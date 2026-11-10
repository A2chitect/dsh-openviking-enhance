// End-to-end tests for the v0.8 "Operate" layer.
//
// Same harness as `test/v05-routes.test.mjs`: boot the BUILT host bundle with a
// fake DSH context (a working `ctx.connection.fetch` transport) and a
// **fake OpenViking HTTP server** on loopback. The browser's real call shapes
// are used:
//
//   webServer GET          → the v0.8 read routes (snapshot/compile/observability…)
//   connection.fetch POST  → the authenticated `/ops/*` mutation family
//
// No test here talks to a live OpenViking: the mutation routes would be a defect
// in the suite if they could. Every controlled action is exercised end to end
// (prepare → confirm → execute → verify → audit → undo) against the in-memory
// fake store — the evidence the PR needs.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v08-${label}-`))
const ZIP = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.from('fake-ovpack-body', 'utf8')])

function envelope(result) {
  return JSON.stringify({ status: 'ok', result })
}
function failure(code, message, details) {
  return JSON.stringify({ status: 'error', error: { code, message, details } })
}

/* ========================================================================
 * The fake OpenViking server
 * ===================================================================== */

class FakeServer {
  constructor() {
    this.requests = []
    this.writes = []
    this.commitCount = 45
    this.restoreDryRunCount = 0
    this.restoreMode = 'applied'
    this.undoPlanExtra = false
    this.compileRuns = 0
    this.packCalls = 0
    this.fileVersionCurrent = 'ver-2'
    this.logLag = 0
    this.holdCommit = false
    this.heldCommit = null
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

  /** Release a commit held by `holdCommit` (gate-contention test). */
  releaseCommit() {
    const held = this.heldCommit
    if (held === null) return false
    this.heldCommit = null
    this.commitCount += 1
    held.response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-held' })
    held.response.end(envelope({ result: 'created', commit_oid: `commit-${this.commitCount}`, changed: 1 }))
    return true
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve))
  }

  get metricsCalls() {
    return this.requests.filter((entry) => entry.path === '/api/v1/metrics').length
  }

  dispatch(request, response, url, body) {
    const path = url.pathname
    const reply = (status, text, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': contentType, 'x-request-id': `req-${this.requests.length}` })
      response.end(text)
    }
    const envelopeReply = (result) => reply(200, envelope(result))
    const commit = (oid, message) => ({
      oid,
      tree: `tree-${oid}`,
      parents: oid === 'commit-45' ? ['commit-44'] : [],
      author: { name: 'tester', time_seconds: 1_760_000_000 },
      committer: { time_seconds: 1_760_000_100 },
      message,
    })

    if (path === '/health') {
      reply(200, JSON.stringify({ status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' }))
      return
    }
    /* ---- tasks / console / observer (shared with earlier versions) ------- */
    if (path === '/api/v1/tasks' && request.method === 'GET') {
      envelopeReply({
        items: [
          { task_id: 'task-compile-1', task_type: 'compile', status: 'completed', created_at: 1760000000, resource_id: 'viking://user/default/resources/out' },
          { task_id: 'task-reindex-1', task_type: 'snapshot_restore_reindex', status: 'running', created_at: 1760000010 },
        ],
        has_more: false,
        next_cursor: null,
      })
      return
    }
    if (path.startsWith('/api/v1/tasks/')) {
      const rest = path.slice('/api/v1/tasks/'.length)
      if (rest.endsWith('/cancel')) {
        envelopeReply({ task_id: rest.slice(0, -'/cancel'.length), task_type: 'compile', status: 'cancelling' })
        return
      }
      envelopeReply({
        task_id: rest,
        task_type: rest.includes('reindex') ? 'snapshot_restore_reindex' : 'compile',
        status: 'completed',
        created_at: 1760000000,
        updated_at: 1760000042,
        processing_seconds: 42,
        result: { output_uri: 'viking://user/default/resources/out/report.md' },
        meta: { task_id: rest },
        execution_events: {
          items: [
            { seq: 1, recorded_at: 1760000001, kind: 'created', status: 'pending', stage: null, operation: 'compile', error: null },
            { seq: 2, recorded_at: 1760000040, kind: 'status_changed', status: 'completed', stage: null, operation: null, error: null },
          ],
          dropped_count: 0,
        },
      })
      return
    }
    if (path === '/api/v1/console/dashboard/summary') {
      envelopeReply({ context_counts: { files: 3, skills: 1, memories: 5, total: 9 }, today_tokens: { total: 77 }, today_retrievals: { total: 2 } })
      return
    }
    if (path === '/api/v1/console/tokens') {
      envelopeReply({ buckets: [{ bucket: '2026-11-09', prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }] })
      return
    }
    if (path === '/api/v1/console/context-commits') {
      envelopeReply({ buckets: [{ bucket: '2026-11-09T00:00', count: 3 }] })
      return
    }
    if (path === '/api/v1/console/audit') {
      envelopeReply({
        items: [
          {
            request_id: 'req-1',
            method: 'POST',
            route: '/api/v1/compile',
            status_code: 202,
            duration_ms: 14,
            error_code: null,
          },
        ],
      })
      return
    }
    if (path.startsWith('/api/v1/observer/')) {
      const name = path.slice('/api/v1/observer/'.length)
      envelopeReply({
        name,
        is_healthy: name !== 'vikingdb',
        has_errors: name === 'queue',
        status:
          name === 'queue'
            ? { queues: [{ queue: 'semantic', pending: 1, in_progress: 0, processed: 4, errors: 0 }] }
            : { backend: 'local', count: 3 },
      })
      return
    }
    /* ---- snapshot reads -------------------------------------------------- */
    if (path === '/api/v1/snapshot/log') {
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const newest = `commit-${Math.max(1, this.commitCount - this.logLag)}`
      if (this.logLag > 0) this.logLag -= 1
      envelopeReply(
        [
          commit(newest, 'v0.8 operate snapshot'),
          commit(`commit-${Math.max(1, this.commitCount - 1)}`, 'previous'),
        ].slice(0, limit),
      )
      return
    }
    if (path === '/api/v1/snapshot/show') {
      const targetRef = url.searchParams.get('target_ref')
      if (typeof targetRef !== 'string' || !targetRef.startsWith('commit-')) {
        reply(404, failure('NOT_FOUND', 'no ref', { type: 'git_ref' }))
        return
      }
      if (url.searchParams.get('path') === null) {
        envelopeReply(commit(targetRef, 'v0.8 operate snapshot'))
        return
      }
      const text = 'file body at commit'
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-snapshot-oid': 'blob-1',
        'x-snapshot-size': String(Buffer.byteLength(text)),
        'x-request-id': 'req-show',
      })
      response.end(Buffer.from(text, 'utf8'))
      return
    }
    if (path === '/api/v1/snapshot/diff') {
      envelopeReply({ path: url.searchParams.get('path'), from_commit: 'commit-44', to_commit: 'commit-45', change_type: 'modified', diff_text: '@@ -1 +1 @@\n-old\n+new' })
      return
    }
    if (path === '/api/v1/snapshot/diff-paths') {
      envelopeReply({ changes: [{ uri: 'viking://user/default/resources/out/report.md', change_type: 'modified' }], total: 1, has_more: false, next_offset: null })
      return
    }
    if (path === '/api/v1/snapshot/versions') {
      const uri = url.searchParams.get('uri')
      if (uri === null) {
        reply(422, failure('INVALID_ARGUMENT', 'uri required'))
        return
      }
      if (uri.includes('/memories/')) {
        reply(412, failure('FAILED_PRECONDITION', 'not compile managed', { code: 'NOT_COMPILE_MANAGED' }))
        return
      }
      const number = Number(this.fileVersionCurrent.slice('ver-'.length))
      envelopeReply({
        uri,
        to: 'viking://user/default/resources/out',
        current_version: this.fileVersionCurrent,
        total: number,
        versions: Array.from({ length: number }, (_, index) => ({
          version_id: `ver-${number - index}`,
          version_number: number - index,
          snapshot_id: `snap-${number - index}`,
          created_at: 1760000010 + (number - index),
          source: 'compile',
          meta: index === 0 ? { operation_id: 'op-1' } : {},
        })),
        next_before_version: null,
      })
      return
    }
    if (path === '/api/v1/snapshot/ignore') {
      envelopeReply('*.tmp\n')
      return
    }
    /* ---- snapshot mutations --------------------------------------------- */
    if (path === '/api/v1/snapshot/commit' && request.method === 'POST') {
      this.writes.push({ op: 'snapshot-commit', message: body.message, paths: body.paths })
      if (this.holdCommit) {
        // Gate-contention test: hold the mutation open until the test releases it.
        this.heldCommit = { response, body }
        return
      }
      this.commitCount += 1
      envelopeReply({ result: 'created', commit_oid: `commit-${this.commitCount}`, changed: 1 })
      return
    }
    if (path === '/api/v1/snapshot/restore' && request.method === 'POST') {
      this.writes.push({ op: 'snapshot-restore', body })
      if (body.path !== undefined) {
        const nextNumber = Number(this.fileVersionCurrent.slice('ver-'.length)) + 1
        this.fileVersionCurrent = `ver-${nextNumber}`
        envelopeReply({ uri: body.path, version_id: this.fileVersionCurrent, version_number: nextNumber, meta: {}, result: undefined })
        return
      }
      if (body.dry_run === true) {
        this.restoreDryRunCount += 1
        if (this.restoreMode === 'conflict') {
          reply(409, failure('CONFLICT', 'history moved'))
          return
        }
        const extra = this.undoPlanExtra && this.restoreDryRunCount > 1
        envelopeReply({
          result: 'dry_run',
          head: 'head-1',
          diff: {
            to_write: [{ path: 'report.md', oid: 'blob-1' }, ...(extra ? [{ path: 'someone-else.md', oid: 'blob-9' }] : [])],
            to_delete: [{ path: 'stale.md', oid: 'blob-2' }],
            unchanged: [{ path: 'keep.md' }],
          },
        })
        return
      }
      if (this.restoreMode === 'partial') {
        reply(
          500,
          failure('RESTORE_WRITEBACK_PARTIAL', 'restore partial', {
            new_commit_oid: 'commit-partial',
            parent_commit: 'commit-45',
            written: 1,
            deleted: 0,
            unchanged: 0,
            written_paths: ['report.md'],
            deleted_paths: [],
            failed_writes: [['stale.md', 'EACCES']],
            failed_deletes: [],
            task_id: 'task-reindex-1',
          }),
        )
        return
      }
      envelopeReply({
        result: 'applied',
        new_commit_oid: 'commit-restored-1',
        parent_commit: 'commit-45',
        written: 2,
        deleted: 1,
        unchanged: 1,
        written_paths: ['report.md', 'notes.md'],
        deleted_paths: ['stale.md'],
        task_id: 'task-reindex-1',
      })
      return
    }
    /* ---- compile --------------------------------------------------------- */
    if (path === '/api/v1/compile/capabilities') {
      envelopeReply({ configured: true, can_create: true, reason_code: null })
      return
    }
    if (path === '/api/v1/compile/configs') {
      envelopeReply({
        targets: [
          {
            status: 'active',
            to: 'viking://user/default/resources/out',
            initialized: true,
            running: false,
            auto_update: true,
            update_schedule: { mode: 'incremental', cron: '0 * * * *' },
            next_run_at: '2026-11-11T00:00:00Z',
            content_updated_at: 1760000000,
            compile_type: 'compile',
            conflicts_num: 0,
          },
        ],
        next_cursor: null,
      })
      return
    }
    if (path === '/api/v1/compile/config') {
      envelopeReply({
        to: url.searchParams.get('to'),
        from: ['viking://user/default/memories'],
        skill: 'skill-builder',
        instruction: 'Summarize the sources',
        auto_update: true,
        update_schedule: { mode: 'incremental' },
        status: 'active',
        compile_type: 'compile',
        conflicts_num: 0,
      })
      return
    }
    if (path === '/api/v1/compile/operations') {
      envelopeReply({
        operations: [
          {
            operation_id: 'op-1',
            operation_type: 'compile',
            actor: 'default',
            status: 'completed',
            created_at: 1760000000,
            started_at: 1760000001,
            finished_at: 1760000030,
            params: { to: 'viking://user/default/resources/out', from: ['viking://user/default/memories'], skill: 'skill-builder' },
            result: { outputs: 1 },
            error: null,
            meta: { task_id: 'task-compile-1' },
          },
        ],
        next_cursor: null,
      })
      return
    }
    if (/^\/api\/v1\/compile\/operations\/[^/]+\/outputs$/.test(path)) {
      envelopeReply({ outputs: [{ uri: 'viking://user/default/resources/out/report.md', version_id: 'ver-2', snapshot_id: 'snap-2' }], next_cursor: null })
      return
    }
    if (/^\/api\/v1\/compile\/operations\/[^/]+$/.test(path)) {
      envelopeReply({ operation_id: 'op-1', operation_type: 'compile', status: 'completed', meta: { task_id: 'task-compile-1' }, params: {}, result: {} })
      return
    }
    if (path.startsWith('/api/v1/compile/submissions/')) {
      const key = path.slice('/api/v1/compile/submissions/'.length)
      if (key === 'dsh-missing') {
        reply(404, failure('NOT_FOUND', 'no submission', { type: 'submission' }))
        return
      }
      envelopeReply({ task_id: 'task-compile-1', task_type: 'compile', status: 'pending' })
      return
    }
    if (path === '/api/v1/compile' && request.method === 'POST') {
      this.compileRuns += 1
      this.writes.push({ op: 'compile', body, idempotencyKey: request.headers['idempotency-key'] })
      reply(202, envelope({ task_id: `task-compile-${this.compileRuns + 1}`, task_type: 'compile', status: 'pending', created_at: 1760000100 }))
      return
    }
    /* ---- pack export ----------------------------------------------------- */
    if (path === '/api/v1/pack/export' && request.method === 'POST') {
      if (body === null || typeof body.uri !== 'string' || body.uri === '') {
        reply(422, failure('INVALID_ARGUMENT', 'uri required'))
        return
      }
      this.packCalls += 1
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="out.ovpack"',
        'x-request-id': 'req-pack',
      })
      response.end(ZIP)
      return
    }
    if (path === '/api/v1/snapshot/versions' && request.method === 'GET') {
      reply(422, failure('INVALID_ARGUMENT', 'uri required'))
      return
    }
    reply(404, failure('NOT_FOUND', `no fake route for ${request.method} ${path}`))
  }
}

