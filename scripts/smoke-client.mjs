// Verify the built browser half without a browser.
//
// The shell loads `lib/client.js` as a lazy-CJS factory registration, so the
// contract this checks is exactly the shell's:
//   1. evaluating the file must call `window.__ModuleLoader__.load({id, factory})`;
//   2. the id must be the package name;
//   3. `factory(require)` must return `{ apply, inject }` with React coming from
//      the provided `require`, never from a bundled copy;
//   4. `apply(ctx)` must mount the plugin's seats and the right-Sidebar tab type,
//      and must not throw.
//
// The three interface switches are checked the way the shell would drive them:
// the fake context below carries a real `configForms` service whose snapshot the
// scenarios replace, and a slot registry that hands back WORKING disposers — a
// hidden surface must actually disappear and a shown one must actually come back,
// in the order `index.tsx` promises, not as calls to a spy.
//
//   node scripts/smoke-client.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
const require = createRequire(import.meta.url)

let handoff = null
// Minimal document stub: enough for `installStyles()` to run and hand us the
// text it would inject, which is how the style-parity checks below are made.
let injectedCss = null
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: {
    append(node) {
      injectedCss = node.textContent
    },
  },
}
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => (handoff = value) } },
  console,
  document: fakeDocument,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'lib/client.js' })

const failures = []
const check = (condition, message) => {
  if (condition) console.log(`[client] ok   ${message}`)
  else {
    console.log(`[client] FAIL ${message}`)
    failures.push(message)
  }
}

check(handoff !== null, 'registers a handoff with window.__ModuleLoader__')
check(handoff?.id === pkg.name, `handoff id is the package name (${pkg.name})`)

// Record what the factory asks for: the bundle's real dependencies, as opposed to
// whatever package names its comments happen to mention.
const required = []
const exports =
  typeof handoff?.factory === 'function'
    ? handoff.factory((id) => {
        required.push(id)
        return require(id)
      })
    : {}
check(typeof exports.apply === 'function', 'factory returns apply()')
check(Array.isArray(exports.inject), 'factory returns inject[]')
check(exports.inject?.includes('slots'), 'inject waits for the slots service')
check(!code.includes('react.development'), 'React is not bundled (external)')

// ---------------------------------------------------------------------------
// A fake shell whose registrations have real lifecycles
// ---------------------------------------------------------------------------
//
// The plugin's feature switches only mean something if a hidden mount really
// unregisters and a shown one really registers again, so nothing here is a spy:
// `register()` returns a disposer that removes the entry, `slots.inject()` runs
// its callback and returns a disposer that runs the callback's returned
// disposer, and `context.inject(deps, cb)` does the same for its cleanup. Every
// registration and every disposal is stamped into `events`, which is what lets a
// scenario assert ORDER (row before main, body before type, close before body).
//
// The right Sidebar's outward face is modelled on the live rc.3 record and its
// mounted-Session observable, and `effect()`'s teardown is kept so a scenario can
// unload the plugin (`shell.unload()`) exactly like the shell's fiber would.

/** Sidebar row id; it also keys the `main` panel. */
const PANEL_ID = 'openviking'
/** The right-Sidebar tab type's identity (implementation, not kind). */
const RECALL_TAB_ID = 'dsh-openviking-enhance:recall'
/** The tab kind the guide registers. */
const RECALL_TAB_KIND = 'openviking-recall'
/** The address a page tab is recorded under, as the container addresses it. */
const RECALL_PAGE_ADDRESS = `sidebar://${RECALL_TAB_KIND}`
/** The config seat's key on the Plugins page. */
const CONFIG_ROW_KEY = `${pkg.name}#openviking-enhance`
/** The settings namespace the config form lives under (the Loader row id). */
const SETTINGS_NAMESPACE = 'openviking-enhance'

const ALL_ON = { showSidebarEntry: true, showCommitStatus: true, showRecallPanel: true }
const ALL_OFF = { showSidebarEntry: false, showCommitStatus: false, showRecallPanel: false }
const BOOT_SEATS = [
  'conversation.composer.dock',
  'main',
  'plugins.row.config',
  'sidebar.panellist',
  'sidebar.right.pane.tab',
].sort()

/** The recall page as an open tab, in the LIVE 0.2.1-rc.3 record shape.
 *
 * A page tab's address lives in `contentId`; `contentId === sidebar://<kind>`
 * is also how the framework itself identifies a page tab (`pageKind`). The
 * earlier record shape (`{address}`) is NOT what the framework sends, and the
 * first cut of the close check compared only that field — which is exactly the
 * regression this fixture pins.
 */
const RECALL_PAGE_TAB_ID = 'tab-recall-1'
const openRecallTab = () => ({
  id: RECALL_PAGE_TAB_ID,
  kind: RECALL_TAB_KIND,
  contentId: RECALL_PAGE_ADDRESS,
  title: '记忆召回',
})
/** A different page tab: the active pane is not showing our recall page. */
const openOtherTab = () => ({
  id: 'tab-task-1',
  kind: 'task-board',
  contentId: 'sidebar://task-board',
  title: '任务管理',
})

/**
 * One fake shell + the controller a scenario uses to edit the settings form.
 *
 * `status`/`value` seed the form snapshot. `activeTab` is the page tab the
 * mounted Session is showing (mutable through `controller.setActiveTab`), and
 * `mountedSession` is the Session the right Sidebar is mounted for — leave it
 * undefined to model the Plugins page, where the right column is off screen and
 * `sidebarRight.active()` answers `undefined`. `settings: false` models a
 * composition without `@deepseek-ai/dsh-client-ui-settings`; `sidebarRight: false`
 * models a harness whose right Sidebar predates the navigation face, and
 * `mountedObservable: false` one that exposes `active()`/`close()` but not the
 * mounted-Session observable.
 */
