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
/** The session-log/Doctor tab type's identity and kind. */
const HEALTH_TAB_ID = 'dsh-openviking-enhance:health'
const HEALTH_TAB_KIND = 'openviking-health'
/** The v0.4 URI-preview tab type and its kind. */
const PREVIEW_TAB_ID = 'dsh-openviking-enhance:preview'
const PREVIEW_TAB_KIND = 'openviking-preview'
/** The v0.4 Explore tab type and its kind. */
const EXPLORE_TAB_ID = 'dsh-openviking-enhance:explore'
const EXPLORE_TAB_KIND = 'openviking-explore'
/** The v0.5 Activity tab type and kind. */
const ACTIVITY_TAB_ID = 'dsh-openviking-enhance:activity'
const ACTIVITY_TAB_KIND = 'openviking-activity'
/** The address a page tab is recorded under, as the container addresses it. */
const RECALL_PAGE_ADDRESS = `sidebar://${RECALL_TAB_KIND}`
/** The config seat's key on the Plugins page. */
const CONFIG_ROW_KEY = `${pkg.name}#openviking-enhance`
/** The settings namespace the config form lives under (the Loader row id). */
const SETTINGS_NAMESPACE = 'openviking-enhance'

const ALL_ON = {
  showSidebarEntry: true,
  showCommitStatus: true,
  showRecallPanel: true,
  showRecallExplain: true,
  showHealthPanel: true,
  showPreview: true,
  showExplore: true,
  enableCommands: true,
  enableActivity: true,
  showScopeBanner: true,
  showNativeViews: true,
  showOnboarding: true,
  enableWrites: true,
}
const ALL_OFF = {
  showSidebarEntry: false,
  showCommitStatus: false,
  showRecallPanel: false,
  showRecallExplain: false,
  showHealthPanel: false,
  showPreview: false,
  showExplore: false,
  enableCommands: false,
  enableActivity: false,
  showScopeBanner: false,
  showNativeViews: false,
  showOnboarding: false,
  enableWrites: false,
}
/**
 * The three additive seats that are registered regardless of any switch: the
 * write confirmation dialog and undo toast (`shell.overlay`) and the keyed
 * `/viking` command renderer. They render nothing until raised, so a hidden
 * write surface still pays only a null render.
 */
const ADDITIVE_SEAT_NAMES = ['shell.overlay', 'shell.overlay', 'conversation.chat.commandview'].sort()
const ADDITIVE_SEATS = ADDITIVE_SEAT_NAMES.length
const CONFIG_SEATS = 1
/**
 * The client-mounted switch surfaces: the v0.3/v0.4/v0.5 ones plus the v0.7
 * Plugins-page Setup card. `showNativeViews` is not a mount — it switches the
 * body of the already-mounted main panel through the native store.
 */
const MOUNTED_SWITCHES = 12
/** Every live seat when all switches are on: mounts + additive seats + the form. */
const ALL_SEATS_COUNT = MOUNTED_SWITCHES + ADDITIVE_SEATS + CONFIG_SEATS
const ALL_TAB_TYPES = 5
const BOOT_SEATS = [
  'conversation.chat.commandview',
  'conversation.chat.turnTail',
  'conversation.composer.dock',
  'conversation.composer.dock',
  'main',
  'plugins.detail.section',
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
].sort()

