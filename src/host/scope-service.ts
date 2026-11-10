/**
 * v0.9: the active-scope authority.
 *
 * One place answers "which server + identity is the cockpit pointed at, may that
 * identity be switched, and what did the last switch change". The host's
 * `index.ts` calls this module instead of walking `profiles.json`/Config itself;
 * the client renders what `/scope` and `/scopes` return.
 *
 * ## The model (Lead sign-off decision 1)
 *
 * A **scope** = one v0.5 server profile + an optional in-server identity
 * override (account/user read selectors; peer read selector). The scope key is
 * the existing v0.5 identity fingerprint: `sha256:` over
 * `{profileId, endpoint, probedAuthMode, account, user, peer}` — no secrets, safe
 * to show/audit. One scope is active at a time.
 *
 * Boot precedence exactly as signed off:
 *   Config `activeProfile` → `scope-state.json` → `profiles.json` header →
 *   legacy v0.4 resolution.
 *
 * Identity overrides live in `scope-state.json`, apply only while their profile
 * is active, and are reset by a profile switch.
 *
 * ## Identity switching rules (F12 completion, sign-off 2)
 *
 * | probed auth mode | account/user | peer read selector |
 * | `dev`            | allowed      | allowed            |
 * | `trusted`        | allowed, both non-empty | allowed |
 * | `api_key`        | disabled (key-bound) | allowed for reads |
 * | `oidc` / `ldap`  | disabled | disabled |
 * | unreachable / unknown | disabled | disabled |
 *
 * The plugin never sets `X-OpenViking-Role`; peer overrides are a READ lens only
 * (`OpenVikingApi` applies them to sessionless read methods), and session
 * capture/commit stay bound to the official plugin's actor peer.
 */
import type {
  PluginNotice,
  ScopeCapability,
  ScopeHealthInfo,
  ScopeIdentityRequest,
  ScopeIdentityRules,
  ScopeKeyInfo,
  ScopeListEntry,
  ScopeOverridesPayload,
} from '../shared/protocol.ts'
import { SCOPE_PROBE_TTL_MS } from '../shared/limits.ts'
import {
  identityFingerprint,
  resolveConnectionForProfile,
  type ConnectionOverrides,
  type OvConnection,
  type ResolvedIdentity,
} from './config.ts'
import { isLoopbackHostname } from './trust-fence.ts'
import { isValidPeerId, isValidScopeName, type Profile } from './profiles.ts'
import type { ProfileStore } from './profiles.ts'
import { emptyScopeState, type ScopeIdentityOverride, type ScopeStateStore } from './scope-state.ts'

/** Which persistence layer supplied the active profile. */
export type ScopeSource = 'config' | 'state' | 'profile-header' | 'legacy'

/** The effective identity override block for the active scope. */
export interface EffectiveOverrides {
  /** What the state file stores (may be partially ignored). */
  stored: ScopeIdentityOverride | null
  /** Effective override applied to the connection, or null for the default. */
  account: string | null
  user: string | null
  peer: string | null
  /** True when at least one override differs from the profile's defaults. */
  active: boolean
  /** Reason codes for stored overrides that were ignored (see `identityRules`). */
  ignored: string[]
}

/** The resolved active scope: v0.5 identity + the v0.9 override/persistence facts. */
export interface ResolvedScope extends ResolvedIdentity {
  /** The v0.5 profile object (null in legacy resolution). */
  profile: Profile | null
  /** Which layer supplied the active profile id. */
  source: ScopeSource
  /** The effective override block. */
  overrides: EffectiveOverrides
  /** Non-fatal resolution warnings (missing profile, ignored overrides, …). */
  warnings: PluginNotice[]
  /** Stable secret-free scope key. */
  scopeKey: string
}

/** The reason a switch is refused (`/scopes`/`/scope/identity` render it). */
export interface ScopeSwitchGuard {
  blocked: boolean
  /** Stable code: `confirmation-pending`, `mutation-in-flight`, `cooldown`. */
  reason: string | null
  /** How many confirmation tokens are pending or executing. */
  pending: number
}