function createShell({
  status = 'ready',
  value = {},
  activeTab,
  mountedSession,
  settings = true,
  sidebarRight = true,
  mountedObservable = true,
} = {}) {
  const state = {
    /** Live slot registrations: `{ options, seq }`. */
    registrations: [],
    /** Ordered log of registrations, disposals and page closes. */
    events: [],
    /** Slot keys the plugin injected, in call order. */
    injectedKeys: [],
    /** Service dependencies the plugin waited for, as `ctx.inject([...])` named them. */
    awaited: [],
    /** Live right-Sidebar tab types. */
    tabTypes: [],
    /** Entry ids asked of `configForms.get()`. */
    entryIds: [],
    /** Service names read through a scoped injection. */
    scopeGets: [],
    /** Tab ids passed to `sidebarRight.close()`. */
    closes: [],
    /** The Session the right Sidebar is mounted for (`undefined` = column off screen). */
    mountedSession,
    /** Listeners on `sidebarRight.mounted`. */
    mountedListeners: new Set(),
    /** The open tab of the mounted Session; `close()` clears it when it matches. */
    activeTab,
    /** Teardowns handed to `ctx.effect`, run by `unload()`. */
    effectTeardowns: [],
    /** Outcomes logged through `ctx.logger.warn` (mount failures must not be silent). */
    reports: [],
    snapshot: status === 'ready' ? { status, value } : { status },
    listeners: new Set(),
    formSubscribes: 0,
    seq: 0,
  }

  const stamp = () => (state.seq += 1)
  const push = (event) => {
    const record = { seq: stamp(), ...event }
    state.events.push(record)
    return record
  }

  // The settings form: one snapshot, replaced by the scenario controller. This is
  // the shape `@deepseek-ai/dsh-client-ui-settings`' `ConfigForm` exposes.
  const form = {
    getSnapshot: () => state.snapshot,
    subscribe(listener) {
      state.formSubscribes += 1
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
  }

  // The right-Sidebar tab registry. It refuses a second live registration of one
  // id (the real one throws), which is exactly the mistake a sloppy re-mount or a
  // double-disposal would cause.
  const tabRegistry = {
    register(definition) {
      if (state.tabTypes.some((held) => held.definition.id === definition.id)) {
        throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
      }
      const held = { definition, seq: stamp() }
      state.tabTypes.push(held)
      push({ type: 'tab-register', entry: definition.id, kind: definition.kind })
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const index = state.tabTypes.indexOf(held)
        if (index >= 0) state.tabTypes.splice(index, 1)
        push({ type: 'tab-dispose', entry: definition.id })
      }
    },
  }

  // The outward navigation face, as the live right Sidebar exposes it: `active()`
  // answers only while the column is mounted (on the Plugins page it is
  // `undefined`), `mounted` tells a deferred close when the column comes back,
  // and `close(id)` records the close and drops the matching active tab.
  const navigation = {
    active: () => (state.mountedSession === undefined ? undefined : state.activeTab),
    // Optional on the service type, and absent on harnesses older than the
    // deferred close: then the switch can only try once.
    mounted: mountedObservable
      ? {
          getSnapshot: () => state.mountedSession,
          subscribe(listener) {
            state.mountedListeners.add(listener)
            return () => state.mountedListeners.delete(listener)
          },
        }
      : undefined,
    close(tabId) {
      state.closes.push(tabId)
      push({ type: 'close', entry: tabId })
      if (state.activeTab?.id === tabId) state.activeTab = undefined
    },
  }

  const configForms = {
    get(entryId) {
      state.entryIds.push(entryId)
      return form
    },
  }

  const slots = {
    inject(key, callback) {
      state.injectedKeys.push(key)
      // The real registry runs the callback when the slot is declared; the
      // callback's return value is the registration's teardown.
      const produced = callback()
      const teardowns =
        typeof produced === 'function' ? [produced] : produced == null ? [] : [...produced]
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        push({ type: 'inject-dispose', key })
        for (const teardown of teardowns) {
          try {
            if (typeof teardown === 'function') teardown()
          } catch (error) {
            state.reports.push(error)
          }
        }
      }
    },
    register(options) {
      const held = { options, seq: stamp() }
      state.registrations.push(held)
      push({ type: 'register', name: options.name, entry: options.key ?? options.id })
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const index = state.registrations.indexOf(held)
        if (index >= 0) state.registrations.splice(index, 1)
        push({ type: 'dispose', name: options.name, entry: options.key ?? options.id })
      }
    },
  }

  const rawContext = {
    slots,
    effect(callback) {
      // The plugin's whole unload path is the returned teardown; keep it, so a
      // scenario can unload (or HMR-reload) the plugin the way the shell does.
      const teardown = callback()
      let used = false
      const run = () => {
        if (used) return
        used = true
        if (typeof teardown === 'function') {
          try {
            teardown()
          } catch (error) {
            state.reports.push(error)
          }
        }
      }
      state.effectTeardowns.push(run)
      return run
    },
    inject(deps, callback) {
      state.awaited.push(deps.join(','))
      const scope = {
        get(name) {
          state.scopeGets.push(name)
          if (name === 'locale') return { getSnapshot: () => ({ active: 'zh' }) }
          if (name === 'sidebarRightTabs') return tabRegistry
          if (name === 'sidebarRight') return sidebarRight ? navigation : undefined
          if (name === 'configForms') return settings ? configForms : undefined
          return undefined
        },
      }
      // The service exists here (otherwise the callback would be waiting), so run
      // it now and keep what it returns as this injection's teardown.
      const teardown = callback(scope)
      let disposed = false
      return {
        dispose() {
          if (disposed) return
          disposed = true
          push({ type: 'service-dispose', services: deps.join(',') })
          if (typeof teardown === 'function') {
            try {
              teardown()
            } catch (error) {
              state.reports.push(error)
            }
          }
        },
      }
    },
    get(name) {
      state.scopeGets.push(name)
      if (name === 'sidebarRight') return sidebarRight ? navigation : undefined
      return undefined
    },
    logger: {
      warn(message) {
        state.reports.push(message)
      },
      info: () => {},
    },
  }

  // Cordis refuses an UNDECLARED service property: reading one throws
  // `cannot get property "x" without inject`. That is exactly how this half
  // shipped broken once — one `ctx.locale` read threw before the registrations,
  // taking the sidebar row, the pill and the tab with it while the host half
  // stayed green. A plain object cannot catch that: it answers `undefined` to
  // anything. Only what the entry actually injects, the optional `get()`
  // accessor and the context's own verbs are readable here.
  const declared = new Set(['slots', 'effect', 'inject', 'get', 'logger'])
  const strictContext = new Proxy(rawContext, {
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      const value = Reflect.get(target, key)
      if (value === undefined && !declared.has(key)) {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return value
    },
  })

  // What a scenario uses to edit the settings form the way a save would: replace
  // the snapshot, then notify every listener.
  const controller = {
    setSnapshot(next) {
      state.snapshot = next
      for (const listener of [...state.listeners]) listener()
    },
    setFlags(flags) {
      controller.setSnapshot({
        status: 'ready',
        value: { ...(state.snapshot.value ?? {}), ...flags },
      })
    },
    notify() {
      for (const listener of [...state.listeners]) listener()
    },
    /** Point the mounted face at a Session, as the conversation coming back does. */
    setMounted(sessionId) {
      state.mountedSession = sessionId
      push({ type: 'mounted', entry: sessionId })
      for (const listener of [...state.mountedListeners]) listener()
    },
    /** Change the tab the mounted Session is showing (without a mount event). */
    setActiveTab(tab) {
      state.activeTab = tab
    },
  }

  /** Unload the plugin the way the shell's fiber teardown would. */
  const unload = () => {
    for (const teardown of state.effectTeardowns.splice(0).reverse()) teardown()
  }

  return { state, context: strictContext, controller, form, unload }
}

