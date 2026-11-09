/**
 * F12: the persistent scope chip.
 *
 * One component, three placements (design §"Scope banner"):
 *   - the composer dock, beside the commit pill (`compact`);
 *   - the plugin's main panel and the Activity/preview tab headers;
 *   - implicitly at the top of every write confirmation dialog, which repeats
 *     the full scope block regardless of this switch.
 *
 * It renders the active profile label, the account/user/peer scope and a warning
 * glyph when the endpoint is not loopback or the identity is key-bound
 * (`auth_mode=api_key`) — the two cases where "which memory space is this?"
 * is easiest to get wrong. Clicking expands the detail: endpoint, auth mode,
 * role, server version, fingerprint prefix, the write gates and the profile
 * switch list.
 *
 * The component never fetches on its own schedule beyond `ensureScope()`: the
 * store is shared, so the chip appearing in three places is still one request.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProfileSummary, ScopePayload } from '../shared/protocol.ts'
import { fetchProfiles } from './host-api.ts'
import { t } from './locale.ts'
import { ensureScope, isScopeBannerEnabled, switchProfile, useScope } from './scope-store.ts'
import { hasPendingWrite } from './write-store.ts'

/** Whether an endpoint points at another machine (the loud-warning case). */
export function isRemoteEndpoint(endpoint: string): boolean {
  // Parsed with a regex rather than `new URL`: the component also renders in the
  // server-render test sandbox, where no bare `URL` global is guaranteed — and
  // its absence must not read as "remote".
  const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/?#:]+)/i.exec(endpoint.trim())
  const host = (match?.[1] ?? '').toLowerCase()
  if (host.length === 0) return true
  return !(
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.startsWith('127.')
  )
}

/** The warning a scope needs, or null. */
export function scopeWarning(scope: ScopePayload): string | null {
  if (isRemoteEndpoint(scope.identity.endpoint)) return t('scope.warnRemote')
  if (scope.identity.authMode === 'api_key') return t('scope.warnKeyBound')
  if (scope.writes.reason === 'profile-unhealthy') return t('scope.warnUnhealthy')
  return null
}

/** A short fingerprint for display: `sha256:1a2b3c4d5e6f…`. */
export function fingerprintPrefix(fingerprint: string): string {
  const hex = fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint
  return `sha256:${hex.slice(0, 12)}…`
}

function ScopeDetail({ scope, onClose }: { scope: ScopePayload; onClose: () => void }) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const pending = hasPendingWrite()

  useEffect(() => {
    let cancelled = false
    void fetchProfiles().then((answer) => {
      if (!cancelled && answer.ok) setProfiles(answer.profiles.profiles)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = useCallback(async (id: string) => {
    setNote(null)
    const result = await switchProfile(id)
    if (!result.ok) setNote(result.error)
  }, [])

  const rows: Array<[string, string]> = [
    [t('scope.endpoint'), scope.identity.endpoint],
    [t('scope.authMode'), scope.identity.authMode ?? t('scope.unknown')],
    [t('scope.role'), scope.role ?? t('scope.unknown')],
    [t('scope.account'), scope.identity.account],
    [t('scope.user'), scope.identity.user],
    [t('scope.peer'), scope.identity.peer ?? t('scope.none')],
    [t('scope.version'), scope.version ?? t('scope.unknown')],
    [t('scope.fingerprint'), fingerprintPrefix(scope.identity.fingerprint)],
    [t('scope.writes'), scope.writes.enabled ? t('scope.writesOn') : t('scope.writesOff', { reason: scope.writes.reason ?? 'writes-disabled' })],
  ]

  return (
    <div className="ove-scope-detail" role="dialog" aria-label={t('scope.detailTitle')}>
      <div className="ove-scope-detail-head">
        <span className="ove-scope-detail-title">{t('scope.detailTitle')}</span>
        <button type="button" className="ove-scope-close" onClick={onClose} aria-label={t('scope.close')}>
          ×
        </button>
      </div>
      <dl className="ove-scope-rows">
        {rows.map(([label, value]) => (
          <div className="ove-scope-row" key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="ove-scope-profiles">
        <span className="ove-scope-profiles-title">{t('scope.switchTitle')}</span>
        {profiles === null ? (
          <span className="ove-scope-hint">{t('scope.switching')}</span>
        ) : profiles.length === 0 ? (
          <span className="ove-scope-hint">{t('scope.noProfiles')}</span>
        ) : (
          profiles.map((profile) => {
            const active = profile.id === scope.identity.profileId
            return (
              <button
                key={profile.id}
                type="button"
                className={`ove-scope-profile${active ? ' ove-scope-profile-active' : ''}`}
                disabled={active || pending}
                title={active ? t('scope.currentProfile') : t('scope.switchHint', { label: profile.label })}
                onClick={() => void choose(profile.id)}
              >
                <span>{profile.label}</span>
                <span className="ove-scope-profile-meta">{profile.endpoint}</span>
              </button>
            )
          })
        )}
        {pending && <span className="ove-scope-warn">{t('scope.switchBlocked')}</span>}
        {note !== null && <span className="ove-scope-warn">{note}</span>}
      </div>
      <p className="ove-scope-hint">{t('scope.managerHint')}</p>
    </div>
  )
}

export interface ScopeChipProps {
  /** The dock variant: just the chip, no surrounding box. */
  compact?: boolean
  /** The dock slot is session-scoped and hands this over; the chip is global. */
  sessionId?: string
}

export function ScopeChip({ compact = false }: ScopeChipProps) {
  const state = useScope()
  const [open, setOpen] = useState(false)
  // The banner switch hides the chip on every surface; write confirmations
  // repeat the scope themselves, so the switch can never hide the identity a
  // destructive action runs under.
  if (!isScopeBannerEnabled()) return null

  useEffect(() => {
    void ensureScope()
  }, [])

  if (state.status === 'idle' || state.status === 'loading') {
    return compact ? null : <span className="ove-scope ove-scope-loading">{t('scope.loading')}</span>
  }
  if (state.status === 'error' || state.scope === null) {
    return (
      <span className={`ove-scope ove-scope-error${compact ? ' ove-scope-compact' : ''}`} title={state.error ?? ''}>
        {t('scope.unavailable')}
      </span>
    )
  }
  const scope = state.scope
  const warning = scopeWarning(scope)
  const label = scope.identity.profileLabel ?? t('scope.legacyMode')
  const peer = scope.identity.peer === null ? '' : ` · ${scope.identity.peer}`

  return (
    <span className={`ove-scope${compact ? ' ove-scope-compact' : ''}`}>
      <button
        type="button"
        className="ove-scope-chip"
        aria-expanded={open}
        title={t('scope.chipHint')}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ove-scope-dot" aria-hidden="true" />
        <span className="ove-scope-label">{label}</span>
        <span className="ove-scope-identity">
          {scope.identity.account}/{scope.identity.user}
          {peer}
        </span>
        {warning !== null && (
          <span className="ove-scope-warn-glyph" title={warning} aria-label={warning}>
            ⚠
          </span>
        )}
      </button>
      {open && <ScopeDetail scope={scope} onClose={() => setOpen(false)} />}
    </span>
  )
}
