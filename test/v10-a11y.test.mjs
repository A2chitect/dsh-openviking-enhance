// v1.0 accessibility: WCAG 2.2 AA-aligned behaviour for the plugin's own widgets.
//
// The bar is "DOM/component assertions plus a manual checklist" (v1.0 design
// §2.1, Lead sign-off decision 2): no browser, no axe, no new dependency. Two
// layers are tested:
//
//  1. the pure keyboard/ARIA helpers in `src/client/a11y.ts` (roving tabindex,
//     tree model, Tab trap, live-region mapping) — exact behaviour, no DOM needed;
//  2. the built bundle's real components server-rendered, asserting the ARIA
//     wiring that has to survive a refactor (tablist/tab/tabpanel + ids,
//     `aria-controls`, roving `tabIndex`, the toast live region, dialog
//     `aria-modal`, the scope trigger's `aria-haspopup`).
//
// Keyboard focus *movement* is a DOM effect and is implemented in the components
// with these helpers; it is covered by the manual checklist in ACCEPTANCE.md
// (the design records the absence of browser automation as a limitation, not a
// claim of automated conformance).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import vm from 'node:vm'

import { DICTS } from '../src/client/locale.ts'
import {
  FOCUSABLE_SELECTOR,
  clampIndex,
  flattenTreeRows,
  liveRegionForTone,
  nextFocusIndex,
  nextMenuIndex,
  nextRovingIndex,
  nextTabIndex,
  treeKeyTarget,
} from '../src/client/a11y.ts'

/* ========================================================================
 * Pure helpers
 * ===================================================================== */

test('roving index wraps in both directions and honours Home/End', () => {
  assert.equal(nextRovingIndex(0, 3, 'ArrowDown', 'vertical'), 1)
  assert.equal(nextRovingIndex(2, 3, 'ArrowDown', 'vertical'), 0, 'Down wraps to the start')
  assert.equal(nextRovingIndex(0, 3, 'ArrowUp', 'vertical'), 2, 'Up wraps to the end')
  assert.equal(nextRovingIndex(1, 3, 'Home'), 0)
  assert.equal(nextRovingIndex(1, 3, 'End'), 2)
  assert.equal(nextRovingIndex(1, 3, 'ArrowDown', 'horizontal'), null, 'vertical-only key ignored')
  assert.equal(nextRovingIndex(1, 3, 'Enter'), null)
  assert.equal(nextRovingIndex(1, 0, 'ArrowDown'), null)
})

test('tab strips are horizontal and skip nothing by accident', () => {
  assert.equal(nextTabIndex(0, 4, 'ArrowRight'), 1)
  assert.equal(nextTabIndex(3, 4, 'ArrowRight'), 0)
  assert.equal(nextTabIndex(0, 4, 'ArrowLeft'), 3)
  assert.equal(nextTabIndex(2, 4, 'Home'), 0)
  assert.equal(nextTabIndex(2, 4, 'End'), 3)
  assert.equal(nextTabIndex(2, 4, 'Tab'), null, 'Tab is the browser’s job, not ours')
  assert.equal(clampIndex(-1, 3), 2)
})

test('the dialog Tab trap wraps both ways and survives focus outside the dialog', () => {
  assert.equal(nextFocusIndex(0, 3, false), 1)
  assert.equal(nextFocusIndex(2, 3, false), 0, 'forward wraps')
  assert.equal(nextFocusIndex(0, 3, true), 2, 'backward wraps')
  assert.equal(nextFocusIndex(1, 3, true), 0)
  assert.equal(nextFocusIndex(-1, 3, false), 0, 'nothing focused -> first element')
  assert.equal(nextFocusIndex(-1, 3, true), 2, 'nothing focused + Shift -> last element')
  assert.equal(nextFocusIndex(0, 0, false), -1)
})

