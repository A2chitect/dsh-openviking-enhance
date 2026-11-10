/**
 * v0.9: the active scope store — one module-level store every surface reads.
 *
 * v0.5 shipped a small store for the scope chip: it fetched `/scope`, rendered
 * the identity and guarded a profile switch behind a pending confirmation. v0.9
 * turns it into the client half of the scope layer:
 *
 *  - the active scope (`ScopePayload`) **and** the scope list/rules
 *    (`ScopesPayload`), so the switcher and every banner share one answer;
 *  - a monotonic **generation** incremented on every switch: the request layer
 *    captures it and drops any response that resolves across the switch, so a
 *    slow previous-scope answer can never be rendered under the new labels;
 *  - **switch guards**: refused while a curation confirmation/token/write is
 *    pending, while a v0.8 ops dialog/token is pending, or during the double-click
 *    cooldown; the reason is localized;
 *  - the **switch flow**: bump the generation → abort in-flight reads → switch
 *    (profile via the v0.5 ConfigForm; identity via `POST /scope/identity`) →
 *    refresh both payloads → publish a "switched from X to Y" notice and notify
 *    the cockpit (which resets to Overview and closes plugin right-sidebar pages);
 *  - `showScopeBanner`/`showScopeSwitcher` switches: the banner is governed by the
 *    v0.5 switch, the menu by the new v0.9 switch; dialog/evidence scope blocks
 *    are never hidden by either.
 *
 * It also registers the request-layer scope transport, which is what attaches
 * `x-dsh-openviking-scope` to every host call and detects `scope-changed`.
 */
import { useSyncExternalStore } from 'react'
import type {
  ScopeErrorCode,
  ScopeIdentityRequest,
  ScopeKeyInfo,
  ScopePayload,
  ScopesPayload,
} from '../shared/protocol.ts'
import {
  abortScopedReads,
  fetchScope,
  fetchScopes,
  registerScopeTransport,
  switchScopeIdentity,
} from './host-api.ts'
import { SCOPE_SWITCH_COOLDOWN_MS } from '../shared/limits.ts'
import { hasPendingOps } from './ops-store.ts'
import { hasPendingWrite } from './write-store.ts'
import { t } from './locale.ts'

/** One published switch, for the transient "switched from X to Y" notice. */
export interface ScopeSwitchNotice {
  /** Monotonic id so React re-renders an identical-label switch. */
  seq: number
  fromLabel: string
  toLabel: string
  at: number
}

export interface ScopeState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  scope: ScopePayload | null
  error: string | null
  /** Set when a switch was refused or failed, for the chip's inline notice. */
  switchError: string | null
  /** v0.9: the full scope list + identity rules (fetched with the switcher). */
  scopes: ScopesPayload | null
  scopesStatus: 'idle' | 'loading' | 'ready' | 'error'
  scopesError: string | null
  /** The last successful switch, cleared after the notice is shown/dismissed. */
  switchNotice: ScopeSwitchNotice | null
  /**
   * v0.9 review S12: a switch is in flight. Every switch control is disabled
   * while true (profile pick and identity apply cannot interleave).
   */
  switching: boolean
}

let state: ScopeState = {
  status: 'idle',
  scope: null,
  error: null,
  switchError: null,
  scopes: null,
  scopesStatus: 'idle',
  scopesError: null,
  switchNotice: null,
  switching: false,
}
let inflight: Promise<void> | null = null
let scopesInflight: Promise<void> | null = null
const listeners = new Set<() => void>()

/** v0.9: monotonic switch generation (the stale-response drop). */
let generation = 0
/** Whether the `showScopeSwitcher` switch is on (default true). */
let switcherEnabled = true
/** Whether the `showScopeBanner` switch is on. */
let bannerEnabled = true
/** The last switch time, for the documented cooldown. */
let lastSwitchAt = 0
/** A registered way to write the `activeProfile` Config field. */
let profileSwitcher: ((id: string) => Promise<boolean> | boolean) | null = null
/** Surfaces that must react to a switch (cockpit reset, sidebar close). */
const switchHandlers = new Set<(notice: ScopeSwitchNotice | null) => void>()
let noticeSeq = 0
/** The generation at which a host-initiated scope-changed refresh last ran. */
let scopeChangedRefreshAt = 0

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

/** Apply the v0.9 `showScopeSwitcher` switch (only the menu is hidden). */
export function setScopeSwitcherEnabled(enabled: boolean): void {
  if (switcherEnabled === enabled) return
  switcherEnabled = enabled
  emit({})
}

