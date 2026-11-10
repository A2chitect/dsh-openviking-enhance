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
import { Config, apply } from '../lib/index.js'
import { createRedactor } from './smoke-redact.mjs'

/**
 * Privacy: the live-data path prints redacted facts by default (counts, states,
 * durations, URI scope/kind) and never session ids, URI leaves, query text,
 * plan text, identity values or home paths. `SMOKE_VERBOSE=1` restores the old
 * detailed output for local debugging. See `scripts/smoke-redact.mjs`.
 */
const redactor = createRedactor()
if (!redactor.verbose) {
  // Say why the output is terse: an operator who expected the old detail needs
  // the documented escape hatch in front of them, not in a README.
  console.log('[smoke] privacy     redacted (set SMOKE_VERBOSE=1 for raw local detail)')
}

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

// The config is RESOLVED FROM THE SCHEMA, exactly as the Loader hands it over.
// Calling `apply(ctx)` with nothing is what let a released build ship broken:
// `volatile()` fields resolve to references rather than values, so the plugin died
// on activation in the app while every test here passed. Passing `{}` proves
// nothing about the shape the app actually uses.
const resolved = Config(process.env.SMOKE_ENDPOINT ? { endpoint: process.env.SMOKE_ENDPOINT } : {})
if (process.env.SMOKE_ENDPOINT) {
  const live = resolved.endpoint?.get?.()
  if (live !== process.env.SMOKE_ENDPOINT) {
    console.error('[smoke] FAIL the resolved endpoint did not carry the override')
    process.exitCode = 1
  }
}
apply(context, resolved)

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
    : `OpenViking is not healthy at ${redactor.endpoint(config.endpoint)}`
  if (requireServer || requested) {
    console.error(`[smoke] FAIL ${reason}`)
    process.exitCode = 1
  } else {
    console.log(`[smoke] SKIP live data path: ${reason}`)
    console.log('[smoke]      (start OpenViking, or set SMOKE_REQUIRE_SERVER=1 to fail instead)')
    // A skipped data path used to verify nothing. Someone who installs this
    // plugin before OpenViking is the first run that matters most, so the
    // no-server branch now asserts the degraded answers every route gives.
    await checkDegraded(base)
  }
}

await checkV05(base, sessionId)
await checkV07(base)
await checkFence(base)

server.close()

/** One raw request, so the Host/Origin/method/body can be shaped exactly. */
function rawStatus(base, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(base)
  return new Promise((resolve) => {
    // A fresh socket per request: a keep-alive socket the agent pooled earlier can
    // be closed by the server's idle timeout, and Node does not retry a POST on a
    // stale socket — which surfaced as a spurious status 0 in these probes.
    const request = http.request({ host: url.hostname, port: url.port, path, method, headers, agent: false }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', () => resolve(0))
    request.end(body)
  })
}

/** A read-only JSON POST, the way the browser half calls the v0.4 routes. */
function postJson(url, body) {
  const target = new URL(url)
  const payload = JSON.stringify(body)
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          host: target.host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            resolve(null)
          }
        })
      },
    )
    request.on('error', () => resolve(null))
    request.end(payload)
  })
}

/**
 * Every route, with no OpenViking to talk to.
 *
 * The plugin must be inert, not broken: each route answers JSON with an `ok`
 * field, `/config` says it is unhealthy and names why, and `/probe` reports the
 * address as unreachable rather than throwing.
 */