/** Build a shell, then apply the built bundle to it exactly as the shell would. */
function mountShell(options) {
  const shell = createShell(options)
  let threw = null
  try {
    exports.apply(shell.context)
  } catch (error) {
    threw = error
  }
  return { ...shell, threw }
}

const liveOf = (state, name) => state.registrations.filter((held) => held.options.name === name)
const liveNames = (state) => state.registrations.map((held) => held.options.name)
const isLive = (state, name) => liveOf(state, name).length > 0
const optionsByName = (state, name) => liveOf(state, name)[0]?.options
const eventAfter = (state, cursor, predicate) => {
  for (let index = cursor; index < state.events.length; index += 1) {
    if (predicate(state.events[index])) return index
  }
  return -1
}
const registerIndex = (state, cursor, name) =>
  eventAfter(state, cursor, (event) => event.type === 'register' && event.name === name)
const disposeIndex = (state, cursor, name) =>
  eventAfter(state, cursor, (event) => event.type === 'dispose' && event.name === name)
const tabEventIndex = (state, cursor, type) => eventAfter(state, cursor, (event) => event.type === type)

/** The reason a scenario failed to mount, for a precise check message. */
const throwReason = (threw) => (threw ? `: ${threw instanceof Error ? threw.message : String(threw)}` : '')

// ---------------------------------------------------------------------------
// Scenario 1 — the pre-switch default: a saved all-on answer
// ---------------------------------------------------------------------------
const on = mountShell({
  status: 'ready',
  value: { ...ALL_ON, endpoint: 'http://127.0.0.1:1933' },
  activeTab: openRecallTab(),
})
check(on.threw === null, `apply() does not throw${throwReason(on.threw)}`)

const onState = on.state
const onSeats = [...liveNames(onState)].sort()
check(
  onSeats.join(',') === BOOT_SEATS.join(','),
  `registers every seat exactly once (saw ${onSeats.join(', ') || 'nothing'})`,
)
check(onState.reports.length === 0, `no mount failure is reported (saw ${onState.reports.join('; ') || 'none'})`)

const byName = new Map(onState.registrations.map((held) => [held.options.name, held.options]))
const dock = liveOf(onState, 'conversation.composer.dock').map((held) => held.options)
check(byName.has('sidebar.panellist'), 'registers the left-sidebar row (sidebar.panellist)')
check(byName.has('main'), 'registers the matching centre panel (main)')
check(byName.get('sidebar.panellist')?.id === byName.get('main')?.key, 'panel row id and main key agree')
// The sidebar sorts rows by `order` and breaks ties by registration order, which
// varies per boot — a shared order is what made this row drift between startups.
// Every other row shipped today is <= 30.
check(
  (byName.get('sidebar.panellist')?.order ?? 0) > 100,
  `sidebar row sorts after every shipped row (order ${byName.get('sidebar.panellist')?.order})`,
)
// Mounting order is load-bearing: a row is clickable the moment it exists, and
// selecting one whose `main` key is not registered throws in the shell.
const bootMain = registerIndex(onState, 0, 'main')
const bootRow = registerIndex(onState, 0, 'sidebar.panellist')
check(
  bootMain !== -1 && bootRow !== -1 && bootMain < bootRow,
  'the main panel is registered before the sidebar row that opens it',
)

// One dock entry. It renders two elements (an invisible mirror + the pill)
// whose auto margins and equal widths are what keep the default pills centred
// while the pill sits at the right edge — the CSS owns that, so here we only
// assert the single registration and its session inject face.
check(dock.length === 1, `registers one dock entry (saw ${dock.length})`)
const pill = dock[0]
check(pill?.id === 'openviking-commit', 'dock entry is the commit pill')
check(typeof pill?.inject === 'function', 'status pill declares a session inject face')
check(onState.injectedKeys.length === 5, `all five slots are injected (saw ${onState.injectedKeys.join(', ')})`)
check(onState.awaited.includes('locale'), 'the app locale is reached through a scoped injection, not the browser')

