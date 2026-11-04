// Unit tests for the host half's pure logic.
//
// These import the TypeScript sources directly: Node strips the types on load
// (no build step, no test framework, no dependencies). That is also why the two
// classes assign their fields in the constructor body instead of using TypeScript
// parameter properties — strip-only mode cannot erase those.
//
//   node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackHostname,
  isTrustedLocalRequest,
} from '../src/host/trust-fence.ts'
import {
  CommitService,
  derivePhase,
  isArchiveUriForSession,
  normalizeDiff,
  normalizeFailure,
  resolveSessionUri,
} from '../src/host/commit-service.ts'
import { OpenVikingApi, parseMaybeDoubleEncoded } from '../src/host/openviking-api.ts'
import { Config, apply, parseLoopbackEndpoint } from '../src/host/index.ts'
import {
  deriveClientPhase,
  describeFailure,
  describeFailureText,
  durationSeconds,
  failedTasks,
  isCancelledTask,
  isSupersededByLaterCommit,
  taskTime,
} from '../src/shared/commit-state.ts'

/**
 * Fabricate the parts of an IncomingMessage the fence reads.
 *
 * Omission is asked for explicitly (`omitHost` / `omitRemote`): passing
 * `undefined` for a destructured default would silently restore the default and
 * test the opposite of what the case claims.
 */
function request({ remoteAddress = '127.0.0.1', host = '127.0.0.1:19387', origin, secFetchSite, omitHost = false, omitRemote = false } = {}) {
  const headers = {}
  if (!omitHost) headers.host = host
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  return { socket: omitRemote ? {} : { remoteAddress }, headers }
}

test('isIPv4Loopback accepts 127/8 only', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.255.255.254'), true)
  assert.equal(isIPv4Loopback('128.0.0.1'), false)
  assert.equal(isIPv4Loopback('10.0.0.1'), false)
  assert.equal(isIPv4Loopback('127.0.0.256'), false)
  assert.equal(isIPv4Loopback('127.0.0'), false)
  assert.equal(isIPv4Loopback('::1'), false)
})

