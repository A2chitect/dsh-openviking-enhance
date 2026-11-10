// v0.6 review follow-ups: the Rules listing budget (S1) and the rule-search
// cost policy (S2), plus the bounded worker pool they are built on.
//
// The server here is a stub HTTP server, not a mock object: these tests pin the
// wire behaviour (which requests are made, how many at once, what stops) rather
// than a particular method shape. No test writes anything, and no test talks to
// a real OpenViking.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { OpenVikingApi } from '../src/host/openviking-api.ts'
import {
  CatalogService,
  RULES_MAX_RULES,
  RULES_MAX_SCENARIOS,
  classifyRuleProbe,
} from '../src/host/catalog-service.ts'
import { CapabilityService, scopeCapabilities } from '../src/host/capability.ts'
import { SearchService, normalizeSearchBuckets } from '../src/host/search-service.ts'
import { PreviewService, clampPageLines } from '../src/host/preview-service.ts'
import { mapPool } from '../src/host/async-pool.ts'
import { PREVIEW_MAX_CHARS } from '../src/shared/protocol.ts'
import {
  PREVIEW_BODY_MAX_LINES,
  PREVIEW_BODY_MAX_LINES_RESPONSE,
  RULE_LIST_CONCURRENCY,
  RULE_LIST_DEADLINE_MS,
} from '../src/shared/limits.ts'

const RULE_MARKDOWN = [
  '---',
  'schema: openviking.rule/v1',
  'atomic_id: project-license',
  'revision: 2',
  'status: active',
  'scenario_id: repository-license',
  'name: Project license',
  'description: Every open-source repo needs a license.',
  'content: When a repository declares itself open source, it must provide a complete license text.',
  '---',
  '',
  '# Project license',
  '',
  'Add a LICENSE file.',
].join('\n')

const RULES_ROOT = 'viking://~/memories/rules'
const abstractOf = (scenario) => `${scenario}/abstract.md`

/**
 * A stub OpenViking that records every request and answers from a route table.
 *
 * `routes` maps a matcher (path prefix or function) to a handler returning
 * `{status, body}`; the handler receives `(url, body, context)` where `context`
 * carries live concurrency counters so a test can prove a pool bound.
 */
async function withStub(routes, body) {
  const calls = []
  const timers = new Set()
  let inFlight = 0
  let maxInFlight = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = raw.length > 0 ? JSON.parse(raw) : undefined
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const call = { method: req.method ?? 'GET', path: url.pathname, params: url.searchParams, body: parsed }
      calls.push(call)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const finish = (status, payload, delayMs = 0) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          inFlight -= 1
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload))
        }, delayMs)
        timers.add(timer)
      }
      const context = {
        inFlight,
        maxInFlight,
        call,
        finish,
        json: (payload, delayMs = 0) => finish(200, payload, delayMs),
      }
      for (const route of routes) {
        const matches =
          typeof route.match === 'function'
            ? route.match(url, req.method)
            : url.pathname === route.match && (route.method === undefined || route.method === req.method)
        if (matches) {
          route.handler(url, parsed, context)
          return
        }
      }
      finish(404, { status: 'error', error: { code: 'NOT_FOUND', message: 'no route' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await body({ base, calls, stats: () => ({ maxInFlight, inFlight }) })
  } finally {
    for (const timer of timers) clearTimeout(timer)
    server.close()
  }
}

/** One rule-directory response: a root listing, scenario listings, rule text. */
function ruleRoutes({
  scenarios,
  filesPerScenario = 1,
  delayMs = 0,
  ruleMarkdown = RULE_MARKDOWN,
} = {}) {
  const scenarioIds = scenarios ?? ['repository-license']
  return [
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (_url, _body, context) => context.finish(422, { detail: [{ loc: ['body'], msg: 'field required' }] }, delayMs),
    },
    {
      match: (url) => url.pathname === '/api/v1/fs/ls' && url.searchParams.get('uri') === RULES_ROOT,
      handler: (_url, _body, context) => {
        const entries = scenarioIds.map((id) => ({ uri: `${RULES_ROOT}/${id}`, isDir: true }))
        context.json({ status: 'ok', result: entries }, delayMs)
      },
    },
    {
      match: (url) => url.pathname === '/api/v1/fs/ls' && url.searchParams.get('uri')?.startsWith(`${RULES_ROOT}/`),
      handler: (url, _body, context) => {
        const scenario = url.searchParams.get('uri')
        const files = Array.from({ length: filesPerScenario }, (_, index) => ({
          uri: `${scenario}/${index === 0 ? 'project-license' : `rule-${index}`}.md`,
          isDir: false,
        }))
        context.json({ status: 'ok', result: files }, delayMs)
      },
    },
    {
      match: (url) => url.pathname === '/api/v1/content/read' && url.searchParams.get('uri')?.endsWith('/abstract.md'),
      handler: (url, _body, context) => {
        const scenario = url.searchParams.get('uri').replace(/\/abstract\.md$/, '').split('/').pop()
        context.json(
          {
            status: 'ok',
            result: `---\nscenario_id: ${scenario}\nname: Scenario ${scenario}\n---\n`,
          },
          delayMs,
        )
      },
    },
    {
      match: (url) => url.pathname === '/api/v1/content/read',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: ruleMarkdown }, delayMs),
    },
  ]
}

