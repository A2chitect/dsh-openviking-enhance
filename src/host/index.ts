/**
 * Host half of `dsh-openviking-enhance`.
 *
 * Responsibilities:
 *  1. resolve the local OpenViking connection (same files the CLI reads);
 *  2. expose read-only JSON routes on the DSH web server for the browser half —
 *     config, commit status, commit list, one commit's memory diff, the current
 *     session's retrieval, and one retrieved entry's full text;
 *  3. stay completely inert when OpenViking is not running: every route answers
 *     `{ok:false, error}` instead of throwing, because a plugin route that
 *     throws can take a request down with it.
 *
 * It deliberately performs **no writes** to OpenViking and never touches the
 * third-party memory plugin's objects; the only cross-plugin reads are the two
 * optional lookups documented in `commit-service.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ACTIVITY_TASKS_DEFAULT_LIMIT,
  ACTIVITY_TASKS_MAX_LIMIT,
  API_PREFIX,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  RECALL_DEFAULT_LIMIT,
  TIMELINE_DEFAULT,
  TIMELINE_MAX,
  WRITE_ACTIONS,
  WRITE_BODY_MAX_BYTES,
  type ApiResult,
  type AuditPayload,
  type IdentityScope,
  type EnhanceConfig,
  type OveResult,
  type PluginNotice,
  type ProfileSummary,
  type ProfilesPayload,
  type ScopePayload,
  type SessionControlPayload,
  type TaskListPayload,
  type WriteAction,
} from '../shared/protocol.ts'
import {
  describeConnection,
  identityFingerprint,
  resolveConnectionForProfile,
  type ConnectionOverrides,
  type ResolvedIdentity,
} from './config.ts'
import { ActivityService, isCancellableTask } from './activity-service.ts'
import { AuditLog } from './audit.ts'
import { CapabilityService, scopeCapabilities } from './capability.ts'
import { ProfileStore, isHttpEndpoint } from './profiles.ts'
import { SessionControlService } from './session-control.ts'
import { WriteService } from './write-service.ts'
import {
  isJsonObject,
  isLoopbackHostname,
  isTrustedLocalRequest,
  readReadOnlyJsonBody,
} from './trust-fence.ts'
import { CommitService, isArchiveUriForSession, type OpenVikingMemoryRuntime } from './commit-service.ts'
import { OpenVikingApi } from './openviking-api.ts'
import { RecallService } from './recall-service.ts'
import { SessionLogService } from './session-log.ts'
import { DoctorService } from './doctor-service.ts'
import { readMemoryPluginVersion } from './local-state.ts'
import { CatalogService, normalizeExperienceKind } from './catalog-service.ts'
import { PreviewFailure, PreviewService } from './preview-service.ts'
import { SearchService } from './search-service.ts'
import {
  VikingCommand,
  vikingCommandDefinition,
  type VikingCommandDefinition,
} from './viking-command.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'openviking-enhance'

/** The web server is the only hard requirement; the OpenViking plugin is optional. */
export const inject = ['webServer']

/**
 * Everything a user may want to change, marked `.volatile()`.
 *
 * That marker is what puts a field on the Plugins page's configuration form: the
 * settings service projects volatile fields only, and a plugin whose fields are
 * ordinary has no form at all — its configuration stays in `cordis.patch.yml`,
 * which is exactly the situation this plugin shipped with. An empty string means
 * "not overridden", so the defaults below stay the composition layer the form
 * reverts to when a field is cleared.
 */
export const Config = z.object({
  /** Override the OpenViking base URL; default comes from `~/.openviking/ovcli.conf`. */
  endpoint: z.string().default('').volatile(),
  /** Override the API key (prefer the config file; this is for unusual setups). */
  apiKey: z.string().default('').volatile(),
  /** Override the identity the panel reads under. */
  account: z.string().default('').volatile(),
  user: z.string().default('').volatile(),
  /** Studio path appended to the endpoint when building the iframe URL. */
  studioPath: z.string().default('/studio/').volatile(),
  /** Status cache TTL in milliseconds. */
  cacheTtlMs: z.number().default(2500).volatile(),
  /** How long one retrieval answer is reused, in milliseconds. */
  recallCacheTtlMs: z.number().default(15000).volatile(),
  /**
   * Interface switch: the Studio entry in the left sidebar.
   *
   * The `show*` fields are *client-only* preferences: they exist here so the
   * Plugins page's configuration form can render and persist them (the settings
   * service projects `.volatile()` fields only), and the host half never reads
   * them. The browser half watches them through `ctx.configForms` and mounts or
   * unmounts each surface live, so flipping one takes effect on the next save
   * without a reload. `enableCommands` is the one switch the host reads (see its
   * own comment below).
   */
  showSidebarEntry: z.boolean().default(true).volatile(),
  /** Interface switch: the per-session commit status pill under the composer. */
  showCommitStatus: z.boolean().default(true).volatile(),
  /** Interface switch: the Memory recall tab in the right sidebar. */
  showRecallPanel: z.boolean().default(true).volatile(),
  /** Interface switch: the per-turn "memory sources" tail in the conversation. */
  showRecallExplain: z.boolean().default(true).volatile(),
  /** Interface switch: the Memory health tab and the Plugins-page health summary. */
  showHealthPanel: z.boolean().default(true).volatile(),
  /** Interface switch: the `viking://` preview tab in the right sidebar. */
  showPreview: z.boolean().default(true).volatile(),
  /** Interface switch: the Explore tab (search, rules, skills, experience). */
  showExplore: z.boolean().default(true).volatile(),
  /**
   * Host-side switch: register the read-only `/viking` command.
   *
   * Unlike the `show*` fields this one is read by the host half (the command
   * registry is a host service). It applies at plugin activation — startup or any
   * re-apply — and ALSO applies live when the Loader emits
   * `loader/volatile-update` for a volatile-only save
   * (`@deepseek-ai/cordis-plugin-loader` does; a volatile-only save does not
   * re-apply the entry by itself). A Loader that emits no such event falls back
   * to the next activation; there is no third behaviour. It is `.volatile()` so
   * the settings form persists it.
   */
  enableCommands: z.boolean().default(true).volatile(),
  /**
   * v0.5 master opt-in for writes (F9/F10).
   *
   * Defaults to **false**: with it off every write surface is hidden/disabled,
   * `/viking` refuses the write verbs, and every mutation route fails closed.
   * The host reads the live value at each call; the client reads it for buttons.
   */
  enableWrites: z.boolean().default(false).volatile(),
  /** v0.5 interface switch: the Activity tab (task centre + metrics). */
  enableActivity: z.boolean().default(true).volatile(),
  /** v0.5 interface switch: the scope chip on the composer/panel headers. */
  showScopeBanner: z.boolean().default(true).volatile(),
  /**
   * The active identity profile id, or '' for legacy v0.4 connection
   * resolution. A named profile wins over the endpoint/apiKey/account/user
   * overrides (Lead sign-off decision A); the host re-resolves on change.
   */
  activeProfile: z.string().default('').volatile(),
})

