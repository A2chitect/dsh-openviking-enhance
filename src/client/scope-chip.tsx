/**
 * F12 + v0.9: the persistent scope banner and the first-class scope menu.
 *
 * One component family, every placement:
 *   - the composer dock, beside the commit pill (`compact` chip);
 *   - the cockpit toolbar and the Overview header (chip + scope block);
 *   - the Activity/preview/recall/health tab headers (compact chip or banner);
 *   - every write/ops confirmation dialog repeats the full scope block itself
 *     (`showScopeBanner` never hides that).
 *
 * The chip renders the active profile label, account/user[/peer] and a warning
 * glyph when the endpoint is remote, the identity is key-bound, or the scope is
 * unhealthy. Clicking opens the v0.9 **scope menu** (a plugin overlay inside the
 * main panel, not a new shell seat):
 *
 *   - servers grouped by endpoint, each row showing label, identity, auth mode,
 *     health dot/version/latency, warnings and the active state;
 *   - an identity section with the account/user read selectors (disabled with the
 *     auth-mode reason when the server is key-bound / external-IdP / unreachable)
 *     and the peer READ selector;
 *   - Switch / Refresh health / Test connection actions; profile creation and
 *     editing stay in the existing Plugins-page editor ("Manage scopes").
 *
 * One active scope only, a second click on the active row is a no-op, and the
 * guard (pending confirmation/write/ops action) is enforced by the scope store.
 * The `showScopeSwitcher` switch hides only this menu; the banner keeps showing
 * the active scope.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ScopeIdentityRequest, ScopeListEntry, ScopesPayload } from '../shared/protocol.ts'
import { fetchScopes, testProfileEndpoint } from './host-api.ts'
import { t } from './locale.ts'
import {
  dismissSwitchNotice,
  ensureScope,
  ensureScopes,
  isScopeBannerEnabled,
  isScopeSwitcherEnabled,
  refreshScope,
  refreshScopes,
  scopeSwitchBlockedMessage,
  scopeSwitchBlockedReason,
  switchIdentity,
  switchProfile,
  useScope,
} from './scope-store.ts'
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

/** The endpoint's host[:port], for a compact banner. */
export function endpointHost(endpoint: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(endpoint.trim())
  return (match?.[1] ?? endpoint).toLowerCase()
}

/** A short fingerprint for display: `sha256:1a2b3c4d5e6f…`. */
export function fingerprintPrefix(fingerprint: string): string {
  const hex = fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint
  return `sha256:${hex.slice(0, 12)}…`
}

/** A warning glyph for a list of host warning codes (v0.9 rows). */
function warningGlyph(warnings: readonly string[]): string | null {
  const order = ['unreachable', 'remote-endpoint', 'cleartext-http', 'key-bound-identity']
  const known = order.filter((code) => warnings.includes(code))
  return known.length > 0 ? '⚠' : null
}

/** A warning title from the host's stable row codes. */
function warningText(code: string): string {
  const key = `scope.rowWarn.${code}`
  const text = t(key)
  return text === key ? code : text
}

/** One identity field, or the profile default when the override is unset. */
function fieldValue(override: string | null, fallback: string): string {
  return override ?? fallback
}

