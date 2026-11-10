/**
 * v0.9 §3.3: session → scope mismatch warning for the right-sidebar surfaces.
 *
 * The host keeps a best-effort local map of which scope saw a DSH session last
 * (`session-scopes.json`, 0600). This module is the client half:
 *
 *  - `useSessionScope(sessionId)` reads `/session-scope` once per session and
 *    exposes `mismatch` / `pipelineMismatch`;
 *  - `SessionScopeBanner` renders the persistent warning ("this session was last
 *    seen under <label>; you are viewing <label>") with a "switch back" action,
 *    or the advisory official-plugin pipeline warning;
 *  - when there is no record the banner renders nothing and the surfaces show the
 *    generic active-scope banner — a missing record is "unknown", never "matches";
 *  - `sessionScopeMismatch(sessionId)` is the synchronous guard write/pill
 *    actions use: a mismatched session's recall explanation and write actions are
 *    disabled until the user switches back (no cross-scope writes).
 */
import { useSyncExternalStore, useState } from 'react'
import type { ScopeIdentityRequest, ScopeIdentityRules, SessionScopePayload } from '../shared/protocol.ts'
import { fetchSessionScope } from './host-api.ts'
import { t } from './locale.ts'
import { switchIdentity, switchProfile } from './scope-store.ts'

export interface SessionScopeState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  payload: SessionScopePayload | null
  error: string | null
}

const states = new Map<string, SessionScopeState>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Map<string, Promise<void>>()
const EMPTY: SessionScopeState = { status: 'idle', payload: null, error: null }

function emit(sessionId: string, next: SessionScopeState): void {
  states.set(sessionId, next)
  for (const listener of listeners.get(sessionId) ?? []) {
    try {
      listener()
    } catch {
      // One broken surface must not stop the others from repainting.
    }
  }
}

/** Fetch the session-scope facts once (or force a refresh after a switch). */
export function ensureSessionScope(sessionId: string, fresh = false): Promise<void> {
  if (sessionId.length === 0) return Promise.resolve()
  const current = states.get(sessionId) ?? EMPTY
  if (!fresh && current.status === 'ready') return Promise.resolve()
  const running = inflight.get(sessionId)
  if (running !== undefined && !fresh) return running
  emit(sessionId, { ...current, status: 'loading', error: null })
  const request = fetchSessionScope(sessionId)
    .then((answer) => {
      if (answer.ok) emit(sessionId, { status: 'ready', payload: answer.sessionScope, error: null })
      else emit(sessionId, { status: 'error', payload: null, error: answer.error.message })
    })
    .catch((error: unknown) =>
      emit(sessionId, {
        status: 'error',
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      inflight.delete(sessionId)
    })
  inflight.set(sessionId, request)
  return request
}

/** The observed state for one session (a hook). */
export function useSessionScope(sessionId: string): SessionScopeState {
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(sessionId)
      if (set === undefined) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
    () => states.get(sessionId) ?? EMPTY,
    () => states.get(sessionId) ?? EMPTY,
  )
}

/**
 * Synchronous mismatch guard for write/pill/recall actions.
 *
 * Unknown (never fetched / no record) is **not** a mismatch: the generic banner
 * plus the advisory official-plugin warning cover that case, and blocking on
 * "unknown" would break a fresh install.
 */
export function sessionScopeMismatch(sessionId: string): boolean {
  const state = states.get(sessionId)
  return state?.payload?.mismatch === true
}

/**
 * v0.9 review B3: drop every cached session-scope answer on a scope switch.
 *
 * The mismatch is scope-dependent state: keeping a previous answer would let the
 * commit pill keep `mismatch=false` after a switch. Surfaces re-fetch when their
 * scope dependency changes; this reset also wakes them immediately.
 */
export function resetSessionScopes(): void {
  // Re-emit an idle snapshot to every listener (surfaces refetch when their
  // scope dependency changes), then forget the sessions entirely.
  for (const sessionId of [...states.keys()]) emit(sessionId, { ...EMPTY, status: 'idle' })
  states.clear()
}

/** Test seam: install a known session-scope answer (component tests, no host). */
export function __setSessionScopeForTests(sessionId: string, next: Partial<SessionScopeState>): void {
  emit(sessionId, { ...(states.get(sessionId) ?? EMPTY), ...next })
}

export interface SwitchBackPlan {
  request: ScopeIdentityRequest
  /** Fields that differ but this auth mode forbids changing (review N2). */
  blocked: string[]
}