export function isScopeSwitcherEnabled(): boolean {
  return switcherEnabled
}

/** The live scope key (the request header value), or null before `/scope`. */
export function scopeKey(): string | null {
  return state.scope?.identity.fingerprint ?? null
}

/** The current generation; the request layer captures it per call. */
export function scopeGeneration(): number {
  return generation
}

/** The active scope identity, or null. */
export function activeScope(): ScopeKeyInfo | null {
  const scope = state.scope
  if (scope === null) return null
  const listed = state.scopes?.active
  return {
    scopeKey: scope.identity.fingerprint,
    profileId: scope.identity.profileId,
    label: scope.identity.profileLabel,
    endpoint: scope.identity.endpoint,
    authMode: scope.identity.authMode,
    account: scope.identity.account,
    user: scope.identity.user,
    peer: scope.identity.peer,
    overrides: listed?.scopeKey === scope.identity.fingerprint ? listed.overrides : false,
  }
}

/** Read `/scope` once (when idle) or force a fresh read. Never throws. */
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

/** Read the scope list (the switcher's data source). */
export function ensureScopes(fresh = false): Promise<void> {
  if (!fresh && state.scopesStatus === 'ready') return scopesInflight ?? Promise.resolve()
  if (scopesInflight !== null) return scopesInflight
  emit({ scopesStatus: 'loading', scopesError: null })
  scopesInflight = fetchScopes(fresh)
    .then((answer) => {
      if (answer.ok) emit({ scopesStatus: 'ready', scopes: answer.scopes, scopesError: null })
      else emit({ scopesStatus: 'error', scopesError: answer.error.message })
    })
    .catch((error: unknown) => emit({ scopesStatus: 'error', scopesError: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      scopesInflight = null
    })
  return scopesInflight
}

/** Force a fresh scope list (menu open, switch settled, Refresh health). */
export function refreshScopes(): Promise<void> {
  return ensureScopes(true)
}

/** `index.tsx` registers the ConfigForm-backed profile switch here. */
export function registerProfileSwitcher(switcher: ((id: string) => Promise<boolean> | boolean) | null): void {
  profileSwitcher = switcher
}

/** `index.tsx` registers the cockpit reset / sidebar close reaction here. */
export function registerScopeSwitchHandler(
  handler: (notice: ScopeSwitchNotice | null) => void,
): () => void {
  switchHandlers.add(handler)
  return () => {
    switchHandlers.delete(handler)
  }
}

function notifySwitchHandlers(notice: ScopeSwitchNotice | null): void {
  for (const handler of [...switchHandlers]) {
    try {
      handler(notice)
    } catch {
      // A broken surface must not stop the switch.
    }
  }
}

function currentLabel(): string {
  const scope = state.scope
  if (scope === null) return t('scope.unknown')
  return scope.identity.profileLabel ?? t('scope.legacyMode')
}

/**
 * A host-initiated scope change (`scope-changed` / a response labelled with
 * another scope): bump the generation, abort reads, refresh both payloads and
 * reset the cockpit. Never rendered as data.
 */
function handleHostScopeChanged(): void {
  const at = Date.now()
  if (at - scopeChangedRefreshAt < 300) return
  scopeChangedRefreshAt = at
  generation += 1
  abortScopedReads()
  notifySwitchHandlers(null)
  void refreshScope()
  void refreshScopes()
}

/**
 * What blocks a switch right now, or null when it is allowed.
 *
 * The v0.8 ops confirmation is included: v0.8 shipped its dialogs without a
 * client store, so `ops-store.ts` tracks whether one is open or executing.
 */
export function scopeSwitchBlockedReason(): string | null {
  if (state.switching) return 'scope.switchInFlight'
  if (hasPendingWrite()) return 'scope.switchBlocked'
  if (hasPendingOps()) return 'scope.switchBlockedOps'
  // Review S10: the wire constant, not a duplicated literal.
  if (lastSwitchAt > 0 && Date.now() - lastSwitchAt < SCOPE_SWITCH_COOLDOWN_MS) return 'scope.switchCooldown'
  return null
}

/** A stable localized message for a switch refusal code. */
export function scopeSwitchBlockedMessage(reason: string): string {
  if (reason === 'scope.switchBlockedOps') return t('scope.switchBlockedOps')
  if (reason === 'scope.switchCooldown') return t('scope.switchCooldown')
  if (reason === 'scope.switchInFlight') return t('scope.switchInFlight')
  return t('scope.switchBlocked')
}

/** Map host scope error codes to localized copy. */
export function scopeErrorText(code: string): string {
  const key = `scope.err.${code}`
  const text = t(key)
  return text === key ? t('scope.switchRefused') : text
}

export interface ScopeSwitchOptions {
  /** Capture the pre-switch label for the notice (defaults to the active one). */
  fromLabel?: string
}

/**
 * The one switch flow: guard → generation bump → abort reads → host switch →
 * refresh → notice + cockpit reset. Both the profile switch and the identity
 * override mutation go through it, so the two can never drift.
 */
async function runSwitch(
  perform: () => Promise<{ ok: true; adopt?: Partial<ScopeState> } | { ok: false; error: string }>,
  options: ScopeSwitchOptions = {},
): Promise<{ ok: boolean; error: string | null }> {
  const blocked = scopeSwitchBlockedReason()
  if (blocked !== null) return { ok: false, error: scopeSwitchBlockedMessage(blocked) }
  const fromLabel = options.fromLabel ?? currentLabel()
  emit({ switching: true, switchError: null })
  generation += 1
  abortScopedReads()
  try {
    const result = await perform()
    if (!result.ok) {
      emit({ switchError: result.error })
      // The host may still have moved (e.g. a profile switch that committed):
      // discovery reads are tolerant and tell us the truth.
      void refreshScope()
      return { ok: false, error: result.error }
    }
    lastSwitchAt = Date.now()
    if (result.adopt !== undefined) {
      // Review B1: the scope-changing mutation replied with the authoritative
      // new scope payload — adopt it instead of re-sending the stale key.
      emit({ status: 'ready', error: null, ...result.adopt })
    } else {
      await refreshScope()
      await refreshScopes()
    }
    const notice: ScopeSwitchNotice = { seq: (noticeSeq += 1), fromLabel, toLabel: currentLabel(), at: lastSwitchAt }
    emit({ switchNotice: notice, switchError: null })
    notifySwitchHandlers(notice)
    return { ok: true, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ switchError: message })
    return { ok: false, error: message }
  } finally {
    emit({ switching: false })
  }
}