/* ========================================================================
 * S1: the bounded pool
 * ===================================================================== */

test('the pool bounds in-flight work, keeps order and reports the started count', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const outcome = await mapPool(
    Array.from({ length: 12 }, (_, index) => index),
    3,
    async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return item * 2
    },
  )
  assert.equal(maxInFlight, 3)
  assert.equal(outcome.started, 12)
  assert.deepEqual(outcome.results, Array.from({ length: 12 }, (_, index) => index * 2))
  assert.equal(outcome.deadlineHit, false)
})

test('the pool stops scheduling at the deadline but keeps what finished', async () => {
  const started = []
  const outcome = await mapPool(
    Array.from({ length: 20 }, (_, index) => index),
    2,
    async (item) => {
      started.push(item)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return item
    },
    { deadline: Date.now() + 40 },
  )
  assert.equal(outcome.deadlineHit, true)
  assert.ok(outcome.started < 20, `expected the deadline to stop the map, started ${outcome.started}`)
  assert.equal(outcome.results.filter((value) => value !== undefined).length, outcome.started)
  assert.ok(started.length >= 2)
})

test('the pool reports an abort and starts nothing after it', async () => {
  const controller = new AbortController()
  controller.abort()
  const outcome = await mapPool([1, 2, 3], 2, async (item) => item, { signal: controller.signal })
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.started, 0)
  assert.deepEqual(outcome.results, [undefined, undefined, undefined])
})

/* ========================================================================
 * S1: the rules listing budget
 * ===================================================================== */

async function withCatalog(routes, options, body) {
  return withStub(routes, async ({ base, calls, stats }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const catalog = new CatalogService({ api, ...options })
    return body({ catalog, calls, stats })
  })
}

test('a healthy rules listing is complete and marks no truncation', async () => {
  await withCatalog(ruleRoutes({ scenarios: ['repo-license', 'style'] }), {}, async ({ catalog }) => {
    const list = await catalog.listRules({ rulesAvailable: true })
    assert.equal(list.empty, false)
    assert.equal(list.partial, false)
    assert.equal(list.limitedBy, null)
    assert.equal(list.rules.length, 2)
    assert.deepEqual(list.scenarios.map((scenario) => scenario.id), ['repo-license', 'style'])
    assert.equal(list.progress.deadlineMs, RULE_LIST_DEADLINE_MS)
    assert.equal(list.progress.ruleCap, RULES_MAX_RULES)
    assert.deepEqual(list.warnings, [])
  })
})

test('opening the list with a cached capability answer makes zero rules/search calls', async () => {
  await withCatalog(ruleRoutes({ scenarios: ['repo-license'] }), {}, async ({ catalog, calls }) => {
    await catalog.listRules({ rulesAvailable: true })
    assert.equal(
      calls.filter((call) => call.path === '/api/v1/rules/search').length,
      0,
      'a cached capability answer must not spend a search',
    )
  })
})

test('a cached "route absent" answer refuses the list before any fs request', async () => {
  await withCatalog(ruleRoutes(), {}, async ({ catalog, calls }) => {
    await assert.rejects(() => catalog.listRules({ rulesAvailable: false }), /unsupported/)
    assert.equal(calls.length, 0, 'nothing is read once the route is known absent')
  })
})