// The configuration form. DSH renders no form for a plugin's Config on its own:
// the Plugins page grows a Configure control only because this seat is taken, and
// it keys the seat by the manifest's package name — which the browser half cannot
// read, so it is written out and pinned here instead. The seat is unconditional:
// it is also the only way back after a surface has been switched off.
const configRow = optionsByName(onState, 'plugins.row.config')
check(configRow !== undefined, 'registers the row configuration form (plugins.row.config)')
check(
  configRow?.key === CONFIG_ROW_KEY,
  `the config seat is keyed by package name and row id (${configRow?.key})`,
)
// The live switches are read from the settings service under this plugin's row
// id; the same form the Configure page renders.
check(
  onState.entryIds.length > 0 && onState.entryIds.every((entryId) => entryId === SETTINGS_NAMESPACE),
  `the settings form is read under this plugin's row id (${onState.entryIds.join(', ') || 'none'})`,
)
check(onState.formSubscribes === 1, `the settings form is observed exactly once (saw ${onState.formSubscribes})`)
check(onState.awaited.includes('configForms'), 'the settings service is reached through a scoped injection')
check(onState.awaited.includes('sidebarRight'), 'the tab-closing navigation face is reached through a scoped injection')

// The right Sidebar tab. Registration is two-stage and the stages must agree: the
// registry keys the body seat by the type's `id`, so a body registered under
// anything else renders the framework's "nothing can view this" notice.
check(onState.awaited.includes('sidebarRightTabs'), 'waits for the tab registry (a service), not the slot declaration')
check(onState.tabTypes.length === 1, `registers one right-Sidebar tab type (saw ${onState.tabTypes.length})`)
const tabType = onState.tabTypes[0]?.definition
check(
  typeof tabType?.id === 'string' && tabType.id.includes(':'),
  `tab id is namespaced, since the registry's key domain is open (${tabType?.id})`,
)
check(tabType?.kind === RECALL_TAB_KIND, `tab kind is namespaced (${tabType?.kind})`)
check(typeof tabType?.title === 'function' && tabType.title('').length > 0, 'the tab type names its chip')
check(
  Array.isArray(tabType?.guide) && tabType.guide.length === 1,
  'the tab carries a guide entry, which is the only way a user can open it',
)
const tabBody = optionsByName(onState, 'sidebar.right.pane.tab')
check(tabBody?.key === tabType?.id, 'the tab body is keyed by the type id')
check(typeof tabBody?.inject === 'function', 'the tab body declares a session inject face')
check(tabBody?.inject('session-x')?.sessionId === 'session-x', 'the tab body receives the session it was opened in')
const bootType = tabEventIndex(onState, 0, 'tab-register')
const bootBody = registerIndex(onState, 0, 'sidebar.right.pane.tab')
check(
  bootType !== -1 && bootBody !== -1 && bootType < bootBody,
  'the tab type is registered before its body',
)
check(code.includes('/recall'), 'the panel requests the host recall route')
// Both dictionaries must ship: the copy follows the app's language, and a build
// that dropped one would leave half the interface in the other. esbuild escapes
// non-ASCII by default (its `charset` is `ascii`), so the bundle is decoded before
// looking for the Chinese.
const decoded = code.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
check(
  decoded.includes('记忆召回') && decoded.includes('Memory recall'),
  'both languages ship in the bundle',
)
// The locale half is a manifest dependency, not a Cordis service this plugin
// waits for: a composition without it must still run the plugin (its copy then
// falls back to the browser language), so the dependency is declared here and
// read opportunistically at runtime.
check(
  (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-locale'),
  'the manifest depends on the locale package',
)
// The settings half is what carries the live switches' values to the browser: a
// manifest without it would leave every surface on, forever.
check(
  (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'),
  'the manifest depends on the settings package (the form and the live switches)',
)
check(injectedCss?.includes('.ove-recall'), 'installs the recall panel stylesheet')

// ---------------------------------------------------------------------------
// Scenario 2 — a saved all-off answer: nothing surface-mounted, form still there
// ---------------------------------------------------------------------------
const off = mountShell({ status: 'ready', value: { ...ALL_OFF }, activeTab: openRecallTab() })
check(off.threw === null, `apply() does not throw with every switch off${throwReason(off.threw)}`)
const offState = off.state
check(
  liveNames(offState).length === 1 && liveNames(offState)[0] === 'plugins.row.config',
  `an entry saved off mounts none of the three surfaces (saw ${liveNames(offState).join(', ') || 'nothing'})`,
)
check(!isLive(offState, 'sidebar.panellist'), 'the left-sidebar row stays unmounted')
check(!isLive(offState, 'main'), 'the Studio main panel stays unmounted')
check(!isLive(offState, 'conversation.composer.dock'), 'the commit pill stays unmounted')
check(!isLive(offState, 'sidebar.right.pane.tab'), 'the recall tab body stays unmounted')
check(offState.tabTypes.length === 0, 'the recall tab type stays unregistered')
check(
  optionsByName(offState, 'plugins.row.config')?.key === CONFIG_ROW_KEY,
  'the configuration row is registered anyway — it is the way back',
)
check(offState.reports.length === 0, `hiding everything reports no failure (saw ${offState.reports.join('; ') || 'none'})`)

// ---------------------------------------------------------------------------
// Scenario 3 — before the settings answer arrives, everything is on
// ---------------------------------------------------------------------------
const boot = mountShell({ status: 'loading', activeTab: openRecallTab() })
check(boot.threw === null, `apply() does not throw while the form is loading${throwReason(boot.threw)}`)
check(
  liveNames(boot.state).length === 5 && boot.state.tabTypes.length === 1,
  `the initial mount is the pre-switch behaviour: all three surfaces on (saw ${liveNames(boot.state).join(', ') || 'nothing'})`,
)
boot.controller.setSnapshot({ status: 'ready', value: { ...ALL_OFF } })
check(
  liveNames(boot.state).length === 1 && liveNames(boot.state)[0] === 'plugins.row.config',
  'a later answer with false hides the surfaces then',
)
check(boot.state.tabTypes.length === 0, 'and the recall tab type is disposed then')

// ---------------------------------------------------------------------------
// Scenario 4 — hide and show again, live, with ordering and no churn
// ---------------------------------------------------------------------------
// The conversation is on screen, so the right Sidebar is mounted and its active
// page (the recall tab) is visible to the close path.
const live = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  mountedSession: 'session-1',
  activeTab: openRecallTab(),
})
check(live.threw === null, `apply() does not throw when all switches are on${throwReason(live.threw)}`)
check(liveNames(live.state).length === 5, `a saved all-on answer leaves every surface mounted (saw ${liveNames(live.state).length})`)

