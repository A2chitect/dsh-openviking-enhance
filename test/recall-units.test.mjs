// Unit tests for the recall path behind the right-Sidebar panel.
//
// The interesting assertions here are about the WIRE: which targets get searched,
// what each request body carries, and how several replies become three buckets.
// A stub server is therefore used with the real `OpenVikingApi`, the same way the
// session-history regression is pinned, so these stay assertions about the
// requests the plugin actually makes rather than about a hand-written double.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { OpenVikingApi } from '../src/host/openviking-api.ts'
import {
  RecallService,
  latestUserPrompt,
  searchTargets,
  userRootOf,
} from '../src/host/recall-service.ts'

const SESSION_URI = 'viking://user/default/sessions/dsh-abc'
const USER_ROOT = 'viking://user/default'
const PEER = 'peer-1'

/** Run `body` with a stub OpenViking and hand it the base URL. */
async function withStub(handler, body) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.close()
  }
}

/** The session log the plugin writes: two user turns, noise, and a last assistant line. */
const MESSAGES_JSONL = [
  JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '旧提问' }] }),
  '{ this line is not json',
  JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: '旧回答' }] }),
  JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '最新提问' }, { type: 'image', url: 'x' }] }),
  JSON.stringify({ role: 'assistant', parts: [{ type: 'tool', tool_name: 'bash' }] }),
].join('\n')

/** What the stub answers per target; the same uri appears under two targets on purpose. */
function replyFor(target) {
  if (target === `${USER_ROOT}/memories`) {
    return {
      memories: [
        { uri: `${USER_ROOT}/memories/a.md`, score: 0.5, context_type: 'memory', level: 2, abstract: 'A', tags: [] },
        { uri: `${USER_ROOT}/memories/shared.md`, score: 0.4, context_type: 'memory', abstract: 'S' },
      ],
      resources: [],
      skills: [],
      query_plan: { reasoning: 'Task type: test' },
    }
  }
  if (target === `${USER_ROOT}/peers/${PEER}/memories`) {
    return {
      memories: [
        { uri: `${USER_ROOT}/memories/a.md`, score: 0.9, context_type: 'memory', abstract: 'A again' },
        { uri: `${USER_ROOT}/peers/${PEER}/memories/b.md`, score: 0.8, context_type: 'memory', abstract: 'B' },
      ],
      resources: [],
      skills: [],
      query_plan: { reasoning: 'Task type: test' },
    }
  }
  if (target === `${USER_ROOT}/skills`) {
    return { memories: [], resources: [], skills: [{ uri: `${USER_ROOT}/skills/s.md`, score: 0.6 }] }
  }
  if (target === `${USER_ROOT}/resources`) {
    return { memories: [], resources: [{ uri: `${USER_ROOT}/resources/r.md`, score: 0.7 }], skills: [] }
  }
  throw new Error(`unexpected target ${target}`)
}

/** A stub OpenViking that records every request the recall path makes. */
function recallStub(overrides = {}) {
  const calls = { search: [], read: [], session: 0, peer: [] }
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', result }))
    }
    if (url.pathname.startsWith('/api/v1/sessions/')) {
      calls.session += 1
      return send({
        session_id: 'dsh-abc',
        uri: SESSION_URI,
        message_count: 0,
        commit_count: 0,
        memories_extracted: { total: 0, memory_write: 0, memory_edit: 0 },
        last_commit_at: null,
        pending_tokens: 0,
      })
    }
    if (url.pathname === '/api/v1/content/read') {
      const uri = url.searchParams.get('uri') ?? ''
      calls.read.push(uri)
      if (uri.endsWith('messages.jsonl')) return send(overrides.messages ?? MESSAGES_JSONL)
      if (overrides.content !== undefined) return send(overrides.content)
      return send('body of one entry')
    }
    if (url.pathname === '/api/v1/search/search') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        calls.search.push(parsed)
        calls.peer.push(req.headers['x-openviking-actor-peer'])
        const target = parsed.target_uri
        if (overrides.failTarget === target) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: { message: 'boom' } }))
          return
        }
        send(replyFor(target))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  }
  return { calls, handler }
}