test('isLoopbackAddress covers ::1 and IPv4-mapped forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false)
  assert.equal(isLoopbackAddress('192.168.1.10'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('isLoopbackHostname covers the loopback authorities, not lookalikes', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('localhost.evil.example'), false)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('the fence trusts a plain same-origin loopback request', () => {
  assert.equal(isTrustedLocalRequest(request()), true)
  assert.equal(isTrustedLocalRequest(request({ host: 'localhost:19387' })), true)
  assert.equal(isTrustedLocalRequest(request({ origin: 'http://127.0.0.1:19387' })), true)
})

test('the fence refuses anything that is not a local same-origin request', () => {
  // Off-machine, even when the Host header claims loopback.
  assert.equal(isTrustedLocalRequest(request({ remoteAddress: '10.0.0.5' })), false)
  assert.equal(isTrustedLocalRequest(request({ omitRemote: true })), false)
  // Reached over loopback through a proxy or tunnel that fronts a public name.
  assert.equal(isTrustedLocalRequest(request({ host: 'dsh.example.com' })), false)
  // A page on another site (or a cross-site form post) reaching the port.
  assert.equal(isTrustedLocalRequest(request({ secFetchSite: 'cross-site' })), false)
  // A different origin on the same machine, and sandboxed iframes' literal null.
  assert.equal(isTrustedLocalRequest(request({ origin: 'http://127.0.0.1:9999' })), false)
  assert.equal(isTrustedLocalRequest(request({ origin: 'null' })), false)
  assert.equal(isTrustedLocalRequest(request({ origin: 'not a url' })), false)
  assert.equal(isTrustedLocalRequest(request({ omitHost: true })), false)
})

test('resolveSessionUri prefers the session record over the configured identity', () => {
  const uri = 'viking://user/fitbot/sessions/dsh-abc'
  // The whole point: another user owns this session, and the configured identity
  // would have built a path that silently returned no archives.
  assert.equal(resolveSessionUri({ uri }, 'dsh-abc', 'default'), uri)
  assert.equal(resolveSessionUri({ uri: `${uri}/` }, 'dsh-abc', 'default'), uri)
  assert.equal(resolveSessionUri({ created_by_user_id: 'fitbot' }, 'dsh-abc', 'default'), uri)
  assert.equal(resolveSessionUri({}, 'dsh-abc', 'default'), 'viking://user/default/sessions/dsh-abc')
  assert.equal(resolveSessionUri(null, 'dsh-abc', 'default'), 'viking://user/default/sessions/dsh-abc')
  assert.equal(resolveSessionUri({ uri: 'https://example.com/x' }, 'dsh-abc', 'default'), 'viking://user/default/sessions/dsh-abc')
  // The session directory, never the history directory: listHistory owns that suffix.
  assert.equal(resolveSessionUri({ uri }, 'dsh-abc', 'default').endsWith('/history'), false)
})

test('the plugin activates with the config the Loader resolves for it', async () => {
  // This is the shape that broke the released plugin: `volatile()` fields — the
  // ones a settings form can edit — do not resolve to their values but to
  // references with a `get()`, so `config.studioPath` was an object and
  // `(path ?? '').trim` threw from inside `apply`, taking the entry down with it
  // ("1 entry did not activate openviking-enhance").
  const resolved = Config({ endpoint: 'http://127.0.0.1:9' })
  assert.equal(typeof resolved.endpoint?.get, 'function', 'a volatile field arrives as a reference')
  assert.equal(resolved.endpoint.get(), 'http://127.0.0.1:9')

  const routes = []
  const context = {
    webServer: { port: 0, register: (route) => (routes.push(route), () => {}) },
    effect: (callback) => (callback(), () => {}),
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  assert.doesNotThrow(() => apply(context, resolved), 'apply() must survive a resolved config')
  assert.ok(routes.length >= 6, `every route is registered (saw ${routes.length})`)

  // And the value has to be READ through the reference, not merely tolerated.
  const route = routes.find((candidate) => candidate.path === '/api/openviking-enhance/config')
  const answered = await callRoute(route)
  assert.equal(answered.status, 200)
  assert.equal(answered.body.endpoint, 'http://127.0.0.1:9')
  assert.equal(answered.body.healthy, false, 'a dead port is reported, not thrown')
})

test('an absurd config value cannot stop the plugin from activating', () => {
  // The incident: a config field the plugin could not read took the whole entry
  // down, and the app showed "1 entry did not activate" instead of a plugin. A
  // wrong type is not a reason to lose the feature.
  const routes = []
  const context = {
    webServer: { port: 0, register: (route) => (routes.push(route), () => {}) },
    effect: (callback) => (callback(), () => {}),
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  assert.doesNotThrow(() =>
    apply(context, { studioPath: 42, cacheTtlMs: 'soon', endpoint: { nope: true } }),
  )
  assert.ok(routes.length >= 6)
})

test('a failure inside the plugin cannot stop the profile from booting', () => {
  // What the user saw: "web boot: 1 entry did not activate / dsh-openviking-enhance:
  // failed" — and an application that would not start. Whatever goes wrong in
  // here, the boot has to survive it, and the cause has to reach the log.
  const logged = []
  const context = {
    webServer: {
      port: 0,
      register: () => {
        throw new Error('the service exploded')
      },
    },
    effect: (callback) => (callback(), () => {}),
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: (line) => logged.push(line) },
  }
  assert.doesNotThrow(() => apply(context, Config({})))
  assert.equal(logged.length, 1, 'the failure is reported exactly once')
  assert.match(logged[0], /failed to activate/)
  assert.match(logged[0], /the service exploded/, 'the cause is in the log, not just the symptom')
})

test('a plugin with no config at all still activates', () => {
  const routes = []
  const context = {
    webServer: { port: 0, register: (route) => (routes.push(route), () => {}) },
    effect: (callback) => (callback(), () => {}),
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  assert.doesNotThrow(() => apply(context))
  assert.ok(routes.length >= 6)
})

test('the three interface switches are volatile booleans that default to on', () => {
  // They exist in the host Config only so the Plugins page's configuration form
  // can render and persist them (the settings service projects volatile fields
  // only). The host half never reads them; the browser half watches the form.
  const switches = ['showSidebarEntry', 'showCommitStatus', 'showRecallPanel']

  const defaults = Config({})
  for (const field of switches) {
    assert.equal(typeof defaults[field]?.get, 'function', `${field} arrives as a volatile reference`)
    assert.equal(defaults[field].get(), true, `${field} defaults to true`)
  }

  // A user who saved `false` must read `false` after the next composition, and
  // the fields they did not touch must keep their own defaults.
  const oneOff = Config({ showCommitStatus: false })
  assert.equal(oneOff.showCommitStatus.get(), false)
  assert.equal(oneOff.showSidebarEntry.get(), true)
  assert.equal(oneOff.showRecallPanel.get(), true)

  const allOff = Config({ showSidebarEntry: false, showCommitStatus: false, showRecallPanel: false })
  for (const field of switches) assert.equal(allOff[field].get(), false, `${field} resolves false`)
})

test('a config carrying the three switches still activates the plugin', async () => {
  // The failure mode this pins: a new Config field the host half cannot survive
  // takes the whole entry down ("1 entry did not activate"). The switches must be
  // inert data as far as activation is concerned — in either polarity.
  for (const resolved of [
    Config({}),
    Config({ showSidebarEntry: false, showCommitStatus: false, showRecallPanel: false }),
  ]) {
    const routes = []
    const context = {
      webServer: { port: 0, register: (route) => (routes.push(route), () => {}) },
      effect: (callback) => (callback(), () => {}),
      get: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    }
    assert.doesNotThrow(() => apply(context, resolved), 'apply() survives the switches')
    assert.ok(routes.length >= 6, `every route is registered (saw ${routes.length})`)
    // The switches are client-only: the config route must not grow a field the
    // host would then be obliged to honour. It still answers with the connection.
    const route = routes.find((candidate) => candidate.path === '/api/openviking-enhance/config')
    const answered = await callRoute(route)
    assert.equal(answered.status, 200)
    for (const field of ['showSidebarEntry', 'showCommitStatus', 'showRecallPanel']) {
      assert.equal(field in answered.body, false, `${field} is not a host-read config field`)
    }
  }
})

/** Call one registered route with a trusted loopback request and read its JSON. */
function callRoute(route) {
  return new Promise((resolve) => {
    const chunks = []
    const req = {
      method: 'GET',
      url: route.path,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:19387' },
    }
    const res = {
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(payload) {
        chunks.push(payload)
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(chunks.join('')) })
      },
    }
    void route.handler(req, res)
  })
}

test('parseLoopbackEndpoint admits only this machine', () => {
  // The configuration form sends what the user typed, so this is the check that
  // keeps the plugin from becoming a URL fetcher for anything on the network.
  assert.equal(parseLoopbackEndpoint('http://127.0.0.1:1933')?.origin, 'http://127.0.0.1:1933')
  assert.equal(parseLoopbackEndpoint('http://localhost:1933/studio/')?.origin, 'http://localhost:1933')
  assert.equal(parseLoopbackEndpoint('  http://[::1]:1933  ')?.hostname, '[::1]')
  assert.equal(parseLoopbackEndpoint('https://127.0.0.1:8443')?.origin, 'https://127.0.0.1:8443')
  assert.equal(parseLoopbackEndpoint('http://example.com:1933'), null)
  assert.equal(parseLoopbackEndpoint('http://192.168.1.10:1933'), null)
  assert.equal(parseLoopbackEndpoint('file:///etc/passwd'), null)
  assert.equal(parseLoopbackEndpoint('not a url'), null)
  assert.equal(parseLoopbackEndpoint(''), null)
})

test('listHistory appends exactly one /history segment', async () => {
  // Regression: resolveSessionUri and listHistory each appended `/history`, so the
  // request went to `history/history` and every session reported zero archives.
  // The real client is exercised against a stub server, which is what makes this
  // an assertion about the wire request rather than about our own test double.
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', result: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const api = new OpenVikingApi({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      apiKey: '',
      account: 'default',
      user: 'default',
    })
    const result = await api.listHistory('viking://user/fitbot/sessions/dsh-abc')
    assert.equal(result.ok, true)
    assert.deepEqual(seen, ['/api/v1/fs/ls?uri=viking%3A%2F%2Fuser%2Ffitbot%2Fsessions%2Fdsh-abc%2Fhistory'])
  } finally {
    server.close()
  }
})

