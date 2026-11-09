// v0.3's own contracts: the recall explanation, the session log's five states,
// the Doctor, the official plugin's local queue, and the text diff.
//
// These are unit tests on purpose. The host smoke harness exercises the same
// routes against a live server; here the wire shapes are pinned so a server that
// changes one field, or a fallback branch that stops reporting why it ran,
// fails a test rather than a panel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OpenVikingApi } from '../src/host/openviking-api.ts'
import {
  RecallService,
  bucketOf,
  codingQuotas,
  contextRequestBody,
  effectiveRecallSettings,
} from '../src/host/recall-service.ts'
import { deriveSessionState, toEvents } from '../src/host/session-log.ts'
import { DoctorService, compatibilityOf } from '../src/host/doctor-service.ts'
import { readPendingQueue } from '../src/host/local-state.ts'
import { resolveConnectionWithOrigins } from '../src/host/config.ts'
import { lineDiff } from '../src/shared/text-diff.ts'

/** Run `body` with a stub HTTP server and hand it the base URL. */
async function withStub(handler, body) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.close()
  }
}

const SESSION_URI = 'viking://user/default/sessions/dsh-s1'
const SESSION = {
  session_id: 'dsh-s1',
  uri: SESSION_URI,
  created_by_user_id: 'default',
  message_count: 4,
  total_message_count: 12,
  commit_count: 2,
  memories_extracted: { total: 9, memory_write: 7, memory_edit: 2 },
  last_commit_at: '2026-11-01T10:00:00Z',
  last_auto_commit_at: '2026-11-01T09:00:00Z',
  last_message_at: '2026-11-01T10:05:00Z',
  pending_tokens: 1200,
  created_at: '2026-11-01T09:00:00Z',
  updated_at: '2026-11-01T10:05:00Z',
  user: { account_id: 'default', user_id: 'default' },
}

/** A commit-service stand-in exposing only what RecallService reads. */
function fakeCommit(overrides = {}) {
  return {
    ovSessionId: () => 'dsh-s1',
    actorPeer: () => undefined,
    pluginConfig: () => null,
    pluginMounted: () => false,
    pluginPeerSource: () => null,
    ...overrides,
  }
}

const CONTEXT_REPLY = {
  entries: [
    {
      uri: 'viking://user/default/memories/events/2026/11/01/release.md',
      category: 'events',
      score: 0.8123,
      detail: 'overview',
      text: 'The release checklist.',
      origin: 'self',
    },
    {
      uri: 'viking://user/default/resources/guide.md',
      category: 'resources',
      score: 0.611,
      detail: 'full',
      text: 'A resource body.',
      origin: 'self',
    },
  ],
  rendered: '<memory uri="viking://user/default/memories/events/2026/11/01/release.md">…</memory>',
  stats: {
    searched: { events: 18, resources: 9 },
    candidates: 27,
    returned: 2,
    dropped: 0,
    deduped: 1,
    excluded: 0,
    max_tokens: 1600,
    used_tokens: 180,
    quotas: { events: 1, resources: 3 },
    tier_counts: { overview: 1, full: 1 },
    origins: { self: 2 },
    peer_scope: 'all',
    planned_queries: ['release checklist'],
    query_expansion: 'off',
    rewrite: 'off',
    score_threshold: 0.35,
    dedup: { turns: 5, status: 'on', cooled: 0, turn: 2 },
    fill: { spare_upgrades: 0 },
  },
}

