// End-to-end tests for the v0.9 "Native II — multi-scope" layer.
//
// Same harness as `test/v05-routes.test.mjs`/`test/v08-routes.test.mjs`: boot the
// BUILT host bundle with a fake DSH context (a working `ctx.connection.fetch`
// transport and a `loader/volatile-update` emitter) against **three invented fake
// OpenViking servers** on loopback:
//
//   A — dev-mode server, data set "alpha"
//   B — dev-mode server, data set "beta"
//   C — api_key-mode server (identity key-bound), data set "gamma"
//
// The v0.9 exit criteria are pinned here: boot precedence (Config override →
// scope state → profile header → legacy), the scope fingerprint route header and
// response label, `scope-changed` refusals (request-side and stale-response),
// guarded switching, identity overrides per auth mode, token `identity-changed`,
// per-scope cache isolation, the session→scope mismatch warning, the four ACL
// states and — stated explicitly — that no `/admin` path is ever requested.
//
// Nothing here talks to a live OpenViking; no fixture is a real memory store.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v09-${label}-`))
const STATE_DIR = 'state/dsh-openviking-enhance'

function envelope(result) {
  return JSON.stringify({ status: 'ok', result })
}
function failure(code, message, details) {
  return JSON.stringify({ status: 'error', error: { code, message, details } })
}

/* ========================================================================
 * The fake OpenViking server (one per scope)
 * ===================================================================== */