test('status hands the session directory to listHistory and probes its newest archive', async () => {
  const seen = []
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/default/sessions/${id}`, commit_count: 1 } }
    },
    // Contract: a session URI in, the archive listing out (the client adds /history).
    async listHistory(sessionUri) {
      seen.push(sessionUri)
      return { ok: true, result: [{ uri: `${sessionUri}/history/archive_001`, isDir: true, size: 0, modTime: null }] }
    },
    async readText(uri) {
      if (uri.endsWith('/history/archive_001/.done')) return { ok: true, status: 200, result: '{}', error: null }
      return { ok: false, status: 404, result: null, error: 'not found' }
    },
    async readJson() {
      return { ok: false, status: 404, result: null, error: 'not found' }
    },
  }
  const service = new CommitService({ api, memoryRuntime: () => null })
  const status = await service.status('abc')

  assert.deepEqual(seen, ['viking://user/default/sessions/dsh-abc'])
  assert.equal(status.archives.length, 1)
  assert.equal(status.archives[0].archiveId, 'archive_001')
  assert.equal(status.phase, 'done')
  assert.deepEqual(status.latest, {
    archiveUri: 'viking://user/default/sessions/dsh-abc/history/archive_001',
    state: 'done',
    failure: null,
    markers: true,
  })
})

test('a failed archive owns the pill even when a partial diff exists', async () => {
  // The real shape from OpenViking 0.5.1.1: a failed extraction can leave a
  // partial memory_diff.json behind, so diff presence alone must not mean done.
  let contentReads = 0
  const failure = {
    stage: 'memory_extraction',
    error: "Error code: 400 - {'error': {'message': 'Thinking mode does not support this tool_choice (request_id: 1)'}}",
    failed_at: '2026-10-02T02:09:27.554Z',
    skipped: true,
  }
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/default/sessions/${id}`, commit_count: 3 } }
    },
    async listHistory(uri) {
      return {
        ok: true,
        result: [1, 2, 3].map((n) => ({ uri: `${uri}/history/archive_00${n}`, isDir: true, size: 0, modTime: null })),
      }
    },
    async readText(uri) {
      contentReads += 1
      return uri.endsWith('/archive_001/.done')
        ? { ok: true, status: 200, result: '{}', error: null }
        : { ok: false, status: 404, result: null, error: 'not found' }
    },
    async readJson(uri) {
      contentReads += 1
      if (uri.endsWith('/memory_diff.json')) {
        return { ok: true, status: 200, result: { operations: { adds: [], updates: [], deletes: [] } }, error: null }
      }
      if (uri.endsWith('/archive_002/.failed.json') || uri.endsWith('/archive_003/.failed.json')) {
        return { ok: true, status: 200, result: failure, error: null }
      }
      return { ok: false, status: 404, result: null, error: 'not found' }
    },
  }
  const service = new CommitService({ api, memoryRuntime: () => null })
  const status = await service.status('abc')
  assert.equal(status.phase, 'errored', 'the newest archive failed')
  assert.equal(status.latest?.state, 'failed')
  assert.equal(status.latest?.failure?.stage, 'memory_extraction')
  assert.equal(status.latest?.failure?.skipped, true)
  assert.equal(status.latest?.markers, true)

  const summaries = await service.summaries('abc', status.archives, 3)
  assert.deepEqual(summaries.map((entry) => [entry.archiveUri.split('/').pop(), entry.state]), [
    ['archive_003', 'failed'],
    ['archive_002', 'failed'],
    ['archive_001', 'done'],
  ])
  assert.ok(summaries[0].summary, 'a partial diff is still reported, next to the failure')

  // A terminal probe is cached: a forced status refresh must not re-read the
  // archive markers or the diff.
  const readsAfterProbe = contentReads
  await service.status('abc', { fresh: true })
  assert.equal(contentReads, readsAfterProbe, 'terminal archive probes are served from cache')
})