/** Switch the active profile (v0.5 ConfigForm mechanism, v0.9 guarded flow). */
export async function switchProfile(id: string): Promise<{ ok: boolean; error: string | null }> {
  if (profileSwitcher === null) return { ok: false, error: t('scope.switchUnavailable') }
  return runSwitch(async () => {
    try {
      const accepted = await profileSwitcher?.(id)
      return accepted === true ? { ok: true as const } : { ok: false as const, error: t('scope.switchRefused') }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Apply one in-server identity override (the host route validates the rules). */
export async function switchIdentity(
  request: ScopeIdentityRequest,
): Promise<{ ok: boolean; error: string | null }> {
  return runSwitch(async () => {
    const answer = await switchScopeIdentity(request)
    if (!answer.ok) return { ok: false as const, error: scopeErrorText(answer.error.code) }
    // Review B1: adopt the replied scope/scopes; do not re-read `/scope` with the
    // key the switch just invalidated.
    return { ok: true as const, adopt: { scope: answer.scope, scopes: answer.scopes } }
  })
}

/** Dismiss the transient switch notice. */
export function dismissSwitchNotice(): void {
  if (state.switchNotice === null) return
  emit({ switchNotice: null })
}

/** Whether a scope switch will abort this many in-flight reads (diagnostics). */
export function scopesStale(): boolean {
  return state.scopesStatus === 'error'
}

/**
 * Test-only seam: install a known scope so the server-rendered component tests
 * can render the ready/disabled/error states without a host. Not used at runtime.
 */
export function __setScopeStateForTests(next: Partial<ScopeState>): void {
  emit(next)
}

/** Test-only seam: reset the module to its initial state between tests. */
export function __resetScopeForTests(): void {
  state = {
    status: 'idle',
    scope: null,
    error: null,
    switchError: null,
    scopes: null,
    scopesStatus: 'idle',
    scopesError: null,
    switchNotice: null,
    switching: false,
  }
  generation = 0
  lastSwitchAt = 0
  emit({})
}

/** The React binding: a component re-renders when the scope changes. */
export function useScope(): ScopeState {
  return useSyncExternalStore(subscribeScope, getScopeState, getScopeState)
}

/* ---- the request-layer registration (module init) ----------------------- */

registerScopeTransport({
  key: () => scopeKey(),
  generation: () => generation,
  onScopeChanged: () => handleHostScopeChanged(),
})

/** Keep the `ScopeErrorCode` type import meaningful for callers that re-export it. */
export type { ScopeErrorCode }
