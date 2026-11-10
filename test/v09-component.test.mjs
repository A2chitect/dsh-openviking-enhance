// Render the v0.9 "Native II — multi-scope" components, without a browser.
//
// Same technique as `test/component-render.test.mjs`: evaluate the built client
// bundle exactly as the shell does, then render the real components to markup with
// React's server renderer. Effects do not run under SSR, which is exactly the
// first paint being checked: the scope menu's grouping/health/warnings, the
// banner, the switch notice, the auth-mode-disabled identity fields, the session
// mismatch banner, the Access tab's initial state, and the two scope switches.
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

const FINGERPRINT = `sha256:${'a1b2c3d4e5f6'.repeat(4)}${'0'.repeat(8)}`

const SCOPE = {
  identity: {
    profileId: 'alpha',
    profileLabel: 'Alpha dev',
    endpoint: 'http://127.0.0.1:1933',
    authMode: 'dev',
    account: 'default',
    user: 'alice',
    peer: 'peer-a',
    fingerprint: FINGERPRINT,
  },
  activeProfileId: 'alpha',
  role: 'ROOT',
  version: '0.5.3',
  healthy: true,
  writes: { enabled: true, transport: true, reason: null },
  ops: { enabled: false, transport: true, reason: 'ops-disabled' },
  capabilities: { health: { available: true, detail: null } },
  warnings: [],
  observedAt: '2026-11-10T00:00:00.000Z',
}

const SCOPES = {
  scopes: [
    {
      id: 'alpha',
      label: 'Alpha dev',
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      account: 'default',
      user: 'alice',
      peer: 'peer-a',
      hasApiKey: false,
      health: { ok: true, version: '0.5.3', latencyMs: 12, error: null },
      capabilities: { health: { available: true, detail: null } },
      warnings: [],
      isActive: true,
      overrides: true,
    },
    {
      id: 'beta',
      label: 'Beta remote',
      endpoint: 'http://192.0.2.44:1999',
      authMode: 'api_key',
      account: 'default',
      user: 'default',
      peer: null,
      hasApiKey: true,
      health: { ok: false, version: null, latencyMs: 4000, error: 'timeout' },
      capabilities: {},
      warnings: ['remote-endpoint', 'cleartext-http', 'unreachable', 'key-bound-identity'],
      isActive: false,
      overrides: false,
    },
  ],
  active: {
    scopeKey: FINGERPRINT,
    profileId: 'alpha',
    label: 'Alpha dev',
    endpoint: 'http://127.0.0.1:1933',
    authMode: 'dev',
    account: 'default',
    user: 'alice',
    peer: 'peer-a',
    overrides: true,
  },
  overrides: {
    account: 'default',
    user: 'alice',
    peer: 'peer-a',
    allowed: { account: true, user: true, peer: true, reason: null, authMode: 'dev' },
    overrides: true,
  },
  officialPlugin: {
    known: true,
    endpointHost: '192.0.2.10:1999',
    account: 'acct',
    user: 'usr',
    peer: 'peer-official',
    authMode: 'dev',
    matches: false,
  },
  warnings: [{ code: 'officialPluginMismatch', params: { host: '192.0.2.10:1999' } }],
  observedAt: '2026-11-10T00:00:00.000Z',
}

function render(element) {
  return renderToStaticMarkup(element)
}

test('the scope menu groups servers, shows health/warnings and marks the active row', () => {
  const client = loadBundle('en')
  client.__resetScopeForTests()
  client.__setScopeStateForTests({ status: 'ready', scope: SCOPE, scopes: SCOPES, scopesStatus: 'ready' })
  const markup = render(createElement(client.ScopeMenu, { onClose: () => {} }))
  assert.ok(markup.includes('Alpha dev'), 'the active profile label')
  assert.ok(markup.includes('Beta remote'), 'the other scope row')
  assert.ok(markup.includes('127.0.0.1:1933'), 'the server group endpoint host')
  assert.ok(markup.includes('192.0.2.44:1999'), 'the other server group endpoint host')
  assert.ok(markup.includes('active'), 'the active row is marked')
  assert.ok(markup.includes('v0.5.3'), 'the health version is shown')
  assert.ok(markup.includes('12ms'), 'the health latency is shown')
  assert.ok(markup.includes('⚠'), 'the remote/unreachable/key-bound warnings carry a glyph')
  assert.ok(markup.includes('key-bound'), 'the key-bound row is labelled')
  assert.ok(markup.includes('In-server identity'), 'the identity section is present')
  assert.ok(markup.includes('Peer'), 'the peer read selector is present')
  assert.ok(markup.includes('Conversation memories are captured'), 'the official-plugin advisory warning')
  assert.ok(markup.includes('Switch'), 'the menu exposes the switch action')
})

test('the identity fields are disabled with the auth-mode reason when the server is key-bound', () => {
  const client = loadBundle('en')
  client.__resetScopeForTests()
  const keyBound = {
    ...SCOPES,
    overrides: {
      ...SCOPES.overrides,
      allowed: { account: false, user: false, peer: true, reason: 'identity-key-bound', authMode: 'api_key' },
    },
  }
  client.__setScopeStateForTests({ status: 'ready', scope: SCOPE, scopes: keyBound, scopesStatus: 'ready' })
  const markup = render(createElement(client.ScopeMenu, { onClose: () => {} }))
  assert.ok(markup.includes('The API key binds the identity'), 'the disabled reason is stated')
  assert.ok(markup.includes('disabled'), 'the account/user inputs are rendered disabled')
})