test('the fallback capability probe sends the validation-only empty body, never a task context', async () => {
  await withCatalog(ruleRoutes({ scenarios: ['repo-license'] }), {}, async ({ catalog, calls }) => {
    const list = await catalog.listRules()
    assert.equal(list.rules.length, 1)
    const probes = calls.filter((call) => call.path === '/api/v1/rules/search')
    assert.equal(probes.length, 1, 'exactly one cheap probe when the caller has no cached answer')
    assert.deepEqual(probes[0].body, {}, 'the empty body is what keeps the probe validation-only')
  })
})

test('scenario and rule reads stay inside the concurrency bound', async () => {
  const scenarios = Array.from({ length: 8 }, (_, index) => `scenario-${index}`)
  await withCatalog(
    ruleRoutes({ scenarios, filesPerScenario: 3, delayMs: 20 }),
    { ruleListConcurrency: 4 },
    async ({ catalog, stats }) => {
      const list = await catalog.listRules({ rulesAvailable: true })
      assert.equal(list.rules.length, 24)
      assert.ok(stats().maxInFlight <= 4, `expected at most 4 in flight, saw ${stats().maxInFlight}`)
      assert.ok(stats().maxInFlight > 1, 'the pool actually fans out')
    },
  )
})

test('the total deadline keeps the rows that arrived and says why the list is partial', async () => {
  const scenarios = Array.from({ length: 8 }, (_, index) => `scenario-${index}`)
  await withCatalog(
    ruleRoutes({ scenarios, filesPerScenario: 2, delayMs: 60 }),
    { ruleListDeadlineMs: 90, ruleListConcurrency: 2 },
    async ({ catalog }) => {
      const started = Date.now()
      const list = await catalog.listRules({ rulesAvailable: true })
      const elapsed = Date.now() - started
      assert.equal(list.partial, true, 'the listing stopped short')
      assert.equal(list.limitedBy, 'deadline')
      assert.equal(list.progress.deadlineMs, 90)
      assert.ok(elapsed < 1000, `the listing must answer close to the deadline, took ${elapsed} ms`)
      assert.ok(
        list.warnings.some((warning) => warning.code === 'ruleListTruncated'),
        'the partial notice is present',
      )
      const notice = list.warnings.find((warning) => warning.code === 'ruleListTruncated')
      assert.equal(notice.params.deadlineMs, 90)
    },
  )
})

test('a slow root read aborts the listing cleanly instead of hanging the section', async () => {
  const routes = ruleRoutes({ scenarios: ['repo-license'] })
  // Slow the root listing far past the total deadline.
  routes[1] = {
    ...routes[1],
    handler: (url, _body, context) => {
      const entries = [{ uri: `${RULES_ROOT}/repo-license`, isDir: true }]
      context.json({ status: 'ok', result: entries }, 200)
    },
  }
  await withCatalog(routes, { ruleListDeadlineMs: 40 }, async ({ catalog }) => {
    const list = await catalog.listRules({ rulesAvailable: true })
    assert.equal(list.partial, true)
    assert.equal(list.limitedBy, 'deadline')
    assert.deepEqual(list.rules, [], 'no rule read was started after the deadline')
    assert.ok(list.warnings.some((warning) => warning.code === 'ruleListTruncated'))
  })
})

test('the scenario cap is reported instead of silently hiding folders', async () => {
  const scenarios = Array.from({ length: RULES_MAX_SCENARIOS + 5 }, (_, index) => `scenario-${index}`)
  await withCatalog(ruleRoutes({ scenarios }), {}, async ({ catalog }) => {
    const list = await catalog.listRules({ rulesAvailable: true })
    assert.equal(list.scenarios.length, RULES_MAX_SCENARIOS)
    assert.equal(list.partial, true)
    assert.equal(list.limitedBy, 'scenario-cap')
    assert.equal(list.progress.scenarioCap, RULES_MAX_SCENARIOS)
  })
})

