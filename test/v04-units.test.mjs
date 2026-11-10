// Unit tests for v0.4's host half: the preview, unified search, the
// rules/skills/experience catalogue, the `/viking` command, the read-only JSON
// POST fence, and the routes that expose them.
//
// Same style as the existing host tests: import the TypeScript sources directly
// (Node strips the types), no framework, no live server. Every remote call is a
// hand-written fake, so these tests pin *our* normalizations and *our* refusal
// codes, not OpenViking's behaviour — that is `scripts/smoke-host.mjs`'s job.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  isJsonContentType,
  isJsonObject,
  isTrustedLocalRequest,
  readReadOnlyJsonBody,
  READ_ONLY_JSON_BODY_MAX,
} from '../src/host/trust-fence.ts'
import {
  parseRuleDocument,
  parseRuleFile,
  parseScenarioMeta,
  normalizeRuleStatus,
  ruleFactsFromDocument,
} from '../src/host/rule-format.ts'
import { OpenVikingApi } from '../src/host/openviking-api.ts'
import {
  PreviewFailure,
  PreviewService,
  isPlaceholderTier,
  isVikingUri,
  normalizePreviewStat,
} from '../src/host/preview-service.ts'
import {
  SearchService,
  clampSearchLimit,
  normalizeSearchBuckets,
  normalizeSearchType,
  toSearchItem,
} from '../src/host/search-service.ts'
import {
  CatalogService,
  clampExperienceLimit,
  isUnsupportedReply,
  normalizeExperienceKind,
  normalizeOutcomes,
} from '../src/host/catalog-service.ts'
import {
  VIKING_USAGE,
  VIKING_WRITE_USAGE,
  vikingUsage,
  VikingCommand,
  commandErrorText,
  doctorMarker,
  parseVikingCommand,
  vikingCommandDefinition,
} from '../src/host/viking-command.ts'
import { Config, apply } from '../src/host/index.ts'
import { PREVIEW_MAX_CHARS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from '../src/shared/protocol.ts'

/* ========================================================================
 * Helpers
 * ===================================================================== */

/** A successful server envelope. */
const ok = (result) => ({ ok: true, status: 200, result, error: null, errorCode: null })
/** A failed server envelope, with the server's own error code when it has one. */
const fail = (status, error, errorCode = null) => ({ ok: false, status, result: null, error, errorCode })

/** A fake `OpenVikingApi`; every method resolves and tests override what they read. */
function fakeApi(overrides = {}) {
  const api = {
    fsStat: async () => ok({ name: 'entry.md', uri: 'viking://user/default/memories/entities/x/entry.md', size: 42, mode: 420, modTime: '2026-11-01T00:00:00Z', isDir: false, isLocked: false }),
    fsAttrs: async () => ok({ uri: 'viking://user/default/memories/entities/x/entry.md', context_type: 'memory', attrs: { tags: ['tag-a'], memory: { memory_type: 'entities', category: '项目' } } }),
    contentFace: async (uri, tier) => ok(tier === 'abstract' ? 'directory abstract' : 'directory overview'),
    readText: async () => ok('full body'),
    listDirectory: async () => ok([]),
    rulesSearch: async () => ok({ rules: [], rendered: '', delivery: { complete: true, rule_count: 0 }, warning: 'rule library is empty' }),
    search: async () => ok({ memories: [], resources: [], skills: [], total: 0 }),
    listSkills: async () => ok({ skills: [], root_uris: [], total: 0 }),
    experienceTrajectories: async () => ok({ items: [], total: 0 }),
    experienceOutcomes: async () => ok({ outcome_distribution: [] }),
  }
  return { ...api, ...overrides }
}

/** One fake `IncomingMessage` carrying a body, for the POST routes. */
function postRequest({ body, headers = {}, method = 'POST', origin, remoteAddress = '127.0.0.1', host = '127.0.0.1:19387' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const request = Object.assign(Readable.from(chunks), {
    method,
    headers: { host, ...headers },
    socket: { remoteAddress },
  })
  if (origin !== undefined) request.headers.origin = origin
  return request
}

/** One fake `IncomingMessage` for a GET/HEAD route. */
function getRequest({ method = 'GET', url = '/', headers = {}, origin, remoteAddress = '127.0.0.1', host = '127.0.0.1:19387' } = {}) {
  const request = { method, url, headers: { host, ...headers }, socket: { remoteAddress } }
  if (origin !== undefined) request.headers.origin = origin
  return request
}

/** Run one registered route against a fake request and read its JSON answer. */
function callRoute(route, request) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(payload) {
        let body = null
        try {
          body = payload === undefined ? null : JSON.parse(payload)
        } catch {
          body = payload
        }
        resolve({ status: this.status, headers: this.headers, body })
      },
    }
    void route.handler(request, res)
  })
}

const findRoute = (routes, path) => routes.find((route) => route.path === `/api/openviking-enhance${path}`)

/**
 * A host context with the three optional services the v0.4 code touches.
 *
 * `commands` may be a fake registry, `'missing'` (inject waits forever) or null
 * (no `inject` verb at all — the 0.3 production shape).
 */
