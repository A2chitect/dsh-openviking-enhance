/**
 * The active scope, shared by every write-capable surface.
 *
 * One module-level store, one fetch: the composer scope chip, the panel headers,
 * every confirmation dialog and the force-commit dialog all describe the same
 * identity, so they read the same answer instead of each polling `/scope`.
 *
 * ## The profile switch and its guard
 *
 * A switch is a Config write (`configForms.get(ns).set('activeProfile', id)`) —
 * the host hears `loader/volatile-update`, re-resolves the connection and
 * invalidates its caches. This store owns the client half:
 *
 *  - `registerProfileSwitcher` is wired by `index.tsx` (which holds
 *    `ctx.configForms`) and calls `form.set('activeProfile', id)`;
 *  - a switch is refused while a confirmation is pending or a write is in flight
 *    (`write-store.ts` exposes the guard);
 *  - after a switch the scope is re-read with `fresh=1`, so the banner and every
 *    gate show the new identity instead of the old one.
 *
 * The scope response contains no secret: `identityFingerprint` is a hash and the
 * profile list is already redacted.
 */
import { useSyncExternalStore } from 'react'
import type { ScopePayload } from '../shared/protocol.ts'
import { fetchScope } from './host-api.ts'
import { hasPendingWrite } from './write-store.ts'
import { t } from './locale.ts'

export interface ScopeState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  scope: ScopePayload | null
  error: string | null
  /** Set when a switch was refused or failed, for the chip's inline notice. */
  switchError: string | null
}

let state: ScopeState = { status: 'idle', scope: null, error: null, switchError: null }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

/** A registered way to write the `activeProfile` Config field. */
let profileSwitcher: ((id: string) => Promise<boolean> | boolean) | null = null

/**
 * Whether the `showScopeBanner` switch is on. The store owns it so a chip inside
 * a panel header (which cannot read the settings form) hides with the switch,
 * while confirmation dialogs keep the full scope block regardless.
 */
let bannerEnabled = true

function emit(next: Partial<ScopeState>): void {
  state = { ...state, ...next }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One broken surface must not stop the others from repainting.
    }
  }
}

export function getScopeState(): ScopeState {
  return state
}

export function subscribeScope(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Apply the `showScopeBanner` switch (called by `index.tsx` on every save). */
export function setScopeBannerEnabled(enabled: boolean): void {
  if (bannerEnabled === enabled) return
  bannerEnabled = enabled
  emit({})
}

export function isScopeBannerEnabled(): boolean {
  return bannerEnabled
}

/** Read once (when idle) or force a fresh read. Never throws. */
export function ensureScope(fresh = false): Promise<void> {
  if (!fresh && state.status !== 'idle') return inflight ?? Promise.resolve()
  if (inflight !== null) return inflight
  emit({ status: 'loading', error: null })
  inflight = fetchScope(fresh)
    .then((answer) => {
      if (answer.ok) emit({ status: 'ready', scope: answer.scope, error: null })
      else emit({ status: 'error', error: answer.error.message })
    })
    .catch((error: unknown) => emit({ status: 'error', error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Force a re-read after something changed the identity or the gates. */
export function refreshScope(): Promise<void> {
  return ensureScope(true)
}

/** `index.tsx` registers the ConfigForm-backed switch here. */
export function registerProfileSwitcher(switcher: ((id: string) => Promise<boolean> | boolean) | null): void {
  profileSwitcher = switcher
}

/** Whether the request asked for a state that blocks a switch. */
export function scopeSwitchBlockedReason(): string | null {
  if (hasPendingWrite()) return 'confirmation-pending'
  return null
}

/**
 * Switch the active profile.
 *
 * The guard runs here as well as in the UI: a click that races a pending
 * confirmation is refused with the reason, not silently queued.
 */
export async function switchProfile(id: string): Promise<{ ok: boolean; error: string | null }> {
  const blocked = scopeSwitchBlockedReason()
  if (blocked !== null) return { ok: false, error: t('scope.switchBlocked') }
  if (profileSwitcher === null) return { ok: false, error: t('scope.switchUnavailable') }
  try {
    const accepted = await profileSwitcher(id)
    if (!accepted) return { ok: false, error: t('scope.switchRefused') }
    emit({ switchError: null })
    await refreshScope()
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Test-only seam: install a known scope so the server-rendered component tests
 * can render the ready/disabled/error states without a host. Not used at runtime.
 */
export function __setScopeStateForTests(next: Partial<ScopeState>): void {
  emit(next)
}

/** The React binding: a component re-renders when the scope changes. */
export function useScope(): ScopeState {
  return useSyncExternalStore(subscribeScope, getScopeState, getScopeState)
}
