// v0.6 privacy, credentials and request identity.
//
// Three promises are pinned here: the smoke harness is redacted by default
// (test/smoke-redact.test.mjs), the legacy API-key config field is declared to
// the settings layer as a secret, and the host can say *what it is* (plugin /
// DSH / Node / platform User-Agent, Doctor build block) and *which local file is
// broken* (config-source health) without ever logging a value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/host/index.ts'
import { OpenVikingApi } from '../src/host/openviking-api.ts'
import {
  DoctorService,
  TESTED_OV_BOUNDS,
  TESTED_OV_RANGE,
  classifyOpenVikingVersion,
} from '../src/host/doctor-service.ts'
import { DICTS } from '../src/client/locale.ts'
import { ProfileStore } from '../src/host/profiles.ts'
import { localStateHealth } from '../src/host/local-state.ts'
import { configSourceHealth, readJsonSource, resolveConnectionWithOrigins } from '../src/host/config.ts'
import { PLUGIN_VERSION, buildUserAgent } from '../src/shared/build-info.ts'

/** A temp dir that removes nothing: tests read it and the OS cleans /tmp. */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function withStub(routes, body) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const call = {
        method: req.method,
        path: url.pathname,
        params: url.searchParams,
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      }
      calls.push(call)
      for (const route of routes) {
        const matches = typeof route.match === 'function' ? route.match(url, req.method) : url.pathname === route.match
        if (matches) {
          const { status = 200, payload = {}, headers = {} } = route.handler(call) ?? {}
          res.writeHead(status, { 'content-type': 'application/json', ...headers })
          res.end(JSON.stringify(payload))
          return
        }
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: 'no route' } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body({ base: `http://127.0.0.1:${server.address().port}`, calls })
  } finally {
    server.close()
  }
}

/* ========================================================================
 * Credentials
 * ===================================================================== */

test('the legacy apiKey config field is declared to the settings layer as a secret', () => {
  const meta = Config.dict?.apiKey?.meta
  assert.equal(meta?.role, 'secret', 'DSH redacts fields with role("secret") on remote reads/forms')
  assert.equal(meta?.volatile, true, 'and it is still editable on the Plugins page')
  assert.equal(meta?.default, '')
})

test('the resolved config still carries the credential field for compatibility', () => {
  const resolved = Config({ apiKey: 'placeholder-for-settings' })
  assert.equal(typeof resolved.apiKey?.get === 'function' ? resolved.apiKey.get() : resolved.apiKey, 'placeholder-for-settings')
})

/* ========================================================================
 * Request identity: User-Agent and build facts
 * ===================================================================== */

test('the build info is available, and honest about a non-release build', () => {
  // These tests run against `src/`, where the build-time define was not applied.
  assert.equal(PLUGIN_VERSION, 'unknown')
  const userAgent = buildUserAgent('0.2.2-rc.1')
  assert.match(userAgent, /^dsh-openviking-enhance\/unknown dsh\/0\.2\.2-rc\.1 node\/v\d+\.\d+\.\d+ platform\/[a-z0-9]+$/)
  assert.match(buildUserAgent(null), / dsh\/unknown /)
})

test('every outbound request carries a version-only User-Agent, never a credential', async () => {
  const routes = [
    {
      match: '/health',
      handler: () => ({ payload: { status: 'ok', result: { healthy: true, version: '0.5.3', auth_mode: 'api_key' } } }),
    },
  ]
  await withStub(routes, async ({ base, calls }) => {
    const api = new OpenVikingApi(
      { endpoint: base, apiKey: 'super-secret-key-value', account: 'alice', user: 'bob' },
      { dshVersion: () => '0.2.2-rc.1' },
    )
    await api.health()
    const headers = calls[0].headers
    assert.match(headers['user-agent'], /^dsh-openviking-enhance\/unknown dsh\/0\.2\.2-rc\.1 node\//)
    assert.equal(headers.authorization, 'Bearer super-secret-key-value', 'the real key rides the auth header')
    assert.ok(!headers['user-agent'].includes('super-secret-key-value'), 'the UA carries no secret')
    assert.ok(!headers['user-agent'].includes('alice'), 'the UA carries no identity')
  })
})

/* ========================================================================
 * Config-source health (P1-4)
 * ===================================================================== */

const writeJson = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))

