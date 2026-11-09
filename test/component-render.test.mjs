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
      // v0.5 switches.
      enableWrites: true,
      enableActivity: true,
      showScopeBanner: true,
      activeProfile: '',
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
    'conversation.chat.commandview',
    'conversation.chat.turnTail',
    'conversation.composer.dock',
    'conversation.composer.dock',
    'main',
    'plugins.detail.section',
    'plugins.row.config',
    'shell.overlay',
    'shell.overlay',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
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
    // v0.5: the write master switch, the Activity tab and the scope banner.
    'Enable writes (curation / force commit)',
    'Activity tab',
    'Show the scope banner',
    // ...and the identity profile editor.
    'Identity profiles',
    'Active profile',
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
    '启用写入（策展 / 强制提交）',
    '活动标签页',
    '显示作用域提示',
    '身份配置档',
    '当前配置档',
  ]) {
    assert.ok(markup.includes(label), `the form shows ${label}`)
  }
  assert.ok(markup.includes('保存'), 'and its own save control')
  assert.ok(markup.includes('已覆盖'), 'and the overridden badge')
  assert.ok(!markup.includes('Save'), 'nothing falls back to English')
})

test('the form renders the eleven interface switches as checkboxes that follow the saved values', () => {
  const { find } = loadBundle('en')
  const markup = renderPage(find, FORM)

  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 11, 'exactly eleven checkbox inputs, one per switch')
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'checked')),
    [true, true, true, true, true, true, true, true, true, true, true],
    'all eleven are checked when the saved values are on',
  )
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [false, false, false, false, false, false, false, false, false, false, false],
    'a writable form leaves them enabled',
  )

  // The eight switches have their own rows, in the order the sidebar, the
  // composer and the conversation, then the right sidebar, appear.
  const blocks = toggleBlocks(markup)
  assert.equal(blocks.length, 11, 'each switch is its own labelled row')
  for (const [index, label] of [
    'Sidebar entry',
    'Commit status pill',
    'Memory recall tab',
    'In-conversation memory sources',
    'Memory health tab',
    'URI preview tab',
    'Explore tab',
    '/viking command',
    'Enable writes (curation / force commit)',
    'Activity tab',
    'Show the scope banner',
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
  assert.equal(checkboxes(off).length, 11)
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
    [true, true, true, true, true, false, false, false, true, true, true],
    'the three v0.4 switches turn off independently',
  )
  // An override is marked where it is edited, the same as every other field.
  assert.ok(offBlocks[1].includes('overridden'), 'the overridden switch carries the override badge')
})