/* ========================================================================
 * Boot the built host against the fake server + a fake DSH context
 * ===================================================================== */

async function boot(configOverrides = {}) {
  const stateHome = tempDir('dsh')
  const ovHome = tempDir('ov')
  const previous = { DSH_HOME: process.env.DSH_HOME, OPENVIKING_HOME: process.env.OPENVIKING_HOME }
  process.env.DSH_HOME = stateHome
  process.env.OPENVIKING_HOME = ovHome
  const fake = new FakeServer()
  await fake.listen()
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
      return { dispose() { if (typeof teardown === 'function') teardown() } }
    },
    logger: { info: () => {}, warn: () => {} },
  }
  module.apply(context, module.Config({ endpoint: fake.base, enableWrites: true, enableOps: true, ...configOverrides }))
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
  const get = async (path) => (await fetch(`${base}${path}`)).json()
  const mutate = async (path, body) => {
    const route = fetchRoutes.find((candidate) => candidate.path === `/api/openviking-enhance${path}`)
    assert.ok(route, `the ${path} mutation route is registered on ctx.connection.fetch`)
    const response = await route.fetch(
      new Request(`http://127.0.0.1/api/openviking-enhance${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
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
  return { fake, base, get, mutate, stateHome, webRoutes, fetchRoutes, shutdown, module }
}

const MEMORY = 'viking://user/default/memories'
const OUT = 'viking://user/default/resources/out'

/**
 * Poll `predicate` until true, bounded by `timeoutMs` (CI-safe).
 *
 * Filesystem side-effects of a completed HTTP response (the one-time download's
 * unlink) are event-driven and can land after the client has the last byte, so
 * tests assert the settled state with a bounded wait rather than assuming the
 * same tick.
 */
async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/* ========================================================================
 * The tests
 * ===================================================================== */

test('the ops mutation routes are registered only through ctx.connection.fetch', async () => {
  const app = await boot()
  try {
    const paths = app.fetchRoutes.map((route) => route.path).sort()
    for (const opsPath of ['/ops/prepare', '/ops/execute', '/ops/plan', '/ops/undo', '/ops/cancel']) {
      assert.ok(
        paths.includes(`/api/openviking-enhance${opsPath}`),
        `${opsPath} is registered on the authenticated transport`,
      )
    }
    for (const route of app.fetchRoutes) {
      assert.deepEqual(route.methods, ['POST'], `${route.path} accepts POST only`)
      assert.equal(route.requestBody, 'buffered')
    }
    // No ops route exists on the unauthenticated loopback read fence.
    const loopback = app.webRoutes.map((route) => route.path)
    assert.equal(loopback.some((path) => path.endsWith('/ops/prepare')), false)
    assert.equal(
      (await fetch(`${app.base}/api/openviking-enhance/ops/prepare`, { method: 'POST', body: '{}' })).status,
      404,
      'the loopback fence answers 404 for an ops mutation',
    )
    const scope = await app.get('/api/openviking-enhance/scope')
    assert.equal(scope.scope.ops.enabled, true)
    assert.equal(scope.scope.ops.transport, true)
    assert.equal(scope.scope.ops.reason, null)
    assert.equal(scope.scope.capabilities.compile.available, true)
  } finally {
    await app.shutdown()
  }
})

test('snapshot read routes answer bounded envelopes against the fake server', async () => {
  const app = await boot()
  try {
    const log = await app.get('/api/openviking-enhance/snapshot-log?limit=5')
    assert.equal(log.ok, true)
    assert.equal(log.commits.length, 2)
    assert.equal(log.commits[0].oid, 'commit-45')

    const meta = await app.get('/api/openviking-enhance/snapshot-show?ref=commit-45')
    assert.equal(meta.ok, true)
    assert.equal(meta.commit.oid, 'commit-45')

    const blob = await app.get(`/api/openviking-enhance/snapshot-show?ref=commit-45&path=${encodeURIComponent(`${OUT}/report.md`)}`)
    assert.equal(blob.ok, true)
    assert.equal(blob.text, 'file body at commit')
    assert.equal(blob.contentType, 'text')

    const diff = await app.get(`/api/openviking-enhance/snapshot-diff?path=${encodeURIComponent(OUT)}&from=commit-44&to=commit-45`)
    assert.equal(diff.ok, true)
    assert.match(diff.diffText, /\+new/)

    const diffPaths = await app.get(`/api/openviking-enhance/snapshot-diff-paths?paths=${encodeURIComponent(OUT)}&to=commit-45`)
    assert.equal(diffPaths.ok, true)
    assert.equal(diffPaths.total, 1)

    const versions = await app.get(`/api/openviking-enhance/snapshot-versions?uri=${encodeURIComponent(`${OUT}/report.md`)}`)
    assert.equal(versions.ok, true)
    assert.equal(versions.currentVersion, 'ver-2')
    assert.equal(versions.versions.length, 2)

    const memoryVersions = await app.get(`/api/openviking-enhance/snapshot-versions?uri=${encodeURIComponent(`${MEMORY}/x.md`)}`)
    assert.equal(memoryVersions.ok, true)
    assert.equal(memoryVersions.available, false)
    assert.equal(memoryVersions.note, 'not-compile-managed')

    const ignore = await app.get('/api/openviking-enhance/snapshot-ignore')
    assert.equal(ignore.ok, true)
    assert.equal(ignore.content, '*.tmp\n')

    const compile = await app.get('/api/openviking-enhance/compile')
    assert.equal(compile.ok, true)
    assert.equal(compile.capabilities.available, true)
    assert.equal(compile.targets.targets[0].to, OUT)

    const target = await app.get(`/api/openviking-enhance/compile-target?to=${encodeURIComponent(OUT)}`)
    assert.equal(target.ok, true)
    assert.equal(target.target.skill, 'skill-builder')

    const operations = await app.get(`/api/openviking-enhance/compile-operations?to=${encodeURIComponent(OUT)}`)
    assert.equal(operations.ok, true)
    assert.equal(operations.operations[0].operationId, 'op-1')

    const outputs = await app.get(`/api/openviking-enhance/compile-outputs?to=${encodeURIComponent(OUT)}&operationId=op-1`)
    assert.equal(outputs.ok, true)
    assert.equal(outputs.outputs[0].uri, `${OUT}/report.md`)

    const submission = await app.get('/api/openviking-enhance/compile-submission?key=dsh-abcdefabcdefabcdefabcdef')
    assert.equal(submission.ok, true)
    assert.equal(submission.found, true)
    assert.equal(submission.taskId, 'task-compile-1')

    const observability = await app.get('/api/openviking-enhance/observability?days=7')
    assert.equal(observability.ok, true)
    assert.equal(observability.cards.length, 7)
    assert.equal(observability.cards.some((card) => card.id === 'queue' && card.rows.length > 1), true)
    assert.equal(observability.tokens.available, true)
    assert.equal(observability.contextCommits.available, true)
    assert.equal(observability.neverMetrics, undefined)
    assert.equal(app.fake.metricsCalls, 0, 'Prometheus /metrics is never requested')
  } finally {
    await app.shutdown()
  }
})

test('snapshot create: prepare, explicit confirmation, execute, verify and audit (not undoable)', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', {
      action: 'snapshot-create',
      message: 'vi-snapshot operate test',
      paths: [MEMORY, OUT],
    })
    assert.equal(prepared.body.ok, true)
    assert.match(prepared.body.token, /^[0-9a-f]{64}$/)
    assert.equal(prepared.body.plan.kind, 'snapshot-create')
    assert.equal(prepared.body.plan.notUndoable, true)
    assert.equal(prepared.body.expiresAt > Date.now(), true)

    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.undoId, null, 'a commit is not undoable')
    assert.match(executed.body.postCommit, /^commit-/)
    assert.equal(executed.body.verified, true)
    assert.match(executed.body.auditId, /^aud-/)

    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries[0].kind, 'snapshot')
    assert.equal(audit.entries[0].action, 'snapshot-create')
    assert.equal(audit.entries[0].snapshot.newCommit, executed.body.postCommit)
    const raw = readFileSync(join(app.stateHome, 'state', 'dsh-openviking-enhance', 'audit.jsonl'), 'utf8')
    assert.equal(raw.includes('vi-snapshot operate test'), false, 'the commit message body is not in the audit')

    // Tokens are single-use.
    const again = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(again.body.ok, false)
    assert.equal(again.body.error.code, 'token-used')
  } finally {
    await app.shutdown()
  }
})

test('snapshot restore: dry-run plan, typed confirmation, reindex task, forward-restore undo', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', {
      action: 'snapshot-restore',
      projectDir: OUT,
      sourceCommit: 'commit-44',
    })
    assert.equal(prepared.body.ok, true)
    const plan = prepared.body.plan
    assert.equal(plan.kind, 'snapshot-restore')
    assert.equal(plan.typedWord, 'out')
    assert.equal(plan.toWrite.length, 1)
    assert.equal(plan.toDelete.length, 1)
    assert.equal(plan.unchanged, 1)
    assert.equal(plan.head, 'head-1')

    const noTyped = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(noTyped.body.ok, false)
    assert.equal(noTyped.body.error.code, 'typed-confirmation-required')
    assert.equal(app.fake.writes.filter((write) => write.op === 'snapshot-restore').length, 1, 'only the dry run happened')

    const wrong = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'nope' })
    assert.equal(wrong.body.ok, false)
    assert.equal(wrong.body.error.code, 'typed-confirmation-mismatch')

    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'out' })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.newCommit, 'commit-restored-1')
    assert.equal(executed.body.parentCommit, 'commit-45')
    assert.equal(executed.body.taskId, 'task-reindex-1')
    assert.equal(executed.body.written, 2)
    assert.equal(executed.body.deleted, 1)
    assert.equal(typeof executed.body.undoId, 'string')

    // Undo is another forward restore to the parent commit.
    const undoPlan = await app.mutate('/ops/plan', { undoId: executed.body.undoId })
    assert.equal(undoPlan.body.ok, true)
    assert.equal(undoPlan.body.plan.kind, 'snapshot-restore')
    assert.equal(undoPlan.body.plan.sourceCommit, 'commit-45')
    assert.equal(undoPlan.body.plan.extraChanges, false)
    const undone = await app.mutate('/ops/undo', { undoId: executed.body.undoId })
    assert.equal(undone.body.ok, true)
    assert.equal(undone.body.outcome, 'restored')
    const undoAudit = await app.get('/api/openviking-enhance/audit?limit=10&kind=undo')
    assert.equal(undoAudit.entries.length, 1)
    assert.equal(undoAudit.entries[0].result, 'undone')

    // A restore cannot be executed twice; a used undo is refused.
    const replay = await app.mutate('/ops/undo', { undoId: executed.body.undoId })
    assert.equal(replay.body.ok, false)
    assert.equal(replay.body.error.code, 'token-used')
  } finally {
    await app.shutdown()
  }
})

test('an undo plan touching an unexpected path requires the second confirmation', async () => {
  const app = await boot()
  try {
    app.fake.undoPlanExtra = true
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-restore', projectDir: OUT, sourceCommit: 'commit-44' })
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'out' })
    assert.equal(executed.body.ok, true)
    // The undo dry-run is the second dry run; it reports someone-else.md.
    const plan = await app.mutate('/ops/plan', { undoId: executed.body.undoId })
    assert.equal(plan.body.ok, true)
    assert.equal(plan.body.plan.extraChanges, true)
    const refused = await app.mutate('/ops/undo', { undoId: executed.body.undoId })
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'extra-changes')
    const applied = await app.mutate('/ops/undo', { undoId: executed.body.undoId, confirmExtra: true })
    assert.equal(applied.body.ok, true)
  } finally {
    await app.shutdown()
  }
})

test('partial writeback is reported honestly and can be undone to the parent', async () => {
  const app = await boot()
  try {
    app.fake.restoreMode = 'partial'
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-restore', projectDir: OUT, sourceCommit: 'commit-44' })
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'out' })
    assert.equal(executed.body.ok, true, 'the envelope still answers so the UI can render the partial state')
    assert.equal(executed.body.verified, false)
    assert.equal(executed.body.partial.taskId, 'task-reindex-1')
    assert.deepEqual(executed.body.partial.failedWrites, ['stale.md: EACCES'])
    assert.equal(typeof executed.body.undoId, 'string')
    assert.match(executed.body.auditId, /^aud-/, 'the partial writeback has a real audit row')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries[0].result, 'failed')
    assert.match(audit.entries[0].error, /failed-partial/)
    assert.equal(audit.entries[0].taskId, 'task-reindex-1')
  } finally {
    await app.shutdown()
  }
})

test('compile: confirmed trigger with host Idempotency-Key, 202 task, submission recovery and no retry', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', {
      action: 'compile-run',
      to: OUT,
      from: [MEMORY],
      skill: 'skill-builder',
      instruction: 'Summarize',
    })
    assert.equal(prepared.body.ok, true)
    const plan = prepared.body.plan
    assert.equal(plan.kind, 'compile-run')
    assert.match(plan.idempotencyKey, /^dsh-[0-9a-f]{24}$/)

    const memorySkill = await app.mutate('/ops/prepare', {
      action: 'compile-run',
      to: OUT,
      from: [MEMORY],
      skill: 'memory',
    })
    assert.equal(memorySkill.body.ok, false)
    assert.equal(memorySkill.body.error.code, 'invalid-request')

    const badScope = await app.mutate('/ops/prepare', {
      action: 'compile-run',
      to: 'viking://agent/rules',
      from: [MEMORY],
      skill: 'skill-builder',
    })
    assert.equal(badScope.body.ok, false)

    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, true)
    assert.match(executed.body.taskId, /^task-compile-/)
    assert.equal(executed.body.idempotencyKey, plan.idempotencyKey)
    assert.equal(executed.body.verificationPending, false)
    const compileWrite = app.fake.writes.find((write) => write.op === 'compile')
    assert.equal(compileWrite.idempotencyKey, plan.idempotencyKey, 'the plan key is the actual header')

    const audit = await app.get(`/api/openviking-enhance/audit?limit=5&kind=compile`)
    assert.equal(audit.entries[0].idempotencyKey, plan.idempotencyKey)
    assert.equal(audit.entries[0].taskId, executed.body.taskId)

    const found = await app.get(`/api/openviking-enhance/compile-submission?key=${plan.idempotencyKey}`)
    assert.equal(found.ok, true)
    assert.equal(found.found, true)
    const missing = await app.get('/api/openviking-enhance/compile-submission?key=dsh-missing')
    assert.equal(missing.found, false)
  } finally {
    await app.shutdown()
  }
})

test('configured-target compile uses the saved config (read-only use) and validates its scope', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', {
      action: 'compile-run',
      configuredTarget: OUT,
      to: '',
      from: [],
      skill: '',
    })
    assert.equal(prepared.body.ok, true)
    const plan = prepared.body.plan
    assert.equal(plan.to, OUT)
    assert.deepEqual(plan.from, [MEMORY])
    assert.equal(plan.skill, 'skill-builder')
    assert.equal(plan.configuredTarget, OUT)
  } finally {
    await app.shutdown()
  }
})

test('pack export: bounded host temp file, one-time download token, metadata-only audit', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', { action: 'pack-export', uri: OUT })
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.plan.kind, 'pack-export')
    assert.equal(prepared.body.plan.includeVectors, false)
    assert.equal(prepared.body.plan.maxBytes, 64 * 1024 * 1024)

    const badScope = await app.mutate('/ops/prepare', { action: 'pack-export', uri: 'viking://agent/skills' })
    assert.equal(badScope.body.ok, false)

    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.fileName, 'out.ovpack')
    assert.equal(executed.body.bytes, ZIP.byteLength)
    assert.match(executed.body.downloadId, /^[0-9a-f]{64}$/)

    const downloadsDir = join(app.stateHome, 'state', 'dsh-openviking-enhance', 'downloads')
    const files = readdirSync(downloadsDir)
    assert.equal(files.length, 1)
    const filePath = join(downloadsDir, files[0])
    assert.equal(statSync(downloadsDir).mode & 0o777, 0o700)
    assert.equal(statSync(filePath).mode & 0o777, 0o600)

    const download = await fetch(`${app.base}/api/openviking-enhance/ops/download?token=${executed.body.downloadId}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/zip')
    assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="out.ovpack"/)
    assert.equal(Buffer.from(await download.arrayBuffer()).equals(ZIP), true)
    // Single use: the token is refused on replay (synchronous capability state).
    const replayed = await fetch(`${app.base}/api/openviking-enhance/ops/download?token=${executed.body.downloadId}`)
    assert.equal(replayed.status, 404)
    // The unlink happens on the response's `finish` event, i.e. a tick after the
    // client consumed the last byte: wait for the filesystem to settle instead of
    // racing the event loop (this assertion was the CI flake).
    assert.equal(
      await waitFor(() => readdirSync(downloadsDir).length === 0, 3_000),
      true,
      'the temp file is deleted after the one download',
    )

    const auditRaw = readFileSync(join(app.stateHome, 'state', 'dsh-openviking-enhance', 'audit.jsonl'), 'utf8')
    assert.equal(auditRaw.includes(executed.body.downloadId), false, 'the one-time token is never audited')
    const history = await app.get('/api/openviking-enhance/pack/history')
    assert.equal(history.ok, true)
    assert.equal(history.history.exports.length >= 1, true)
    assert.equal(history.history.exports[0].bytes, ZIP.byteLength)
  } finally {
    await app.shutdown()
  }
})

