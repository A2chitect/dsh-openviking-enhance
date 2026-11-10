/**
 * v0.9 §3.4: the official memory plugin compatibility advisory.
 *
 * A cockpit scope switch moves only **this plugin's** read/write target. The
 * conversation's capture/commit pipeline belongs to
 * `@openviking/dsh-memory-plugin`, which resolves its own connection and
 * credentials independently (v0.5 research). The real footgun is therefore:
 * "the cockpit looks at server B while this conversation keeps capturing to
 * server A" — and no OpenViking response says which server captured a session.
 *
 * The mitigation is a read-only, **allowlisted projection** of the official
 * plugin's per-session runtime config: endpoint host, account, user, peer and
 * auth-mode hint only. The API key and the raw config object are never read out
 * of this module, never serialised and never compared. The projection is
 * explicitly advisory:
 *
 *  - the in-process shape is not a published contract (Lead sign-off 4 accepts
 *    reading it because a failure is only "unknown", never a false claim);
 *  - when the facts are absent the answer is `known: false` — the UI says
 *    "official plugin connection: unknown" instead of guessing;
 *  - nothing here rewrites the official plugin's credentials or rebinds a
 *    session (explicitly out of scope; see the README N/A matrix).
 */
import type { OfficialPluginFacts } from '../shared/protocol.ts'
import type { OpenVikingMemoryRuntime } from './commit-service.ts'

/** The connection facts this module is allowed to project. */
export interface OfficialPluginProjection {
  /** The configured endpoint (base URL), when the runtime exposed one. */
  endpoint: string | null
  /** The endpoint's host[:port] — all a banner needs, and no path. */
  endpointHost: string | null
  account: string | null
  user: string | null
  peer: string | null
  authMode: string | null
}

/**
 * Extract the allowed facts from the runtime.
 *
 * The official plugin's resolved config field names (verified on the installed
 * 0.5.32 build's `config.mjs`): `baseUrl` (the endpoint), `account`, `user`,
 * `peerId`, `authMode`. Only string values are considered; everything else is
 * ignored so an upstream shape change degrades to "unknown" rather than a
 * guessed warning.
 */
export function projectOfficialPluginFacts(runtime: OpenVikingMemoryRuntime | null): OfficialPluginProjection | null {
  if (runtime === null) return null
  const configs: Array<Record<string, unknown>> = []
  try {
    for (const state of runtime.states?.values() ?? []) {
      const config = state?.config
      if (config !== undefined && config !== null && typeof config === 'object') configs.push(config)
    }
  } catch {
    return null
  }
  let endpoint: string | null = null
  let account: string | null = null
  let user: string | null = null
  let peer: string | null = null
  let authMode: string | null = null
  const text = (value: unknown, max = 200): string | null =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null
  for (const config of configs) {
    endpoint ??= text(config.baseUrl) ?? text(config.endpoint)
    account ??= text(config.account, 128)
    user ??= text(config.user, 128)
    peer ??= text(config.peerId, 128)
    authMode ??= text(config.authMode, 32) ?? text(config.auth_mode, 32)
  }
  if (endpoint === null && account === null && user === null && peer === null && authMode === null) return null
  let endpointHost: string | null = null
  if (endpoint !== null) {
    try {
      const url = new URL(endpoint)
      endpointHost = url.host.length > 0 ? url.host : null
    } catch {
      endpointHost = null
    }
  }
  return { endpoint: endpoint === null ? null : endpoint.replace(/\/+$/, ''), endpointHost, account, user, peer, authMode }
}

/** The active scope facts the comparison needs. */
export interface ActiveScopeFactInput {
  endpoint: string
  account: string
  user: string
  peer: string | null
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).host
  } catch {
    return null
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Compare the official plugin's facts with the active scope.
 *
 * `matches` is `true` only when every projected fact agrees; `false` when at
 * least one known fact disagrees; `null` when nothing could be compared. The
 * advisory `pipelineMismatch` is true only for a definite disagreement — an
 * unknown projection never produces a warning.
 */
export function compareOfficialPluginFacts(
  projection: OfficialPluginProjection | null,
  active: ActiveScopeFactInput,
): { facts: OfficialPluginFacts | null; pipelineMismatch: boolean } {
  if (projection === null) return { facts: null, pipelineMismatch: false }
  const known =
    projection.endpoint !== null ||
    projection.account !== null ||
    projection.user !== null ||
    projection.peer !== null ||
    projection.authMode !== null
  const facts: OfficialPluginFacts = {
    known,
    endpointHost: projection.endpointHost,
    account: projection.account,
    user: projection.user,
    peer: projection.peer,
    authMode: projection.authMode,
    matches: null,
  }
  if (!known) return { facts, pipelineMismatch: false }
  let compared = 0
  let agreed = 0
  if (projection.endpoint !== null) {
    compared += 1
    const sameHost = normalizeEndpoint(projection.endpoint) === normalizeEndpoint(active.endpoint)
    // Prefer a host-level compare when both parse; an explicit port difference
    // is still a difference, so compare the full normalized endpoints first and
    // fall back to host equality only when one side is not a parseable URL.
    const a = hostOf(projection.endpoint)
    const b = hostOf(active.endpoint)
    if (sameHost || (a !== null && a === b)) agreed += 1
  }
  if (projection.account !== null) {
    compared += 1
    if (projection.account === active.account) agreed += 1
  }
  if (projection.user !== null) {
    compared += 1
    if (projection.user === active.user) agreed += 1
  }
  if (projection.peer !== null) {
    compared += 1
    if (projection.peer === active.peer) agreed += 1
  }
  // `authMode` is a hint about the official plugin's own configuration, not a
  // scope identity field (this plugin probes the mode it sees): it is shown in
  // the advisory copy but never counted as a match/mismatch.
  if (compared === 0) return { facts, pipelineMismatch: false }
  const matches = agreed === compared
  return { facts: { ...facts, matches }, pipelineMismatch: !matches }
}