/**
 * One `Config` field as the Loader actually hands it over.
 *
 * A field marked `.volatile()` — which is what makes it editable on the Plugins
 * page — does NOT arrive as its value: schemastery resolves it to a reference
 * whose `get()` reads the current one, so a change made in the form is visible
 * without a reload. Reading such a field directly is exactly how this plugin
 * failed to activate the first time it shipped a settings form:
 * `config.studioPath` was a reference, `(path ?? '').trim` threw from inside
 * `apply`, and the whole entry went down with it.
 *
 * Ordinary fields arrive as plain values, so this accepts both — and typing the
 * parameter this way is the point: the compiler now refuses a raw read.
 */
export type ConfigField<T> = T | { get(): T }

export interface EnhanceConfigInput {
  endpoint?: ConfigField<string>
  apiKey?: ConfigField<string>
  account?: ConfigField<string>
  user?: ConfigField<string>
  studioPath?: ConfigField<string>
  cacheTtlMs?: ConfigField<number>
  recallCacheTtlMs?: ConfigField<number>
  showSidebarEntry?: ConfigField<boolean>
  showCommitStatus?: ConfigField<boolean>
  showRecallPanel?: ConfigField<boolean>
  showRecallExplain?: ConfigField<boolean>
  showHealthPanel?: ConfigField<boolean>
  showPreview?: ConfigField<boolean>
  showExplore?: ConfigField<boolean>
  enableCommands?: ConfigField<boolean>
  enableWrites?: ConfigField<boolean>
  enableActivity?: ConfigField<boolean>
  showScopeBanner?: ConfigField<boolean>
  activeProfile?: ConfigField<string>
}

/** The value behind a field, whether it is a reference or the value itself. */
export function configField<T>(value: ConfigField<T> | undefined): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/** A string field, or `''` for anything that is not one. */
function configText(value: ConfigField<string> | undefined): string {
  const plain = configField(value)
  return typeof plain === 'string' ? plain : ''
}

/** A numeric field, or the fallback. */
function configNumber(value: ConfigField<number> | undefined, fallback: number): number {
  const plain = configField(value)
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : fallback
}

/** Structural view of the host services this plugin uses. */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/**
 * The host context, narrowed to what this plugin touches. It is deliberately not
 * `extends Context`: the real logger is Cordis's `LoggerService`, and widening or
 * narrowing it here would only create friction with the framework's own types.
 */
interface HostContext {
  webServer: { register(route: WebRoute): () => void; port: number }
  effect(callback: () => (() => void) | void, label?: string): () => void
  get(key: string): unknown
  /**
   * Listen for a Cordis event. Used only for the Loader's
   * `loader/volatile-update`, so a settings save can toggle the `/viking`
   * command without a restart. Optional: a bare host without a plugin Loader
   * simply applies the value it started with.
   */
  on?(event: string, listener: () => void): (() => void) | void
  /**
   * Cordis's scoped `ctx.inject(deps, callback)`: run the callback once the
   * named service exists, and dispose what it returns when it goes away.
   *
   * This is how the command registry stays OPTIONAL: a composition without
   * `@deepseek-ai/dsh-commands` still mounts every route and every tab, it just
   * never gets a command. Waiting for the service is the activation-safe form;
   * reading `ctx.commands` directly would throw and take the entry down.
   */
  inject?(
    deps: readonly string[],
    callback: (scope: { get(key: string): unknown }) => (() => void) | void,
  ): { dispose(): void } | unknown
  logger?: { info?(message: string): void; warn?(message: string, error?: unknown): void }
}

/** The slice of the command registry this plugin registers into. */
interface CommandRegistryLike {
  register(definition: VikingCommandDefinition): () => void
}

/**
 * The authenticated mutation transport (`ctx.connection.fetch`), declared
 * structurally.
 *
 * This is Lead sign-off decision B: every v0.5 mutation rides the framework's
 * 0.2.2-rc.1 Fetch routes ("only owner Peers reach an exact route; the shared
 * handler answers 403 for every other principal"), and when the service is
 * absent writes fail closed with `transport-unavailable`. There is deliberately
 * **no** loopback `webServer` POST write path: the v0.4 read fence is weaker
 * than an authenticated transport, so raising write authority over it would be a
 * security regression.
 */