test('readJsonSource distinguishes missing, malformed, wrong-shape and ok', () => {
  const dir = tempDir('ove-config-')
  assert.equal(readJsonSource(join(dir, 'nope.json')).state, 'missing')
  writeJson(join(dir, 'broken.json'), '{ not json')
  const malformed = readJsonSource(join(dir, 'broken.json'))
  assert.equal(malformed.state, 'malformed')
  assert.equal(malformed.errorCode, 'InvalidJSON')
  writeJson(join(dir, 'array.json'), '[]')
  assert.equal(readJsonSource(join(dir, 'array.json')).state, 'wrong-shape')
  writeJson(join(dir, 'ok.json'), { url: 'http://127.0.0.1:1933' })
  const ok = readJsonSource(join(dir, 'ok.json'))
  assert.equal(ok.state, 'ok')
  assert.equal(ok.value.url, 'http://127.0.0.1:1933')
})

test('the resolver reports per-file health with symbolic paths, never contents', () => {
  const home = tempDir('ove-ovhome-')
  writeJson(join(home, 'ovcli.conf'), '{ this is not json')
  writeJson(join(home, 'ovcli.conf.local'), { account: 'team', user: 'alice' })
  const resolution = resolveConnectionWithOrigins({}, { OPENVIKING_HOME: home })
  assert.equal(resolution.connection.account, 'team', 'the readable layer still resolves')
  const bySource = Object.fromEntries(resolution.configSources.map((source) => [source.source, source]))
  assert.equal(bySource['ovcli.conf'].state, 'malformed')
  assert.equal(bySource['ovcli.conf'].path, '$OPENVIKING_HOME/ovcli.conf')
  assert.equal(bySource['ovcli.conf.local'].state, 'ok')
  assert.equal(resolution.configSources.length, 2)
  const serialized = JSON.stringify(resolution.configSources)
  assert.ok(!serialized.includes('this is not json'), 'contents never appear in a health record')
})

test('an unreadable config file is reported as unreadable (not missing)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = tempDir('ove-ovhome-')
  const path = join(home, 'ovcli.conf')
  writeJson(path, { url: 'http://127.0.0.1:1933' })
  chmodSync(path, 0o000)
  try {
    assert.equal(readJsonSource(path).state, 'unreadable')
  } finally {
    chmodSync(path, 0o644)
  }
})

test('configSourceHealth reads the two OpenViking layers for the Doctor', () => {
  const home = tempDir('ove-ovhome-')
  const sources = configSourceHealth({ OPENVIKING_HOME: home })
  assert.deepEqual(sources.map((source) => source.source), ['ovcli.conf', 'ovcli.conf.local'])
  assert.equal(sources[0].state, 'missing')
  assert.equal(sources[0].path, '$OPENVIKING_HOME/ovcli.conf')
  assert.equal(sources[0].errorCode, 'ENOENT')
})

test('a corrupt profiles.json is a Doctor fact, not silent "no profiles"', () => {
  const dir = tempDir('ove-profiles-')
  const store = new ProfileStore({ dir })
  assert.equal(store.sourceHealth().state, 'missing')
  writeFileSync(join(dir, 'profiles.json'), '{ broken')
  const malformed = new ProfileStore({ dir }).sourceHealth()
  assert.equal(malformed.state, 'malformed')
  assert.equal(malformed.source, 'profiles.json')
  writeFileSync(join(dir, 'profiles.json'), '[]')
  const wrongShape = new ProfileStore({ dir })
  assert.equal(wrongShape.sourceHealth().state, 'wrong-shape')
  // Reading still degrades to a usable, empty store — the Doctor reports the
  // shape problem, the plugin keeps running.
  assert.deepEqual(wrongShape.describe().profiles, [])
  assert.equal(typeof wrongShape.describe().storeAvailable, 'boolean')
})

test('localStateHealth reports the pending queue and memo directories', () => {
  const home = tempDir('ove-localstate-')
  const missing = localStateHealth({ home })
  assert.deepEqual(missing.map((source) => [source.source, source.state]), [
    ['pending-queue', 'missing'],
    ['plugin-state', 'missing'],
  ])
  mkdirSync(join(home, 'state'))
  mkdirSync(join(home, 'pending'))
  const ok = localStateHealth({ home })
  assert.deepEqual(ok.map((source) => source.state), ['ok', 'ok'])
  // A file where a directory belongs is a shape problem worth reporting.
  const odd = tempDir('ove-localstate-odd-')
  writeFileSync(join(odd, 'pending'), 'not a directory')
  assert.equal(localStateHealth({ home: odd }).find((source) => source.source === 'pending-queue').state, 'wrong-shape')
})

