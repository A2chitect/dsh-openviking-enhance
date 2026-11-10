// End-to-end tests for the v0.5 route layer.
//
// These boot the BUILT host bundle (`lib/index.js`) exactly as the loader does,
// give it a fake DSH context with a working `ctx.connection.fetch` transport, and
// point it at a **fake OpenViking HTTP server** on loopback. The browser's real
// call shapes are used:
//
//   webServer GET  → the read routes (scope, profiles, tasks, metrics, audit…)
//   connection.fetch POST → the authenticated mutation routes
//
// No test in this file talks to a live OpenViking: the write routes would be a
// defect in the suite if they could. Every write path is exercised end to end
// (prepare → execute → verify → post-commit → audit → undo) against the in-memory
// fake store, which is the evidence the PR needs for decision B (mutations ride
// the authenticated transport and nowhere else).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-routes-${label}-`))

/* ========================================================================
 * The fake OpenViking server
 * ===================================================================== */

function envelope(result) {
  return JSON.stringify({ status: 'ok', result })
}

function failure(code, message, details) {
  return JSON.stringify({ status: 'error', error: { code, message, details } })
}

class FakeServer {
  constructor() {
    this.files = new Map([
      ['viking://user/default/memories/preferences/tools.md', { content: 'Original body', modTime: '2026-11-09T00:00:00Z' }],
      ['viking://user/default/memories/entities/project/sidebar.md', { content: 'Rows sort by order.', modTime: '2026-11-09T00:00:00Z' }],
    ])
    this.tags = new Map([['viking://user/default/memories/preferences/tools.md', ['env=prod']]])
    this.commitCount = 0
    this.writes = []
    this.requests = []
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw.length === 0 ? null : JSON.parse(raw)
        this.requests.push({ method: request.method, path: url.pathname, query: url.searchParams })
        try {
          this.dispatch(request, response, url, body)
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

  dispatch(request, response, url, body) {
    const path = url.pathname
    const reply = (status, text) => {
      response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req-${this.requests.length}` })
      response.end(text)
    }
    const fileUri = url.searchParams.get('uri') ?? ''

    if (path === '/health') {
      reply(200, JSON.stringify({ status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' }))
      return
    }
    if (path === '/api/v1/snapshot/log') {
      reply(404, failure('NOT_FOUND', 'Git_ref not found: main', { type: 'git_ref' }))
      return
    }
    if (path === '/api/v1/tasks' && request.method === 'GET') {
      reply(
        200,
        envelope({
          items: [
            {
              task_id: 'task-1',
              task_type: 'session_commit',
              status: 'running',
              created_at: 1000,
              updated_at: 1001,
              resource_id: 'dsh-s1',
              stage: 'extract',
              result: { session_id: 'dsh-s1' },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      )
      return
    }
    if (path.startsWith('/api/v1/tasks/')) {
      const rest = path.slice('/api/v1/tasks/'.length)
      if (rest.endsWith('/cancel')) {
        const taskId = rest.slice(0, -'/cancel'.length)
        reply(200, envelope({ task_id: taskId, task_type: 'session_commit', status: 'cancelling' }))
        return
      }
      reply(
        200,
        envelope({
          task_id: rest,
          task_type: 'session_commit',
          status: 'completed',
          created_at: 1000,
          updated_at: 1042,
          processing_seconds: 42,
          resource_id: 'dsh-s1',
          result: {
            session_id: 'dsh-s1',
            archive_uri: 'viking://user/default/sessions/dsh-s1/history/archive_001',
            memories_extracted: { total: 2, memory_write: 1, memory_edit: 1 },
            execution_events: {
              items: [
                { seq: 1, recorded_at: 1001, kind: 'created', status: 'pending', stage: null, operation: 'session_commit', error: null },
                { seq: 2, recorded_at: 1030, kind: 'status_changed', status: 'completed', stage: null, operation: null, error: null },
              ],
              dropped_count: 0,
            },
          },
        }),
      )
      return
    }
    if (path === '/api/v1/fs/stat') {
      const file = this.files.get(fileUri)
      if (file === undefined) {
        reply(404, failure('NOT_FOUND', 'not found'))
        return
      }
      reply(200, envelope({ uri: fileUri, size: Buffer.byteLength(file.content, 'utf8'), modTime: file.modTime }))
      return
    }
    if (path === '/api/v1/fs/attrs') {
      reply(200, envelope({ uri: fileUri, attrs: { tags: [...(this.tags.get(fileUri) ?? [])] } }))
      return
    }
    if (path === '/api/v1/content/read') {
      const file = this.files.get(fileUri)
      if (file === undefined) {
        reply(404, failure('NOT_FOUND', 'not found'))
        return
      }
      reply(200, envelope(file.content))
      return
    }
    if (path === '/api/v1/content/write' && request.method === 'POST') {
      this.files.set(body.uri, { content: body.content, modTime: '2026-11-09T01:00:00Z' })
      this.writes.push({ op: 'write', uri: body.uri, content: body.content })
      reply(200, envelope({ uri: body.uri, written_bytes: Buffer.byteLength(body.content, 'utf8'), content_updated: true }))
      return
    }
    if (path === '/api/v1/content/set_tags' && request.method === 'POST') {
      const current = this.tags.get(body.uri) ?? []
      const tags = body.mode === 'clear' ? [] : body.mode === 'append' ? [...new Set([...current, ...(body.tags ?? [])])] : [...(body.tags ?? [])]
      this.tags.set(body.uri, tags)
      this.writes.push({ op: 'set-tags', uri: body.uri, tags, mode: body.mode })
      reply(200, envelope({ uri: body.uri, tags, mode: body.mode, tags_updated: true }))
      return
    }
    if (path === '/api/v1/fs' && request.method === 'DELETE') {
      this.files.delete(fileUri)
      this.writes.push({ op: 'delete', uri: fileUri })
      reply(200, envelope({ uri: fileUri }))
      return
    }
    if (path === '/api/v1/snapshot/commit' && request.method === 'POST') {
      this.commitCount += 1
      reply(200, envelope({ result: 'created', commit_oid: `commit-${this.commitCount}`, changed: 1 }))
      return
    }
    if (path === '/api/v1/snapshot/restore' && request.method === 'POST') {
      if (body.dry_run === true) {
        reply(200, envelope({ result: 'dry_run', diff: { to_write: [{ path: 'tools.md', oid: body.source_commit }], to_delete: [], unchanged: [] } }))
        return
      }
      reply(200, envelope({ result: 'applied', new_commit_oid: 'undo-commit-1', task_id: 'task-reindex' }))
      return
    }
    if (/^\/api\/v1\/sessions\/[^/]+\/commit$/.test(path) && request.method === 'POST') {
      this.writes.push({ op: 'commit', body })
      reply(
        200,
        envelope({
          session_id: 'dsh-s1',
          status: 'accepted',
          task_id: 'task-commit-1',
          archive_uri: 'viking://user/default/sessions/dsh-s1/history/archive_001',
          archived: true,
        }),
      )
      return
    }
    if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
      reply(
        200,
        envelope({
          session_id: 'dsh-s1',
          message_count: 7,
          commit_count: 1,
          pending_tokens: 42,
          last_commit_at: null,
          memories_extracted: { total: 1, memory_write: 1, memory_edit: 0 },
        }),
      )
      return
    }
    if (path === '/api/v1/console/dashboard/summary') {
      reply(200, envelope({ context_counts: { files: 3, skills: 1, memories: 5, total: 9 }, today_tokens: { total: 77 }, today_retrievals: { total: 2 } }))
      return
    }
    if (path === '/api/v1/observer/queue') {
      reply(200, envelope({ status: { queues: [{ queue: 'semantic', pending: 0, in_progress: 0, errors: 0, processed: 4 }] } }))
      return
    }
    if (path === '/api/v1/stats/memories') {
      reply(200, envelope({ total_memories: 5, by_category: { entities: 3, events: 2 }, hotness_distribution: {}, staleness: {} }))
      return
    }
    if (path.startsWith('/api/v1/stats/sessions/')) {
      reply(200, envelope({ session_id: 'dsh-s1', total_turns: 4, memories_extracted: 2 }))
      return
    }
    reply(404, failure('NOT_FOUND', `no fake route for ${request.method} ${path}`))
  }
}

/* ========================================================================
 * Boot the built host against the fake server and a fake DSH context
 * ===================================================================== */

async function boot() {
  const stateHome = tempDir('dsh')
  const ovHome = tempDir('ov')
  const previous = { DSH_HOME: process.env.DSH_HOME, OPENVIKING_HOME: process.env.OPENVIKING_HOME }
  process.env.DSH_HOME = stateHome
  process.env.OPENVIKING_HOME = ovHome

  const fake = new FakeServer()
  await fake.listen()

  // The bundle is imported AFTER the home overrides: the state modules resolve
  // their paths at construction time, and the audit/profile files must land in
  // the temp dir, never in the real `~/.dsh`.
  const module = await import('../lib/index.js')
  const webRoutes = []
  const fetchRoutes = []
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
    inject(deps, callback) {
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
      return {
        dispose() {
          if (typeof teardown === 'function') teardown()
        },
      }
    },
    logger: { info: () => {}, warn: () => {} },
  }
  module.apply(context, module.Config({ endpoint: fake.base, enableWrites: true }))

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

  const get = async (path) => {
    const response = await fetch(`${base}${path}`)
    return response.json()
  }
  const mutate = async (path, body, parse = true) => {
    const route = fetchRoutes.find((candidate) => candidate.path === `/api/openviking-enhance${path}`)
    assert.ok(route, `the ${path} mutation route is registered on ctx.connection.fetch`)
    const response = await route.fetch(
      new Request(`http://127.0.0.1/api/openviking-enhance${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return parse ? { status: response.status, body: await response.json() } : { status: response.status, response }
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve))
    await fake.close()
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.DSH_HOME
    if (previous.OPENVIKING_HOME === undefined) delete process.env.OPENVIKING_HOME
    else process.env.OPENVIKING_HOME = previous.OPENVIKING_HOME
  }

  return { fake, base, get, mutate, stateHome, webRoutes, fetchRoutes, shutdown }
}

const MEMORY = 'viking://user/default/memories/preferences/tools.md'

/* ========================================================================
 * The tests
 * ===================================================================== */

test('the mutation routes are registered only through ctx.connection.fetch', async () => {
  const app = await boot()
  try {
    const paths = app.fetchRoutes.map((route) => route.path).sort()
    assert.deepEqual(paths, [
      '/api/openviking-enhance/profiles/delete',
      '/api/openviking-enhance/profiles/save',
      '/api/openviking-enhance/profiles/test',
      '/api/openviking-enhance/task/cancel',
      '/api/openviking-enhance/write/cancel',
      '/api/openviking-enhance/write/execute',
      '/api/openviking-enhance/write/plan',
      '/api/openviking-enhance/write/prepare',
      '/api/openviking-enhance/write/undo',
    ])
    for (const route of app.fetchRoutes) {
      assert.deepEqual(route.methods, ['POST'], `${route.path} accepts POST only`)
      assert.equal(route.requestBody, 'buffered')
    }
    const scope = await app.get('/api/openviking-enhance/scope')
    assert.equal(scope.ok, true)
    assert.equal(scope.scope.writes.enabled, true)
    assert.equal(scope.scope.writes.transport, true, 'the fake connection service is detected')
    assert.equal(scope.scope.writes.reason, null)
  } finally {
    await app.shutdown()
  }
})

test('the read routes answer the documented envelopes against the fake server', async () => {
  const app = await boot()
  try {
    const profiles = await app.get('/api/openviking-enhance/profiles')
    assert.equal(profiles.ok, true)
    assert.deepEqual(profiles.profiles.profiles, [])
    assert.match(profiles.profiles.storePath, /dsh-openviking-enhance[\\/]profiles\.json$/)

    const tasks = await app.get('/api/openviking-enhance/tasks?limit=5')
    assert.equal(tasks.ok, true)
    assert.equal(tasks.available, true)
    assert.equal(tasks.tasks[0].taskId, 'task-1')

    const detail = await app.get('/api/openviking-enhance/task?taskId=task-1&events=1')
    assert.equal(detail.ok, true)
    assert.equal(detail.task.events.length, 2)

    const metrics = await app.get('/api/openviking-enhance/metrics?sessionId=s1')
    assert.equal(metrics.ok, true)
    assert.equal(metrics.metrics.dashboard.memories, 5)
    assert.equal(metrics.metrics.session.totalTurns, 4)
    assert.equal(metrics.metrics.prometheus, false)

    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.ok, true)
    assert.equal(Array.isArray(audit.entries), true)

    const control = await app.get('/api/openviking-enhance/session-control?sessionId=s1')
    assert.equal(control.ok, true)
    assert.equal(control.capture.canPause, false)
    assert.equal(control.session.pendingTokens, 42)

    const exported = await fetch(`${app.base}/api/openviking-enhance/task/export?taskId=task-1`)
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="openviking-task-task-1\.json"/)
    const exportedBody = await exported.json()
    assert.equal(exportedBody.task_id, 'task-1')
    assert.equal(exportedBody.result.session_id, 'dsh-s1')
  } finally {
    await app.shutdown()
  }
})