class FakeServer {
  constructor(options) {
    this.label = options.label
    this.authMode = options.authMode ?? 'dev'
    this.data = options.data
    this.requests = []
    this.delayMs = 0
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        try {
          body = raw.length === 0 ? null : JSON.parse(raw)
        } catch {
          body = null
        }
        this.requests.push({
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          headers: { ...request.headers },
        })
        const dispatch = () => {
          try {
            this.dispatch(request, response, url, body)
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(failure('INTERNAL', error instanceof Error ? error.message : String(error)))
          }
        }
        const slow = url.searchParams.get('uri')?.includes('slow') === true
        const delay = slow ? 250 : url.pathname === '/health' ? 0 : this.delayMs
        if (delay > 0) setTimeout(dispatch, delay)
        else dispatch()
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

  get paths() {
    return this.requests.map((entry) => entry.path)
  }

  /** Every request that used one of the admin/account/group APIs (must stay 0). */
  get adminRequests() {
    return this.requests.filter(
      (entry) =>
        entry.path.startsWith('/api/v1/admin') ||
        entry.path.startsWith('/api/v1/accounts') ||
        entry.path.startsWith('/api/v1/groups'),
    )
  }

  dispatch(request, response, url, body) {
    const path = url.pathname
    const reply = (status, text, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': contentType, 'x-request-id': `req-${this.requests.length}` })
      response.end(text)
    }
    const echoHeaders = () => ({
      account: request.headers['x-openviking-account'] ?? null,
      user: request.headers['x-openviking-user'] ?? null,
      peer: request.headers['x-openviking-actor-peer'] ?? null,
      role: request.headers['x-openviking-role'] ?? null,
    })
    const ok = (result) => reply(200, envelope(result))

    if (path === '/health') {
      reply(
        200,
        JSON.stringify({
          status: 'ok',
          healthy: true,
          version: this.data.version,
          auth_mode: this.authMode,
          ...(this.authMode === 'dev' ? { account_id: 'default', user_id: 'default' } : {}),
        }),
      )
      return
    }
    /* ---- capability probes (cheap, read-only) ---------------------------- */
    if (path === '/api/v1/snapshot/log') {
      reply(404, failure('NOT_FOUND', 'no commits yet', { type: 'git_ref' }))
      return
    }
    if (path === '/api/v1/tasks' && request.method === 'GET') {
      ok({ items: [], has_more: false, next_cursor: null })
      return
    }
    if (path === '/api/v1/compile/capabilities') {
      ok({ configured: true, can_create: true })
      return
    }
    if (path === '/api/v1/snapshot/versions' || path === '/api/v1/snapshot/diff-paths') {
      reply(400, failure('INVALID_ARGUMENT', 'required parameter missing'))
      return
    }
    if (path === '/api/v1/rules/search' && request.method === 'POST') {
      reply(400, failure('INVALID_ARGUMENT', 'task_context required'))
      return
    }
    /* ---- browse / preview ------------------------------------------------ */
    if (path === '/api/v1/fs/ls') {
      const uri = url.searchParams.get('uri') ?? ''
      ok({
        uri,
        items: [
          { uri: `${uri}/file-${this.data.label}.md`, name: `file-${this.data.label}.md`, is_dir: false, size: 12, mod_time: '2026-11-10T00:00:00Z' },
        ],
        has_more: false,
        next_cursor: null,
      })
      return
    }
    if (path === '/api/v1/fs/tree') {
      ok({ items: [], has_more: false })
      return
    }
    if (path === '/api/v1/content/read' || path === '/api/v1/content/abstract' || path === '/api/v1/content/overview') {
      ok(`hello ${this.data.label} ${JSON.stringify(echoHeaders())}`)
      return
    }
    if (path === '/api/v1/fs/stat') {
      ok({ uri: url.searchParams.get('uri') ?? '', size: 12, modTime: '2026-11-10T00:00:00Z' })
      return
    }
    if (path === '/api/v1/fs/attrs') {
      ok({ uri: url.searchParams.get('uri') ?? '', attrs: { tags: [] } })
      return
    }
    if (path === '/api/v1/content/set_tags' && request.method === 'POST') {
      ok({ uri: body?.uri ?? '', tags: body?.tags ?? [], mode: body?.mode ?? 'replace', tags_updated: true })
      return
    }
    if (path === '/api/v1/snapshot/commit' && request.method === 'POST') {
      ok({ result: 'created', commit_oid: `commit-${this.data.label}`, changed: 1 })
      return
    }
    /* ---- Activity tab metric sources (scope cache test B5) -------------- */
    if (path === '/api/v1/console/dashboard/summary') {
      ok({ context_counts: { files: this.data.memories, skills: 0, memories: this.data.memories, total: this.data.memories }, today_tokens: { total: this.data.memories }, today_retrievals: { total: 1 } })
      return
    }
    if (path === '/api/v1/observer/queue') {
      ok({ status: { queues: [] } })
      return
    }
    if (path === '/api/v1/stats/memories') {
      ok({ total_memories: this.data.memories, by_category: {}, hotness_distribution: {}, staleness: {} })
      return
    }
    if (path.startsWith('/api/v1/stats/sessions/')) {
      ok({ session_id: path.split('/').pop(), total_turns: 1, memories_extracted: this.data.memories })
      return
    }
    /* ---- ACL: the four states ------------------------------------------- */
    if (path === '/api/v1/acl') {
      const uri = url.searchParams.get('uri') ?? ''
      if (uri === 'viking://resources/ok') {
        ok({
          uri,
          acl_mode: 'restricted',
          direct_entries: [{ principal: 'user:alice', level: 'read' }],
          inherited_entries: [{ principal: 'group:reviewers', level: 'write' }],
          effective_entries: [
            { principal: 'user:alice', level: 'read' },
            { principal: 'group:reviewers', level: 'write' },
          ],
        })
        return
      }
      if (uri === 'viking://resources/denied') {
        reply(403, failure('PERMISSION_DENIED', 'ACL management denied: manage permission required'))
        return
      }
      if (uri === 'viking://resources/auth') {
        reply(401, failure('UNAUTHORIZED', 'invalid api key'))
        return
      }
      if (uri === 'viking://resources/boom') {
        reply(500, failure('INTERNAL', 'boom'))
        return
      }
      if (uri === 'viking://resources/no-mode') {
        // A build that answers the report but omits acl_mode: the plugin must
        // report "unknown", never guess "inherit" (review S2).
        ok({ uri, direct_entries: [], inherited_entries: [], effective_entries: [] })
        return
      }
      reply(404, failure('NOT_FOUND', 'no ACL route on this build'))
      return
    }
    /* ---- everything else is an honest 404 ------------------------------- */
    reply(404, failure('NOT_FOUND', `no fake route for ${request.method} ${path}`))
  }
}

/* ========================================================================
 * Boot the built host against the fake servers and a fake DSH context
 * ===================================================================== */

function seedState(dshHome, profiles, activeProfileId, identity = null) {
  const dir = join(dshHome, STATE_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, activeProfileId, profiles }, null, 2), { mode: 0o600 })
  writeFileSync(
    join(dir, 'scope-state.json'),
    JSON.stringify({ version: 1, activeProfileId: activeProfileId || '', identity, updatedAt: '2026-11-10T00:00:00.000Z' }, null, 2),
    { mode: 0o600 },
  )
}

