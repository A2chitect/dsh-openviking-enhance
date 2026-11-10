// End-to-end tests for the v0.7 native read routes.
//
// The built host bundle is booted exactly as the loader does, against a fake
// OpenViking HTTP server on loopback (no live server is ever contacted and no
// test can write to a real memory store). The browser's real call shapes are
// used: guarded loopback GETs for the reads, one same-origin JSON POST for the
// plugin's own onboarding state file.
//
// What this proves, per the v0.7 design:
//   - the composed Overview degrades per part and carries the read-only checks;
//   - browse pages `fs/ls` with the documented params and caches/dedupes;
//   - the URI allowlist refuses internal scopes and unsafe paths at the route;
//   - sessions page the session directory (the server's list has no pagination);
//   - recent commits are a bounded fan-out with first-class partials;
//   - the Studio probe classifies XFO/CSP/auth/2xx answers host-side;
//   - the onboarding POST writes ONLY the plugin's 0600 local file, makes zero
//     OpenViking calls and never stores endpoint/identity values.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v07-${label}-`))

/* ========================================================================
 * The fake OpenViking server
 * ===================================================================== */

function envelope(result) {
  return JSON.stringify({ status: 'ok', result })
}

function failure(code, message, details) {
  return JSON.stringify({ status: 'error', error: { code, message, details } })
}

const SESSION_URI = 'viking://user/default/sessions'
const MEMORIES = 'viking://user/default/memories'
const ARCHIVE_DONE = 'viking://user/default/sessions/dsh-s1/history/archive_001'
const ARCHIVE_PENDING = 'viking://user/default/sessions/dsh-s2/history/archive_001'