/** A RecallService wired to the stub, with the peer the memory plugin would report. */
function serviceFor(endpoint, options = {}) {
  const api = new OpenVikingApi({ endpoint, apiKey: '', account: 'default', user: 'default' })
  const commit = {
    ovSessionId: (sessionId) => `dsh-${sessionId}`,
    actorPeer: () => PEER,
  }
  return new RecallService({ api, commit, cacheTtlMs: options.cacheTtlMs ?? 15000, ...(options.now ? { now: options.now } : {}) })
}

test('latestUserPrompt takes the last user turn and survives a broken log', () => {
  assert.equal(latestUserPrompt(MESSAGES_JSONL), '最新提问')
  assert.equal(latestUserPrompt(''), null)
  assert.equal(latestUserPrompt('not json at all\n{"role":"assistant","parts":[]}'), null)
  // A user turn with no text part is not a query.
  assert.equal(latestUserPrompt(JSON.stringify({ role: 'user', parts: [{ type: 'image' }] })), null)
})

test('userRootOf reads the user root out of a session path', () => {
  assert.equal(userRootOf(SESSION_URI), USER_ROOT)
  assert.equal(userRootOf('viking://user/fitbot/sessions/x'), 'viking://user/fitbot')
  assert.equal(userRootOf('viking://agent/sessions/x'), null)
  assert.equal(userRootOf(null), null)
})

test('searchTargets covers every source and the peer tree', () => {
  assert.deepEqual(searchTargets(SESSION_URI, 'default', PEER).map((target) => target.uri), [
    `${USER_ROOT}/memories`,
    `${USER_ROOT}/peers/${PEER}/memories`,
    `${USER_ROOT}/resources`,
    `${USER_ROOT}/skills`,
  ])
  // Without a peer the peer tree is dropped rather than guessed at.
  assert.deepEqual(searchTargets(SESSION_URI, 'default', null).map((target) => target.uri), [
    `${USER_ROOT}/memories`,
    `${USER_ROOT}/resources`,
    `${USER_ROOT}/skills`,
  ])
  // No session record: fall back to the configured identity's root.
  assert.deepEqual(searchTargets(null, 'fitbot', null).map((target) => target.uri), [
    'viking://user/fitbot/memories',
    'viking://user/fitbot/resources',
    'viking://user/fitbot/skills',
  ])
})

test('recall searches every target as the session, and merges the replies', async () => {
  const stub = recallStub()
  await withStub(stub.handler, async (endpoint) => {
    const payload = await serviceFor(endpoint).recall('abc')

    // Four targets, each with the session id that makes the answer session-aware.
    assert.deepEqual(
      stub.calls.search.map((body) => body.target_uri),
      [
        `${USER_ROOT}/memories`,
        `${USER_ROOT}/peers/${PEER}/memories`,
        `${USER_ROOT}/resources`,
        `${USER_ROOT}/skills`,
      ],
    )
    for (const body of stub.calls.search) {
      assert.equal(body.session_id, 'dsh-abc')
      assert.equal(body.query, '最新提问')
      assert.equal(body.score_threshold, 0)
      assert.equal(body.limit, 8)
    }
    assert.deepEqual(stub.calls.peer, [PEER, PEER, PEER, PEER])

    // The query came from the session's own log, read once.
    assert.equal(payload.query.source, 'session')
    assert.equal(payload.query.text, '最新提问')
    assert.deepEqual(stub.calls.read, [`${SESSION_URI}/messages.jsonl`])

    // Same uri from two targets: kept once, at the better score.
    const memories = payload.buckets.find((bucket) => bucket.bucket === 'memories')
    assert.deepEqual(memories.items.map((item) => item.uri), [
      `${USER_ROOT}/memories/a.md`,
      `${USER_ROOT}/peers/${PEER}/memories/b.md`,
      `${USER_ROOT}/memories/shared.md`,
    ])
    assert.equal(memories.items[0].score, 0.9)
    assert.equal(memories.items[1].level, null)
    assert.deepEqual(memories.items[1].tags, [])

    const resources = payload.buckets.find((bucket) => bucket.bucket === 'resources')
    const skills = payload.buckets.find((bucket) => bucket.bucket === 'skills')
    assert.equal(resources.items.length, 1)
    assert.equal(skills.items.length, 1)

    assert.equal(payload.plan, 'Task type: test')
    assert.equal(payload.peer, PEER)
    assert.equal(payload.sessionUri, SESSION_URI)
    assert.equal(payload.targets.length, 4)
    // Raw hits across every reply, which is more than the de-duplicated list.
    assert.equal(payload.total, 6)
    assert.deepEqual(payload.warnings, [])
  })
})