function IdentityEditor({ scopes, onClose }: { scopes: ScopesPayload; onClose: () => void }) {
  const scope = useScope()
  const active = scopes.active
  const allowed = scopes.overrides.allowed
  const [account, setAccount] = useState(fieldValue(scopes.overrides.account, active.account))
  const [user, setUser] = useState(fieldValue(scopes.overrides.user, active.user))
  const [peer, setPeer] = useState(scopes.overrides.peer ?? '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Review S12: no identity apply while another switch is in flight.
  const switching = scope.switching
  useEffect(() => {
    setAccount(fieldValue(scopes.overrides.account, active.account))
    setUser(fieldValue(scopes.overrides.user, active.user))
    setPeer(scopes.overrides.peer ?? '')
  }, [scopes, active.account, active.user])
  const identityEnabled = allowed.account && allowed.user
  const apply = useCallback(async () => {
    if (switching) {
      setNote(t('scope.switchInFlight'))
      return
    }
    setNote(null)
    const request: ScopeIdentityRequest = {}
    if (identityEnabled) {
      request.account = account.trim()
      request.user = user.trim()
    }
    if (allowed.peer) request.peer = peer.trim()
    if (Object.keys(request).length === 0) {
      setNote(t('scope.identity.menuDisabled'))
      return
    }
    setBusy(true)
    const result = await switchIdentity(request)
    setBusy(false)
    if (!result.ok) setNote(result.error)
    else onClose()
  }, [account, user, peer, identityEnabled, allowed.peer, onClose, switching])
  const clear = useCallback(async () => {
    if (switching) {
      setNote(t('scope.switchInFlight'))
      return
    }
    setNote(null)
    setBusy(true)
    const result = await switchIdentity({ clear: ['account', 'user', 'peer'] })
    setBusy(false)
    if (!result.ok) setNote(result.error)
    else onClose()
  }, [onClose, switching])
  const disabledReason = allowed.reason === null ? null : t(`scope.identity.reason.${allowed.reason}`)
  return (
    <div className="ove-scope-identity" role="group" aria-label={t('scope.identity.title')}>
      <span className="ove-scope-section-title">{t('scope.identity.title')}</span>
      <label className={`ove-scope-field${identityEnabled ? '' : ' ove-scope-field-disabled'}`}>
        <span>{t('scope.account')}</span>
        <input
          value={account}
          disabled={!identityEnabled || busy}
          onChange={(event) => setAccount(event.target.value)}
          aria-label={t('scope.account')}
        />
      </label>
      <label className={`ove-scope-field${identityEnabled ? '' : ' ove-scope-field-disabled'}`}>
        <span>{t('scope.user')}</span>
        <input
          value={user}
          disabled={!identityEnabled || busy}
          onChange={(event) => setUser(event.target.value)}
          aria-label={t('scope.user')}
        />
      </label>
      <label className={`ove-scope-field${allowed.peer ? '' : ' ove-scope-field-disabled'}`}>
        <span>{t('scope.peer')}</span>
        <input
          value={peer}
          disabled={!allowed.peer || busy}
          onChange={(event) => setPeer(event.target.value)}
          placeholder={t('scope.peerReadOnly')}
          aria-label={t('scope.peer')}
        />
      </label>
      {disabledReason !== null && <p className="ove-scope-hint">{disabledReason}</p>}
      <p className="ove-scope-hint">{t('scope.identity.peerHint')}</p>
      <div className="ove-scope-actions">
        <button type="button" className="ove-preview-button ove-scope-primary" disabled={busy || switching} onClick={() => void apply()}>
          {busy ? t('scope.identity.applying') : t('scope.identity.apply')}
        </button>
        <button type="button" className="ove-preview-button" disabled={busy || switching} onClick={() => void clear()}>
          {t('scope.identity.clear')}
        </button>
      </div>
      {note !== null && <p className="ove-scope-warn">{note}</p>}
      {scope.switchError !== null && <p className="ove-scope-warn">{scope.switchError}</p>}
    </div>
  )
}

function ScopeRow({ row, onSwitch, busy }: { row: ScopeListEntry; onSwitch: (row: ScopeListEntry) => void; busy: boolean }) {
  const glyph = warningGlyph(row.warnings)
  const health = row.health
  // v0.9: per-scope capability matrix summary ("snapshot ✓ · compile —").
  // Only the active scope is probed live; an inactive row that has never been
  // activated shows "?" (= probe on switch) instead of a guessed answer.
  const capabilitySummary = ['snapshot', 'compile', 'rules']
    .map((name) => {
      const capability = row.capabilities[name]
      if (capability === undefined) return `${name} ?`
      return `${name} ${capability.available ? '✓' : '—'}`
    })
    .join(' · ')
  return (
    <button
      type="button"
      className={`ove-scope-profile${row.isActive ? ' ove-scope-profile-active' : ''}`}
      disabled={row.isActive || busy}
      title={row.isActive ? t('scope.currentProfile') : t('scope.switchHint', { label: row.label })}
      onClick={() => onSwitch(row)}
    >
      <span className={`ove-scope-dot ${health.ok ? 'ove-scope-dot-ok' : 'ove-scope-dot-bad'}`} aria-hidden="true" />
      <span className="ove-scope-row-main">
        <span className="ove-scope-row-label">
          {row.label}
          {row.isActive && <span className="ove-scope-active-pill">{t('scope.active')}</span>}
          {row.overrides && <span className="ove-scope-override-pill">{t('scope.overridePill')}</span>}
        </span>
        <span className="ove-scope-row-meta">
          {row.account}/{row.user}
          {row.peer === null ? '' : ` · ${row.peer}`}
          {` · ${row.authMode ?? t('scope.unknown')}`}
          {health.version === null ? '' : ` · v${health.version}`}
          {health.latencyMs === null ? '' : ` · ${health.latencyMs}ms`}
        </span>
        <span className="ove-scope-row-caps">{capabilitySummary}</span>
      </span>
      <span className="ove-scope-row-side">
        {row.authMode === 'api_key' && <span className="ove-scope-key-pill">{t('scope.keyBoundPill')}</span>}
        {row.hasApiKey && row.authMode !== 'api_key' && (
          <span className="ove-scope-hint" title={t('scope.hasKeyNotBound')}>
            🔑
          </span>
        )}
        {glyph !== null && (
          <span
            className="ove-scope-warn-glyph"
            title={row.warnings.map((code) => warningText(code)).join(' · ')}
            aria-label={row.warnings.map((code) => warningText(code)).join(' · ')}
          >
            {glyph}
          </span>
        )}
      </span>
    </button>
  )
}

export interface ScopeMenuProps {
  onClose: () => void
}

/**
 * v0.9: the scope menu — servers grouped by endpoint, identity section, actions.
 *
 * It is the one switcher surface; the cockpit toolbar chip and the Overview
 * header both open it, and the `showScopeSwitcher` switch hides it without hiding
 * the scope banner.
 */
export function ScopeMenu({ onClose }: ScopeMenuProps) {
  const state = useScope()
  const [busy, setBusy] = useState(false)
  const [testNote, setTestNote] = useState<string | null>(null)
  // Review (smaller items): the blocked reason is recomputed on render, and the
  // cooldown clears itself with a short timer instead of needing a new event.
  const [, setTick] = useState(0)
  const scopes = state.scopes
  const blocked = scopeSwitchBlockedReason()
  useEffect(() => {
    void ensureScopes()
  }, [])
  useEffect(() => {
    if (blocked !== 'scope.switchCooldown') return
    const timer = setTimeout(() => setTick((value) => value + 1), 1_100)
    return () => clearTimeout(timer)
  }, [blocked])
  const activeScope = state.scope
  // Review S12: no switch control may act while any switch is in flight.
  const profileAllowsSwitch = isScopeSwitcherEnabled() && !state.switching
  const switchRow = useCallback(
    async (row: ScopeListEntry) => {
      if (row.isActive || busy) return
      setBusy(true)
      const result = await switchProfile(row.id)
      setBusy(false)
      if (result.ok) onClose()
    },
    [busy, onClose],
  )
  const refreshHealth = useCallback(() => {
    void refreshScopes()
  }, [])
  const testConnection = useCallback(async () => {
    const endpoint = activeScope?.identity.endpoint ?? ''
    if (endpoint.length === 0) return
    setTestNote(t('scope.test.running'))
    const answer = await testProfileEndpoint(endpoint)
    if (!answer.ok) {
      setTestNote(answer.error.message)
      return
    }
    setTestNote(
      answer.reachable
        ? t('scope.test.reachable', { version: answer.version ?? t('scope.unknown') })
        : t('scope.test.unreachable', { error: answer.error ?? t('scope.unknown') }),
    )
  }, [activeScope])

  // Group rows by endpoint (one server group per distinct endpoint).
  const groups: Array<{ endpoint: string; rows: ScopeListEntry[] }> = []
  for (const row of scopes?.scopes ?? []) {
    const group = groups.find((candidate) => candidate.endpoint === row.endpoint)
    if (group === undefined) groups.push({ endpoint: row.endpoint, rows: [row] })
    else group.rows.push(row)
  }
  const official = scopes?.officialPlugin ?? null
  const notices = scopes?.warnings ?? []
  return (
    <div className="ove-scope-menu" role="dialog" aria-label={t('scope.menuTitle')}>
      <div className="ove-scope-detail-head">
        <span className="ove-scope-detail-title">{t('scope.menuTitle')}</span>
        <span className="ove-spacer" />
        <button type="button" className="ove-preview-button" onClick={refreshHealth} title={t('scope.menu.refreshHealth')}>
          {t('scope.menu.refreshHealth')}
        </button>
        <button type="button" className="ove-scope-close" onClick={onClose} aria-label={t('scope.close')}>
          ×
        </button>
      </div>
      {activeScope !== null && (
        <div className="ove-scope-active-block">
          <span className="ove-scope-label">{activeScope.identity.profileLabel ?? t('scope.legacyMode')}</span>
          <span className="ove-scope-identity">
            {activeScope.identity.account}/{activeScope.identity.user}
            {activeScope.identity.peer === null ? '' : ` · ${activeScope.identity.peer}`}
          </span>
          <span className="ove-empty">{activeScope.identity.endpoint}</span>
          <span className="ove-empty">{activeScope.identity.authMode ?? t('scope.unknown')}</span>
          <span className="ove-empty">{fingerprintPrefix(activeScope.identity.fingerprint)}</span>
        </div>
      )}
      {notices.length > 0 && (
        <div className="ove-scope-notices" role="status">
          {notices.map((notice) => (
            <p key={notice.code} className="ove-scope-warn">{noticeKeyText(notice.code, notice.params)}</p>
          ))}
        </div>
      )}
      {official !== null && official.known && official.matches === false && (
        <p className="ove-scope-warn">
          {t('scope.officialMismatch', { host: official.endpointHost ?? t('scope.unknown') })}
        </p>
      )}
      {official !== null && !official.known && (
        <p className="ove-scope-hint">{t('scope.officialUnknown')}</p>
      )}
      {blocked !== null && <p className="ove-scope-warn">{scopeSwitchBlockedMessage(blocked)}</p>}
      {scopes === null ? (
        <p className="ove-scope-hint">{state.scopesError ?? t('scope.menu.loading')}</p>
      ) : (
        <>
          <div className="ove-scope-groups">
            {groups.map((group) => (
              <div className="ove-scope-group" key={group.endpoint}>
                <div className="ove-scope-group-title" title={group.endpoint}>
                  {endpointHost(group.endpoint)}
                  {isRemoteEndpoint(group.endpoint) && (
                    <span className="ove-scope-warn-glyph" title={t('scope.warnRemote')}>
                      ⚠
                    </span>
                  )}
                </div>
                {group.rows.map((row) => (
                  <ScopeRow key={row.id} row={row} busy={busy || !profileAllowsSwitch} onSwitch={(target) => void switchRow(target)} />
                ))}
              </div>
            ))}
          </div>
          <IdentityEditor scopes={scopes} onClose={onClose} />
        </>
      )}
      <div className="ove-scope-actions">
        <button type="button" className="ove-preview-button" onClick={() => void testConnection()}>
          {t('scope.menu.testConnection')}
        </button>
        <span className="ove-scope-hint">{t('scope.menu.manageHint')}</span>
      </div>
      {testNote !== null && <p className="ove-scope-hint">{testNote}</p>}
      {hasPendingWrite() && <p className="ove-scope-warn">{t('scope.switchBlocked')}</p>}
    </div>
  )
}

/** Render one host warning code (stable code → localized copy). */
function noticeKeyText(code: string, params: Record<string, string | number> | undefined): string {
  const key = `scope.notice.${code}`
  const text = t(key, params)
  return text === key ? code : text
}

/** The compact scope banner: one line, every surface, always the active scope. */
export function ScopeBanner(props: { className?: string; showMenu?: boolean }) {
  const state = useScope()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void ensureScope()
    // Review S9: do not probe every configured server just because a banner
    // mounted; the list is only fetched for the switcher.
    if (isScopeSwitcherEnabled()) void ensureScopes()
  }, [])
  if (!isScopeBannerEnabled()) return null
  const className = `ove-scope ove-scope-banner${props.className === undefined ? '' : ` ${props.className}`}`
  // Review B1: never keep rendering the previous label after a failed refresh —
  // the host may already be on another scope.
  if (state.status === 'error') {
    return (
      <div className={className} role="status">
        <span className="ove-scope-warn-glyph" aria-hidden="true">⚠</span>
        <span className="ove-scope-warn">{t('scope.unavailableReload')}</span>
        <button
          type="button"
          className="ove-scope-menu-button"
          onClick={() => {
            void refreshScope()
            if (isScopeSwitcherEnabled()) void refreshScopes()
          }}
        >
          {t('scope.reload')}
        </button>
      </div>
    )
  }
  if (state.scope === null) {
    return (
      <div className={`${className} ove-scope-loading`} role="status">
        {t('scope.loading')}
      </div>
    )
  }
  const scope = state.scope
  const label = scope.identity.profileLabel ?? t('scope.legacyMode')
  // Review S11: surface the /scope warnings themselves, not only endpoint/auth
  // glyphs — a missing profile, ignored overrides or a corrupt state file must be
  // visible on the banner without opening the menu.
  const scopeNotices = scopeWarnings(scope)
  const warning = scopeWarning(scope) ?? scopeNotices[0] ?? null
  return (
    <div className={className} role="status">
      <span className="ove-scope-dot" aria-hidden="true" />
      <span className="ove-scope-label">{label}</span>
      <span className="ove-empty">{endpointHost(scope.identity.endpoint)}</span>
      <span className="ove-scope-identity">
        {scope.identity.account}/{scope.identity.user}
        {scope.identity.peer === null ? '' : ` · ${scope.identity.peer}`}
      </span>
      {warning !== null && (
        <span
          className="ove-scope-warn-glyph"
          title={[scopeWarning(scope), ...scopeNotices].filter((text): text is string => text !== null).join(' · ')}
          aria-label={warning}
        >
          ⚠
        </span>
      )}
      {scopeNotices.length > 0 && <span className="ove-scope-warn ove-scope-banner-warn">{scopeNotices[0]}</span>}
      {props.showMenu !== false && isScopeSwitcherEnabled() && (
        <button type="button" className="ove-scope-menu-button" onClick={() => setOpen((current) => !current)}>
          {t('scope.menu.open')}
        </button>
      )}
      {open && <ScopeMenu onClose={() => setOpen(false)} />}
    </div>
  )
}