test('a read-only form disables the eleven switches instead of pretending they can be edited', () => {
  const { find } = loadBundle('en')
  const readOnly = { ...FORM, state: { ...FORM.state, writable: false } }
  const markup = renderPage(find, readOnly)
  const boxes = checkboxes(markup)
  assert.equal(boxes.length, 11)
  assert.deepEqual(
    boxes.map((tag) => hasAttribute(tag, 'disabled')),
    [true, true, true, true, true, true, true, true, true, true, true],
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

/* ========================================================================
 * v0.5 "Collaborate" surfaces
 *
 * The same server-render contract as above: the built bundle's real components,
 * the real copy layer, the first paint before any host fetch resolves. The
 * write store and the scope store expose documented test seams, so each
 * screenshot-worthy state (dialog, plan, toast, chip, activity, command card) is
 * rendered deterministically without a host.
 * ===================================================================== */

const TEST_SCOPE = {
  profileId: 'local-default',
  profileLabel: 'Local dev',
  endpoint: 'http://127.0.0.1:1933',
  authMode: 'dev',
  account: 'default',
  user: 'default',
  peer: null,
  fingerprint: `sha256:${'b'.repeat(64)}`,
}

const TEST_SCOPE_PAYLOAD = {
  identity: TEST_SCOPE,
  activeProfileId: 'local-default',
  role: 'ROOT',
  version: '0.5.3',
  healthy: true,
  writes: { enabled: true, transport: true, reason: null },
  capabilities: {},
  warnings: [],
  observedAt: '2026-11-09T00:00:00Z',
}

/** The same shape `/write/prepare` returns; a fixture, not a real token. */
function prepareFixture(overrides = {}) {
  return {
    token: 'f'.repeat(64),
    action: 'edit-memory',
    target: 'viking://user/default/memories/preferences/tools.md',
    scope: TEST_SCOPE,
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
    ...overrides,
  }
}

/** Render one overlay entry by its registration id. */
function renderOverlay(contributions, id, props = {}) {
  const entry = contributions.find((candidate) => candidate.options.id === id)
  assert.ok(entry, `the ${id} overlay entry is registered`)
  return renderToStaticMarkup(createElement(entry.Component, props))
}

/** Reset the two module stores between tests (they are process-global). */
function resetV05Stores(exports) {
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

test('the scope chip renders the active identity, and warns about a remote endpoint', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setScopeStateForTests({ status: 'ready', scope: TEST_SCOPE_PAYLOAD, error: null })
    const markup = renderToStaticMarkup(createElement(exports.ScopeChip, {}))
    assert.ok(markup.includes('ove-scope-chip'), 'the chip renders as a real control')
    assert.ok(markup.includes('Local dev'), 'the profile label is shown')
    assert.ok(markup.includes('default/default'), 'the account/user scope is shown')
    assert.ok(!markup.includes('⚠'), 'a loopback identity needs no warning glyph')

    exports.__setScopeStateForTests({
      status: 'ready',
      scope: {
        ...TEST_SCOPE_PAYLOAD,
        identity: { ...TEST_SCOPE, endpoint: 'http://10.0.0.2:1933' },
      },
    })
    const remote = renderToStaticMarkup(createElement(exports.ScopeChip, {}))
    assert.ok(remote.includes('⚠'), 'a remote endpoint is flagged')

    exports.__setScopeStateForTests({
      status: 'ready',
      scope: { ...TEST_SCOPE_PAYLOAD, identity: { ...TEST_SCOPE, authMode: 'api_key' } },
    })
    const keyBound = renderToStaticMarkup(createElement(exports.ScopeChip, {}))
    assert.ok(keyBound.includes('⚠'), 'a key-bound identity is flagged')
  } finally {
    resetV05Stores(exports)
    assert.ok(contributions.length > 0)
  }
})

test('the edit dialog renders the body, the revision and the scope block', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setWriteStateForTests({ confirm: prepareFixture() })
    const markup = renderOverlay(contributions, 'openviking-write-dialog')
    for (const text of [
      'Edit memory file',
      'Original body',
      'Current revision',
      'Local dev',
      'http://127.0.0.1:1933',
      'default/default',
      'Cancel',
      'Save and write',
    ]) {
      assert.ok(markup.includes(text), `the edit dialog shows ${text}`)
    }
    assert.ok(markup.includes('ove-write-editor'), 'the body is editable')
    // The body is unchanged, so the write button is present but disabled.
    const primary = /<button[^>]*class="[^"]*ove-write-primary[^"]*"[^>]*>/.exec(markup)?.[0] ?? ''
    assert.ok(hasAttribute(primary, 'disabled'), 'nothing to save yet')
  } finally {
    resetV05Stores(exports)
  }
})

test('the delete dialog needs the typed file name, and the tag dialog needs a change', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setWriteStateForTests({
      confirm: prepareFixture({ action: 'delete-memory', content: null, confirmWord: 'tools.md' }),
    })
    const remove = renderOverlay(contributions, 'openviking-write-dialog')
    assert.ok(remove.includes('Delete memory file'), 'the delete dialog is titled')
    assert.ok(remove.includes('type the file name'.replace('type', 'Type')), 'the typed confirmation is explained')
    assert.ok(remove.includes('tools.md'), 'the expected word is shown')
    assert.ok(remove.includes('this deletes immediately') || remove.includes('no recycle bin'), 'the permanence is stated')
    const deleteButton = /<button[^>]*class="[^"]*ove-write-danger[^"]*"[^>]*>/.exec(remove)?.[0] ?? ''
    assert.ok(hasAttribute(deleteButton, 'disabled'), 'delete stays disabled until the name is typed')

    exports.__setWriteStateForTests({
      confirm: prepareFixture({ action: 'set-tags', content: null, tagsBefore: ['env=prod'], revision: null }),
    })
    const tags = renderOverlay(contributions, 'openviking-write-dialog')
    assert.ok(tags.includes('Edit tags'), 'the tags dialog is titled')
    assert.ok(tags.includes('env=prod'), 'existing tags are chips')
    assert.ok(tags.includes('Clear'), 'and can be cleared')
    assert.ok(tags.includes('Add to the existing tags instead of replacing them'), 'and can be appended rather than replaced')
    const apply = /<button[^>]*class="[^"]*ove-write-primary[^"]*"[^>]*>/.exec(tags)?.[0] ?? ''
    assert.ok(hasAttribute(apply, 'disabled'), 'an unchanged tag set is not written')

    exports.__setWriteStateForTests({
      confirm: prepareFixture({
        action: 'force-commit',
        content: null,
        target: 'session-1',
        session: { sessionId: 'session-1', ovSessionId: 'dsh-session-1', pendingTokens: 123, messageCount: 9, commitCount: 3, lastCommitAt: null },
      }),
    })
    const commit = renderOverlay(contributions, 'openviking-write-dialog')
    assert.ok(commit.includes('Force-commit session'), 'the force-commit dialog is titled')
    assert.ok(commit.includes('cannot be rolled back'), 'it says extraction is irreversible')
    assert.ok(commit.includes('123'), 'it shows the pending token count')
  } finally {
    resetV05Stores(exports)
  }
})

