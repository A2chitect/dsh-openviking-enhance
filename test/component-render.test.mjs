// Render the plugin's real components, without a browser.
//
// The client bundle is evaluated exactly as the shell evaluates it — the same
// `window.__ModuleLoader__.load` handoff, the same `factory(require)` — and the
// components it registers are then rendered to markup with React's server
// renderer. Nothing here is a mock-up: the markup below is what the components
// produce, including the copy layer, so this is the only check that would notice
// a panel that throws on render, a translated label that never appears, or a
// configuration form that lost its fields.
//
// Server rendering skips effects, which is exactly the shape being checked: the
// first paint, before any fetch resolves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Evaluate the bundle the way the web shell does, and return what it exports. */
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
  exportsObject.apply(strict({
    slots: {
      inject: (_key, callback) => (callback(), () => {}),
      register: (options, Component) => (contributions.push({ options, Component }), () => {}),
    },
    effect: (callback) => (callback(), () => {}),
    // Two services arrive through a scoped injection rather than a property: the
    // right Sidebar's tab registry (contributed on the SERVICE, not on the slot
    // declaration) and the app's locale, which the plugin must read here or it
    // silently falls back to the browser's language.
    inject: (deps, callback) =>
      (
        callback({
          get: (name) => {
            if (name === 'sidebarRightTabs') return { register: () => () => {} }
            if (name === 'locale' && deps.includes('locale')) return { getSnapshot: () => ({ active: locale }) }
            return undefined
          },
        }),
        { dispose() {} }
      ),
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} },
  }))

  const find = (name) => contributions.find((entry) => entry.options.name === name)
  return { find, contributions, exports: exportsObject }
}

/**
 * The shell's context, refusing what Cordis refuses.
 *
 * Reading an undeclared service property is a thrown Error there
 * (`cannot get property "x" without inject`), not a warning — the exact mistake
 * that shipped. Only the injected services, the optional `get()` accessor and the
 * context's own verbs are readable here.
 */
const DECLARED = new Set(['slots', 'effect', 'inject', 'get', 'logger'])
function strict(context) {
  return new Proxy(context, {
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      const value = Reflect.get(target, key)
      if (value === undefined && !DECLARED.has(key)) {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return value
    },
  })
}

/** The configuration snapshot the Plugins page hands a row's form. */
const FORM = {
  state: {
    status: 'ready',
    writable: true,
    mode: 'host',
    revision: 7,
    value: {
      endpoint: 'http://127.0.0.1:1933',
      apiKey: '',
      account: 'default',
      user: 'default',
      studioPath: '/studio/',
      cacheTtlMs: 2500,
      recallCacheTtlMs: 15000,
      showSidebarEntry: true,
      showCommitStatus: true,
      showRecallPanel: true,
      showRecallExplain: true,
      showHealthPanel: true,
      showPreview: true,
      showExplore: true,
      enableCommands: true,
    },
    base: { endpoint: '', studioPath: '/studio/', cacheTtlMs: 2500, recallCacheTtlMs: 15000 },
    user: { endpoint: 'http://127.0.0.1:1933' },
  },
  mutate: () => Promise.resolve(true),
}

/** Every `<input type="checkbox">` tag in a rendered form, in document order. */
function checkboxes(markup) {
  return [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0])
}

/**
 * Whether React's server renderer wrote a boolean attribute as present.
 *
 * `renderToStaticMarkup` writes `checked=""` / `disabled=""` for a true prop and
 * omits the attribute for a false one, so presence is the state.
 */
const hasAttribute = (tag, attribute) => new RegExp(`\\b${attribute}(="")?(?=[\\s/>])`).test(tag)

/** The one `.ove-config-toggle` label block wrapping each switch, in order. */
function toggleBlocks(markup) {
  return [...markup.matchAll(/<label class="ove-config-toggle">([\s\S]*?)<\/label>/g)].map(
    (match) => match[1],
  )
}

/** Render the plugin's configuration page with one form snapshot. */
function renderPage(find, form) {
  return renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'page', form }),
  )
}