/**
 * v0.9 round 2 (N2): build a "switch back" request this auth mode can accept.
 *
 * Only fields that actually differ are named, and a field the auth-mode rules
 * forbid is reported instead of sent — under `api_key` the account/user are
 * key-bound, so a peer-only mismatch restores with `{peer}` alone instead of a
 * request the host would refuse.
 */
export function planSwitchBack(
  record: NonNullable<SessionScopePayload['record']>,
  active: SessionScopePayload['active'],
  allowed: ScopeIdentityRules,
): SwitchBackPlan {
  const request: ScopeIdentityRequest = {}
  const blocked: string[] = []
  const accountDiffers = record.account !== active.account
  const userDiffers = record.user !== active.user
  if (accountDiffers || userDiffers) {
    if (allowed.account && allowed.user) {
      request.account = record.account
      request.user = record.user
    } else {
      blocked.push('account')
    }
  }
  if (record.peer !== active.peer) {
    if (allowed.peer) request.peer = record.peer ?? ''
    else blocked.push('peer')
  }
  return { request, blocked }
}

export interface SessionScopeBannerProps {
  sessionId: string
  className?: string
}

/**
 * The mismatch banner. Renders nothing for a matching/unknown session except the
 * advisory pipeline warning when the official plugin's facts disagree.
 */
export function SessionScopeBanner({ sessionId, className }: SessionScopeBannerProps) {
  const state = useSessionScope(sessionId)
  const payload = state.payload
  const classes = className === undefined ? 'ove-scope-session-banner' : `ove-scope-session-banner ${className}`
  if (payload === null) return null
  const record = payload.record
  // Review S4/N2: show the recorded identity tuple so a manual fix is possible,
  // and restore it in one click when the profile already matches. The request
  // names only the fields that differ and the rules allow (N2), and a refusal is
  // shown in the banner instead of being swallowed.
  const recordedIdentity =
    record === null ? null : `${record.account}/${record.user}${record.peer === null ? '' : ` · ${record.peer}`}`
  const sameProfile = record !== null && record.profileId === payload.active.profileId
  const allowed = payload.overrides?.allowed ?? { account: true, user: true, peer: true, reason: null, authMode: null }
  const plan = record !== null && sameProfile ? planSwitchBack(record, payload.active, allowed) : null
  const [note, setNote] = useState<string | null>(null)
  const switchBack = async (): Promise<void> => {
    if (record === null) return
    setNote(null)
    if (!sameProfile) {
      if (record.profileId === null) return
      const result = await switchProfile(record.profileId)
      if (!result.ok) setNote(result.error ?? t('scope.switchRefused'))
      return
    }
    if (plan === null) return
    const result = await switchIdentity(plan.request)
    if (!result.ok) setNote(result.error ?? t('scope.session.restoreFailed'))
  }
  if (payload.mismatch) {
    return (
      <div className={`${classes} ove-scope-session-mismatch`} role="alert">
        <span>
          {t('scope.session.mismatch', {
            label: record?.label ?? t('scope.unknown'),
            active: payload.active.label ?? t('scope.legacyMode'),
          })}
        </span>
        {recordedIdentity !== null && (
          <span className="ove-scope-hint" title={t('scope.session.recordedIdentityHint')}>
            {t('scope.session.recordedIdentity', { identity: recordedIdentity })}
          </span>
        )}
        {record !== null && record.profileId !== null && (
          <button
            type="button"
            className="ove-preview-button"
            disabled={sameProfile && (plan === null || plan.blocked.length > 0)}
            onClick={() => void switchBack()}
          >
            {t('scope.session.switchBack')}
          </button>
        )}
        {sameProfile && plan !== null && plan.blocked.length > 0 && (
          <span className="ove-scope-hint">
            {t('scope.session.restoreBlocked', { fields: plan.blocked.join(', ') })}
          </span>
        )}
        {record !== null && record.profileId !== null && !sameProfile && (
          <span className="ove-scope-hint">{t('scope.session.switchBackHint')}</span>
        )}
        {note !== null && <span className="ove-scope-warn">{note}</span>}
        <span className="ove-scope-hint">{t('scope.session.actionsDisabled')}</span>
      </div>
    )
  }
  if (payload.pipelineMismatch) {
    return (
      <div className={`${classes} ove-scope-pipeline-mismatch`} role="status">
        <span>
          {t('scope.session.pipelineMismatch', {
            host: payload.officialPlugin?.endpointHost ?? t('scope.unknown'),
          })}
        </span>
      </div>
    )
  }
  return null
}
