/**
 * Browser half entry point — `exports["./client"]`, served by the shell at
 * `/plugins/dsh-openviking-enhance/client.js` and executed as a lazy-CJS
 * factory (`window.__ModuleLoader__.load({id, factory})`, see `build.mjs`).
 *
 * Failure policy: DOM and slot problems are logged, never thrown. A plugin whose
 * `apply` throws fails the whole web shell boot, and an external plugin must not
 * be able to take the GUI down. Every registration is owned by the mount table
 * below (or by `ctx.effect`), so an unload — or a feature switch — collapses it
 * cleanly and can mount it again later.
 *
 * Slot map, all verified against `@deepseek-ai/dsh-client-ui-{slots,sidebar,layout,conversation}@0.2.0-rc.2`,
 * and re-verified on 0.2.1-rc.2 and 0.2.1-rc.3:
 *   sidebar.panellist          list, root      owner {size, active}  → panel icon
 *   main                       keyed, root     key must equal the panellist id
 *   conversation.composer.dock list, session   inject(sessionId)     → status pill
 *
 * Plus one tab type in the right Sidebar
 * (`@deepseek-ai/dsh-client-ui-sidebar-right@0.2.0-rc.2`, re-verified on
 * 0.2.1-rc.2 and 0.2.1-rc.3), registered in two
 * stages because that is the only contract the framework offers:
 *   ctx.sidebarRightTabs.register({id, kind, title, guide})   stage one: a page type
 *   sidebar.right.pane.tab     keyed, session, key = that id → stage two: the body
 *
 * The three surfaces are switchable from the plugin's own settings form
 * (`showSidebarEntry` / `showCommitStatus` / `showRecallPanel`). `feature-toggles.ts`
 * reads the live values from `ctx.configForms`; this file owns the mount/unmount
 * pairs and the order they run in:
 *
 *  - mount: main panel before the sidebar row that opens it, because a row whose
 *    `main` key is not registered throws when selected;
 *  - unmount: the row before the main panel (the layout notices the key vanish
 *    and returns to the conversation by itself); the recall tab drops its body
 *    and then its type, while the switch additionally closes an open recall page
 *    (immediately when a surface is mounted, otherwise on its return);
 *  - `plugins.row.config` is registered unconditionally: the Configure form is
 *    the only way back after a surface has been hidden, so it must never be
 *    behind a switch itself.
 */
import type {
  ClientContext,
  SidebarRightService,
  SidebarRightTabRecord,
  SidebarRightTabRegistry,
} from './slot-service.ts'
import { installStyles } from './styles.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'
import { StudioPanel } from './studio-panel.tsx'
import { CommitStatusPill } from './commit-status.tsx'
import { RecallPanel } from './recall-panel.tsx'
import { ConfigPage } from './config-page.tsx'
import { attachLocale, t } from './locale.ts'
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_ORDER,
  watchFeatureFlags,
  type FeatureFlags,
} from './feature-toggles.ts'

/** Client services this half waits for before `apply` runs. */
export const inject = ['slots']

/** Sidebar row id; the same value keys the `main` panel entry. */
const PANEL_ID = 'openviking'

/**
 * Sort key of our sidebar row.
 *
 * The sidebar orders `sidebar.panellist` ascending by `order` and, on a tie, falls
 * back to registration order — which is plugin load order and therefore differs
 * between boots. That is exactly what made this row drift: it shared `order: 30`
 * with the skill-explorer row, so it sometimes sat before it and sometimes after.
 *
 * The values in use are 0 and 10 (the shell's own plugin and schedule rows), 20
 * (task board), 30 (skill explorer), and the framework's own contract doc shows
 * `order: 100` for a third-party panel row. This row is meant to be last, so it
 * sits well above all of those; a plain "just above the current maximum" value
 * would collide again with the next plugin that picks it.
 */
const SIDEBAR_ORDER = 1000

/**
 * The right Sidebar tab type.
 *
 * `id` is the implementation's identity and is what the framework keys the body
 * and title seats by; `kind` is what `ctx.sidebarRight.openTab(kind)` names. Both
 * are namespaced because the key domain is open: another plugin could register a
 * `recall` kind, and a collision on `id` throws.
 */
const RECALL_TAB_ID = 'dsh-openviking-enhance:recall'
const RECALL_TAB_KIND = 'openviking-recall'

/**
 * The address a page tab is recorded under (`sidebar://<kind>`). Hiding the
 * recall surface closes the page first when it is the one on screen, so the
 * column does not keep a record whose body and type no longer exist.
 */