/* ========================================================================
 * Doctor: build facts, trace ids and config-source summary
 * ===================================================================== */

/** An OpenViking that answers every Doctor probe with a request id. */
async function doctorReport({ configSources } = {}) {
  const routes = [
    {
      match: '/health',
      handler: () => ({
        payload: { status: 'ok', result: { healthy: true, version: '0.5.3', auth_mode: 'api_key' } },
        headers: { 'x-request-id': 'req-health-12345678' },
      }),
    },
    {
      match: '/api/v1/system/status',
      handler: () => ({ payload: { status: 'ok', result: { initialized: true, user: 'bob' } }, headers: { 'x-request-id': 'req-system-87654321' } }),
    },
    {
      match: '/api/v1/skills',
      handler: () => ({ payload: { status: 'ok', result: { skills: [], root_uris: [], total: 0 } }, headers: { 'x-request-id': 'req-skills-0001' } }),
    },
    {
      match: '/api/v1/observer/retrieval',
      handler: () => ({ payload: { status: 'ok', result: { status: { total_queries: 1, avg_latency_ms: 2 } } }, headers: { 'x-request-id': 'req-observer-0002' } }),
    },
    {
      match: (url) => url.pathname.startsWith('/api/v1/sessions/'),
      handler: () => ({
        payload: {
          status: 'ok',
          result: {
            session_id: 'dsh-s1',
            uri: 'viking://user/default/sessions/dsh-s1',
            user: { account_id: 'default', user_id: 'bob' },
            message_count: 1,
            commit_count: 0,
            memories_extracted: { total: 0, memory_write: 0, memory_edit: 0 },
            last_commit_at: null,
            pending_tokens: 0,
          },
        },
        headers: { 'x-request-id': 'req-session-0003' },
      }),
    },
    {
      match: '/api/v1/snapshot/log',
      handler: () => ({ payload: { status: 'ok', result: { commits: [] } }, headers: { 'x-request-id': 'req-snapshot-0004' } }),
    },
    {
      match: '/api/v1/tasks',
      handler: () => ({ payload: { status: 'ok', result: { items: [], has_more: false } }, headers: { 'x-request-id': 'req-tasks-0005' } }),
    },
    {
      match: (url, method) => url.pathname === '/api/v1/search/search' && method === 'POST',
      handler: () => ({ payload: { status: 'ok', result: { entries: [], stats: {} } }, headers: { 'x-request-id': 'req-context-0006' } }),
    },
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: () => ({ status: 422, payload: { detail: [{ msg: 'field required' }] }, headers: { 'x-request-id': 'req-rules-0007' } }),
    },
    {
      match: '/api/v1/fs/stat',
      handler: () => ({ payload: { status: 'ok', result: { name: 'home', uri: 'viking://~', isDir: true } }, headers: { 'x-request-id': 'req-fs-0008' } }),
    },
  ]
  return withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: 'super-secret-key-value', account: 'default', user: 'bob' })
    const commit = {
      ovSessionId: () => 'dsh-s1',
      actorPeer: () => undefined,
      pluginConfig: () => null,
      pluginMounted: () => false,
      pluginPeerSource: () => null,
    }
    const home = tempDir('ove-doctor-')
    const service = new DoctorService({
      api,
      commit,
      connection: { endpoint: base, apiKey: 'super-secret-key-value', account: 'default', user: 'bob' },
      origins: [],
      dshVersion: () => '0.2.2-rc.1',
      localState: { home },
      configSources,
    })
    return service.report('session-1', { probe: true })
  })
}

test('the server version is classified against the contract range, permissively', () => {
  assert.deepEqual(classifyOpenVikingVersion('0.5.1.1'), { state: 'ok', detail: '0.5.1.1' })
  assert.deepEqual(classifyOpenVikingVersion('0.5.2'), { state: 'ok', detail: '0.5.2' })
  assert.deepEqual(classifyOpenVikingVersion('0.5.3.2'), { state: 'ok', detail: '0.5.3.2' })
  assert.deepEqual(classifyOpenVikingVersion('v0.5.3'), { state: 'ok', detail: 'v0.5.3' })
  for (const version of ['0.5.1', '0.5.0', '0.5.4', '0.6.0', '1.0.0']) {
    assert.equal(classifyOpenVikingVersion(version).state, 'warn', `${version} is outside the tested range`)
  }
  // Unparseable/absent stays visible as unknown; nothing is hidden.
  assert.deepEqual(classifyOpenVikingVersion(null), { state: 'unknown', detail: null })
  assert.deepEqual(classifyOpenVikingVersion('unknown-build'), { state: 'unknown', detail: 'unknown-build' })
})