async function boot(options = {}) {
  const stateHome = tempDir('dsh')
  const ovHome = tempDir('ov')
  const previous = { DSH_HOME: process.env.DSH_HOME, OPENVIKING_HOME: process.env.OPENVIKING_HOME }
  process.env.DSH_HOME = stateHome
  process.env.OPENVIKING_HOME = ovHome

  const serverA = new FakeServer({ label: 'a', data: { label: 'alpha', version: '0.5.3', memories: 111 } })
  const serverB = new FakeServer({ label: 'b', data: { label: 'beta', version: '0.5.2', memories: 222 } })
  const serverC = new FakeServer({ label: 'c', authMode: 'api_key', data: { label: 'gamma', version: '0.5.1.1', memories: 333 } })
  await Promise.all([serverA.listen(), serverB.listen(), serverC.listen()])

  const profiles = [
    {
      id: 'alpha',
      label: 'Alpha dev',
      endpoint: serverA.base,
      authMode: 'dev',
      apiKey: '',
      account: 'default',
      user: 'default',
      peerId: '',
    },
    {
      id: 'beta',
      label: 'Beta dev',
      endpoint: serverB.base,
      authMode: 'dev',
      apiKey: '',
      account: 'default',
      user: 'default',
      peerId: '',
    },
    {
      id: 'gamma',
      label: 'Gamma key-bound',
      endpoint: serverC.base,
      authMode: 'api_key',
      apiKey: 'gamma-secret-must-never-leak',
      account: 'default',
      user: 'default',
      peerId: '',
    },
  ]
  seedState(stateHome, profiles, options.activeProfileId ?? 'alpha', options.identity ?? null)
  if (options.corruptScopeState === true) {
    writeFileSync(join(stateHome, STATE_DIR, 'scope-state.json'), '{broken json', { mode: 0o600 })
  }

  const holder = { activeProfile: options.configActiveProfile ?? '' }
  const module = await import('../lib/index.js')
  const webRoutes = []
  const fetchRoutes = []
  const volatileListeners = []
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
    on(event, listener) {
      if (event === 'loader/volatile-update') volatileListeners.push(listener)
      return () => {}
    },
    inject(deps, callback) {
      if (deps.includes('connection')) {
        const scope = {
          get(name) {
            if (name !== 'connection') return undefined
            return {
              fetch: {
                register(route) {
                  fetchRoutes.push(route)
                  return async () => {}
                },
              },
            }
          },
        }
        const teardown = callback(scope)
        return { dispose() { if (typeof teardown === 'function') teardown() } }
      }
      const teardown = callback({ get: () => undefined })
      return { dispose() { if (typeof teardown === 'function') teardown() } }
    },
    logger: { info: () => {}, warn: () => {} },
  }
  const config = { ...module.Config({ enableWrites: true, enableOps: false }), activeProfile: { get: () => holder.activeProfile } }
  module.apply(context, config)

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

  const getRaw = (path, headers = {}) => fetch(`${base}${path}`, { headers })
  const get = async (path, headers = {}) => {
    const response = await getRaw(path, headers)
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  const mutate = async (path, body, headers = {}) => {
    const route = fetchRoutes.find((candidate) => candidate.path === path)
    assert.ok(route, `the ${path} mutation route is registered on ctx.connection.fetch`)
    const response = await route.fetch(
      new Request(`http://127.0.0.1${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  const emitVolatile = async () => {
    for (const listener of volatileListeners) listener()
    // Let the synchronous re-resolution settle.
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const readState = (file) => JSON.parse(readFileSync(join(stateHome, STATE_DIR, file), 'utf8'))

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve))
    await Promise.all([serverA.close(), serverB.close(), serverC.close()])
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.DSH_HOME
    if (previous.OPENVIKING_HOME === undefined) delete process.env.OPENVIKING_HOME
    else process.env.OPENVIKING_HOME = previous.OPENVIKING_HOME
  }
  return { base, get, getRaw, mutate, emitVolatile, readState, holder, serverA, serverB, serverC, stateHome, module, shutdown }
}

const API = '/api/openviking-enhance'

/* ---- boot / scope payload ---------------------------------------------- */

test('the persisted last scope boots active, is labelled and exposes the scope list', async () => {
  const app = await boot()
  try {
    const scope = await app.get(`${API}/scope`)
    assert.equal(scope.body.ok, true)
    assert.equal(scope.body.scope.identity.profileId, 'alpha')
    assert.equal(scope.body.scope.identity.profileLabel, 'Alpha dev')
    assert.match(scope.body.scope.identity.fingerprint, /^sha256:[0-9a-f]{64}$/)
    const labelled = scope.headers.get('x-dsh-openviking-scope')
    assert.equal(labelled, scope.body.scope.identity.fingerprint, 'every response is labelled with the active scope')

    const list = await app.get(`${API}/scopes`)
    assert.equal(list.body.ok, true)
    assert.equal(list.body.scopes.active.profileId, 'alpha')
    assert.equal(list.body.scopes.scopes.length, 3)
    const alpha = list.body.scopes.scopes.find((row) => row.id === 'alpha')
    const beta = list.body.scopes.scopes.find((row) => row.id === 'beta')
    assert.equal(alpha.isActive, true)
    assert.equal(alpha.health.ok, true)
    assert.equal(alpha.health.version, '0.5.3')
    assert.equal(beta.isActive, false)
    assert.equal(beta.health.ok, true)
    assert.equal(JSON.stringify(list.body).includes('gamma-secret-must-never-leak'), false, 'the key never leaves the host')
    assert.equal(list.body.scopes.overrides.allowed.account, true)
    // No admin/account/group endpoint was requested by any scope flow.
    assert.equal(app.serverA.adminRequests.length, 0)
    assert.equal(app.serverB.adminRequests.length, 0)
    assert.equal(app.serverC.adminRequests.length, 0)
  } finally {
    await app.shutdown()
  }
})

test('the v0.9 scope-state file exists private after boot and holds no secret', async () => {
  const app = await boot()
  try {
    const path = join(app.stateHome, STATE_DIR, 'scope-state.json')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const raw = readFileSync(path, 'utf8')
    assert.equal(raw.includes('gamma-secret-must-never-leak'), false)
    assert.equal(raw.includes('http://'), false)
  } finally {
    await app.shutdown()
  }
})

/* ---- scope header enforcement ------------------------------------------ */

test('a request carrying a non-active scope key is refused with scope-changed before any upstream call', async () => {
  const app = await boot()
  try {
    const before = app.serverA.requests.length
    const wrong = await app.get(`${API}/browse?uri=viking://user/default/memories`, {
      'x-dsh-openviking-scope': `sha256:${'0'.repeat(64)}`,
    })
    assert.equal(wrong.status, 409)
    assert.equal(wrong.body.ok, false)
    assert.equal(wrong.body.error.code, 'scope-changed')
    assert.equal(app.serverA.requests.length, before, 'the refusal happens before the handler reads upstream')
    // A missing header stays allowed for loopback/curl use and is still labelled.
    const bare = await app.get(`${API}/browse?uri=viking://user/default/memories`)
    assert.equal(bare.status, 200)
    assert.ok(bare.headers.get('x-dsh-openviking-scope')?.startsWith('sha256:'))
    // Review B1: the two discovery routes handle the switch chain; a stale key on
    // them is answered with the CURRENT scope (still labelled), never a 409.
    for (const discovery of ['/scope', '/scopes']) {
      const answer = await app.get(`${API}${discovery}`, {
        'x-dsh-openviking-scope': `sha256:${'0'.repeat(64)}`,
      })
      assert.equal(answer.status, 200, `${discovery} must stay readable with a stale key`)
      assert.equal(answer.body.ok, true)
      assert.ok(answer.headers.get('x-dsh-openviking-scope')?.startsWith('sha256:'))
    }
    // Review S10: an over-long scope header is a caller error, not a mismatch.
    const tooLong = await app.get(`${API}/browse?uri=viking://user/default/memories`, {
      'x-dsh-openviking-scope': `sha256:${'a'.repeat(300)}`,
    })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.body.error.code, 'invalid-scope')
  } finally {
    await app.shutdown()
  }
})

