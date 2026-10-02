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
    },
    base: { endpoint: '', studioPath: '/studio/', cacheTtlMs: 2500, recallCacheTtlMs: 15000 },
    user: { endpoint: 'http://127.0.0.1:1933' },
  },
  mutate: () => Promise.resolve(true),
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
  for (const label of ['OpenViking address', 'API key', 'Account', 'User', 'Studio path', 'Status cache (ms)', 'Recall cache (ms)']) {
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
  for (const label of ['OpenViking 地址', 'API Key', 'Account', 'User', 'Studio 路径', '状态缓存（毫秒）', '召回缓存（毫秒）']) {
    assert.ok(markup.includes(label), `the form shows ${label}`)
  }
  assert.ok(markup.includes('保存'), 'and its own save control')
  assert.ok(markup.includes('已覆盖'), 'and the overridden badge')
  assert.ok(!markup.includes('Save'), 'nothing falls back to English')
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