export interface ScopeServiceOptions {
  profiles: ProfileStore
  state: ScopeStateStore
  /** The live runtime Config `activeProfile` value ('' = unset). */
  configActiveProfile: () => string
  /** The v0.4 plugin-config overrides; used only by legacy resolution. */
  configOverrides: () => ConnectionOverrides
  /** The probed auth mode of the active scope (null = not probed yet). */
  probedAuthMode: () => string | null
  /** Whether the last capability snapshot says the active server is healthy. */
  healthy: () => boolean
  /** Cheap `/health` probe for one profile (the scope menu's rows). */
  probe: (profile: Profile) => Promise<ScopeHealthInfo>
  /** The active scope's capability matrix (only the active scope is probed live). */
  activeCapabilities: () => Record<string, ScopeCapability>
  /** The shared mutation-gate/confirmation state (switch guard). */
  guard: () => { pending: number; busy: boolean; lastSwitchAt: number | null }
  /** Test seam. */
  now?: () => number
}

/**
 * Derive the identity-switch rules from the probed auth mode and health.
 *
 * Reasons are stable codes the client maps to localized copy; the menu shows
 * them on the disabled fields instead of sending a header the server ignores.
 */
export function identityRules(authMode: string | null, healthy: boolean): ScopeIdentityRules {
  if (!healthy) {
    return { account: false, user: false, peer: false, reason: 'profile-unhealthy', authMode }
  }
  if (authMode === 'dev' || authMode === 'trusted') {
    return { account: true, user: true, peer: true, reason: null, authMode }
  }
  if (authMode === 'api_key') {
    return { account: false, user: false, peer: true, reason: 'identity-key-bound', authMode }
  }
  if (authMode === 'oidc' || authMode === 'ldap') {
    return { account: false, user: false, peer: false, reason: 'identity-external-idp', authMode }
  }
  return { account: false, user: false, peer: false, reason: 'identity-unknown', authMode }
}

/**
 * Whether the effective override must be a complete account+user pair.
 *
 * `trusted` upstreams expect both headers; sending only one selects a mixed
 * identity, so a partial stored override is ignored rather than half-applied.
 */
function pairRequired(authMode: string | null): boolean {
  return authMode === 'trusted'
}

/**
 * The v0.9 scope service.
 *
 * Pure with respect to time and the filesystem except `profiles`/`state`: it
 * never holds a network client, so a unit test can drive every rule with fake
 * stores.
 */
export class ScopeService {
  private readonly options: ScopeServiceOptions
  private readonly now: () => number
  /** Last `/health` answer per profile id for the menu, bounded by the profile cap. */
  private readonly healthCache = new Map<string, { at: number; health: ScopeHealthInfo }>()
  /** Last-known capability matrix per profile id (only the active scope is probed). */
  private readonly capabilityCache = new Map<string, Record<string, ScopeCapability>>()
  /** Last switch time, for the double-click cooldown. */
  private lastSwitchAt: number | null = null