test('the scope banner shows the label, endpoint host and identity; the banner switch hides it', () => {
  const client = loadBundle('en')
  client.__resetScopeForTests()
  client.__setScopeStateForTests({ status: 'ready', scope: SCOPE, scopes: SCOPES, scopesStatus: 'ready' })
  const shown = render(createElement(client.ScopeBanner, {}))
  assert.ok(shown.includes('Alpha dev'))
  assert.ok(shown.includes('127.0.0.1:1933'))
  assert.ok(shown.includes('default/alice'))
  assert.ok(shown.includes('peer-a'))
  client.setScopeBannerEnabled(false)
  assert.equal(render(createElement(client.ScopeBanner, {})), '', 'showScopeBanner=false hides the banner')
  client.setScopeBannerEnabled(true)
  const chip = render(createElement(client.ScopeChip, {}))
  assert.ok(chip.includes('Alpha dev'), 'the chip shows the active scope')
})

test('the switcher switch hides only the menu affordance, never the banner', () => {
  const client = loadBundle('en')
  client.__resetScopeForTests()
  client.__setScopeStateForTests({ status: 'ready', scope: SCOPE, scopes: SCOPES, scopesStatus: 'ready' })
  client.setScopeSwitcherEnabled(false)
  const markup = render(createElement(client.ScopeMenu, { onClose: () => {} }))
  assert.ok(markup.includes('Alpha dev'), 'the menu itself still renders its facts')
  assert.ok(markup.includes('disabled'), 'the switch rows are inert with showScopeSwitcher off')
  const banner = render(createElement(client.ScopeBanner, {}))
  assert.ok(banner.includes('Alpha dev'), 'showScopeSwitcher=false never hides the persistent banner')
  client.setScopeSwitcherEnabled(true)
})

test('the switch notice names both scopes and can be dismissed', () => {
  const client = loadBundle('en')
  client.__resetScopeForTests()
  client.__setScopeStateForTests({
    status: 'ready',
    scope: SCOPE,
    switchNotice: { seq: 1, fromLabel: 'Alpha dev', toLabel: 'Beta remote', at: 1 },
  })
  const markup = render(createElement(client.ScopeSwitchNoticeLine, {}))
  assert.ok(markup.includes('Scope switched from Alpha dev to Beta remote.'))
  assert.ok(markup.includes('Dismiss'))
})

test('the session mismatch banner warns and offers switch-back; a matching session renders nothing', () => {
  const client = loadBundle('en')
  client.__setSessionScopeForTests('s1', {
    status: 'ready',
    payload: {
      sessionId: 's1',
      record: {
        sessionId: 's1',
        scopeKey: 'sha256:old',
        profileId: 'beta',
        label: 'Beta remote',
        account: 'default',
        user: 'default',
        peer: null,
        observedAt: '2026-11-10T00:00:00.000Z',
      },
      active: SCOPES.active,
      mismatch: true,
      officialPlugin: null,
      pipelineMismatch: false,
      warnings: [],
      observedAt: '2026-11-10T00:00:00.000Z',
    },
  })
  const markup = render(createElement(client.SessionScopeBanner, { sessionId: 's1' }))
  assert.ok(markup.includes('This session was last seen under Beta remote'))
  assert.ok(markup.includes('Switch back'))
  assert.ok(markup.includes('Recall/write actions are disabled'))
  client.__setSessionScopeForTests('s2', {
    status: 'ready',
    payload: {
      sessionId: 's2',
      record: null,
      active: SCOPES.active,
      mismatch: false,
      officialPlugin: null,
      pipelineMismatch: false,
      warnings: [],
      observedAt: '2026-11-10T00:00:00.000Z',
    },
  })
  assert.equal(render(createElement(client.SessionScopeBanner, { sessionId: 's2' })), '')
})

test('the Access tab renders its loading state without a host (SSR first paint)', () => {
  const client = loadBundle('en')
  const markup = render(createElement(client.AccessPanel, { uri: 'viking://resources/ok', refreshKey: 0 }))
  assert.ok(markup.includes('Reading ACL'), 'the first paint says it is reading')
  assert.equal(markup.includes('<table'), false, 'no ACL data is invented before the answer')
})

test('the v0.9 components speak both languages', () => {
  const client = loadBundle('zh')
  client.__resetScopeForTests()
  client.__setScopeStateForTests({ status: 'ready', scope: SCOPE, scopes: SCOPES, scopesStatus: 'ready' })
  const markup = render(createElement(client.ScopeMenu, { onClose: () => {} }))
  assert.ok(markup.includes('作用域与身份'), 'the menu title is translated')
  assert.ok(markup.includes('服务端身份'), 'the identity section is translated')
  assert.ok(markup.includes('切换'), 'the switch copy is translated')
})