test('status reads a session that another user owns', async () => {
  const seen = []
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/fitbot/sessions/${id}`, commit_count: 2 } }
    },
    async listHistory(uri) {
      seen.push(uri)
      return { ok: true, result: [] }
    },
  }
  await new CommitService({ api, memoryRuntime: () => null }).status('abc')
  assert.deepEqual(seen, ['viking://user/fitbot/sessions/dsh-abc'])
})

test('status falls back to dsh-<id> and the raw path when the plugin is absent', async () => {
  const seen = []
  const api = {
    user: 'default',
    async getSession(id) {
      seen.push(`session:${id}`)
      return { ok: true, result: { session_id: id, commit_count: 0, pending_tokens: 1500 } }
    },
    async listHistory(uri) {
      seen.push(`history:${uri}`)
      return { ok: true, result: [] }
    },
  }
  const status = await new CommitService({ api, memoryRuntime: () => null }).status('abc')
  assert.deepEqual(seen, ['session:dsh-abc', 'history:viking://user/default/sessions/dsh-abc'])
  assert.equal(status.threshold, null)
  assert.equal(status.phase, 'pending')
})

test('derivePhase prefers the newest archive marker over the commit counter', () => {
  assert.equal(derivePhase({ metaOk: false, commitCount: 0, pendingTokens: 0, archiveCount: 0 }), 'failed')
  assert.equal(derivePhase({ metaOk: true, commitCount: 0, pendingTokens: 0, archiveCount: 0 }), 'idle')
  assert.equal(derivePhase({ metaOk: true, commitCount: 0, pendingTokens: 12, archiveCount: 0 }), 'pending')
  assert.equal(derivePhase({ metaOk: true, commitCount: 2, pendingTokens: 0, archiveCount: 2 }), 'done')
  assert.equal(derivePhase({ metaOk: true, commitCount: 1, pendingTokens: 0, archiveCount: 2 }), 'extracting')
  // The counter advances when the archive is written, so it cannot tell a
  // running extraction from a failed one. The archive's own marker can.
  assert.equal(derivePhase({ metaOk: true, commitCount: 2, pendingTokens: 0, archiveCount: 2, latestState: 'pending' }), 'extracting')
  assert.equal(derivePhase({ metaOk: true, commitCount: 2, pendingTokens: 0, archiveCount: 2, latestState: 'failed' }), 'errored')
  assert.equal(derivePhase({ metaOk: true, commitCount: 1, pendingTokens: 0, archiveCount: 2, latestState: 'done' }), 'done')
})

test('normalizeDiff maps every operation shape and trusts the recorded summary', () => {
  const diff = normalizeDiff('viking://user/default/sessions/s/history/archive_001', {
    extracted_at: '2026-10-02T02:00:00Z',
    operations: {
      adds: [{ uri: 'viking://user/default/memories/events/a.md', memory_type: 'events', after: 'A' }],
      updates: [{ uri: 'viking://user/default/memories/entities/b.md', memory_type: 'entities', before: 'B', after: 'B2' }],
      deletes: [{ uri: 'viking://user/default/memories/entities/c.md', memory_type: 'entities', deleted_content: 'C' }],
    },
    summary: { total_adds: 1, total_updates: 1, total_deletes: 1, total_skipped: 0 },
  })
  assert.equal(diff.adds[0].uri.endsWith('/a.md'), true)
  assert.equal(diff.updates[0].before, 'B')
  assert.equal(diff.deletes[0].deletedContent, 'C')
  assert.deepEqual(diff.summary, { totalAdds: 1, totalUpdates: 1, totalDeletes: 1, totalSkipped: 0 })
})

test('normalizeDiff counts when the server omits summary', () => {
  const diff = normalizeDiff('viking://x', {
    operations: { adds: [{ uri: 'a' }, { uri: 'b' }], updates: [], deletes: [] },
  })
  assert.deepEqual(diff.summary, { totalAdds: 2, totalUpdates: 0, totalDeletes: 0, totalSkipped: 0 })
  assert.equal(diff.extractedAt, null)
})

test('isArchiveUriForSession keeps the diff route scoped', () => {
  const sid = 'dsh-session-abc'
  const good = `viking://user/default/sessions/${sid}/history/archive_001`
  assert.equal(isArchiveUriForSession(good, sid), true)
  assert.equal(isArchiveUriForSession(good, 'dsh-session-other'), false)
  assert.equal(isArchiveUriForSession('/etc/passwd', sid), false)
  assert.equal(isArchiveUriForSession(`viking://user/default/sessions/${sid}/history/../../../secrets`, sid), false)
})