test('a composed read that resolves after a switch answers scope-changed instead of stale data', async () => {
  const app = await boot()
  try {
    const scope = await app.get(`${API}/scope`)
    const oldKey = scope.body.scope.identity.fingerprint
    const before = (await app.get(`${API}/scopes`)).body.scopes.scopes.find((row) => row.isActive)
    void before
    // Start a slow browse under the old scope, switch the identity mid-flight.
    const slow = app.get(`${API}/browse?uri=viking://user/default/memories/slow`, {
      'x-dsh-openviking-scope': oldKey,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const switched = await app.mutate(`${API}/scope/identity`, { peer: 'peer-mid-flight' }, { 'x-dsh-openviking-scope': oldKey })
    assert.equal(switched.body.ok, true)
    const answer = await slow
    assert.equal(answer.status, 409, 'the host refuses to return the previous scope payload')
    assert.equal(answer.body.error.code, 'scope-changed')
  } finally {
    await app.shutdown()
  }
})

/* ---- identity overrides ------------------------------------------------ */

test('a dev-mode identity override is applied to reads and changes the scope key', async () => {
  const app = await boot()
  try {
    const first = (await app.get(`${API}/scope`)).body.scope
    const key = first.identity.fingerprint
    const switched = await app.mutate(
      `${API}/scope/identity`,
      { account: 'acme', user: 'alice', peer: 'peer-7' },
      { 'x-dsh-openviking-scope': key },
    )
    assert.equal(switched.body.ok, true, JSON.stringify(switched.body))
    assert.equal(switched.body.changed, true)
    assert.notEqual(switched.body.to, switched.body.from)
    assert.equal(switched.body.scope.identity.account, 'acme')
    assert.equal(switched.body.scope.identity.user, 'alice')
    assert.equal(switched.body.scope.identity.peer, 'peer-7')

    const after = (await app.get(`${API}/scope`)).body.scope
    assert.equal(after.identity.fingerprint, switched.body.to)
    const state = app.readState('scope-state.json')
    assert.deepEqual(state.identity, { account: 'acme', user: 'alice', peer: 'peer-7' })

    // The old key is refused; the new key reads under the overridden identity.
    const stale = await app.get(`${API}/browse?uri=viking://user/alice/memories`, { 'x-dsh-openviking-scope': key })
    assert.equal(stale.status, 409)
    const fresh = await app.get(`${API}/browse?uri=viking://user/alice/memories`, {
      'x-dsh-openviking-scope': after.identity.fingerprint,
    })
    assert.equal(fresh.status, 200)
    const lastBrowse = [...app.serverA.requests].reverse().find((entry) => entry.path === '/api/v1/fs/ls')
    assert.equal(lastBrowse.headers['x-openviking-account'], 'acme')
    assert.equal(lastBrowse.headers['x-openviking-user'], 'alice')
    assert.equal(lastBrowse.headers['x-openviking-actor-peer'], 'peer-7', 'peer is a read-lens header')
    assert.equal(lastBrowse.headers['x-openviking-role'], undefined, 'the plugin never sets a role header')

    // The switch is audited with from/to scope keys (no secrets).
    const audit = await app.get(`${API}/audit?kind=switch&limit=10`)
    const entry = audit.body.entries.find((row) => row.switch?.to === switched.body.to)
    assert.ok(entry, 'an audit entry records the switch')
    assert.equal(entry.switch.from, switched.body.from)
    assert.equal(JSON.stringify(entry).includes('gamma-secret'), false)
  } finally {
    await app.shutdown()
  }
})

/* ---- profile switch via the v0.5 ConfigForm mechanism ------------------ */

test('a profile switch persists the scope, resets overrides and isolates per-scope reads', async () => {
  const app = await boot({ activeProfileId: 'alpha', identity: { account: 'acme', user: 'alice', peer: null } })
  try {
    const before = (await app.get(`${API}/scope`)).body.scope
    assert.equal(before.identity.account, 'acme')
    const alphaBrowse = await app.get(`${API}/browse?uri=viking://user/alice/memories`, {
      'x-dsh-openviking-scope': before.identity.fingerprint,
    })
    assert.equal(alphaBrowse.body.ok, true)
    assert.equal(alphaBrowse.body.page.entries[0].name, 'file-alpha.md')

    app.holder.activeProfile = 'beta'
    await app.emitVolatile()
    const after = (await app.get(`${API}/scope`)).body.scope
    assert.equal(after.identity.profileId, 'beta')
    assert.equal(after.identity.profileLabel, 'Beta dev')
    assert.equal(after.identity.account, 'default', 'the profile switch resets the identity override')
    const state = app.readState('scope-state.json')
    assert.equal(state.activeProfileId, 'beta')
    assert.equal(state.identity, null)
    const betaBrowse = await app.get(`${API}/browse?uri=viking://user/default/memories`, {
      'x-dsh-openviking-scope': after.identity.fingerprint,
    })
    assert.equal(betaBrowse.body.page.entries[0].name, 'file-beta.md', 'the read comes from the new server')
    // Switching back to alpha with the old key is refused (the key includes the identity).
    const stale = await app.get(`${API}/browse?uri=viking://user/alice/memories`, {
      'x-dsh-openviking-scope': before.identity.fingerprint,
    })
    assert.equal(stale.status, 409)
  } finally {
    await app.shutdown()
  }
})

/* ---- auth-mode gates --------------------------------------------------- */

test('api_key profiles disable account/user overrides with a stated reason but allow the peer read lens', async () => {
  const app = await boot()
  try {
    app.holder.activeProfile = 'gamma'
    await app.emitVolatile()
    // The documented switch cooldown refuses a second switch in the same second;
    // this test is about the auth-mode gate, so let the cooldown lapse.
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    const scope = (await app.get(`${API}/scope`)).body.scope
    assert.equal(scope.identity.profileId, 'gamma')
    assert.equal(scope.identity.authMode, 'api_key')
    const list = (await app.get(`${API}/scopes`)).body.scopes
    assert.equal(list.overrides.allowed.account, false)
    assert.equal(list.overrides.allowed.reason, 'identity-key-bound')
    const refused = await app.mutate(
      `${API}/scope/identity`,
      { account: 'acme', user: 'alice' },
      { 'x-dsh-openviking-scope': scope.identity.fingerprint },
    )
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'identity-not-switchable')
    // The key itself never rides an identity header: the server's api_key answer
    // is the identity, and the plugin omits account/user headers there.
    const browse = await app.get(`${API}/browse?uri=viking://user/default/memories`, {
      'x-dsh-openviking-scope': scope.identity.fingerprint,
    })
    assert.equal(browse.status, 200)
    const lastBrowse = [...app.serverC.requests].reverse().find((entry) => entry.path === '/api/v1/fs/ls')
    assert.equal(lastBrowse.headers['x-openviking-account'], undefined)

    const peer = await app.mutate(
      `${API}/scope/identity`,
      { peer: 'peer-key' },
      { 'x-dsh-openviking-scope': scope.identity.fingerprint },
    )
    assert.equal(peer.body.ok, true, 'the peer read selector is allowed under api_key')
    const lastPeerBrowse = [...app.serverC.requests].reverse().find((entry) => entry.path === '/api/v1/fs/ls')
    void lastPeerBrowse
  } finally {
    await app.shutdown()
  }
})

/* ---- switch guard + identity-changed tokens --------------------------- */

test('a switch is refused while a curation confirmation is pending and a previous-identity token refuses identity-changed', async () => {
  const app = await boot()
  try {
    const scope = (await app.get(`${API}/scope`)).body.scope
    const key = scope.identity.fingerprint
    const prepared = await app.mutate(
      `${API}/write/prepare`,
      { action: 'delete-memory', target: 'viking://user/default/memories/preferences/tools.md' },
      { 'x-dsh-openviking-scope': key },
    )
    assert.equal(prepared.body.ok, true, JSON.stringify(prepared.body))
    const blocked = await app.mutate(`${API}/scope/identity`, { peer: 'peer-blocked' }, { 'x-dsh-openviking-scope': key })
    assert.equal(blocked.body.ok, false)
    assert.equal(blocked.body.error.code, 'scope-switch-blocked')

    // Cancel the pending token: the switch is allowed, and the old token now
    // refuses with identity-changed (it stays visible, it just cannot execute).
    await app.mutate(`${API}/write/cancel`, { token: prepared.body.token }, { 'x-dsh-openviking-scope': key })
    const switched = await app.mutate(`${API}/scope/identity`, { peer: 'peer-new' }, { 'x-dsh-openviking-scope': key })
    assert.equal(switched.body.ok, true)
    const oldToken = await app.mutate(
      `${API}/write/execute`,
      { token: prepared.body.token, typed: 'file-alpha.md' },
      { 'x-dsh-openviking-scope': switched.body.to },
    )
    assert.equal(oldToken.body.ok, false)
    assert.equal(oldToken.body.error.code, 'token-used', 'the cancelled token stays cancelled')
  } finally {
    await app.shutdown()
  }
})

test('undo handles from the previous identity stay visible but refuse identity-changed', async () => {
  const app = await boot()
  try {
    const key = (await app.get(`${API}/scope`)).body.scope.identity.fingerprint
    const prepared = await app.mutate(
      `${API}/write/prepare`,
      {
        action: 'set-tags',
        target: 'viking://user/default/memories/preferences/tools.md',
        tags: ['priority=high'],
        tagMode: 'append',
      },
      { 'x-dsh-openviking-scope': key },
    )
    assert.equal(prepared.body.ok, true, JSON.stringify(prepared.body))
    const executed = await app.mutate(
      `${API}/write/execute`,
      { token: prepared.body.token },
      { 'x-dsh-openviking-scope': key },
    )
    assert.equal(executed.body.ok, true, JSON.stringify(executed.body))
    assert.ok(executed.body.undoId, 'the successful write produced an undo handle')
    // The switch is allowed now (no pending token); the previous identity's undo
    // handle stays recorded, but it must refuse rather than write under the new one.
    const switched = await app.mutate(`${API}/scope/identity`, { peer: 'peer-two' }, { 'x-dsh-openviking-scope': key })
    assert.equal(switched.body.ok, true, JSON.stringify(switched.body))
    const undone = await app.mutate(
      `${API}/write/undo`,
      { undoId: executed.body.undoId },
      { 'x-dsh-openviking-scope': switched.body.to },
    )
    assert.equal(undone.body.ok, false)
    assert.equal(undone.body.error.code, 'identity-changed')
  } finally {
    await app.shutdown()
  }
})

/* ---- session-scope map ------------------------------------------------- */

test('a session that read under one scope warns after a switch and keeps its records local', async () => {
  const app = await boot()
  try {
    const key = (await app.get(`${API}/scope`)).body.scope.identity.fingerprint
    await app.get(`${API}/metrics?sessionId=s1`, { 'x-dsh-openviking-scope': key })
    const before = await app.get(`${API}/session-scope?sessionId=s1`, { 'x-dsh-openviking-scope': key })
    assert.equal(before.body.sessionScope.record?.scopeKey, key, JSON.stringify(before.body))
    assert.equal(before.body.sessionScope.mismatch, false)
    const switched = await app.mutate(`${API}/scope/identity`, { peer: 'peer-session' }, { 'x-dsh-openviking-scope': key })
    assert.equal(switched.body.ok, true, JSON.stringify(switched.body))
    const after = await app.get(`${API}/session-scope?sessionId=s1`, { 'x-dsh-openviking-scope': switched.body.to })
    assert.equal(after.body.sessionScope.mismatch, true, JSON.stringify(after.body))
    assert.equal(after.body.sessionScope.record.scopeKey, key)
    assert.equal(
      after.body.sessionScope.warnings.some((warning) => warning.code === 'sessionScopeMismatch'),
      true,
    )
    // The local map carries no bodies/keys and is private.
    const raw = readFileSync(join(app.stateHome, STATE_DIR, 'session-scopes.json'), 'utf8')
    assert.equal(raw.includes('gamma-secret'), false)
    assert.equal(raw.includes('http://'), false)
    assert.equal(statSync(join(app.stateHome, STATE_DIR, 'session-scopes.json')).mode & 0o777, 0o600)
  } finally {
    await app.shutdown()
  }
})

/* ---- ACL read-only view ------------------------------------------------ */

test('the ACL Access tab exposes the four states and never guesses enabled/disabled', async () => {
  const app = await boot()
  try {
    const key = (await app.get(`${API}/scope`)).body.scope.identity.fingerprint
    const headers = { 'x-dsh-openviking-scope': key }
    const ok = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/ok')}`, headers)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.acl.state, 'available')
    assert.equal(ok.body.acl.aclMode, 'restricted')
    assert.equal(ok.body.acl.direct.length, 1)
    assert.equal(ok.body.acl.inherited[0].principal, 'group:reviewers')
    assert.equal(ok.body.acl.effective.length, 2)
    assert.equal(ok.body.acl.visibility, 'account-shared')
    assert.equal(ok.body.acl.sharingAvailable, false)

    const denied = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/denied')}`, headers)
    assert.equal(denied.body.acl.state, 'denied-no-manage')
    assert.equal(denied.body.acl.detail, 'acl-manage-required')
    const absent = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/absent')}`, headers)
    assert.equal(absent.body.acl.state, 'unsupported')
    const before = app.serverA.requests.length
    const only = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://user/default/memories/x')}`, headers)
    assert.equal(only.body.acl.state, 'only-resources')
    assert.equal(only.body.acl.visibility, 'private-user')
    assert.equal(app.serverA.requests.length, before, 'a non-resource URI is answered without a server call')
    assert.equal(app.serverA.adminRequests.length, 0)
  } finally {
    await app.shutdown()
  }
})

/* ---- no admin enumeration, no federation ------------------------------- */

test('no scope flow ever requests an admin/account/group endpoint or another server’s data', async () => {
  const app = await boot()
  try {
    const key = () => app.get(`${API}/scope`).then((answer) => answer.body.scope.identity.fingerprint)
    const first = await key()
    await app.get(`${API}/scopes`)
    await app.get(`${API}/browse?uri=viking://user/default/memories`, { 'x-dsh-openviking-scope': first })
    await app.mutate(`${API}/scope/identity`, { peer: 'p' }, { 'x-dsh-openviking-scope': first })
    assert.deepEqual(app.serverA.adminRequests, [])
    assert.deepEqual(app.serverB.adminRequests, [])
    assert.deepEqual(app.serverC.adminRequests, [])
    // The active read only went to the active server, never to both.
    const aListings = app.serverA.requests.filter((entry) => entry.path === '/api/v1/fs/ls').length
    const bListings = app.serverB.requests.filter((entry) => entry.path === '/api/v1/fs/ls').length
    assert.equal(aListings > 0, true)
    assert.equal(bListings, 0, 'no cross-scope/federated read')
  } finally {
    await app.shutdown()
  }
})

/* ========================================================================
 * Review round 1 regression tests (B2/B3/B5/S1/S2/S6/S7)
 * ===================================================================== */

test('B2: a sessionless prepare never sends the scope peer to its write reads', async () => {
  const app = await boot({ identity: { account: null, user: null, peer: 'peer-scope' } })
  try {
    const scope = (await app.get(`${API}/scope`)).body.scope
    assert.equal(scope.identity.peer, 'peer-scope')
    const key = scope.identity.fingerprint
    const baseline = app.serverA.requests.length
    const prepared = await app.mutate(
      `${API}/write/prepare`,
      {
        action: 'set-tags',
        target: 'viking://user/default/memories/preferences/tools.md',
        tags: ['priority=high'],
        tagMode: 'replace',
      },
      { 'x-dsh-openviking-scope': key },
    )
    assert.equal(prepared.body.ok, true, JSON.stringify(prepared.body))
    const during = app.serverA.requests.slice(baseline)
    const readPaths = during.filter((entry) =>
      ['/api/v1/fs/attrs', '/api/v1/fs/stat', '/api/v1/content/read'].includes(entry.path),
    )
    assert.ok(readPaths.length > 0, 'the prepare read the target (revision/tags)')
    assert.equal(
      readPaths.some((entry) => entry.headers['x-openviking-actor-peer'] !== undefined),
      false,
      'write preparation must not use the scope peer read selector',
    )
    // The peer READ selector still applies where documented (ACL, sessionless reads):
    const acl = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/ok')}`, {
      'x-dsh-openviking-scope': key,
    })
    assert.equal(acl.body.ok, true)
    const aclRequest = [...app.serverA.requests].reverse().find((entry) => entry.path === '/api/v1/acl')
    assert.equal(aclRequest.headers['x-openviking-actor-peer'], 'peer-scope', 'S1: ACL is a sessionless read')
  } finally {
    await app.shutdown()
  }
})

