// v1.0 bilingual parity: rendered in both languages, and formatted by Intl.
//
// `locale.test.mjs` already enforces dictionary parity and that every literal
// `t('key')` exists. This suite adds the render-level audit the v1.0 design asks
// for: the real bundle's major surfaces are rendered in EN and ZH and must not
// emit locale-key-shaped text (the `t()` fallback would look like
// `native.view.overview`), plus the evidence that the copy is really translated.
// Command output stays English by design (the host has no app locale); that is a
// documented limitation, not an untested claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import vm from 'node:vm'

import { DICTS, attachLocale, formatCount, formatDateTime, intlLocale } from '../src/client/locale.ts'

const require = createRequire(import.meta.url)
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadBundle(locale) {
  let handoff = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => (handoff = value) } },
    console,
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { append: () => {} },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
  const exportsObject = handoff.factory(require)
  const contributions = []
  exportsObject.apply({
    slots: {
      inject: (_key, callback) => (callback(), () => {}),
      register: (options, Component) => (contributions.push({ options, Component }), () => {}),
    },
    effect: (callback) => (callback(), () => {}),
    inject: (deps, callback) => {
      callback({
        get: (name) => {
          if (name === 'sidebarRightTabs') return { register: () => () => {} }
          if (name === 'locale' && deps.includes('locale')) return { getSnapshot: () => ({ active: locale }) }
          return undefined
        },
      })
      return { dispose() {} }
    },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} },
  })
  return { exports: exportsObject, contributions }
}

/** Repeatable, locale-independent test setup for the native panel. */
function nativePanelMarkup(locale) {
  attachLocale({ getSnapshot: () => ({ active: locale }) })
  const { exports, contributions } = loadBundle(locale)
  exports.resetNative()
  exports.setNativeSwitches({ nativeViews: true, onboarding: true })
  exports.__setNativeLayoutForTests(null)
  const cockpit = contributions.find((entry) => entry.options.name === 'main')
  assert.notEqual(cockpit, undefined)
  const markup = renderToStaticMarkup(createElement(cockpit.Component))
  exports.resetNative()
  return markup
}

/** Visible text only (tags stripped); entity-decoded enough for key detection. */
function visibleText(markup) {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

/**
 * Two-or-more dotted lowercase segments: how a raw locale key looks. The earlier
 * audit only caught 3+ segments, so a leaked `scope.menuTitle` or `native.loading`
 * slipped through (review S6). A short allow-list covers legitimate dotted text.
 */
const KEY_SHAPED = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+\b/
const KEY_ALLOWLIST = new Set(['e.g', 'i.e'])
/** Version labels (`v0.8`, `0.5.3`) and `e.g` are not locale keys. */
const isAllowedToken = (token) => KEY_ALLOWLIST.has(token) || /^v?\d+(?:\.\d+)+$/.test(token)

test('the native cockpit renders without emitting raw locale keys in either language', () => {
  for (const locale of ['en', 'zh']) {
    const text = visibleText(nativePanelMarkup(locale))
    const hits = [...text.matchAll(new RegExp(KEY_SHAPED, 'g'))].map((match) => match[0]).filter((hit) => !isAllowedToken(hit))
    assert.deepEqual(hits, [], `${locale} cockpit emitted locale-key-shaped text: ${hits.join(', ')}`)
  }
})

/** The v1.0 surfaces a user can open without Studio. */
const SURFACES = [
  ['NativeBrowse', { sessionId: 's-1' }],
  ['NativeSessions', {}],
  ['NativeCommits', { sessionId: 's-1' }],
  ['NativeStats', {}],
  ['NativeOperate', { sessionId: 's-1' }],
  ['NativeObservability', {}],
  ['ActivityPanel', { sessionId: 's-1' }],
  ['ExplorePanel', { sessionId: 's-1' }],
  ['PreviewBody', { uri: 'viking://user/default/memories/preferences/tools.md' }],
  ['AccessPanel', { uri: 'viking://resources/notes.md' }],
]

test('every native surface renders in both languages without a raw locale key', () => {
  for (const locale of ['en', 'zh']) {
    const { exports } = loadBundle(locale)
    for (const [name, props] of SURFACES) {
      const Component = exports[name]
      assert.notEqual(Component, undefined, `${name} is exported`)
      const markup = renderToStaticMarkup(createElement(Component, props))
      const text = visibleText(markup)
      // A component that rendered an untranslated key would show the key text.
      const hits = [...text.matchAll(new RegExp(KEY_SHAPED, 'g'))].map((match) => match[0]).filter((hit) => !isAllowedToken(hit))
      assert.deepEqual(hits, [], `${locale} ${name} emitted locale-key-shaped text: ${hits.join(', ')}`)
    }
  }
})

test('every native cockpit view renders in both languages without a raw locale key', () => {
  // The cockpit view switch remounts a different view; the earlier audit only
  // rendered the default view (review S6). Walk every view through the real
  // bundle, including Browse/Sessions/Commits/Operate/Studio.
  const views = [
    ['overview', { view: 'overview' }],
    ['browse', { view: 'browse', browse: { uri: 'viking://user/default/memories' } }],
    ['sessions', { view: 'sessions' }],
    ['commits', { view: 'commits', commits: { sessionId: 's-1' } }],
    ['stats', { view: 'stats' }],
    ['operate', { view: 'operate' }],
    ['studio', { view: 'studio' }],
  ]
  for (const locale of ['en', 'zh']) {
    attachLocale({ getSnapshot: () => ({ active: locale }) })
    const { exports, contributions } = loadBundle(locale)
    exports.setNativeSwitches({ nativeViews: true, onboarding: true })
    const cockpit = contributions.find((entry) => entry.options.name === 'main')
    assert.notEqual(cockpit, undefined)
    for (const [name, target] of views) {
      exports.__setNativeStateForTests({ view: target.view, target })
      const markup = renderToStaticMarkup(createElement(cockpit.Component))
      const text = visibleText(markup)
      const hits = [...text.matchAll(new RegExp(KEY_SHAPED, 'g'))].map((match) => match[0]).filter((hit) => !isAllowedToken(hit))
      assert.deepEqual(hits, [], `${locale} cockpit ${name} view emitted locale-key-shaped text: ${hits.join(', ')}`)
    }
    exports.resetNative()
  }
})

test('no hardcoded English placeholders ship in the client (review S6)', () => {
  // Placeholders are user-visible text; they must come from `t()` like any other
  // copy. The only literal allowed is the URI scheme example (protocol data).
  const dir = new URL('../src/client/', import.meta.url)
  const allowed = new Set(['viking://…', 'viking://'])
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const source = readFileSync(new URL(name, dir), 'utf8')
    for (const match of source.matchAll(/placeholder="([^"]*)"/g)) {
      assert.ok(allowed.has(match[1]), `${name} ships hardcoded placeholder "${match[1]}"`)
    }
  }
})