test('parseMaybeDoubleEncoded unwraps the nested JSON content/read returns', () => {
  const payload = { operations: { adds: [] }, summary: { total_adds: 0 } }
  assert.deepEqual(parseMaybeDoubleEncoded(JSON.stringify(JSON.stringify(payload))), payload)
  assert.deepEqual(parseMaybeDoubleEncoded(JSON.stringify(payload)), payload)
  assert.equal(parseMaybeDoubleEncoded('not json'), null)
})

// --- commit-state: the failure signal the rest of the system hides ---------

test('deriveClientPhase prefers work in progress over an older failure', () => {
  const failed = { task_id: 'a', status: 'failed', stage: 'failed', error: 'boom', result: null }
  const running = { task_id: 'b', status: 'running', stage: null, error: null, result: null }
  assert.equal(deriveClientPhase({ error: null, status: null, tasks: [running, failed] }), 'extracting')
  assert.equal(deriveClientPhase({ error: null, status: null, tasks: [failed] }), 'errored')
  assert.equal(deriveClientPhase({ error: 'host down', status: null, tasks: [failed] }), 'failed')
})

test('deriveClientPhase lets the newest archive marker own the pill', () => {
  const failedTask = { task_id: 'a', status: 'failed', stage: null, error: 'x', result: null, created_at: 100 }
  const done = { archiveUri: 'viking://s/history/archive_001', state: 'done', failure: null }
  const failed = {
    archiveUri: 'viking://s/history/archive_002',
    state: 'failed',
    failure: { stage: 'memory_extraction', error: 'boom', failedAt: null, skipped: true },
  }
  const pending = { archiveUri: 'viking://s/history/archive_003', state: 'pending', failure: null }
  // A historical failure no longer owns the pill once a newer archive says done.
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done', latest: done }, tasks: [failedTask] }), 'done')
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done', latest: failed }, tasks: [] }), 'errored')
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done', latest: pending }, tasks: [] }), 'extracting')
  // A legacy server has no marker: a failed task from the current commit is the
  // only evidence, and it must outrank the marker-less "pending" state.
  const pendingLegacy = { archiveUri: 'viking://s/history/archive_003', state: 'pending', failure: null, markers: false }
  const currentFailure = { task_id: 'f', status: 'failed', stage: null, error: 'x', result: null, created_at: 200 }
  assert.equal(
    deriveClientPhase({ error: null, status: { phase: 'extracting', latest: pendingLegacy, lastCommitAt: '1970-01-01T00:03:10.000Z' }, tasks: [currentFailure] }),
    'errored',
  )
  assert.equal(
    deriveClientPhase({ error: null, status: { phase: 'extracting', latest: pendingLegacy, lastCommitAt: '1970-01-01T00:03:30.000Z' }, tasks: [currentFailure] }),
    'extracting',
  )
  // `cancelled` is not `failed`: it must not turn the pill red on a legacy server.
  const cancelled = { task_id: 'c', status: 'cancelled', stage: null, error: null, result: null, created_at: 100 }
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [cancelled] }), 'done')
})

