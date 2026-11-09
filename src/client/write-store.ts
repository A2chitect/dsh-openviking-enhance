/**
 * The prepare → confirm → execute → undo/audit interaction store.
 *
 * The dialog and the toast live in `shell.overlay` (frame-wide, above every
 * column) while the buttons that raise them live in panels and chat rows. A
 * module-level store is the seam DSH's shipped Workspace/Schedule features use
 * for the same reason: the outcome must outlive the panel that asked for it, and
 * a component cannot reach another slot's service.
 *
 * ## What is never stored here
 *
 * The confirmation token itself lives in `pending.prepare.token` and is handed
 * straight back to the host; it is never put in a URL, a title or the toast. The
 * prepare payload may carry the current edit body during the dialog's lifetime —
 * the dialog needs it to edit — and it is dropped as soon as the dialog settles.
 */
import { useSyncExternalStore } from 'react'
import type { WritePreparePayload, WriteUndoPlan } from '../shared/protocol.ts'

/** The outcome notice the toast renders (success with Undo, or a failure). */
export interface WriteNotice {
  /** Monotonic id, so React sees a new notice even with identical text. */
  seq: number
  tone: 'success' | 'warning' | 'error'
  /** Already-localized text ("Edited …"). */
  text: string
  /** Set when the action can be undone; the toast renders the Undo action. */
  undoId: string | null
  auditId: string | null
}

export interface WriteStoreState {
  /** The confirmation currently shown, or null. */
  confirm: WritePreparePayload | null
  /** An undo plan awaiting the user's confirmation (extra changes). */
  plan: WriteUndoPlan | null
  notice: WriteNotice | null
  /** A host call is in flight; the switch guard and buttons read this. */
  busy: boolean
  /** Bumped after every settled write, so panels reload from the server. */
  lastWriteSeq: number
  lastWriteTarget: string | null
  lastWriteAction: string | null
}

let state: WriteStoreState = {
  confirm: null,
  plan: null,
  notice: null,
  busy: false,
  lastWriteSeq: 0,
  lastWriteTarget: null,
  lastWriteAction: null,
}
let seq = 0
const listeners = new Set<() => void>()

function emit(next: Partial<WriteStoreState>): void {
  state = { ...state, ...next }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A broken surface must not stop the dialog from rendering.
    }
  }
}

export function getWriteState(): WriteStoreState {
  return state
}

export function subscribeWrite(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Raise the confirmation dialog for one prepared action. */
export function openWriteConfirm(prepare: WritePreparePayload): void {
  emit({ confirm: prepare, plan: null })
}

/** Settle the pending confirmation (cancel, Escape, backdrop, or after execute). */
export function closeWriteConfirm(): void {
  emit({ confirm: null })
}

/** Raise the extra-changes undo plan dialog. */
export function openUndoPlan(plan: WriteUndoPlan): void {
  emit({ plan, confirm: null })
}

export function closeUndoPlan(): void {
  emit({ plan: null })
}

/** Show one outcome notice. */
export function showNotice(notice: Omit<WriteNotice, 'seq'>): void {
  seq += 1
  emit({ notice: { ...notice, seq } })
}

export function dismissNotice(): void {
  emit({ notice: null })
}

/** Mark a host call in flight; the dialog disables its buttons while true. */
export function setWriteBusy(busy: boolean): void {
  emit({ busy })
}

/**
 * Signal that a write settled. Panels refresh their data from the server (never
 * from optimistic state) when this fires.
 */
export function notifyWriteSettled(action: string, target: string): void {
  emit({
    lastWriteSeq: state.lastWriteSeq + 1,
    lastWriteTarget: target,
    lastWriteAction: action,
  })
}

/** Whether a confirmation/undo is pending; a profile switch is refused then. */
export function hasPendingWrite(): boolean {
  return state.confirm !== null || state.plan !== null || state.busy
}

/**
 * Test-only seam: install a known dialog/notice so the server-rendered component
 * tests can render each surface without a host. Not used at runtime.
 */
export function __setWriteStateForTests(next: Partial<WriteStoreState>): void {
  emit(next)
}

/** React binding for the overlay and the panels. */
export function useWriteStore(): WriteStoreState {
  return useSyncExternalStore(subscribeWrite, getWriteState, getWriteState)
}