test('the bundle registers every seat, and all of them render', () => {
  const { find, contributions, exports } = loadBundle('en')
  const seats = contributions.map((entry) => entry.options.name).sort()
  assert.deepEqual(seats, [
    'conversation.chat.turnTail',
    'conversation.composer.dock',
    'main',
    'plugins.detail.section',
    'plugins.row.config',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab',
  ])

  // The configuration form: the page renders it with the view it asked for.
  const markup = renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'page', form: FORM }),
  )
  for (const label of [
    'OpenViking address',
    'API key',
    'Account',
    'User',
    'Studio path',
    'Status cache (ms)',
    'Recall cache (ms)',
    // The three interface switches that mount/unmount the surfaces live.
    'Interface',
    'Sidebar entry',
    'Commit status pill',
    'Memory recall tab',
    'In-conversation memory sources',
    'Memory health tab',
    // The v0.4 switches: two new tabs and the host-side command.
    'URI preview tab',
    'Explore tab',
    '/viking command',
  ]) {
    assert.ok(markup.includes(label), `the form shows ${label}`)
  }
  assert.ok(markup.includes('Save'), 'the form has its own save control')
  assert.ok(markup.includes('overridden'), 'a field carried by the profile override is marked as such')

  // The recall tab renders its search row before any answer arrives.
  const recall = renderToStaticMarkup(
    createElement(find('sidebar.right.pane.tab').Component, { sessionId: 'session-1' }),
  )
  assert.ok(recall.includes('Search'), 'the recall tab renders its search control')
  assert.ok(recall.includes('This session&#x27;s last prompt'), 'and its placeholder')

  // The per-turn explanation tail reads the turn's prompt through the Chat
  // standard `useChat` hook; a stand-in snapshot is enough to render its trigger.
  const fakeChat = {
    locations: { getTurn: () => ['node-1'] },
    nodes: { get: () => ({ kind: 'user', data: { content: [{ type: 'text', text: 'Why did this turn recall that?' }] } }) },
  }
  const explain = renderToStaticMarkup(
    createElement(find('conversation.chat.turnTail').Component, {
      sessionId: 'session-1',
      turn: { turn: 1 },
      seq: 1,
      openFile: () => {},
      useChat: (selector) => selector(fakeChat),
    }),
  )
  assert.ok(explain.includes('Memory sources'), 'the recall explanation tail renders its trigger')

  // The Memory health tab renders its header before either request resolves.
  const health = renderToStaticMarkup(
    createElement(
      contributions.find((entry) => entry.options.key === 'dsh-openviking-enhance:health').Component,
      { sessionId: 'session-1' },
    ),
  )
  assert.ok(health.includes('OpenViking health'), 'the health tab renders its header')
  assert.ok(health.includes('Refresh'), 'and its refresh control')

  // The v0.4 preview tab renders its address bar before a target is chosen, and
  // the Explore tab renders its segmented navigation with Search selected.
  const preview = renderToStaticMarkup(
    createElement(
      contributions.find((entry) => entry.options.key === 'dsh-openviking-enhance:preview').Component,
      { sessionId: 'session-1' },
    ),
  )
  assert.ok(preview.includes('ove-preview'), 'the preview tab renders its shell')
  assert.ok(preview.includes('Paste a viking:// path'), 'and its address bar placeholder')
  assert.ok(preview.includes('No entry selected yet.'), 'and its empty state')
  const explore = renderToStaticMarkup(
    createElement(
      contributions.find((entry) => entry.options.key === 'dsh-openviking-enhance:explore').Component,
      { sessionId: 'session-1' },
    ),
  )
  assert.ok(explore.includes('ove-explore'), 'the Explore tab renders its shell')
  for (const label of ['Search', 'Rules', 'Skills', 'Experience']) {
    assert.ok(explore.includes(label), `the Explore tab offers the ${label} segment`)
  }

  // The shared viking:// link is a real button whose tooltip is the URI, and the
  // preview store is the seam every surface reaches it through.
  exports.setPreviewTarget('viking://user/default/memories/entities/x.md')
  assert.equal(
    exports.getPreviewTarget()?.uri,
    'viking://user/default/memories/entities/x.md',
    'a URI link target lands in the shared preview store',
  )
  exports.resetPreviewStore()
  assert.equal(exports.getPreviewTarget(), null, 'the store clears for the next test')
  const link = renderToStaticMarkup(
    createElement(exports.VikingUriLink, { uri: 'viking://user/default/memories/entities/x.md' }),
  )
  assert.ok(link.includes('ove-uri-link'), 'the URI link renders its shared class')
  assert.ok(link.includes('viking://user/default/memories/entities/x.md'), 'and names the URI')

  // The Plugins-page summary renders for this plugin's own page only.
  const summary = renderToStaticMarkup(
    createElement(find('plugins.detail.section').Component, {
      subject: {
        kind: 'bundle',
        pkg: {
          name: 'dsh-openviking-enhance',
          installed: true,
          availability: 'installed',
          official: false,
          enabled: true,
          rows: [],
        },
      },
    }),
  )
  assert.ok(summary.includes('OpenViking health'), 'the plugin-page health summary renders')

  // The pill renders in the dock, and the centre panel renders while it waits
  // for the host: neither may throw with an absent fetch.
  assert.ok(
    renderToStaticMarkup(
      createElement(find('conversation.composer.dock').Component, { sessionId: 'session-1' }),
    ).includes('ove-pill'),
    'the commit pill renders',
  )
  assert.ok(
    renderToStaticMarkup(createElement(find('main').Component)).includes('ove-panel'),
    'the Studio panel renders',
  )
})