const RECALL_PAGE_ADDRESS = `sidebar://${RECALL_TAB_KIND}`

/**
 * The plugin's own row on the Plugins page.
 *
 * The page keys the config seat by `<package name>#<row id>`, taken from the
 * bundle's manifest and its patch, and the **Configure** control appears only
 * because a registration exists here. Nothing else in DSH renders a form for a
 * plugin's Config, however well declared the schema is.
 *
 * `PACKAGE_NAME` is written out because the browser half has no package.json to
 * read; `scripts/smoke-client.mjs` asserts it equals the manifest's name. The row
 * id is also the settings namespace DSH serves the entry's form under, which is
 * why `configForms.get()` is given it directly rather than derived again.
 */
const PACKAGE_NAME = 'dsh-openviking-enhance'
const ROW_ID = 'openviking-enhance'
const CONFIG_ROW_KEY = `${PACKAGE_NAME}#${ROW_ID}`
const SETTINGS_NAMESPACE = ROW_ID

/**
 * Sidebar row glyph. The shell hands a list occupant only `{ size, active }` and
 * draws the button, title and highlight itself, so this adds just the marker the
 * panel row carries and defers the artwork to the shared mark — the same one the
 * status pill uses.
 */
function SidebarIcon(props: { size: number; active: boolean }) {
  return <OpenVikingIcon {...props} data-dsh-panel-entry={PANEL_ID} />
}

function report(context: ClientContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const logger = context.logger
  if (typeof logger?.warn === 'function') logger.warn(`[openviking-enhance] ${message}`, error)
  else console.error('[openviking-enhance]', error)
}

/**
 * Whether one right-Sidebar record is the recall page this plugin contributed.
 *
 * The live record is `{ id, kind, contentId, title }` and a page tab's address
 * (`sidebar://<kind>`) is `contentId`. Comparing only a field named `address`
 * (which the framework does not send) is what made the first cut of this switch
 * leave a dead recall tab behind: the check was always false, so `close()` never
 * ran. Match the content identity first, then the kind, and keep the legacy
 * field as a fallback for harness versions that sent it.
 */
function isRecallPage(tab: SidebarRightTabRecord): boolean {
  return (
    tab.contentId === RECALL_PAGE_ADDRESS ||
    tab.kind === RECALL_TAB_KIND ||
    tab.address === RECALL_PAGE_ADDRESS
  )
}

/**
 * Close the recall page when it is the one the right Sidebar is showing.
 *
 * Returns whether a close was issued. Best effort on purpose: the service may be
 * absent, or — the common case when the user edits the settings form — there may
 * be no mounted right-Sidebar surface at all while a Plugins page fills the main
 * column, so `active()` answers `undefined`. Callers arm a deferred retry for
 * that case.
 */
function tryCloseRecallTab(
  context: ClientContext,
  sidebarRight: SidebarRightService | undefined,
): boolean {
  if (sidebarRight === undefined) return false
  try {
    const active = sidebarRight.active?.()
    if (active === undefined || !isRecallPage(active)) return false
    sidebarRight.close?.(active.id)
    return true
  } catch (error) {
    report(context, error)
    return false
  }
}

