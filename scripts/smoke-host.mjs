// Smoke-test the built host half against the live OpenViking server, without
// installing anything into a DSH profile.
//
// It boots `lib/index.js` under a minimal fake Cordis context, mounts the routes
// on a throwaway HTTP server, and calls them the way the browser half does.
// This is the only check that exercises the real route handlers, the real
// OpenViking API and the real response shapes — including the retrieval that
// feeds the right-Sidebar panel, which no unit test can prove against a live
// server's own ranking.
//
//   node scripts/smoke-host.mjs [dshSessionId]
//
// Defaults to this machine's most recently committed DSH session when one is
// given, else it lists candidates from the OpenViking session index.
import http from 'node:http'
import { apply } from '../lib/index.js'

const routes = []
const context = {
  webServer: {
    port: 0,
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(callback) {
    callback()
    return () => {}
  },
  get() {
    // The OpenViking memory plugin is not mounted here: this exercises the
    // documented fallback path (`dsh-<sessionId>`, no actor peer).
    return undefined
  },
  logger: console,
}

apply(context)

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((candidate) => candidate.path === pathname)
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `no route for ${pathname}` }))
    return
  }
  void route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/**
 * The live-data half needs a running OpenViking; the fence half does not.
 *
 * On a machine without the server (CI, a fresh clone) the data path reports SKIP
 * and the exit code stays 0, while the fence assertions still run — those are the
 * ones that catch a regression introduced by this repository. Asking for a
 * specific session, or setting SMOKE_REQUIRE_SERVER=1, turns the skip back into a
 * failure for anyone who wants the full check.
 */
const requireServer = process.env.SMOKE_REQUIRE_SERVER === '1'
const requested = process.argv[2]
const config = await get(`${base}/api/openviking-enhance/config`)
const reachable = config?.ok === true && config?.healthy === true
const sessionId = requested ?? (reachable ? await pickSession(config) : null)

if (sessionId) {
  await report(base, sessionId)
} else {
  const reason = config?.ok !== true
    ? 'the plugin routes did not answer'
    : `OpenViking is not healthy at ${config.endpoint}`
  if (requireServer || requested) {
    console.error(`[smoke] FAIL ${reason}`)
    process.exitCode = 1
  } else {
    console.log(`[smoke] SKIP live data path: ${reason}`)
    console.log('[smoke]      (start OpenViking, or set SMOKE_REQUIRE_SERVER=1 to fail instead)')
  }
  await checkFence(base)
}

server.close()