/** The recall page as an open tab, in the LIVE 0.2.2-rc.1 record shape.
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
    /** `openTab(kind, options)` calls, in order. */
    openTabs: [],
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
    openTab(kind, options) {
      state.openTabs.push({ kind, options })
      push({ type: 'open', entry: kind })
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
/** The additive seats still live in a state (dialog, toast, command card). */
const liveAdditive = (state) => state.registrations.filter((held) => held.options.name === 'shell.overlay' || held.options.name === 'conversation.chat.commandview')
/** True when only the additive seats + the configuration row remain. */
const onlyAdditiveAndConfig = (state) => {
  const names = [...state.registrations.map((held) => held.options.name)].sort()
  return names.length === ADDITIVE_SEATS + CONFIG_SEATS && liveOf(state, 'plugins.row.config').length === 1
}
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

// Two dock entries: the status pill and the v0.5 scope chip. Each renders an
// invisible mirror + its own surface so the default pills stay centred.
check(dock.length === 2, `registers two dock entries (saw ${dock.length})`)
const pill = dock.find((options) => options.id === 'openviking-commit')
check(pill !== undefined, 'one dock entry is the commit pill')
check(dock.some((options) => options.id === 'openviking-scope'), 'the other is the scope chip')
check(typeof pill?.inject === 'function', 'status pill declares a session inject face')
check(onState.injectedKeys.length === ALL_SEATS_COUNT, `all ${ALL_SEATS_COUNT} slots are injected (saw ${onState.injectedKeys.length})`)
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
check(onState.tabTypes.length === ALL_TAB_TYPES, `registers all ${ALL_TAB_TYPES} right-Sidebar tab types (saw ${onState.tabTypes.length})`)
const tabType = onState.tabTypes[0]?.definition
check(
  typeof tabType?.id === 'string' && tabType.id.includes(':'),
  `tab id is namespaced, since the registry's key domain is open (${tabType?.id})`,
)
check(tabType?.kind === RECALL_TAB_KIND, `recall tab kind is namespaced (${tabType?.kind})`)
const healthType = onState.tabTypes[1]?.definition
check(healthType?.id === HEALTH_TAB_ID, `health tab id is namespaced (${healthType?.id})`)
check(healthType?.kind === HEALTH_TAB_KIND, `health tab kind is namespaced (${healthType?.kind})`)
check(Array.isArray(healthType?.guide) && healthType.guide.length === 1, 'the health tab carries a guide entry')
const previewType = onState.tabTypes[2]?.definition
check(previewType?.id === PREVIEW_TAB_ID, `preview tab id is namespaced (${previewType?.id})`)
check(previewType?.kind === PREVIEW_TAB_KIND, `preview tab kind is namespaced (${previewType?.kind})`)
check(Array.isArray(previewType?.guide) && previewType.guide.length === 1, 'the preview tab carries a guide entry')
const exploreType = onState.tabTypes[3]?.definition
check(exploreType?.id === EXPLORE_TAB_ID, `explore tab id is namespaced (${exploreType?.id})`)
check(exploreType?.kind === EXPLORE_TAB_KIND, `explore tab kind is namespaced (${exploreType?.kind})`)
check(Array.isArray(exploreType?.guide) && exploreType.guide.length === 1, 'the Explore tab carries a guide entry')
const activityType = onState.tabTypes[4]?.definition
check(activityType?.id === ACTIVITY_TAB_ID, `activity tab id is namespaced (${activityType?.id})`)
check(activityType?.kind === ACTIVITY_TAB_KIND, `activity tab kind is namespaced (${activityType?.kind})`)
check(Array.isArray(activityType?.guide) && activityType.guide.length === 1, 'the Activity tab carries a guide entry')
check(activityType?.guide?.[0]?.order === 44, 'the Activity guide entry sits after the v0.4 pages')
// The tab bodies: keys are the type ids, and each is a session slot.
for (const id of [RECALL_TAB_ID, HEALTH_TAB_ID, PREVIEW_TAB_ID, EXPLORE_TAB_ID, ACTIVITY_TAB_ID]) {
  const body = onState.registrations.find(
    (held) => held.options.name === 'sidebar.right.pane.tab' && held.options.key === id,
  )?.options
  check(body !== undefined, `a tab body is registered for ${id}`)
  check(typeof body?.inject === 'function', `the ${id} body declares a session inject face`)
}
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
check(code.includes('/preview'), 'the preview panel requests the host preview route')
// v0.5 read + write routes: the client only ever calls document-relative paths.
for (const route of ['/scope', '/profiles', '/tasks', '/metrics', '/audit', '/session-control', '/write/prepare', '/write/execute', '/write/undo', '/write/cancel', '/task/cancel', '/profiles/save']) {
  check(code.includes(route), `the browser half knows ${route}`)
}
// The additive frame-wide seats and the keyed command renderer.
const overlaySeats = liveOf(onState, 'shell.overlay').map((held) => held.options.id)
check(overlaySeats.length === 2 && overlaySeats.includes('openviking-write-dialog') && overlaySeats.includes('openviking-write-toast'), `the two overlay entries are registered (${overlaySeats.join(', ')})`)
const commandSeat = liveOf(onState, 'conversation.chat.commandview')[0]?.options
check(commandSeat?.key === 'viking', `the command view is keyed by the command name (${commandSeat?.key})`)
check(typeof commandSeat?.inject === 'function', 'the command view declares a session inject face')
check(typeof exports.VikingCommandCard === 'function', 'the rich /viking card ships for the server-render harness')
check(exports.parseEnvelope('x\n' + JSON.stringify({ ov: '1', kind: 'open-editor', uri: 'viking://user/default/memories/preferences/tools.md' }))?.kind === 'open-editor', 'the command card parser reads the host envelope')
check(typeof exports.ActivityPanel === 'function', 'the Activity panel ships')
// v0.7: the native cockpit, its onboarding card, the shared preview body and the
// extracted metric cards are all part of the bundle's public surface (the
// server-render harness mounts them directly).
for (const name of ['OpenVikingPanel', 'NativeCockpit', 'NativeOverview', 'NativeBrowse', 'NativeSessions', 'NativeCommits', 'NativeStats', 'PreviewBody', 'OnboardingCard', 'OnboardingSetupSection', 'MetricsCards', 'MetricCard']) {
  check(typeof exports[name] === 'function', `the bundle ships ${name}`)
}
check(typeof exports.getNativeState === 'function' && typeof exports.navigateNative === 'function', 'the native navigation store ships')
check(typeof exports.setNativeSwitches === 'function' && typeof exports.__setNativeLayoutForTests === 'function', 'the native store exposes its documented test seams')
check(exports.getNativeState().switches.nativeViews === true, 'the native cockpit is the shipped default')
check(exports.getNativeState().view === 'overview', 'the cockpit opens on Overview')
// The native views only call document-relative host routes of their own.
for (const route of ['/overview', '/browse/roots', '/browse/subtree', '/browse?', '/sessions', '/recent-commits', '/studio-status', '/onboarding/state']) {
  check(code.includes(route), `the browser half knows the native route ${route}`)
}
// v0.8 Operate reads + the ops mutation family are document-relative too.
for (const route of [
  '/snapshot-log', '/snapshot-show', '/snapshot-diff', '/snapshot-diff-paths', '/snapshot-versions', '/snapshot-ignore',
  '/compile-target', '/compile-operations', '/compile-operation', '/compile-outputs', '/compile-submission',
  '/observability', '/pack/history', '/task/evidence', '/ops/download',
  '/ops/prepare', '/ops/execute', '/ops/plan', '/ops/undo', '/ops/cancel',
]) {
  check(code.includes(route), `the browser half knows the v0.8 route ${route}`)
}
// v0.9 multi-scope reads/mutations are document-relative too; the scope header is
// attached by the shared request layer rather than each call site.
for (const route of ['/scopes', '/scope/identity', '/session-scope', '/acl']) {
  check(code.includes(route), `the browser half knows the v0.9 route ${route}`)
}
check(code.includes('x-dsh-openviking-scope'), 'the browser half sends the scope fingerprint header')
// The second Plugins-page section is registered under its own id, just above the
// v0.3 health summary; it is the setup surface older-DSH users fall back to.
const detailSections = liveOf(onState, 'plugins.detail.section').map((held) => held.options)
check(detailSections.length === 2, `the plugin contributes two Plugins-page sections (saw ${detailSections.length})`)
check(detailSections.some((options) => options.id === 'openviking-setup' && options.order === 39), 'the Setup card is registered at order 39')
check(detailSections.some((options) => options.id === 'openviking-health' && options.order === 40), 'and the health summary still sits below it')
check(liveOf(onState, 'main').length === 1, 'exactly one main panel remains (no second sidebar row)')
check(typeof exports.ScopeChip === 'function', 'the scope chip ships')
for (const name of ['ScopeMenu', 'ScopeBanner', 'ScopeSwitchNoticeLine', 'SessionScopeBanner', 'AccessPanel']) {
  check(typeof exports[name] === 'function', `the bundle ships the v0.9 surface ${name}`)
}
check(typeof exports.setScopeSwitcherEnabled === 'function' && typeof exports.setScopeBannerEnabled === 'function', 'the two scope switches are exposed to the harness')
check(typeof exports.scopeKey === 'function', 'the browser half can read the active scope key')
check(typeof exports.WriteDialog === 'function' && typeof exports.WriteToast === 'function', 'the write dialog and undo toast ship')
// The shared URI link and the preview store are the v0.4 deep-link seam. The
// shell only reads apply/inject; the extra exports exist for these harnesses.
check(typeof exports.openPreview === 'function', 'the bundle exports the deep-link opener for the harness')
check(typeof exports.VikingUriLink === 'function', 'the bundle ships the shared viking:// link component')
check(typeof exports.PreviewPanel === 'function' && typeof exports.ExplorePanel === 'function', 'the two v0.4 panels ship')
check(typeof exports.previewUriParam === 'function', 'the preview knows how to read its navigation params')
check(
  exports.previewUriParam({ uri: 'viking://user/default/memories/x.md' }) === 'viking://user/default/memories/x.md',
  'the navigation params carry the preview URI',
)
check(exports.previewUriParam({}) === null && exports.previewUriParam(undefined) === null, 'missing params are an empty preview')
// Clicking a URI anywhere calls openPreview: the target is recorded AND the tab
// is opened with the URI as framework navigation params.
exports.openPreview('viking://user/default/memories/entities/项目/lifeos.md')
const openedPreview = [...onState.openTabs].reverse().find((entry) => entry.kind === PREVIEW_TAB_KIND)
check(openedPreview !== undefined, 'a URI click opens the preview tab')
check(
  openedPreview?.options?.params?.uri === 'viking://user/default/memories/entities/项目/lifeos.md',
  `the URI travels as tab navigation params (saw ${JSON.stringify(openedPreview?.options)})`,
)
check(
  exports.getPreviewTarget()?.uri === 'viking://user/default/memories/entities/项目/lifeos.md',
  'and the store keeps the target for harness generations without params',
)
exports.resetPreviewStore()
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
// v0.4: the preview and Explore tabs follow the same right-Sidebar metrics, and
// the shared URI link is the one thing every surface renders.
check(injectedCss?.includes('.ove-preview-bar'), 'installs the preview tab stylesheet')
check(injectedCss?.includes('.ove-preview-text'), 'the preview renders L2 as a text block, not HTML')
check(injectedCss?.includes('.ove-explore-nav'), 'installs the Explore tab stylesheet')
check(injectedCss?.includes('.ove-explore-tester'), 'the rule tester has its own styles')
check(injectedCss?.includes('.ove-uri-link'), 'installs the shared viking:// link style')
check(injectedCss?.includes('.ove-explain-card'), 'installs the recall explanation stylesheet')
check(injectedCss?.includes('.ove-health'), 'installs the memory health stylesheet')
check(injectedCss?.includes('.ove-diff-line-add') && injectedCss?.includes('.ove-diff-line-remove'), 'installs the diff line styles')
// v0.5 styles: the scope chip, the write dialog/toast, the Activity tab, the
// command card and the settings profile editor all ship their own CSS.
for (const className of ['.ove-scope-chip', '.ove-write-dialog', '.ove-write-editor', '.ove-toast', '.ove-act-task', '.ove-cmd', '.ove-config-profile-row']) {
  check(injectedCss?.includes(className), `installs the ${className} styles`)
}
// v0.9 styles: the scope menu/banner/switch notice, the session mismatch banner
// and the read-only ACL Access tab.
for (const className of ['.ove-scope-menu', '.ove-scope-banner', '.ove-scope-switch-notice', '.ove-scope-session-banner', '.ove-acl-panel']) {
  check(injectedCss?.includes(className), `installs the ${className} styles`)
}
check(injectedCss?.includes('pointer-events: auto'), 'the click-through overlay entries opt back into pointer events')

// ---------------------------------------------------------------------------
// Scenario 2 — a saved all-off answer: nothing surface-mounted, form still there
// ---------------------------------------------------------------------------
const off = mountShell({ status: 'ready', value: { ...ALL_OFF }, activeTab: openRecallTab() })
check(off.threw === null, `apply() does not throw with every switch off${throwReason(off.threw)}`)
const offState = off.state
check(
  onlyAdditiveAndConfig(offState),
  `an entry saved off mounts none of the client surfaces; only the additive seats and the form remain (saw ${liveNames(offState).join(', ') || 'nothing'})`,
)
check(
  liveAdditive(offState).length === ADDITIVE_SEATS,
  'the write dialog/toast/command card stay registered because they render nothing until raised',
)
check(!isLive(offState, 'sidebar.panellist'), 'the left-sidebar row stays unmounted')
check(!isLive(offState, 'main'), 'the Studio main panel stays unmounted')
check(!isLive(offState, 'conversation.composer.dock'), 'the commit pill stays unmounted')
check(!isLive(offState, 'sidebar.right.pane.tab'), 'both tab bodies stay unmounted')
check(!isLive(offState, 'conversation.chat.turnTail'), 'the recall explanation tail stays unmounted')
check(!isLive(offState, 'plugins.detail.section'), 'the plugin-page health summary stays unmounted')
check(offState.tabTypes.length === 0, 'all four tab types stay unregistered')
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
  liveNames(boot.state).length === ALL_SEATS_COUNT && boot.state.tabTypes.length === ALL_TAB_TYPES,
  `the initial mount is the pre-switch behaviour: every surface on (saw ${liveNames(boot.state).join(', ') || 'nothing'})`,
)
boot.controller.setSnapshot({ status: 'ready', value: { ...ALL_OFF } })
check(onlyAdditiveAndConfig(boot.state), 'a later answer with false hides the surfaces then')
check(boot.state.tabTypes.length === 0, 'and every tab type is disposed then')

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
check(liveNames(live.state).length === ALL_SEATS_COUNT, `a saved all-on answer leaves every surface mounted (saw ${liveNames(live.state).length})`)