async function checkDegraded(base) {
  const prefix = '/api/openviking-enhance'
  const routes = [
    ['config', `${prefix}/config`],
    ['status', `${prefix}/status?sessionId=probe`],
    ['commits', `${prefix}/commits?sessionId=probe`],
    ['recall', `${prefix}/recall?sessionId=probe`],
    ['explain', `${prefix}/recall/explain?sessionId=probe&query=probe`],
    ['log', `${prefix}/session-log?sessionId=probe`],
    ['doctor', `${prefix}/doctor?sessionId=probe`],
    ['diff', `${prefix}/diff?sessionId=probe&archive=viking://x/history/archive_001`],
    ['probe', `${prefix}/probe?endpoint=${encodeURIComponent('http://127.0.0.1:9')}`],
    ['content', `${prefix}/recall/content?uri=${encodeURIComponent('viking://user/default/memories/x.md')}`],
    ['preview', `${prefix}/preview?uri=${encodeURIComponent('viking://user/default/memories/x.md')}`],
    ['rules', `${prefix}/rules`],
    ['skills', `${prefix}/skills`],
    ['experience', `${prefix}/experience?kind=trajectories`],
    // v0.5 reads: identity scope, profiles, task centre, metrics, audit and the
    // F10 session-control read model. Every one must answer a JSON envelope even
    // with no server behind it.
    ['scope', `${prefix}/scope`],
    ['profiles', `${prefix}/profiles`],
    ['tasks', `${prefix}/tasks?limit=2`],
    ['task', `${prefix}/task?taskId=probe&events=1`],
    ['task export', `${prefix}/task/export?taskId=probe`],
    ['metrics', `${prefix}/metrics?sessionId=probe`],
    ['audit', `${prefix}/audit?limit=5`],
    ['session-control', `${prefix}/session-control?sessionId=probe`],
    // v0.7 reads: the composed overview, the identity-aware browse roots/pages,
    // the sessions page, the bounded recent-commit fan-out and the Studio probe.
    ['overview', `${prefix}/overview?fresh=1`],
    ['browse roots', `${prefix}/browse/roots`],
    ['browse page', `${prefix}/browse?uri=${encodeURIComponent('viking://user/default/memories')}`],
    ['browse subtree', `${prefix}/browse/subtree?uri=${encodeURIComponent('viking://user/default/memories')}`],
    ['sessions', `${prefix}/sessions?limit=2`],
    ['recent commits', `${prefix}/recent-commits?limit=2`],
    ['studio status', `${prefix}/studio-status`],
  ]
  for (const [label, path] of routes) {
    const body = await get(`${base}${path}`)
    const answered = body !== null && body !== undefined && typeof body === 'object' && 'ok' in body
    console.log(`[offline] ${answered ? 'ok  ' : 'FAIL'} ${label.padEnd(8)} answers JSON`)
    if (!answered) process.exitCode = 1
  }
  // The v0.4 read-only POSTs: with no OpenViking behind them they must still
  // answer a JSON envelope (never a throw or an empty response).
  for (const [label, path, body] of [
    ['search', `${prefix}/search`, { query: 'probe' }],
    ['rules search', `${prefix}/rules/search`, { taskContext: 'probe' }],
  ]) {
    const answer = await postJson(`${base}${path}`, body)
    const answered = answer !== null && typeof answer === 'object' && 'ok' in answer
    console.log(`[offline] ${answered ? 'ok  ' : 'FAIL'} ${label.padEnd(12)} answers JSON over POST`)
    if (!answered) process.exitCode = 1
  }

  const config = await get(`${base}${prefix}/config`)
  const named = (config?.warnings ?? []).some((warning) => warning?.code === 'unreachable')
  console.log(`[offline] ${named ? 'ok  ' : 'FAIL'} config names the unreachable endpoint as a code`)
  if (!named) process.exitCode = 1
  const probe = await get(`${base}${prefix}/probe?endpoint=${encodeURIComponent('http://127.0.0.1:9')}`)
  const refused = probe?.ok === true && probe.reachable === false
  console.log(`[offline] ${refused ? 'ok  ' : 'FAIL'} probe reports a dead address as unreachable`)
  if (!refused) process.exitCode = 1
}

/**
 * v0.5 read routes and the write-transport fence.
 *
 * Two things are verified here that no unit test can:
 *
 *  1. the new read routes answer the documented envelopes against whatever server
 *     this machine has (the shape is stable; the values degrade);
 *  2. **no mutation route exists on the loopback `webServer` fence**. Decision B
 *     puts every write on the authenticated `ctx.connection.fetch` transport, and
 *     this fake host has no connection service, so a POST to a write path must be
 *     a 404 — anything else would mean a raw loopback write path shipped.
 */