test('the undo toast renders Undo, Details and the audit id', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setWriteStateForTests({
      notice: { seq: 1, tone: 'success', text: 'Deleted memory/preferences/tools.md', undoId: 'u'.repeat(32), auditId: 'aud-abc' },
    })
    const markup = renderOverlay(contributions, 'openviking-write-toast')
    assert.ok(markup.includes('Deleted memory/preferences/tools.md'), 'the outcome line is shown')
    assert.ok(markup.includes('Undo'), 'the undo action is offered')
    assert.ok(markup.includes('Details'), 'details are offered')
    assert.ok(markup.includes('ove-toast'), 'the toast renders its own surface')
  } finally {
    resetV05Stores(exports)
  }
})

test('the undo plan lists the paths and warns about extra changes', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setWriteStateForTests({
      plan: {
        undoId: 'u'.repeat(32),
        action: 'edit-memory',
        target: 'viking://user/default/memories/preferences/tools.md',
        projectDir: 'viking://user/default/memories/preferences',
        sourceCommit: 'abc123',
        toWrite: [{ path: 'tools.md', expected: true }, { path: 'other.md', expected: false }],
        toDelete: [],
        unchanged: 4,
        extraChanges: true,
        tagsOnly: false,
      },
    })
    const markup = renderOverlay(contributions, 'openviking-write-dialog')
    assert.ok(markup.includes('Undo plan'), 'the plan dialog is titled')
    assert.ok(markup.includes('would also revert'), 'the extra-change warning is shown')
    assert.ok(markup.includes('tools.md') && markup.includes('other.md'), 'the plan paths are listed')
    assert.ok(markup.includes('Revert those changes too'), 'the explicit second confirmation is offered')
  } finally {
    resetV05Stores(exports)
  }
})

test('the Activity tab renders both sections and its task/mode controls', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    exports.__setScopeStateForTests({ status: 'ready', scope: TEST_SCOPE_PAYLOAD, error: null })
    const activity = contributions.find((entry) => entry.options.key === 'dsh-openviking-enhance:activity')
    assert.ok(activity !== undefined, 'the Activity page type is registered')
    const markup = renderToStaticMarkup(createElement(activity.Component, { sessionId: 'session-1' }))
    for (const text of ['ove-act', 'Tasks', 'Status', 'Loading…', 'All types', 'All statuses', 'Refresh']) {
      assert.ok(markup.includes(text), `the Activity tab renders ${text}`)
    }
    assert.ok(markup.includes('ove-scope'), 'and carries the scope chip')
  } finally {
    resetV05Stores(exports)
  }
})

test('the /viking command card parses the envelope and renders Confirm/Cancel', () => {
  const { contributions, exports } = loadBundle('en')
  try {
    const card = contributions.find((entry) => entry.options.name === 'conversation.chat.commandview')
    assert.ok(card !== undefined, 'the keyed command renderer is registered')
    const prepare = prepareFixture({ action: 'delete-memory', content: null, confirmWord: 'tools.md' })
    const text = `Prepared a delete.\n${JSON.stringify({ ov: '1', kind: 'confirm', prepare, hint: 'Type the file name.' })}`
    const markup = renderToStaticMarkup(
      createElement(card.Component, { node: { name: 'viking', outcome: { kind: 'success', text } }, sessionId: 's1' }),
    )
    assert.ok(markup.includes('Delete memory'), 'the card names the action')
    assert.ok(markup.includes('Cancel') && markup.includes('Confirm'), 'it offers Confirm/Cancel')
    assert.ok(markup.includes('Local dev'), 'it repeats the identity scope')
    assert.ok(!markup.includes('Original body'), 'a delete envelope carries no body')

    const editor = renderToStaticMarkup(
      createElement(card.Component, {
        node: {
          name: 'viking',
          outcome: { kind: 'success', text: `Open the editor.\n${JSON.stringify({ ov: '1', kind: 'open-editor', uri: 'viking://user/default/memories/preferences/tools.md' })}` },
        },
        sessionId: 's1',
      }),
    )
    assert.ok(editor.includes('Open the editor'), 'the edit verb renders its editor button')
    assert.ok(editor.includes('Open editor'), 'with the button label')

    const plain = renderToStaticMarkup(
      createElement(card.Component, { node: { name: 'viking', outcome: { kind: 'success', text: 'plain line' } }, sessionId: 's1' }),
    )
    assert.ok(plain.includes('plain line'), 'a command without an envelope falls back to plain text')
  } finally {
    resetV05Stores(exports)
  }
})