test('curation end to end: prepare, execute, verify, audit, undo — over the authenticated transport', async () => {
  const app = await boot()
  try {
    // --- edit ---------------------------------------------------------------
    const prepared = await app.mutate('/write/prepare', { action: 'edit-memory', target: MEMORY, sessionId: 's1' })
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.content, 'Original body')
    assert.match(prepared.body.revision.sha256, /^sha256:/)

    const executed = await app.mutate('/write/execute', { token: prepared.body.token, content: 'A curated body' })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.verified, true)
    assert.equal(app.fake.files.get(MEMORY).content, 'A curated body')
    assert.equal(app.fake.writes.some((write) => write.op === 'write' && write.content === 'A curated body'), true)
    assert.match(executed.body.auditId, /^aud-/)

    const plan = await app.mutate('/write/plan', { undoId: executed.body.undoId })
    assert.equal(plan.body.ok, true)
    assert.equal(plan.body.plan.extraChanges, false)

    const undone = await app.mutate('/write/undo', { undoId: executed.body.undoId })
    assert.equal(undone.body.ok, true)
    assert.equal(undone.body.outcome, 'restored')
    assert.equal(undone.body.newCommit, 'undo-commit-1')
    assert.equal(undone.body.taskId, 'task-reindex')

    // --- delete with the typed confirmation ---------------------------------
    const deletePrep = await app.mutate('/write/prepare', { action: 'delete-memory', target: MEMORY })
    assert.equal(deletePrep.body.ok, true)
    assert.equal(deletePrep.body.confirmWord, 'tools.md')
    const noTyped = await app.mutate('/write/execute', { token: deletePrep.body.token })
    assert.equal(noTyped.body.ok, false)
    assert.equal(noTyped.body.error.code, 'typed-confirmation-required')
    const deleted = await app.mutate('/write/execute', { token: deletePrep.body.token, typed: 'tools.md' })
    assert.equal(deleted.body.ok, true)
    assert.equal(app.fake.files.has(MEMORY), false)

    // --- tags ---------------------------------------------------------------
    app.fake.files.set(MEMORY, { content: 'Original body', modTime: null })
    const tagPrep = await app.mutate('/write/prepare', { action: 'set-tags', target: MEMORY, tags: ['env=staging'] })
    assert.equal(tagPrep.body.ok, true)
    assert.deepEqual(tagPrep.body.tagsBefore, ['env=prod'])
    const tagged = await app.mutate('/write/execute', { token: tagPrep.body.token })
    assert.equal(tagged.body.ok, true)
    assert.deepEqual(app.fake.tags.get(MEMORY), ['env=staging'])
    const tagUndo = await app.mutate('/write/undo', { undoId: tagged.body.undoId })
    assert.equal(tagUndo.body.ok, true)
    assert.equal(tagUndo.body.outcome, 'tags-restored')
    assert.deepEqual(app.fake.tags.get(MEMORY), ['env=prod'])

    // The audit trail is on disk, 0600, and carries no body.
    const auditDir = join(app.stateHome, 'state', 'dsh-openviking-enhance')
    const auditFile = join(auditDir, 'audit.jsonl')
    const rawAudit = readFileSync(auditFile, 'utf8')
    assert.equal(statSync(auditFile).mode & 0o777, 0o600)
    assert.equal(rawAudit.includes('A curated body'), false, 'the audit file never stores a body')
    assert.equal(rawAudit.includes('req-'), true, 'the server request id is correlated')
    const audit = await app.get('/api/openviking-enhance/audit?limit=20')
    assert.deepEqual(
      audit.entries.map((entry) => `${entry.kind}/${entry.action}`).slice(0, 3),
      ['undo/set-tags', 'write/set-tags', 'write/delete-memory'],
      'the newest audit entries are first',
    )
    assert.equal(readdirSync(auditDir).includes('audit.jsonl'), true)
  } finally {
    await app.shutdown()
  }
})