test('file-version restore: CAS restore with typed confirmation and version undo (0.5.3)', async () => {
  const app = await boot()
  try {
    const uri = `${OUT}/report.md`
    const prepared = await app.mutate('/ops/prepare', {
      action: 'file-version-restore',
      uri,
      restoreVersion: 'ver-1',
      currentVersion: 'ver-2',
    })
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.plan.kind, 'file-version-restore')
    assert.equal(prepared.body.plan.typedWord, 'report.md')
    assert.equal(prepared.body.plan.restoreVersionNumber, 1)
    assert.equal(prepared.body.plan.currentVersionNumber, 2)

    const noTyped = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(noTyped.body.error.code, 'typed-confirmation-required')
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'report.md' })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.versionNumber, 3)
    assert.equal(typeof executed.body.undoId, 'string')

    const plan = await app.mutate('/ops/plan', { undoId: executed.body.undoId })
    assert.equal(plan.body.ok, true)
    assert.equal(plan.body.plan.kind, 'file-version-restore')
    assert.equal(plan.body.plan.restoreVersion, 'ver-2')
    const undone = await app.mutate('/ops/undo', { undoId: executed.body.undoId })
    assert.equal(undone.body.ok, true)
    assert.equal(undone.body.outcome, 'version-restored')
  } finally {
    await app.shutdown()
  }
})