  constructor(options: ScopeServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** The profile id chosen by the boot precedence, and the layer that chose it. */
  activeProfileSelection(): { id: string; source: ScopeSource; warning: PluginNotice | null } {
    const configId = this.options.configActiveProfile().trim()
    if (configId.length > 0) return { id: configId, source: 'config', warning: null }
    const stateRead = this.options.state.read()
    const stateId = stateRead.file.activeProfileId
    if (stateId.length > 0) {
      const exists = this.options.profiles.read().file.profiles.some((profile) => profile.id === stateId)
      if (exists) return { id: stateId, source: 'state', warning: null }
      return {
        id: '',
        source: 'legacy',
        warning: { code: 'scopeStateProfileMissing', params: { id: stateId } },
      }
    }
    const headerId = this.options.profiles.read().file.activeProfileId
    if (headerId.length > 0) {
      const exists = this.options.profiles.read().file.profiles.some((profile) => profile.id === headerId)
      if (exists) return { id: headerId, source: 'profile-header', warning: null }
      return { id: '', source: 'legacy', warning: { code: 'profileHeaderMissing', params: { id: headerId } } }
    }
    return { id: '', source: 'legacy', warning: null }
  }

  /** The profile selected by the boot precedence, or null for legacy resolution. */
  activeProfile(): { profile: Profile | null; id: string; source: ScopeSource; warnings: PluginNotice[] } {
    const selection = this.activeProfileSelection()
    const profiles = this.options.profiles.read().file.profiles
    const profile = selection.id.length > 0 ? profiles.find((candidate) => candidate.id === selection.id) ?? null : null
    const warnings: PluginNotice[] = []
    if (selection.warning !== null) warnings.push(selection.warning)
    if (selection.id.length > 0 && profile === null) {
      warnings.push({ code: 'profileNotFound', params: { id: selection.id } })
    }
    return { profile, id: profile?.id ?? selection.id, source: selection.source, warnings }
  }

  /**
   * Resolve the active scope (connection + effective overrides + key).
   *
   * Applying the result to the live `connection` object is the caller's job
   * (index.ts owns the mutable reference every v0.4 service holds).
   */
  resolveActive(): ResolvedScope {
    const selected = this.activeProfile()
    const resolved = resolveConnectionForProfile(
      this.options.profiles.read().file.profiles,
      selected.id,
      this.options.configOverrides(),
    )
    const probedAuthMode = this.options.probedAuthMode()
    const healthy = this.options.healthy()
    // Before the first probe the configured hint is the only auth-mode fact we
    // have; it is an intentional operator setting (dev/trusted/api_key), so the
    // stored overrides are validated against it. A later probe that disagrees
    // re-validates them, and the API omits identity headers under api_key anyway.
    const effectiveAuthMode = probedAuthMode ?? resolved.authModeHint
    const rules = identityRules(effectiveAuthMode, healthy)
    const stateRead = this.options.state.read()
    const stored = stateRead.file.identity
    const warnings = [...selected.warnings]
    const ignored: string[] = []
    let account: string | null = null
    let user: string | null = null
    let peer: string | null = null
    // Overrides belong to the profile the state file was written for: a Config
    // override that points elsewhere must not inherit them.
    const stateMatchesProfile =
      selected.profile !== null && stateRead.file.activeProfileId === selected.profile.id && stored !== null
    if (stored !== null && !stateMatchesProfile) {
      ignored.push('override-profile-mismatch')
    } else if (stored !== null) {
      const wantsAccount = stored.account !== null && stored.account !== selected.profile?.account
      const wantsUser = stored.user !== null && stored.user !== selected.profile?.user
      const wantsIdentity = wantsAccount || wantsUser
      if (wantsIdentity) {
        if (rules.account && rules.user) {
          const complete = stored.account !== null && stored.user !== null
          if (pairRequired(effectiveAuthMode) && !complete) {
            ignored.push('identity-pair-required')
          } else {
            account = stored.account
            user = stored.user
          }
        } else if (rules.reason !== null) {
          ignored.push(rules.reason)
        }
      }
      const wantsPeer = stored.peer !== null && stored.peer !== selected.profile?.peerId
      if (wantsPeer) {
        if (rules.peer) peer = stored.peer
        else if (rules.reason !== null) ignored.push(rules.reason)
      }
    }
    if (ignored.includes('override-profile-mismatch')) {
      warnings.push({ code: 'overridesIgnored', params: { reason: 'override-profile-mismatch' } })
    } else if (ignored.length > 0) {
      warnings.push({ code: 'overridesIgnored', params: { reason: ignored[0] as string } })
    }
    const base = resolved.connection
    const connection: OvConnection = {
      endpoint: base.endpoint,
      apiKey: base.apiKey,
      account: account ?? base.account,
      user: user ?? base.user,
      authMode: probedAuthMode ?? resolved.authModeHint,
      // The peer read selector: applied by OpenVikingApi to sessionless reads
      // only (never to mutations; those carry the session's actor peer).
      peerId: peer ?? resolved.peerId,
    }
    const effective: EffectiveOverrides = {
      stored: stateMatchesProfile ? stored : null,
      account,
      user,
      peer,
      active: account !== null || user !== null || peer !== null,
      ignored,
    }
    const identityForFingerprint = {
      profileId: resolved.profileId,
      // `identityFingerprint` reads endpoint/account/user only; the connection is
      // passed whole so its type stays the shared `OvConnection`.
      connection,
      peerId: connection.peerId ?? null,
    }
    return {
      connection,
      origins: resolved.origins,
      profileId: resolved.profileId,
      profileLabel: resolved.profileLabel,
      peerId: connection.peerId ?? null,
      authModeHint: resolved.authModeHint,
      fingerprintInput: resolved.fingerprintInput,
      profile: selected.profile,
      source: selected.source,
      overrides: effective,
      warnings,
      scopeKey: identityFingerprint(identityForFingerprint, probedAuthMode, resolved.authModeHint),
    }
  }

  /** The identity-switch rules for the current scope state. */
  rules(): ScopeIdentityRules {
    return identityRules(this.options.probedAuthMode(), this.options.healthy())
  }

  /** The overrides/identity block `/scopes` returns. */
  overridesPayload(resolved: ResolvedScope): ScopeOverridesPayload {
    return {
      account: resolved.overrides.stored?.account ?? null,
      user: resolved.overrides.stored?.user ?? null,
      peer: resolved.overrides.stored?.peer ?? null,
      allowed: identityRules(resolved.connection.authMode ?? null, this.options.healthy()),
      overrides: resolved.overrides.active,
    }
  }

  /** The reviewable scope identity (`ScopePayload`/`ScopesPayload` share it). */
  scopeInfo(resolved: ResolvedScope): ScopeKeyInfo {
    return {
      scopeKey: resolved.scopeKey,
      profileId: resolved.profileId,
      label: resolved.profileLabel,
      endpoint: resolved.connection.endpoint,
      authMode: resolved.connection.authMode ?? null,
      account: resolved.connection.account,
      user: resolved.connection.user,
      peer: resolved.peerId,
      overrides: resolved.overrides.active,
    }
  }

  /** The switch guard: a switch is refused while anything mutation-shaped is pending. */
  guardState(): ScopeSwitchGuard {
    const guard = this.options.guard()
    if (guard.busy) return { blocked: true, reason: 'mutation-in-flight', pending: guard.pending }
    if (guard.pending > 0) return { blocked: true, reason: 'confirmation-pending', pending: guard.pending }
    const last = guard.lastSwitchAt ?? this.lastSwitchAt
    if (last !== null && this.now() - last < 1_000) {
      return { blocked: true, reason: 'cooldown', pending: 0 }
    }
    return { blocked: false, reason: null, pending: 0 }
  }

  /** Record a switch (the caller audits it); also feeds the cooldown. */
  noteSwitch(): void {
    this.lastSwitchAt = this.now()
    this.healthCache.clear()
  }

  /**
   * Apply one identity-override mutation.
   *
   * This is a **local plugin mutation** (it writes `scope-state.json`, never the
   * OpenViking store), but it changes mutation authority, so the host only
   * exposes it on the authenticated transport and refuses it while a write/ops
   * action is pending. The caller re-resolves after `ok:true`.
   */
  switchIdentity(
    request: ScopeIdentityRequest,
    resolved: ResolvedScope,
  ):
    | { ok: true; changed: boolean; identity: ScopeIdentityOverride | null; warnings: PluginNotice[] }
    | { ok: false; code: string; message: string } {
    const guard = this.guardState()
    if (guard.blocked) {
      return { ok: false, code: 'scope-switch-blocked', message: 'A write or operational action is pending; finish it before switching.' }
    }
    const profile = resolved.profile
    if (profile === null) {
      return { ok: false, code: 'profile-missing', message: 'Create a named profile before switching the in-server identity.' }
    }
    const rules = identityRules(resolved.connection.authMode ?? null, this.options.healthy())
    const clear = new Set(request.clear ?? [])
    const text = (value: unknown): string | null => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      return trimmed.length === 0 ? null : trimmed
    }
    const wantsAccount = request.account !== undefined && !clear.has('account')
    const wantsUser = request.user !== undefined && !clear.has('user')
    const wantsPeer = request.peer !== undefined && !clear.has('peer')
    if ((wantsAccount || wantsUser) && !(rules.account && rules.user)) {
      return {
        ok: false,
        code: 'identity-not-switchable',
        message: rules.reason === 'identity-key-bound'
          ? 'The API key binds the identity; switch to another profile to change account/user.'
          : 'This server/identity cannot be switched (auth mode or health).',
      }
    }
    if (wantsPeer && !rules.peer) {
      return { ok: false, code: 'identity-not-switchable', message: 'The peer read selector is disabled for this auth mode or health state.' }
    }
    const previous = resolved.overrides.stored ?? { account: null, user: null, peer: null }
    let account = previous.account
    let user = previous.user
    let peer = previous.peer
    if (clear.has('account') || (request.account !== undefined && text(request.account) === null)) account = null
    else if (request.account !== undefined) account = text(request.account)
    if (clear.has('user') || (request.user !== undefined && text(request.user) === null)) user = null
    else if (request.user !== undefined) user = text(request.user)
    if (clear.has('peer') || (request.peer !== undefined && text(request.peer) === null)) peer = null
    else if (request.peer !== undefined) peer = text(request.peer)
    if (account !== null && !isValidScopeName(account)) {
      return { ok: false, code: 'identity-not-switchable', message: 'The account selector is not a valid header value.' }
    }
    if (user !== null && !isValidScopeName(user)) {
      return { ok: false, code: 'identity-not-switchable', message: 'The user selector is not a valid header value.' }
    }
    if (peer !== null && !isValidPeerId(peer)) {
      return { ok: false, code: 'identity-not-switchable', message: 'The peer id is not a valid path segment.' }
    }
    if (pairRequired(resolved.connection.authMode ?? null) && (account !== null || user !== null) && (account === null || user === null)) {
      return { ok: false, code: 'identity-switch-incomplete', message: 'trusted mode needs both account and user.' }
    }
    // An override equal to the profile default is stored as "no override": the
    // state file stays a list of genuine in-server identity overrides.
    if (account === profile.account) account = null
    if (user === profile.user) user = null
    if (peer === profile.peerId) peer = null
    const next: ScopeIdentityOverride | null =
      account === null && user === null && peer === null ? null : { account, user, peer }
    const unchanged =
      (next?.account ?? null) === (previous.account ?? null) &&
      (next?.user ?? null) === (previous.user ?? null) &&
      (next?.peer ?? null) === (previous.peer ?? null)
    if (unchanged) return { ok: true, changed: false, identity: next, warnings: [] }
    const written = this.options.state.write(profile.id, next)
    if (!written.ok) {
      return { ok: false, code: 'rejected-by-server', message: written.error ?? 'Could not write scope-state.json.' }
    }
    const warnings: PluginNotice[] = []
    if (account !== null || user !== null) {
      warnings.push({ code: 'identityOverrideActive', params: { account: account ?? profile.account, user: user ?? profile.user } })
    }
    if (peer !== null) warnings.push({ code: 'peerReadSelectorActive', params: { peer } })
    return { ok: true, changed: true, identity: next, warnings }
  }