/** A stub OpenViking for the explanation paths. */
async function explainBody(handler, body) {
  return withStub(handler, async (base) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const tmp = await mkdtemp(join(tmpdir(), 'ove-v03-'))
    return body({ api, base, tmp })
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

test('the context explanation maps the server accounting and its entry fields', async () => {
  await explainBody(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/v1/sessions/')) return send(res, 200, { status: 'ok', result: SESSION })
      if (url.pathname === '/api/v1/search/search') {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          assert.equal(JSON.parse(raw).mode, 'context')
          send(res, 200, { status: 'ok', result: CONTEXT_REPLY })
        })
        return
      }
      send(res, 404, { error: { message: 'no route' } })
    },
    async ({ api, tmp }) => {
      const service = new RecallService({
        api,
        commit: fakeCommit({ pluginConfig: () => ({ scoreThreshold: 0.35, recallDedupTurns: 5 }) }),
        localState: { home: tmp },
      })
      const explanation = await service.explain('session-1', 'release checklist', { source: 'turn' })
      assert.equal(explanation.mode, 'context')
      assert.equal(explanation.replay, true)
      assert.equal(explanation.query.source, 'turn')
      assert.equal(explanation.entries.length, 2)
      assert.equal(explanation.entries[0].bucket, 'memories')
      assert.equal(explanation.entries[0].category, 'events')
      assert.equal(explanation.entries[0].detail, 'overview')
      assert.equal(explanation.entries[0].origin, 'self')
      assert.equal(explanation.entries[1].bucket, 'resources')
      assert.ok(explanation.rendered.startsWith('<memory'))
      assert.equal(explanation.stats.usedTokens, 180)
      assert.equal(explanation.stats.maxTokens, 1600)
      assert.equal(explanation.stats.deduped, 1)
      assert.equal(explanation.stats.dedup.turns, 5)
      assert.deepEqual(explanation.stats.plannedQueries, ['release checklist'])
      assert.equal(explanation.effective.scoreThreshold, 0.35)
      assert.equal(explanation.effective.dedupTurns, 5)
    },
  )
})

test('a legacy server falls back to per-target search and says why', async () => {
  const searched = []
  await explainBody(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/v1/sessions/')) return send(res, 200, { status: 'ok', result: SESSION })
      if (url.pathname === '/api/v1/search/search') {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          const body = JSON.parse(raw)
          if (body.mode === 'context') {
            send(res, 400, { status: 'error', error: { message: 'extra inputs are not permitted: mode' } })
            return
          }
          searched.push(body.target_uri)
          send(res, 200, {
            status: 'ok',
            result: {
              memories: [{ uri: 'viking://user/default/memories/entities/x.md', score: 0.5, context_type: 'memory', abstract: 'X' }],
              resources: [],
              skills: [],
              total: 1,
              query_plan: { reasoning: 'legacy plan' },
            },
          })
        })
        return
      }
      send(res, 404, { error: { message: 'no route' } })
    },
    async ({ api, tmp }) => {
      const service = new RecallService({ api, commit: fakeCommit(), localState: { home: tmp } })
      const explanation = await service.explain('session-1', 'why this', { source: 'turn' })
      assert.equal(explanation.mode, 'search')
      assert.equal(explanation.replay, true)
      assert.equal(explanation.stats, null)
      assert.ok(explanation.warnings.some((warning) => warning.code === 'contextUnavailable'))
      assert.ok(searched.length >= 2, `expected per-target searches, saw ${searched.join(', ')}`)
      assert.equal(explanation.entries[0].bucket, 'memories')
      assert.equal(explanation.plan, 'legacy plan')
    },
  )
})

test('the context request mirrors the mounted plugin, and omits knobs it did not configure', () => {
  const plain = contextRequestBody('why', 'dsh-s1', null)
  assert.equal(plain.mode, 'context')
  assert.equal(plain.purpose, 'coding')
  assert.equal(plain.score_threshold, 0.35)
  assert.equal(plain.session_id, 'dsh-s1')
  assert.equal(plain.dedup_turns, 5)
  assert.equal(plain.quotas, undefined, 'quotas stay server-default unless configured')
  assert.equal(plain.max_tokens, undefined, 'max_tokens stays server-default unless configured')

  const configured = contextRequestBody('why', 'dsh-s1', {
    recallLimit: 12,
    recallLimitConfigured: true,
    recallMaxTokens: 2200,
    recallMaxTokensConfigured: true,
    recallDedupTurns: 2,
    recallPeerScope: 'actor',
    recallQueryExpansion: 'off',
    recallQueryExpansionConfigured: true,
    recallExcludeUris: ['viking://a', 'viking://b'],
    recallRewrite: 'server',
    recallCompressMaxBullets: 4,
    recallCompressMaxBulletsConfigured: true,
  })
  assert.deepEqual(configured.quotas, codingQuotas(12))
  assert.equal(configured.max_tokens, 2200)
  assert.equal(configured.dedup_turns, 2)
  assert.equal(configured.peer_scope, 'actor')
  assert.equal(configured.query_expansion, 'off')
  assert.deepEqual(configured.exclude_uris, ['viking://a', 'viking://b'])
  assert.equal(configured.rewrite, true)
  assert.equal(configured.rewrite_max_bullets, 4)
})