test('task evidence: bounded JSON attachment with build, identity and audit correlation', async () => {
  const app = await boot()
  try {
    // Produce a compile action so the task has a local-audit correlation.
    const prepared = await app.mutate('/ops/prepare', {
      action: 'compile-run',
      to: OUT,
      from: [MEMORY],
      skill: 'skill-builder',
    })
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, true)

    const response = await fetch(`${app.base}/api/openviking-enhance/task/evidence?taskId=${executed.body.taskId}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="openviking-task-evidence-/)
    const body = await response.json()
    assert.equal(body.schema, 'dsh-openviking-enhance/task-evidence/v1')
    assert.equal(body.task.task_id, executed.body.taskId)
    assert.equal(body.correlation.auditEntries.length >= 1, true)
    assert.equal(body.correlation.auditEntries[0].kind, 'compile')
    assert.equal(body.correlation.idempotencyKey, executed.body.idempotencyKey)
    assert.equal(body.build.pluginVersion.length > 0, true)
    assert.equal(body.identity.account, 'default')
    assert.equal(JSON.stringify(body).includes('memory body'), false)
    assert.equal(response.headers.get('content-length') !== null, true)
  } finally {
    await app.shutdown()
  }
})

test('ops fail closed: switch off, bad token, unknown action, bad body and no loopback write path', async () => {
  const app = await boot({ enableOps: false })
  try {
    const disabled = await app.mutate('/ops/prepare', { action: 'snapshot-create', message: 'x', paths: [MEMORY] })
    assert.equal(disabled.body.ok, false)
    assert.equal(disabled.body.error.code, 'ops-disabled')
    // Curation writes stay gated separately (enableWrites is still true here).
    const scope = await app.get('/api/openviking-enhance/scope')
    assert.equal(scope.scope.writes.enabled, true)
    assert.equal(scope.scope.ops.enabled, false)
    assert.equal(scope.scope.ops.reason, 'ops-disabled')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries.some((entry) => entry.kind === 'denied' && entry.error.startsWith('ops-disabled')), true)
  } finally {
    await app.shutdown()
  }

  const app2 = await boot()
  try {
    const unknown = await app2.mutate('/ops/prepare', { action: 'drop-database' })
    assert.equal(unknown.body.ok, false)
    assert.equal(unknown.body.error.code, 'invalid-request')

    const expired = await app2.mutate('/ops/execute', { token: 'f'.repeat(64) })
    assert.equal(expired.body.ok, false)
    assert.equal(expired.body.error.code, 'token-expired')

    const scopeViolation = await app2.mutate('/ops/prepare', { action: 'snapshot-create', message: 'x', paths: ['viking://'] })
    assert.equal(scopeViolation.body.ok, false)
    assert.equal(scopeViolation.body.error.code, 'invalid-scope')

    const sessionRestore = await app2.mutate('/ops/prepare', {
      action: 'snapshot-restore',
      projectDir: 'viking://user/default/sessions/dsh-1',
      sourceCommit: 'commit-44',
    })
    assert.equal(sessionRestore.body.ok, false)
    assert.equal(sessionRestore.body.error.code, 'restore-scope-refused')

    const route = app2.fetchRoutes.find((candidate) => candidate.path === '/api/openviking-enhance/ops/prepare')
    const wrongType = await route.fetch(
      new Request('http://127.0.0.1/api/openviking-enhance/ops/prepare', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      }),
    )
    assert.equal(wrongType.status, 400)
    assert.equal((await wrongType.json()).error.code, 'invalid-body')
    const getAttempt = await route.fetch(new Request('http://127.0.0.1/api/openviking-enhance/ops/prepare', { method: 'GET' }))
    assert.equal(getAttempt.status, 405)
  } finally {
    await app2.shutdown()
  }
})

test('ops cancel releases a pending token; a cancelled token cannot execute', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-create', message: 'cancel me', paths: [MEMORY] })
    assert.equal(prepared.body.ok, true)
    const cancelled = await app.mutate('/ops/cancel', { token: prepared.body.token })
    assert.equal(cancelled.body.ok, true)
    assert.equal(cancelled.body.status, 'cancelled')
    assert.equal(cancelled.body.action, 'snapshot-create')
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, false)
    assert.equal(executed.body.error.code, 'token-used')
    const again = await app.mutate('/ops/cancel', { token: prepared.body.token })
    assert.equal(again.body.ok, true)
    assert.equal(again.body.status, 'settled')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries.some((entry) => entry.kind === 'cancel'), true)

    // Both the write and the ops services exist in one composition (one shared
    // gate instance); curation writes stay gated by their own switch.
    const scope = await app.get('/api/openviking-enhance/scope')
    assert.equal(scope.scope.writes.enabled, true)
    assert.equal(scope.scope.ops.enabled, true)
  } finally {
    await app.shutdown()
  }
})

/* ========================================================================
 * PR #6 review round 1 — destructive paths, gate contention and caps
 * ===================================================================== */

test('S7: history moving between prepare and execute refuses with revision-mismatch (no retry)', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-restore', projectDir: OUT, sourceCommit: 'commit-44' })
    assert.equal(prepared.body.ok, true)
    // The server's next dry run answers 409 CONFLICT (branch advanced).
    app.fake.restoreMode = 'conflict'
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'out' })
    assert.equal(executed.body.ok, false)
    assert.equal(executed.body.error.code, 'revision-mismatch')
    assert.equal(app.fake.writes.filter((write) => write.op === 'snapshot-restore' && write.body.dry_run === false).length, 0, 'nothing was applied')
    const audit = await app.get('/api/openviking-enhance/audit?limit=5')
    assert.equal(audit.entries[0].result, 'failed')
    // The token is dead: executing again is a used-token refusal, not a retry.
    const replay = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'out' })
    assert.equal(replay.body.error.code, 'token-used')
  } finally {
    await app.shutdown()
  }
})

test('S6: a lagging snapshot log is verified with the bounded read retry (route level)', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-create', message: 'lag', paths: [MEMORY] })
    assert.equal(prepared.body.ok, true)
    app.fake.logLag = 2 // the first two verification reads still show the old HEAD
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token })
    assert.equal(executed.body.ok, true)
    assert.equal(executed.body.verified, true, 'the bounded retry saw the new commit')
  } finally {
    await app.shutdown()
  }
})

test('read-route paths filters are capped at SNAPSHOT_PATHS_MAX', async () => {
  const app = await boot()
  try {
    const paths = Array.from({ length: 17 }, (_, index) => `${OUT}/f${index}`)
    const log = await app.get(
      `/api/openviking-enhance/snapshot-log?${paths.map((path) => `paths=${encodeURIComponent(path)}`).join('&')}`,
    )
    assert.equal(log.ok, false)
    assert.equal(log.error.code, 'invalid-scope')
    const diffPaths = await app.get(
      `/api/openviking-enhance/snapshot-diff-paths?to=commit-45&${paths.map((path) => `paths=${encodeURIComponent(path)}`).join('&')}`,
    )
    assert.equal(diffPaths.ok, false)
    assert.equal(diffPaths.error.code, 'invalid-scope')
  } finally {
    await app.shutdown()
  }
})

test('S7: an in-flight ops mutation holds the shared gate and refuses a write prepare', async () => {
  const app = await boot()
  try {
    const prepared = await app.mutate('/ops/prepare', { action: 'snapshot-create', message: 'gate', paths: [MEMORY] })
    assert.equal(prepared.body.ok, true)
    app.fake.holdCommit = true
    const executing = app.mutate('/ops/execute', { token: prepared.body.token })
    // Wait until the ops mutation has reached the server and is parked there.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.fake.heldCommit !== null) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.notEqual(app.fake.heldCommit, null, 'the ops mutation is in flight')
    const blocked = await app.mutate('/write/prepare', {
      action: 'delete-memory',
      target: `${MEMORY}/preferences/tools.md`,
    })
    assert.equal(blocked.body.ok, false)
    assert.equal(blocked.body.error.code, 'write-in-flight', 'WriteService and OpsService share one gate')
    app.fake.releaseCommit()
    const executed = await executing
    assert.equal(executed.body.ok, true)
    assert.match(executed.body.auditId, /^aud-/)
  } finally {
    await app.shutdown()
  }
})

test('file-version restore audit does not stuff a version id into the commit columns', async () => {
  const app = await boot()
  try {
    const uri = `${OUT}/report.md`
    const prepared = await app.mutate('/ops/prepare', {
      action: 'file-version-restore',
      uri,
      restoreVersion: 'ver-1',
      currentVersion: 'ver-2',
    })
    assert.equal(prepared.body.ok, true)
    const executed = await app.mutate('/ops/execute', { token: prepared.body.token, typed: 'report.md' })
    assert.equal(executed.body.ok, true)
    const audit = await app.get('/api/openviking-enhance/audit?limit=10&action=file-version-restore')
    assert.equal(audit.entries.length >= 1, true)
    const entry = audit.entries[0]
    assert.equal(entry.snapshot === null || entry.snapshot === undefined, true, 'no fake commit columns')
    assert.equal(entry.snapshot?.sourceCommit ?? null, null, 'the version UUID is not a commit')
    assert.equal(entry.target, uri)
  } finally {
    await app.shutdown()
  }
})
