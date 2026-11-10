/**
 * Open one of the plugin's right-Sidebar page kinds from anywhere in the plugin.
 *
 * The native cockpit lives in the main column, but some of its actions belong in
 * the right Sidebar (the Explore tab's Rules/Experience sections, the Doctor's
 * Memory health page). Those tabs are opened through the shell's
 * `sidebarRight.openTab(kind)`, which is only reachable from `apply()` in
 * `index.tsx`. This module is the bridge: one setter called by `apply()`, one
 * opener used by components. It follows the same module-store pattern as
 * `preview-store.ts` and `scope-store.ts` and no-ops when the service is absent.
 */

/** The kinds this bridge may open (must match `index.tsx`'s tab kinds). */
export type RightTabKind = 'openviking-recall' | 'openviking-health' | 'openviking-preview' | 'openviking-explore' | 'openviking-activity'

type TabOpener = (kind: RightTabKind, params?: unknown) => void

let opener: TabOpener | null = null

/** Install (or clear) the opener; called from the `sidebarRight` injection. */
export function setRightTabOpener(next: TabOpener | null): void {
  opener = next
}

/** Whether the shell's right Sidebar can be asked to open a page. */
export function canOpenRightTab(): boolean {
  return opener !== null
}

/** Open one of the plugin's pages; returns false when the shell has no sidebar. */
export function openRightTab(kind: RightTabKind, params?: unknown): boolean {
  if (opener === null) return false
  try {
    opener(kind, params)
    return true
  } catch {
    return false
  }
}
