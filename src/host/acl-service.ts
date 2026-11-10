/**
 * v0.9 §5: the read-only ACL/Access view.
 *
 * The shipped OpenViking server (0.5.1.1–0.5.3) exposes
 * `GET /api/v1/acl?uri=<viking://resources/...>` only: **resources-only**, and the
 * caller needs `manage` (ADMIN implicit). There is no share/invite API and no
 * endpoint that reports whether ACL is enabled — a 403 means "manage required",
 * which is exactly the ambiguity the UI must state instead of guessing.
 *
 * This service therefore classifies one user-selected resource URI into one of
 * four states and never mutates anything:
 *
 *   available        — 200, the direct/inherited/effective tables are shown
 *   denied-no-manage — 403: ACL may be enabled without this identity having
 *                      manage, **or** ACL may be disabled; the UI says exactly
 *                      that ambiguity and never claims enabled/disabled
 *   only-resources   — 400 for the attempted URI (the server only supports
 *                      `viking://resources/**`)
 *   unsupported      — 404 / any other answer (older build, route absent)
 *
 * Principal ids are server-side identity data: they are shown only for the
 * selected resource, bounded by `ACL_ENTRIES_MAX`, cached only in this
 * short-lived in-memory map (keyed per scope), and never written to the audit
 * log, evidence files or logs.
 */
import type { AclEntry, AclPayload, AclViewState, AclVisibilityKind, ScopeCapability } from '../shared/protocol.ts'
import { ACL_ENTRIES_MAX, SCOPE_PROBE_TTL_MS } from '../shared/limits.ts'
import type { OpenVikingApi } from './openviking-api.ts'

/** How long one ACL report is reused in memory (per scope + URI). */
const ACL_CACHE_TTL_MS = SCOPE_PROBE_TTL_MS
/** Bounded cache entries; principals are privacy-sensitive, so keep it small. */
const ACL_CACHE_MAX = 8

/** Visibility classification from the URI alone (never a server call). */
export function classifyVisibility(uri: string): AclVisibilityKind {
  const normalized = uri.trim()
  if (!normalized.startsWith('viking://')) return 'unknown'
  if (/^viking:\/\/resources(\/|$)/.test(normalized) || /^viking:\/\/agent\/skills(\/|$)/.test(normalized)) {
    return 'account-shared'
  }
  if (/^viking:\/\/user\/[^/]+\/peers\/[^/]+(\/|$)/.test(normalized)) return 'peer'
  if (/^viking:\/\/user\/[^/]+\/sessions(\/|$)/.test(normalized)) return 'session'
  if (/^viking:\/\/user\/[^/]+(\/|$)/.test(normalized)) return 'private-user'
  if (/^viking:\/\/agent(\/|$)/.test(normalized)) return 'agent'
  return 'unknown'
}

/** Whether the ACL route accepts this URI at all (server: resources only). */
export function isAclSupportedUri(uri: string): boolean {
  return /^viking:\/\/resources(\/|$)/.test(uri.trim())
}

/** A short English fact for a state the UI maps to localized copy. */
export function aclStateDetail(state: AclViewState, serverMessage: string | null): string | null {
  switch (state) {
    case 'available':
      return null
    case 'denied-no-manage':
      return 'acl-manage-required'
    case 'only-resources':
      return 'acl-resources-only'
    case 'unsupported':
      return serverMessage ?? 'acl-unsupported'
  }
}

/**
 * v0.9 review S2: the failure detail distinguishes *why* the four-state
 * classification landed where it did. An invalid key (401) is not "this build
 * has no ACL route", and a 5xx/network failure is not "unsupported" either — the
 * state stays one of the four (the UI contract) but the detail is honest.
 */
export function aclFailureDetail(status: number, serverMessage: string | null): string {
  if (status === 401) return 'acl-auth-required'
  if (status === 403) return 'acl-manage-required'
  if (status === 400) return 'acl-resources-only'
  if (status === 0) return 'acl-unreachable'
  if (status === 404) return 'acl-unsupported'
  if (status >= 500) return 'acl-server-error'
  return serverMessage === null ? 'acl-unsupported' : 'acl-request-failed'
}