// (b) turn everything off through the form listener.
const hideCursor = live.state.events.length
live.controller.setFlags({ ...ALL_OFF })
const hidden = live.state
check(
  liveNames(hidden).length === 1 && liveNames(hidden)[0] === 'plugins.row.config',
  `hiding every surface leaves only the configuration row (saw ${liveNames(hidden).join(', ') || 'nothing'})`,
)
check(!isLive(hidden, 'sidebar.panellist'), 'the sidebar row is unmounted live')
check(!isLive(hidden, 'main'), 'the Studio page is unmounted live')
check(!isLive(hidden, 'conversation.composer.dock'), 'the commit pill is unmounted live')
check(!isLive(hidden, 'sidebar.right.pane.tab'), 'the recall body is unmounted live')
check(hidden.tabTypes.length === 0, 'the recall tab type is unregistered live')
const hiddenRow = disposeIndex(hidden, hideCursor, 'sidebar.panellist')
const hiddenMain = disposeIndex(hidden, hideCursor, 'main')
check(
  hiddenRow !== -1 && hiddenMain !== -1 && hiddenRow < hiddenMain,
  'on hide the sidebar row is disposed before the main panel (so the layout can return to the conversation)',
)
const hiddenBody = disposeIndex(hidden, hideCursor, 'sidebar.right.pane.tab')
const hiddenType = tabEventIndex(hidden, hideCursor, 'tab-dispose')
check(
  hiddenBody !== -1 && hiddenType !== -1 && hiddenBody < hiddenType,
  'on hide the recall body is disposed before its tab type',
)
const closeAt = tabEventIndex(hidden, hideCursor, 'close')
check(
  closeAt !== -1 && hidden.closes.length === 1 && hidden.closes[0] === RECALL_PAGE_TAB_ID,
  `hiding the recall surface closes the open recall page (saw ${hidden.closes.join(', ') || 'no close'})`,
)
check(
  closeAt !== -1 && hiddenBody !== -1 && closeAt < hiddenBody,
  'the open recall page is closed before its body and type go away',
)
const churn = hidden.events
  .slice(hideCursor)
  .filter((event) => event.type === 'register' || event.type === 'tab-register')
check(
  churn.length === 0,
  `hiding only disposes — it mounts nothing (saw ${churn.map((event) => event.name ?? event.entry).join(', ') || 'no mount'})`,
)
check(
  !hidden.events.some((event) => event.type === 'dispose' && event.name === 'plugins.row.config'),
  'the configuration row is never disposed by a switch',
)

// A different page being active must not be closed: the switch closes the recall
// page it can see, not whatever tab happens to be in front. (The public face
// cannot enumerate inactive tabs, so this is the boundary of the cleanup.)
const otherFront = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  mountedSession: 'session-1',
  activeTab: openOtherTab(),
})
otherFront.controller.setFlags(ALL_OFF)
check(
  otherFront.state.closes.length === 0,
  `hiding the recall surface leaves a different active page alone (saw ${otherFront.state.closes.join(', ') || 'no close'})`,
)
check(
  !isLive(otherFront.state, 'sidebar.right.pane.tab'),
  'the recall body still unmounts while another page is active',
)
check(otherFront.state.reports.length === 0, 'and doing so reports no failure')

// The watcher's contract: unchanged flags are not re-emitted, and a snapshot that
// is not `ready` is not an answer.
const settledCursor = hidden.events.length
live.controller.notify()
check(hidden.events.length === settledCursor, 'a repeated notification with unchanged flags emits nothing')
live.controller.setSnapshot({ status: 'loading' })
check(
  hidden.events.length === settledCursor && liveNames(hidden).length === 1,
  'a non-ready snapshot is not permission to show hidden surfaces',
)
live.controller.setSnapshot({ status: 'ready', value: { ...ALL_OFF } })
check(
  hidden.events.length === settledCursor,
  'the same ready values arriving again do not remount or re-dispose anything',
)

// (c) turn everything back on.
const showCursor = hidden.events.length
live.controller.setFlags({ ...ALL_ON })
const shown = live.state
check(
  liveNames(shown).length === 5 && [...liveNames(shown)].sort().join(',') === BOOT_SEATS.join(','),
  `switching back on re-registers every seat (saw ${liveNames(shown).join(', ') || 'nothing'})`,
)
const shownMain = registerIndex(shown, showCursor, 'main')
const shownRow = registerIndex(shown, showCursor, 'sidebar.panellist')
check(
  shownMain !== -1 && shownRow !== -1 && shownMain < shownRow,
  'on show the main panel is registered before the sidebar row again',
)
check(optionsByName(shown, 'conversation.composer.dock')?.id === 'openviking-commit', 'the commit pill comes back')
check(
  shown.tabTypes.length === 1 && shown.tabTypes[0]?.definition.id === RECALL_TAB_ID,
  'the recall tab type comes back',
)
check(
  optionsByName(shown, 'sidebar.right.pane.tab')?.key === RECALL_TAB_ID,
  'the recall body comes back keyed by the type id',
)
const shownType = tabEventIndex(shown, showCursor, 'tab-register')
const shownBody = registerIndex(shown, showCursor, 'sidebar.right.pane.tab')
check(
  shownType !== -1 && shownBody !== -1 && shownType < shownBody,
  'the type is registered before its body again',
)
check(
  registerIndex(shown, showCursor, 'plugins.row.config') === -1 &&
    liveOf(shown, 'plugins.row.config').length === 1,
  'the configuration row is neither re-registered nor duplicated by a switch',
)
check(shown.reports.length === 0, `toggling surfaces reports no failure (saw ${shown.reports.join('; ') || 'none'})`)