test('a pruned success cannot resurrect an old failure through the task list', () => {
  // The server keeps completed tasks ~24 h and failed ones ~7 days. After the
  // latest success is pruned, its task vanishes while the old failure remains;
  // `last_commit_at` is the durable proof that the failure was superseded.
  const older = { task_id: 'a', status: 'failed', stage: null, error: 'x', result: null, created_at: 100 }
  const newer = { task_id: 'b', status: 'completed', stage: null, error: null, result: null, created_at: 200 }
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [newer, older] }), 'done')
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [older, newer] }), 'done')
  // No newer task survives, but a later commit does.
  assert.equal(
    deriveClientPhase({ error: null, status: { phase: 'done', lastCommitAt: '1970-01-01T00:03:20.000Z' }, tasks: [older] }),
    'done',
  )
  // A failure created after `last_commit_at` belongs to the newest commit.
  assert.equal(
    deriveClientPhase({ error: null, status: { phase: 'done', lastCommitAt: '1970-01-01T00:00:00.000Z' }, tasks: [older] }),
    'errored',
  )
})

test('isSupersededByLaterCommit needs a later timestamp and a readable one', () => {
  const older = { task_id: 'a', status: 'failed', stage: null, error: 'x', result: null, created_at: 100 }
  assert.equal(isSupersededByLaterCommit(older, { lastCommitAt: '1970-01-01T00:03:20.000Z' }), true)
  assert.equal(isSupersededByLaterCommit(older, { lastCommitAt: '1970-01-01T00:00:00.000Z' }), false)
  assert.equal(isSupersededByLaterCommit(older, { lastCommitAt: null }), false)
  assert.equal(isSupersededByLaterCommit({ ...older, created_at: undefined, created_at_iso: undefined }, { lastCommitAt: '2026-01-01T00:00:00Z' }), false)
})