test('coding quotas stay within the requested slot count', () => {
  for (const limit of [1, 3, 10, 12]) {
    const quotas = codingQuotas(limit)
    const total = Object.values(quotas).reduce((sum, value) => sum + value, 0)
    assert.equal(total, Math.max(limit, Object.keys(quotas).length))
  }
})

test('effective settings expose only the fields the explanation uses', () => {
  const effective = effectiveRecallSettings({
    scoreThreshold: 0.4,
    recallLimit: 8,
    recallMaxTokens: 1200,
    recallTokenBudget: 2000,
    recallDedupTurns: 5,
    recallQueryExpansion: 'auto',
    recallRewrite: 'off',
    recallPeerScope: 'all',
    commitTokenThreshold: 20000,
    apiKey: 'never',
  })
  assert.deepEqual(effective, {
    scoreThreshold: 0.4,
    recallLimit: 8,
    recallMaxTokens: 1200,
    recallTokenBudget: 2000,
    dedupTurns: 5,
    queryExpansion: 'auto',
    rewrite: 'off',
    peerScope: 'all',
    commitTokenThreshold: 20000,
  })
  assert.equal(effectiveRecallSettings(null), null)
})

test('a hit is grouped by URI when the server names no category', () => {
  assert.equal(bucketOf('viking://user/default/skills/x.md', null), 'skills')
  assert.equal(bucketOf('viking://user/default/resources/x.md', null), 'resources')
  assert.equal(bucketOf('viking://user/default/memories/events/x.md', 'events'), 'memories')
})

test('the session state distinguishes the five working states', () => {
  const base = {
    serverOk: true,
    totalMessageCount: 1,
    messageCount: 1,
    pendingTokens: 10,
    commitCount: 0,
    archiveCount: 0,
    activeTask: false,
    latestArchiveState: null,
    pendingQueueCount: 0,
  }
  assert.equal(deriveSessionState({ ...base, totalMessageCount: 0, messageCount: 0, pendingTokens: 0 }), 'no-messages')
  assert.equal(deriveSessionState(base), 'not-committed')
  assert.equal(deriveSessionState({ ...base, activeTask: true }), 'extracting')
  assert.equal(deriveSessionState({ ...base, latestArchiveState: 'pending' }), 'extracting')
  assert.equal(deriveSessionState({ ...base, latestArchiveState: 'failed', commitCount: 1 }), 'failed')
  assert.equal(deriveSessionState({ ...base, pendingQueueCount: 2 }), 'queued')
  assert.equal(deriveSessionState({ ...base, commitCount: 1, pendingTokens: 0, messageCount: 0 }), 'committed')
  assert.equal(deriveSessionState({ ...base, serverOk: false }), 'unknown')
})

test('the activity timeline is newest-first and includes commit, failure and queue facts', () => {
  const events = toEvents(
    SESSION,
    [
      { archiveUri: 'viking://…/archive_001', archiveId: 'archive_001', modTime: '2026-11-01T10:00:00Z' },
      { archiveUri: 'viking://…/archive_002', archiveId: 'archive_002', modTime: '2026-11-01T11:00:00Z' },
    ],
    [
      {
        archiveUri: 'viking://…/archive_002',
        summary: null,
        state: 'failed',
        failure: { stage: 'extract', error: 'boom', failedAt: '2026-11-01T11:01:00Z', skipped: false },
      },
    ],
    '2026-11-01T12:00:00Z',
  )
  assert.equal(events[0].kind, 'queued')
  assert.ok(events.some((event) => event.kind === 'failed' && event.detail === 'extract'))
  assert.ok(events.filter((event) => event.kind === 'commit').length >= 2)
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(Date.parse(events[index - 1].at) >= Date.parse(events[index].at))
  }
})