// ---------------------------------------------------------------------------
// Scenario 5 — partial answers are honoured one surface at a time
// ---------------------------------------------------------------------------
const noCommit = mountShell({
  status: 'ready',
  value: { showSidebarEntry: true, showCommitStatus: false, showRecallPanel: true },
  activeTab: openRecallTab(),
})
check(noCommit.threw === null, `apply() does not throw with only the commit switch off${throwReason(noCommit.threw)}`)
check(
  isLive(noCommit.state, 'sidebar.panellist') && isLive(noCommit.state, 'main'),
  'only the commit switch off leaves the sidebar entry mounted',
)
check(
  noCommit.state.tabTypes.length === 1 && isLive(noCommit.state, 'sidebar.right.pane.tab'),
  'only the commit switch off leaves the recall surface mounted',
)
check(!isLive(noCommit.state, 'conversation.composer.dock'), 'the commit pill is the only surface removed')

const noSidebar = mountShell({
  status: 'ready',
  value: { showSidebarEntry: false, showCommitStatus: true, showRecallPanel: true },
  activeTab: openRecallTab(),
})
check(noSidebar.threw === null, `apply() does not throw with only the sidebar switch off${throwReason(noSidebar.threw)}`)
check(
  !isLive(noSidebar.state, 'sidebar.panellist') && !isLive(noSidebar.state, 'main'),
  'only the sidebar switch off removes the entry and its page',
)
check(
  optionsByName(noSidebar.state, 'conversation.composer.dock')?.id === 'openviking-commit' &&
    noSidebar.state.tabTypes.length === 1,
  'only the sidebar switch off keeps the pill and the recall tab',
)

// ---------------------------------------------------------------------------
// Scenario 6 — defaults-on and optional services
// ---------------------------------------------------------------------------
// Only a literal `false` hides a surface: a string, 0 or null is a malformed
// value, and hiding something because of one would be the dangerous direction.
const tolerant = mountShell({
  status: 'ready',
  value: { showSidebarEntry: 'false', showCommitStatus: 0, showRecallPanel: null },
  activeTab: openRecallTab(),
})
check(tolerant.threw === null, `apply() does not throw on malformed switch values${throwReason(tolerant.threw)}`)
check(
  liveNames(tolerant.state).length === 5,
  `only a literal boolean false hides a surface (saw ${liveNames(tolerant.state).join(', ') || 'nothing'})`,
)
const absentFlags = mountShell({
  status: 'ready',
  value: { endpoint: 'http://127.0.0.1:1933' },
  activeTab: openRecallTab(),
})
check(
  liveNames(absentFlags.state).length === 5,
  'a settings value that does not carry the switches keeps every surface mounted',
)
// A composition without the settings service (a remote Web deployment, or a
// profile without the settings package) must keep the plugin working: every
// surface stays on, exactly as before the switches existed.
const noSettings = mountShell({
  status: 'ready',
  value: { ...ALL_OFF },
  settings: false,
  activeTab: openRecallTab(),
})
check(noSettings.threw === null, `apply() does not throw without the settings service${throwReason(noSettings.threw)}`)
check(
  liveNames(noSettings.state).length === 5,
  'a composition without the settings service keeps every surface mounted',
)
check(noSettings.state.entryIds.length === 0, 'and it never asks a missing service for a form')
// Likewise, a right Sidebar that predates the navigation face must not make the
// switch unusable: the recall surface still unmounts, it just cannot pre-close an
// open page.
const noNav = mountShell({ status: 'ready', value: { ...ALL_ON }, sidebarRight: false, activeTab: openRecallTab() })
check(noNav.threw === null, `apply() does not throw without the navigation face${throwReason(noNav.threw)}`)
noNav.controller.setFlags({ ...ALL_OFF })
check(
  !isLive(noNav.state, 'sidebar.right.pane.tab') && noNav.state.tabTypes.length === 0,
  'hiding the recall surface works without the navigation face',
)
check(
  noNav.state.closes.length === 0 && noNav.state.reports.length === 0,
  'an absent navigation face is not an error',
)

// ---------------------------------------------------------------------------
// Scenario 7 — deferred close: the Configure form unmounts the right column
// ---------------------------------------------------------------------------
// The settings form lives on the Plugins page, and that page fills the main
// column: while it is open there is no mounted right Sidebar, so `active()`
// answers `undefined` and the open recall page cannot be closed at save time.
// This is the live defect the deferred close exists for: the surface unmounts
// immediately, and the page is closed only once the column is mounted again.
// An unload (or HMR reload) must never close the page, and re-enabling the
// switch must cancel a close that is still pending.