/** The transient "switched from X to Y" notice the cockpit shows. */
export function ScopeSwitchNoticeLine() {
  const state = useScope()
  if (state.switchNotice === null) return null
  return (
    <div className="ove-scope-switch-notice" role="status">
      <span>
        {t('scope.switchedFromTo', {
          from: state.switchNotice.fromLabel,
          to: state.switchNotice.toLabel,
        })}
      </span>
      <button type="button" className="ove-scope-menu-button" onClick={() => dismissSwitchNotice()}>
        {t('scope.dismiss')}
      </button>
    </div>
  )
}

/** The warning a scope needs, or null (v0.5 chip behaviour, v0.9 vocabulary). */
export function scopeWarning(scope: {
  identity: { endpoint: string; authMode: string | null }
  writes: { reason: string | null }
}): string | null {
  if (isRemoteEndpoint(scope.identity.endpoint)) return t('scope.warnRemote')
  if (scope.identity.authMode === 'api_key') return t('scope.warnKeyBound')
  if (scope.writes.reason === 'profile-unhealthy') return t('scope.warnUnhealthy')
  return null
}

/** Localized text for the `/scope` payload's own warning codes (review S11). */
export function scopeWarnings(scope: {
  warnings?: Array<{ code: string; params?: Record<string, string | number> }>
}): string[] {
  const notices = scope.warnings ?? []
  return notices.map((notice) => noticeKeyText(notice.code, notice.params)).filter((text) => text.length > 0)
}