test('deriveClientPhase falls back to the host phase with no tasks', () => {
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'pending' }, tasks: [] }), 'pending')
  assert.equal(deriveClientPhase({ error: null, status: null, tasks: [] }), 'idle')
})

test('normalizeFailure keeps the server reason and stage, and defaults the rest', () => {
  assert.deepEqual(
    normalizeFailure({
      stage: 'memory_extraction',
      error: "Error code: 400 - {'error': {'message': 'Thinking mode does not support this tool_choice (request_id: 1)'}}",
      failed_at: '2026-10-02T02:09:27.554Z',
      skipped: true,
    }),
    {
      stage: 'memory_extraction',
      error: "Error code: 400 - {'error': {'message': 'Thinking mode does not support this tool_choice (request_id: 1)'}}",
      failedAt: '2026-10-02T02:09:27.554Z',
      skipped: true,
    },
  )
  assert.deepEqual(normalizeFailure({}), { stage: null, error: null, failedAt: null, skipped: false })
  assert.equal(
    describeFailureText("Error code: 400 - {'error': {'message': 'provider said no'}}"),
    'provider said no',
  )
})

test('describeFailure unwraps the provider message out of the server error', () => {
  const task = {
    task_id: 'a',
    status: 'failed',
    stage: 'failed',
    result: null,
    error:
      "Error code: 400 - {'error': {'message': 'Thinking mode does not support this tool_choice (request_id: 49c9)', 'type': 'invalid_request_error', 'param': None, 'code': 'invalid_request_error'}}",
  }
  assert.equal(describeFailure(task), 'Thinking mode does not support this tool_choice (request_id: 49c9)')
  assert.equal(describeFailure({ ...task, error: 'plain failure' }), 'plain failure')
  // An error with no message yields no text: this module is shared by both
  // halves, so the wording belongs to whichever half has a language.
  assert.equal(describeFailure({ ...task, error: null }), '')
  assert.equal(describeFailure({ ...task, error: '   ' }), '')
})

test('failedTasks keeps failures and leaves cancellation out of the failure list', () => {
  const tasks = [
    { task_id: 'a', status: 'completed', stage: null, error: null, result: null, created_at_iso: '2026-10-02T02:03:53+00:00' },
    { task_id: 'b', status: 'failed', stage: 'failed', error: 'x', result: null, created_at_iso: '2026-10-02T02:25:34+00:00', processing_seconds: 89.4 },
    { task_id: 'c', status: 'cancelled', stage: null, error: null, result: null, created_at_iso: '2026-10-02T02:53:25+00:00' },
  ]
  const failures = failedTasks(tasks)
  assert.deepEqual(failures.map((t) => t.task_id), ['b'])
  assert.equal(isCancelledTask(tasks[2]), true)
  assert.equal(durationSeconds(failures[0]), 89)
  assert.equal(taskTime(failures[0]).startsWith('10-02 '), true)
  assert.equal(taskTime({ ...tasks[0], created_at_iso: 'nonsense' }), null)
})

// --- the timeline's archive probes -----------------------------------------