async function checkV05(base, sessionId) {
  const prefix = '/api/openviking-enhance'
  const check = (ok, message) => {
    console.log(`[v05] ${ok ? 'ok  ' : 'FAIL'} ${message}`)
    if (!ok) process.exitCode = 1
  }

  const scope = await get(`${base}${prefix}/scope`)
  check(
    scope?.ok === true && typeof scope.scope?.identity?.fingerprint === 'string' && scope.scope.identity.fingerprint.startsWith('sha256:'),
    'the scope route reports a fingerprint',
  )
  check(
    scope?.scope?.writes?.enabled === false,
    `writes are off by default (enabled=${scope?.scope?.writes?.enabled})`,
  )
  check(
    scope?.scope?.writes?.transport === false && typeof scope?.scope?.writes?.reason === 'string',
    `without ctx.connection.fetch the write gates fail closed (${scope?.scope?.writes?.reason})`,
  )
  check(
    scope?.scope?.identity !== undefined && !JSON.stringify(scope.scope.identity).toLowerCase().includes('apikey'),
    'the scope payload carries no secret',
  )

  const profiles = await get(`${base}${prefix}/profiles`)
  check(
    profiles?.ok === true && Array.isArray(profiles.profiles?.profiles) && typeof profiles.profiles.storePath === 'string',
    `the profiles route answers a redacted list (${profiles?.profiles?.profiles?.length ?? '?'} profile(s))`,
  )
  check(!JSON.stringify(profiles).includes('apiKey'), 'no profile payload ever returns a key')

  const tasks = await get(`${base}${prefix}/tasks?limit=2`)
  check(tasks?.ok === true && Array.isArray(tasks.tasks) && typeof tasks.available === 'boolean', 'the tasks route answers a bounded page')

  const metrics = await get(`${base}${prefix}/metrics${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`)
  check(
    metrics?.ok === true && metrics.metrics?.prometheus === false && typeof metrics.metrics.dashboard?.available === 'boolean',
    'the metrics route answers per-card availability and never probes Prometheus',
  )

  const audit = await get(`${base}${prefix}/audit?limit=5`)
  check(audit?.ok === true && Array.isArray(audit.entries), 'the audit route answers a bounded tail')

  const control = await get(`${base}${prefix}/session-control?sessionId=${encodeURIComponent(sessionId ?? 'probe')}`)
  check(
    control?.ok === true && control.capture?.canPause === false,
    'the session-control read model states that capture pause is not available',
  )

  // Decision B: mutations must not exist on the raw loopback fence.
  for (const path of [
    '/write/prepare',
    '/write/execute',
    '/write/undo',
    '/write/plan',
    '/write/cancel',
    '/task/cancel',
    '/profiles/save',
    '/profiles/delete',
    '/profiles/test',
  ]) {
    // No body: the keep-alive probe only needs the dispatch decision, and the
    // fake server's 404 handler does not consume a request body.
    const posted = await rawStatus(base, `${prefix}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(base).origin },
    })
    check(posted === 404, `no loopback write route at ${path} (POST -> ${posted}, expected 404)`)
    const fetched = await rawStatus(base, `${prefix}${path}`)
    check(fetched === 405 || fetched === 404, `no read-shaped mutation route at ${path} (GET -> ${fetched})`)
  }
}

/**
 * v0.7 native read routes and the local onboarding-state POST.
 *
 * The shape checks are server-independent (the values degrade with no OpenViking;
 * the envelopes do not). The state POST checks are deliberately invalid-post-only
 * and cross-origin-only: the smoke script verifies the guard without overwriting a
 * developer's own dismissal/completion state.
 */
async function checkV07(base) {
  const prefix = '/api/openviking-enhance'
  const check = (ok, message) => {
    console.log(`[v07] ${ok ? 'ok  ' : 'FAIL'} ${message}`)
    if (!ok) process.exitCode = 1
  }

  const overview = await get(`${base}${prefix}/overview?fresh=1`)
  check(
    overview?.ok === true && typeof overview.overview?.parts === 'object' && typeof overview.overview?.observedAt === 'string',
    'the composed overview answers one payload with per-part flags',
  )
  check(
    Array.isArray(overview?.overview?.onboarding?.checks) && overview.overview.onboarding.checks.length === 6,
    `the overview carries the six cheap onboarding checks (saw ${overview?.overview?.onboarding?.checks?.length ?? '?'})`,
  )
  check(
    overview?.overview?.plugin !== undefined && typeof overview.overview.plugin.mounted === 'boolean',
    'the overview reports the in-process memory-plugin facts',
  )
  const overviewText = JSON.stringify(overview)
  check(!overviewText.includes('apiKey') && !overviewText.includes('Bearer'), 'the overview payload carries no secret')

  const roots = await get(`${base}${prefix}/browse/roots`)
  check(roots?.ok === true && Array.isArray(roots.roots) && roots.roots.length === 8, `the browse roots are resolved host-side (${roots?.roots?.length ?? '?'} roots)`)
  check(
    roots?.ok === true && roots.roots.every((root) => typeof root.uri === 'string' && root.uri.startsWith('viking://')),
    'every root is a viking:// URI',
  )

  const refused = await rawStatus(base, `${prefix}/browse?uri=${encodeURIComponent('viking://queue/job-1')}`)
  check(refused === 400, `the browse allowlist refuses an internal scope at the route (${refused}, expected 400)`)

  const sessions = await get(`${base}${prefix}/sessions?limit=2`)
  check(
    sessions !== null && typeof sessions === 'object' && 'ok' in sessions,
    'the sessions route answers an envelope (it degrades to ok:false without a server)',
  )
  const recent = await get(`${base}${prefix}/recent-commits?limit=2`)
  check(
    recent !== null && typeof recent === 'object' && 'ok' in recent,
    'the recent-commits route answers an envelope',
  )
  if (recent?.ok === true) {
    check(
      typeof recent.recent?.partial === 'boolean' &&
        typeof recent.recent?.progress?.sessionsScanned === 'number' &&
        recent.recent.progress.deadlineMs === 10_000,
      'recent commits report their bounded fan-out progress and 10 s deadline',
    )
    check(recent.recent?.progress?.sessionCap <= 8, 'the recent-commits session cap is at most eight')
  }

  const studio = await get(`${base}${prefix}/studio-status`)
  check(
    studio?.ok === true && ['yes', 'no', 'unknown'].includes(studio.studio?.frameable),
    `the Studio probe classifies the answer host-side (${studio?.studio?.frameable ?? '?'})`,
  )
  check(
    studio?.ok === true && typeof studio.studio?.reason === 'string' && !JSON.stringify(studio.studio ?? {}).includes('apiKey'),
    'the Studio probe reports a reason and no credentials',
  )

  // The onboarding POST is a LOCAL state write. Verify the guard without writing:
  // an invalid action must be refused, and a cross-origin page must be fenced.
  const invalid = await postJson(`${base}${prefix}/onboarding/state`, { action: 'not-an-action' })
  check(invalid?.ok === false, 'the local-state POST refuses an unknown action')
  const crossOrigin = await rawStatus(base, `${prefix}/onboarding/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
    body: JSON.stringify({ action: 'dismiss' }),
  })
  check(crossOrigin === 403, `a cross-origin state POST is fenced (${crossOrigin}, expected 403)`)
  const stateRead = await rawStatus(base, `${prefix}/onboarding/state`)
  check(stateRead === 405, `the local-state route is POST-only (${stateRead}, expected 405)`)
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

  // v0.4 widens the fence for two read-only JSON POST routes, and only in the
  // documented ways: same-origin loopback + JSON content type + a 64 KiB cap.
  const searchPath = '/api/openviking-enhance/search'
  const postCases = [
    [
      'same-origin JSON POST is admitted',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(base).origin }, body: '{"query":"probe"}' },
      200,
    ],
    [
      'cross-origin JSON POST is refused',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' }, body: '{"query":"probe"}' },
      403,
    ],
    [
      'cross-site fetch marker on POST is refused',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{"query":"probe"}',
      },
      403,
    ],
    [
      'a non-JSON POST is refused',
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"query":"probe"}' },
      415,
    ],
    [
      'an oversized POST is refused',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
        body: '',
      },
      413,
    ],
  ]
  for (const [label, options, expected] of postCases) {
    const actual = await rawStatus(base, searchPath, options)
    const ok = actual === expected
    console.log(`[fence] ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual} (expected ${expected})`)
    if (!ok) process.exitCode = 1
  }
}

