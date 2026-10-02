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
 */
import type { ClientContext } from './slot-service.ts'
import { installStyles } from './styles.ts'
import { StudioIcon, StudioPanel } from './studio-panel.tsx'
import { CommitStatusPill, DockSpacer } from './commit-status.tsx'

/** Client services this half waits for before `apply` runs. */
export const inject = ['slots']

/** Sidebar row id; the same value keys the `main` panel entry. */
const PANEL_ID = 'openviking'

function report(context: ClientContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const logger = (context as { logger?: { warn?: (m: string, e?: unknown) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(`[openviking-enhance] ${message}`, error)
  else console.error('[openviking-enhance]', error)
}

export function apply(context: ClientContext): void {
  const disposers: Array<() => void> = []

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
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'OpenViking' },
          StudioIcon as never,
        ),
      ),
    )

    // Centre column page for that row. Selecting a row whose `main` key is not
    // registered throws in the shell, so this pair must always ship together.
    disposers.push(
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, StudioPanel as never)),
    )

    // Session footer status pill. The inject factory receives the session id
    // because the slot is session-scoped. `order: 1` puts it after the shell's
    // stats pills and the context meter; its `margin-left:auto` pins it to the
    // right edge, and the spacer below keeps the default pills centred while it
    // does so (see styles.ts for why the two go together).
    disposers.push(
      slots.inject('conversation.composer.dock', () => {
        const spacer = slots.register(
          { name: 'conversation.composer.dock', id: 'openviking-commit-spacer', order: -1 },
          DockSpacer as never,
        )
        const pill = slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'openviking-commit',
            order: 1,
            inject: (sessionId: string) => ({ sessionId }),
          },
          CommitStatusPill as never,
        )
        return () => {
          pill()
          spacer()
        }
      }),
    )
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
