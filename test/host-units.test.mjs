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
  resolveSessionUri,
} from '../src/host/commit-service.ts'
import { OpenVikingApi, parseMaybeDoubleEncoded } from '../src/host/openviking-api.ts'
import {
  deriveClientPhase,
  describeFailure,
  durationSeconds,
  failedTasks,
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

test('status hands the session directory to listHistory and reports its archives', async () => {
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
  }
  const service = new CommitService({ api, memoryRuntime: () => null })
  const status = await service.status('abc')

  assert.deepEqual(seen, ['viking://user/default/sessions/dsh-abc'])
  assert.equal(status.archives.length, 1)
  assert.equal(status.archives[0].archiveId, 'archive_001')
  assert.equal(status.phase, 'done')
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

test('derivePhase names the archive/counter disagreement', () => {
  assert.equal(derivePhase({ metaOk: false, commitCount: 0, pendingTokens: 0, archiveCount: 0 }), 'failed')
  assert.equal(derivePhase({ metaOk: true, commitCount: 0, pendingTokens: 0, archiveCount: 0 }), 'idle')
  assert.equal(derivePhase({ metaOk: true, commitCount: 0, pendingTokens: 12, archiveCount: 0 }), 'pending')
  assert.equal(derivePhase({ metaOk: true, commitCount: 2, pendingTokens: 0, archiveCount: 2 }), 'done')
  assert.equal(derivePhase({ metaOk: true, commitCount: 1, pendingTokens: 0, archiveCount: 2 }), 'extracting')
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

test('deriveClientPhase reports the newest task, not any failure', () => {
  const older = { task_id: 'a', status: 'failed', stage: null, error: 'x', result: null, created_at: 100 }
  const newer = { task_id: 'b', status: 'completed', stage: null, error: null, result: null, created_at: 200 }
  // A superseded failure must not own the pill; the popover still lists it.
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [newer, older] }), 'done')
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [older, newer] }), 'done')
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'done' }, tasks: [older] }), 'errored')
})

test('deriveClientPhase falls back to the host phase with no tasks', () => {
  assert.equal(deriveClientPhase({ error: null, status: { phase: 'pending' }, tasks: [] }), 'pending')
  assert.equal(deriveClientPhase({ error: null, status: null, tasks: [] }), 'idle')
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
  assert.equal(describeFailure({ ...task, error: null }), '抽取失败（阶段：failed）')
  assert.equal(describeFailure({ ...task, error: null, stage: null }), '抽取失败（服务端未给出原因）')
})

test('failedTasks and taskTime read the task list the way the popover needs', () => {
  const tasks = [
    { task_id: 'a', status: 'completed', stage: null, error: null, result: null, created_at_iso: '2026-10-02T02:03:53+00:00' },
    { task_id: 'b', status: 'failed', stage: 'failed', error: 'x', result: null, created_at_iso: '2026-10-02T02:25:34+00:00', processing_seconds: 89.4 },
    { task_id: 'c', status: 'cancelled', stage: null, error: null, result: null, created_at_iso: '2026-10-02T02:53:25+00:00' },
  ]
  const failures = failedTasks(tasks)
  assert.deepEqual(failures.map((t) => t.task_id), ['c', 'b'])
  assert.equal(durationSeconds(failures[1]), 89)
  assert.equal(taskTime(failures[1]).startsWith('10-02 '), true)
  assert.equal(taskTime({ ...tasks[0], created_at_iso: 'nonsense' }), null)
})