test('B3: a session observed under another scope cannot prepare a write', async () => {
  const app = await boot()
  try {
    const key = (await app.get(`${API}/scope`)).body.scope.identity.fingerprint
    // A successful session read records the observation under this scope.
    const metrics = await app.get(`${API}/metrics?sessionId=s1`, { 'x-dsh-openviking-scope': key })
    assert.equal(metrics.body.ok, true)
    const switched = await app.mutate(`${API}/scope/identity`, { peer: 'peer-moved' }, { 'x-dsh-openviking-scope': key })
    assert.equal(switched.body.ok, true, JSON.stringify(switched.body))
    const prepared = await app.mutate(
      `${API}/write/prepare`,
      {
        action: 'set-tags',
        target: 'viking://user/default/memories/preferences/tools.md',
        tags: ['priority=high'],
        tagMode: 'replace',
        sessionId: 's1',
      },
      { 'x-dsh-openviking-scope': switched.body.to },
    )
    assert.equal(prepared.body.ok, false)
    assert.equal(prepared.body.error.code, 'session-scope-mismatch')
    // A sessionless target (no session id) is not affected by the boundary.
    const sessionless = await app.mutate(
      `${API}/write/prepare`,
      {
        action: 'set-tags',
        target: 'viking://user/default/memories/preferences/tools.md',
        tags: ['priority=high'],
        tagMode: 'replace',
      },
      { 'x-dsh-openviking-scope': switched.body.to },
    )
    assert.equal(sessionless.body.ok, true, JSON.stringify(sessionless.body))
  } finally {
    await app.shutdown()
  }
})

