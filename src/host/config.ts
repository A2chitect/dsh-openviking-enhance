/**
 * OpenViking connection resolution for the host half.
 *
 * The plugin never invents credentials: it resolves them from the documented
 * OpenViking layers below, so the panel always shows the memory space the
 * sessions actually write to. This is the plugin's own resolver — it deliberately
 * does not reproduce the official plugin's full credential chain; the differences
 * are listed in both READMEs' host-contract chapter and in `PROVENANCE.md`.
 *
 *   1. explicit plugin config (the loader row in cordis.patch.yml)
 *   2. process environment (`OPENVIKING_*`)
 *   3. `~/.openviking/ovcli.conf`      → `url`, `api_key`
 *      `~/.openviking/ovcli.conf.local` → `account`, `user`
 *   4. built-in defaults (loopback server, `default`/`default`)
 *
 * Never log `apiKey`. `describeConnection()` exists for diagnostics and
 * deliberately omits it.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ConfigSourceHealth,
  ConfigSourceState,
  ConnectionFieldOrigin,
  ConnectionSource,
} from '../shared/protocol.ts'
import type { Profile } from './profiles.ts'
import { fingerprintInput, normalizeProfileEndpoint } from './profiles.ts'

export interface OvConnection {
  /** Base URL without a trailing slash. */
  endpoint: string
  apiKey: string
  account: string
  user: string
  /**
   * The server's probed auth mode, when known.
   *
   * In `api_key` mode the server derives the identity from the key and ignores
   * `X-OpenViking-Account`/`-User`; sending them is harmless but misleading, so
   * `openviking-api.ts` omits them there. `null`/absent = not probed yet, where
   * the v0.4 behaviour (send them) is kept.
   */
  authMode?: string | null
  /**
   * v0.9 peer READ selector.
   *
   * Applied by `OpenVikingApi` as `X-OpenViking-Actor-Peer` **only** to
   * sessionless read methods (directory listings, content reads, ACL). Writes
   * and session-scoped reads keep the session's actor peer from the official
   * memory plugin, so this field can never change where a write lands (Lead
   * sign-off 2).
   */
  peerId?: string | null
}

/** The connection plus a secret-free record of where each field came from. */
export interface ConnectionResolution {
  connection: OvConnection
  origins: ConnectionFieldOrigin[]
  /** Per-file read health for the two OpenViking config layers (P1-4). */
  configSources: ConfigSourceHealth[]
}

export interface ConnectionOverrides {
  endpoint?: string | undefined
  apiKey?: string | undefined
  account?: string | undefined
  user?: string | undefined
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1933'
const DEFAULT_ACCOUNT = 'default'
const DEFAULT_USER = 'default'

/** The OpenViking home the CLI and the memory plugin use. */
export function openVikingHome(): string {
  return process.env.OPENVIKING_HOME?.trim() || join(homedir(), '.openviking')
}

/**
 * Read one JSON config file, reporting *why* it produced nothing.
 *
 * A missing file is the normal case (a fresh machine); a malformed or unreadable
 * one is not, and the Doctor must be able to say which happened without echoing
 * contents. Values only; the secret paths never leave this module.
 */
export function readJsonSource(path: string): {
  value: Record<string, unknown>
  state: ConfigSourceState
  errorCode: string | null
} {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? null
    return { value: {}, state: code === 'ENOENT' ? 'missing' : code === null ? 'unknown' : 'unreadable', errorCode: code }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const code = error instanceof SyntaxError ? 'InvalidJSON' : ((error as NodeJS.ErrnoException).code ?? null)
    return { value: {}, state: 'malformed', errorCode: code }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, state: 'wrong-shape', errorCode: 'not-an-object' }
  }
  return { value: parsed as Record<string, unknown>, state: 'ok', errorCode: null }
}