// (a) hide while nothing is mounted: no close yet, close once the column returns.
const deferred = mountShell({ status: 'ready', value: { ...ALL_ON }, activeTab: openRecallTab() })
check(deferred.threw === null, `apply() does not throw with the right column off screen${throwReason(deferred.threw)}`)
const deferredCursor = deferred.state.events.length
deferred.controller.setFlags({ ...ALL_OFF })
check(
  deferred.state.closes.length === 0,
  'with no mounted right sidebar, hiding the recall surface cannot close the page yet',
)
check(
  !isLive(deferred.state, 'sidebar.right.pane.tab') && deferred.state.tabTypes.length === 0,
  'the surface is unmounted immediately even though the open page cannot be closed yet',
)
check(
  deferred.state.mountedListeners.size === 1,
  `a deferred close watches the mounted-Session observable (saw ${deferred.state.mountedListeners.size} listener(s))`,
)
// The conversation comes back; its recall page is still the open tab.
deferred.controller.setMounted('session-1')
check(
  deferred.state.closes.length === 1 && deferred.state.closes[0] === RECALL_PAGE_TAB_ID,
  `the pending close lands when the right sidebar mounts again (saw ${deferred.state.closes.join(', ') || 'no close'})`,
)
check(deferred.state.mountedListeners.size === 0, 'the retry stops after the close it was armed for')
const mountedAt = tabEventIndex(deferred.state, deferredCursor, 'mounted')
const deferredCloseAt = tabEventIndex(deferred.state, deferredCursor, 'close')
check(
  mountedAt !== -1 && deferredCloseAt !== -1 && mountedAt < deferredCloseAt,
  'the close follows the mounting event that made the page visible again',
)
check(
  deferred.state.reports.length === 0,
  `the deferred path reports no failure (saw ${deferred.state.reports.join('; ') || 'none'})`,
)
// A stopped retry must not fire again on a later mount change.
deferred.controller.setMounted(undefined)
deferred.controller.setMounted('session-1')
check(deferred.state.closes.length === 1, 'a stopped retry never closes the page twice')

// (b) re-enabling the switch cancels a pending close.
const cancelled = mountShell({ status: 'ready', value: { ...ALL_ON }, activeTab: openRecallTab() })
check(cancelled.threw === null, `apply() does not throw while a close is pending${throwReason(cancelled.threw)}`)
cancelled.controller.setFlags({ ...ALL_OFF })
check(cancelled.state.mountedListeners.size === 1, 'hiding without the right column arms a deferred close')
cancelled.controller.setFlags({ ...ALL_ON })
check(cancelled.state.mountedListeners.size === 0, 'switching the surface back on cancels the pending close')
check(cancelled.state.closes.length === 0, 'nothing is closed by the cancel itself')
cancelled.controller.setMounted('session-1')
check(cancelled.state.closes.length === 0, 'mounting the column afterwards does not run a cancelled close')
check(
  isLive(cancelled.state, 'sidebar.right.pane.tab') && cancelled.state.tabTypes.length === 1,
  'the recall surface is mounted again, not closed',
)
check(cancelled.state.reports.length === 0, 'the cancel reports no failure')

// (c) unload (or an HMR reload) must NOT close the page the user had open.
const unloaded = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  mountedSession: 'session-1',
  activeTab: openRecallTab(),
})
check(unloaded.threw === null, `apply() does not throw before unload${throwReason(unloaded.threw)}`)
unloaded.unload()
check(
  unloaded.state.closes.length === 0,
  `unloading the plugin never closes the recall page the user had open (saw ${unloaded.state.closes.join(', ') || 'no close'})`,
)
check(
  liveNames(unloaded.state).length === 0 && unloaded.state.tabTypes.length === 0,
  'the unload still tears every mount down',
)
check(unloaded.state.reports.length === 0, 'the unload reports no failure')

// ...and an unload cancels a deferred close instead of firing it.
const unloadedPending = mountShell({ status: 'ready', value: { ...ALL_ON }, activeTab: openRecallTab() })
check(
  unloadedPending.threw === null,
  `apply() does not throw before an unload with a pending close${throwReason(unloadedPending.threw)}`,
)
unloadedPending.controller.setFlags({ ...ALL_OFF })
check(unloadedPending.state.mountedListeners.size === 1, 'a deferred close is armed before the unload')
unloadedPending.unload()
check(unloadedPending.state.closes.length === 0, 'unloading cancels a pending close instead of firing it')
check(unloadedPending.state.mountedListeners.size === 0, 'and the mounted-Session listener is removed')
check(unloadedPending.state.reports.length === 0, 'the unload cancel reports no failure')

// (d) the immediate path still closes exactly once, matching the LIVE record by
// its content identity, and only by the minted tab id.
const immediate = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  mountedSession: 'session-1',
  activeTab: openRecallTab(),
})
immediate.controller.setFlags({ ...ALL_OFF })
check(
  immediate.state.closes.length === 1 && immediate.state.closes[0] === RECALL_PAGE_TAB_ID,
  `a mounted recall page is closed once, by its minted tab id (saw ${immediate.state.closes.join(', ') || 'no close'})`,
)
check(
  immediate.state.closes[0] !== RECALL_TAB_ID,
  'the closed id is the page tab id, not the tab type id',
)
check(
  immediate.state.mountedListeners.size === 0,
  'an immediate close leaves no deferred listener behind',
)
// The live record's address is `contentId`; a harness that sent `kind` only, or
// the legacy `address` field, must still be recognised (the old check compared
// only `address` and never closed anything).
for (const [shape, tab] of [
  ['contentId', { id: 'tab-content-9', contentId: RECALL_PAGE_ADDRESS, title: '记忆召回' }],
  ['kind', { id: 'tab-kind-9', kind: RECALL_TAB_KIND, title: '记忆召回' }],
  ['legacy address', { id: 'tab-legacy-9', address: RECALL_PAGE_ADDRESS, title: '记忆召回' }],
]) {
  const shell = mountShell({ status: 'ready', value: { ...ALL_ON }, mountedSession: 'session-1', activeTab: tab })
  shell.controller.setFlags({ ...ALL_OFF })
  check(
    shell.state.closes.length === 1 && shell.state.closes[0] === tab.id,
    `the switch finds the recall page by its ${shape} identity`,
  )
}

// The mounted observable is optional: a harness whose right Sidebar exposes the
// active tab but not the mounted-Session observable can only try once. It must
// still unmount the surface without throwing and without inventing a retry.
const noMountedObservable = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  activeTab: openRecallTab(),
  mountedObservable: false,
})
check(
  noMountedObservable.threw === null,
  `apply() does not throw without the mounted observable${throwReason(noMountedObservable.threw)}`,
)
noMountedObservable.controller.setFlags({ ...ALL_OFF })
check(
  noMountedObservable.state.closes.length === 0 && noMountedObservable.state.mountedListeners.size === 0,
  'without the mounted observable the close is skipped, not retried',
)
check(
  !isLive(noMountedObservable.state, 'sidebar.right.pane.tab') &&
    noMountedObservable.state.tabTypes.length === 0 &&
    noMountedObservable.state.reports.length === 0,
  'the surface still unmounts cleanly when the close cannot be deferred',
)