// (b) turn everything off through the form listener.
const hideCursor = live.state.events.length
live.controller.setFlags({ ...ALL_OFF })
const hidden = live.state
check(
  onlyAdditiveAndConfig(hidden),
  `hiding every surface leaves only the additive seats and the configuration row (saw ${liveNames(hidden).join(', ') || 'nothing'})`,
)
check(!isLive(hidden, 'sidebar.panellist'), 'the sidebar row is unmounted live')
check(!isLive(hidden, 'main'), 'the Studio page is unmounted live')
check(!isLive(hidden, 'conversation.composer.dock'), 'the commit pill and scope chip are unmounted live')
check(!isLive(hidden, 'sidebar.right.pane.tab'), 'all five tab bodies are unmounted live')
check(!isLive(hidden, 'conversation.chat.turnTail'), 'the recall explanation tail is unmounted live')
check(!isLive(hidden, 'plugins.detail.section'), 'the plugin-page health summary is unmounted live')
check(hidden.tabTypes.length === 0, 'all five tab types are unregistered live')
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
  hidden.events.length === settledCursor && onlyAdditiveAndConfig(hidden),
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
  liveNames(shown).length === ALL_SEATS_COUNT && [...liveNames(shown)].sort().join(',') === BOOT_SEATS.join(','),
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
  shown.tabTypes.length === ALL_TAB_TYPES &&
    [RECALL_TAB_ID, HEALTH_TAB_ID, PREVIEW_TAB_ID, EXPLORE_TAB_ID, ACTIVITY_TAB_ID].every((id) =>
      shown.tabTypes.some((held) => held.definition.id === id),
    ),
  'all five tab types come back',
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
  noCommit.state.tabTypes.length === ALL_TAB_TYPES && liveOf(noCommit.state, 'sidebar.right.pane.tab').length === ALL_TAB_TYPES,
  'only the commit switch off leaves every right-Sidebar surface mounted',
)
check(
  !liveOf(noCommit.state, 'conversation.composer.dock').some((held) => held.options.id === 'openviking-commit') &&
    liveOf(noCommit.state, 'conversation.composer.dock').some((held) => held.options.id === 'openviking-scope'),
  'only the commit pill is removed; the scope chip stays',
)

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
    noSidebar.state.tabTypes.length === ALL_TAB_TYPES,
  'only the sidebar switch off keeps the pill and the right-Sidebar tabs',
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
  liveNames(tolerant.state).length === ALL_SEATS_COUNT,
  `only a literal boolean false hides a surface (saw ${liveNames(tolerant.state).join(', ') || 'nothing'})`,
)
const absentFlags = mountShell({
  status: 'ready',
  value: { endpoint: 'http://127.0.0.1:1933' },
  activeTab: openRecallTab(),
})
check(
  liveNames(absentFlags.state).length === ALL_SEATS_COUNT,
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
  liveNames(noSettings.state).length === ALL_SEATS_COUNT,
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
  liveOf(cancelled.state, 'sidebar.right.pane.tab').length === ALL_TAB_TYPES && cancelled.state.tabTypes.length === ALL_TAB_TYPES,
  'the right-Sidebar surfaces are mounted again, not closed',
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
// Scenario 8 — the two v0.4 tabs are ordinary live switches
// ---------------------------------------------------------------------------
// They must behave exactly like the shipped ones: hidden live, no churn, back on
// live in the documented order, and their open page closed when hidden.
const v04 = mountShell({
  status: 'ready',
  value: { ...ALL_ON },
  mountedSession: 'session-1',
  activeTab: { id: 'tab-preview-1', kind: PREVIEW_TAB_KIND, contentId: `sidebar://${PREVIEW_TAB_KIND}`, title: '预览' },
})
check(v04.threw === null, `apply() does not throw with the v0.4 switches on${throwReason(v04.threw)}`)
check(
  liveOf(v04.state, 'sidebar.right.pane.tab').length === ALL_TAB_TYPES && v04.state.tabTypes.length === ALL_TAB_TYPES,
  'both v0.4 tabs mount with the shipped surfaces',
)
// Guide entries are how a person opens a page; assert their order is after the
// v0.3 pages and distinct.
for (const [type, order] of [
  [v04.state.tabTypes.find((held) => held.definition.id === PREVIEW_TAB_ID), 42],
  [v04.state.tabTypes.find((held) => held.definition.id === EXPLORE_TAB_ID), 43],
]) {
  check(type?.definition.guide?.[0]?.order === order, `the ${type?.definition.id} guide entry sits at order ${order}`)
}
const v04Cursor = v04.state.events.length
v04.controller.setFlags({ ...ALL_ON, showPreview: false })
check(
  !v04.state.tabTypes.some((held) => held.definition.id === PREVIEW_TAB_ID),
  'turning the preview switch off unregisters its tab type live',
)
check(
  v04.state.tabTypes.some((held) => held.definition.id === EXPLORE_TAB_ID),
  'and leaves the Explore tab alone',
)
check(v04.state.closes.length === 1, 'and closes the open preview page it can see')
const v04Churn = v04.state.events
  .slice(v04Cursor)
  .filter((event) => event.type === 'register' || event.type === 'tab-register')
check(v04Churn.length === 0, 'hiding a v0.4 tab mounts nothing')

// `enableCommands` is host-side: it changes no client mount, and the settings
// save that carries it must not churn the surfaces.
const commandsCursor = v04.state.events.length
v04.controller.setFlags({ ...ALL_ON, showPreview: false, enableCommands: false })
check(
  v04.state.events.length === commandsCursor,
  'the host-side command switch causes no client mount churn',
)

// Both come back live, type before body.
const v04ShowCursor = v04.state.events.length
v04.controller.setFlags({ ...ALL_ON })
check(
  v04.state.tabTypes.length === ALL_TAB_TYPES &&
    v04.state.tabTypes.some((held) => held.definition.id === PREVIEW_TAB_ID) &&
    v04.state.tabTypes.some((held) => held.definition.id === EXPLORE_TAB_ID),
  'both v0.4 tab types come back live',
)
const shownPreviewType = tabEventIndex(v04.state, v04ShowCursor, 'tab-register')
const shownPreviewBody = registerIndex(v04.state, v04ShowCursor, 'sidebar.right.pane.tab')
check(
  shownPreviewType !== -1 && shownPreviewBody !== -1 && shownPreviewType < shownPreviewBody,
  'the v0.4 tab types are registered before their bodies again',
)
check(v04.state.reports.length === 0, `toggling the v0.4 tabs reports no failure (saw ${v04.state.reports.join('; ') || 'none'})`)

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