export function apply(context: ClientContext): void {
  const disposers: Array<() => void> = []
  /** Live mounts, keyed by the switch that owns them. */
  const mounted = new Map<keyof FeatureFlags, () => void>()

  // The app's language, for every string this half renders. Read live by `t()`,
  // so switching the app's locale does not need a reload.
  //
  // Attached through a SCOPED injection, not a property read.
  //
  // Reading `context.locale` throws (`cannot get property "locale" without
  // inject`) and, sitting outside every `try`, it took the whole entry down: no
  // sidebar row, no commit pill, no recall tab. Reading it through the plain
  // `get()` accessor is legal but does not reach it either — the form then fell
  // back to `navigator.language`, so the plugin spoke the browser's language
  // instead of the app's. This is the same two-stage pattern the recall tab uses
  // for its registry, and for the same reason: the callback runs when the service
  // exists and is never a dependency the entry waits on.
  context.inject(['locale'], (scope) => {
    attachLocale(scope.get('locale') as Parameters<typeof attachLocale>[0])
  })

  try {
    installStyles()
  } catch (error) {
    report(context, error)
  }

  /**
   * The right Sidebar's outward face, kept for the recall mount to close that
   * tab on the way out. Optional like the settings service: a composition
   * without it keeps the recall surface, it just cannot pre-close the page.
   */
  let sidebarRight: SidebarRightService | undefined
  try {
    const watch = context.inject(['sidebarRight'], (scope) => {
      sidebarRight = scope.get('sidebarRight') as SidebarRightService | undefined
      return () => {
        sidebarRight = undefined
      }
    })
    disposers.push(() => watch.dispose())
  } catch (error) {
    report(context, error)
  }

  const slots = context.slots

  /**
   * A recall-page close that has to wait for the right Sidebar to come back.
   *
   * The settings form lives on the Plugins page, and that page fills the main
   * column: while it is open the conversation — and with it the right Sidebar's
   * mounted surface — is unmounted, so `sidebarRight.active()` answers
   * `undefined` and the open recall page cannot be found at save time. The switch
   * still unmounts the surface immediately; this set remembers to close the page
   * as soon as the column is mounted again. Re-enabling the switch, or unloading
   * the plugin, cancels the pending work.
   */
  const pendingRecallCloses = new Set<() => void>()

  function cancelPendingRecallCloses(): void {
    for (const cancel of [...pendingRecallCloses]) {
      pendingRecallCloses.delete(cancel)
      try {
        cancel()
      } catch (error) {
        report(context, error)
      }
    }
  }

  function armRecallTabClose(): void {
    const right = sidebarRight
    if (right === undefined) return
    // The surface may actually be mounted (another window, a hot reload): try
    // once before subscribing.
    if (tryCloseRecallTab(context, right)) return
    const mounted = right.mounted
    if (mounted === undefined || typeof mounted.subscribe !== 'function') return

    let stopped = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      try {
        unsubscribe?.()
      } catch (error) {
        report(context, error)
      }
      unsubscribe = undefined
      pendingRecallCloses.delete(stop)
    }
    // The mounted Session changes before React renders the arriving commit, so
    // the store the tab record lives in may not be adopted yet at notification
    // time. A handful of short retries covers that gap without a poll forever.
    const attempt = (remaining: number): void => {
      if (stopped) return
      if (tryCloseRecallTab(context, right)) {
        stop()
        return
      }
      if (remaining <= 0) {
        stop()
        return
      }
      timer = setTimeout(() => attempt(remaining - 1), 60)
    }
    try {
      unsubscribe = mounted.subscribe(() => attempt(6))
    } catch (error) {
      report(context, error)
      return
    }
    pendingRecallCloses.add(stop)
  }

  /**
   * The Studio surface: the left sidebar row and the centre page it opens.
   *
   * Main first, then the row — a row is clickable the moment it exists, and
   * selecting one whose `main` key is not registered throws in the shell.
   */
  function mountSidebarEntry(): () => void {
    const disposeMain = slots.inject('main', () =>
      slots.register({ name: 'main', key: PANEL_ID }, StudioPanel),
    )
    const disposeRow = slots.inject('sidebar.panellist', () =>
      slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: SIDEBAR_ORDER,
          label: () => 'OpenViking',
        },
        SidebarIcon,
      ),
    )
    return () => {
      // Row first: the layout reacts to the `main` key disappearing by returning
      // to the conversation, so dropping the page while the row still points at
      // it would leave a row that throws when clicked for one render.
      disposeRow()
      disposeMain()
    }
  }

  /**
   * The session footer status pill. The inject factory receives the session id
   * because the slot is session-scoped. `order: 1` places it after the shell's
   * stats pills and the context meter; the row keeps its own centring.
   */
  function mountCommitStatus(): () => void {
    return slots.inject('conversation.composer.dock', () =>
      slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'openviking-commit',
          order: 1,
          inject: (sessionId: string) => ({ sessionId }),
        },
        CommitStatusPill,
      ),
    )
  }

  /**
   * The right Sidebar tab, contributed in the two stages the framework asks for.
   *
   * Waiting on the REGISTRY (a service), not on the slot declaration, is
   * load-bearing: the right Sidebar's own seat declares
   * `sidebar.right.pane.tab` before it provides `sidebarRightTabs`, so a
   * registration triggered by the declaration would read the registry as absent
   * and — because a declaration never collapses — never retry.
   */
  function mountRecallPanel(): () => void {
    const seat = context.inject(['sidebarRightTabs'], (scope) => {
      const tabs = scope.get('sidebarRightTabs') as SidebarRightTabRegistry | undefined
      if (tabs === undefined) return
      const disposeType = tabs.register({
        id: RECALL_TAB_ID,
        kind: RECALL_TAB_KIND,
        title: () => t('recall.tabTitle'),
        // The guide is how the tab is found at all: the right Sidebar opens on its
        // guide page, and a type with no entry there is reachable only by code.
        guide: [
          {
            id: 'recall',
            order: 40,
            title: () => t('recall.tabTitle'),
            description: () => t('recall.tabDescription'),
          },
        ],
      })
      try {
        // Stage two: the body, keyed by the type's own id (that is what the
        // framework dispatches on). Registered on the slot declaration, which the
        // right Sidebar has certainly made by the time its registry exists.
        const disposeBody = slots.inject('sidebar.right.pane.tab', () =>
          slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: RECALL_TAB_ID,
              inject: (sessionId: string) => ({ sessionId }),
            },
            RecallPanel,
          ),
        )
        return () => {
          // Drop the body before the type: the registry refuses a second
          // registration of the same id for the rest of the page's life, and a
          // type whose body is missing renders the framework's dead-page notice.
          // Closing an open page is the switch's job (`applyFeature`), not this
          // teardown's: a plugin unload or HMR reload must not discard the tab
          // the user had open.
          disposeBody()
          disposeType()
        }
      } catch (error) {
        // A body that failed to register must not leave the type claimed: the
        // registry refuses a second registration of the same id for the rest of
        // the page's life.
        disposeType()
        throw error
      }
    })
    return () => seat.dispose()
  }

  const mounts: Record<keyof FeatureFlags, () => () => void> = {
    sidebarEntry: mountSidebarEntry,
    commitStatus: mountCommitStatus,
    recallPanel: mountRecallPanel,
  }

  /** Mount or unmount one surface; a mount failure is logged, never thrown. */
  function applyFeature(feature: keyof FeatureFlags, on: boolean): void {
    const live = mounted.get(feature)
    if (on && live === undefined) {
      // A surface that is coming back cancels a "close the stale page" retry
      // armed when it went away: the page may be the user's own, restored.
      if (feature === 'recallPanel') cancelPendingRecallCloses()
      try {
        mounted.set(feature, mounts[feature]())
      } catch (error) {
        report(context, error)
      }
      return
    }
    if (!on && live !== undefined) {
      mounted.delete(feature)
      // Only the switch closes the recall page (see the mount's teardown for why
      // an unload must not). When the settings form is what did the hiding, the
      // right Sidebar is unmounted, so the close is retried on its return.
      const closed = feature === 'recallPanel' ? tryCloseRecallTab(context, sidebarRight) : false
      try {
        live()
      } catch (error) {
        report(context, error)
      }
      if (feature === 'recallPanel' && !closed) armRecallTabClose()
    }
  }

  /** Apply one settings answer to every surface. */
  function applyFlags(flags: FeatureFlags): void {
    for (const feature of FEATURE_ORDER) applyFeature(feature, flags[feature])
  }

  // Start from the pre-switch behaviour: everything on. A settings answer that
  // arrives later (or a stored `false`) turns the chosen surfaces off; one that
  // never arrives leaves the plugin exactly as it shipped.
  applyFlags(DEFAULT_FEATURE_FLAGS)

  // Watch the switches for the rest of the page's life. The callback runs when a
  // ready snapshot is already held, so a persisted `false` applies on boot too.
  let stopWatching = (): void => {}
  try {
    stopWatching = watchFeatureFlags(context, SETTINGS_NAMESPACE, applyFlags)
  } catch (error) {
    report(context, error)
  }

  // The plugin's own settings, on its row of the Plugins page. Registered
  // unconditionally — this form is where a hidden surface is switched back on.
  try {
    disposers.push(
      context.slots.inject('plugins.row.config', () =>
        context.slots.register({ name: 'plugins.row.config', key: CONFIG_ROW_KEY }, ConfigPage),
      ),
    )
  } catch (error) {
    report(context, error)
  }

  context.effect(
    () => () => {
      // Stop observing first: an unload must not race a settings answer into
      // mounting a surface while the mounts below are being torn down.
      try {
        stopWatching()
      } catch (error) {
        report(context, error)
      }
      // An unload must not fire a deferred close after the surfaces are gone.
      cancelPendingRecallCloses()
      for (const feature of [...FEATURE_ORDER].reverse()) {
        const live = mounted.get(feature)
        if (live === undefined) continue
        mounted.delete(feature)
        try {
          live()
        } catch (error) {
          report(context, error)
        }
      }
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          report(context, error)
        }
      }
    },
    'openviking-enhance: ui mounts',
  )
}