test('the rule cap is reported instead of silently truncating at 100', async () => {
  await withCatalog(
    ruleRoutes({ scenarios: ['one'], filesPerScenario: RULES_MAX_RULES + 10 }),
    {},
    async ({ catalog }) => {
      const list = await catalog.listRules({ rulesAvailable: true })
      assert.equal(list.rules.length, RULES_MAX_RULES)
      assert.equal(list.partial, true)
      assert.equal(list.limitedBy, 'rule-cap')
      assert.equal(list.progress.ruleCap, RULES_MAX_RULES)
    },
  )
})

/* ========================================================================
 * S2: the capability probe classification and the search defaults
 * ===================================================================== */

const reply = (status, error = null, errorCode = null, ok = false) => ({ ok, status, result: null, error, errorCode })

test('the rule probe classifies validation, absence and unknown answers', () => {
  assert.deepEqual(classifyRuleProbe(reply(422, 'body invalid')), {
    available: true,
    detail: 'validation',
    kind: 'available',
  })
  assert.equal(classifyRuleProbe(reply(400, 'missing field')).available, true, '400 is also body validation')
  assert.deepEqual(classifyRuleProbe(reply(404, 'Not Found')), {
    available: false,
    detail: 'unsupported',
    kind: 'route-absent',
  })
  // A 404 carrying the server's own code is a missing resource, not a missing route.
  assert.equal(classifyRuleProbe(reply(404, 'not found', 'NOT_FOUND')).available, true)
  assert.equal(classifyRuleProbe(reply(405, 'method not allowed')).kind, 'method-mismatch')
  assert.equal(classifyRuleProbe(reply(403, 'forbidden')).kind, 'denied')
  assert.equal(classifyRuleProbe(reply(0, 'fetch failed')).kind, 'unknown')
  assert.equal(classifyRuleProbe(reply(500, 'backend exploded')).kind, 'unknown')
})

test('the capability service probes rules once and then serves the cache', async () => {
  let ruleProbes = 0
  const routes = [
    {
      match: (url) => url.pathname === '/health',
      handler: (_url, _body, context) =>
        context.json({ status: 'ok', result: { version: '0.5.3', auth_mode: 'dev' } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/snapshot/log',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { commits: [] } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/tasks',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { tasks: [] } }),
    },
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (_url, _body, context) => {
        ruleProbes += 1
        context.finish(422, { detail: [{ msg: 'field required' }] })
      },
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const capability = new CapabilityService({ api, transport: () => false, now: () => Date.now() })
    const first = await capability.rules()
    assert.equal(first.available, true)
    assert.equal(first.kind, 'available')
    const second = await capability.rules()
    assert.deepEqual(second, first)
    assert.equal(ruleProbes, 1, 'the 10-minute cache must keep opening the section free')
    const scope = scopeCapabilities(await capability.probe(), false, false)
    assert.equal(scope.rules.available, true)
    assert.equal(ruleProbes, 1, 'the scope probe reuses the cached rules answer')
  })
})

test('the default Explore search excludes rules and an explicit request includes them', async () => {
  const calls = []
  const routes = [
    {
      match: (url, method) => url.pathname === '/api/v1/search/search' && method === 'POST',
      handler: (url, body, context) => {
        calls.push(['search', body.context_type])
        context.json({ status: 'ok', result: { memories: [], resources: [], skills: [], total: 0 } })
      },
    },
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (url, body, context) => {
        calls.push(['rules', body.task_context])
        context.json({ status: 'ok', result: { rules: [], delivery: { complete: true } } })
      },
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const service = new SearchService({ api })
    assert.deepEqual(normalizeSearchBuckets(undefined), ['memories', 'resources', 'skills'])
    await service.search({ query: 'license' })
    assert.deepEqual(calls, [['search', ['memory', 'resource', 'skill']]], 'default search costs no rule call')

    calls.length = 0
    const explicit = await service.search({
      query: 'license',
      buckets: ['memories', 'resources', 'skills', 'rules'],
    })
    assert.deepEqual(calls[0], ['search', ['memory', 'resource', 'skill']])
    assert.deepEqual(calls[1], ['rules', 'license'], 'the opt-in sends the query as the task context')
    assert.deepEqual(explicit.buckets.map((bucket) => bucket.bucket), ['memories', 'resources', 'skills', 'rules'])
  })
})

/* ========================================================================
 * Optional review note: preview L2 paging instead of whole-file fetch
 * ===================================================================== */

