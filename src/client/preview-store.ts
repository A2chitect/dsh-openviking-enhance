/**
 * F5: the selection store behind every `viking://` deep link.
 *
 * The plugin renders URIs in five unrelated surfaces (recall tab, per-turn
 * explanation, commit diff, health/doctor, and the preview itself). Any of them
 * must be able to say "show this entry in the preview tab", and the preview body
 * lives in a right-Sidebar slot with no access to the slot registry or the
 * sidebar navigation service. A module-level store is the seam:
 *
 *   - `setPreviewTarget(uri, label?)` records what the preview should show and
 *     notifies its subscribers;
 *   - `openPreview(uri, label?)` records the target AND asks the registered
 *     opener to reveal the tab, handing it the URI;
 *   - `index.tsx` registers the opener once it holds `ctx.sidebarRight`, which is
 *     the same service the recall explanation uses to open its tab.
 *
 * ## Params first, store as the cross-generation fallback
 *
 * The 0.2.2 harness carries a target in `openTab(kind, {params:{uri}})`
 * (`SidebarRightTabParamsMap`), and re-opening navigates the existing page. The
 * store is kept for two reasons the framework does not cover: components cannot
 * reach `ctx.sidebarRight` at all (so they need this module anyway), and the
 * manifest still supports 0.2.0/0.2.1 generations where the params API may be
 * absent — there the store target is the only channel. The panel prefers the
 * live navigation params and falls back to the store.
 */
import { useSyncExternalStore } from 'react'

/** The entry the preview should show. */
export interface PreviewTarget {
  /** A `viking://…` URI, exactly as the surface rendered it. */
  uri: string
  /** Optional human label; currently unused by the panel, kept for callers. */
  label: string | null
}

let target: PreviewTarget | null = null
let opener: ((uri: string) => void) | null = null
const listeners = new Set<() => void>()

/** The current target, or null. Stable identity until it changes. */
export function getPreviewTarget(): PreviewTarget | null {
  return target
}

/** Subscribe to target changes; returns the unsubscribe function. */
export function subscribePreviewTarget(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener that throws must not stop the other surfaces from updating.
    }
  }
}

/**
 * Record the entry the preview should show.
 *
 * An empty or whitespace-only URI clears the selection; the panel then renders
 * its empty state. The same URI again is a no-op for the store (no re-render),
 * but `openPreview` still asks the sidebar to reveal the tab.
 */
export function setPreviewTarget(uri: string | null, label?: string | null): void {
  const trimmed = (uri ?? '').trim()
  const next: PreviewTarget | null = trimmed.length === 0 ? null : { uri: trimmed, label: label ?? null }
  if (next === null && target === null) return
  if (next !== null && target !== null && next.uri === target.uri && next.label === target.label) return
  target = next
  emit()
}

/**
 * Register the way to reveal the preview tab. Called once by `apply()` with the
 * injected `sidebarRight`; a composition without that service keeps its target
 * (a future mount can show it) and simply cannot pre-focus the page.
 *
 * Returns a disposer, and only clears the opener if it is still the same one —
 * an unload must not remove a newer registration.
 */
export function setPreviewOpener(next: ((uri: string) => void) | null): () => void {
  opener = next
  return () => {
    if (opener === next) opener = null
  }
}

/** Show one URI: record it, then reveal the tab when the sidebar can. */
export function openPreview(uri: string, label?: string | null): void {
  const trimmed = (uri ?? '').trim()
  setPreviewTarget(trimmed, label)
  if (trimmed.length === 0) return
  try {
    opener?.(trimmed)
  } catch {
    // The target is still recorded; the user can open the tab from the guide.
  }
}

/** Test/HMR seam: forget the selection and the opener. */
export function resetPreviewStore(): void {
  target = null
  opener = null
  emit()
}

/** The preview target as a React value (server render sees the module state). */
export function usePreviewTarget(): PreviewTarget | null {
  return useSyncExternalStore(subscribePreviewTarget, getPreviewTarget, getPreviewTarget)
}