test('recall honours the bucket limit and takes an explicit query', async () => {
  const stub = recallStub()
  await withStub(stub.handler, async (endpoint) => {
    const payload = await serviceFor(endpoint).recall('abc', '手动提问', 1)
    const memories = payload.buckets.find((bucket) => bucket.bucket === 'memories')
    assert.equal(memories.items.length, 1)
    assert.equal(memories.items[0].score, 0.9)
    assert.equal(payload.query.source, 'manual')
    assert.equal(payload.query.text, '手动提问')
    // An explicit query never reads the session log.
    assert.deepEqual(stub.calls.read, [])
    assert.equal(stub.calls.search[0].query, '手动提问')
    assert.equal(stub.calls.search[0].limit, 1)
  })
})

test('recall reports a session with no prompt instead of searching nothing', async () => {
  const stub = recallStub({ messages: '' })
  await withStub(stub.handler, async (endpoint) => {
    const payload = await serviceFor(endpoint).recall('abc')
    assert.equal(payload.query.text, '')
    assert.deepEqual(stub.calls.search, [])
    assert.deepEqual(payload.buckets.map((bucket) => bucket.items.length), [0, 0, 0])
    assert.equal(payload.warnings.length, 1)
    assert.equal(payload.warnings[0].includes('手动输入'), true)
  })
})

test('recall keeps the other sources when one target fails', async () => {
  const stub = recallStub({ failTarget: `${USER_ROOT}/skills` })
  await withStub(stub.handler, async (endpoint) => {
    const payload = await serviceFor(endpoint).recall('abc')
    assert.equal(payload.buckets.find((bucket) => bucket.bucket === 'memories').items.length, 3)
    assert.equal(payload.warnings.length, 1)
    assert.equal(payload.warnings[0].includes('/skills'), true)
    // The failure is reported with the server's own message, not a bare status.
    assert.equal(payload.warnings[0].includes('boom'), true)
  })
})

test('recall reuses one answer inside the TTL and bypasses it when asked fresh', async () => {
  const stub = recallStub()
  await withStub(stub.handler, async (endpoint) => {
    let clock = 1000
    const service = serviceFor(endpoint, { cacheTtlMs: 15000, now: () => clock })

    await service.recall('abc')
    assert.equal(stub.calls.search.length, 4)
    await service.recall('abc')
    assert.equal(stub.calls.search.length, 4, 'a cached answer makes no requests')

    clock += 20000
    await service.recall('abc')
    assert.equal(stub.calls.search.length, 8, 'the cache expires')

    await service.recall('abc', undefined, 8, { fresh: true })
    assert.equal(stub.calls.search.length, 12, 'fresh skips the cache')
  })
})

test('recall does not cache a query that produced nothing', async () => {
  const stub = recallStub({ messages: '' })
  await withStub(stub.handler, async (endpoint) => {
    const service = serviceFor(endpoint)
    await service.recall('abc')
    await service.recall('abc')
    // Each attempt re-reads the log: a session that has not spoken yet must not be
    // pinned to "no query" by an earlier look.
    assert.equal(stub.calls.session, 2)
  })
})

test("recall reads one entry's whole text and refuses anything that is not viking://", async () => {
  const stub = recallStub({ content: 'x'.repeat(30000) })
  await withStub(stub.handler, async (endpoint) => {
    const service = serviceFor(endpoint)
    const content = await service.content(`${USER_ROOT}/memories/a.md`)
    assert.equal('error' in content, false)
    assert.equal(content.text.length, 20000)
    assert.equal(content.truncated, true)

    const refused = await service.content('file:///etc/passwd')
    assert.equal('error' in refused, true)
    assert.equal(refused.error.includes('viking://'), true)
    // The refusal happens before any request leaves the host.
    assert.equal(stub.calls.read.length, 1)
  })
})
