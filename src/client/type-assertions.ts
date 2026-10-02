/**
 * Compile-time assertions for the client slot contract.
 *
 * This file is never imported and never bundled. It exists so `tsc --noEmit`
 * fails when a guarantee documented in `slot-service.ts` stops holding — after a
 * DSH upgrade, or after someone loosens the types to make an error go away.
 *
 * Each `@ts-expect-error` is the assertion: if the line above it *stops* being an
 * error, TypeScript reports the directive as unused (TS2578) and the build fails.
 * Keep every case on a single line so the directive covers the whole statement.
 */
import type { SlotService } from './slot-service.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'
import { StudioPanel } from './studio-panel.tsx'
import { CommitStatusPill } from './commit-status.tsx'
import { RecallPanel } from './recall-panel.tsx'
import { ConfigPage } from './config-page.tsx'

declare const slots: SlotService

// --- the shapes the plugin actually registers: these must type-check ---------

slots.register({ name: 'sidebar.panellist', id: 'openviking', order: 1000, label: () => 'OpenViking' }, OpenVikingIcon)
slots.register({ name: 'main', key: 'openviking' }, StudioPanel)
slots.register(
  { name: 'conversation.composer.dock', id: 'openviking-commit', order: 1, inject: (sessionId: string) => ({ sessionId }) },
  CommitStatusPill,
)
slots.register(
  { name: 'sidebar.right.pane.tab', key: 'dsh-openviking-enhance:recall', inject: (sessionId: string) => ({ sessionId }) },
  RecallPanel,
)
slots.register({ name: 'plugins.row.config', key: 'dsh-openviking-enhance#openviking-enhance' }, ConfigPage)

// --- and the mistakes each rule exists to catch ------------------------------

// @ts-expect-error the slot key must exist in SlotMap
slots.register({ name: 'sidebar.panellistt', id: 'x' }, OpenVikingIcon)
// @ts-expect-error a keyed slot is addressed by `key`, not `id`
slots.register({ name: 'main', id: 'x' }, StudioPanel)
// @ts-expect-error a list slot is addressed by `id`, not `key`
slots.register({ name: 'sidebar.panellist', key: 'x' }, OpenVikingIcon)
// @ts-expect-error a root slot must not declare an inject factory
slots.register({ name: 'main', key: 'x', inject: (sessionId: string) => ({ sessionId }) }, StudioPanel)
// @ts-expect-error a session slot must declare an inject factory
slots.register({ name: 'conversation.composer.dock', id: 'x' }, CommitStatusPill)
// @ts-expect-error the right-Sidebar tab body is a session slot too: no inject means no session
slots.register({ name: 'sidebar.right.pane.tab', key: 'x' }, RecallPanel)
// @ts-expect-error the config seat is keyed, and its root scope forbids an inject factory
slots.register({ name: 'plugins.row.config', key: 'x', inject: (sessionId: string) => ({ sessionId }) }, ConfigPage)
// @ts-expect-error the component must accept the props its slot hands it
slots.register({ name: 'sidebar.panellist', id: 'x' }, (props: { nope: number }) => null)