/**
 * Classify one ACL failure into the four-state UI contract.
 *
 * 401/403 are both permission-shaped (`denied-no-manage`), 400 is the
 * resources-only restriction, and anything else (404, 5xx, network) is
 * `unsupported` — never a guessed "ACL disabled".
 */
export function classifyAclFailure(status: number): AclViewState {
  if (status === 400) return 'only-resources'
  if (status === 401 || status === 403) return 'denied-no-manage'
  return 'unsupported'
}

/** Bound and sanitize one table from the server answer. */
function normalizeEntries(raw: unknown): AclEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: AclEntry[] = []
  for (const candidate of raw) {
    if (entries.length >= ACL_ENTRIES_MAX) break
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    const principal = typeof record.principal === 'string' ? record.principal.trim() : ''
    const level = typeof record.level === 'string' ? record.level.trim() : ''
    if (principal.length === 0 || principal.length > 200) continue
    if (level.length === 0 || level.length > 32) continue
    entries.push({ principal, level })
  }
  return entries
}

export interface AclServiceOptions {
  api: OpenVikingApi
  /** The active scope key: the cache is keyed per scope (v0.9 §4.1). */
  scopeKey: () => string
  /** Latest capability facts (version/role) for the panel's hint. */
  serverFacts: () => { version: string | null; role: string | null }
  now?: () => number
}

/**
 * The ACL proxy + classification.
 *
 * It performs exactly one GET for a URI the user selected; there is no probe at
 * startup, no enumeration and no mutation path. A capability probe result is
 * cached per scope so re-opening the Access tab is free.
 */
export class AclService {
  private readonly options: AclServiceOptions
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; payload: AclPayload }>()

  constructor(options: AclServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop cached reports (a switch: the previous scope's principals must not linger). */
  clear(): void {
    this.cache.clear()
  }

  /** Read the ACL report for one selected resource URI. Never throws. */
  async report(uri: string, options: { fresh?: boolean } = {}): Promise<AclPayload> {
    const normalized = uri.trim()
    const scopeKey = this.options.scopeKey()
    const observedAt = new Date(this.now()).toISOString()
    const facts = this.options.serverFacts()
    const base = {
      uri: normalized,
      aclMode: null,
      direct: [] as AclEntry[],
      inherited: [] as AclEntry[],
      effective: [] as AclEntry[],
      visibility: classifyVisibility(normalized),
      version: facts.version,
      role: facts.role,
      sharingAvailable: false as const,
      observedAt,
      warnings: [],
    }
    if (!isAclSupportedUri(normalized)) {
      // No network call: the server would answer 400 for the same fact, and the
      // route must not be usable as an arbitrary-URI ACL prober.
      return { ...base, state: 'only-resources', detail: aclStateDetail('only-resources', null) }
    }
    const key = `${scopeKey}\u0000${normalized}`
    const cached = this.cache.get(key)
    if (options.fresh !== true && cached !== undefined && this.now() - cached.at < ACL_CACHE_TTL_MS) {
      return cached.payload
    }
    const answer = await this.options.api.getAcl(normalized)
    const state: AclViewState = answer.ok ? 'available' : classifyAclFailure(answer.status)
    const report = answer.ok ? answer.result : null
    // Never guess the mode: only the server's own two documented values are
    // reported, anything else (missing/unknown) stays null ("unknown").
    const aclMode =
      report?.acl_mode === 'inherit' || report?.acl_mode === 'restricted' ? report.acl_mode : null
    const payload: AclPayload = {
      ...base,
      state,
      aclMode: state === 'available' ? aclMode : null,
      direct: state === 'available' ? normalizeEntries(report?.direct_entries) : [],
      inherited: state === 'available' ? normalizeEntries(report?.inherited_entries) : [],
      effective: state === 'available' ? normalizeEntries(report?.effective_entries) : [],
      detail: answer.ok ? null : aclFailureDetail(answer.status, answer.error),
    }
    this.cache.delete(key)
    this.cache.set(key, { at: this.now(), payload })
    while (this.cache.size > ACL_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return payload
  }

  /** A cheap capability summary for the scope menu's per-scope matrix. */
  capabilitySummary(): ScopeCapability {
    return { available: false, detail: 'acl-manage-required' }
  }
}