  /**
   * Persist the active profile when the runtime Config points somewhere new.
   *
   * Called from the host's re-resolve path (settings save / boot): a profile
   * change writes the state file and **resets the identity overrides** (sign-off
   * 1). Returns whether the persisted profile changed.
   */
  persistProfile(profileId: string): { changed: boolean; ok: boolean; error: string | null } {
    const current = this.options.state.read().file.activeProfileId
    if (current === profileId) return { changed: false, ok: true, error: null }
    const written = this.options.state.write(profileId, null)
    this.healthCache.clear()
    return { changed: written.ok, ok: written.ok, error: written.error }
  }

  /** Fill per-scope capability summaries: the active scope is marked fresh. */
  private rememberCapabilities(profileId: string | null, capabilities: Record<string, ScopeCapability>): void {
    if (profileId !== null && Object.keys(capabilities).length > 0) this.capabilityCache.set(profileId, capabilities)
  }

  /** One row's health: cached for the probe TTL, `fresh` forces a probe. */
  private async healthFor(profile: Profile, fresh: boolean): Promise<ScopeHealthInfo> {
    const cached = this.healthCache.get(profile.id)
    if (!fresh && cached !== undefined && this.now() - cached.at < SCOPE_PROBE_TTL_MS) return cached.health
    let health: ScopeHealthInfo
    try {
      health = await this.options.probe(profile)
    } catch (error) {
      health = { ok: false, version: null, latencyMs: null, error: error instanceof Error ? error.message : String(error) }
    }
    this.healthCache.set(profile.id, { at: this.now(), health })
    return health
  }