test('menu navigation wraps and supports Home/End without changing the value', () => {
  assert.equal(nextMenuIndex(0, 3, 'ArrowDown'), 1)
  assert.equal(nextMenuIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(2, 3, 'End'), 2)
  assert.equal(nextMenuIndex(2, 3, 'Home'), 0)
  assert.equal(nextMenuIndex(-1, 3, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(1, 0, 'ArrowDown'), null)
  assert.equal(nextMenuIndex(1, 3, 'Enter'), null)
})

test('the focusable selector covers every interactive control the plugin uses', () => {
  for (const fragment of ['button:not([disabled])', 'input:not([disabled])', 'textarea:not([disabled])', 'a[href]', '[tabindex]:not([tabindex="-1"])']) {
    assert.ok(FOCUSABLE_SELECTOR.includes(fragment), `selector mentions ${fragment}`)
  }
})

test('toast tones map to assertive errors and polite status updates', () => {
  assert.deepEqual(liveRegionForTone('error'), { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' })
  for (const tone of ['success', 'warning', 'info']) {
    assert.deepEqual(liveRegionForTone(tone), { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
  }
})

const TREE_ROWS = [
  { uri: 'root-a', parentUri: null, isDir: true, expanded: true },
  { uri: 'root-a/child', parentUri: 'root-a', isDir: false, expanded: false },
  { uri: 'root-b', parentUri: null, isDir: true, expanded: false },
]

test('the tree keyboard model matches the ARIA tree pattern', () => {
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a', 'ArrowDown'), { focus: 'root-a/child', toggle: null, select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a/child', 'ArrowUp'), { focus: 'root-a', toggle: null, select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a/child', 'End'), { focus: 'root-b', toggle: null, select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-b', 'Home'), { focus: 'root-a', toggle: null, select: false })
  // Right on collapsed directory expands; expanded directory enters the child.
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-b', 'ArrowRight'), { focus: 'root-b', toggle: 'expand', select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a', 'ArrowRight'), { focus: 'root-a/child', toggle: null, select: false })
  // Left on expanded directory collapses; on a child moves to the parent.
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a', 'ArrowLeft'), { focus: 'root-a', toggle: 'collapse', select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a/child', 'ArrowLeft'), { focus: 'root-a', toggle: null, select: false })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a/child', 'Enter'), { focus: 'root-a/child', toggle: null, select: true })
  assert.deepEqual(treeKeyTarget(TREE_ROWS, 'root-a/child', ' '), { focus: 'root-a/child', toggle: null, select: true })
  assert.equal(treeKeyTarget(TREE_ROWS, 'root-a/child', 'x'), null, 'typing is not a tree key')
})

test('the visible-row flattening keeps display order, depth and parent links', () => {
  const roots = [{ uri: 'root-a' }, { uri: 'shortcut', shortcut: true }, { uri: 'root-b' }]
  const children = {
    'root-a': [
      { uri: 'root-a/dir', isDir: true },
      { uri: 'root-a/file', isDir: false },
    ],
    'root-a/dir': [{ uri: 'root-a/dir/deep', isDir: false }],
  }
  const expanded = new Set(['root-a', 'root-a/dir'])
  const rows = flattenTreeRows(
    roots,
    (uri) => children[uri],
    (uri) => expanded.has(uri),
  )
  assert.deepEqual(
    rows.map((row) => [row.uri, row.depth, row.parentUri]),
    [
      ['root-a', 0, null],
      ['root-a/dir', 1, 'root-a'],
      ['root-a/dir/deep', 2, 'root-a/dir'],
      ['root-a/file', 1, 'root-a'],
      ['root-b', 0, null],
    ],
    'shortcuts stay out of the tree; collapsed roots hide their children',
  )
})

/* ========================================================================
 * Rendered ARIA wiring (real bundle, server-rendered)
 * ===================================================================== */

const require = createRequire(import.meta.url)
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadBundle(locale = 'en') {
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
  const find = (name) => contributions.find((entry) => entry.options.name === name)
  return { find, contributions, exports: exportsObject }
}

const SCOPE = {
  profileId: 'local-default',
  profileLabel: 'Local dev',
  endpoint: 'http://127.0.0.1:1933',
  authMode: 'dev',
  account: 'default',
  user: 'default',
  peer: null,
  fingerprint: `sha256:${'b'.repeat(64)}`,
}
const SCOPE_PAYLOAD = {
  identity: SCOPE,
  activeProfileId: 'local-default',
  role: 'ROOT',
  version: '0.5.3',
  healthy: true,
  writes: { enabled: false, transport: false, reason: 'writes-disabled' },
  ops: { enabled: false, transport: true, reason: 'ops-disabled' },
  capabilities: {},
  warnings: [],
  observedAt: '2026-11-10T00:00:00Z',
}

/** Render one overlay entry by its registration id. */
function overlay(contributions, id) {
  const entry = contributions.find((candidate) => candidate.options.id === id)
  assert.ok(entry, `the ${id} overlay entry is registered`)
  return renderToStaticMarkup(createElement(entry.Component))
}

const PREPARE = {
  token: 'f'.repeat(64),
  action: 'edit-memory',
  target: 'viking://user/default/memories/preferences/tools.md',
  scope: SCOPE,
  expiresAt: Date.now() + 120_000,
  revision: { sha256: `sha256:${'c'.repeat(64)}`, size: 88, modifiedAt: null },
  preCommit: '3f2a'.repeat(10),
  content: 'Original body',
  contentTruncated: false,
  beforeChars: 13,
  afterChars: null,
  tagsBefore: null,
  tagsAfter: null,
  confirmWord: null,
  session: null,
  summary: ['Edit memory/preferences/tools.md'],
}