test('writes fail closed over the route layer: uncuratable, invalid body, identity/token rules', async () => {
  const app = await boot()
  try {
    const uncuratable = await app.mutate('/write/prepare', { action: 'delete-memory', target: 'viking://user/default/memories/rules/x.md' })
    assert.equal(uncuratable.body.ok, false)
    assert.equal(uncuratable.body.error.code, 'target-not-curatable')

    const notCuratable = await app.mutate('/write/prepare', { action: 'edit-memory', target: 'viking://resources/wiki/project.md' })
    assert.equal(notCuratable.body.error.code, 'target-not-curatable')

    const unknownAction = await app.mutate('/write/prepare', { action: 'drop-database', target: MEMORY })
    assert.equal(unknownAction.body.ok, false)
    assert.equal(unknownAction.body.error.code, 'invalid-request')

    // Unknown tokens are refused with a stable code, never a throw.
    const expired = await app.mutate('/write/execute', { token: 'f'.repeat(64) })
    assert.equal(expired.body.ok, false)
    assert.equal(expired.body.error.code, 'token-expired')

    // A non-JSON request body is a 400 envelope.
    const route = app.fetchRoutes.find((candidate) => candidate.path === '/api/openviking-enhance/write/prepare')
    const wrongType = await route.fetch(
      new Request('http://127.0.0.1/api/openviking-enhance/write/prepare', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      }),
    )
    assert.equal(wrongType.status, 400)
    assert.equal((await wrongType.json()).error.code, 'invalid-body')

    // A GET is refused before the handler.
    const getAttempt = await route.fetch(
      new Request('http://127.0.0.1/api/openviking-enhance/write/prepare', { method: 'GET' }),
    )
    assert.equal(getAttempt.status, 405)
    assert.equal((await getAttempt.json()).error.code, 'method-not-allowed')
  } finally {
    await app.shutdown()
  }
})