test('a pending archive is re-probed on a delay; a terminal one is cached', async () => {
  let diffReads = 0
  let payload = null
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/default/sessions/${id}`, commit_count: 1 } }
    },
    async listHistory(uri) {
      return { ok: true, result: [{ uri: `${uri}/history/archive_001`, isDir: true, size: 0, modTime: '2026-10-02T02:00:00.000Z' }] }
    },
    async readText() {
      // No `.done` yet: this exercises the legacy diff-only path.
      return { ok: false, status: 404, result: null, error: 'not found' }
    },
    async readJson(uri) {
      if (uri.endsWith('/memory_diff.json')) {
        diffReads += 1
        return payload === null
          ? { ok: false, status: 404, result: null, error: 'not found' }
          : { ok: true, status: 200, result: payload, error: null }
      }
      return { ok: false, status: 404, result: null, error: 'not found' }
    },
  }
  const service = new CommitService({ api, memoryRuntime: () => null, pendingArchiveRetryMs: 0 })
  const status = await service.status('abc')
  assert.equal(status.archives[0].modTime, '2026-10-02T02:00:00.000Z', 'archive modTime reaches the timeline')
  assert.equal(status.phase, 'extracting')
  assert.deepEqual(status.latest?.state, 'pending')

  const pending = await service.summaries('abc', status.archives, 3)
  assert.equal(pending[0].state, 'pending')
  assert.equal(pending[0].summary, null)

  // Once extraction writes the diff the next probe caches the terminal state.
  payload = { operations: { adds: [{ uri: 'a' }, { uri: 'b' }], updates: [], deletes: [] }, summary: null }
  const later = await service.summaries('abc', status.archives, 3)
  assert.equal(later[0].state, 'done')
  assert.deepEqual(later[0].summary, { totalAdds: 2, totalUpdates: 0, totalDeletes: 0, totalSkipped: 0 })
  assert.equal(later[0].failure, null)
  const refreshed = await service.status('abc', { fresh: true })
  assert.equal(refreshed.latest?.state, 'done')
  assert.equal(refreshed.latest?.markers, false, 'a diff-only success is a legacy server, not marker support')
  const readsAfterWrite = diffReads
  await service.summaries('abc', status.archives, 3)
  assert.equal(diffReads, readsAfterWrite, 'a terminal probe is served from cache')
})

test('summaries returns newest first and honours the limit', async () => {
  const diffReads = []
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/default/sessions/${id}`, commit_count: 5 } }
    },
    async listHistory(uri) {
      return {
        ok: true,
        result: [1, 2, 3, 4, 5].map((n) => ({ uri: `${uri}/history/archive_00${n}`, isDir: true, size: 0, modTime: null })),
      }
    },
    async readText() {
      return { ok: true, status: 200, result: '{}', error: null }
    },
    async readJson(uri) {
      if (uri.endsWith('/memory_diff.json')) diffReads.push(uri)
      return { ok: true, status: 200, result: { operations: { adds: [], updates: [], deletes: [] } }, error: null }
    },
  }
  const service = new CommitService({ api, memoryRuntime: () => null })
  const { archives } = await service.status('abc')
  const summaries = await service.summaries('abc', archives, 2)
  assert.equal(summaries.length, 2)
  assert.equal(summaries[0].archiveUri.endsWith('/archive_005'), true, 'newest first')
  assert.equal(summaries[0].state, 'done')
  assert.equal(summaries[1].archiveUri.endsWith('/archive_004'), true)
  assert.equal(diffReads.length, 2, 'only the requested window is read')
})

test('summaries with a zero limit reads nothing', async () => {
  let reads = 0
  const api = {
    user: 'default',
    async getSession(id) {
      return { ok: true, result: { session_id: id, uri: `viking://user/default/sessions/${id}`, commit_count: 1 } }
    },
    async listHistory(uri) {
      return { ok: true, result: [{ uri: `${uri}/history/archive_001`, isDir: true, size: 0, modTime: null }] }
    },
    async readText() {
      return { ok: true, status: 200, result: '{}', error: null }
    },
    async readJson() {
      reads += 1
      return { ok: true, status: 200, result: { operations: {} }, error: null }
    },
  }
  const service = new CommitService({ api, memoryRuntime: () => null })
  const status = await service.status('abc')
  const before = reads
  assert.deepEqual(await service.summaries('abc', status.archives, 0), [])
  assert.equal(reads, before, 'summaries=0 is a valid request that reads nothing')
})