/** A 900-line fictional file served a page at a time, as `content/read` does. */
function previewRoutes() {
  const lines = Array.from({ length: 900 }, (_, index) => `line ${index + 1}`)
  const reads = []
  return {
    reads,
    routes: [
      {
        match: (url) => url.pathname === '/api/v1/fs/stat',
        handler: (_url, _body, context) => context.json({ status: 'ok', result: { name: 'notes.md', uri: 'viking://fixture/notes.md', size: 900, isDir: false } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/fs/attrs',
        handler: (_url, _body, context) => context.json({ status: 'ok', result: { uri: 'viking://fixture/notes.md', context_type: 'memory', attrs: { tags: [] } } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/content/abstract',
        handler: (_url, _body, context) => context.json({ status: 'ok', result: 'fixture abstract' }),
      },
      {
        match: (url) => url.pathname === '/api/v1/content/overview',
        handler: (_url, _body, context) => context.json({ status: 'ok', result: 'fixture overview' }),
      },
      {
        match: (url) => url.pathname === '/api/v1/content/read',
        handler: (url, _body, context) => {
          const offset = Number(url.searchParams.get('offset') ?? 0)
          const limit = Number(url.searchParams.get('limit') ?? -1)
          reads.push({ offset, limit })
          const page = limit < 0 ? lines.slice(offset) : lines.slice(offset, offset + limit)
          context.json({ status: 'ok', result: page.join('\n') })
        },
      },
    ],
  }
}

test('the preview asks for one bounded L2 page, not the whole file', async () => {
  const { routes, reads } = previewRoutes()
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
    const preview = await service.preview('viking://fixture/notes.md')
    assert.deepEqual(reads, [{ offset: 0, limit: PREVIEW_BODY_MAX_LINES }], 'the first read is line-bounded')
    const l2 = preview.tiers.find((tier) => tier.id === 'l2')
    assert.equal(l2.available, true)
    assert.equal(l2.offset, 0)
    assert.equal(l2.text.split('\n').length, PREVIEW_BODY_MAX_LINES)
    assert.equal(l2.nextOffset, PREVIEW_BODY_MAX_LINES, 'a full page advertises the next offset')
    assert.equal(l2.truncated, false, 'display truncation is separate from paging')

    const second = await service.preview('viking://fixture/notes.md', { offset: l2.nextOffset })
    const page2 = second.tiers.find((tier) => tier.id === 'l2')
    assert.deepEqual(reads[1], { offset: PREVIEW_BODY_MAX_LINES, limit: PREVIEW_BODY_MAX_LINES })
    assert.equal(page2.offset, PREVIEW_BODY_MAX_LINES)
    assert.equal(page2.nextOffset, PREVIEW_BODY_MAX_LINES * 2)
    assert.equal(page2.text.split('\n')[0], `line ${PREVIEW_BODY_MAX_LINES + 1}`)
  })
})

test('the last page has no next offset, so "Show more" disappears', async () => {
  const { routes } = previewRoutes()
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
    const preview = await service.preview('viking://fixture/notes.md', { offset: PREVIEW_BODY_MAX_LINES * 2 })
    const l2 = preview.tiers.find((tier) => tier.id === 'l2')
    assert.equal(l2.text.split('\n').length, 100, '900 lines minus two full pages')
    assert.equal(l2.nextOffset, null)
  })
})

test('a page clipped by the display cap stops paging', async () => {
  const { routes } = previewRoutes()
  routes[4] = {
    match: (url) => url.pathname === '/api/v1/content/read',
    handler: (_url, _body, context) =>
      context.json({ status: 'ok', result: 'z'.repeat(PREVIEW_MAX_CHARS + 100) }),
  }
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
    const preview = await service.preview('viking://fixture/notes.md')
    const l2 = preview.tiers.find((tier) => tier.id === 'l2')
    assert.equal(l2.text.length, PREVIEW_MAX_CHARS)
    assert.equal(l2.truncated, true)
    assert.equal(l2.nextOffset, null, 'a clipped page cannot advertise a next line offset')
  })
})