/** One raw request, so the Host/Origin/method can be shaped exactly. */
function rawStatus(base, path, { method = 'GET', headers = {} } = {}) {
  const url = new URL(base)
  return new Promise((resolve) => {
    const request = http.request({ host: url.hostname, port: url.port, path, method, headers }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', () => resolve(0))
    request.end()
  })
}

/**
 * The fence, end to end: these routes are outside the DSH web auth gate, so the
 * only thing standing between the memory store and a tunneled port is this.
 */
async function checkFence(base) {
  const path = '/api/openviking-enhance/config'
  const cases = [
    ['plain loopback request', {}, 200],
    ['public Host header', { headers: { host: 'dsh.example.com' } }, 403],
    ['cross-origin Origin', { headers: { origin: 'http://evil.example.com' } }, 403],
    ['same-origin Origin', { headers: { origin: new URL(base).origin } }, 200],
    ['cross-site fetch marker', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['POST instead of GET', { method: 'POST' }, 405],
  ]
  for (const [label, options, expected] of cases) {
    const actual = await rawStatus(base, path, options)
    const ok = actual === expected
    console.log(`[fence] ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual} (expected ${expected})`)
    if (!ok) process.exitCode = 1
  }
}

async function report(base, sessionId) {
  const config = await get(`${base}/api/openviking-enhance/config`)
  console.log('[smoke] config     ', summarise(config))

  const status = await get(`${base}/api/openviking-enhance/status?sessionId=${encodeURIComponent(sessionId)}`)
  console.log('[smoke] status     ', summarise(status))

  const commits = await get(`${base}/api/openviking-enhance/commits?sessionId=${encodeURIComponent(sessionId)}`)
  console.log('[smoke] commits    ', summarise({ status: commits?.status, tasks: `${commits?.tasks?.length ?? 0} tasks` }))
  console.log(`[smoke] timeline    newest ${commits?.summaries?.length ?? 0} of ${commits?.status?.archives?.length ?? 0} archives`)
  for (const entry of commits?.summaries ?? []) {
    const name = entry.archiveUri.split('/').at(-1)
    const s = entry.summary
    const counts = s ? `${s.totalAdds} adds / ${s.totalUpdates} updates / ${s.totalDeletes} deletes` : '(no diff yet)'
    console.log(`[smoke]   ${name.padEnd(12)} ${counts}`)
  }

  const recall = await get(
    `${base}/api/openviking-enhance/recall?sessionId=${encodeURIComponent(sessionId)}&limit=3`,
  )
  if (recall?.ok !== true) {
    console.log(`[smoke] FAIL recall      ${recall?.error ?? 'no answer'}`)
    process.exitCode = 1
  } else {
    const payload = recall.recall
    console.log(
      `[smoke] recall      ${payload.query.source === 'session' ? 'session query' : 'explicit query'} ` +
        `"${payload.query.text.slice(0, 40)}" · ${payload.targets.length} targets · ` +
        `${payload.total} hits · ${payload.latencyMs} ms`,
    )
    for (const bucket of payload.buckets) {
      const top = bucket.items[0]
      console.log(
        `[smoke]   ${bucket.bucket.padEnd(10)} ${String(bucket.items.length).padStart(2)}` +
          (top ? `  ${top.score.toFixed(3)}  ${top.uri.replace('viking://user/default/', '~/')}` : ''),
      )
    }
    if (payload.plan) console.log(`[smoke] plan        ${payload.plan.split('\n')[0].slice(0, 90)}`)
    for (const warning of payload.warnings) console.log(`[smoke]   warning   ${warning}`)

    // The detail view is a second route; exercise it on a real hit.
    const first = payload.buckets.flatMap((bucket) => bucket.items)[0]
    if (first) {
      const content = await get(
        `${base}/api/openviking-enhance/recall/content?uri=${encodeURIComponent(first.uri)}`,
      )
      if (content?.ok !== true) {
        console.log(`[smoke] FAIL content     ${content?.error ?? 'no answer'}`)
        process.exitCode = 1
      } else {
        console.log(
          `[smoke] content     ${content.content.text.length} chars, truncated=${content.content.truncated}`,
        )
      }
    }
  }

  const archive = commits?.status?.archives?.at(-1)
  if (!archive) {
    console.log('[smoke] diff        (no archive for this session yet)')
    return
  }
  const diff = await get(
    `${base}/api/openviking-enhance/diff?sessionId=${encodeURIComponent(sessionId)}&archive=${encodeURIComponent(archive.archiveUri)}`,
  )
  console.log('[smoke] diff        ', summarise(diff))
  if (diff?.diff) {
    console.log(
      `[smoke] affected    adds=${diff.diff.summary.totalAdds} updates=${diff.diff.summary.totalUpdates} deletes=${diff.diff.summary.totalDeletes}`,
    )
    for (const entry of [...diff.diff.adds, ...diff.diff.updates].slice(0, 5)) {
      console.log(`[smoke]   ${entry.memoryType.padEnd(12)} ${entry.uri}`)
    }
  }

  await checkFence(base)
}

/** Find a DSH session that already has commits, by asking OpenViking directly. */
async function pickSession(config) {
  // A completed commit task names its session, so the diff path gets exercised.
  const tasks = await get(`${config.endpoint}/api/v1/tasks?task_type=session_commit&limit=200`)
  const taskItems = Array.isArray(tasks?.result) ? tasks.result : (tasks?.result?.items ?? [])
  const committed = taskItems.find(
    (task) => typeof task?.resource_id === 'string' && task.resource_id.startsWith('dsh-') && task.status === 'completed',
  )
  if (committed) return committed.resource_id.replace(/^dsh-/, '')

  // Otherwise settle for any DSH session; the status path still gets tested.
  const list = await get(`${config.endpoint}/api/v1/sessions?limit=200`)
  const items = Array.isArray(list?.result) ? list.result : []
  const anyDsh = items.find((item) => typeof item?.session_id === 'string' && item.session_id.startsWith('dsh-'))
  return anyDsh ? anyDsh.session_id.replace(/^dsh-/, '') : null
}

async function get(url) {
  try {
    const response = await fetch(url)
    return await response.json()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function summarise(payload) {
  if (!payload || typeof payload !== 'object') return String(payload)
  if (payload.ok === false) return `NOT OK: ${payload.error}`
  const { ok, ...rest } = payload
  const text = JSON.stringify(rest)
  return text.length > 420 ? `${text.slice(0, 420)}…` : text
}
