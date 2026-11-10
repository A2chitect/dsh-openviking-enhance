// Render the v0.8 Operate components, without a browser.
//
// Same technique as `component-render.test.mjs`: evaluate the built client bundle
// exactly as the shell does, then render the components to markup with React's
// server renderer. Effects do not run under SSR, so this checks the first paint:
// no throw, the locale copy resolves, the enableOps switch hides/shows actions,
// and the degraded/unavailable states render their stated reason instead of a
// dead button.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import vm from 'node:vm'

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
  exportsObject.apply({
    slots: {
      inject: (_key, callback) => (callback(), () => {}),
      register: () => () => {},
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
  return exportsObject
}

test('the Operate group renders with actions hidden when enableOps is off', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({
    view: 'operate',
    target: { view: 'operate', operate: { tab: 'snapshots' } },
    switches: { nativeViews: true, onboarding: true, ops: false },
  })
  const markup = renderToStaticMarkup(createElement(client.NativeOperate, { refreshKey: 0 }))
  assert.match(markup, /Operate|Snapshots/)
  assert.match(markup, /enable Ops/)
  // No action buttons are rendered while enableOps is off.
  assert.equal(markup.includes('Create snapshot'), false)
  assert.equal(markup.includes('Restore directory'), false)
  assert.match(markup, /Actions are disabled/)
})

test('the Operate group renders the action entry points when enableOps is on', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({
    view: 'operate',
    target: { view: 'operate', operate: { tab: 'snapshots' } },
    switches: { nativeViews: true, onboarding: true, ops: true },
  })
  const markup = renderToStaticMarkup(createElement(client.NativeOperate, { refreshKey: 0 }))
  assert.equal(markup.includes('Actions are disabled'), false)
  assert.match(markup, /Create snapshot/)
  assert.match(markup, /Restore directory/)
  // The Snapshots read surface states the feature's limits honestly.
  assert.match(markup, /Branch: main/)
  assert.match(markup, /version history|Versions/i)
})

test('the Operate tabs render in both languages with parity', () => {
  for (const locale of ['en', 'zh']) {
    const client = loadBundle(locale)
    client.__setNativeStateForTests({
      view: 'operate',
      target: { view: 'operate', operate: { tab: 'compile' } },
      switches: { nativeViews: true, onboarding: true, ops: true },
    })
    const markup = renderToStaticMarkup(createElement(client.NativeOperate, { refreshKey: 0 }))
    assert.match(markup, /Compile|编译/)
    assert.match(markup, /Manual run|手动运行/)
  }
})

test('the Observability segment renders on-demand copy and never mentions polling', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({
    view: 'stats',
    target: { view: 'stats', segment: 'observability' },
    switches: { nativeViews: true, onboarding: true, ops: true },
  })
  const markup = renderToStaticMarkup(createElement(client.NativeObservability, { refreshKey: 0 }))
  assert.match(markup, /Observability/)
  assert.match(markup, /never polled/)
  assert.match(markup, /Prometheus \/metrics is never requested/)
  // The observer card labels resolve (not raw keys).
  assert.equal(markup.includes('obs.card.'), false)
})

test('the OpsDialog renders nothing when closed and no action key leaks to the UI', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({ switches: { nativeViews: true, onboarding: true, ops: false } })
  const markup = renderToStaticMarkup(createElement(client.OpsDialog, { request: null, onClose: () => {} }))
  assert.equal(markup, '')
})

test('the Tasks tab states that no task-retry API exists', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({
    view: 'operate',
    target: { view: 'operate', operate: { tab: 'tasks' } },
    switches: { nativeViews: true, onboarding: true, ops: true },
  })
  const markup = renderToStaticMarkup(createElement(client.NativeOperate, { refreshKey: 0 }))
  assert.match(markup, /no task-retry API/)
  assert.equal(markup.toLowerCase().includes('>retry<'), false, 'no Retry button exists anywhere')
})

test('the Packs tab states the deferred backup/import/restore reasons', () => {
  const client = loadBundle('en')
  client.__setNativeStateForTests({
    view: 'operate',
    target: { view: 'operate', operate: { tab: 'packs' } },
    switches: { nativeViews: true, onboarding: true, ops: false },
  })
  const markup = renderToStaticMarkup(createElement(client.NativeOperate, { refreshKey: 0 }))
  assert.match(markup, /backup|Backup/)
  assert.match(markup, /import|Import/)
  assert.match(markup, /restore|Restore/)
})
