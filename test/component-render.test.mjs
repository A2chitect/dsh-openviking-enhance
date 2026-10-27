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
  return { find, contributions }
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
  const { find, contributions } = loadBundle('en')
  const seats = contributions.map((entry) => entry.options.name).sort()
  assert.deepEqual(seats, [
    'conversation.composer.dock',
    'main',
    'plugins.row.config',
    'sidebar.panellist',
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
  ]) {
    assert.ok(markup.includes(label), `the form shows ${label}`)
  }
  assert.ok(markup.includes('保存'), 'and its own save control')
  assert.ok(markup.includes('已覆盖'), 'and the overridden badge')
  assert.ok(!markup.includes('Save'), 'nothing falls back to English')
})

test('the form renders the three interface switches as checkboxes that follow the saved values', () => {
  const { find } = loadBundle('en')
  const markup = renderPage(find, FORM)

  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 3, 'exactly three checkbox inputs, one per switch')
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'checked')),
    [true, true, true],
    'all three are checked when the saved values are on',
  )
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [false, false, false],
    'a writable form leaves them enabled',
  )

  // The three switches have their own rows, in the order the sidebar, the
  // composer and the right sidebar appear.
  const blocks = toggleBlocks(markup)
  assert.equal(blocks.length, 3, 'each switch is its own labelled row')
  for (const [index, label] of ['Sidebar entry', 'Commit status pill', 'Memory recall tab'].entries()) {
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
  assert.equal(checkboxes(off).length, 3)
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
  // An override is marked where it is edited, the same as every other field.
  assert.ok(offBlocks[1].includes('overridden'), 'the overridden switch carries the override badge')
})

test('a read-only form disables the three switches instead of pretending they can be edited', () => {
  const { find } = loadBundle('en')
  const readOnly = { ...FORM, state: { ...FORM.state, writable: false } }
  const markup = renderPage(find, readOnly)
  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 3)
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [true, true, true],
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