test('the cockpit view switcher is a complete tablist/tab/tabpanel set', () => {
  const { find, exports } = loadBundle('en')
  try {
    exports.resetNative()
    exports.setNativeSwitches({ nativeViews: true, onboarding: true })
    exports.__setNativeLayoutForTests(null)
    const markup = renderToStaticMarkup(createElement(find('main').Component))
    assert.match(markup, /role="tablist"/, 'the view switcher is a tablist')
    assert.equal((markup.match(/role="tab"/g) ?? []).length, 7, 'seven view tabs render')
    const selected = [...markup.matchAll(/role="tab"[^>]*aria-selected="true"/g)].length
    assert.equal(selected, 1, 'exactly one tab is selected')
    assert.match(markup, /aria-controls="ove-tabpanel-/, 'each tab names its panel')
    assert.match(markup, /role="tabpanel"/, 'the active view is a tabpanel')
    assert.match(markup, /aria-labelledby="ove-tab-/, 'the panel is labelled by its tab')
    // Roving tabindex: only the active tab is in the page tab order.
    assert.equal((markup.match(/tabindex="0"/g) ?? []).length >= 1, true)
    assert.equal((markup.match(/tabindex="-1"/g) ?? []).length, 6, 'the other six tabs are roving (-1)')
    // Icon-only nav buttons must have accessible names.
    assert.match(markup, /aria-label="Back"/, 'the back arrow has a name')
    assert.match(markup, /aria-label="Forward"/, 'the forward arrow has a name')
  } finally {
    exports.resetNative()
  }
})

test('the write dialog is a modal dialog and the toast is a live region', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setScopeStateForTests({ status: 'ready', scope: SCOPE_PAYLOAD, error: null })
    exports.__setWriteStateForTests({ confirm: PREPARE })
    const dialog = overlay(contributions, 'openviking-write-dialog')
    assert.match(dialog, /role="dialog"/)
    assert.match(dialog, /aria-modal="true"/)
    assert.match(dialog, /aria-label="Edit memory file"/)

    exports.__setWriteStateForTests({ confirm: null })
    exports.__setWriteStateForTests({
      notice: { tone: 'error', text: 'The write failed.', undoId: null, auditId: 'audit-1' },
    })
    const toast = overlay(contributions, 'openviking-write-toast')
    assert.match(toast, /role="alert"/, 'an error toast is announced assertively')
    assert.match(toast, /aria-live="assertive"/)
    assert.match(toast, /aria-atomic="true"/)
    exports.__setWriteStateForTests({
      notice: { tone: 'success', text: 'Saved.', undoId: 'undo-1', auditId: 'audit-2' },
    })
    const success = overlay(contributions, 'openviking-write-toast')
    assert.match(success, /role="status"/)
    assert.match(success, /aria-live="polite"/)
  } finally {
    exports.__setWriteStateForTests({
      confirm: null,
      plan: null,
      notice: null,
      busy: false,
      lastWriteSeq: 0,
      lastWriteTarget: null,
      lastWriteAction: null,
    })
    exports.__setScopeStateForTests({ status: 'idle', scope: null, error: null, switchError: null })
  }
})

test('the scope trigger announces that it opens a dialog', () => {
  const { exports } = loadBundle('en')
  try {
    exports.__setScopeStateForTests({ status: 'ready', scope: SCOPE_PAYLOAD, error: null })
    const chip = renderToStaticMarkup(createElement(exports.ScopeChip, {}))
    assert.match(chip, /aria-haspopup="dialog"/, 'the chip is a dialog opener')
    assert.match(chip, /aria-expanded="false"/, 'and starts collapsed')
    const banner = renderToStaticMarkup(createElement(exports.ScopeBanner, {}))
    assert.match(banner, /aria-haspopup="dialog"/)
  } finally {
    exports.__setScopeStateForTests({ status: 'idle', scope: null, error: null, switchError: null })
  }
})

test('the scope choices ship real menu/menuitem semantics', () => {
  // The panel is a labelled dialog (it holds the identity editor); the scope
  // choices inside it are an ARIA menu because they select a value.
  const source = readFileSync(new URL('../src/client/scope-chip.tsx', import.meta.url), 'utf8')
  assert.match(source, /role="menu"/)
  assert.match(source, /role="menuitem"/)
  assert.match(source, /nextMenuIndex/)
  assert.match(source, /aria-current/)
  for (const dict of Object.values(DICTS)) {
    assert.ok('scope.menu.servers' in dict, 'the menu has a localized accessible name')
  }
})

test('host warnings are announced politely without becoming a focus target', () => {
  const { exports } = loadBundle('en')
  const markup = renderToStaticMarkup(
    createElement(exports.NativeWarnings, {
      warnings: [{ code: 'staleDirectory', params: { uri: 'viking://user/default/memories' } }],
    }),
  )
  assert.match(markup, /role="status"/)
  assert.match(markup, /aria-live="polite"/)
  assert.match(markup, /<details/, 'the detail stays collapsible')
})

test('the a11y CSS ships the focus ring, reduced motion and zoom rules', () => {
  const { find } = loadBundle('en')
  const css = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  // The stylesheet is a template string in TS; assert the shipped rules exist.
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /outline: 2px solid/)
  assert.match(css, /max-height: calc\(100vh - 32px\)/)
  assert.match(css, /prefers-color-scheme: light/)
  assert.ok(find('main') !== undefined)
})