test('the commit diff browser renders its filters and an expanded line diff', () => {
  const { exports } = loadBundle('en')
  const diff = {
    archiveUri: 'viking://user/demo/sessions/demo/history/archive_003',
    extractedAt: '2026-10-02T07:55:00Z',
    adds: [],
    updates: [
      {
        uri: 'viking://user/demo/memories/entities/project/sidebar-row-order.md',
        memoryType: 'entity',
        before: 'Rows sort by order.',
        after: 'Rows sort by order ascending.',
      },
    ],
    deletes: [],
    summary: { totalAdds: 0, totalUpdates: 1, totalDeletes: 0, totalSkipped: 0 },
  }
  const markup = renderToStaticMarkup(createElement(exports.DiffView, { diff }))
  for (const label of ['All', 'Added', 'Updated', 'Deleted', 'Export JSON']) {
    assert.ok(markup.includes(label), `the diff browser renders ${label}`)
  }
  assert.ok(markup.includes('ove-diff-filter'), 'the filters are real controls')
  const entry = renderToStaticMarkup(
    createElement(exports.DiffEntry, { entry: diff.updates[0], kind: 'updates', open: true, onToggle: () => {} }),
  )
  assert.ok(entry.includes('ove-diff-line-add'), 'an expanded update shows added lines')
  assert.ok(entry.includes('ove-diff-line-remove'), 'an expanded update shows removed lines')
})

test('the same components render in Chinese when the app is set to it', () => {
  const { find } = loadBundle('zh')
  const markup = renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'page', form: FORM }),
  )
  for (const label of [
    'OpenViking 地址',
    'API Key',
    'Account',
    'User',
    'Studio 路径',
    '状态缓存（毫秒）',
    '召回缓存（毫秒）',
    // The three interface switches are translated too, not left in English.
    '界面开关',
    '左侧边栏入口',
    '提交状态胶囊',
    '记忆召回标签页',
    '对话内记忆来源',
    '记忆健康标签页',
    'URI 预览 tab',
    '探索 tab',
    '/viking 命令',
  ]) {
    assert.ok(markup.includes(label), `the form shows ${label}`)
  }
  assert.ok(markup.includes('保存'), 'and its own save control')
  assert.ok(markup.includes('已覆盖'), 'and the overridden badge')
  assert.ok(!markup.includes('Save'), 'nothing falls back to English')
})