test('force commit, task cancel and the profile store work end to end', async () => {
  const app = await boot()
  try {
    // --- force commit -------------------------------------------------------
    const prepared = await app.mutate('/write/prepare', { action: 'force-commit', target: 's1', sessionId: 's1', origin: 'command' })
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.session.pendingTokens, 42)
    assert.equal(prepared.body.session.messageCount, 7)
    const committed = await app.mutate('/write/execute', { token: prepared.body.token })
    assert.equal(committed.body.ok, true)
    assert.equal(committed.body.taskId, 'task-commit-1')
    assert.equal(committed.body.undoId, null)
    assert.equal(app.fake.writes.some((write) => write.op === 'commit'), true)

    // --- cooperative task cancel -------------------------------------------
    const cancelled = await app.mutate('/task/cancel', { taskId: 'task-1' })
    assert.equal(cancelled.body.ok, true)
    assert.equal(cancelled.body.task.status, 'cancelling')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries.some((entry) => entry.action === 'cancel-task'), true)

    // --- the profile store --------------------------------------------------
    const saved = await app.mutate('/profiles/save', {
      id: 'local-default',
      label: 'Local dev',
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      apiKey: 'secret-value-that-must-not-leave',
      account: 'default',
      user: 'default',
      peerId: '',
    })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.profiles[0].hasApiKey, true)
    assert.equal(JSON.stringify(saved.body).includes('secret-value-that-must-not-leave'), false)
    const profilesFile = join(app.stateHome, 'state', 'dsh-openviking-enhance', 'profiles.json')
    assert.equal(statSync(profilesFile).mode & 0o777, 0o600)
    assert.equal(readFileSync(profilesFile, 'utf8').includes('secret-value-that-must-not-leave'), true, 'the key is stored only in the 0600 file')
    const readBack = await app.get('/api/openviking-enhance/profiles')
    assert.equal(readBack.profiles.profiles[0].id, 'local-default')
    assert.equal(JSON.stringify(readBack).includes('secret-value-that-must-not-leave'), false)

    const test = await app.mutate('/profiles/test', { endpoint: app.fake.base })
    assert.equal(test.body.ok, true)
    assert.equal(test.body.reachable, true)
    assert.equal(test.body.authMode, 'dev')

    // Review S9: the test button is not a general URL prober.
    const metadata = await app.mutate('/profiles/test', { endpoint: 'http://169.254.169.254/latest/meta-data' })
    assert.equal(metadata.body.ok, false)
    assert.equal(metadata.body.error.code, 'invalid-request')

    const removed = await app.mutate('/profiles/delete', { id: 'local-default' })
    assert.equal(removed.body.ok, true)
    assert.deepEqual(removed.body.profiles, [])
  } finally {
    await app.shutdown()
  }
})