test('every Doctor check id has a label in both languages', async () => {
  // The renderer resolves `doctor.check.<id>` through the dictionary; a missing
  // label renders the raw key in the UI (the round-2 review caught exactly that),
  // and the locale test's static scan cannot see template-string keys.
  const report = await doctorReport()
  const ids = report.checks.map((check) => check.id)
  assert.ok(ids.length >= 16, `the report produces the full check list, saw ${ids.length}`)
  for (const id of ids) {
    for (const [language, dict] of Object.entries(DICTS)) {
      assert.ok(`doctor.check.${id}` in dict, `${language} dictionary is missing doctor.check.${id}`)
    }
  }
  // The version check's hint is the other half of its bilingual copy.
  for (const dict of Object.values(DICTS)) {
    assert.ok('doctor.hint.openvikingVersion' in dict)
  }
})

test('the tested OpenViking range, classifier bounds and hint copy agree', () => {
  // Three records can drift: the display string, the classifier tuples, and the
  // bilingual hint. The classifier is derived from TESTED_OV_RANGE now; this
  // asserts all three name the same range.
  const match = /OpenViking\s+(\d+(?:\.\d+)*)\s+[–-]\s+(\d+(?:\.\d+)*)/.exec(TESTED_OV_RANGE)
  assert.notEqual(match, null, 'TESTED_OV_RANGE is a parsable range')
  const [, floorText, headText] = match
  assert.deepEqual(TESTED_OV_BOUNDS.floor, [...floorText.split('.').map(Number), 0].slice(0, 4))
  assert.equal(classifyOpenVikingVersion(floorText).state, 'ok', 'the floor is inside the range')
  assert.equal(classifyOpenVikingVersion(headText).state, 'ok', 'the head is inside the range')
  for (const [language, dict] of Object.entries(DICTS)) {
    const hint = dict['doctor.hint.openvikingVersion'] ?? ''
    assert.ok(hint.includes(floorText), `${language} hint names the floor ${floorText}`)
    assert.ok(hint.includes(headText), `${language} hint names the head ${headText}`)
  }
  // One step outside on either side warns; the classifier and the range agree.
  assert.equal(classifyOpenVikingVersion('0.5.1.0').state, 'warn')
  assert.equal(classifyOpenVikingVersion('0.5.4').state, 'warn')
})

test('the Doctor reports build identity, including a non-release warning', async () => {
  const report = await doctorReport()
  const versionCheck = report.checks.find((check) => check.id === 'openvikingVersion')
  assert.equal(versionCheck.status, 'ok', 'the stub health answers 0.5.3, inside the tested range')
  assert.equal(versionCheck.hint, null)
  assert.equal(report.build.pluginVersion, 'unknown')
  assert.equal(report.build.dshVersion, '0.2.2-rc.1')
  assert.match(report.build.nodeVersion, /^v\d+/)
  assert.match(report.build.userAgent, /^dsh-openviking-enhance\/unknown dsh\/0\.2\.2-rc\.1 node\//)
  const buildCheck = report.checks.find((check) => check.id === 'pluginBuild')
  assert.equal(buildCheck.status, 'warn')
  assert.equal(buildCheck.hint, 'doctor.hint.pluginVersionUnknown')
})

test('the Doctor diagnostics carry per-probe request ids and no secret', async () => {
  const report = await doctorReport()
  const traces = report.diagnostics.traces
  assert.equal(traces.health, 'req-health-12345678')
  assert.equal(traces.system, 'req-system-87654321')
  assert.equal(traces.skills, 'req-skills-0001')
  assert.equal(traces.observer, 'req-observer-0002')
  assert.equal(traces.session, 'req-session-0003')
  assert.equal(traces.contextFace, 'req-context-0006')
  assert.equal(traces.rules, 'req-rules-0007')
  assert.equal(traces.fsStat, 'req-fs-0008')
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes('super-secret-key-value'), 'the configured key never appears in diagnostics')
  assert.ok(!serialized.includes('Authorization'), 'no request header is echoed')
})