async function report(base, sessionId) {
  const config = await get(`${base}/api/openviking-enhance/config`)
  console.log('[smoke] config     ', redactor.summarise(config))

  const status = await get(`${base}/api/openviking-enhance/status?sessionId=${encodeURIComponent(sessionId)}`)
  console.log('[smoke] status     ', redactor.summarise(status))

  const commits = await get(`${base}/api/openviking-enhance/commits?sessionId=${encodeURIComponent(sessionId)}`)
  console.log('[smoke] commits    ', redactor.summarise({ status: commits?.status, tasks: `${commits?.tasks?.length ?? 0} tasks` }))
  console.log(`[smoke] timeline    newest ${commits?.summaries?.length ?? 0} of ${commits?.status?.archives?.length ?? 0} archives`)
  // The durable-marker contract the client renders from: `latest` is null only
  // before the first commit, and every summary carries a terminal state.
  const latest = commits?.status?.latest
  const latestOk =
    latest === null || (typeof latest?.state === 'string' && typeof latest?.markers === 'boolean')
  const summariesOk = (commits?.summaries ?? []).every((entry) =>
    ['done', 'failed', 'pending', 'unknown'].includes(entry.state),
  )
  console.log(
    `[smoke] markers     ${latestOk && summariesOk ? 'ok  ' : 'FAIL'} latest=${latest?.state ?? 'none'} summaries=${summariesOk ? 'ok' : 'bad'}`,
  )
  if (!latestOk || !summariesOk) process.exitCode = 1
  for (const entry of commits?.summaries ?? []) {
    const name = redactor.archiveName(entry.archiveUri)
    const s = entry.summary
    const counts = s ? `${s.totalAdds} adds / ${s.totalUpdates} updates / ${s.totalDeletes} deletes` : '(no diff yet)'
    const failed = entry.state === 'failed' ? ` [${entry.failure?.stage ?? 'failed'}]` : ''
    console.log(`[smoke]   ${name.padEnd(12)} ${entry.state.padEnd(7)} ${counts}${failed}`)
  }

  // The configuration form's own guard: a loopback endpoint is probed, anything
  // else is refused before a request leaves the host.
  const probe = await get(`${base}/api/openviking-enhance/probe?endpoint=${encodeURIComponent(config.endpoint)}`)
  console.log(
    `[smoke] probe       ${probe?.ok === true ? `reachable=${probe.reachable} version=${probe.version ?? '?'}` : `FAIL ${redactor.text(probe?.error ?? 'no answer')}`}`,
  )
  if (probe?.ok !== true || probe.reachable !== true) process.exitCode = 1
  const refused = await get(
    `${base}/api/openviking-enhance/probe?endpoint=${encodeURIComponent('http://example.com:1933')}`,
  )
  const refusedOk = refused?.ok === false
  console.log(`[smoke] probe guard ${refusedOk ? 'ok  ' : 'FAIL'} non-loopback endpoint refused (${redactor.text(refused?.error ?? 'not refused')})`)
  if (!refusedOk) process.exitCode = 1

  const recall = await get(
    `${base}/api/openviking-enhance/recall?sessionId=${encodeURIComponent(sessionId)}&limit=3`,
  )
  if (recall?.ok !== true) {
    console.log(`[smoke] FAIL recall      ${redactor.text(recall?.error ?? 'no answer')}`)
    process.exitCode = 1
  } else {
    const payload = recall.recall
    console.log(
      `[smoke] recall      ${payload.query.source === 'session' ? 'session query' : 'explicit query'} ` +
        `${redactor.query(payload.query.text)} · ${payload.targets.length} targets · ` +
        `${payload.total} hits · ${payload.latencyMs} ms`,
    )
    for (const bucket of payload.buckets) {
      const top = bucket.items[0]
      console.log(
        `[smoke]   ${bucket.bucket.padEnd(10)} ${String(bucket.items.length).padStart(2)}` +
          (top ? `  ${top.score.toFixed(3)}  ${redactor.uri(top.uri)}` : ''),
      )
    }
    if (payload.plan && redactor.verbose) {
      console.log(`[smoke] plan        ${payload.plan.split('\n')[0].slice(0, 90)}`)
    }
    for (const warning of payload.warnings) console.log(`[smoke]   warning   ${warning.code}`)

    // The detail view is a second route; exercise it on a real hit.
    const first = payload.buckets.flatMap((bucket) => bucket.items)[0]
    if (first) {
      const content = await get(
        `${base}/api/openviking-enhance/recall/content?uri=${encodeURIComponent(first.uri)}`,
      )
      if (content?.ok !== true) {
        console.log(`[smoke] FAIL content     ${redactor.text(content?.error ?? 'no answer')}`)
        process.exitCode = 1
      } else {
        console.log(
          `[smoke] content     ${content.content.text.length} chars, truncated=${content.content.truncated}`,
        )
      }
    }
  }

  // The v0.3 explanation: the same context request the memory plugin makes,
  // with the server's own accounting.
  const explain = await get(
    `${base}/api/openviking-enhance/recall/explain?sessionId=${encodeURIComponent(sessionId)}` +
      `&query=${encodeURIComponent('what is this project about')}&source=turn`,
  )
  if (explain?.ok !== true) {
    console.log(`[smoke] FAIL explain     ${redactor.text(explain?.error ?? 'no answer')}`)
    process.exitCode = 1
  } else {
    const explanation = explain.explanation
    const stats = explanation.stats
    console.log(
      `[smoke] explain     ${explanation.mode} · ${explanation.entries.length} entries · ` +
        `${stats ? `${stats.usedTokens ?? '?'}/${stats.maxTokens ?? '?'} tokens · deduped ${stats.deduped ?? '?'}` : 'no stats'} · ` +
        `${explanation.latencyMs} ms`,
    )
    const explainOk =
      explanation.replay === true &&
      explanation.query.source === 'turn' &&
      Array.isArray(explanation.entries) &&
      (explanation.mode === 'context' ? stats !== null : stats === null)
    console.log(`[smoke] explain     ${explainOk ? 'ok  ' : 'FAIL'} replay/query/mode/entries shape`)
    if (!explainOk) process.exitCode = 1
    if (explanation.mode === 'context') {
      const budgetOk = stats.maxTokens !== null && stats.returned !== null
      console.log(`[smoke] explain     ${budgetOk ? 'ok  ' : 'FAIL'} context accounting present`)
      if (!budgetOk) process.exitCode = 1
    }
  }

  // The session log: one state out of the documented set, plus the local queue
  // view that the Dashboard cannot get from the server alone.
  const logAnswer = await get(
    `${base}/api/openviking-enhance/session-log?sessionId=${encodeURIComponent(sessionId)}`,
  )
  if (logAnswer?.ok !== true) {
    console.log(`[smoke] FAIL log         ${redactor.text(logAnswer?.error ?? 'no answer')}`)
    process.exitCode = 1
  } else {
    const log = logAnswer.log
    const states = ['no-messages', 'not-committed', 'extracting', 'failed', 'queued', 'committed', 'unknown']
    const logOk =
      states.includes(log.state) &&
      typeof log.pending?.available === 'boolean' &&
      Array.isArray(log.events) &&
      Array.isArray(log.tasks)
    console.log(
      `[smoke] log         ${logOk ? 'ok  ' : 'FAIL'} state=${log.state} tasks=${log.tasks.length} ` +
        `events=${log.events.length} queue=${log.pending.total}`,
    )
    if (!logOk) process.exitCode = 1
  }

  // The Doctor: connection, plugin, capabilities and checks. The secret must
  // never appear in the payload.
  const doctorAnswer = await get(
    `${base}/api/openviking-enhance/doctor?sessionId=${encodeURIComponent(sessionId)}&probe=1`,
  )
  if (doctorAnswer?.ok !== true) {
    console.log(`[smoke] FAIL doctor      ${redactor.text(doctorAnswer?.error ?? 'no answer')}`)
    process.exitCode = 1
  } else {
    const report = doctorAnswer.report
    const doctorOk =
      typeof report.endpoint === 'string' &&
      typeof report.health?.healthy === 'boolean' &&
      Array.isArray(report.checks) &&
      report.checks.length >= 10 &&
      ['available', 'unavailable', 'legacy', 'unknown', 'skipped'].includes(report.capabilities?.contextFace?.state)
    console.log(
      `[smoke] doctor      ${doctorOk ? 'ok  ' : 'FAIL'} ${report.checks.filter((c) => c.status === 'ok').length} ok / ` +
        `${report.checks.filter((c) => c.status === 'warn').length} warn · ` +
        `context=${report.capabilities?.contextFace?.state} rules=${report.capabilities?.ruleSearch?.state}`,
    )
    if (!doctorOk) process.exitCode = 1
    const apiKeyOrigin = (report.connection?.origins ?? []).find((origin) => origin.field === 'apiKey')
    const leaked =
      JSON.stringify(report).includes('"apiKey":') ||
      JSON.stringify(report).includes('"api_key"') ||
      JSON.stringify(report).includes('Authorization:')
    // Read the key from the same resolved config the host under test received,
    // not from a second resolution path.
    const configuredKey = resolved.apiKey?.get?.() ?? ''
    // A one-character key (or the dev placeholder) occurs in unrelated strings;
    // only a key long enough to be meaningful makes the exact-value assertion
    // evidence rather than noise.
    const exactCheckable = configuredKey.length >= 8
    const actualLeak = exactCheckable && JSON.stringify(doctorAnswer).includes(configuredKey)
    const originOk = apiKeyOrigin !== undefined && typeof apiKeyOrigin.configured === 'boolean' && !('value' in apiKeyOrigin)
    console.log(
      `[smoke] doctor      ${!leaked && !actualLeak && originOk ? 'ok  ' : 'FAIL'} API key stays out of the diagnostics ` +
        `(origin only${exactCheckable ? ', exact value absent' : '; configured key too short to search'})`,
    )
    if (leaked || actualLeak || !originOk) process.exitCode = 1
  }

  // ---- v0.4 read-only surfaces ----------------------------------------
  // The preview on a real recall hit: stat + three tiers + a Studio URL.
  const firstHit = recall?.recall?.buckets?.flatMap((bucket) => bucket.items)[0]
  if (firstHit) {
    const preview = await get(`${base}/api/openviking-enhance/preview?uri=${encodeURIComponent(firstHit.uri)}`)
    const payload = preview?.preview
    const previewOk =
      preview?.ok === true &&
      Array.isArray(payload?.tiers) &&
      payload.tiers.length === 3 &&
      typeof payload.studioUrl === 'string' &&
      firstHit.uri.startsWith('viking://')
    const tiers = (payload?.tiers ?? []).map((tier) => `${tier.id}:${tier.available ? (tier.placeholder ? 'placeholder' : tier.text.length) : 'unavailable'}`)
    console.log(`[smoke] preview     ${previewOk ? 'ok  ' : 'FAIL'} ${payload?.stat?.isDir === true ? 'dir' : 'file'} · ${tiers.join(' ')}`)
    if (!previewOk) process.exitCode = 1
  }

  // Unified search (S2): the DEFAULT is the three cheap buckets — rules are an
  // explicit opt-in because `rules/search` can spend a server-side judge call.
  const search = await postJson(`${base}/api/openviking-enhance/search`, {
    query: 'OpenViking plugin',
    limit: 3,
  })
  const searchBuckets = search?.search?.buckets
  const searchOk =
    search?.ok === true &&
    Array.isArray(searchBuckets) &&
    searchBuckets.map((bucket) => bucket.bucket).join(',') === 'memories,resources,skills'
  console.log(
    `[smoke] search      ${searchOk ? 'ok  ' : 'FAIL'} ${
      searchOk ? searchBuckets.map((bucket) => `${bucket.bucket}:${bucket.items.length}`).join(' ') : redactor.text(search?.error ?? 'no answer')
    }`,
  )
  if (!searchOk) process.exitCode = 1
  const searchWithRules = await postJson(`${base}/api/openviking-enhance/search`, {
    query: 'OpenViking plugin',
    limit: 3,
    buckets: ['memories', 'resources', 'skills', 'rules'],
  })
  const rulesBucket = (searchWithRules?.search?.buckets ?? []).find((bucket) => bucket.bucket === 'rules')
  const optInOk = searchWithRules?.ok === true && rulesBucket !== undefined
  console.log(
    `[smoke] search opt-in ${optInOk ? 'ok  ' : 'FAIL'} ${
      optInOk ? `rules bucket requested explicitly (${rulesBucket.items.length} hit(s))` : redactor.text(searchWithRules?.error ?? 'no answer')
    }`,
  )
  if (!optInOk) process.exitCode = 1
  if (!(search?.search?.warnings ?? []).some((warning) => warning.code === 'keywordsUnavailable')) {
    console.log('[smoke] search      ok   semantic path (no keyword fallback needed)')
  }

  // Rules: 0.5.3 answers the list (empty is normal); an older server answers
  // `unsupported`, which is a documented degradation rather than a failure.
  const rules = await get(`${base}/api/openviking-enhance/rules`)
  const rulesOk =
    rules?.ok === true
      ? Array.isArray(rules.list?.rules) && typeof rules.list.empty === 'boolean'
      : rules?.error === 'unsupported'
  console.log(
    `[smoke] rules       ${rulesOk ? 'ok  ' : 'FAIL'} ${
      rules?.ok === true
        ? `${rules.list.rules.length} rule(s), ${rules.list.scenarios.length} scenario(s), empty=${rules.list.empty}, partial=${rules.list.partial}`
        : redactor.text(rules?.error ?? 'no answer')
    }`,
  )
  if (!rulesOk) process.exitCode = 1
  const ruleSearch = await postJson(`${base}/api/openviking-enhance/rules/search`, {
    taskContext: 'Implement a preview tab in a DSH plugin and run the test suite.',
  })
  const ruleSearchOk =
    (ruleSearch?.ok === true && Array.isArray(ruleSearch.rules?.matches)) || ruleSearch?.error === 'unsupported'
  console.log(
    `[smoke] rule tester ${ruleSearchOk ? 'ok  ' : 'FAIL'} ${
      ruleSearch?.ok === true
        ? `${ruleSearch.rules.matches.length} match(es), complete=${ruleSearch.rules.complete}`
        : redactor.text(ruleSearch?.error ?? 'no answer')
    }`,
  )
  if (!ruleSearchOk) process.exitCode = 1

  // Skills catalogue and Experience discovery (both empty states are normal).
  const skills = await get(`${base}/api/openviking-enhance/skills`)
  const skillsOk =
    (skills?.ok === true && Array.isArray(skills.catalogue?.skills)) || skills?.error === 'unsupported'
  console.log(
    `[smoke] skills      ${skillsOk ? 'ok  ' : 'FAIL'} ${
      skills?.ok === true ? `${skills.catalogue.skills.length} skill(s)` : redactor.text(skills?.error ?? 'no answer')
    }`,
  )
  if (!skillsOk) process.exitCode = 1
  const experience = await get(`${base}/api/openviking-enhance/experience?kind=trajectories`)
  const experienceOk =
    (experience?.ok === true && Array.isArray(experience.experience?.experiences)) ||
    experience?.error === 'unsupported'
  console.log(
    `[smoke] experience  ${experienceOk ? 'ok  ' : 'FAIL'} ${
      experience?.ok === true
        ? `${experience.experience.experiences.length} experience(s)${experience.experience.note ? ` (${experience.experience.note})` : ''}`
        : redactor.text(experience?.error ?? 'no answer')
    }`,
  )
  if (!experienceOk) process.exitCode = 1

  const archive = commits?.status?.archives?.at(-1)
  if (!archive) {
    console.log('[smoke] diff        (no archive for this session yet)')
    return
  }
  const diff = await get(
    `${base}/api/openviking-enhance/diff?sessionId=${encodeURIComponent(sessionId)}&archive=${encodeURIComponent(archive.archiveUri)}`,
  )
  console.log('[smoke] diff        ', redactor.summarise(diff))
  if (diff?.diff) {
    console.log(
      `[smoke] affected    adds=${diff.diff.summary.totalAdds} updates=${diff.diff.summary.totalUpdates} deletes=${diff.diff.summary.totalDeletes}`,
    )
    for (const entry of [...diff.diff.adds, ...diff.diff.updates].slice(0, 5)) {
      console.log(`[smoke]   ${entry.memoryType.padEnd(12)} ${redactor.uri(entry.uri)}`)
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