// ---------------------------------------------------------------------------
// Style parity: the recall panel is styled from the shipped right-Sidebar tabs
// ---------------------------------------------------------------------------
// Each check below pins one of those copied declarations. The source is named per
// check: .header/.body/.row are the files tab's rules in
// `@deepseek-ai/dsh-client-ui-sidebar-files`, the field is the primitives package's
// `Input.module.css`, and the group header is `SearchBlock.module.css`.
check(
  injectedCss.includes('height: 38px; padding: 0 6px 0 8px;'),
  'recall header uses the files tab header height (38px)',
)
check(
  injectedCss.includes('border-bottom: .5px solid var(--dsw-alias-border-l3)'),
  'recall header has the files tab hairline, not a card edge',
)
// The pane clips a tab body (`overflow:hidden` on .tabBody), so a body that does
// not scroll itself is a list the user cannot reach the end of.
check(
  injectedCss.includes('flex: auto; min-height: 0; overflow: auto; scrollbar-gutter: stable;'),
  'recall body is the scroller, like the files tab body',
)
check(
  injectedCss.includes('padding: 6px 10px;') && injectedCss.includes('border-radius: var(--dsw-radius-md)'),
  'recall rows sit inside a card at the shipped row metrics',
)
// Every entry is outlined, and its score is graded by colour.
check(
  injectedCss.includes('border: .5px solid var(--dsw-alias-border-l3)'),
  'each recall entry carries the shipped card border',
)
for (const [tone, token] of [
  ['high', '--dsw-alias-state-success-primary'],
  ['mid', '--dsw-alias-state-warn-primary'],
  ['low', '--dsw-alias-state-error-primary'],
]) {
  check(
    injectedCss.includes(`.ove-recall-score-${tone} { color: var(${token}`),
    `the ${tone} score band uses the app's own ${token.replace('--dsw-alias-', '')} state colour`,
  )
}
// A flex ROW here put the abstract and the tags on the title's own line, which
// pushed the score to the middle of a multi-line item. The row is a block whose
// first child is the flex line; pin both halves.
check(
  injectedCss.includes('display: block; width: 100%; min-width: 0;'),
  'recall row is a block, so its second line starts under the title',
)
check(
  injectedCss.includes('.ove-recall-line { display: flex; align-items: center; gap: 6px; min-width: 0; }'),
  'exactly one line of a row is a flex line (title, score, caret)',
)
check(
  injectedCss.includes('border: .5px solid var(--dsw-alias-border-l4)'),
  'the query field uses the shipped Input border token',
)
check(
  injectedCss.includes('border-color: var(--dsw-alias-state-business-primary)'),
  'the query field focuses like the shipped Input',
)
// An entry body sits on the app's text-block surface. bg-layer-1 is the page's own
// colour, so the block was invisible against it in the light theme.
check(
  injectedCss.includes('background: var(--dsw-alias-markdown-code-block)'),
  'an opened entry reads as a text block, not as page background',
)
// The interface switches are a distinct group in the form, and a disabled one must
// look disabled: the row is otherwise a bare checkbox with no affordance.
check(
  injectedCss.includes('.ove-config-group {'),
  'the interface switches are a distinct group in the form stylesheet',
)
check(
  injectedCss.includes('.ove-config-check:disabled'),
  'a disabled switch dims instead of looking clickable',
)

// Style parity with the shell's own stats pills is the whole point of the pill's
// CSS, and a template-literal slip silently ships invalid declarations, so assert
// the resolved text rather than trusting a visual check.
check(typeof injectedCss === 'string' && injectedCss.length > 500, 'installs its stylesheet')
check(!injectedCss.includes('${'), 'stylesheet has no unresolved template expression')
check(
  injectedCss.includes('font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)'),
  'pill font size matches StatsPills.module.css',
)
check(
  injectedCss.includes('line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))'),
  'pill line height matches StatsPills.module.css',
)
check(injectedCss.includes('color: var(--dsw-alias-label-tertiary)'), 'pill label colour matches')
check(
  injectedCss.includes('background: var(--dsw-alias-interactive-bg-hover)'),
  'pill hover background matches',
)
check(injectedCss.includes('border-radius: 999px'), 'pill capsule shape matches')
check(
  injectedCss.includes('.ove-pill svg { flex: none; width: 14px; height: 14px; }'),
  'pill icon box matches the default pills (14x14)',
)
check(
  injectedCss.includes('font-variant-numeric: tabular-nums'),
  'pill figures are tabular like the default pills',
)

// One glyph, two mounts: the sidebar row and the pill must not drift apart, and
// the mark must stay self-contained (no cross-package icon lookup).
check(
  code.split('M6.5 6.5 9.5 9.5').length - 1 === 1,
  'the OpenViking mark is defined once and shared by both mounts',
)
// The mark must stay self-contained: the only thing the bundle may pull from the
// module table is React. Asserted on the require calls the factory actually makes
// rather than on the bundle's text, so a comment naming a package cannot trip it.
check(
  !required.some((id) => id.startsWith('@deepseek-ai/dsh-client-ui-')),
  `no cross-package icon dependency (required: ${required.join(', ') || 'nothing'})`,
)

// The failed-extraction state is the one thing nothing else in the system shows.
check(
  injectedCss.includes('.ove-pill-errored { color: var(--dsw-alias-state-warn-primary'),
  'the pill has a warning state for a failed extraction',
)
check(injectedCss.includes('.ove-failure'), 'the popover has a failure block')
check(injectedCss.includes('.ove-timeline'), 'the commit records render as a timeline')

if (failures.length > 0) {
  console.error(`[client] ${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('[client] all checks passed')
}