test('the Chinese UI is actually translated, not English fallback', () => {
  const zhMarkup = nativePanelMarkup('zh')
  const zh = DICTS.zh
  for (const key of ['native.view.overview', 'native.view.browse', 'native.refresh']) {
    assert.ok(zhMarkup.includes(zh[key]), `zh cockpit shows ${key} (${zh[key]})`)
  }
  // The English word for the active view must not leak through the Chinese page.
  assert.ok(!visibleText(zhMarkup).includes('Overview'), 'the Chinese view switcher is not English')
})

test('the source tree ships no hardcoded user-facing string that bypasses the copy layer', () => {
  // A guard for the "no hardcoded English in JSX" pass: user-facing text is
  // supplied through `t()`; the only literal strings allowed in JSX children are
  // symbols/punctuation (arrows, bullets, ×, ↻) and proper nouns (OpenViking,
  // Studio, a scope/profile label). This reads the shipped sources, so it fails
  // when a new surface skips the copy layer.
  // Every client tsx file (the old five-file sample missed surfaces); TS
  // generics/code fragments inside the tag heuristic are skipped by the filters.
  const files = readdirSync(new URL('../src/client/', import.meta.url))
    .filter((name) => name.endsWith('.tsx'))
    .sort()
  const allowed = new Set(['OpenViking', 'Studio', 'JSON', 'MCP', 'OVPack', 'DSH'])
  for (const name of files) {
    const source = readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
    const jsxText = [...source.matchAll(/>([^<>{}\n]+)</g)]
      .map((match) => match[1].trim())
      .filter((text) => text.length > 0)
      // Only plain prose candidates: code fragments like `=> (item as X)` are
      // picked up by the tag heuristic but are not JSX text.
      .filter((text) => /^[A-Za-z][A-Za-z0-9 ,.!?&%'\-]*$/.test(text))
      // A member-expression fragment (`document.querySelector`) is code caught
      // between a TS generic's `>` and the next `<`, not JSX prose.
      .filter((text) => !/^[a-z][A-Za-z0-9]*\.[a-zA-Z]/.test(text))
    for (const text of jsxText) {
      const words = text.replace(/[0-9.,;:!?()\[\]{}×→←▾▸▴▾…·—\-+/%°⌘⚠🔒©®™'"#*|&]/g, ' ').match(/[A-Za-z]{3,}/g) ?? []
      for (const word of words) {
        assert.ok(allowed.has(word), `${name} renders hardcoded text "${text}" (word "${word}") — use t()`)
      }
    }
  }
})

test('dates and counts use Intl for the active language', () => {
  attachLocale({ getSnapshot: () => ({ active: 'en-US' }) })
  assert.equal(intlLocale(), 'en-US')
  const enDate = formatDateTime('2026-11-10T12:00:00Z')
  assert.match(enDate, /2026/)
  attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
  assert.equal(intlLocale(), 'zh-CN')
  const zhDate = formatDateTime('2026-11-10T12:00:00Z')
  assert.match(zhDate, /2026/)
  assert.notEqual(enDate, zhDate, 'the two languages format the same date differently')
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime('not-a-date'), 'not-a-date', 'malformed values stay visible')
  attachLocale({ getSnapshot: () => ({ active: 'en-US' }) })
  assert.equal(formatCount(1234), '1,234')
  assert.equal(formatCount(0), '0')
})

test('both READMEs keep the same chapter structure', () => {
  // Section-level parity: the Chinese README mirrors every English chapter (the
  // headings are translated, so the count and the fenced-block count must match).
  const readmeEn = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const readmeZh = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8')
  const enHeads = [...readmeEn.matchAll(/^## /gm)].length
  const zhHeads = [...readmeZh.matchAll(/^## /gm)].length
  assert.equal(zhHeads, enHeads, 'README.zh.md has the same number of chapters as README.md')
  // The v1.0 ledger/matrix sections are row-for-row mirrored; `v10-docs` asserts
  // that. Whole-file table counts differed historically for unrelated prose
  // tables, so this test only pins the chapter skeleton.
})