test('the local pending queue filters by session and never exposes payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ove-pending-'))
  const entry = (sessionId, type, createdAt) => ({ type, sessionId, payload: { text: 'private transcript' }, createdAt, retries: 1, dedupKey: 'k' })
  await writeFile(join(dir, 'a_1.json'), JSON.stringify(entry('dsh-s1', 'addMessage', 1000)))
  await writeFile(join(dir, 'b_1.json'), JSON.stringify(entry('dsh-s1', 'commitSession', 2000)))
  await writeFile(join(dir, 'c_1.processing'), JSON.stringify(entry('dsh-s1', 'addMessage', 3000)))
  await writeFile(join(dir, 'd_1.json'), JSON.stringify(entry('dsh-other', 'addMessage', 4000)))
  await writeFile(join(dir, 'broken.json'), '{not json')
  const summary = await readPendingQueue('dsh-s1', { pendingDir: dir })
  assert.equal(summary.available, true)
  assert.equal(summary.total, 3)
  assert.equal(summary.items.length, 3)
  assert.equal(summary.items[0].processing, true, 'the newest item (processing) sorts first')
  assert.ok(!JSON.stringify(summary).includes('private transcript'))
  const missing = await readPendingQueue('dsh-s1', { pendingDir: join(dir, 'nope') })
  assert.equal(missing.available, true, 'a missing queue is an empty queue, not a failure')
  assert.equal(missing.total, 0)
})

test('connection origins name the layer that supplied each field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ove-home-'))
  await writeFile(join(home, 'ovcli.conf'), JSON.stringify({ url: 'http://127.0.0.1:1999', api_key: 'secret' }))
  await writeFile(join(home, 'ovcli.conf.local'), JSON.stringify({ account: 'acct', user: 'usr' }))
  const previous = process.env.OPENVIKING_HOME
  process.env.OPENVIKING_HOME = home
  try {
    const resolution = resolveConnectionWithOrigins({}, { OPENVIKING_BASE_URL: 'http://127.0.0.1:1888' })
    assert.equal(resolution.connection.endpoint, 'http://127.0.0.1:1888')
    assert.equal(resolution.connection.account, 'acct')
    assert.equal(resolution.connection.user, 'usr')
    const sourceOf = (field) => resolution.origins.find((origin) => origin.field === field)
    assert.equal(sourceOf('endpoint').source, 'env')
    assert.equal(sourceOf('endpoint').detail, 'OPENVIKING_BASE_URL')
    assert.equal(sourceOf('apiKey').source, 'ovcli')
    assert.equal(sourceOf('apiKey').configured, true)
    assert.ok(!('value' in sourceOf('apiKey')), 'the secret is never part of the origin record')
    assert.equal(sourceOf('account').source, 'ovcli.local')
    assert.equal(sourceOf('user').source, 'ovcli.local')

    const overridden = resolveConnectionWithOrigins({ endpoint: 'http://127.0.0.1:1777' }, {})
    assert.equal(overridden.connection.endpoint, 'http://127.0.0.1:1777')
    assert.equal(overridden.origins.find((origin) => origin.field === 'endpoint').source, 'override')
  } finally {
    if (previous === undefined) delete process.env.OPENVIKING_HOME
    else process.env.OPENVIKING_HOME = previous
  }
})

