/**
 * The native cockpit's state: the active view, the deep-link target, the
 * in-memory history (Back/Forward) and the two presentation switches.
 *
 * Same pattern as `preview-store.ts`/`scope-store.ts`: a module store read with
 * `useSyncExternalStore`. Deliberately **in-memory only** (Lead sign-off §3/§20):
 * the panel reopens on Overview after a reload, and no navigation state is
 * persisted in the plugin's local state file. DSH exposes no browser URL routing
 * for main-panel selection, so this store plus `ctx.layout.selectPanel` is what
 * "URL-ish/stateful where possible" means here.
 *
 * The layout bridge is capability-detected **structurally** (`typeof
 * layout?.selectPanel === 'function'`), so an older DSH generation without the
 * action simply reports "no panel action" and deep links fall back to the
 * existing right-Sidebar preview tab.
 */
import { useSyncExternalStore } from 'react'
import { NATIVE_HISTORY_MAX } from '../shared/limits.ts'
import type { NativeTarget, NativeViewId } from '../shared/protocol.ts'

/** The two presentation switches the panel honors live. */
export interface NativeSwitches {
  /** Native multi-view cockpit vs the exact v0.6 Studio page. */
  nativeViews: boolean
  /** The onboarding checklist card (Overview + Plugins Setup card). */
  onboarding: boolean
  /** v0.8: `enableOps` — render the Operate group's action buttons. Reads always render. */
  ops: boolean
}

export interface NativeState {
  /** The view currently shown. */
  view: NativeViewId
  /** The deep-link target that produced it (browse URI, session id, …). */
  target: NativeTarget
  /** Bounded navigation history, oldest→newest. */
  history: NativeTarget[]
  /** Index of the current entry in `history`. */
  index: number
  switches: NativeSwitches
}

/** The pre-settings-answer state, and the fallback when no answer arrives. */
export const DEFAULT_NATIVE_SWITCHES: NativeSwitches = { nativeViews: true, onboarding: true, ops: false }

const OVERVIEW_TARGET: NativeTarget = { view: 'overview' }

let state: NativeState = {
  view: 'overview',
  target: OVERVIEW_TARGET,
  history: [OVERVIEW_TARGET],
  index: 0,
  switches: DEFAULT_NATIVE_SWITCHES,
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** The current snapshot (referentially stable until a change). */
export function getNativeState(): NativeState {
  return state
}

/** Subscribe to cockpit changes; returns the unsubscribe function. */
export function subscribeNative(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The hook every cockpit component reads the store through. */
export function useNative(): NativeState {
  return useSyncExternalStore(subscribeNative, getNativeState, getNativeState)
}

/** One deep-link target as a compact identity, for history dedupe. */
function targetKey(target: NativeTarget): string {
  return JSON.stringify(target)
}

function normalizedTarget(target: NativeTarget): NativeTarget {
  return { ...target, view: target.view }
}

/**
 * Apply the two presentation switches.
 *
 * The panel body re-renders in place; no history is touched (a user toggling
 * "use Studio" must still find their last view when they toggle back).
 */
export function setNativeSwitches(switches: Partial<NativeSwitches>): void {
  const next: NativeSwitches = {
    nativeViews: switches.nativeViews ?? state.switches.nativeViews,
    onboarding: switches.onboarding ?? state.switches.onboarding,
    ops: switches.ops ?? state.switches.ops,
  }
  if (
    next.nativeViews === state.switches.nativeViews &&
    next.onboarding === state.switches.onboarding &&
    next.ops === state.switches.ops
  ) {
    return
  }
  state = { ...state, switches: next }
  emit()
}

/**
 * Navigate the cockpit to a target.
 *
 * Pushes onto the history (truncating any forward entries), dedupes the exact
 * same target, and drops the oldest entries beyond `NATIVE_HISTORY_MAX`.
 */
export function navigate(target: NativeTarget): void {
  const normalized = normalizedTarget(target)
  if (targetKey(normalized) === targetKey(state.target)) {
    state = { ...state, view: normalized.view, target: normalized }
    emit()
    return
  }
  const kept = state.history.slice(0, state.index + 1)
  kept.push(normalized)
  const overflow = Math.max(0, kept.length - NATIVE_HISTORY_MAX)
  const history = overflow > 0 ? kept.slice(overflow) : kept
  state = { ...state, view: normalized.view, target: normalized, history, index: history.length - 1 }
  emit()
}

/** Go back one history entry; false when already at the oldest. */
export function back(): boolean {
  if (state.index <= 0) return false
  const index = state.index - 1
  const target = state.history[index] as NativeTarget
  state = { ...state, index, target, view: target.view }
  emit()
  return true
}

/** Go forward one history entry; false when already at the newest. */
export function forward(): boolean {
  if (state.index >= state.history.length - 1) return false
  const index = state.index + 1
  const target = state.history[index] as NativeTarget
  state = { ...state, index, target, view: target.view }
  emit()
  return true
}

/** Reset to Overview (plugin unload/reload, or a user "home" action). */
export function resetNative(): void {
  state = {
    view: 'overview',
    target: OVERVIEW_TARGET,
    history: [OVERVIEW_TARGET],
    index: 0,
    switches: state.switches,
  }
  emit()
}

/** Test seam: install a known state without exercising the setters. */
export function __setNativeStateForTests(next: Partial<NativeState>): void {
  state = { ...state, ...next }
  emit()
}

/* ---- deep links and the layout bridge ----------------------------------- */

/**
 * The slice of the shell's layout service used here, declared structurally so
 * this module needs no `dsh-client-ui-layout` import (the design's requirement:
 * capability detection, not a new dependency).
 */
export interface LayoutLike {
  /** Select a registered main key; throws when the key is absent in the shell. */
  selectPanel?: (panelId: string | null) => void
  /** Live panel facts on generations that expose them. */
  panelInfo?: { activePanelId?: string | null }
}

/** The panel id both the sidebar row and this plugin's main key use. */
export const NATIVE_PANEL_ID = 'openviking'

let layout: LayoutLike | null = null

/** Install the layout service (`ctx.get('layout')`), or clear it on unload. */
export function attachNativeLayout(next: LayoutLike | null): void {
  layout = next
}

/** Whether this shell generation can switch the main column programmatically. */
export function canSelectPanel(): boolean {
  return typeof layout?.selectPanel === 'function'
}

/** Whether the native cockpit is already the active main panel. */
export function isNativePanelActive(): boolean {
  if (layout === null) return false
  try {
    return layout.panelInfo?.activePanelId === NATIVE_PANEL_ID
  } catch {
    return false
  }
}

/**
 * Open the native cockpit on a target, without ever stealing the main column
 * from an incidental click.
 *
 * Returns `'panel'` when the shell selected the panel, `'preview'` when this DSH
 * generation has no layout action (the caller then falls back to the existing
 * right-Sidebar preview tab). An explicit action calls this; incidental
 * `viking://` links keep calling `openPreview` and never reach here.
 */
export function openNative(target: NativeTarget): 'panel' | 'preview' {
  navigate(target)
  if (!canSelectPanel()) return 'preview'
  try {
    layout?.selectPanel?.(NATIVE_PANEL_ID)
    return 'panel'
  } catch {
    // A shell whose panel key is not registered must not take the click down.
    return 'preview'
  }
}

/** Test seam for the layout bridge. */
export function __setNativeLayoutForTests(next: LayoutLike | null): void {
  attachNativeLayout(next)
}