function LegacyScopeDetail({
  onClose,
}: {
  onClose: () => void
}) {
  const state = useScope()
  const scope = state.scope
  if (scope === null) return null
  const rows: Array<[string, string]> = [
    [t('scope.endpoint'), scope.identity.endpoint],
    [t('scope.authMode'), scope.identity.authMode ?? t('scope.unknown')],
    [t('scope.role'), scope.role ?? t('scope.unknown')],
    [t('scope.account'), scope.identity.account],
    [t('scope.user'), scope.identity.user],
    [t('scope.peer'), scope.identity.peer ?? t('scope.none')],
    [t('scope.version'), scope.version ?? t('scope.unknown')],
    [t('scope.fingerprint'), fingerprintPrefix(scope.identity.fingerprint)],
    [
      t('scope.writes'),
      scope.writes.enabled
        ? t('scope.writesOn')
        : t('scope.writesOff', { reason: scope.writes.reason ?? 'writes-disabled' }),
    ],
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
  useEffect(() => {
    void ensureScope()
  }, [])
  // The banner switch hides the chip on every surface; write confirmations
  // repeat the scope themselves, so the switch can never hide the identity a
  // destructive action runs under.
  if (!isScopeBannerEnabled()) return null
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
    <div className={`ove-scope${compact ? ' ove-scope-compact' : ''}`}>
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
      {open &&
        (isScopeSwitcherEnabled() ? (
          <ScopeMenu onClose={() => setOpen(false)} />
        ) : (
          <LegacyScopeDetail onClose={() => setOpen(false)} />
        ))}
    </div>
  )
}