test('the DSH compatibility check is honest about untested generations', () => {
  assert.equal(compatibilityOf('0.2.1-rc.3').compatible, true)
  assert.equal(compatibilityOf('0.2.2-rc.1').compatible, true)
  assert.equal(compatibilityOf('0.1.7-rc.2').compatible, false)
  assert.equal(compatibilityOf('0.2.0-rc.1').compatible, false)
  assert.equal(compatibilityOf('0.2.0-rc.2').compatible, true)
  assert.equal(compatibilityOf('0.3.0').compatible, false)
  assert.equal(compatibilityOf('not-a-version').compatible, null)
  assert.equal(compatibilityOf(null).compatible, null)
})

test('the Doctor reports connection, plugin and capability facts without a secret', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ove-doctor-'))
  const reply = (result) => ({ ok: true, status: 200, result, error: null })
  const api = {
    user: 'default',
    health: async () => ({ ok: true, version: '0.5.3', authMode: 'dev', error: null }),
    systemStatus: async () => reply({ initialized: true, user: 'default' }),
    listSkills: async () => reply({ skills: [{ name: 'a' }, { name: 'b' }] }),
    observerRetrieval: async () => reply({ status: { total_queries: 10, avg_latency_ms: 500 } }),
    getSession: async () => reply(SESSION),
    searchContext: async () => reply({ entries: [], stats: {} }),
    rulesSearch: async () => reply({ rules: [], warning: 'rule library is empty' }),
    fsStat: async () => reply({ uri: 'viking://user/default', isDir: true }),
  }
  const commit = fakeCommit({
    pluginMounted: () => true,
    pluginConfig: () => ({
      enabled: true,
      autoRecall: true,
      autoCapture: true,
      scoreThreshold: 0.35,
      commitTokenThreshold: 20000,
      peerSource: 'git',
      apiKey: 'secret',
    }),
    pluginPeerSource: () => 'git',
  })
  const service = new DoctorService({
    api,
    commit,
    connection: { endpoint: 'http://127.0.0.1:1933', apiKey: 'secret', account: 'default', user: 'default' },
    origins: [
      { field: 'endpoint', source: 'ovcli', detail: 'ovcli.conf', configured: true },
      { field: 'apiKey', source: 'ovcli', detail: 'ovcli.conf', configured: true },
      { field: 'account', source: 'default', detail: null, configured: false },
      { field: 'user', source: 'default', detail: null, configured: false },
    ],
    dshVersion: () => '0.2.2-rc.1',
    pluginVersion: () => '0.5.32',
    tools: () => ['mcp__openviking__search', 'mcp__openviking__read', 'other_tool'],
    localState: { home },
  })
  const report = await service.report('session-1', { probe: true })
  assert.equal(report.health.version, '0.5.3')
  assert.equal(report.plugin.mounted, true)
  assert.equal(report.plugin.version, '0.5.32')
  assert.equal(report.capabilities.contextFace.state, 'available')
  assert.equal(report.capabilities.ruleSearch.state, 'available')
  assert.equal(report.capabilities.skills.count, 2)
  assert.equal(report.capabilities.mcpTools.count, 2)
  assert.ok(report.checks.some((check) => check.id === 'mcpTools' && check.status === 'ok'))
  assert.equal(report.compatibility.dshCompatible, true)
  assert.ok(report.checks.length >= 12)
  assert.ok(report.checks.some((check) => check.id === 'commitThreshold' && check.status === 'ok'))
  assert.ok(!JSON.stringify(report).includes('"apiKey":"secret"'), 'the key is not copied into the report')
  assert.ok(!JSON.stringify(report.diagnostics).includes('secret'), 'nor into the diagnostics')
})

test('the text diff marks the changed lines and bounds huge inputs', () => {
  const diff = lineDiff('a\nb\nc', 'a\nB\nc')
  assert.equal(diff.removed, 1)
  assert.equal(diff.added, 1)
  assert.deepEqual(
    diff.rows.map((row) => `${row.kind}:${row.text}`),
    ['same:a', 'remove:b', 'add:B', 'same:c'],
  )
  const huge = lineDiff(Array.from({ length: 400 }, (_, index) => `old-${index}`).join('\n'), 'new')
  assert.equal(huge.truncated, true)
  assert.equal(huge.removed, 400)
  assert.equal(huge.added, 1)
})