/** A config path in a form safe to show: `~/.openviking/...` or `$VAR/...`. */
function symbolicOpenVikingPath(file: string, env: NodeJS.ProcessEnv): string {
  const override = env.OPENVIKING_HOME?.trim()
  return override ? `$OPENVIKING_HOME/${file}` : `~/.openviking/${file}`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize to `scheme://host:port` with no trailing slash. */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_ENDPOINT
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Resolve the connection. `readJsonFile` failures are silent by design: a
 * missing config file is the normal case for a fresh machine, and the plugin
 * must never take the host down over it.
 */
export function resolveConnection(
  overrides: ConnectionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): OvConnection {
  return resolveConnectionWithOrigins(overrides, env).connection
}

/** One resolved field, plus the layer that supplied it. */
function pick(
  candidates: Array<{ value: string; source: ConnectionSource; detail: string | null }>,
  fallback: { value: string; source: ConnectionSource; detail: string | null },
): { value: string; source: ConnectionSource; detail: string | null } {
  for (const candidate of candidates) {
    if (candidate.value.length > 0) return candidate
  }
  return fallback
}

/**
 * Resolve the connection and record the provenance of every field.
 *
 * The Doctor needs to answer "why is it pointed there?"; the same precedence
 * walk therefore also reports which layer won each field. Values themselves are
 * never echoed for `apiKey` — only whether one is configured and from where.
 */
/** Read both OpenViking config layers once, with their health records. */
function readOpenVikingSources(env: NodeJS.ProcessEnv): {
  cli: Record<string, unknown>
  cliLocal: Record<string, unknown>
  configSources: ConfigSourceHealth[]
} {
  const home = env.OPENVIKING_HOME?.trim() || openVikingHome()
  const cliSource = readJsonSource(join(home, 'ovcli.conf'))
  const cliLocalSource = readJsonSource(join(home, 'ovcli.conf.local'))
  return {
    cli: cliSource.value,
    cliLocal: cliLocalSource.value,
    configSources: [
      { source: 'ovcli.conf', path: symbolicOpenVikingPath('ovcli.conf', env), state: cliSource.state, errorCode: cliSource.errorCode },
      {
        source: 'ovcli.conf.local',
        path: symbolicOpenVikingPath('ovcli.conf.local', env),
        state: cliLocalSource.state,
        errorCode: cliLocalSource.errorCode,
      },
    ],
  }
}

/**
 * Config-source health for the Doctor (P1-4).
 *
 * Missing is normal and silent; malformed/unreadable/wrong-shape are the states a
 * person needs told about, because the plugin silently falls back to defaults in
 * all of them. Never returns contents.
 */
export function configSourceHealth(env: NodeJS.ProcessEnv = process.env): ConfigSourceHealth[] {
  return readOpenVikingSources(env).configSources
}

export function resolveConnectionWithOrigins(
  overrides: ConnectionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ConnectionResolution {
  const { cli, cliLocal, configSources } = readOpenVikingSources(env)

  const endpoint = pick(
    [
      { value: overrides.endpoint ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_URL), source: 'env', detail: 'OPENVIKING_URL' },
      { value: str(env.OPENVIKING_BASE_URL), source: 'env', detail: 'OPENVIKING_BASE_URL' },
      { value: str(cli.url), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_ENDPOINT, source: 'default', detail: null },
  )
  const apiKey = pick(
    [
      { value: overrides.apiKey ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_BEARER_TOKEN), source: 'env', detail: 'OPENVIKING_BEARER_TOKEN' },
      { value: str(env.OPENVIKING_API_KEY), source: 'env', detail: 'OPENVIKING_API_KEY' },
      { value: str(cli.api_key), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: '', source: 'none', detail: null },
  )
  const account = pick(
    [
      { value: overrides.account ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_ACCOUNT), source: 'env', detail: 'OPENVIKING_ACCOUNT' },
      { value: str(cliLocal.account), source: 'ovcli.local', detail: 'ovcli.conf.local' },
      { value: str(cli.account), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_ACCOUNT, source: 'default', detail: null },
  )
  const user = pick(
    [
      { value: overrides.user ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_USER), source: 'env', detail: 'OPENVIKING_USER' },
      { value: str(cliLocal.user), source: 'ovcli.local', detail: 'ovcli.conf.local' },
      { value: str(cli.user), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_USER, source: 'default', detail: null },
  )

  return {
    connection: {
      endpoint: normalizeEndpoint(endpoint.value),
      apiKey: apiKey.value,
      account: account.value,
      user: user.value,
    },
    configSources,
    origins: [
      { field: 'endpoint', source: endpoint.source, detail: endpoint.detail, configured: endpoint.value.length > 0 },
      // The value of an API key never leaves this module; the origin record says
      // only where it came from.
      { field: 'apiKey', source: apiKey.source, detail: apiKey.detail, configured: apiKey.value.length > 0 },
      { field: 'account', source: account.source, detail: account.detail, configured: account.value.length > 0 },
      { field: 'user', source: user.source, detail: user.detail, configured: user.value.length > 0 },
    ],
  }
}

/** Diagnostic view: everything except the key. */
export function describeConnection(connection: OvConnection): Record<string, string> {
  return {
    endpoint: connection.endpoint,
    account: connection.account,
    user: connection.user,
    auth: connection.apiKey ? 'bearer' : 'none',
  }
}

/* ========================================================================
 * v0.5 — profile resolution (Lead sign-off decision A)
 * ===================================================================== */

/**
 * The resolved identity a write runs under.
 *
 * `connection` is the same mutable object the v0.4 services hold, so an
 * identity switch updates every reader at once; `origins` is likewise the exact
 * array `DoctorService` renders. See `index.ts`'s `applyIdentity`.
 */
export interface ResolvedIdentity {
  connection: OvConnection
  origins: ConnectionFieldOrigin[]
  /** Profile id, or null in legacy resolution (env/ovcli/defaults). */
  profileId: string | null
  profileLabel: string | null
  /** Actor-peer scope configured on the profile; empty when none. */
  peerId: string | null
  /** The auth mode the profile owner expects; the probe confirms or corrects it. */
  authModeHint: string | null
  /** Stable, secret-free hash input for the identity fingerprint. */
  fingerprintInput: string
}

/** Profile provenance for the Doctor: which layer won each field. */
function profileOrigins(profile: Profile): ConnectionFieldOrigin[] {
  const detail = `profile:${profile.id}`
  return [
    { field: 'endpoint', source: 'profile', detail, configured: true },
    { field: 'apiKey', source: 'profile', detail, configured: profile.apiKey.length > 0 },
    { field: 'account', source: 'profile', detail, configured: profile.account.length > 0 },
    { field: 'user', source: 'profile', detail, configured: profile.user.length > 0 },
  ]
}

/**
 * Resolve the connection for the active profile, or fall back to v0.4 rules.
 *
 * **Precedence (decision A):** while a profile is active it wins over the
 * plugin-config overrides, the environment and `ovcli.conf`. Without one, the
 * v0.4 precedence is untouched — this function then returns exactly what
 * `resolveConnectionWithOrigins` has always returned.
 */
export function resolveConnectionForProfile(
  profiles: readonly Profile[],
  activeProfileId: string,
  overrides: ConnectionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedIdentity {
  const id = activeProfileId.trim()
  const profile = id.length > 0 ? profiles.find((candidate) => candidate.id === id) : undefined
  if (profile !== undefined) {
    const connection: OvConnection = {
      endpoint: normalizeEndpoint(normalizeProfileEndpoint(profile.endpoint)),
      apiKey: profile.apiKey,
      account: profile.account.length > 0 ? profile.account : 'default',
      user: profile.user.length > 0 ? profile.user : 'default',
      authMode: profile.authMode === 'unknown' ? null : profile.authMode,
    }
    const peerId = profile.peerId.length > 0 ? profile.peerId : null
    return {
      connection,
      origins: profileOrigins(profile),
      profileId: profile.id,
      profileLabel: profile.label,
      peerId,
      authModeHint: profile.authMode === 'unknown' ? null : profile.authMode,
      // The probed auth mode is appended by `identityFingerprint`; the stored
      // input here is only the secret-free shape both halves agree on.
      fingerprintInput: fingerprintInput({
        profileId: profile.id,
        endpoint: connection.endpoint,
        authMode: null,
        account: connection.account,
        user: connection.user,
        peer: peerId,
      }),
    }
  }
  const legacy = resolveConnectionWithOrigins(overrides, env)
  return {
    connection: legacy.connection,
    origins: legacy.origins,
    profileId: null,
    profileLabel: null,
    peerId: null,
    authModeHint: null,
    fingerprintInput: fingerprintInput({
      profileId: null,
      endpoint: legacy.connection.endpoint,
      authMode: null,
      account: legacy.connection.account,
      user: legacy.connection.user,
      peer: null,
    }),
  }
}

/**
 * `sha256:` + the digest of `{profileId, endpoint, authMode, account, user, peer}`.
 *
 * The probed auth mode is part of the identity on purpose: a profile that is
 * switched from `dev` to `api_key` (a new key stored) has a different identity,
 * and an undo prepared under the old one must be refused. `null` means "not
 * probed yet" and is hashed as `null` rather than guessed at — a later probe
 * that changes the answer changes the fingerprint, and the mismatch is visible
 * instead of silent.
 */
export function identityFingerprint(
  identity: Pick<ResolvedIdentity, 'profileId' | 'connection' | 'peerId'>,
  probedAuthMode: string | null,
  configuredAuthMode: string | null,
): string {
  const authMode = probedAuthMode ?? configuredAuthMode
  const input = fingerprintInput({
    profileId: identity.profileId,
    endpoint: identity.connection.endpoint,
    authMode,
    account: identity.connection.account,
    user: identity.connection.user,
    peer: identity.peerId,
  })
  return `sha256:${createHash('sha256').update(input).digest('hex')}`
}