  /** Stable warning codes for one row of the scope menu. */
  private warningsFor(profile: Profile, health: ScopeHealthInfo, isActive: boolean, resolved: ResolvedScope): string[] {
    const warnings: string[] = []
    let host: string | null = null
    try {
      host = new URL(profile.endpoint).hostname
    } catch {
      host = null
    }
    const loopback = host === null ? false : isLoopbackHostname(host)
    if (!loopback) warnings.push('remote-endpoint')
    if (!loopback && profile.endpoint.toLowerCase().startsWith('http:')) warnings.push('cleartext-http')
    if (profile.authMode === 'api_key' || (isActive && resolved.connection.authMode === 'api_key')) warnings.push('key-bound-identity')
    if (!health.ok) warnings.push('unreachable')
    if (isActive) for (const warning of resolved.warnings) warnings.push(warning.code)
    return [...new Set(warnings)]
  }

  /**
   * The scope list the switcher renders.
   *
   * Health probes are cheap `/health` reads (no credentials beyond the profile's
   * own configured identity, never `/admin`); the active scope's capability
   * matrix is the live one, other rows show their last-known matrix or "probe on
   * switch".
   */
  async listScopes(options: { fresh?: boolean } = {}): Promise<ScopeListEntry[]> {
    const fresh = options.fresh === true
    const resolved = this.resolveActive()
    const profileFile = this.options.profiles.read().file
    const profiles = profileFile.profiles
    if (resolved.profile !== null) this.rememberCapabilities(resolved.profile.id, this.options.activeCapabilities())
    const rows: ScopeListEntry[] = []
    for (const profile of profiles) {
      const isActive = resolved.profile?.id === profile.id
      const health = isActive
        ? await this.activeHealth(profile, fresh)
        : await this.healthFor(profile, fresh)
      const capabilities = isActive
        ? this.options.activeCapabilities()
        : (this.capabilityCache.get(profile.id) ?? {})
      const warnings = this.warningsFor(profile, health, isActive, resolved)
      rows.push({
        id: profile.id,
        label: profile.label,
        endpoint: profile.endpoint,
        authMode: isActive ? resolved.connection.authMode ?? profile.authMode : profile.authMode === 'unknown' ? null : profile.authMode,
        account: isActive ? resolved.connection.account : profile.account,
        user: isActive ? resolved.connection.user : profile.user,
        peer: isActive ? resolved.peerId : profile.peerId.length > 0 ? profile.peerId : null,
        hasApiKey: profile.apiKey.length > 0,
        health,
        capabilities,
        warnings,
        isActive,
        overrides: isActive && resolved.overrides.active,
      })
    }
    if (resolved.profile === null) {
      // The legacy v0.4 connection is a real scope; it is listed (pinned first)
      // and the menu offers "create a named scope" instead of silently converting.
      const legacyHealth: ScopeHealthInfo = {
        ok: this.options.healthy(),
        version: null,
        latencyMs: null,
        error: this.options.healthy() ? null : 'profile-unhealthy',
      }
      rows.unshift({
        id: '__legacy__',
        label: 'Legacy connection',
        endpoint: resolved.connection.endpoint,
        authMode: resolved.connection.authMode ?? null,
        account: resolved.connection.account,
        user: resolved.connection.user,
        peer: resolved.peerId,
        hasApiKey: resolved.connection.apiKey.length > 0,
        health: legacyHealth,
        capabilities: {},
        warnings: this.warningsFor(
          {
            id: '__legacy__',
            label: 'Legacy connection',
            endpoint: resolved.connection.endpoint,
            authMode: 'unknown',
            apiKey: resolved.connection.apiKey,
            account: resolved.connection.account,
            user: resolved.connection.user,
            peerId: resolved.peerId ?? '',
          },
          legacyHealth,
          true,
          resolved,
        ),
        isActive: true,
        overrides: resolved.overrides.active,
      })
    }
    return rows
  }

  /** The active scope's health from the probe (fresh when asked); cached briefly. */
  private async activeHealth(profile: Profile, fresh: boolean): Promise<ScopeHealthInfo> {
    return this.healthFor(profile, fresh)
  }
}

/** The empty override block (exported for tests and the legacy row). */
export function emptyOverrides(): EffectiveOverrides {
  return { stored: emptyScopeState().identity, account: null, user: null, peer: null, active: false, ignored: [] }
}