test('a malformed local config file becomes a configSources warning with a hint', async () => {
  const report = await doctorReport({
    configSources: () => [
      { source: 'ovcli.conf', path: '~/.openviking/ovcli.conf', state: 'malformed', errorCode: 'InvalidJSON' },
      { source: 'profiles.json', path: '~/.dsh/state/dsh-openviking-enhance/profiles.json', state: 'ok', errorCode: null },
    ],
  })
  const check = report.checks.find((entry) => entry.id === 'configSources')
  assert.equal(check.status, 'warn')
  assert.equal(check.value, 'ovcli.conf malformed')
  assert.equal(check.hint, 'doctor.hint.configMalformed')
  assert.deepEqual(
    report.configSources.map((source) => source.state),
    ['malformed', 'ok'],
  )
  assert.deepEqual(report.diagnostics.configSources, report.configSources)
})

test('healthy/missing local sources produce an ok configSources check', async () => {
  const report = await doctorReport({
    configSources: () => [
      { source: 'ovcli.conf', path: '~/.openviking/ovcli.conf', state: 'missing', errorCode: 'ENOENT' },
      { source: 'profiles.json', path: '~/.dsh/state/...', state: 'ok', errorCode: null },
    ],
  })
  const check = report.checks.find((entry) => entry.id === 'configSources')
  assert.equal(check.status, 'ok')
  assert.equal(check.hint, null)
})

test('a failed health probe carries the short request id in the warning params', async () => {
  const routes = [
    {
      match: '/health',
      handler: () => ({ status: 503, payload: { status: 'error', error: { code: 'UNAVAILABLE', message: 'down' } }, headers: { 'x-request-id': 'req-failing-abcdef12' } }),
    },
    {
      match: '/api/v1/system/status',
      handler: () => ({ status: 503, payload: { status: 'error' } }),
    },
    {
      match: '/api/v1/skills',
      handler: () => ({ status: 503, payload: { status: 'error' } }),
    },
    {
      match: '/api/v1/observer/retrieval',
      handler: () => ({ status: 503, payload: { status: 'error' } }),
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const service = new DoctorService({
      api,
      commit: { ovSessionId: () => 'dsh-s1', actorPeer: () => undefined, pluginConfig: () => null, pluginMounted: () => false, pluginPeerSource: () => null },
      connection: { endpoint: base, apiKey: '', account: 'default', user: 'default' },
      origins: [],
      dshVersion: () => '0.2.2-rc.1',
    })
    const report = await service.report(undefined, { probe: true })
    const warning = report.warnings.find((entry) => entry.code === 'unreachable')
    assert.notEqual(warning, undefined)
    assert.equal(warning.params.requestId, 'abcdef12', 'the last 8 chars correlate with the server log')
    assert.equal(report.diagnostics.traces.health, 'req-failing-abcdef12', 'the full id stays in diagnostics')
  })
})

test('the Doctor reports an unprobed rules route as unknown, not available', async () => {
  // A transport failure/cancellation returns status 0 from the cheap probe. The
  // UI keeps the surface visible (`available` stays optimistic), but the Doctor
  // must not claim the capability was observed.
  const api = {
    health: async () => ({ ok: true, version: '0.5.3', authMode: 'dev', role: null, accountId: null, userId: null, error: null, requestId: null }),
    systemStatus: async () => ({ ok: true, status: 200, result: { initialized: true, user: 'bob' }, error: null }),
    listSkills: async () => ({ ok: true, status: 200, result: { skills: [], root_uris: [], total: 0 }, error: null }),
    observerRetrieval: async () => ({ ok: true, status: 200, result: { status: { total_queries: 1, avg_latency_ms: 2 } }, error: null }),
    searchContext: async () => ({ ok: true, status: 200, result: { entries: [], stats: {} }, error: null }),
    probeRuleSearchRoute: async () => ({ ok: false, status: 0, result: null, error: 'fetch failed', errorCode: null, requestId: null }),
    fsStat: async () => ({ ok: true, status: 200, result: { uri: 'viking://~', isDir: true }, error: null }),
  }
  const commit = {
    ovSessionId: () => 'dsh-s1',
    actorPeer: () => undefined,
    pluginConfig: () => null,
    pluginMounted: () => false,
    pluginPeerSource: () => null,
  }
  const service = new DoctorService({
    api,
    commit,
    connection: { endpoint: 'http://127.0.0.1:1933', apiKey: '', account: 'default', user: 'default' },
    origins: [],
    dshVersion: () => '0.2.2-rc.1',
    localState: { home: tempDir('ove-doctor-unknown-') },
  })
  const report = await service.report(undefined, { probe: true })
  assert.equal(report.capabilities.ruleSearch.state, 'unknown')
  assert.equal(report.capabilities.ruleSearch.detail, 'fetch failed')
})