class FakeServer {
  constructor(opts = {}) {
    this.failMetrics = opts.failMetrics === true
    this.studioStatus = 200
    this.studioHeaders = {}
    this.requests = []
    this.writes = []
    this.listings = new Map([
      [
        MEMORIES,
        [
          { uri: `${MEMORIES}/preferences`, isDir: true, size: 0, modTime: '2026-11-10T09:00:00Z' },
          {
            uri: `${MEMORIES}/preferences/tools.md`,
            isDir: false,
            size: 42,
            modTime: '2026-11-10T08:00:00Z',
            abstract: 'Long abstract '.repeat(40),
            tags: ['env=prod', 'team=a'],
          },
          { uri: `${MEMORIES}/entities`, isDir: true, size: 0, modTime: '2026-11-10T07:00:00Z' },
        ],
      ],
      [
        SESSION_URI,
        [
          { uri: `${SESSION_URI}/dsh-s1`, isDir: true, size: 0, modTime: '2026-11-10T10:04:00Z' },
          { uri: `${SESSION_URI}/dsh-s2`, isDir: true, size: 0, modTime: '2026-11-10T10:03:00Z' },
          { uri: `${SESSION_URI}/local-runner`, isDir: true, size: 0, modTime: '2026-11-10T10:02:00Z' },
          { uri: `${SESSION_URI}/dsh-s4`, isDir: true, size: 0, modTime: '2026-11-10T10:01:00Z' },
        ],
      ],
      [`${SESSION_URI}/dsh-s1/history`, [{ uri: ARCHIVE_DONE, isDir: true, size: 0, modTime: '2026-11-10T10:00:00Z' }]],
      [`${SESSION_URI}/dsh-s2/history`, [{ uri: ARCHIVE_PENDING, isDir: true, size: 0, modTime: '2026-11-10T09:59:00Z' }]],
      [`${SESSION_URI}/dsh-s4/history`, []],
      [
        'viking://user/default/resources',
        [],
      ],
    ])
    this.contents = new Map([
      [`${ARCHIVE_DONE}/.done`, 'done'],
      [
        `${ARCHIVE_DONE}/memory_diff.json`,
        JSON.stringify({
          archive_uri: ARCHIVE_DONE,
          extracted_at: '2026-11-10T10:00:00Z',
          summary: { total_adds: 2, total_updates: 1, total_deletes: 0, total_skipped: 0 },
          operations: { adds: [{ uri: 'viking://user/default/memories/entities/x', memory_type: 'entities' }] },
        }),
      ],
      [`${ARCHIVE_PENDING}/memory_diff.json`, null],
    ])
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        this.requests.push({ method: request.method, path: url.pathname, query: url.searchParams })
        try {
          this.dispatch(request, response, url, raw)
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(failure('INTERNAL', error instanceof Error ? error.message : String(error)))
        }
      })
    })
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
  }

  get base() {
    return `http://127.0.0.1:${this.server.address().port}`
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve))
  }

  requestsTo(pathname) {
    return this.requests.filter((entry) => entry.path === pathname)
  }

  dispatch(request, response, url, raw) {
    const path = url.pathname
    const reply = (status, text, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req-${this.requests.length}`, ...headers })
      response.end(text)
    }
    const fileUri = url.searchParams.get('uri') ?? ''

    if (path === '/health') {
      reply(200, JSON.stringify({ status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' }))
      return
    }
    if (path === '/studio/') {
      reply(this.studioStatus === 200 ? 200 : this.studioStatus, '<html><body>studio</body></html>', {
        'content-type': 'text/html',
        ...this.studioHeaders,
      })
      return
    }
    if (path === '/api/v1/snapshot/log') {
      reply(404, failure('NOT_FOUND', 'Git_ref not found: main', { type: 'git_ref' }))
      return
    }
    if (path === '/api/v1/tasks') {
      reply(200, envelope({ items: [], has_more: false, next_cursor: null }))
      return
    }
    if (path === '/api/v1/rules/search') {
      // The validation-only capability probe: reject the empty body without work.
      reply(400, failure('INVALID_ARGUMENT', 'task_context is required'))
      return
    }
    if (path === '/api/v1/fs/ls') {
      const listing = this.listings.get(fileUri)
      if (listing === undefined) {
        reply(404, failure('NOT_FOUND', 'not found'))
        return
      }
      const limit = Number(url.searchParams.get('node_limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const page = listing.slice(offset, offset + limit)
      // The native tree asks with `output=agent` and reads the page envelope; the
      // v0.3 history walk asks without it and reads a bare array (both are served
      // by the same server route in the tested range).
      if (url.searchParams.get('output') === 'agent') {
        reply(200, envelope({ items: page, has_more: offset + limit < listing.length }))
      } else {
        reply(200, envelope(page))
      }
      return
    }
    if (path === '/api/v1/fs/tree') {
      const entries = [
        { uri: `${MEMORIES}/preferences`, rel_path: 'preferences', isDir: true, level: 1, size: 0, modTime: '2026-11-10T09:00:00Z' },
        { uri: `${MEMORIES}/preferences/tools.md`, rel_path: 'preferences/tools.md', isDir: false, level: 2, size: 42, modTime: '2026-11-10T08:00:00Z' },
      ]
      reply(200, envelope({ items: entries, has_more: false }))
      return
    }
    if (path === '/api/v1/fs/stat') {
      reply(404, failure('NOT_FOUND', 'not found'))
      return
    }
    if (path === '/api/v1/fs/attrs') {
      reply(200, envelope({ uri: fileUri, attrs: {} }))
      return
    }
    if (path.startsWith('/api/v1/content/')) {
      const tier = path.slice('/api/v1/content/'.length)
      if (tier === 'read') {
        const content = this.contents.get(fileUri)
        if (content === undefined || content === null) {
          reply(404, failure('NOT_FOUND', 'not found'))
          return
        }
        reply(200, envelope(content))
        return
      }
      reply(404, failure('NOT_FOUND', 'no content face'))
      return
    }
    if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
      const ovSessionId = path.slice('/api/v1/sessions/'.length)
      reply(
        200,
        envelope({
          session_id: ovSessionId,
          uri: `${SESSION_URI}/${ovSessionId}`,
          pending_tokens: 7,
          commit_count: 1,
          message_count: 2,
          total_message_count: 2,
          last_commit_at: '2026-11-10T10:00:00Z',
          memories_extracted: { total: 1, memory_write: 1, memory_edit: 0 },
        }),
      )
      return
    }
    if (path === '/api/v1/console/dashboard/summary') {
      if (this.failMetrics) {
        reply(500, failure('INTERNAL', 'dashboard exploded'))
        return
      }
      reply(200, envelope({ context_counts: { files: 3, skills: 1, memories: 5, total: 9 }, today_tokens: { total: 77 }, today_retrievals: { total: 2 } }))
      return
    }
    if (path === '/api/v1/observer/queue') {
      if (this.failMetrics) {
        reply(500, failure('INTERNAL', 'queue exploded'))
        return
      }
      reply(200, envelope({ status: { queues: [{ queue: 'semantic', pending: 0, in_progress: 0, errors: 0, processed: 4 }] } }))
      return
    }
    if (path === '/api/v1/stats/memories') {
      if (this.failMetrics) {
        reply(500, failure('INTERNAL', 'stats exploded'))
        return
      }
      reply(200, envelope({ total_memories: 5, by_category: { entities: 3, events: 2 }, hotness_distribution: { hot: 2 }, staleness: { not_accessed_7d: 1 } }))
      return
    }
    reply(404, failure('NOT_FOUND', `no fake route for ${request.method} ${path}`))
  }
}

/* ========================================================================
 * Boot the built host against the fake server and a fake DSH context
 * ===================================================================== */

async function boot(options = {}) {
  const stateHome = tempDir('dsh')
  const ovHome = tempDir('ov')
  const previous = { DSH_HOME: process.env.DSH_HOME, OPENVIKING_HOME: process.env.OPENVIKING_HOME }
  process.env.DSH_HOME = stateHome
  process.env.OPENVIKING_HOME = ovHome

  const fake = new FakeServer(options)
  await fake.listen()

  const module = await import('../lib/index.js')
  const webRoutes = []
  const context = {
    webServer: {
      port: 0,
      register(route) {
        webRoutes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      callback()
      return () => {}
    },
    get() {
      return undefined
    },
    inject(_deps, callback) {
      const teardown = callback({ get: () => undefined })
      return {
        dispose() {
          if (typeof teardown === 'function') teardown()
        },
      }
    },
    logger: { info: () => {}, warn: () => {} },
  }
  module.apply(context, module.Config({ endpoint: fake.base }))

  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = webRoutes.find((candidate) => candidate.path === pathname)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'no route' }))
      return
    }
    void route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const get = async (path, headers = {}) => {
    const response = await fetch(`${base}${path}`, { headers })
    return { status: response.status, body: await response.json() }
  }
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve))
    await fake.close()
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.DSH_HOME
    if (previous.OPENVIKING_HOME === undefined) delete process.env.OPENVIKING_HOME
    else process.env.OPENVIKING_HOME = previous.OPENVIKING_HOME
  }

  return {
    fake,
    base,
    get,
    post,
    stateHome,
    webRoutes,
    onboardingPath: join(stateHome, 'state', 'dsh-openviking-enhance', 'onboarding.json'),
    shutdown,
  }
}

/* ========================================================================
 * The tests
 * ===================================================================== */

test('the v0.7 read routes are registered through the loopback web server', async () => {
  const app = await boot()
  try {
    const paths = app.webRoutes.map((route) => route.path)
    for (const path of [
      '/api/openviking-enhance/overview',
      '/api/openviking-enhance/browse/roots',
      '/api/openviking-enhance/browse',
      '/api/openviking-enhance/browse/subtree',
      '/api/openviking-enhance/sessions',
      '/api/openviking-enhance/recent-commits',
      '/api/openviking-enhance/studio-status',
      '/api/openviking-enhance/onboarding/state',
    ]) {
      assert.ok(paths.includes(path), `${path} is registered`)
    }
    // The local-state POST is the ONLY new POST route, and it is not on the
    // authenticated mutation transport (it never touches OpenViking).
    assert.equal(app.webRoutes.filter((route) => route.kind !== 'exact').length, 0)
  } finally {
    await app.shutdown()
  }
})

test('the composed overview carries every part, the checks and no secrets', async () => {
  const app = await boot()
  try {
    const { status, body } = await app.get('/api/openviking-enhance/overview?fresh=1')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const overview = body.overview
    for (const part of ['config', 'scope', 'metrics', 'plugin', 'studio', 'onboarding']) {
      assert.equal(overview.parts[part].available, true, `${part} is available`)
    }
    assert.equal(overview.config.version, '0.5.3')
    assert.equal(overview.config.healthy, true)
    assert.equal(overview.plugin.mounted, false, 'no fake memory runtime is mounted')
    assert.equal(overview.studio.frameable, 'yes', 'the fake studio sends no blocking headers')
    assert.equal(overview.metrics.dashboard.memories, 5)
    assert.equal(overview.metrics.prometheus, false)
    assert.equal(overview.onboarding.state.version, 1)
    assert.equal(overview.onboarding.state.dismissedAt, null)
    assert.deepEqual(
      overview.onboarding.checks.map((check) => check.id),
      ['endpoint', 'health', 'identity', 'memoryPlugin', 'capabilities', 'firstStep'],
    )
    assert.equal(overview.onboarding.checks.find((check) => check.id === 'memoryPlugin').status, 'warn')
    assert.equal(overview.onboarding.checks.find((check) => check.id === 'firstStep').hintKey, 'onboarding.firstStep.browse')
    const text = JSON.stringify(body)
    assert.ok(!text.includes('apiKey'), 'no key field in the payload')
    assert.ok(!text.includes('Bearer'), 'no bearer material in the payload')
    // The composed answer was cached: a second question without fresh=1 costs no
    // new OpenViking round trips.
    const before = app.fake.requests.length
    await app.get('/api/openviking-enhance/overview')
    assert.equal(app.fake.requests.length, before, 'the 5 s overview cache answers the second call')
  } finally {
    await app.shutdown()
  }
})

test('one failing overview part degrades alone', async () => {
  const app = await boot({ failMetrics: true })
  try {
    const { body } = await app.get('/api/openviking-enhance/overview?fresh=1')
    assert.equal(body.ok, true)
    assert.equal(body.overview.parts.config.available, true, 'config still answers')
    assert.equal(body.overview.parts.metrics.available, true, 'the metrics payload itself always resolves')
    assert.equal(body.overview.metrics.dashboard.available, false, 'the dashboard card degrades')
    assert.equal(body.overview.metrics.queue.available, false)
    assert.equal(body.overview.onboarding.checks.find((check) => check.id === 'capabilities').status, 'warn')
  } finally {
    await app.shutdown()
  }
})

test('browse roots are resolved host-side from the identity and carry no listing', async () => {
  const app = await boot()
  try {
    const before = app.fake.requests.filter((entry) => entry.path === '/api/v1/fs/ls').length
    const { body } = await app.get('/api/openviking-enhance/browse/roots')
    assert.equal(body.ok, true)
    const roots = body.roots
    assert.equal(roots.length, 8)
    assert.equal(roots[0].id, 'memories')
    assert.equal(roots[0].uri, 'viking://user/default/memories')
    assert.equal(roots[0].scope, 'user')
    assert.equal(roots.find((root) => root.id === 'rules').shortcut, true)
    assert.equal(roots.find((root) => root.id === 'sessions').shortcut, true)
    assert.equal(roots.find((root) => root.id === 'resources').scope, 'account')
    assert.equal(roots.find((root) => root.id === 'agentSkills').scope, 'agent')
    const after = app.fake.requests.filter((entry) => entry.path === '/api/v1/fs/ls').length
    assert.equal(after, before, 'resolving roots lists nothing')
  } finally {
    await app.shutdown()
  }
})

test('browse pages a directory with the documented params, caches and pages with offset', async () => {
  const app = await boot()
  try {
    const first = await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}&limit=2`)
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    const page = first.body.page
    assert.equal(page.uri, MEMORIES)
    assert.equal(page.entries.length, 2)
    assert.equal(page.hasMore, true)
    assert.equal(page.nextOffset, 2)
    assert.equal(page.entries[0].kind, 'directory')
    assert.equal(page.entries[1].kind, 'memory')
    assert.equal(page.entries[1].isDir, false)
    assert.deepEqual(page.entries[1].tags, ['env=prod', 'team=a'])
    assert.ok(page.entries[1].abstract.length <= 160, 'the abstract is capped at 160 chars')
    // The upstream request carried the documented pfs/ls parameters.
    const upstream = app.fake.requestsTo('/api/v1/fs/ls').at(-1)
    assert.equal(upstream.query.get('node_limit'), '2')
    assert.equal(upstream.query.get('offset'), '0')
    assert.equal(upstream.query.get('output'), 'agent')
    assert.equal(upstream.query.get('abs_limit'), '160')
    assert.equal(upstream.query.get('include_tags'), 'true')

    // Cache: the same page costs no new upstream read; fresh=1 bypasses it.
    const upstreamCount = app.fake.requestsTo('/api/v1/fs/ls').length
    await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}&limit=2`)
    assert.equal(app.fake.requestsTo('/api/v1/fs/ls').length, upstreamCount, 'the 15 s directory cache answered')
    await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}&limit=2&fresh=1`)
    assert.equal(app.fake.requestsTo('/api/v1/fs/ls').length, upstreamCount + 1, 'fresh=1 bypasses the cache')

    const second = await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}&limit=2&offset=2`)
    assert.equal(second.body.page.entries.length, 1)
    assert.equal(second.body.page.hasMore, false)
    assert.equal(second.body.page.nextOffset, null)
  } finally {
    await app.shutdown()
  }
})

test('browse refuses internal scopes and treats a stale directory as an empty page', async () => {
  const app = await boot()
  try {
    const refused = await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent('viking://queue/job-1')}`)
    assert.equal(refused.status, 400)
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'not-allowed')

    const unsafe = await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent('viking://user/default/../queue/x')}`)
    assert.equal(unsafe.status, 400)
    assert.equal(unsafe.body.error.code, 'not-allowed')

    const noUri = await app.get('/api/openviking-enhance/browse')
    assert.equal(noUri.status, 400)

    // The fake 404s this URI: a stale tree path is an empty page + a notice.
    const stale = await app.get('/api/openviking-enhance/browse?uri=viking://user/default/nope')
    assert.equal(stale.status, 200)
    assert.equal(stale.body.ok, true)
    assert.deepEqual(stale.body.page.entries, [])
    assert.equal(stale.body.page.warnings[0].code, 'staleDirectory')
  } finally {
    await app.shutdown()
  }
})

test('the bounded subtree action flattens its entries and echoes the caps', async () => {
  const app = await boot()
  try {
    const { body } = await app.get(`/api/openviking-enhance/browse/subtree?uri=${encodeURIComponent(MEMORIES)}&levels=2&nodes=100`)
    assert.equal(body.ok, true)
    assert.equal(body.subtree.levels, 2)
    assert.equal(body.subtree.nodes, 100)
    assert.equal(body.subtree.truncated, false)
    assert.equal(body.subtree.entries.length, 2)
    assert.equal(body.subtree.entries[1].relPath, 'preferences/tools.md')
    assert.equal(body.subtree.entries[1].depth, 2)
    assert.equal(body.subtree.entries[1].kind, 'memory')
    const upstream = app.fake.requestsTo('/api/v1/fs/tree').at(-1)
    assert.equal(upstream.query.get('level_limit'), '2')
    assert.equal(upstream.query.get('node_limit'), '100')
    // A crafted query cannot widen the caps.
    const clamped = await app.get(`/api/openviking-enhance/browse/subtree?uri=${encodeURIComponent(MEMORIES)}&levels=9&nodes=900`)
    assert.equal(clamped.body.subtree.levels, 2)
    assert.equal(clamped.body.subtree.nodes, 100)
  } finally {
    await app.shutdown()
  }
})

test('sessions pages the directory (the server list has no pagination) with kinds and ids', async () => {
  const app = await boot()
  try {
    const first = await app.get('/api/openviking-enhance/sessions?limit=2&fresh=1')
    assert.equal(first.body.ok, true, JSON.stringify(first.body))
    assert.equal(first.body.sessions.items.length, 2)
    assert.equal(first.body.sessions.hasMore, true)
    assert.equal(first.body.sessions.nextOffset, 2)
    assert.equal(first.body.sessions.items[0].ovSessionId, 'dsh-s1')
    assert.equal(first.body.sessions.items[0].sessionId, 's1')
    assert.equal(first.body.sessions.items[0].kind, 'dsh')
    assert.equal(first.body.sessions.items[1].kind, 'dsh')
    const upstream = app.fake.requestsTo('/api/v1/fs/ls').at(-1)
    assert.equal(upstream.query.get('sort_by'), 'mtime')
    assert.equal(upstream.query.get('sort_order'), 'desc')

    const second = await app.get('/api/openviking-enhance/sessions?limit=2&offset=2')
    assert.equal(second.body.sessions.items[0].ovSessionId, 'local-runner')
    assert.equal(second.body.sessions.items[0].sessionId, null, 'another harness is not addressable')
    assert.equal(second.body.sessions.items[0].kind, 'local')
    assert.equal(second.body.sessions.hasMore, false, 'offset 2 + limit 2 is the end of the four-row fake directory')
  } finally {
    await app.shutdown()
  }
})

test('recent commits are a bounded fan-out with real statuses and a session-cap partial', async () => {
  const app = await boot()
  try {
    const { body } = await app.get('/api/openviking-enhance/recent-commits?limit=3&fresh=1')
    assert.equal(body.ok, true)
    const recent = body.recent
    assert.equal(recent.items.length, 3)
    assert.equal(recent.partial, true, 'four session directories exist, three were asked for')
    assert.equal(recent.limitedBy, 'session-cap')
    assert.equal(recent.progress.sessionCap, 3)
    assert.deepEqual(
      recent.items.map((row) => row.ovSessionId),
      ['dsh-s1', 'dsh-s2', 'local-runner'],
    )
    const done = recent.items[0]
    assert.ok(done.status, JSON.stringify(done))
    assert.equal(done.status.commitCount, 1)
    assert.equal(done.status.pendingTokens, 7)
    assert.equal(done.summaries.length, 1)
    assert.equal(done.summaries[0].state, 'done')
    assert.equal(done.summaries[0].summary.totalAdds, 2)
    const local = recent.items[2]
    assert.equal(local.error, 'unsupported-session')
    assert.equal(local.status, null)

    // Cached for 30 s: the second read fans out again only with fresh=1.
    const before = app.fake.requests.length
    await app.get('/api/openviking-enhance/recent-commits?limit=3')
    assert.equal(app.fake.requests.length, before, 'the 30 s recent-commits cache answered')
  } finally {
    await app.shutdown()
  }
})

test('the Studio probe classifies real headers host-side and caches its answer', async () => {
  const app = await boot()
  try {
    const first = await app.get('/api/openviking-enhance/studio-status')
    assert.equal(first.body.ok, true)
    assert.equal(first.body.studio.frameable, 'yes')
    assert.equal(first.body.studio.reason, 'ok')
    assert.match(first.body.studio.url, /\/studio\/$/)

    const studioHits = app.fake.requestsTo('/studio/').length
    await app.get('/api/openviking-enhance/studio-status')
    assert.equal(app.fake.requestsTo('/studio/').length, studioHits, 'the 60 s probe cache answered')

    app.fake.studioHeaders = { 'x-frame-options': 'SAMEORIGIN' }
    const blocked = await app.get('/api/openviking-enhance/studio-status?fresh=1')
    assert.equal(blocked.body.studio.frameable, 'no')
    assert.equal(blocked.body.studio.reason, 'x-frame-options')

    app.fake.studioHeaders = { 'content-security-policy': "frame-ancestors 'none'" }
    const csp = await app.get('/api/openviking-enhance/studio-status?fresh=1')
    assert.equal(csp.body.studio.frameable, 'no')
    assert.equal(csp.body.studio.reason, 'csp-frame-ancestors')

    app.fake.studioHeaders = {}
    app.fake.studioStatus = 401
    const auth = await app.get('/api/openviking-enhance/studio-status?fresh=1')
    assert.equal(auth.body.studio.frameable, 'unknown')
    assert.equal(auth.body.studio.reason, 'auth-required')
  } finally {
    await app.shutdown()
  }
})

test('the onboarding POST writes only the 0600 local state file and never calls OpenViking', async () => {
  const app = await boot()
  try {
    // The first overview call recorded "last opened" (best effort).
    await app.get('/api/openviking-enhance/overview?fresh=1')
    const beforeCalls = app.fake.requests.length
    assert.equal(existsSync(app.onboardingPath), true, 'opening the cockpit recorded first-run state')
    assert.equal(statSync(app.onboardingPath).mode & 0o777, 0o600, 'the state file is 0600')

    const dismissed = await app.post('/api/openviking-enhance/onboarding/state', { action: 'dismiss' })
    assert.equal(dismissed.status, 200)
    assert.equal(dismissed.body.ok, true)
    assert.equal(typeof dismissed.body.state.dismissedAt, 'string')
    assert.equal(app.fake.requests.length, beforeCalls, 'the local-state POST made zero OpenViking calls')

    const stored = JSON.parse(readFileSync(app.onboardingPath, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(typeof stored.dismissedAt, 'string')
    assert.ok(!JSON.stringify(stored).includes('127.0.0.1'), 'no endpoint value is persisted')
    assert.ok(!JSON.stringify(stored).includes('default'), 'no account/user value is persisted')
    assert.ok(!JSON.stringify(stored).includes('apiKey'), 'no key field is persisted')

    const step = await app.post('/api/openviking-enhance/onboarding/state', { action: 'complete-step', stepId: 'health' })
    assert.deepEqual(step.body.state.completedStepIds, ['health'])
    const badStep = await app.post('/api/openviking-enhance/onboarding/state', { action: 'complete-step', stepId: 'root-me' })
    assert.equal(badStep.status, 400)
    assert.equal(badStep.body.ok, false)
    const badAction = await app.post('/api/openviking-enhance/onboarding/state', { action: 'install-backdoor' })
    assert.equal(badAction.status, 400)

    const full = await app.post('/api/openviking-enhance/onboarding/state', { action: 'full-check', ok: 7, warn: 2, error: 1 })
    assert.deepEqual(full.body.state.lastFullCheck.ok, 7)
    assert.deepEqual(full.body.state.lastFullCheck.warn, 2)
    assert.deepEqual(full.body.state.lastFullCheck.error, 1)
    const badCounts = await app.post('/api/openviking-enhance/onboarding/state', { action: 'full-check', ok: -1, warn: 2, error: 1 })
    assert.equal(badCounts.status, 400)

    // The overview reflects the persisted dismissal after a fresh read.
    const overview = await app.get('/api/openviking-enhance/overview?fresh=1')
    assert.equal(typeof overview.body.overview.onboarding.state.dismissedAt, 'string')

    const reset = await app.post('/api/openviking-enhance/onboarding/state', { action: 'reset' })
    assert.equal(reset.body.state.dismissedAt, null)
    assert.deepEqual(reset.body.state.completedStepIds, [])
    assert.equal(reset.body.state.lastFullCheck, null)

    // The same-origin read-only JSON guard still applies to this POST.
    const get = await app.get('/api/openviking-enhance/onboarding/state')
    assert.equal(get.status, 405, 'GET is not a method for the state route')
    const crossOrigin = await fetch(`${app.base}/api/openviking-enhance/onboarding/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ action: 'dismiss' }),
    })
    assert.equal(crossOrigin.status, 403, 'a cross-origin page cannot write the state file')
    const wrongMedia = await fetch(`${app.base}/api/openviking-enhance/onboarding/state`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'dismiss' }),
    })
    assert.equal(wrongMedia.status, 415, 'only JSON bodies are read')
  } finally {
    await app.shutdown()
  }
})