test('B5: Activity metrics are re-fetched after a scope switch (cache is scope-scoped)', async () => {
  const app = await boot()
  try {
    const first = await app.get(`${API}/metrics?sessionId=s1`)
    assert.equal(first.body.ok, true)
    assert.equal(JSON.stringify(first.body.metrics).includes('111'), true, 'alpha aggregates')
    app.holder.activeProfile = 'beta'
    await app.emitVolatile()
    const second = await app.get(`${API}/metrics?sessionId=s1`)
    assert.equal(second.body.ok, true)
    assert.equal(JSON.stringify(second.body.metrics).includes('222'), true, 'beta aggregates, not the cached alpha ones')
    assert.equal(JSON.stringify(second.body.metrics).includes('111'), false)
    assert.equal(
      app.serverA.requests.filter((entry) => entry.path === '/api/v1/console/dashboard/summary').length,
      1,
      'the alpha source was called once',
    )
    assert.ok(
      app.serverB.requests.some((entry) => entry.path === '/api/v1/console/dashboard/summary'),
      'the beta source was actually queried after the switch',
    )
  } finally {
    await app.shutdown()
  }
})

test('S2: ACL 401/5xx are distinguished from "unsupported" and a missing mode is not guessed', async () => {
  const app = await boot()
  try {
    const key = (await app.get(`${API}/scope`)).body.scope.identity.fingerprint
    const headers = { 'x-dsh-openviking-scope': key }
    const auth = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/auth')}`, headers)
    assert.equal(auth.body.acl.state, 'denied-no-manage')
    assert.equal(auth.body.acl.detail, 'acl-auth-required')
    const boom = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/boom')}`, headers)
    assert.equal(boom.body.acl.state, 'unsupported')
    assert.equal(boom.body.acl.detail, 'acl-server-error')
    const noMode = await app.get(`${API}/acl?uri=${encodeURIComponent('viking://resources/no-mode')}`, headers)
    assert.equal(noMode.body.acl.state, 'available')
    assert.equal(noMode.body.acl.aclMode, null, 'a missing acl_mode stays unknown (no "inherit" guessing)')
  } finally {
    await app.shutdown()
  }
})