test('the page line bound is clamped to the documented response cap', () => {
  assert.equal(clampPageLines(undefined), PREVIEW_BODY_MAX_LINES)
  assert.equal(clampPageLines(0), 1)
  assert.equal(clampPageLines(5000), PREVIEW_BODY_MAX_LINES_RESPONSE)
  assert.equal(clampPageLines(Number.NaN), PREVIEW_BODY_MAX_LINES)
})

/* ========================================================================
 * Optional review notes: per-item throw isolation, deterministic warnings,
 * capability generation counter.
 * ===================================================================== */

test('the pool isolates a worker that throws instead of failing the whole map', async () => {
  const outcome = await mapPool([1, 2, 3, 4], 2, async (item) => {
    if (item === 2) throw new Error('boom')
    return item * 10
  })
  assert.equal(outcome.failures, 1)
  assert.equal(outcome.started, 4)
  assert.deepEqual(outcome.results, [10, undefined, 30, 40])
  assert.match(String(outcome.errors[1]), /boom/)
  assert.equal(outcome.errors[0], undefined)
})

/** A rules fake where one scenario listing and one rule read throw synchronously. */
function throwingRulesApi() {
  const root = RULES_ROOT
  return {
    probeRuleSearchRoute: async () => ({ ok: false, status: 422, result: null, error: 'validation', errorCode: null }),
    listDirectory: async (uri) => {
      if (uri === root) {
        return {
          ok: true,
          status: 200,
          result: [
            { uri: `${root}/scenario-a`, isDir: true },
            { uri: `${root}/scenario-b`, isDir: true },
          ],
        }
      }
      if (uri === `${root}/scenario-a`) throw new Error('listing exploded')
      return { ok: true, status: 200, result: [{ uri: `${root}/scenario-b/good.md`, isDir: false }] }
    },
    readText: async (uri) => {
      if (uri.endsWith('/abstract.md')) return { ok: true, status: 200, result: '---\nname: B\n---\n' }
      if (uri.endsWith('good.md')) return { ok: true, status: 200, result: RULE_MARKDOWN }
      throw new Error('rule exploded')
    },
  }
}

test('a throwing catalogue read becomes a warning, not a failed section', async () => {
  const api = throwingRulesApi()
  api.listDirectory = async (uri) => {
    if (uri === RULES_ROOT) {
      return {
        ok: true,
        status: 200,
        result: [
          { uri: `${RULES_ROOT}/scenario-a`, isDir: true },
          { uri: `${RULES_ROOT}/scenario-b`, isDir: true },
        ],
      }
    }
    if (uri === `${RULES_ROOT}/scenario-a`) throw new Error('listing exploded')
    return {
      ok: true,
      status: 200,
      result: [
        { uri: `${RULES_ROOT}/scenario-b/good.md`, isDir: false },
        { uri: `${RULES_ROOT}/scenario-b/bad.md`, isDir: false },
      ],
    }
  }
  api.readText = async (uri) => {
    if (uri.endsWith('/abstract.md')) return { ok: true, status: 200, result: '---\nname: B\n---\n' }
    if (uri.endsWith('good.md')) return { ok: true, status: 200, result: RULE_MARKDOWN }
    throw new Error('rule exploded')
  }
  const catalog = new CatalogService({ api })
  const list = await catalog.listRules()
  assert.equal(list.partial, false)
  assert.equal(list.rules.length, 1, 'the readable rule still lists')
  const codes = list.warnings.map((warning) => warning.code)
  assert.ok(codes.includes('ruleScenarioFailed'), `scenario throw became a warning: ${codes.join(', ')}`)
  assert.ok(codes.includes('ruleReadFailed'), `rule throw became a warning: ${codes.join(', ')}`)
})