test('the form renders the eight interface switches as checkboxes that follow the saved values', () => {
  const { find } = loadBundle('en')
  const markup = renderPage(find, FORM)

  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 8, 'exactly eight checkbox inputs, one per switch')
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'checked')),
    [true, true, true, true, true, true, true, true],
    'all eight are checked when the saved values are on',
  )
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [false, false, false, false, false, false, false, false],
    'a writable form leaves them enabled',
  )

  // The eight switches have their own rows, in the order the sidebar, the
  // composer and the conversation, then the right sidebar, appear.
  const blocks = toggleBlocks(markup)
  assert.equal(blocks.length, 8, 'each switch is its own labelled row')
  for (const [index, label] of [
    'Sidebar entry',
    'Commit status pill',
    'Memory recall tab',
    'In-conversation memory sources',
    'Memory health tab',
    'URI preview tab',
    'Explore tab',
    '/viking command',
  ].entries()) {
    assert.ok(blocks[index].includes(label), `switch ${index + 1} is the ${label} row`)
    assert.equal(checkboxes(blocks[index]).length, 1, `the ${label} row has exactly one checkbox`)
  }

  // A saved `false` reaches its own checkbox as unchecked, and does not leak into
  // the other two. This is the whole point of the form: the switch reflects what
  // the browser half will do with the surface.
  const off = renderPage(find, {
    ...FORM,
    state: {
      ...FORM.state,
      value: { ...FORM.state.value, showCommitStatus: false },
      user: { ...FORM.state.user, showCommitStatus: false },
    },
  })
  const offBlocks = toggleBlocks(off)
  assert.equal(checkboxes(off).length, 8)
  assert.equal(
    hasAttribute(checkboxes(offBlocks[0])[0], 'checked'),
    true,
    'the sidebar switch stays on',
  )
  assert.equal(
    hasAttribute(checkboxes(offBlocks[1])[0], 'checked'),
    false,
    'the saved-off commit switch is unchecked',
  )
  assert.equal(
    hasAttribute(checkboxes(offBlocks[2])[0], 'checked'),
    true,
    'the recall switch stays on',
  )
  assert.equal(
    hasAttribute(checkboxes(offBlocks[3])[0], 'checked'),
    true,
    'the explanation switch stays on',
  )
  assert.equal(
    hasAttribute(checkboxes(offBlocks[4])[0], 'checked'),
    true,
    'the health switch stays on',
  )
  // A v0.4-only switch behaves the same way: its own checkbox, nothing else.
  const previewOff = renderPage(find, {
    ...FORM,
    state: {
      ...FORM.state,
      value: { ...FORM.state.value, showPreview: false, showExplore: false, enableCommands: false },
    },
  })
  const previewBlocks = toggleBlocks(previewOff)
  assert.deepEqual(
    previewBlocks.map((block) => hasAttribute(checkboxes(block)[0], 'checked')),
    [true, true, true, true, true, false, false, false],
    'the three v0.4 switches turn off independently',
  )
  // An override is marked where it is edited, the same as every other field.
  assert.ok(offBlocks[1].includes('overridden'), 'the overridden switch carries the override badge')
})

test('a read-only form disables the eight switches instead of pretending they can be edited', () => {
  const { find } = loadBundle('en')
  const readOnly = { ...FORM, state: { ...FORM.state, writable: false } }
  const markup = renderPage(find, readOnly)
  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 8)
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [true, true, true, true, true, true, true, true],
    'every switch is disabled when the profile cannot be written',
  )
  assert.ok(markup.includes('read-only'), 'the form also explains why it cannot be edited')
})

test('a deployment that cannot write says so instead of offering a dead save', () => {
  const { find } = loadBundle('en')
  const readOnly = { ...FORM, state: { ...FORM.state, writable: false } }
  const markup = renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'page', form: readOnly }),
  )
  assert.ok(markup.includes('read-only'), 'the form explains why it cannot be edited')
})

test('a deployment without the settings service renders an explanation, not a blank page', () => {
  const { find } = loadBundle('en')
  const unavailable = { ...FORM, state: { ...FORM.state, status: 'unavailable' } }
  const markup = renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'page', form: unavailable }),
  )
  assert.ok(markup.includes('cordis.patch.yml'), 'the fallback names where to configure it instead')
})

test('the row summary is the one-liner the page asks for', () => {
  const { find } = loadBundle('en')
  const summary = renderToStaticMarkup(
    createElement(find('plugins.row.config').Component, { view: 'summary', form: FORM }),
  )
  assert.ok(summary.includes('http://127.0.0.1:1933'), 'the summary names the endpoint in force')
})