test('write/cancel releases a pending token and a cancelled token cannot execute', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/write/prepare', { action: 'delete-memory', target: MEMORY })
    assert.equal(prepared.body.ok, true)
    const cancelled = await app.mutate('/write/cancel', { token: prepared.body.token })
    assert.equal(cancelled.body.ok, true)
    assert.equal(cancelled.body.status, 'cancelled')
    assert.equal(cancelled.body.action, 'delete-memory')

    const executed = await app.mutate('/write/execute', { token: prepared.body.token, typed: 'tools.md' })
    assert.equal(executed.body.ok, false)
    assert.equal(executed.body.error.code, 'token-used')
    assert.equal(app.fake.files.has(MEMORY), true, 'a cancelled token writes nothing')

    // Cancelling again (or after a settle) is an idempotent no-op.
    const again = await app.mutate('/write/cancel', { token: prepared.body.token })
    assert.equal(again.body.ok, true)
    assert.equal(again.body.status, 'settled')
    const unknown = await app.mutate('/write/cancel', { token: 'f'.repeat(64) })
    assert.equal(unknown.body.ok, true)
    assert.equal(unknown.body.status, 'expired')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries.some((entry) => entry.kind === 'cancel'), true, 'the cancellation is audited')
  } finally {
    await app.shutdown()
  }
})

test('the flow origin is decided host-side: a fetch-route delete still needs the typed name', async () => {
  const app = await boot()
  try {
    // A caller cannot opt out of the dialog's typed confirmation by claiming a
    // command origin in the body (review S3): the Fetch routes are overlay.
    const prepared = await app.mutate('/write/prepare', {
      action: 'delete-memory',
      target: MEMORY,
      origin: 'command',
    })
    assert.equal(prepared.body.ok, true)
    const noTyped = await app.mutate('/write/execute', { token: prepared.body.token })
    assert.equal(noTyped.body.ok, false)
    assert.equal(noTyped.body.error.code, 'typed-confirmation-required')
    assert.equal(app.fake.files.has(MEMORY), true)
  } finally {
    await app.shutdown()
  }
})