test('no route in the v0.7 surface writes to OpenViking', async () => {
  const app = await boot()
  try {
    await app.get('/api/openviking-enhance/overview?fresh=1')
    await app.get('/api/openviking-enhance/browse/roots')
    await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}`)
    await app.get(`/api/openviking-enhance/browse?uri=${encodeURIComponent(MEMORIES)}&fresh=1`)
    await app.get(`/api/openviking-enhance/browse/subtree?uri=${encodeURIComponent(MEMORIES)}`)
    await app.get('/api/openviking-enhance/sessions?fresh=1')
    await app.get('/api/openviking-enhance/recent-commits?fresh=1')
    await app.get('/api/openviking-enhance/studio-status?fresh=1')
    await app.post('/api/openviking-enhance/onboarding/state', { action: 'dismiss' })
    assert.deepEqual(app.fake.writes, [], 'no fake write endpoint was ever called')
    const methods = new Set(app.fake.requests.map((entry) => entry.method))
    assert.deepEqual([...methods].sort(), ['GET', 'POST'], 'the only POST is the validation-only rules probe')
    const postedPaths = app.fake.requests.filter((entry) => entry.method === 'POST').map((entry) => entry.path)
    assert.deepEqual(postedPaths, ['/api/v1/rules/search'], 'no write route was POSTed')
  } finally {
    await app.shutdown()
  }
})