function hostContext({ commands = null, injectMode = 'run' } = {}) {
  const routes = []
  const listeners = new Map()
  const state = { routes, listeners, injected: [], warns: [] }
  const context = {
    webServer: {
      port: 0,
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      const teardown = callback()
      return () => {
        if (typeof teardown === 'function') teardown()
      }
    },
    get() {
      return undefined
    },
    logger: {
      info() {},
      warn(...args) {
        state.warns.push(args)
      },
      error(...args) {
        state.warns.push(args)
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    inject(deps, callback) {
      state.injected.push(deps.join(','))
      if (commands !== null && injectMode === 'run' && deps.includes('commands')) {
        const teardown = callback({ get: (name) => (name === 'commands' ? commands : undefined) })
        return {
          dispose() {
            if (typeof teardown === 'function') teardown()
          },
        }
      }
      return { dispose() {} }
    },
  }
  return { context, state }
}

/** A fake command registry that records live definitions. */
function commandRegistry() {
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      let live = true
      return () => {
        if (!live) return
        live = false
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
  }
}

/* ========================================================================
 * Rule documents
 * ===================================================================== */

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
  'applies_when: |',
  '  The repository declares itself open source.',
  '  The change touches packaging.',
  'exception: The change is documentation-only.',
  '---',
  '',
  '# Project license',
  '',
  'Add a LICENSE file.',
].join('\n')

test('the rule-document parser reads scalar, quoted and block frontmatter', () => {
  const parsed = parseRuleDocument(RULE_MARKDOWN)
  assert.equal(parsed.fields.schema, 'openviking.rule/v1')
  assert.equal(parsed.fields.atomic_id, 'project-license')
  assert.equal(parsed.fields.revision, '2')
  assert.equal(parsed.fields.status, 'active')
  assert.equal(parsed.fields.content, 'When a repository declares itself open source, it must provide a complete license text.')
  // The `|` block keeps its newlines.
  assert.equal(
    parsed.fields.applies_when,
    'The repository declares itself open source.\nThe change touches packaging.',
  )
  assert.equal(parsed.fields.exception, 'The change is documentation-only.')
  assert.match(parsed.body, /# Project license/)
  assert.match(parsed.body, /Add a LICENSE file\./)
})

/** The server's own serialization, reproduced from PyYAML defaults. */
// OpenViking writes rule files with `yaml.safe_dump(meta, allow_unicode=True,
// sort_keys=False, default_flow_style=False)` and PyYAML folds any scalar past
// `width=80` onto indented continuation lines. Reproduced here with the
// installed server's Python (see the review's B1 evidence) — this is the exact
// shape that used to be silently truncated.
const WRAPPED_PYYAML_RULE = [
  '---',
  'schema: openviking.rule/v1',
  'atomic_id: project-license',
  'revision: 2',
  'status: active',
  'scenario_id: repository-license',
  'source_uris:',
  '- viking://user/default/resources/LICENSE.md',
  'evidence: []',
  "updated_at: '2026-11-09T08:00:00+00:00'",
  'name: Run the test suite before reporting done',
  'confidence: user',
  'description: A long description that certainly exceeds the eighty character default',
  '  width and therefore wraps onto a continuation line.',
  'content: Run the full test suite before reporting a change as complete, unless the',
  '  change is documentation-only.',
  'applies_when: The task modifies source code or configuration, and the change will',
  '  be reported to another person as complete.',
  "exception: ''",
  '---',
  '',
  '# Project license',
  '',
  'Add a LICENSE file.',
].join('\n')

test('wrapped PyYAML plain scalars are folded back instead of truncated', () => {
  const parsed = parseRuleDocument(WRAPPED_PYYAML_RULE)
  // The exact evidence from the review: the old parser stopped at the fold.
  assert.equal(
    parsed.fields.content,
    'Run the full test suite before reporting a change as complete, unless the change is documentation-only.',
  )
  assert.equal(
    parsed.fields.description,
    'A long description that certainly exceeds the eighty character default width and therefore wraps onto a continuation line.',
  )
  assert.equal(
    parsed.fields.applies_when,
    'The task modifies source code or configuration, and the change will be reported to another person as complete.',
  )
  assert.equal(parsed.fields.exception, '')
  // A folded continuation must not swallow the following fields.
  assert.equal(parsed.fields.name, 'Run the test suite before reporting done')
  assert.equal(parsed.fields.status, 'active')
  // The sequence is still skipped, not merged into the scalar above it.
  assert.equal(parsed.fields.source_uris, '')
  assert.equal(parsed.fields.evidence, '[]')
  assert.match(parsed.body, /Add a LICENSE file\./)

  const facts = ruleFactsFromDocument(
    'viking://user/default/memories/rules/repository-license/project-license.md',
    WRAPPED_PYYAML_RULE,
  )
  assert.equal(
    facts.constraint,
    'Run the full test suite before reporting a change as complete, unless the change is documentation-only.',
    'the requirement the user sees is the full sentence, not the first 80 columns',
  )
  assert.match(facts.appliesWhen, /reported to another person as complete\.$/)
  assert.equal(facts.name, 'Run the test suite before reporting done')
})

test('a single-quoted fold after an apostrophe does not close the scalar (N1)', () => {
  // Genuine `yaml.safe_dump` output from the installed OpenViking server's
  // PyYAML 6.0.3: the fold lands right after `dogs'`, which YAML writes as
  // `dogs''`. A naive "ends with quote" check closed the scalar one line early,
  // dropping the rest and leaving a stray apostrophe.
  const frontmatter = [
    "content: 'Use the tool: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx dogs''",
    "  toys and more text that keeps going well past the eighty column limit here.'",
  ].join('\n')
  const fields = parseRuleDocument(`---\n${frontmatter}\n---\n\nbody\n`).fields
  assert.equal(
    fields.content,
    "Use the tool: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx dogs' " +
      'toys and more text that keeps going well past the eighty column limit here.',
  )
})

test('blank lines inside a quoted scalar are newlines, not the end of it (N2)', () => {
  // Genuine PyYAML output for a two-paragraph single-quoted value: every newline
  // in the value becomes one blank line, and the next folded segment must not
  // gain a space.
  const twoParagraphs = [
    "content: 'First line of the rule.",
    '',
    '',
    '  Second line that is also quite long and will need folding somewhere well past the',
    "  eighty column limit.'",
  ].join('\n')
  assert.equal(
    parseRuleDocument(`---\n${twoParagraphs}\n---\n\nbody\n`).fields.content,
    'First line of the rule.\n\n' +
      'Second line that is also quite long and will need folding somewhere well past the eighty column limit.',
  )

  // The single-newline form has one blank line and keeps one newline.
  const oneNewline = [
    "content: 'Constraint: First line of the rule.",
    '',
    '  Second line that is also quite long and will need folding somewhere well past the',
    "  eighty column limit.'",
  ].join('\n')
  assert.equal(
    parseRuleDocument(`---\n${oneNewline}\n---\n\nbody\n`).fields.content,
    'Constraint: First line of the rule.\n' +
      'Second line that is also quite long and will need folding somewhere well past the eighty column limit.',
  )

  // A trailing newline in the value survives too (blank line before the closing
  // quote), and a following field is still parsed.
  const trailing = [
    "content: 'Constraint: A value that ends with a newline.",
    '',
    "  '",
    'name: after the quoted scalar',
  ].join('\n')
  const parsed = parseRuleDocument(`---\n${trailing}\n---\n\nbody\n`)
  assert.equal(parsed.fields.content, 'Constraint: A value that ends with a newline.\n')
  assert.equal(parsed.fields.name, 'after the quoted scalar')
})

test('folded single- and double-quoted scalars are re-joined by YAML rules', () => {
  // PyYAML chooses single quotes for a value containing `: ` / `#`; the closing
  // quote lands on the continuation line.
  const singleQuoted = [
    '---',
    "content: 'He said: \"Run the full test suite before reporting a change as complete,",
    '  then report it.\"\'',
    '---',
  ].join('\n')
  assert.equal(
    parseRuleDocument(singleQuoted).fields.content,
    'He said: "Run the full test suite before reporting a change as complete, then report it."',
  )

  // A tab forces double-quote style. PyYAML wraps it with an ESCAPED line break
  // (`\` at EOL + `\ ` at the start of the continuation): no folded space, and
  // `\t` is the tab escape.
  const doubleQuoted = [
    '---',
    'content: "Run\\tthe full test suite before reporting a change as complete, then report\\',
    '  \\ it."',
    '---',
  ].join('\n')
  assert.equal(
    parseRuleDocument(doubleQuoted).fields.content,
    'Run\tthe full test suite before reporting a change as complete, then report it.',
  )

  // A single-line double-quoted scalar still decodes its escapes.
  assert.equal(parseRuleDocument('---\ncontent: "line\\nbreak"\n---\n').fields.content, 'line\nbreak')
})

test('the rule-document parser tolerates quotes, CRLF, folded blocks and no frontmatter', () => {
  const quoted = parseRuleDocument("---\nname: \"Quoted name\"\nexception: 'single quoted'\n---\nbody")
  assert.equal(quoted.fields.name, 'Quoted name')
  assert.equal(quoted.fields.exception, 'single quoted')

  const crlf = parseRuleDocument('---\r\nname: CRLF rule\r\n---\r\nbody\r\n')
  assert.equal(crlf.fields.name, 'CRLF rule')
  assert.equal(crlf.body, 'body\n', 'line endings are normalized')

  const folded = parseRuleDocument('---\napplies_when: >\n  line one\n  line two\n---\nbody')
  assert.equal(folded.fields.applies_when, 'line one line two')

  // A plain Markdown file: no frontmatter, the whole text is the body.
  const plain = parseRuleDocument('# Just a note\n\nNothing to parse.')
  assert.deepEqual(plain.fields, {})
  assert.match(plain.body, /Just a note/)
  // Unclosed frontmatter degrades to the same shape rather than eating the body.
  const unclosed = parseRuleDocument('---\nname: broken')
  assert.deepEqual(unclosed.fields, {})
  assert.match(unclosed.body, /name: broken/)
})

test('rule facts copy the search reply fields and fall back to the document body', () => {
  const facts = ruleFactsFromDocument(
    'viking://user/default/memories/rules/repository-license/project-license.md',
    RULE_MARKDOWN,
    { id: 'project-license', revision: 3, scenario: 'repository-license', probability: 0.91 },
  )
  assert.equal(facts.id, 'project-license')
  assert.equal(facts.revision, 3, 'the reply revision wins over the frontmatter')
  assert.equal(facts.scenario, 'repository-license')
  assert.equal(facts.probability, 0.91)
  assert.equal(facts.name, 'Project license')
  assert.match(facts.constraint, /must provide a complete license text/)
  assert.match(facts.appliesWhen, /declares itself open source/)
  assert.equal(facts.exception, 'The change is documentation-only.')
  assert.equal(facts.status, 'active')
  assert.match(facts.body, /Add a LICENSE file/)

  // No `content:` field: the first body paragraph stands in, without the heading.
  const noContent = ruleFactsFromDocument('viking://x/rule.md', '---\nname: Fallback\n---\n\n# Heading\n\nUseful constraint.')
  assert.equal(noContent.constraint, 'Useful constraint.')
  // No name anywhere: the atomic id, then the file name.
  assert.equal(ruleFactsFromDocument('viking://x/a.md', '---\natomic_id: a1\n---\nbody').name, 'a1')
  assert.equal(ruleFactsFromDocument('viking://x/a.md', 'body only').name, 'a.md')
})

test('rule statuses normalize, and scenario metadata degrades to the directory id', () => {
  assert.equal(normalizeRuleStatus('active'), 'active')
  assert.equal(normalizeRuleStatus(' PAUSED '), 'paused')
  assert.equal(normalizeRuleStatus('archived'), 'archived')
  assert.equal(normalizeRuleStatus('retired'), 'unknown')
  assert.equal(normalizeRuleStatus(null), 'unknown')

  assert.deepEqual(parseScenarioMeta('coding', ''), { id: 'coding', name: 'coding', description: '' })
  assert.deepEqual(
    parseScenarioMeta('coding', '---\nscenario_id: coding\nname: Coding rules\ndescription: Constraints for code changes.\n---\n'),
    { id: 'coding', name: 'Coding rules', description: 'Constraints for code changes.' },
  )
  const parsed = parseRuleFile('viking://x/s/rule.md', RULE_MARKDOWN, 'coding')
  assert.equal(parsed.facts.scenario, 'coding')
})

/* ========================================================================
 * Trust fence: the read-only JSON POST widening
 * ===================================================================== */

test('only JSON media types pass the POST content-type check', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('Application/JSON; charset=utf-8'), true)
  assert.equal(isJsonContentType('application/json;charset=utf-8'), true)
  assert.equal(isJsonContentType('text/plain'), false)
  assert.equal(isJsonContentType('application/x-www-form-urlencoded'), false)
  assert.equal(isJsonContentType('multipart/form-data; boundary=x'), false)
  assert.equal(isJsonContentType(undefined), false)
  assert.equal(isJsonContentType([]), false)
  assert.equal(isJsonContentType(['application/json']), true)
})

test('isJsonObject accepts objects only', () => {
  assert.equal(isJsonObject({}), true)
  assert.equal(isJsonObject([]), false)
  assert.equal(isJsonObject(null), false)
  assert.equal(isJsonObject('x'), false)
  assert.equal(isJsonObject(3), false)
})

