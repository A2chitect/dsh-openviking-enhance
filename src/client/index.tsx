/**
 * Browser half entry point — `exports["./client"]`, served by the shell at
 * `/plugins/dsh-openviking-enhance/client.js` and executed as a lazy-CJS
 * factory (`window.__ModuleLoader__.load({id, factory})`, see `build.mjs`).
 *
 * Failure policy: DOM and slot problems are logged, never thrown. A plugin whose
 * `apply` throws fails the whole web shell boot, and an external plugin must not
 * be able to take the GUI down. Every registration is owned by `ctx.effect`, so
 * an unload (or an HMR reload) collapses both mounts cleanly.
 *
 * Slot map, all verified against `@deepseek-ai/dsh-client-ui-{slots,sidebar,layout,conversation}@0.2.0-rc.2`:
 *   sidebar.panellist          list, root      owner {size, active}  → panel icon
 *   main                       keyed, root     key must equal the panellist id
 *   conversation.composer.dock list, session   inject(sessionId)     → status pill
 *
 * Plus one tab type in the right Sidebar
 * (`@deepseek-ai/dsh-client-ui-sidebar-right@0.2.0-rc.2`), registered in two
 * stages because that is the only contract the framework offers:
 *   ctx.sidebarRightTabs.register({id, kind, title, guide})   stage one: a page type
 *   sidebar.right.pane.tab     keyed, session, key = that id → stage two: the body
 */
import type { ClientContext, SidebarRightTabRegistry } from './slot-service.ts'
import { installStyles } from './styles.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'
import { StudioPanel } from './studio-panel.tsx'
import { CommitStatusPill } from './commit-status.tsx'
import { RecallPanel } from './recall-panel.tsx'
import { ConfigPage } from './config-page.tsx'
import { attachLocale, t } from './locale.ts'

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
 * The key of this plugin's row configuration on the Plugins page.
 *
 * The page keys the seat by `<package name>#<row id>`, taken from the bundle's
 * manifest and its patch, and the **Configure** control appears only because a
 * registration exists here. Nothing else in DSH renders a form for a plugin's
 * Config, however well declared the schema is.
 *
 * `PACKAGE_NAME` is written out because the browser half has no package.json to
 * read; `scripts/smoke-client.mjs` asserts it equals the manifest's name.
 */
const PACKAGE_NAME = 'dsh-openviking-enhance'
const CONFIG_ROW_KEY = `${PACKAGE_NAME}#openviking-enhance`

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
  const logger = (context as { logger?: { warn?: (m: string, e?: unknown) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(`[openviking-enhance] ${message}`, error)
  else console.error('[openviking-enhance]', error)
}

export function apply(context: ClientContext): void {
  const disposers: Array<() => void> = []

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

  try {
    const slots = context.slots

    // Left sidebar row. A list occupant draws only the glyph: the shell owns the
    // button, the title, the tooltip and the active highlight.
    disposers.push(
      slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: SIDEBAR_ORDER, label: () => 'OpenViking' },
          SidebarIcon,
        ),
      ),
    )

    // Centre column page for that row. Selecting a row whose `main` key is not
    // registered throws in the shell, so this pair must always ship together.
    disposers.push(
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, StudioPanel)),
    )

    // Session footer status pill. The inject factory receives the session id
    // because the slot is session-scoped. `order: 1` places it after the shell's
    // stats pills and the context meter; the row keeps its own centring.
    disposers.push(
      slots.inject('conversation.composer.dock', () =>
        slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'openviking-commit',
            order: 1,
            inject: (sessionId: string) => ({ sessionId }),
          },
          CommitStatusPill,
        ),
      ),
    )
  } catch (error) {
    report(context, error)
  }

  // The plugin's own settings, on its row of the Plugins page.
  try {
    disposers.push(
      context.slots.inject('plugins.row.config', () =>
        context.slots.register({ name: 'plugins.row.config', key: CONFIG_ROW_KEY }, ConfigPage),
      ),
    )
  } catch (error) {
    report(context, error)
  }

  // Right Sidebar: one tab type, contributed in the two stages the framework
  // asks for. Waiting on the REGISTRY (a service), not on the slot declaration, is
  // load-bearing: the right Sidebar's own seat declares
  // `sidebar.right.pane.tab` before it provides `sidebarRightTabs`, so a
  // registration triggered by the declaration would read the registry as absent
  // and — because a declaration never collapses — never retry.
  try {
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
        const disposeBody = context.slots.inject('sidebar.right.pane.tab', () =>
          context.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: RECALL_TAB_ID,
              inject: (sessionId: string) => ({ sessionId }),
            },
            RecallPanel,
          ),
        )
        return () => {
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
    disposers.push(() => seat.dispose())
  } catch (error) {
    report(context, error)
  }

  context.effect(
    () => () => {
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