interface HostConnectionFetchRoute {
  /** Absolute path below `/api`. */
  path: string
  methods: readonly ('GET' | 'HEAD' | 'POST')[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

interface HostConnectionLike {
  fetch?: { register(route: HostConnectionFetchRoute): () => Promise<void> | void }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * An `http(s)` endpoint on this machine, or null.
 *
 * A candidate that is not loopback is refused rather than normalized: the point
 * of the check is that a request this plugin makes cannot leave the machine.
 */
export function parseLoopbackEndpoint(raw: string): URL | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return isLoopbackHostname(url.hostname) ? url : null
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
}

/**
 * A plugin entry that throws while activating does not just fail: it takes the
 * whole profile with it, and the user gets "1 entry did not activate" plus an
 * application that will not start. This plugin is a viewer for a local memory
 * server — there is no version of that worth a dead boot — so activation is
 * wrapped: a failure is logged in full and the plugin simply provides nothing.
 *
 * The logging is not decoration. The first time this happened the only visible
 * symptom was the boot dialog, and the cause had to be reconstructed by hand.
 */
export function apply(ctx: Context, config: EnhanceConfigInput = {}): void {
  try {
    start(ctx, config)
  } catch (error) {
    const logger = (ctx as unknown as { logger?: { error?: (line: string) => void } }).logger
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logger?.error?.(`[openviking-enhance] failed to activate, so the plugin provides nothing: ${detail}`)
  }
}

function start(ctx: Context, config: EnhanceConfigInput): void {
  const host = ctx as unknown as HostContext
  const logger = host.logger

  /* ---- v0.5 identity (F12 / decision A) -------------------------------- */

  /**
   * The plugin-owned profile file is the secret store of record. A missing or
   * corrupt file is not an error: `resolveConnectionForProfile` then falls back
   * to the v0.4 precedence, so the plugin keeps working on a fresh machine.
   */
  const profileStore = new ProfileStore()
  const connectionOverrides = (): ConnectionOverrides => ({
    endpoint: configText(config.endpoint),
    apiKey: configText(config.apiKey),
    account: configText(config.account),
    user: configText(config.user),
  })
  const activeProfileId = (): string => configText(config.activeProfile).trim()
  const resolveActive = (): ResolvedIdentity =>
    resolveConnectionForProfile(profileStore.read().file.profiles, activeProfileId(), connectionOverrides())

  /** The active identity. `connection`/`origins` are mutable objects so a
   * profile switch updates every v0.4 service in place (they hold references). */
  let resolvedIdentity: ResolvedIdentity = resolveActive()
  const connection = resolvedIdentity.connection
  const origins = resolvedIdentity.origins
  let currentApi = new OpenVikingApi(connection)

  /**
   * One API instance per active profile, behind a proxy.
   *
   * v0.4's services were constructed with a fixed client; making the proxy the
   * identity seam means a `loader/volatile-update` can swap the underlying
   * client without rebuilding every service (and without stale caches keyed to a
   * previous profile).
   */
  const api = new Proxy({} as OpenVikingApi, {
    get: (_target, property) => {
      const target = currentApi
      const value = (target as unknown as Record<string | symbol, unknown>)[property]
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })

  /** True once `ctx.connection.fetch.register` is available and our routes are on it. */
  let transportAvailable = false
  /** Assigned once the audit log exists; audits a profile switch. */
  let recordIdentitySwitch: (() => void) | null = null

  /**
   * The active identity, secret-free, with a stable fingerprint.
   *
   * The fingerprint hashes the probed auth mode when one exists (so a profile
   * whose key changed is a different identity) and falls back to the configured
   * expectation; it never contains the key. Every token/undo/audit entry stores
   * it, which is what makes "undo after an identity switch" impossible.
   */
  const identityScope = (): IdentityScope => {
    const probedAuthMode = capability.lastSnapshot()?.health.authMode ?? null
    // The API client reads `connection.authMode` for its header policy; refreshing
    // it here means every gate that confirms an identity (prepare/execute/scope)
    // also corrects the headers the next request carries.
    connection.authMode = probedAuthMode ?? resolvedIdentity.authModeHint
    return {
      profileId: resolvedIdentity.profileId,
      profileLabel: resolvedIdentity.profileLabel,
      endpoint: connection.endpoint,
      authMode: probedAuthMode ?? resolvedIdentity.authModeHint,
      account: connection.account,
      user: connection.user,
      peer: resolvedIdentity.peerId,
      fingerprint: identityFingerprint(resolvedIdentity, probedAuthMode, resolvedIdentity.authModeHint),
    }
  }

  /** Re-resolve the connection after `activeProfile` (or a legacy field) changed. */
  const resolveActiveIdentity = (): void => {
    const next = resolveActive()
    Object.assign(connection, next.connection)
    origins.splice(0, origins.length, ...next.origins)
    resolvedIdentity = { ...next, connection, origins }
    currentApi = new OpenVikingApi(connection)
    capability.invalidate()
    // v0.4 caches are keyed by session, not by identity: an answer read under
    // the previous profile must not survive the switch.
    service.resetCaches()
    recall.resetCaches()
    recordIdentitySwitch?.()
  }

  logger?.info?.(`[openviking-enhance] ${JSON.stringify(describeConnection(connection))}`)
  const studioPath = normalizeStudioPath(configText(config.studioPath))

  const memoryRuntime = (): OpenVikingMemoryRuntime | null => {
    try {
      const value = host.get('openvikingMemory')
      return value && typeof value === 'object' ? (value as OpenVikingMemoryRuntime) : null
    } catch {
      return null
    }
  }

  const service = new CommitService({
    api,
    memoryRuntime,
    cacheTtlMs: configNumber(config.cacheTtlMs, 2500),
  })

  const recall = new RecallService({
    api,
    commit: service,
    cacheTtlMs: configNumber(config.recallCacheTtlMs, 15000),
  })

  const sessionLog = new SessionLogService({ api, commit: service })

  /** The running app's release, when the web host publishes it. */
  const dshVersion = (): string | null => {
    try {
      const clientModules = host.get('clientModules') as
        | { release?: { version?: unknown } }
        | undefined
      if (typeof clientModules?.release?.version === 'string') return clientModules.release.version
      const app = host.get('app') as { version?: unknown } | undefined
      if (typeof app?.version === 'string') return app.version
    } catch {
      // An optional host service that throws is simply not available.
    }
    return typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION.length > 0
      ? process.env.DSH_VERSION
      : null
  }

  /** Tool names the model can see, when the tool registry exposes them. */
  const listToolNames = (): string[] | null => {
    try {
      const tools = host.get('tools') as
        | { schemas?: (scope?: unknown) => Array<{ name?: unknown }> }
        | undefined
      if (typeof tools?.schemas !== 'function') return null
      const schemas = tools.schemas()
      if (!Array.isArray(schemas)) return null
      return schemas
        .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
        .filter((name) => name.length > 0)
    } catch {
      return null
    }
  }

  const doctor = new DoctorService({
    api,
    commit: service,
    connection,
    origins,
    dshVersion,
    tools: listToolNames,
  })

  const preview = new PreviewService({ api, studioUrl: () => `${connection.endpoint}${studioPath}` })
  const search = new SearchService({ api })
  const catalog = new CatalogService({ api })

  /* ---- v0.5 write/identity/activity services ---------------------------- */

  const audit = new AuditLog()
  const capability = new CapabilityService({ api, transport: () => transportAvailable })
  const sessionControl = new SessionControlService({ api, commit: service })
  const activity = new ActivityService({ api })
  const writeService = new WriteService({
    api,
    capabilities: capability,
    sessions: sessionControl,
    audit,
    identity: identityScope,
    writesEnabled: () => configField(config.enableWrites) === true,
    transport: () => transportAvailable,
    actorPeer: (sessionId) =>
      sessionId === undefined || sessionId.length === 0 ? undefined : service.actorPeer(sessionId),
  })

  /**
   * Audit identity activation and every later switch (F12: "switching account
   * never silently mixes data" — the trail is how a reviewer can prove what
   * identity a write ran under). Deduplicated by fingerprint, because the
   * resolver may be asked to re-resolve for an unrelated volatile field.
   */
  let lastAuditedFingerprint = ''
  const auditIdentitySwitch = (): void => {
    const scope = identityScope()
    if (scope.fingerprint === lastAuditedFingerprint) return
    const first = lastAuditedFingerprint === ''
    lastAuditedFingerprint = scope.fingerprint
    audit.append({
      kind: 'switch',
      action: first ? 'identity-selected' : 'identity-switched',
      target: scope.endpoint,
      identity: {
        profileId: scope.profileId,
        endpoint: scope.endpoint,
        authMode: scope.authMode,
        account: scope.account,
        user: scope.user,
        peer: scope.peer,
        dshSessionId: null,
      },
      fingerprint: scope.fingerprint,
      confirmation: null,
      preCommit: null,
      postCommit: null,
      requestId: null,
      result: 'ok',
      error: null,
      undo: null,
    })
  }
  recordIdentitySwitch = auditIdentitySwitch
  auditIdentitySwitch()

  const vikingCommand = new VikingCommand({
    api,
    connection,
    commit: service,
    recall,
    doctor,
    preview,
    writes: writeService,
    writesEnabled: () => configField(config.enableWrites) === true,
    identity: identityScope,
    audit,
    dshVersion,
    memoryPluginVersion: readMemoryPluginVersion,
  })

  const configPayload = async (): Promise<ApiResult<EnhanceConfig>> => {
    const health = await api.health()
    const warnings: PluginNotice[] = []
    if (!health.ok) warnings.push({ code: 'unreachable', params: { endpoint: connection.endpoint, error: health.error ?? 'unknown' } })
    if (!memoryRuntime()) {
      warnings.push({ code: 'noMemoryPlugin' })
    }
    const scope = identityScope()
    return {
      ok: true,
      endpoint: connection.endpoint,
      studioUrl: `${connection.endpoint}${studioPath}`,
      version: health.version,
      healthy: health.ok,
      account: connection.account,
      user: connection.user,
      writesEnabled: configField(config.enableWrites) === true,
      activeProfileId: scope.profileId,
      authMode: scope.authMode,
      warnings,
    }
  }

  /**
   * Refuse anything that is not a same-origin request from the loopback
   * interface. These routes are not covered by the DSH web auth gate, and
   * `/diff` returns memory bodies — see `trust-fence.ts` for what each check
   * buys. Read-only is not a reason to skip this: the payload is private.
   */
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' } satisfies ApiResult<never>)
      return false
    }
    if (isTrustedLocalRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' } satisfies ApiResult<never>)
    return false
  }

  /**
   * The v0.4 read-only POST guard: same loopback + same-origin fence as every
   * GET, and the body rules live in `readReadOnlyJsonBody` (JSON content type,
   * 64 KiB cap). Only the documented read-only routes use this; a future write
   * route must add its own admission, which is the point.
   */
  const guardPost = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' } satisfies ApiResult<never>)
      return false
    }
    if (isTrustedLocalRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' } satisfies ApiResult<never>)
    return false
  }

  /** Read one guarded POST body, answering the refusal itself. */
  const readPostBody = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | null> => {
    const body = await readReadOnlyJsonBody(req)
    if (!body.ok) {
      const status = body.error === 'content-type' ? 415 : body.error === 'too-large' ? 413 : 400
      writeJson(res, status, { ok: false, error: body.error } satisfies ApiResult<never>)
      return null
    }
    if (!isJsonObject(body.value)) {
      writeJson(res, 400, { ok: false, error: 'invalid-body' } satisfies ApiResult<never>)
      return null
    }
    return body.value
  }

  /** A finite, bounded integer query parameter. */
  const limitParam = (params: URLSearchParams, name: string, fallback: number, max: number): number => {
    const raw = Number(params.get(name) ?? fallback)
    return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), max) : fallback
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        writeJson(res, 200, await configPayload())
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        // The configuration form's "test" button: it sends whatever the user has
        // typed, so the endpoint is checked before anything is fetched. Loopback
        // only — without that this route would be a general-purpose URL fetcher
        // for anyone who can reach the plugin's port.
        const candidate = parseLoopbackEndpoint(query(req).get('endpoint') ?? '')
        if (candidate === null) {
          writeJson(res, 400, {
            ok: false,
            error: 'endpoint-not-loopback',
          } satisfies ApiResult<never>)
          return
        }
        // The key is the one already in force, never the staged edit: a secret in
        // a query string ends up in logs.
        const health = await new OpenVikingApi({
          endpoint: candidate.origin,
          apiKey: connection.apiKey,
          account: connection.account,
          user: connection.user,
        }).health()
        writeJson(res, 200, { ok: true, reachable: health.ok, version: health.version, error: health.error })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const sessionId = query(req).get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        try {
          const status = await service.status(sessionId, { fresh: query(req).get('fresh') === '1' })
          writeJson(res, 200, { ok: true, status })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/commits`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const sessionId = query(req).get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        try {
          // `summaries` bounds the timeline's fan-out: the popover asks for
          // TIMELINE_DEFAULT on its poll and for more only when the user expands.
          const requested = Number(query(req).get('summaries') ?? TIMELINE_DEFAULT)
          const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 0), TIMELINE_MAX) : TIMELINE_DEFAULT
          // A user-triggered refresh (opening the popover, returning to the tab)
          // skips the short status cache; ordinary polling keeps it.
          const fresh = query(req).get('fresh') === '1'
          const { status, tasks, summaries } = await service.commits(sessionId, limit, { fresh })
          writeJson(res, 200, { ok: true, status, tasks, summaries })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/diff`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const sessionId = params.get('sessionId') ?? ''
        const archiveUri = params.get('archive') ?? ''
        if (!sessionId || !archiveUri) {
          writeJson(res, 400, { ok: false, error: 'sessionId and archive are required' } satisfies ApiResult<never>)
          return
        }
        const ovSessionId = service.ovSessionId(sessionId)
        if (!isArchiveUriForSession(archiveUri, ovSessionId)) {
          writeJson(res, 400, { ok: false, error: 'archive is not part of this session history' } satisfies ApiResult<never>)
          return
        }
        try {
          const diff = await service.diff(sessionId, archiveUri)
          if (!diff) {
            // Not an error: the archive exists but extraction has not written
            // the diff yet. The UI shows this as "extracting…".
            writeJson(res, 200, { ok: true, diff: null, pending: true })
            return
          }
          writeJson(res, 200, { ok: true, diff, pending: false })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/recall`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const sessionId = params.get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        try {
          // `query` is absent for the session's own last prompt; `limit` bounds
          // each bucket, so a crafted request cannot ask for the whole library.
          const requested = Number(params.get('limit') ?? RECALL_DEFAULT_LIMIT)
          const limit = Number.isFinite(requested) ? requested : RECALL_DEFAULT_LIMIT
          const payload = await recall.recall(sessionId, params.get('query') ?? undefined, limit, {
            fresh: params.get('fresh') === '1',
          })
          writeJson(res, 200, { ok: true, recall: payload })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/recall/explain`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const sessionId = params.get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        const requested = params.get('source')
        const source =
          requested === 'turn' || requested === 'session' || requested === 'manual' ? requested : undefined
        try {
          const explanation = await recall.explain(sessionId, params.get('query') ?? undefined, {
            fresh: params.get('fresh') === '1',
            ...(source === undefined ? {} : { source }),
          })
          writeJson(res, 200, { ok: true, explanation })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/session-log`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const sessionId = params.get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        try {
          const log = await sessionLog.log(sessionId, { fresh: params.get('fresh') === '1' })
          writeJson(res, 200, { ok: true, log })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/doctor`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const sessionId = params.get('sessionId') ?? undefined
        try {
          const report = await doctor.report(sessionId, { probe: params.get('probe') === '1' })
          writeJson(res, 200, { ok: true, report })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/recall/content`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const uri = query(req).get('uri') ?? ''
        if (!uri) {
          writeJson(res, 400, { ok: false, error: 'uri is required' } satisfies ApiResult<never>)
          return
        }
        try {
          // The reader refuses anything that is not a `viking://` path, so this
          // route cannot be turned into a file read of the host.
          const content = await recall.content(uri)
          if ('error' in content) {
            writeJson(res, 200, { ok: false, error: content.error })
            return
          }
          writeJson(res, 200, { ok: true, content })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    /* ---- v0.4 read-only routes ---------------------------------------- */
    {
      kind: 'exact',
      path: `${API_PREFIX}/preview`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const uri = (query(req).get('uri') ?? '').trim()
        if (uri.length === 0) {
          writeJson(res, 400, { ok: false, error: 'uri is required' } satisfies ApiResult<never>)
          return
        }
        try {
          // One request returns stat + L0/L1/L2; the panel never fans out.
          writeJson(res, 200, { ok: true, preview: await preview.preview(uri) })
        } catch (error) {
          if (error instanceof PreviewFailure) {
            // A bad URI is a caller error; "not found"/"unreadable" are answers
            // the panel renders in place. Neither is a throw.
            const status = error.code === 'not-a-viking-path' ? 400 : 200
            writeJson(res, status, {
              ok: false,
              error: error.code === 'unreadable' ? error.message : error.code,
            } satisfies ApiResult<never>)
            return
          }
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/search`,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        const body = await readPostBody(req, res)
        if (body === null) return
        const text = typeof body.query === 'string' ? body.query : ''
        if (text.trim().length === 0) {
          writeJson(res, 400, { ok: false, error: 'query is required' } satisfies ApiResult<never>)
          return
        }
        const buckets = Array.isArray(body.buckets)
          ? body.buckets.filter((bucket): bucket is string => typeof bucket === 'string')
          : undefined
        try {
          const payload = await search.search({
            query: text,
            ...(typeof body.searchType === 'string' ? { searchType: body.searchType } : {}),
            ...(buckets === undefined ? {} : { buckets }),
            ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
          })
          writeJson(res, 200, { ok: true, search: payload })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/rules/search`,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        const body = await readPostBody(req, res)
        if (body === null) return
        const taskContext = typeof body.taskContext === 'string' ? body.taskContext : ''
        if (taskContext.trim().length === 0) {
          writeJson(res, 400, { ok: false, error: 'taskContext is required' } satisfies ApiResult<never>)
          return
        }
        try {
          writeJson(res, 200, { ok: true, rules: await catalog.searchRules(taskContext) })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/rules`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, list: await catalog.listRules() })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/skills`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, catalogue: await catalog.listSkills() })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/experience`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const kind = normalizeExperienceKind(params.get('kind') ?? undefined)
        const experienceUri = (params.get('experienceUri') ?? params.get('uri') ?? '').trim() || undefined
        const limit = limitParam(params, 'limit', 20, 100)
        try {
          writeJson(res, 200, {
            ok: true,
            experience: await catalog.experience(kind, experienceUri, limit),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) } satisfies ApiResult<never>)
        }
      },
    },
  ]

  /* ======================================================================
   * v0.5 read routes + the authenticated mutation transport
   * ==================================================================== */

  /** An `OveResult` failure, with the design's envelope (a code plus a message). */
  const fail = (res: ServerResponse, status: number, code: string, message: string): void => {
    writeJson(res, status, { ok: false, error: { code, message } } satisfies OveResult<never>)
  }

  /** A caught failure from a v0.5 route: never a throw, never a 500 page. */
  const failFrom = (res: ServerResponse, error: unknown, code = 'rejected-by-server'): void => {
    fail(res, 200, code, error instanceof Error ? error.message : String(error))
  }

  /** The resolved scope: profile, identity, server health and the write gates. */
  const scopePayload = async (fresh: boolean): Promise<ScopePayload> => {
    const snapshot = await capability.probe(fresh)
    const writesEnabled = configField(config.enableWrites) === true
    const transport = transportAvailable
    const scope = identityScope()
    // A named profile that no longer exists must be visible, not silently
    // replaced by the legacy resolution.
    const warnings: PluginNotice[] = []
    const configuredProfile = activeProfileId()
    if (configuredProfile.length > 0 && profileStore.find(configuredProfile) === null) {
      warnings.push({ code: 'profileNotFound', params: { id: configuredProfile } })
    }
    const reason = !writesEnabled
      ? 'writes-disabled'
      : !transport
        ? 'transport-unavailable'
        : !snapshot.health.ok
          ? 'profile-unhealthy'
          : scope.authMode === null
            ? 'identity-unknown'
            : null
    return {
      identity: scope,
      activeProfileId: resolvedIdentity.profileId,
      role: snapshot.health.role,
      version: snapshot.health.version,
      healthy: snapshot.health.ok,
      writes: { enabled: writesEnabled, transport, reason },
      capabilities: scopeCapabilities(snapshot, transport, writesEnabled),
      warnings,
      observedAt: new Date(snapshot.observedAt).toISOString(),
    }
  }

  /** The redacted profile list; the runtime config value wins over the file header. */
  const profilesPayload = (): ProfilesPayload => {
    const payload = profileStore.describe()
    const configured = activeProfileId()
    if (configured.length === 0) return payload
    const exists = payload.profiles.some((profile) => profile.id === configured)
    return { ...payload, activeProfileId: exists ? configured : null }
  }

  /** A profile save/delete response body from a store outcome. */
  const profileWriteResult = (
    outcome: { ok: true; profiles: ProfileSummary[] } | { ok: false; code: string; message: string },
  ): OveResult<{ profiles: ProfileSummary[] }> => {
    if (!outcome.ok) return { ok: false, error: { code: outcome.code, message: outcome.message } }
    if (outcome.profiles.some((profile) => profile.id === activeProfileId())) resolveActiveIdentity()
    return { ok: true, profiles: outcome.profiles }
  }

  const auditProfile = (action: string, target: string | null, result: 'ok' | 'failed', error: string | null): void => {
    audit.append({
      kind: 'profile',
      action,
      target,
      identity: null,
      fingerprint: null,
      confirmation: null,
      preCommit: null,
      postCommit: null,
      requestId: null,
      result,
      error,
      undo: null,
    })
  }

  /** One read route with the standard guard + error envelope. */
  const readRoute = (
    path: string,
    handler: (params: URLSearchParams) => Promise<OveResult<Record<string, unknown>>>,
  ): WebRoute => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        writeJson(res, 200, await handler(query(req)))
      } catch (error) {
        failFrom(res, error)
      }
    },
  })

  const v05Routes: WebRoute[] = [
    readRoute(`${API_PREFIX}/scope`, async (params) => ({ ok: true, scope: await scopePayload(params.get('fresh') === '1') })),
    {
      kind: 'exact',
      path: `${API_PREFIX}/profiles`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, profiles: profilesPayload() })
        } catch (error) {
          failFrom(res, error)
        }
      },
    },
    readRoute(`${API_PREFIX}/tasks`, async (params) => {
      const list = await activity.tasks({
        ...(params.get('taskType') === null ? {} : { taskType: params.get('taskType') as string }),
        ...(params.get('status') === null ? {} : { status: params.get('status') as string }),
        ...(params.get('cursor') === null ? {} : { cursor: params.get('cursor') as string }),
        limit: limitParam(params, 'limit', ACTIVITY_TASKS_DEFAULT_LIMIT, ACTIVITY_TASKS_MAX_LIMIT),
      })
      const payload: TaskListPayload = list
      return { ok: true, ...payload }
    }),
    readRoute(`${API_PREFIX}/task`, async (params) => {
      const taskId = (params.get('taskId') ?? '').trim()
      if (taskId.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'taskId is required' } }
      const detail = await activity.task(taskId, { events: params.get('events') === '1' })
      if (!detail.ok) return detail
      return { ok: true, task: detail.task }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/task/export`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const taskId = (query(req).get('taskId') ?? '').trim()
        if (taskId.length === 0) {
          fail(res, 400, 'invalid-request', 'taskId is required')
          return
        }
        try {
          const exported = await activity.exportTask(taskId)
          if (!exported.ok) {
            writeJson(res, exported.error.code === 'not-found' ? 404 : 200, exported)
            return
          }
          const body = JSON.stringify(exported.task, null, 2)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${exported.fileName}"`,
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        } catch (error) {
          failFrom(res, error)
        }
      },
    },
    readRoute(`${API_PREFIX}/metrics`, async (params) => {
      const sessionId = (params.get('sessionId') ?? '').trim()
      const metrics = await activity.metrics({
        ...(sessionId.length === 0 ? {} : { sessionId, ovSessionId: service.ovSessionId(sessionId) }),
        fresh: params.get('fresh') === '1',
      })
      return { ok: true, metrics }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/audit`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const limit = limitParam(query(req), 'limit', AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT)
          const payload: AuditPayload = audit.recent(limit)
          writeJson(res, 200, { ok: true, ...payload })
        } catch (error) {
          failFrom(res, error)
        }
      },
    },
    readRoute(`${API_PREFIX}/session-control`, async (params) => {
      const sessionId = (params.get('sessionId') ?? '').trim()
      if (sessionId.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'sessionId is required' } }
      const payload: SessionControlPayload = await sessionControl.read(sessionId)
      return { ok: true, ...payload }
    }),
  ]
  routes.push(...v05Routes)

  /* ---- authenticated mutation routes (decision B) ----------------------- */

  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

  /** Read one bounded JSON object body off a Fetch route; null on any refusal. */
  const readMutationBody = async (request: Request): Promise<Record<string, unknown> | null> => {
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > WRITE_BODY_MAX_BYTES) return null
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > WRITE_BODY_MAX_BYTES) return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** Wrap one mutation handler: POST + JSON + size cap, and no throw ever. */
  const mutation = (
    handler: (body: Record<string, unknown>) => Promise<unknown>,
  ): ((request: Request) => Promise<Response>) => {
    return async (request: Request): Promise<Response> => {
      try {
        if (request.method !== 'POST') {
          return jsonResponse(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        }
        const body = await readMutationBody(request)
        if (body === null) {
          return jsonResponse(400, { ok: false, error: { code: 'invalid-body', message: 'A JSON object body below 64 KiB is required.' } })
        }
        return jsonResponse(200, await handler(body))
      } catch (error) {
        return jsonResponse(200, {
          ok: false,
          error: { code: 'rejected-by-server', message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  const stringField = (body: Record<string, unknown>, name: string): string | undefined =>
    typeof body[name] === 'string' ? (body[name] as string) : undefined

  const stringArrayField = (body: Record<string, unknown>, name: string): string[] | undefined =>
    Array.isArray(body[name]) ? (body[name] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : undefined

  /** The mutation callbacks, registered below when the transport exists. */
  const registerMutationRoutes = (connectionService: HostConnectionLike): Array<() => Promise<void> | void> => {
    const register = connectionService.fetch?.register
    if (typeof register !== 'function') return []
    const disposers: Array<() => Promise<void> | void> = []
    const add = (path: string, handler: (body: Record<string, unknown>) => Promise<unknown>): void => {
      try {
        disposers.push(
          register.call(connectionService.fetch, {
            path,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: mutation(handler),
          }),
        )
      } catch (error) {
        logger?.warn?.(`[openviking-enhance] could not register mutation route ${path}`, error)
      }
    }

    add(`${API_PREFIX}/write/prepare`, async (body) => {
      const action = stringField(body, 'action')
      const target = stringField(body, 'target')
      if (action === undefined || !(WRITE_ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, error: { code: 'invalid-request', message: 'Unknown or missing action.' } }
      }
      if (target === undefined || target.trim().length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'target is required.' } }
      }
      const sessionId = stringField(body, 'sessionId')
      const origin = body.origin === 'command' ? 'command' : 'overlay'
      const tags = stringArrayField(body, 'tags')
      const tagMode = stringField(body, 'tagMode')
      return writeService.prepare({
        action: action as WriteAction,
        target,
        ...(sessionId === undefined ? {} : { sessionId }),
        origin,
        ...(tags === undefined || action !== 'set-tags' ? {} : { tags }),
        ...(tagMode === 'append' || tagMode === 'replace' || tagMode === 'clear' ? { tagMode } : {}),
      })
    })
    add(`${API_PREFIX}/write/execute`, async (body) => {
      const token = stringField(body, 'token')
      if (token === undefined || token.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'token is required.' } }
      }
      const content = typeof body.content === 'string' ? body.content : undefined
      const tags = stringArrayField(body, 'tags')
      const tagMode = stringField(body, 'tagMode')
      const typed = stringField(body, 'typed')
      return writeService.execute({
        token,
        ...(content === undefined ? {} : { content }),
        ...(tags === undefined ? {} : { tags }),
        ...(tagMode === 'append' || tagMode === 'replace' || tagMode === 'clear' ? { tagMode } : {}),
        ...(typed === undefined ? {} : { typed }),
      })
    })
    add(`${API_PREFIX}/write/plan`, async (body) => {
      const undoId = stringField(body, 'undoId')
      if (undoId === undefined || undoId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'undoId is required.' } }
      }
      return writeService.plan({ undoId })
    })
    add(`${API_PREFIX}/write/undo`, async (body) => {
      const undoId = stringField(body, 'undoId')
      if (undoId === undefined || undoId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'undoId is required.' } }
      }
      return writeService.undo({ undoId, confirmExtra: body.confirmExtra === true })
    })
    add(`${API_PREFIX}/task/cancel`, async (body) => {
      const taskId = stringField(body, 'taskId')
      if (taskId === undefined || taskId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'taskId is required.' } }
      }
      const result = await activity.cancel(taskId)
      const scope = identityScope()
      audit.append({
        kind: 'write',
        action: 'cancel-task',
        target: taskId,
        identity: {
          profileId: scope.profileId,
          endpoint: scope.endpoint,
          authMode: scope.authMode,
          account: scope.account,
          user: scope.user,
          peer: scope.peer,
          dshSessionId: null,
        },
        fingerprint: scope.fingerprint,
        confirmation: 'overlay',
        preCommit: null,
        postCommit: null,
        requestId: null,
        result: result.ok ? 'ok' : 'failed',
        error: result.ok ? null : `${result.error.code}: ${result.error.message}`,
        undo: null,
      })
      return result
    })
    add(`${API_PREFIX}/profiles/save`, async (body) => {
      const input = {
        id: stringField(body, 'id') ?? '',
        label: stringField(body, 'label') ?? '',
        endpoint: stringField(body, 'endpoint') ?? '',
        authMode: stringField(body, 'authMode') ?? 'unknown',
        account: stringField(body, 'account') ?? '',
        user: stringField(body, 'user') ?? '',
        peerId: stringField(body, 'peerId') ?? '',
        // Absent key = keep the stored one; an explicit empty string clears.
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      }
      const outcome = profileStore.save(input)
      if (!outcome.ok) {
        auditProfile('save-profile', input.id, 'failed', `${outcome.code}: ${outcome.message}`)
        return { ok: false, error: { code: outcome.code, message: outcome.message } }
      }
      auditProfile('save-profile', input.id, 'ok', null)
      return profileWriteResult(outcome)
    })
    add(`${API_PREFIX}/profiles/delete`, async (body) => {
      const id = stringField(body, 'id') ?? ''
      if (id.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'id is required.' } }
      if (id === activeProfileId()) {
        return {
          ok: false,
          error: { code: 'invalid-request', message: 'Switch to another profile before deleting this one.' },
        }
      }
      const outcome = profileStore.delete(id)
      if (!outcome.ok) {
        auditProfile('delete-profile', id, 'failed', `${outcome.code}: ${outcome.message}`)
        return { ok: false, error: { code: outcome.code, message: outcome.message } }
      }
      auditProfile('delete-profile', id, 'ok', null)
      return { ok: true, profiles: outcome.profiles }
    })
    add(`${API_PREFIX}/profiles/test`, async (body) => {
      const endpoint = (stringField(body, 'endpoint') ?? '').trim().replace(/\/+$/, '')
      if (!isHttpEndpoint(endpoint)) {
        return { ok: false, error: { code: 'invalid-request', message: 'An http(s) endpoint is required.' } }
      }
      // Reachability only: no stored key is sent, so a test never authenticates
      // a candidate endpoint with the active profile's credentials.
      const health = await new OpenVikingApi({ endpoint, apiKey: '', account: 'default', user: 'default' }).health()
      return { ok: true, reachable: health.ok, version: health.version, authMode: health.authMode, error: health.error }
    })
    return disposers
  }

  try {
    host.inject?.(['connection'], (scope) => {
      const connectionService = scope.get('connection') as HostConnectionLike | undefined
      if (connectionService === undefined || typeof connectionService.fetch?.register !== 'function') {
        // Older DSH generations: reads keep working, writes stay disabled with
        // the documented reason. Never fall back to an unauthenticated POST.
        logger?.warn?.('[openviking-enhance] connection.fetch is unavailable; write surfaces stay disabled')
        return
      }
      transportAvailable = true
      const disposers = registerMutationRoutes(connectionService)
      return () => {
        transportAvailable = false
        for (const dispose of disposers.reverse()) {
          try {
            const pending = dispose()
            if (pending !== undefined && typeof (pending as Promise<void>).catch === 'function') {
              ;(pending as Promise<void>).catch(() => {})
            }
          } catch (error) {
            logger?.warn?.('[openviking-enhance] could not release a mutation route', error)
          }
        }
      }
    })
  } catch (error) {
    logger?.warn?.('[openviking-enhance] authenticated connection service unavailable', error)
  }

  host.effect(() => {
    const disposers = routes.map((route) => host.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'openviking-enhance: http routes')

  /**
   * F6: the `/viking` command.
   *
   * Two guardrails, because a host plugin that fails to activate takes the whole
   * profile down:
   *
   *  1. registration happens inside `ctx.inject(['commands'], …)`, so a
   *     composition without the command registry mounts everything else and
   *     simply has no `/viking` — reaching for `ctx.commands` directly would
   *     throw at activation;
   *  2. the `enableCommands` switch is applied in both directions: off at
   *     startup never registers. A settings save is applied again on the next
   *     plugin apply (the normal save/reload path), and additionally takes
   *     effect live when the Loader emits `loader/volatile-update`; an older
   *     Loader that emits no such event simply uses the apply/restart path.
   *
   * The command itself stays registered while `enableWrites` is off: DSH
   * registers commands whole, not per sub-verb, so the write verbs are gated at
   * invocation time (they refuse with `writes-disabled`) and the help hides them.
   *
   * Any failure here is logged and contained: commands are a convenience, and
   * losing them must not lose the read-only UI.
   */
  const commandDefinition = vikingCommandDefinition(vikingCommand)
  let commandRegistry: CommandRegistryLike | null = null
  let unregisterCommand: (() => void) | null = null
  const commandsEnabled = (): boolean => configField(config.enableCommands) !== false
  const syncCommand = (): void => {
    if (!commandsEnabled()) {
      if (unregisterCommand !== null) {
        const dispose = unregisterCommand
        unregisterCommand = null
        try {
          dispose()
        } catch (error) {
          logger?.warn?.('[openviking-enhance] failed to unregister /viking', error)
        }
      }
      return
    }
    if (commandRegistry === null || unregisterCommand !== null) return
    try {
      unregisterCommand = commandRegistry.register(commandDefinition)
      logger?.info?.('[openviking-enhance] registered /viking (read-only)')
    } catch (error) {
      logger?.warn?.('[openviking-enhance] failed to register /viking', error)
      unregisterCommand = null
    }
  }
  try {
    host.inject?.(['commands'], (scope) => {
      const registry = scope.get('commands') as Partial<CommandRegistryLike> | undefined
      if (registry === undefined || typeof registry.register !== 'function') return
      commandRegistry = registry as CommandRegistryLike
      syncCommand()
      return () => {
        // The service is going away (or being replaced): drop our definition
        // through its own disposer rather than leaving a dead handler behind.
        commandRegistry = null
        if (unregisterCommand !== null) {
          const dispose = unregisterCommand
          unregisterCommand = null
          try {
            dispose()
          } catch {
            // A registry being torn down may already have released it.
          }
        }
      }
    })
  } catch (error) {
    logger?.warn?.('[openviking-enhance] command service unavailable', error)
  }

  let stopVolatileWatch: (() => void) | null = null
  /**
   * A settings save reaches the host here. `activeProfile` re-resolves the
   * connection and invalidates caches; `enableCommands`/`enableWrites` change
   * what the command and the write gates do. Both are live, no restart.
   */
  const onVolatileUpdate = (): void => {
    try {
      resolveActiveIdentity()
    } catch (error) {
      logger?.warn?.('[openviking-enhance] could not re-resolve the active identity', error)
    }
    syncCommand()
  }
  try {
    const stop = host.on?.('loader/volatile-update', onVolatileUpdate)
    if (typeof stop === 'function') stopVolatileWatch = stop
  } catch (error) {
    logger?.warn?.('[openviking-enhance] cannot watch volatile config updates', error)
  }

  host.effect(() => () => {
    stopVolatileWatch?.()
    stopVolatileWatch = null
    if (unregisterCommand !== null) {
      const dispose = unregisterCommand
      unregisterCommand = null
      try {
        dispose()
      } catch {
        // Unloading: best effort.
      }
    }
  }, 'openviking-enhance: /viking command')
}

function normalizeStudioPath(path: string | undefined): string {
  // Belt and braces at the one place that took the whole entry down: its
  // parameter is typed, but a plugin that fails to activate over a settings value
  // is a worse outcome than a default Studio path. Anything that is not a string
  // is treated as unset.
  const raw = (typeof path === 'string' ? path.trim() : '') || '/studio/'
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