test('warning order follows the input order even when completions race', async () => {
  const scenarios = ['slow', 'fast', 'medium']
  const delays = { slow: 60, fast: 5, medium: 30 }
  const routes = [
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (_url, _body, context) => context.finish(422, { detail: [] }),
    },
    {
      match: (url) => url.pathname === '/api/v1/fs/ls' && url.searchParams.get('uri') === RULES_ROOT,
      handler: (_url, _body, context) =>
        context.json({
          status: 'ok',
          result: scenarios.map((id) => ({ uri: `${RULES_ROOT}/${id}`, isDir: true })),
        }),
    },
    {
      match: (url) => url.pathname === '/api/v1/fs/ls' && url.searchParams.get('uri')?.startsWith(`${RULES_ROOT}/`),
      handler: (url, _body, context) => {
        const id = url.searchParams.get('uri').split('/').pop()
        // Non-2xx on purpose: a 200 with an error envelope is a *successful*
        // listing as far as the HTTP client is concerned, which made the old
        // version of this test assert on two empty warning lists.
        if (id !== 'fast') {
          context.finish(
            500,
            { status: 'error', error: { code: 'INTERNAL_ERROR', message: `cannot list ${id}` } },
            delays[id],
          )
          return
        }
        context.json({ status: 'ok', result: [{ uri: `${RULES_ROOT}/${id}/good.md`, isDir: false }] }, delays[id])
      },
    },
    {
      match: (url) => url.pathname === '/api/v1/content/read',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: RULE_MARKDOWN }, 5),
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const catalog = new CatalogService({ api })
    const list = await catalog.listRules({ rulesAvailable: true })
    // Input order is slow, fast, medium; completion order is fast (5 ms),
    // medium (30 ms), slow (60 ms). Warnings must follow the INPUT order.
    assert.deepEqual(
      list.warnings.map((warning) => warning.code),
      ['ruleListFailed', 'ruleListFailed'],
      `exactly the two failed listings warn: ${JSON.stringify(list.warnings)}`,
    )
    assert.deepEqual(
      list.warnings.map((warning) => warning.params.uri),
      [`${RULES_ROOT}/slow`, `${RULES_ROOT}/medium`],
      'warning URIs follow the scenario input order, not completion order',
    )
    assert.equal(list.scenarios.length, 1, 'only the readable scenario is listed')
    assert.equal(list.scenarios[0].name, 'Project license', 'the readable scenario metadata still resolves')
    assert.equal(list.rules.length, 1, 'the readable scenario still contributes its rule')
  })
})

test('a caller after invalidate() gets a fresh probe, not the previous identity in flight', async () => {
  let ruleProbes = 0
  const routes = [
    {
      match: (url) => url.pathname === '/health',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { version: '0.5.3', auth_mode: 'dev' } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/snapshot/log',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: {} }),
    },
    {
      match: (url) => url.pathname === '/api/v1/tasks',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { items: [] } }),
    },
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (_url, _body, context) => {
        ruleProbes += 1
        context.finish(422, { detail: [] }, 60)
      },
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const capability = new CapabilityService({ api, transport: () => false })
    const previousIdentity = capability.rules()
    capability.invalidate()
    // The in-flight handle was dropped, so this call starts a current probe
    // instead of awaiting the previous identity's answer.
    const currentIdentity = capability.rules()
    await Promise.all([previousIdentity, currentIdentity])
    assert.equal(ruleProbes, 2, 'the new caller triggered a second probe')
    // The current probe populates the cache; a later read is free again.
    await capability.rules()
    assert.equal(ruleProbes, 2, 'the current probe is cached')
  })
})

test('an identity invalidation during a rules probe is not cached for the next identity', async () => {
  let ruleProbes = 0
  const routes = [
    {
      match: (url) => url.pathname === '/health',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { version: '0.5.3', auth_mode: 'dev' } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/snapshot/log',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: {} }),
    },
    {
      match: (url) => url.pathname === '/api/v1/tasks',
      handler: (_url, _body, context) => context.json({ status: 'ok', result: { items: [] } }),
    },
    {
      match: (url, method) => url.pathname === '/api/v1/rules/search' && method === 'POST',
      handler: (_url, _body, context) => {
        ruleProbes += 1
        context.finish(422, { detail: [] }, 80)
      },
    },
  ]
  await withStub(routes, async ({ base }) => {
    const api = new OpenVikingApi({ endpoint: base, apiKey: '', account: 'default', user: 'default' })
    const capability = new CapabilityService({ api, transport: () => false })
    const inFlight = capability.rules()
    // A profile switch while the probe is still on the wire.
    capability.invalidate()
    const first = await inFlight
    assert.equal(first.available, true)
    const second = await capability.rules()
    assert.deepEqual(second, first)
    assert.equal(ruleProbes, 2, 'the stale probe answer was not trusted for the new identity')
  })
})