test('a same-origin loopback POST passes the existing fence unchanged', () => {
  // The fence is method-agnostic: a browser's same-origin POST carries Origin
  // and Sec-Fetch-Site: same-origin, both of which it already accepts.
  assert.equal(
    isTrustedLocalRequest(getRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', headers: { 'sec-fetch-site': 'same-origin' } })),
    true,
  )
  assert.equal(isTrustedLocalRequest(getRequest({ method: 'POST', origin: 'http://127.0.0.1:9999' })), false)
  assert.equal(isTrustedLocalRequest(getRequest({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isTrustedLocalRequest(getRequest({ method: 'POST', host: 'dsh.example.com' })), false)
})

test('readReadOnlyJsonBody parses a bounded JSON object', async () => {
  const answer = await readReadOnlyJsonBody(
    postRequest({ body: { query: 'hello' }, headers: { 'content-type': 'application/json' } }),
  )
  assert.deepEqual(answer, { ok: true, value: { query: 'hello' } })

  // A streamed body with no declared length is still parseable.
  const streamed = await readReadOnlyJsonBody(
    postRequest({ body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json', 'content-length': '7' } }),
  )
  assert.deepEqual(streamed, { ok: true, value: { a: 1 } })
})

test('readReadOnlyJsonBody refuses the wrong content type, a large body or bad JSON', async () => {
  assert.deepEqual(
    await readReadOnlyJsonBody(postRequest({ body: { a: 1 }, headers: { 'content-type': 'text/plain' } })),
    { ok: false, error: 'content-type' },
  )
  // Declared Content-Length past the cap: refused before reading.
  assert.deepEqual(
    await readReadOnlyJsonBody(
      postRequest({
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-length': String(READ_ONLY_JSON_BODY_MAX + 1) },
      }),
    ),
    { ok: false, error: 'too-large' },
  )
  // Streaming past the cap without a (truthful) Content-Length: the bytes on the
  // wire are what counts.
  const oversized = 'x'.repeat(READ_ONLY_JSON_BODY_MAX + 10)
  assert.deepEqual(
    await readReadOnlyJsonBody(
      postRequest({ body: JSON.stringify({ query: oversized }), headers: { 'content-type': 'application/json' } }),
    ),
    { ok: false, error: 'too-large' },
  )
  // A smaller custom cap still applies.
  assert.deepEqual(
    await readReadOnlyJsonBody(postRequest({ body: '{"a":1}', headers: { 'content-type': 'application/json' } }), 3),
    { ok: false, error: 'too-large' },
  )
  assert.deepEqual(
    await readReadOnlyJsonBody(postRequest({ body: '{not json', headers: { 'content-type': 'application/json' } })),
    { ok: false, error: 'invalid-json' },
  )
  assert.deepEqual(
    await readReadOnlyJsonBody(postRequest({ body: '', headers: { 'content-type': 'application/json' } })),
    { ok: false, error: 'invalid-json' },
  )
})

test('a caller signal aborts the in-flight OpenViking request', async () => {
  // This is the transport end of S3: the command's signal must reach the fetch,
  // not just be checked between awaits, so a cancelled retrieval stops spending
  // server time immediately.
  const original = globalThis.fetch
  const controller = new AbortController()
  let fetchSignal
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      fetchSignal = init.signal
      const onAbort = () => reject(new Error('The operation was aborted.'))
      init.signal.addEventListener('abort', onAbort, { once: true })
      if (init.signal.aborted) onAbort()
      else controller.abort()
    })
  try {
    const api = new OpenVikingApi({
      endpoint: 'http://127.0.0.1:1933',
      apiKey: '',
      account: 'default',
      user: 'default',
    })
    const answer = await api.health({ signal: controller.signal })
    assert.equal(fetchSignal?.aborted, true, 'the caller cancellation reaches the fetch signal')
    assert.equal(answer.ok, false)
    assert.equal(answer.version, null)
    assert.match(String(answer.error), /abort/i, 'the aborted fetch is reported, not thrown')
  } finally {
    globalThis.fetch = original
  }
})

/* ========================================================================
 * F5: preview
 * ===================================================================== */

test('preview validates viking:// paths only', () => {
  assert.equal(isVikingUri('viking://user/default/memories'), true)
  assert.equal(isVikingUri('  viking://user '), true)
  assert.equal(isVikingUri('file:///etc/passwd'), false)
  assert.equal(isVikingUri('/etc/passwd'), false)
  assert.equal(isVikingUri('viking://'), false)
})

test('preview detects the server "not ready" placeholder sidecars', () => {
  assert.equal(isPlaceholderTier('# viking://user/default/memories [Directory abstract is not ready]'), true)
  assert.equal(isPlaceholderTier('# viking://user/default/memories\n\n[Directory overview is not ready]'), true)
  assert.equal(isPlaceholderTier('A real abstract.'), false)
})

test('preview assembles stat, attrs and the three tiers in one answer', async () => {
  const api = fakeApi({
    readText: async () => ok('L2 body'),
  })
  const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  const preview = await service.preview('viking://user/default/memories/entities/x/entry.md')

  assert.equal(preview.uri, 'viking://user/default/memories/entities/x/entry.md')
  assert.equal(preview.studioUrl, 'http://127.0.0.1:1933/studio/')
  assert.equal(preview.stat.name, 'entry.md')
  assert.equal(preview.stat.size, 42)
  assert.equal(preview.stat.isDir, false)
  assert.equal(preview.stat.contextType, 'memory')
  assert.equal(preview.stat.memoryType, 'entities')
  assert.equal(preview.stat.category, '项目')
  assert.deepEqual(preview.stat.tags, ['tag-a'])
  assert.deepEqual(
    preview.tiers.map((tier) => [tier.id, tier.available, tier.text]),
    [
      ['l0', true, 'directory abstract'],
      ['l1', true, 'directory overview'],
      ['l2', true, 'L2 body'],
    ],
  )
  assert.deepEqual(preview.tiers.map((tier) => tier.placeholder), [false, false, false])
  assert.deepEqual(preview.warnings, [])
  assert.match(preview.observedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('preview caps a long tier and marks it truncated', async () => {
  const api = fakeApi({ readText: async () => ok('y'.repeat(PREVIEW_MAX_CHARS + 40)) })
  const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  const preview = await service.preview('viking://user/default/memories/x.md')
  const l2 = preview.tiers.find((tier) => tier.id === 'l2')
  assert.equal(l2.text.length, PREVIEW_MAX_CHARS)
  assert.equal(l2.truncated, true)
  assert.equal(l2.available, true)
})

test('preview keeps a directory readable when only L2 is refused', async () => {
  const api = fakeApi({
    fsStat: async () => ok({ name: 'memories', uri: 'viking://user/default/memories', size: 0, isDir: true, modTime: '2026-11-01T00:00:00Z' }),
    fsAttrs: async () => ok({ uri: 'viking://user/default/memories', context_type: 'memory', attrs: { tags: [] } }),
    contentFace: async () => ok('# viking://user/default/memories [Directory abstract is not ready]'),
    readText: async () =>
      fail(400, 'Cannot read directory as file: viking://user/default/memories', 'INVALID_ARGUMENT'),
  })
  const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  const preview = await service.preview('viking://user/default/memories')
  assert.equal(preview.stat.isDir, true)
  const l2 = preview.tiers.find((tier) => tier.id === 'l2')
  assert.equal(l2.available, false)
  assert.match(l2.error, /directory/i)
  // The placeholder is surfaced as a state, not content.
  assert.equal(preview.tiers.find((tier) => tier.id === 'l0').placeholder, true)
})

test('preview reports a missing attrs sidecar as a warning, not a failure', async () => {
  const api = fakeApi({ fsAttrs: async () => fail(404, 'Not Found', 'NOT_FOUND') })
  const service = new PreviewService({ api, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  const preview = await service.preview('viking://user/default/memories/x.md')
  assert.equal(preview.stat.contextType, null, 'stat still answers without attrs')
  assert.deepEqual(preview.warnings.map((warning) => warning.code), ['attrsUnavailable'])
})

test('preview distinguishes a missing entry from an unreadable server', async () => {
  const notFoundApi = fakeApi({
    fsStat: async () => fail(404, 'Resource not found', 'NOT_FOUND'),
    fsAttrs: async () => fail(404, 'Resource not found', 'NOT_FOUND'),
    contentFace: async () => fail(404, 'Resource not found', 'NOT_FOUND'),
    readText: async () => fail(404, 'Resource not found', 'NOT_FOUND'),
  })
  const service = new PreviewService({ api: notFoundApi, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  await assert.rejects(
    () => service.preview('viking://user/default/memories/nope.md'),
    (error) => error instanceof PreviewFailure && error.code === 'not-found',
  )

  const deadApi = fakeApi({
    fsStat: async () => fail(0, 'fetch failed'),
    fsAttrs: async () => fail(0, 'fetch failed'),
    contentFace: async () => fail(0, 'fetch failed'),
    readText: async () => fail(0, 'fetch failed'),
  })
  const dead = new PreviewService({ api: deadApi, studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  await assert.rejects(
    () => dead.preview('viking://user/default/memories/x.md'),
    (error) => error instanceof PreviewFailure && error.code === 'unreadable',
  )

  const local = new PreviewService({ api: fakeApi(), studioUrl: () => 'http://127.0.0.1:1933/studio/' })
  await assert.rejects(
    () => local.preview('https://example.com/x'),
    (error) => error instanceof PreviewFailure && error.code === 'not-a-viking-path',
  )
})

test('preview stat normalization tolerates every missing field', () => {
  assert.equal(normalizePreviewStat('viking://user/default/x.md', null, null), null)
  const stat = normalizePreviewStat('viking://user/default/x.md', null, {
    uri: 'viking://user/default/x.md',
    context_type: 'resource',
    attrs: { tags: ['a', 3], memory: { memory_type: 'entities' } },
  })
  assert.equal(stat.name, 'x.md', 'the tail of the URI stands in for a missing name')
  assert.equal(stat.size, null)
  assert.equal(stat.isDir, null)
  assert.equal(stat.memoryType, 'entities')
  assert.equal(stat.category, null)
  assert.deepEqual(stat.tags, ['a'], 'non-string tags are dropped')
})

/* ========================================================================
 * F7: unified search
 * ===================================================================== */

test('the search request is clamped to the documented window', () => {
  assert.equal(clampSearchLimit(undefined), SEARCH_DEFAULT_LIMIT)
  assert.equal(clampSearchLimit(0), 1)
  assert.equal(clampSearchLimit(-5), 1)
  assert.equal(clampSearchLimit(999), SEARCH_MAX_LIMIT)
  assert.equal(clampSearchLimit(Number.NaN), SEARCH_DEFAULT_LIMIT)
  assert.equal(clampSearchLimit(5.9), 5)
})

test('search buckets and types normalize to the supported set', () => {
  assert.deepEqual(normalizeSearchBuckets(undefined), ['memories', 'resources', 'skills', 'rules'])
  assert.deepEqual(normalizeSearchBuckets([]), ['memories', 'resources', 'skills', 'rules'])
  assert.deepEqual(normalizeSearchBuckets(['rules', 'memories']), ['memories', 'rules'], 'kept in display order')
  assert.deepEqual(normalizeSearchBuckets(['nope']), [], 'unknown buckets are dropped')
  assert.equal(normalizeSearchType('keywords'), 'keywords')
  assert.equal(normalizeSearchType('semantic'), 'semantic')
  assert.equal(normalizeSearchType(undefined), 'semantic')
  assert.equal(normalizeSearchType('fuzzy'), 'semantic')
})

test('a search item carries the bucket facts, including the memory kind from the path', () => {
  const item = toSearchItem(
    { uri: 'viking://user/default/memories/events/2026/10/02/x.md', score: 0.7, context_type: 'memory', level: 2, abstract: 'A', tags: ['t', 4] },
    'memories',
  )
  assert.equal(item.memoryType, 'event')
  assert.equal(item.level, 2)
  assert.deepEqual(item.tags, ['t'])
  assert.equal(item.rule, null)
  // A result named without a context_type falls back to the bucket's own server type.
  assert.equal(toSearchItem({ uri: 'viking://agent/skills/x', score: 0.5 }, 'skills').contextType, 'skill')
})

test('the unified search merges search buckets and rule matches into four groups', async () => {
  const seen = []
  const api = fakeApi({
    search: async (body) => {
      seen.push(body)
      return ok({
        memories: [{ uri: 'viking://user/default/memories/entities/x/a.md', score: 0.8, level: 2, abstract: 'memory hit', tags: [] }],
        resources: [{ uri: 'viking://resources/x/b.md', score: 0.6, abstract: 'resource hit', tags: [] }],
        skills: [],
        total: 2,
      })
    },
    rulesSearch: async (context) => {
      seen.push({ rules: context })
      return ok({
        rules: [
          {
            atomic_id: 'project-license',
            revision: 1,
            scenario_id: 'repository-license',
            probability: 0.91,
            uri: 'viking://user/default/memories/rules/repository-license/project-license.md',
            content: RULE_MARKDOWN,
          },
        ],
        rendered: '# Applicable rules',
        delivery: { complete: true, rule_count: 1 },
      })
    },
  })
  const service = new SearchService({ api, now: () => 1000 })
  const payload = await service.search({ query: '  license  ' })

  assert.equal(payload.query, 'license')
  assert.equal(payload.searchType, 'semantic')
  assert.deepEqual(payload.buckets.map((bucket) => bucket.bucket), ['memories', 'resources', 'skills', 'rules'])
  assert.equal(payload.total, 3)
  assert.equal(payload.searchedAt, new Date(1000).toISOString())

  // The main call: no target URI, list mode, all three server context types, the
  // browse score threshold, and the limit.
  const searchCall = seen[0]
  assert.equal(searchCall.query, 'license')
  assert.equal(searchCall.mode, 'list')
  assert.equal(searchCall.target_uri, undefined, 'the 0.5.3 recommendation is no target URI')
  assert.equal(searchCall.search_type, 'semantic')
  assert.deepEqual(searchCall.context_type, ['memory', 'resource', 'skill'])
  assert.equal(searchCall.score_threshold, 0)
  assert.equal(searchCall.limit, SEARCH_DEFAULT_LIMIT)
  // The rules half passes the query as the task context.
  assert.equal(seen[1].rules, 'license')

  const rules = payload.buckets.find((bucket) => bucket.bucket === 'rules')
  assert.equal(rules.items.length, 1)
  assert.equal(rules.items[0].contextType, 'rule')
  assert.equal(rules.items[0].score, 0.91)
  assert.equal(rules.items[0].rule.name, 'Project license')
  assert.equal(rules.items[0].rule.status, 'active')
  assert.match(rules.items[0].rule.appliesWhen, /open source/)
  assert.equal(rules.items[0].abstract, 'When a repository declares itself open source, it must provide a complete license text.')
})

test('only the requested buckets cost a server call', async () => {
  const seen = []
  const api = fakeApi({
    search: async (body) => {
      seen.push(['search', body.context_type])
      return ok({ skills: [{ uri: 'viking://agent/skills/x', score: 0.4 }] })
    },
    rulesSearch: async () => {
      seen.push(['rules'])
      return ok({ rules: [] })
    },
  })
  const service = new SearchService({ api })
  const payload = await service.search({ query: 'x', buckets: ['skills'] })
  assert.deepEqual(seen, [['search', ['skill']]], 'rules were not requested, so rules/search was not called')
  assert.equal(payload.buckets.length, 1)
  assert.equal(payload.buckets[0].bucket, 'skills')
})

test('a failed rules call is a warning on a usable answer', async () => {
  const api = fakeApi({
    search: async () => ok({ memories: [], resources: [], skills: [] }),
    rulesSearch: async () => fail(404, 'Not Found'),
  })
  const service = new SearchService({ api })
  const payload = await service.search({ query: 'x' })
  assert.deepEqual(payload.warnings.map((warning) => warning.code), ['rulesUnavailable'])
  assert.deepEqual(payload.buckets.find((bucket) => bucket.bucket === 'rules').items, [])
})

test('keywords degrade to semantic with one warning (live 0.5.3 rejects keywords)', async () => {
  const types = []
  const api = fakeApi({
    search: async (body) => {
      types.push(body.search_type)
      if (body.search_type === 'keywords') {
        return fail(
          400,
          'Keyword search is not supported by the configured vector backend, or full-text indexing is not enabled for the content field.',
          'INVALID_ARGUMENT',
        )
      }
      return ok({ memories: [{ uri: 'viking://user/default/memories/entities/x/a.md', score: 0.5 }] })
    },
  })
  const service = new SearchService({ api })
  const payload = await service.search({ query: 'x', searchType: 'keywords', buckets: ['memories'] })
  assert.deepEqual(types, ['keywords', 'semantic'])
  assert.equal(payload.searchType, 'semantic', 'the effective type is reported')
  assert.deepEqual(payload.warnings.map((warning) => warning.code), ['keywordsUnavailable'])
  assert.equal(payload.buckets[0].items.length, 1)
})

test('an empty query and a dead main search are errors the route can answer', async () => {
  const service = new SearchService({ api: fakeApi() })
  await assert.rejects(() => service.search({ query: '   ' }), /query-required/)

  const dead = new SearchService({
    api: fakeApi({ search: async () => fail(0, 'fetch failed') }),
  })
  await assert.rejects(() => dead.search({ query: 'x' }), /fetch failed/)
})

/* ========================================================================
 * F8: rules / skills / experience catalogue
 * ===================================================================== */

test('unsupported-feature detection uses the server error envelope, not the status alone', () => {
  // A route this build does not have: plain 404, no server code.
  assert.equal(isUnsupportedReply(fail(404, 'Not Found')), true)
  assert.equal(isUnsupportedReply(fail(405, 'Method Not Allowed')), true)
  // The server's own NOT_FOUND with a code is a missing resource, not a missing route.
  assert.equal(isUnsupportedReply(fail(404, 'Directory not found', 'NOT_FOUND')), false)
  assert.equal(isUnsupportedReply(fail(400, 'bad body', 'INVALID_ARGUMENT')), false)
  assert.equal(isUnsupportedReply(fail(0, 'fetch failed')), false)
  assert.equal(isUnsupportedReply(ok({})), false)
})

test('the rules list is empty when the server says the tree does not exist', async () => {
  const api = fakeApi({
    listDirectory: async () => fail(404, 'Directory not found: viking://user/default/memories/rules', 'NOT_FOUND'),
  })
  const catalog = new CatalogService({ api })
  const list = await catalog.listRules()
  assert.deepEqual(list.rules, [])
  assert.deepEqual(list.scenarios, [])
  assert.equal(list.empty, true)
  assert.deepEqual(list.warnings, [])
})

test('the rules capability gate catches an older server before the tree looks merely empty', async () => {
  // On a 0.5.1.1 server there is no rules router AND no rules directory: the
  // filesystem alone would answer 404 NOT_FOUND, which looks exactly like "no
  // rules compiled yet". The `rules/search` probe is what tells them apart.
  const api = fakeApi({
    rulesSearch: async () => fail(404, 'Not Found'),
    listDirectory: async () => fail(404, 'Directory not found', 'NOT_FOUND'),
  })
  const catalog = new CatalogService({ api })
  await assert.rejects(() => catalog.listRules(), /unsupported/)
})

test('a generic fs/ls 404 means the rules feature is unsupported', async () => {
  const api = fakeApi({ listDirectory: async () => fail(404, 'Not Found') })
  const catalog = new CatalogService({ api })
  await assert.rejects(() => catalog.listRules(), /unsupported/)
})

test('the rules list reads scenario folders and parses each rule file', async () => {
  const root = 'viking://~/memories/rules'
  const scenario = `${root}/repository-license`
  const ruleUri = `${scenario}/project-license.md`
  const seenReads = []
  const api = fakeApi({
    listDirectory: async (uri) => {
      if (uri === root) return ok([{ uri: scenario, isDir: true }])
      if (uri === scenario) {
        return ok([
          { uri: `${scenario}/abstract.md`, isDir: false },
          { uri: ruleUri, isDir: false },
        ])
      }
      return ok([])
    },
    readText: async (uri) => {
      seenReads.push(uri)
      if (uri.endsWith('abstract.md')) {
        return ok('---\nscenario_id: repository-license\nname: Repository license\ndescription: License constraints.\n---\n')
      }
      return ok(RULE_MARKDOWN)
    },
  })
  const catalog = new CatalogService({ api })
  const list = await catalog.listRules()
  assert.equal(list.empty, false)
  assert.equal(list.rules.length, 1)
  const rule = list.rules[0]
  assert.equal(rule.id, 'project-license')
  assert.equal(rule.name, 'Project license')
  assert.equal(rule.status, 'active')
  assert.equal(rule.scenario, 'repository-license')
  assert.equal(rule.description, 'Every open-source repo needs a license.')
  assert.deepEqual(list.scenarios, [{ id: 'repository-license', name: 'Repository license', ruleCount: 1 }])
  // Index files are not rules.
  assert.equal(seenReads.filter((uri) => uri.endsWith('abstract.md')).length, 1)
})

test('a failed scenario abstract read is recorded as a warning, not swallowed', async () => {
  const root = 'viking://~/memories/rules'
  const scenario = `${root}/repository-license`
  const api = fakeApi({
    listDirectory: async (uri) => {
      if (uri === root) return ok([{ uri: scenario, isDir: true }])
      if (uri === scenario) return ok([{ uri: `${scenario}/project-license.md`, isDir: false }])
      return ok([])
    },
    readText: async (uri) => {
      if (uri.endsWith('abstract.md')) return fail(500, 'backend exploded')
      return ok(RULE_MARKDOWN)
    },
  })
  const list = await new CatalogService({ api }).listRules()
  assert.equal(list.rules.length, 1, 'the rule file itself still lists')
  assert.deepEqual(list.scenarios, [{ id: 'repository-license', name: 'repository-license', ruleCount: 1 }])
  assert.deepEqual(list.warnings.map((warning) => warning.code), ['ruleScenarioUnreadable'])
  assert.match(String(list.warnings[0].params.uri), /repository-license\/abstract\.md$/)
})

test('a wrong-content-type POST drains its body before the clean 415 answer', async () => {
  let resumed = false
  let consumed = 0
  const request = {
    headers: { 'content-type': 'text/plain', 'content-length': '900000' },
    resume() {
      resumed = true
    },
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 4; index += 1) {
        consumed += 1
        yield Buffer.from('x'.repeat(1024))
      }
    },
  }
  const answer = await readReadOnlyJsonBody(request, 64)
  assert.deepEqual(answer, { ok: false, error: 'content-type' })
  assert.equal(resumed, true, 'the refused body is drained so the client sees a 415, not a reset')
  assert.equal(consumed, 0, 'the body is refused before any of it is parsed')
})

test('the rule tester parses matched rules and reports the delivery', async () => {
  const api = fakeApi({
    rulesSearch: async () =>
      ok({
        rules: [
          {
            atomic_id: 'project-license',
            revision: 2,
            scenario_id: 'repository-license',
            probability: 0.91,
            uri: 'viking://user/default/memories/rules/repository-license/project-license.md',
            content: RULE_MARKDOWN,
          },
        ],
        rendered: '# Applicable OpenViking Rules\n\nMatched 1 active Rule(s).',
        delivery: { complete: true, rule_count: 1 },
        warning: 'model unavailable; pass-through',
      }),
  })
  const catalog = new CatalogService({ api, now: () => 5000 })
  const result = await catalog.searchRules('Add an open-source license to the repo')
  assert.equal(result.matches.length, 1)
  const match = result.matches[0]
  assert.equal(match.id, 'project-license')
  assert.equal(match.revision, 2)
  assert.equal(match.probability, 0.91)
  assert.match(match.constraint, /must provide a complete license text/)
  assert.match(match.appliesWhen, /declares itself open source/)
  assert.equal(match.exception, 'The change is documentation-only.')
  assert.equal(match.status, 'active')
  assert.match(match.body, /Add a LICENSE file/)
  assert.match(result.rendered, /Matched 1 active Rule/)
  assert.equal(result.complete, true)
  assert.equal(result.warning, 'model unavailable; pass-through')
  assert.equal(result.searchedAt, new Date(5000).toISOString())

  await assert.rejects(() => catalog.searchRules('   '), /task-context-required/)
  await assert.rejects(
    () => new CatalogService({ api: fakeApi({ rulesSearch: async () => fail(404, 'Not Found') }) }).searchRules('x'),
    /unsupported/,
  )
})

test('the skill catalogue maps the real skill shape and gates a missing route', async () => {
  const api = fakeApi({
    listSkills: async (options) =>
      ok({
        root_uris: ['viking://agent/skills'],
        total: 1,
        skills: [
          {
            type: 'skill',
            name: 'daily-report',
            uri: 'viking://agent/skills/daily-report',
            root_uri: 'viking://agent/skills/daily-report',
            skill_md_uri: 'viking://agent/skills/daily-report/SKILL.md',
            description: 'Compile daily reports.',
            tags: ['report'],
            allowed_tools: ['read'],
          },
        ],
      }),
  })
  const catalog = new CatalogService({ api })
  const found = await catalog.listSkills()
  assert.equal(found.total, 1)
  assert.deepEqual(found.roots, ['viking://agent/skills'])
  assert.equal(found.skills[0].name, 'daily-report')
  assert.equal(found.skills[0].skillMdUri, 'viking://agent/skills/daily-report/SKILL.md')
  assert.deepEqual(found.skills[0].tags, ['report'])

  await assert.rejects(
    () => new CatalogService({ api: fakeApi({ listSkills: async () => fail(404, 'Not Found') }) }).listSkills(),
    /unsupported/,
  )
})

test('the experience catalogue normalizes kinds, limits and the five outcome classes', () => {
  assert.equal(normalizeExperienceKind(undefined), 'trajectories')
  assert.equal(normalizeExperienceKind('outcomes'), 'outcomes')
  assert.equal(normalizeExperienceKind('banana'), 'trajectories')
  assert.equal(clampExperienceLimit(undefined), 20)
  assert.equal(clampExperienceLimit(0), 1)
  assert.equal(clampExperienceLimit(1000), 100)

  const outcomes = normalizeOutcomes([
    { outcome: 'failure', count: 1 },
    { outcome: 'success', count: 4 },
    { outcome: 'custom', count: 2 },
  ])
  assert.deepEqual(outcomes.map((entry) => entry.outcome), [
    'success',
    'failure',
    'partial',
    'unknown',
    'unfinished',
    'custom',
  ])
  assert.deepEqual(outcomes[0], { outcome: 'success', count: 4 })
  assert.deepEqual(outcomes[2], { outcome: 'partial', count: 0 }, 'unreported classes are zero, not absent')
})

test('experiences are discovered from the filesystem and can then be selected', async () => {
  const experienceUri = 'viking://user/default/memories/experiences/exchange.md'
  const trajectoryUri = 'viking://user/default/memories/trajectories/exchange_20260805020000.md'
  const seenTrajectories = []
  const api = fakeApi({
    listDirectory: async (uri) =>
      uri.endsWith('/memories/experiences')
        ? ok([{ uri: experienceUri, isDir: false, modTime: '2026-08-05T02:00:00Z', abstract: 'Handle exchange requests.' }])
        : ok([]),
    experienceTrajectories: async (uri, options) => {
      seenTrajectories.push([uri, options.limit])
      return ok({
        experience_uri: uri,
        items: [
          {
            uri: trajectoryUri,
            name: 'exchange_20260805020000.md',
            description: 'Handle an exchange request',
            created_at: '2026-08-05T02:00:00Z',
            updated_at: '2026-08-05T02:00:00Z',
          },
        ],
        total: 1,
      })
    },
  })
  const catalog = new CatalogService({ api })

  const listing = await catalog.experience('trajectories', undefined)
  assert.equal(listing.selected, null)
  assert.equal(listing.empty, false)
  assert.equal(listing.note, null)
  assert.deepEqual(listing.experiences, [
    { uri: experienceUri, name: 'exchange', description: 'Handle exchange requests.', modifiedAt: '2026-08-05T02:00:00Z' },
  ])

  const trajectories = await catalog.experience('trajectories', experienceUri)
  assert.equal(trajectories.selected, experienceUri)
  assert.equal(trajectories.items.length, 1)
  assert.equal(trajectories.items[0].name, 'exchange_20260805020000.md')
  assert.equal(trajectories.items[0].description, 'Handle an exchange request')
  assert.deepEqual(seenTrajectories, [[experienceUri, 20]])

  const outcomes = await new CatalogService({
    api: fakeApi({
      listDirectory: async () => ok([{ uri: experienceUri, isDir: false }]),
      experienceOutcomes: async () =>
        ok({ outcome_distribution: [{ outcome: 'success', count: 4 }, { outcome: 'failure', count: 1 }] }),
    }),
  }).experience('outcomes', experienceUri)
  assert.deepEqual(outcomes.outcomes.map((entry) => [entry.outcome, entry.count]), [
    ['success', 4],
    ['failure', 1],
    ['partial', 0],
    ['unknown', 0],
    ['unfinished', 0],
  ])
})

test('experience empty, not-found and unsupported states are distinct', async () => {
  const empty = await new CatalogService({
    api: fakeApi({ listDirectory: async () => fail(404, 'Directory not found', 'NOT_FOUND') }),
  }).experience('trajectories', undefined)
  assert.equal(empty.empty, true)
  assert.equal(empty.note, 'no-experiences')

  await assert.rejects(
    () => new CatalogService({ api: fakeApi({ listDirectory: async () => fail(404, 'Not Found') }) }).experience('trajectories', undefined),
    /unsupported/,
  )
  await assert.rejects(
    () =>
      new CatalogService({ api: fakeApi() }).experience('trajectories', 'viking://user/default/memories/profile.md'),
    /invalid-experience-uri/,
  )

  // The experience file vanished between listing and reading: a note, not an error.
  const vanished = await new CatalogService({
    api: fakeApi({
      listDirectory: async () => ok([{ uri: 'viking://user/default/memories/experiences/x.md', isDir: false }]),
      experienceTrajectories: async () => fail(404, 'File not found: x.md', 'NOT_FOUND'),
    }),
  }).experience('trajectories', 'viking://user/default/memories/experiences/x.md')
  assert.equal(vanished.note, 'not-found')
  assert.deepEqual(vanished.items, [])

  await assert.rejects(
    () =>
      new CatalogService({
        api: fakeApi({
          listDirectory: async () => ok([]),
          experienceTrajectories: async () => fail(404, 'Not Found'),
        }),
      }).experience('trajectories', 'viking://user/default/memories/experiences/x.md'),
    /unsupported/,
  )
})

/* ========================================================================
 * F6: the /viking command
 * ===================================================================== */

test('the command parser maps the read verbs and v0.5 write verbs', () => {
  assert.deepEqual(parseVikingCommand(''), { subcommand: 'status', argument: '' })
  assert.deepEqual(parseVikingCommand('   '), { subcommand: 'status', argument: '' })
  assert.deepEqual(parseVikingCommand(' status '), { subcommand: 'status', argument: '' })
  assert.deepEqual(parseVikingCommand('status'), { subcommand: 'status', argument: '' })
  assert.deepEqual(parseVikingCommand('doctor'), { subcommand: 'doctor', argument: '' })
  assert.deepEqual(parseVikingCommand('recall why did this recall'), {
    subcommand: 'recall',
    argument: 'why did this recall',
  })
  assert.deepEqual(parseVikingCommand('open viking://user/default/memories/x.md'), {
    subcommand: 'open',
    argument: 'viking://user/default/memories/x.md',
  })
  assert.deepEqual(parseVikingCommand('help'), { subcommand: 'help', argument: '' })
  assert.deepEqual(parseVikingCommand('?'), { subcommand: 'help', argument: '' })
  assert.deepEqual(parseVikingCommand('RECALL x'), { subcommand: 'recall', argument: 'x' })
  // v0.5 opens the write verbs; the ones that need an upstream API stay unknown.
  for (const verb of ['edit', 'forget', 'tag', 'commit', 'undo', 'audit']) {
    assert.equal(parseVikingCommand(verb).subcommand, verb, `${verb} is a write verb`)
  }
  for (const verb of ['remember', 'pause', 'resume', 'write']) {
    assert.equal(parseVikingCommand(verb).subcommand, 'unknown', `${verb} is not a /viking verb`)
  }
  assert.match(VIKING_USAGE, /status/)
  assert.match(VIKING_WRITE_USAGE, /commit/)
  assert.match(vikingUsage(true), /forget/)
  assert.match(vikingUsage(false), /Writes are off/i)
})

test('doctor markers map each check status', () => {
  assert.equal(doctorMarker('ok'), '✓')
  assert.equal(doctorMarker('warn'), '!')
  assert.equal(doctorMarker('error'), '✗')
  assert.equal(doctorMarker('skipped'), '–')
  assert.equal(doctorMarker('unknown'), '·')
})

/** The command's services, all faked: the verbs are what is under test. */
function commandDeps(overrides = {}) {
  const calls = []
  const deps = {
    api: {
      health: async () => ({ ok: true, version: '0.5.3', authMode: 'dev', error: null }),
    },
    connection: { endpoint: 'http://127.0.0.1:1933', apiKey: '', account: 'default', user: 'default' },
    commit: {
      pluginMounted: () => true,
      status: async (sessionId) => {
        calls.push(['status', sessionId])
        return {
          sessionId,
          ovSessionId: `dsh-${sessionId}`,
          pendingTokens: 123,
          threshold: 20000,
          ratio: 0.01,
          commitCount: 3,
          lastCommitAt: '2026-11-01T00:00:00Z',
          phase: 'idle',
          latest: { archiveUri: 'viking://x/history/archive_003', state: 'done', failure: null, markers: true },
          archives: [],
        }
      },
    },
    recall: {
      recall: async (sessionId, query, limit) => {
        calls.push(['recall', sessionId, query, limit])
        return {
          sessionId,
          ovSessionId: `dsh-${sessionId}`,
          sessionUri: null,
          peer: null,
          query: { text: query, source: 'manual' },
          buckets: [
            {
              bucket: 'memories',
              items: [
                {
                  uri: 'viking://user/default/memories/entities/x/a.md',
                  score: 0.812,
                  contextType: 'memory',
                  memoryType: 'entity',
                  level: 2,
                  abstract: 'A private memory body that must not be echoed in full.',
                  tags: [],
                },
              ],
            },
          ],
          plan: null,
          targets: [],
          total: 1,
          latencyMs: 12,
          searchedAt: '2026-11-01T00:00:00Z',
          warnings: [],
        }
      },
    },
    doctor: {
      report: async () => ({
        observedAt: '2026-11-01T00:00:00Z',
        endpoint: 'http://127.0.0.1:1933',
        health: { healthy: true, version: '0.5.3', authMode: 'dev', latencyMs: 2, error: null },
        connection: { endpoint: 'http://127.0.0.1:1933', origins: [] },
        identity: {},
        plugin: {},
        session: {},
        capabilities: {},
        checks: [
          { id: 'endpoint', status: 'ok', value: 'http://127.0.0.1:1933', hint: null },
          { id: 'rules', status: 'warn', value: '404', hint: 'doctor.hint.rules' },
        ],
        compatibility: {},
        warnings: [],
        diagnostics: {},
      }),
    },
    preview: {
      preview: async (uri) => {
        calls.push(['preview', uri])
        return {
          uri,
          stat: { uri, name: 'x.md', size: 10, mode: 420, isDir: false, isLocked: false, modifiedAt: '2026-11-01T00:00:00Z', contextType: 'memory', memoryType: 'entities', category: null, tags: [] },
          tiers: [
            { id: 'l0', text: 'abstract text', truncated: false, available: true, placeholder: false, error: null },
            { id: 'l1', text: 'overview text', truncated: false, available: true, placeholder: false, error: null },
            { id: 'l2', text: 'full text', truncated: false, available: true, placeholder: false, error: null },
          ],
          studioUrl: 'http://127.0.0.1:1933/studio/',
          observedAt: '2026-11-01T00:00:00Z',
          warnings: [],
        }
      },
    },
    dshVersion: () => '0.2.2-rc.1',
    memoryPluginVersion: () => '0.5.33',
    // v0.5 command deps: the write protocol is exercised in test/v05-units.test.mjs;
    // here it only has to exist so the read verbs keep working.
    writesEnabled: () => true,
    identity: () => ({
      profileId: null,
      profileLabel: null,
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      account: 'default',
      user: 'default',
      peer: null,
      fingerprint: 'sha256:' + 'a'.repeat(64),
    }),
    writes: {
      prepare: async () => ({ ok: false, error: { code: 'writes-disabled', message: 'test stub' } }),
      execute: async () => ({ ok: false, error: { code: 'token-mismatch', message: 'test stub' } }),
      plan: async () => ({ ok: false, error: { code: 'undo-unavailable', message: 'test stub' } }),
      undo: async () => ({ ok: false, error: { code: 'undo-unavailable', message: 'test stub' } }),
    },
    audit: { recentLines: () => [], append: () => ({ ok: true, id: null, error: null }) },
    ...overrides,
  }
  const runner = new VikingCommand(deps)
  return { runner, calls, deps }
}

test('status names the endpoint, identity, plugin and session state', async () => {
  const { runner } = commandDeps()
  const result = await runner.run(' status ', 'session-1')
  assert.equal(result.kind, 'success')
  for (const fragment of [
    'OpenViking 0.5.3',
    'healthy',
    'http://127.0.0.1:1933',
    'default/default',
    '@openviking/dsh-memory-plugin 0.5.33',
    '0.2.2-rc.1',
    'Session session-1: 123 pending tokens (threshold 20000)',
    '3 commits',
    'Writes: enabled',
    'no profile',
  ]) {
    assert.ok(result.text.includes(fragment), `status shows ${fragment}`)
  }
})

test('status degrades when the plugin or the session state is unavailable', async () => {
  const { runner } = commandDeps({
    api: { health: async () => ({ ok: false, version: null, authMode: null, error: 'boom' }) },
    memoryPluginVersion: () => null,
    commit: {
      pluginMounted: () => false,
      status: async () => {
        throw new Error('session route down')
      },
    },
  })
  const result = await runner.run('', 'session-2')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /unreachable/)
  assert.match(result.text, /not installed/)
  assert.match(result.text, /commit state unavailable \(session route down\)/)
})

test('doctor prints one short line per check', async () => {
  const { runner } = commandDeps()
  const result = await runner.run('doctor', 'session-1')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Doctor · http:\/\/127\.0\.0\.1:1933 · server 0\.5\.3 · healthy/)
  assert.match(result.text, /✓ endpoint: http:\/\/127\.0\.0\.1:1933/)
  assert.match(result.text, /! rules: 404/)
})

test('recall runs this session and lists scored hits without full bodies', async () => {
  const { runner, calls } = commandDeps()
  const result = await runner.run('recall what did we decide', 'session-7')
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls.find((call) => call[0] === 'recall'), ['recall', 'session-7', 'what did we decide', 8])
  assert.match(result.text, /Recall “what did we decide” · 1 hits/)
  assert.match(result.text, /memories \(1\)/)
  assert.match(result.text, /0\.81 entity viking:\/\/user\/default\/memories\/entities\/x\/a\.md/)
  assert.match(result.text, /A private memory body/)
  // The abstract is front-and-centre, but the whole body never is.
  assert.equal(result.text.includes('\n\n\n'), false)

  const usage = await runner.run('recall', 'session-7')
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /Usage: \/viking recall <query>/)
})

test('open prints stat and the capped L0/L1 text, and refuses non-viking paths', async () => {
  const { runner, calls } = commandDeps()
  const result = await runner.run('open viking://user/default/memories/entities/x/a.md', 'session-1')
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls.find((call) => call[0] === 'preview'), ['preview', 'viking://user/default/memories/entities/x/a.md'])
  for (const fragment of ['viking://user/default/memories/entities/x/a.md', 'memory/entities', 'L0: abstract text', 'L1: overview text', 'Full view: open the OpenViking preview tab']) {
    assert.ok(result.text.includes(fragment), `open shows ${fragment}`)
  }

  const invalid = await runner.run('open /etc/passwd', 'session-1')
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /Usage: \/viking open/)
})

test('open reports a missing entry as an error result instead of throwing', async () => {
  const { runner } = commandDeps({
    preview: {
      preview: async () => {
        throw new PreviewFailure('not-found', 'not-found')
      },
    },
  })
  const result = await runner.run('open viking://user/default/memories/nope.md', 'session-1')
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'OpenViking has no such entry.', 'the raw code is rendered as a sentence')
})

test('help and an unknown verb render the usage', async () => {
  const { runner } = commandDeps()
  const help = await runner.run('help', 'session-1')
  assert.equal(help.kind, 'success')
  assert.equal(help.text, vikingUsage(true))
  const readOnly = await commandDeps({ writesEnabled: () => false })
  const helpOff = await readOnly.runner.run('help', 'session-1')
  assert.equal(helpOff.kind, 'success')
  assert.match(helpOff.text, /Writes are off/i)
  const unknown = await runner.run('remember', 'session-1')
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown \/viking command/)
  assert.match(unknown.text, /forget/)
})

test('the registry definition takes the session id from invocation.agent.id', async () => {
  const { runner, calls } = commandDeps()
  const definition = vikingCommandDefinition(runner)
  assert.equal(definition.name, 'viking')
  assert.match(definition.description, /curate/i)
  assert.match(definition.input.hint, /forget/)
  assert.match(definition.input.hint, /undo/)

  const success = await definition.handler({
    agent: { id: 'session-9' },
    rawInput: ' status',
    signal: { aborted: false },
  })
  assert.equal(success.kind, 'success')
  assert.equal(calls.some((call) => call[0] === 'status' && call[1] === 'session-9'), true)

  const missingSession = await definition.handler({ agent: {}, rawInput: 'status' })
  assert.equal(missingSession.kind, 'error')
  assert.match(missingSession.text, /session id/)

  const aborted = await definition.handler({ agent: { id: 's' }, rawInput: 'status', signal: { aborted: true } })
  assert.equal(aborted.kind, 'error')
  assert.match(aborted.text, /Cancelled/)
})

test('the /viking command threads cancellation into every long verb', async () => {
  // The signal reaches the service it may be spent in, and the command returns
  // ONE cancellation result instead of a partial answer.
  const recallController = new AbortController()
  const recallSignals = []
  const recallRun = commandDeps({
    recall: {
      recall: async (sessionId, query, limit, options) => {
        recallSignals.push(options?.signal)
        recallController.abort()
        return {
          sessionId,
          ovSessionId: `dsh-${sessionId}`,
          sessionUri: null,
          peer: null,
          query: { text: query, source: 'manual' },
          buckets: [],
          plan: null,
          targets: [],
          total: 0,
          latencyMs: 1,
          searchedAt: '2026-11-01T00:00:00Z',
          warnings: [],
        }
      },
    },
  })
  const recalled = await recallRun.runner.run('recall anything', 'session-1', recallController.signal)
  assert.deepEqual(recalled, { kind: 'error', text: 'Cancelled.' })
  assert.equal(recallSignals[0], recallController.signal, 'recall receives the caller signal')

  // doctor: abort during the report; the result must not be printed.
  const doctorController = new AbortController()
  const doctorSignals = []
  const doctorRun = commandDeps({
    doctor: {
      report: async (_sessionId, options) => {
        doctorSignals.push(options.signal)
        doctorController.abort()
        return {}
      },
    },
  })
  const doctored = await doctorRun.runner.run('doctor', 'session-1', doctorController.signal)
  assert.deepEqual(doctored, { kind: 'error', text: 'Cancelled.' })
  assert.equal(doctorSignals[0], doctorController.signal, 'doctor receives the caller signal')

  // open: abort during the preview read.
  const openController = new AbortController()
  const openSignals = []
  const openRun = commandDeps({
    preview: {
      preview: async (_uri, options) => {
        openSignals.push(options.signal)
        openController.abort()
        return {}
      },
    },
  })
  const opened = await openRun.runner.run('open viking://user/default/memories/x.md', 'session-1', openController.signal)
  assert.deepEqual(opened, { kind: 'error', text: 'Cancelled.' })
  assert.equal(openSignals[0], openController.signal, 'preview receives the caller signal')
})

test('a command cancelled before it starts makes no request at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const { runner, calls } = commandDeps()
  for (const rawInput of ['status', 'doctor', 'recall something', 'open viking://user/default/memories/x.md']) {
    const result = await runner.run(rawInput, 'session-1', controller.signal)
    assert.deepEqual(result, { kind: 'error', text: 'Cancelled.' })
  }
  assert.deepEqual(calls, [], 'nothing was asked of the server')

  // The registry handler passes its own signal through too.
  const definition = vikingCommandDefinition(runner)
  const handlerResult = await definition.handler({ agent: { id: 'session-1' }, rawInput: ' status', signal: controller.signal })
  assert.deepEqual(handlerResult, { kind: 'error', text: 'Cancelled.' })
})

test('host error codes are rendered as sentences for command output', () => {
  assert.equal(commandErrorText('not-found'), 'OpenViking has no such entry.')
  assert.equal(commandErrorText('not-a-viking-path'), 'Only viking:// paths can be previewed.')
  assert.equal(commandErrorText('invalid-experience-uri'), 'That is not an Experience file path.')
  // Server messages and unknown codes are diagnostics and pass through.
  assert.equal(commandErrorText('HTTP 500'), 'HTTP 500')
  assert.equal(commandErrorText('something the server said'), 'something the server said')
})

/* ========================================================================
 * Routes, config and optional command registration
 * ===================================================================== */

const DEAD_ENDPOINT = 'http://127.0.0.1:9'

test('the v0.4 switches are volatile booleans defaulting to on, and the host activates with them', async () => {
  for (const field of ['showPreview', 'showExplore', 'enableCommands']) {
    const defaults = Config({})
    assert.equal(typeof defaults[field]?.get, 'function', `${field} arrives as a volatile reference`)
    assert.equal(defaults[field].get(), true, `${field} defaults to on`)
    const off = Config({ [field]: false })
    assert.equal(off[field].get(), false, `${field} resolves false`)
  }

  for (const resolved of [
    Config({ endpoint: DEAD_ENDPOINT }),
    Config({ endpoint: DEAD_ENDPOINT, showPreview: false, showExplore: false, enableCommands: false }),
  ]) {
    const { context, state } = hostContext()
    assert.doesNotThrow(() => apply(context, resolved), 'activation survives the v0.4 switches')
    assert.ok(state.routes.length >= 16, `every route is registered (saw ${state.routes.length})`)
  }
})

test('the v0.4 routes are registered with their documented paths', () => {
  const { context, state } = hostContext()
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  const paths = state.routes.map((route) => route.path).sort()
  for (const path of [
    '/api/openviking-enhance/preview',
    '/api/openviking-enhance/search',
    '/api/openviking-enhance/rules/search',
    '/api/openviking-enhance/rules',
    '/api/openviking-enhance/skills',
    '/api/openviking-enhance/experience',
  ]) {
    assert.ok(paths.includes(path), `${path} is registered`)
  }
  // Nothing write-capable was added: every v0.4 POST path is one of the two
  // documented read-only operations.
  const v04Post = state.routes
    .filter((route) => ['/preview', '/search', '/rules/search', '/rules', '/skills', '/experience'].some((suffix) => route.path.endsWith(suffix)))
    .map((route) => route.path)
  assert.deepEqual(v04Post.sort(), [
    '/api/openviking-enhance/experience',
    '/api/openviking-enhance/preview',
    '/api/openviking-enhance/rules',
    '/api/openviking-enhance/rules/search',
    '/api/openviking-enhance/search',
    '/api/openviking-enhance/skills',
  ])
})

test('GET-only routes still answer 405 to a POST', async () => {
  const { context, state } = hostContext()
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  for (const path of ['/config', '/preview?uri=viking://x', '/rules', '/skills']) {
    const route = findRoute(state.routes, path.split('?')[0])
    const answer = await callRoute(route, postRequest({ body: {}, headers: { 'content-type': 'application/json' } }))
    assert.equal(answer.status, 405, `${path} refuses POST`)
    assert.equal(answer.body.ok, false)
  }
})

test('the JSON POST fence refuses cross-origin, wrong type and oversized bodies', async () => {
  const { context, state } = hostContext()
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  const route = findRoute(state.routes, '/search')

  // The same-origin POST from the application document reaches the handler.
  const sameOrigin = await callRoute(
    route,
    postRequest({
      body: { query: 'x' },
      headers: { 'content-type': 'application/json' },
      origin: 'http://127.0.0.1:19387',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    }),
  )
  assert.equal(sameOrigin.status, 200, 'a same-origin loopback POST is admitted')
  assert.equal(sameOrigin.body.ok, false, 'and the dead server is reported, not thrown')

  const cases = [
    ['cross-origin', postRequest({ body: { query: 'x' }, headers: { 'content-type': 'application/json' }, origin: 'http://evil.example.com' }), 403],
    ['cross-site fetch', postRequest({ body: { query: 'x' }, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }), 403],
    ['public host', postRequest({ body: { query: 'x' }, headers: { 'content-type': 'application/json' }, host: 'dsh.example.com' }), 403],
    ['wrong content type', postRequest({ body: { query: 'x' }, headers: { 'content-type': 'text/plain' } }), 415],
    [
      'oversized body',
      postRequest({ body: { query: 'x' }, headers: { 'content-type': 'application/json', 'content-length': String(READ_ONLY_JSON_BODY_MAX + 1) } }),
      413,
    ],
    ['invalid JSON', postRequest({ body: '{oops', headers: { 'content-type': 'application/json' } }), 400],
    ['missing query', postRequest({ body: {}, headers: { 'content-type': 'application/json' } }), 400],
  ]
  for (const [label, request, expected] of cases) {
    const answer = await callRoute(route, request)
    assert.equal(answer.status, expected, `${label} → ${expected} (saw ${answer.status})`)
    assert.equal(answer.body.ok, false, `${label} answers an ok:false envelope`)
  }

  const rulesRoute = findRoute(state.routes, '/rules/search')
  const missingContext = await callRoute(
    rulesRoute,
    postRequest({ body: {}, headers: { 'content-type': 'application/json' } }),
  )
  assert.equal(missingContext.status, 400)
  assert.equal(missingContext.body.error, 'taskContext is required')
})

test('the preview route validates its URI and answers without throwing', async () => {
  const { context, state } = hostContext()
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  const route = findRoute(state.routes, '/preview')

  const missing = await callRoute(route, getRequest({ url: '/?uri=' }))
  assert.equal(missing.status, 400)
  assert.equal(missing.body.ok, false)

  const invalid = await callRoute(route, getRequest({ url: '/?uri=file%3A%2F%2F%2Fetc%2Fpasswd' }))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error, 'not-a-viking-path')

  // A viking:// URI with no server behind it: an ok:false envelope, never a throw.
  const unreadable = await callRoute(route, getRequest({ url: '/?uri=viking%3A%2F%2Fuser%2Fdefault' }))
  assert.equal(unreadable.status, 200)
  assert.equal(unreadable.body.ok, false)
  assert.equal(typeof unreadable.body.error, 'string')
})

test('the catalogue routes answer ok:false instead of throwing on a dead server', async () => {
  const { context, state } = hostContext()
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  for (const path of ['/rules', '/skills', '/experience?kind=trajectories', '/experience?kind=outcomes&experienceUri=viking%3A%2F%2Fuser%2Fdefault%2Fmemories%2Fexperiences%2Fx.md']) {
    const route = findRoute(state.routes, path.split('?')[0])
    const answer = await callRoute(route, getRequest({ url: path }))
    assert.equal(answer.status, 200, `${path} answers 200 with an envelope`)
    assert.equal(answer.body.ok, false, `${path} reports the failure in JSON`)
    assert.equal(typeof answer.body.error, 'string')
  }
})

test('the command is registered optionally and lives behind enableCommands', async () => {
  // A composition with the command service: one `/viking` definition.
  const registry = commandRegistry()
  const { context } = hostContext({ commands: registry })
  apply(context, Config({ endpoint: DEAD_ENDPOINT }))
  assert.equal(registry.definitions.length, 1)
  assert.equal(registry.definitions[0].name, 'viking')

  // Its handler works through the real route services (dead server: the status
  // text says so, without throwing).
  const result = await registry.definitions[0].handler({
    agent: { id: 'session-1' },
    rawInput: ' status',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, new RegExp(DEAD_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  // A composition without the service: no command, and no activation failure.
  const without = hostContext({ commands: null })
  assert.doesNotThrow(() => apply(without.context, Config({ endpoint: DEAD_ENDPOINT })))
  assert.equal(without.state.routes.length >= 16, true, 'the routes still mount')

  // An inject that never runs (the service is absent/waiting) is not an error.
  const waiting = hostContext({ commands: registry, injectMode: 'wait' })
  assert.doesNotThrow(() => apply(waiting.context, Config({ endpoint: DEAD_ENDPOINT })))
  assert.deepEqual(waiting.state.injected.includes('commands'), true)

  // A command switch saved off: nothing registers.
  const offRegistry = commandRegistry()
  apply(hostContext({ commands: offRegistry }).context, Config({ endpoint: DEAD_ENDPOINT, enableCommands: false }))
  assert.equal(offRegistry.definitions.length, 0)

  // A refusal from the registry is logged, not thrown.
  const throwing = {
    register() {
      throw new Error('registry exploded')
    },
  }
  const broken = hostContext({ commands: throwing })
  assert.doesNotThrow(() => apply(broken.context, Config({ endpoint: DEAD_ENDPOINT })))
  assert.match(String(broken.state.warns[0]?.[0] ?? ''), /failed to register \/viking/)
})

test('an activation reads the enableCommands reference and registers accordingly', () => {
  // Activation path: startup, or a re-apply caused by a save that reloads the
  // entry. Each apply reads the reference it was handed, in either polarity.
  // (The volatile-only save path is covered by the loader/volatile-update test
  // below — a volatile-only save does not re-apply the entry by itself.)
  const on = commandRegistry()
  apply(hostContext({ commands: on }).context, Config({ endpoint: DEAD_ENDPOINT, enableCommands: true }))
  assert.equal(on.definitions.length, 1)

  const off = commandRegistry()
  apply(hostContext({ commands: off }).context, Config({ endpoint: DEAD_ENDPOINT, enableCommands: false }))
  assert.equal(off.definitions.length, 0)
})

test('a volumetric config save toggles the command live through loader/volatile-update', () => {
  // The Loader emits `loader/volatile-update` for a volatile-only save
  // (cordis-plugin-loader does). The host half must hear it and register or
  // unregister the command in place — no duplicate definition, no dead handler.
  let enabled = true
  const config = { enableCommands: { get: () => enabled } }
  const registry = commandRegistry()
  const { context, state } = hostContext({ commands: registry })
  apply(context, config)
  assert.equal(registry.definitions.length, 1, 'the command starts registered')

  const fire = state.listeners.get('loader/volatile-update')
  assert.equal(typeof fire, 'function', 'the plugin listens for volatile-only config saves')

  enabled = false
  fire()
  assert.equal(registry.definitions.length, 0, 'turning the switch off unregisters live')

  enabled = true
  fire()
  assert.equal(registry.definitions.length, 1, 'turning it back on registers live')

  fire()
  assert.equal(registry.definitions.length, 1, 'an unchanged answer does not duplicate the command')

  // The same path starting from off: nothing at activation, registered on the
  // first live update that enables it.
  let offEnabled = false
  const offRegistry = commandRegistry()
  const offHost = hostContext({ commands: offRegistry })
  apply(offHost.context, { enableCommands: { get: () => offEnabled } })
  assert.equal(offRegistry.definitions.length, 0)
  offEnabled = true
  offHost.state.listeners.get('loader/volatile-update')()
  assert.equal(offRegistry.definitions.length, 1)
})

test('the plugin no longer throws when the command registration fails at activation', () => {
  const routes = []
  const context = {
    webServer: { port: 0, register: (route) => (routes.push(route), () => {}) },
    effect: (callback) => (callback(), () => {}),
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  // No inject/on at all: the 0.3 production shape.
  assert.doesNotThrow(() => apply(context, Config({ endpoint: DEAD_ENDPOINT })))
  assert.ok(routes.length >= 16)
})