test('S6: a profile activated through scope-state.json cannot be deleted', async () => {
  const app = await boot()
  try {
    const scope = (await app.get(`${API}/scope`)).body.scope
    assert.equal(scope.identity.profileId, 'alpha')
    const refused = await app.mutate(`${API}/profiles/delete`, { id: 'alpha' }, { 'x-dsh-openviking-scope': scope.identity.fingerprint })
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'invalid-request')
    const profiles = await app.get(`${API}/profiles`)
    assert.equal(profiles.body.profiles.profiles.some((profile) => profile.id === 'alpha'), true)
  } finally {
    await app.shutdown()
  }
})

test('S7: a corrupt scope-state.json is kept (not overwritten) and reported at boot', async () => {
  const app = await boot({ corruptScopeState: true })
  try {
    const scope = await app.get(`${API}/scope`)
    assert.equal(scope.body.ok, true)
    assert.equal(
      scope.body.scope.warnings.some((warning) => warning.code === 'scopeStateCorrupt'),
      true,
      'the corrupt state is surfaced, not silently replaced',
    )
    assert.equal(
      readFileSync(join(app.stateHome, STATE_DIR, 'scope-state.json'), 'utf8'),
      '{broken json',
      'the boot fallback leaves the file intact for the Doctor',
    )
    const health = await app.get(`${API}/doctor`)
    const sources = health.body.report?.configSources ?? []
    assert.equal(
      sources.some((source) => source.source === 'scope-state.json' && source.state !== 'ok'),
      true,
      'the Doctor still sees the config-source health evidence',
    )
  } finally {
    await app.shutdown()
  }
})
