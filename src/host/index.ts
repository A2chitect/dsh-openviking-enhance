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
 * It deliberately performs **no writes** to OpenViking and never mutates the
 * third-party memory plugin's objects. The cross-plugin reads are the optional
 * in-process runtime lookups documented in `commit-service.ts` (mounted-ness,
 * per-session peer/config, installed version) plus the read-only pending-queue
 * and capability-memo files under the OpenViking home.
 */
import { createReadStream, statSync, unlinkSync } from 'node:fs'
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
  type OverviewPluginFact,
  OPS_ACTIONS,
  type OpsAction,
  SCOPE_HEADER,
  SCOPE_RESPONSE_HEADER,
  type AclPayload,
  type OfficialPluginFacts,
  type ScopeIdentityRequest,
  type ScopesPayload,
  type SearchPayload,
  type SessionScopePayload,
  type SessionScopeRecord,
  type ScopeCapability,
} from '../shared/protocol.ts'
import {
  ACL_URI_MAX_CHARS,
  FILE_VERSIONS_PAGE,
  SCOPE_KEY_MAX_CHARS,
  OBSERVABILITY_MAX_DAYS,
  SNAPSHOT_DIFF_PATHS_PAGE,
  SNAPSHOT_LOG_MAX,
  SNAPSHOT_LOG_PAGE,
  SNAPSHOT_PATHS_MAX,
  SNAPSHOT_SHOW_MAX_BYTES,
  SCOPE_HEALTH_TIMEOUT_MS,
  TASK_EVIDENCE_MAX_BYTES,
} from '../shared/limits.ts'
import {
  configSourceHealth,
  describeConnection,
  identityFingerprint,
  normalizeEndpoint,
  resolveConnectionForProfile,
  type ConnectionOverrides,
  type ResolvedIdentity,
} from './config.ts'
import { ActivityService, isCancellableTask } from './activity-service.ts'
import { AuditLog } from './audit.ts'
import { CapabilityService, scopeCapabilities } from './capability.ts'
import { MutationGate } from './confirmation-store.ts'
import { SnapshotService } from './snapshot-service.ts'
import { CompileService } from './compile-service.ts'
import { PackDownloadBroker, packHistory } from './pack-service.ts'
import { OpsService, type OpsPrepareRequest } from './ops-service.ts'
import { ObservabilityService } from './observability-service.ts'
import { EvidenceService } from './evidence-service.ts'
import { PLUGIN_VERSION } from '../shared/build-info.ts'
import { ProfileStore, isHttpEndpoint, isProbeableEndpoint, normalizeProfileEndpoint } from './profiles.ts'
import { ScopeStateStore } from './scope-state.ts'
import { ScopeService, type ResolvedScope } from './scope-service.ts'
import { SessionScopeMap } from './session-scope-map.ts'
import { AclService } from './acl-service.ts'
import { compareOfficialPluginFacts, projectOfficialPluginFacts } from './plugin-connection-facts.ts'
import { SessionControlService } from './session-control.ts'
import { WriteService } from './write-service.ts'
import {
  isJsonObject,
  isLoopbackHostname,
  isTrustedLocalRequest,
  readReadOnlyJsonBody,
} from './trust-fence.ts'
import {
  BROWSE_PAGE_SIZE,
  BROWSE_SUBTREE_MAX_LEVELS,
  BROWSE_SUBTREE_MAX_NODES,
  RECENT_COMMITS_SESSION_CAP,
  SESSIONS_PAGE_SIZE,
} from '../shared/limits.ts'
import { CommitService, isArchiveUriForSession, type OpenVikingMemoryRuntime } from './commit-service.ts'
import { OpenVikingApi } from './openviking-api.ts'
import { RecallService } from './recall-service.ts'
import { SessionLogService } from './session-log.ts'
import { DoctorService } from './doctor-service.ts'
import { localStateHealth, readMemoryPluginVersion } from './local-state.ts'
import { CatalogService, normalizeExperienceKind } from './catalog-service.ts'
import { PreviewFailure, PreviewService } from './preview-service.ts'
import { SearchService } from './search-service.ts'
import { BrowseFailure, BrowseService } from './browse-service.ts'
import { SessionsService } from './sessions-service.ts'
import { RecentCommitsService } from './commits-service.ts'
import { StudioStatusService } from './studio-status.ts'
import { OnboardingStore, parseOnboardingUpdate } from './onboarding.ts'
import { OverviewService } from './overview-service.ts'
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
  /**
   * Legacy API-key override.
   *
   * Kept for compatibility (removing it is a breaking change), but marked
   * `role('secret')` so DSH's settings layer treats the value as a secret on
   * remote reads/forms, and documented as the LAST resort: prefer
   * `~/.openviking/ovcli.conf`, the `OPENVIKING_*` environment variables, or a
   * named profile, because saving this field writes the plaintext key into your
   * profile patch.
   */
  apiKey: z.string().default('').role('secret').volatile(),
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
  /**
   * v0.8 master opt-in for operational actions (snapshot create/restore, compile
   * trigger, OVPack export, file-version restore).
   *
   * Defaults to **false**. `enableWrites` stays curation-only (Lead sign-off
   * §2): one switch, one mental model, and reads are always available. The host
   * reads the live value at each prepare/execute; the client reads it for
   * buttons. Every gate fails closed when it is off.
   */
  enableOps: z.boolean().default(false).volatile(),
  /** v0.5 interface switch: the Activity tab (task centre + metrics). */
  enableActivity: z.boolean().default(true).volatile(),
  /** v0.5 interface switch: the scope chip on the composer/panel headers. */
  showScopeBanner: z.boolean().default(true).volatile(),
  /**
   * v0.7 interface switch: the native read cockpit inside the OpenViking panel.
   *
   * Default **true**: the native multi-view page is the point of v0.7. Off
   * renders exactly the v0.6 Studio iframe page, which is the documented
   * backwards-compatible fallback for older DSH generations or a user who only
   * wants Studio. Client-only, like the other `show*` switches.
   */
  showNativeViews: z.boolean().default(true).volatile(),
  /** v0.7 interface switch: the onboarding checklist (Overview card + Plugins Setup card). */
  showOnboarding: z.boolean().default(true).volatile(),
  /**
   * v0.9 interface switch: the cockpit scope menu (the switcher).
   *
   * Default **true**. Off hides only the menu/switcher affordance — the
   * persistent scope banner stays governed by the existing `showScopeBanner`
   * switch, and every dialog/evidence scope block is never hidden (sign-off 6).
   */
  showScopeSwitcher: z.boolean().default(true).volatile(),
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
  enableOps?: ConfigField<boolean>
  enableActivity?: ConfigField<boolean>
  showScopeBanner?: ConfigField<boolean>
  showNativeViews?: ConfigField<boolean>
  showOnboarding?: ConfigField<boolean>
  showScopeSwitcher?: ConfigField<boolean>
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
 * **no** loopback `webServer` POST path that reaches OpenViking: the v0.4 read
 * fence is weaker than an authenticated transport, so raising write authority
 * over it would be a security regression. (v0.7's onboarding-state POST is the
 * one loopback POST; it writes only the plugin's own 0600 state file, is clamped
 * to the documented action vocabulary, and is audited — never OpenViking.)
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

/**
 * v0.9: the per-response scope context installed by the route wrapper.
 *
 * `captured` is the scope key the request started under; `current()` reads the
 * live active key. `writeJson` labels the response with the active key and, if
 * the scope moved while the handler was awaiting an upstream read, answers
 * `scope-changed` instead of returning a payload from the previous scope
 * (design §3.2 "host-side guard": no partial/stale payload ever reaches a client
 * that asked under another key).
 */
interface ScopeResponder {
  /** The identity tuple the request started under (profile/endpoint/account/user/peer). */
  capturedTuple: string
  /**
   * The live scope facts. The stale check compares the identity tuple, not the
   * raw key: the first capability probe refines the probed auth mode and with it
   * the key, which is not a scope change (the identity did not move).
   */
  current: () => { key: string; tuple: string }
}
const SCOPE_RESPONDER = Symbol('openvikingScopeResponder')

/** Refuse only when the identity itself moved, not when the probe refined the key. */
function scopeMoved(capturedTuple: string, current: { key: string; tuple: string }): boolean {
  return capturedTuple !== current.tuple
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const tagged = res as ServerResponse & { [SCOPE_RESPONDER]?: ScopeResponder }
  const responder = tagged[SCOPE_RESPONDER]
  let nextStatus = status
  let nextBody = body
  if (responder !== undefined) {
    const current = responder.current()
    if (scopeMoved(responder.capturedTuple, current)) {
      nextStatus = 409
      nextBody = {
        ok: false,
        error: {
          code: 'scope-changed',
          message: 'The active scope changed while this request was in flight; reload the surface.',
          scopeKey: current.key,
        },
      }
    }
    if (!res.headersSent && typeof res.setHeader === 'function') {
      res.setHeader(SCOPE_RESPONSE_HEADER, current.key)
    }
  }
  const payload = JSON.stringify(nextBody)
  res.writeHead(nextStatus, {
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

  /**
   * The running app's release, when the web host publishes it.
   *
   * Read lazily: it feeds the outbound `User-Agent` (through a client-info
   * callback), the Doctor and `/viking` output, all of which may run before the
   * host has published anything — "unknown" is then correct and honest.
   */
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

  /* ---- v0.5/v0.9 identity + scope (F12 / decision A, extended by v0.9) --- */

  /**
   * The plugin-owned profile file is the credential/server unit of record (0600).
   * A missing or corrupt file is not an error: resolution falls back to the v0.4
   * precedence, so the plugin keeps working on a fresh machine.
   */
  const profileStore = new ProfileStore()
  /**
   * v0.9: the DSH-home last-scope state — the active profile plus the optional
   * in-server identity override (0600, atomic). Secrets never live here.
   */
  const scopeState = new ScopeStateStore()
  const connectionOverrides = (): ConnectionOverrides => ({
    endpoint: configText(config.endpoint),
    apiKey: configText(config.apiKey),
    account: configText(config.account),
    user: configText(config.user),
  })
  const activeProfileId = (): string => configText(config.activeProfile).trim()

  /**
   * The shared mutable connection object.
   *
   * It starts as the legacy v0.4 resolution and is replaced in place by the
   * resolved scope below: every v0.4 service holds a reference to this object, so
   * an identity switch updates every reader at once (the v0.5 mechanism).
   */
  const bootIdentity = resolveConnectionForProfile([], '', connectionOverrides())
  const connection = bootIdentity.connection
  const origins = bootIdentity.origins
  let currentApi = new OpenVikingApi(connection, { dshVersion })

  /**
   * One API instance per active scope, behind a proxy.
   *
   * v0.4's services were constructed with a fixed client; making the proxy the
   * identity seam means a scope switch can swap the underlying client without
   * rebuilding every service (and without stale caches keyed to a previous scope).
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
  /** Assigned once the audit log exists; audits a scope switch with from/to keys. */
  let recordIdentitySwitch: ((previousKey: string, previousLabel: string | null) => void) | null = null
  /**
   * Lazy service refs: the scope authority is constructed before the capability
   * probe and the mutation gate exist, but both are only *called* later, so the
   * indirection keeps activation order simple (a boot-time throw takes the whole
   * plugin down, so no service may depend on a half-initialised peer).
   */
  let capabilityServiceRef: CapabilityService | null = null
  let scopePendingCount = (): number => 0
  let scopeBusy = (): boolean => false
  /**
   * v0.9 review S7: state-file problems that must reach the user instead of being
   * silently overwritten — a failed persist after a switch, and a corrupt
   * `scope-state.json` found at boot (which is *not* rewritten automatically so
   * the Doctor keeps the evidence).
   */
  let scopePersistenceWarning: PluginNotice | null = null
  let scopeStateCorruptAtBoot = false

  /**
   * v0.9: the active-scope authority — boot precedence, identity rules,
   * override persistence, the switch guard and the scope list.
   */
  const scopeService = new ScopeService({
    profiles: profileStore,
    state: scopeState,
    configActiveProfile: activeProfileId,
    configOverrides: connectionOverrides,
    probedAuthMode: () => capabilityServiceRef?.lastSnapshot()?.health.authMode ?? null,
    healthy: () => capabilityServiceRef?.lastSnapshot()?.health.ok ?? true,
    // Review S8: switching needs a *known* healthy snapshot; resolution of an
    // already-stored override keeps the permissive flag above.
    knownHealthy: () => capabilityServiceRef?.lastSnapshot()?.health.ok === true,
    // The scope menu probes each configured server's `/health` only: a cheap
    // liveness read with that profile's own credentials, never `/admin`.
    probe: async (profile) => {
      const started = Date.now()
      try {
        const client = new OpenVikingApi(
          {
            endpoint: normalizeEndpoint(normalizeProfileEndpoint(profile.endpoint)),
            apiKey: profile.apiKey,
            account: profile.account,
            user: profile.user,
            authMode: profile.authMode === 'unknown' ? null : profile.authMode,
          },
          { dshVersion },
        )
        const health = await client.health({ timeoutMs: SCOPE_HEALTH_TIMEOUT_MS })
        return { ok: health.ok, version: health.version, latencyMs: Date.now() - started, error: health.error }
      } catch (error) {
        return { ok: false, version: null, latencyMs: Date.now() - started, error: message(error) }
      }
    },
    activeCapabilities: () => activeCapabilityMatrix(),
    guard: () => ({ pending: scopePendingCount(), busy: scopeBusy(), lastSwitchAt: null }),
  })

  /** The resolved active scope (profile + effective overrides + scope key). */
  let resolvedScope: ResolvedScope = scopeService.resolveActive()
  Object.assign(connection, resolvedScope.connection)
  origins.splice(0, origins.length, ...resolvedScope.origins)
  resolvedScope = { ...resolvedScope, connection, origins }
  currentApi = new OpenVikingApi(connection, { dshVersion })

  /**
   * The active identity, secret-free, with the stable scope key.
   *
   * The key is the v0.5 identity fingerprint (`sha256:` over the profile
   * descriptor + probed auth mode + effective overrides): it contains no secret,
   * so it is safe in chips, dialogs, audit and evidence. Every token/undo/audit
   * entry stores it — which is what makes "a token from the previous identity is
   * refused" work for identity overrides exactly as it does for profiles.
   */
  const identityScope = (): IdentityScope => {
    const probedAuthMode = capabilityServiceRef?.lastSnapshot()?.health.authMode ?? null
    // The API client reads `connection.authMode` for its header policy; refreshing
    // it here means every gate that confirms an identity corrects the headers the
    // next request carries.
    connection.authMode = probedAuthMode ?? resolvedScope.authModeHint
    const fingerprint = identityFingerprint(
      { profileId: resolvedScope.profileId, connection, peerId: resolvedScope.peerId },
      probedAuthMode,
      resolvedScope.authModeHint,
    )
    if (fingerprint !== resolvedScope.scopeKey) resolvedScope = { ...resolvedScope, scopeKey: fingerprint }
    return {
      profileId: resolvedScope.profileId,
      profileLabel: resolvedScope.profileLabel,
      endpoint: connection.endpoint,
      authMode: connection.authMode ?? null,
      account: connection.account,
      user: connection.user,
      peer: resolvedScope.peerId,
      fingerprint,
    }
  }

  /** The live secret-free scope key (the request header/response label). */
  const scopeKeyNow = (): string => identityScope().fingerprint

  /**
   * The identity tuple behind the key: only these fields moving is a real scope
   * change. The probed auth mode (part of the key) is discovered lazily; the
   * first probe must not look like a switch.
   */
  const scopeTupleNow = (): string =>
    JSON.stringify([
      resolvedScope.profileId,
      connection.endpoint,
      connection.account,
      connection.user,
      resolvedScope.peerId,
    ])

  /**
   * The local best-effort DSH-session → scope map: written when a session
   * surface reads under the active scope, so a later switch can warn that this
   * conversation was last seen under another server (sign-off 4). No bodies, no
   * keys, bounded LRU; a missing record means "unknown", never "matches".
   */
  const sessionScopes = new SessionScopeMap()
  const observeSessionScope = (sessionId: string | undefined): void => {
    if (sessionId === undefined || sessionId.length === 0) return
    try {
      const scope = identityScope()
      // "First reads under a scope": once a session is recorded under one scope,
      // a read under a *different* scope must not overwrite the record — the
      // record is the warning source ("this conversation was captured there"),
      // and overwriting it would make the mismatch silently disappear.
      const existing = sessionScopes.get(sessionId)
      if (existing !== null && existing.scopeKey !== scope.fingerprint) return
      sessionScopes.record({
        sessionId,
        scopeKey: scope.fingerprint,
        profileId: scope.profileId,
        label: scope.profileLabel,
        account: scope.account,
        user: scope.user,
        peer: scope.peer,
      })
    } catch {
      // Best effort by design: a full/slow disk must not fail a read.
    }
  }

  /**
   * v0.9 review S5: compare the **identity tuple** recorded for a session, not
   * the raw scope key. The key embeds the lazily probed auth mode, so a record
   * taken before the first probe could otherwise "mismatch" the same identity
   * after a successful probe. The tuple (profile id + effective account/user +
   * peer) is exactly what a person selected.
   */
  const sessionScopeMatches = (record: SessionScopeRecord): boolean =>
    record.profileId === resolvedScope.profileId &&
    record.account === connection.account &&
    record.user === connection.user &&
    record.peer === resolvedScope.peerId

  /** Whether this DSH session was last observed under a different identity. */
  const sessionScopeMismatched = (sessionId: string | undefined): boolean => {
    if (sessionId === undefined || sessionId.trim().length === 0) return false
    const record = sessionScopes.get(sessionId)
    return record !== null && !sessionScopeMatches(record)
  }

  /**
   * v0.9 §3.4: compare the official memory plugin's (allowlisted, secret-free)
   * connection facts with the active scope. Advisory only: a missing projection
   * says "unknown", and this plugin never rewrites the official plugin's config.
   */
  const officialPluginComparison = (): { facts: OfficialPluginFacts | null; pipelineMismatch: boolean } =>
    compareOfficialPluginFacts(projectOfficialPluginFacts(memoryRuntime()), {
      endpoint: connection.endpoint,
      account: connection.account,
      user: connection.user,
      peer: resolvedScope.peerId,
    })

  /** v0.9 §5: read-only ACL/Access proxy; its cache is keyed per scope. */
  const aclService = new AclService({
    api,
    scopeKey: scopeKeyNow,
    serverFacts: () => ({
      version: capabilityServiceRef?.lastSnapshot()?.health.version ?? null,
      role: capabilityServiceRef?.lastSnapshot()?.health.role ?? null,
    }),
  })

  const studioPath = normalizeStudioPath(configText(config.studioPath))

  const memoryRuntime = (): OpenVikingMemoryRuntime | null => {
    try {
      const value = host.get('openvikingMemory')
      return value && typeof value === 'object' ? (value as OpenVikingMemoryRuntime) : null
    } catch {
      return null
    }
  }

  /**
   * v0.7: the mounted official memory plugin's facts for the Overview.
   *
   * Read in-process and read-only: `mounted` from the runtime object and the
   * installed version from its package manifest. No identity/peer fields: the
   * cockpit is root-scoped, so a peer read from an arbitrary session would be
   * misread as the identity's peer (the session-scoped tabs and the Doctor own
   * that display).
   */
  const overviewPluginFact = (): OverviewPluginFact => {
    // No identity fields here on purpose: the cockpit is root-scoped, so any
    // peer read from an arbitrary session would be misread as *the* peer. The
    // per-session peer belongs to the session-scoped tabs and the Doctor.
    return {
      mounted: memoryRuntime() !== null,
      version: memoryRuntime() === null ? null : readMemoryPluginVersion(),
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
    // P1-4: per-file health of every local source (values only, never contents).
    configSources: () => [
      ...configSourceHealth(),
      profileStore.sourceHealth(),
      // v0.9: the last-scope state file is a config source too (corrupt → Doctor).
      scopeState.sourceHealth(),
      ...localStateHealth(),
    ],
  })

  const preview = new PreviewService({ api, studioUrl: () => `${connection.endpoint}${studioPath}` })
  const search = new SearchService({ api })
  const catalog = new CatalogService({ api })

  /* ---- v0.5 write/identity/activity services ---------------------------- */

  const audit = new AuditLog()
  const capability = new CapabilityService({ api, transport: () => transportAvailable })
  capabilityServiceRef = capability
  /**
   * v0.9: the live capability matrix of the **active** scope.
   *
   * Capability matrices are per scope (sign-off 5): this callback is what the
   * scope list reads for the active row, and every switch invalidates the probe
   * (`capability.invalidate()`), so a matrix can never describe a previous
   * server. Inactive rows show their last-known matrix or "probe on switch".
   */
  const activeCapabilityMatrix = (): Record<string, ScopeCapability> => {
    const snapshot = capability.lastSnapshot()
    if (snapshot === null) return {}
    return scopeCapabilities(
      snapshot,
      transportAvailable,
      configField(config.enableWrites) === true,
      configField(config.enableOps) === true,
    )
  }
  const sessionControl = new SessionControlService({ api, commit: service })
  const activity = new ActivityService({ api })

  /* ---- v0.7 native cockpit services ------------------------------------- */

  const browse = new BrowseService({ api, user: () => connection.user })
  const sessions = new SessionsService({ api, user: () => connection.user })
  const recentCommits = new RecentCommitsService({ commit: service, sessions })
  const studioStatus = new StudioStatusService({ studioUrl: () => `${connection.endpoint}${studioPath}` })
  const onboardingStore = new OnboardingStore({})
  /**
   * v0.8: the shared mutation gate. One curation write **or** one operational
   * action may be in flight per profile — the WriteService and OpsService share
   * this single controller, so the one-lock rule spans both (design §2).
   */
  const mutationGate = new MutationGate()
  const writeService = new WriteService({
    api,
    capabilities: capability,
    sessions: sessionControl,
    audit,
    identity: identityScope,
    writesEnabled: () => configField(config.enableWrites) === true,
    transport: () => transportAvailable,
    gate: mutationGate,
    actorPeer: (sessionId) =>
      sessionId === undefined || sessionId.length === 0 ? undefined : service.actorPeer(sessionId),
    // Review B3: the host must enforce the session-scope boundary, not just the UI.
    sessionScopeMismatch: (sessionId) => sessionScopeMismatched(sessionId),
  })

  /* ---- v0.8 Operate services -------------------------------------------- */

  const snapshotService = new SnapshotService({ api, user: () => connection.user })
  const compileService = new CompileService({ api })
  const packBroker = new PackDownloadBroker({ api, audit, identity: identityScope })
  const opsService = new OpsService({
    capabilities: capability,
    snapshot: snapshotService,
    compile: compileService,
    packs: packBroker,
    audit,
    identity: identityScope,
    opsEnabled: () => configField(config.enableOps) === true,
    transport: () => transportAvailable,
    gate: mutationGate,
    activeUser: () => connection.user,
  })
  const observability = new ObservabilityService({ api })
  /** v0.9: the switch guard reads both services' unresolved tokens + the gate. */
  scopePendingCount = () => writeService.unresolvedCount() + opsService.unresolvedCount()
  scopeBusy = () => mutationGate.busy
  const evidence = new EvidenceService({
    api,
    audit,
    activity,
    identity: identityScope,
    build: () => ({
      pluginVersion: PLUGIN_VERSION,
      dshVersion: dshVersion(),
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
    }),
  })

  /**
   * v0.9: the one place a profile/identity change becomes the live scope.
   *
   * Re-resolves profile + overrides, swaps the API client, invalidates the
   * capability probe (clear-all cache fallback: the approved simple path when a
   * per-scope LRU retrofit is too invasive, sign-off 5), clears every service
   * cache, drops one-time downloads, persists the last scope (a profile switch
   * resets the identity overrides) and audits the from/to switch. Ordered so no
   * cache can serve the previous scope's data after the client re-reads `/scope`.
   */
  const applyActiveScope = (): void => {
    // Review S12: one switch at a time; a nested/interleaved switch is refused
    // rather than writing `scope-state.json` from two resolutions.
    if (!scopeService.beginSwitch()) {
      logger?.warn?.('[openviking-enhance] ignored a scope change while another switch was in flight')
      return
    }
    try {
      applyActiveScopeLocked()
    } finally {
      scopeService.endSwitch()
    }
  }

  /** The body of `applyActiveScope`, called while the switching mutex is held. */
  const applyActiveScopeLocked = (): void => {
    const previousKey = resolvedScope.scopeKey
    const previousLabel = resolvedScope.profileLabel
    const next = scopeService.resolveActive()
    Object.assign(connection, next.connection)
    origins.splice(0, origins.length, ...next.origins)
    resolvedScope = { ...next, connection, origins }
    currentApi = new OpenVikingApi(connection, { dshVersion })
    capability.invalidate()
    // v0.4–v0.8 caches are all identity-scoped: an answer read under the previous
    // scope must not survive the switch (approved clear-all fallback).
    service.resetCaches()
    recall.resetCaches()
    browse.resetCaches()
    sessions.resetCaches()
    recentCommits.resetCaches()
    studioStatus.resetCaches()
    overview.resetCaches()
    observability.resetCaches()
    // ACL reports carry principal ids: never cached across scopes.
    aclService.clear()
    // Review B5: the Activity metrics cache holds account-wide aggregates.
    activity.resetCaches()
    // One-time pack downloads are bound to an identity fingerprint.
    packBroker.close()
    // Persist the last scope. `persistProfile` writes `scope-state.json` and
    // resets the identity overrides when the profile actually changed.
    // Review S7: a failed persist must be visible, not swallowed — otherwise a
    // switch looks successful while the next boot falls back to the old scope.
    scopePersistenceWarning = null
    try {
      const persisted = scopeService.persistProfile(resolvedScope.profile?.id ?? '')
      if (!persisted.ok) {
        scopePersistenceWarning = { code: 'scopeStatePersistFailed' }
        logger?.warn?.(`[openviking-enhance] could not persist the active scope: ${persisted.error ?? 'unknown error'}`)
      }
    } catch (error) {
      scopePersistenceWarning = { code: 'scopeStatePersistFailed' }
      logger?.warn?.('[openviking-enhance] could not persist the active scope', error)
    }
    // The double-click cooldown starts here (the client guard reads the clock
    // too; this keeps a same-instant second switch refused host-side).
    scopeService.noteSwitch()
    recordIdentitySwitch?.(previousKey, previousLabel)
  }

  /**
   * Audit identity activation and every later switch (F12: "switching account
   * never silently mixes data" — the trail is how a reviewer can prove what
   * identity a write ran under). Deduplicated by fingerprint, because the
   * resolver may be asked to re-resolve for an unrelated volatile field; v0.9
   * adds the from/to scope keys and labels (a hash and a profile label only).
   */
  let lastAuditedFingerprint = ''
  const auditIdentitySwitch = (previousKey?: string | null, previousLabel?: string | null): void => {
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
      switch: first
        ? null
        : { from: previousKey ?? null, fromLabel: previousLabel ?? null, to: scope.fingerprint, toLabel: scope.profileLabel },
    })
  }
  recordIdentitySwitch = auditIdentitySwitch
  // Boot: remember the resolved last scope and record the activation identity.
  //
  // Review S7: a malformed/wrong-shape `scope-state.json` must NOT be overwritten
  // on boot. Rewriting it would make the Doctor's config-source health report
  // "ok" and destroy the evidence the README promises. The warning rides the
  // scope payload instead; a deliberate user switch may still replace the file.
  const bootStateHealth = scopeState.sourceHealth()
  if (bootStateHealth.state === 'malformed' || bootStateHealth.state === 'wrong-shape') {
    scopeStateCorruptAtBoot = true
    logger?.warn?.(`[openviking-enhance] scope-state.json is ${bootStateHealth.state}; keeping it for the Doctor and falling back`)
  } else {
    try {
      const persisted = scopeService.persistProfile(resolvedScope.profile?.id ?? '')
      if (!persisted.ok) {
        scopePersistenceWarning = { code: 'scopeStatePersistFailed' }
        logger?.warn?.(`[openviking-enhance] could not persist the initial scope: ${persisted.error ?? 'unknown error'}`)
      }
    } catch (error) {
      scopePersistenceWarning = { code: 'scopeStatePersistFailed' }
      logger?.warn?.('[openviking-enhance] could not persist the initial scope', error)
    }
  }
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
      // v0.9: the scope facts the toolbar/banner can render without a second call.
      scopeKey: scope.fingerprint,
      profileLabel: scope.profileLabel,
      peer: scope.peer,
      overrides: resolvedScope.overrides.active,
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

  /**
   * v0.9 §3.3: the readable-root allowlist a search result must stay inside.
   *
   * There is no federated search: every request goes to the active endpoint with
   * the active identity. The URI check is defence in depth against a misconfigured
   * server or a stale cache; the server's ACL remains the real boundary.
   */
  const readableRootPrefixes = (): string[] => [
    'viking://resources',
    'viking://agent',
    `viking://user/${connection.user}`,
  ]
  const isReadableResultUri = (uri: string): boolean => {
    const normalized = uri.trim()
    if (!normalized.startsWith('viking://')) return false
    return readableRootPrefixes().some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
  }
  /** Drop out-of-scope hits and report one bounded warning. */
  const filterCrossScopeResults = (input: SearchPayload): { payload: SearchPayload; dropped: number } => {
    let dropped = 0
    const buckets = input.buckets.map((bucket) => ({
      ...bucket,
      items: bucket.items.filter((item) => {
        if (isReadableResultUri(item.uri)) return true
        dropped += 1
        return false
      }),
    }))
    if (dropped === 0) return { payload: input, dropped: 0 }
    return {
      payload: {
        ...input,
        buckets,
        total: Math.max(0, input.total - dropped),
        warnings: [...input.warnings, { code: 'crossScopeResultDropped', params: { count: dropped } }],
      },
      dropped,
    }
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
        const health = await new OpenVikingApi(
          {
            endpoint: candidate.origin,
            apiKey: connection.apiKey,
            account: connection.account,
            user: connection.user,
          },
          { dshVersion },
        ).health()
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
          // v0.9 review S5: record only after a successful read — a failed read
          // must not claim this scope observed the session.
          observeSessionScope(sessionId)
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
          observeSessionScope(sessionId)
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
          observeSessionScope(sessionId)
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
          observeSessionScope(sessionId)
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
          observeSessionScope(sessionId)
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
          observeSessionScope(sessionId)
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
        const params = query(req)
        try {
          // One request returns stat + L0/L1 plus ONE bounded L2 page; "Show
          // more" asks for the next offset instead of downloading the whole file.
          const offset = params.get('offset') === null ? undefined : Number(params.get('offset'))
          const limit = params.get('limit') === null ? undefined : Number(params.get('limit'))
          writeJson(res, 200, {
            ok: true,
            preview: await preview.preview(uri, {
              ...(Number.isFinite(offset) ? { offset } : {}),
              ...(Number.isFinite(limit) ? { limit } : {}),
            }),
          })
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
          writeJson(res, 200, { ok: true, search: filterCrossScopeResults(payload).payload })
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
          // S2: the capability answer comes from the cached validation-only probe,
          // so opening the section never runs a rule search (embedding/judge work).
          const rulesCapability = await capability.rules()
          writeJson(res, 200, {
            ok: true,
            list: await catalog.listRules({ rulesAvailable: rulesCapability.available }),
          })
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
    if (scopeStateCorruptAtBoot) warnings.push({ code: 'scopeStateCorrupt' })
    if (scopePersistenceWarning !== null) warnings.push(scopePersistenceWarning)
    const reason = !writesEnabled
      ? 'writes-disabled'
      : !transport
        ? 'transport-unavailable'
        : !snapshot.health.ok
          ? 'profile-unhealthy'
          : scope.authMode === null
            ? 'identity-unknown'
            : null
    // v0.8: the Operate switch is separate from enableWrites (curation-only).
    const opsEnabled = configField(config.enableOps) === true
    const opsReason = !opsEnabled
      ? 'ops-disabled'
      : !transport
        ? 'transport-unavailable'
        : !snapshot.health.ok
          ? 'profile-unhealthy'
          : scope.authMode === null
            ? 'identity-unknown'
            : null
    return {
      identity: scope,
      activeProfileId: resolvedScope.profileId,
      role: snapshot.health.role,
      version: snapshot.health.version,
      healthy: snapshot.health.ok,
      writes: { enabled: writesEnabled, transport, reason },
      ops: { enabled: opsEnabled, transport, reason: opsReason },
      capabilities: scopeCapabilities(snapshot, transport, writesEnabled, opsEnabled),
      // v0.9 resolution warnings (missing profile, ignored overrides) are part of
      // the scope block so the chip can never silently show another identity.
      warnings: [...warnings, ...resolvedScope.warnings],
      observedAt: new Date(snapshot.observedAt).toISOString(),
    }
  }

  /**
   * v0.9: build the switcher's full payload (`GET ${API_PREFIX}/scopes`).
   *
   * One cheap `/health` probe per configured profile (cached for
   * `SCOPE_PROBE_TTL_MS`; `fresh=1` forces), the active scope's live capability
   * matrix, the identity-override rules and the advisory official-plugin facts.
   * No `/admin` request is ever made: identity choices come from local profiles.
   */
  const scopesPayload = async (fresh: boolean): Promise<ScopesPayload> => {
    const rows = await scopeService.listScopes({ fresh })
    const scope = identityScope()
    const official = officialPluginComparison()
    const warnings: PluginNotice[] = [...resolvedScope.warnings]
    if (scopeStateCorruptAtBoot) warnings.push({ code: 'scopeStateCorrupt' })
    if (scopePersistenceWarning !== null) warnings.push(scopePersistenceWarning)
    if (!official.pipelineMismatch && official.facts === null) {
      warnings.push({ code: 'officialPluginUnknown' })
    }
    return {
      scopes: rows,
      active: scopeService.scopeInfo(resolvedScope),
      overrides: scopeService.overridesPayload(resolvedScope),
      officialPlugin: official.facts,
      warnings,
      observedAt: new Date().toISOString(),
    }
  }

  /**
   * v0.9: the session-scope mismatch facts for the right-sidebar surfaces.
   *
   * Best effort: a session never observed under a scope has `record: null` and
   * the UI shows the generic active-scope banner. A recorded different scope
   * disables the session's recall/write actions until the user switches back —
   * no cross-scope writes and no silent rebind.
   */
  const sessionScopePayload = (sessionId: string): SessionScopePayload => {
    identityScope()
    const record = sessionScopes.get(sessionId)
    const official = officialPluginComparison()
    // Review S5: compare the identity tuple, not the key (the key embeds the
    // lazily probed auth mode). A record taken before the probe cannot "mismatch"
    // the same identity once the probe lands.
    const mismatch = record !== null && !sessionScopeMatches(record)
    const warnings: PluginNotice[] = []
    if (mismatch) warnings.push({ code: 'sessionScopeMismatch', params: { label: record.label ?? 'unknown' } })
    if (official.pipelineMismatch) warnings.push({ code: 'officialPluginMismatch', params: { host: official.facts?.endpointHost ?? 'unknown' } })
    return {
      sessionId,
      record,
      active: scopeService.scopeInfo(resolvedScope),
      mismatch,
      officialPlugin: official.facts,
      pipelineMismatch: official.pipelineMismatch,
      warnings,
      observedAt: new Date().toISOString(),
    }
  }

  /**
   * The redacted profile list; the boot precedence (Config → scope state → file
   * header) decides the active id, so the settings form and the scope menu can
   * never disagree about which profile is active.
   */
  const profilesPayload = (): ProfilesPayload => {
    const payload = profileStore.describe()
    return { ...payload, activeProfileId: resolvedScope.profileId }
  }

  /** A profile save/delete response body from a store outcome. */
  const profileWriteResult = (
    outcome: { ok: true; profiles: ProfileSummary[] } | { ok: false; code: string; message: string },
  ): OveResult<{ profiles: ProfileSummary[] }> => {
    if (!outcome.ok) return { ok: false, error: { code: outcome.code, message: outcome.message } }
    // Editing the profile the plugin is running under changes its identity: apply
    // the new resolution (and persist/reset overrides) exactly like a switch.
    if (outcome.profiles.some((profile) => profile.id === resolvedScope.profileId)) applyActiveScope()
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
            // v0.9: attachments are labelled too (they are on the fenced GET path).
            'x-dsh-openviking-scope': scopeKeyNow(),
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
      // Review S5: only a successful metrics read records the observation.
      observeSessionScope(sessionId)
      return { ok: true, metrics }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/audit`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const params = query(req)
          const limit = limitParam(params, 'limit', AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT)
          const filter = (name: string): string | undefined => {
            const value = params.get(name)
            return value === null || value.trim().length === 0 ? undefined : value.trim()
          }
          const kind = filter('kind')
          const action = filter('action')
          const taskId = filter('taskId')
          const operationId = filter('operationId')
          const payload: AuditPayload = audit.recent(limit, {
            ...(kind === undefined ? {} : { kind }),
            ...(action === undefined ? {} : { action }),
            ...(taskId === undefined ? {} : { taskId }),
            ...(operationId === undefined ? {} : { operationId }),
          })
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
      observeSessionScope(sessionId)
      return { ok: true, ...payload }
    }),
  ]
  routes.push(...v05Routes)

  /* ======================================================================
   * v0.7 read routes + the local onboarding-state POST
   *
   * Everything here is read-only against OpenViking. The one POST writes ONLY
   * the plugin's own 0600 `onboarding.json` under the DSH state directory: it
   * deliberately rides the same-origin read-only JSON guard (`guardPost` +
   * `readReadOnlyJsonBody`) rather than the authenticated mutation transport,
   * because it is not an OpenViking mutation and must keep working on the
   * read-only DSH generations the native views target. It performs zero
   * OpenViking API calls (a unit test asserts that).
   * ==================================================================== */

  /** The composed Overview: config + scope + metrics + plugin + Studio + onboarding. */
  const configPart = async (): Promise<EnhanceConfig> => {
    const payload = await configPayload()
    if (!payload.ok) throw new Error(payload.error)
    return payload as EnhanceConfig
  }

  const overview = new OverviewService({
    config: configPart,
    scope: scopePayload,
    metrics: (fresh) => activity.metrics({ fresh }),
    plugin: overviewPluginFact,
    studio: (fresh) => studioStatus.status(fresh),
    onboarding: onboardingStore,
    onboardingEnabled: () => configField(config.showOnboarding) !== false,
  })

  /**
   * Cancel an upstream read when the browser collapses/deselects the node.
   *
   * Listens on the RESPONSE's `close`, not the request's: a GET request's stream
   * is complete (and emits `close`) as soon as its headers/body are read, which
   * on a keep-alive socket can be well before the handler finishes, so listening
   * on `req` would abort every read. `res` closes when the response is finished
   * or the connection drops — either way there is no reader left.
   */
  const abortOnClose = (res: ServerResponse): { signal: AbortSignal; dispose: () => void } => {
    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.once('close', onClose)
    return {
      signal: controller.signal,
      dispose: () => {
        try {
          res.off('close', onClose)
        } catch {
          // A finished response cannot be unlistened to on very old Node builds.
        }
      },
    }
  }

  /**
   * Record one local onboarding-state write in the plugin's own audit trail.
   *
   * These actions never reach OpenViking, but "forget the checklist state" is a
   * local mutation a reviewer should be able to see; `identity` stays null on
   * purpose because the state file is per DSH home, not per scope.
   */
  const auditOnboarding = (action: string, writeError: string | null): void => {
    try {
      audit.append({
        kind: 'onboarding',
        action,
        target: null,
        identity: null,
        fingerprint: null,
        confirmation: null,
        preCommit: null,
        postCommit: null,
        requestId: null,
        result: writeError === null ? 'ok' : 'failed',
        error: writeError,
        undo: null,
      })
    } catch {
      // The audit trail is best effort; a failed append must not fail the write.
    }
  }

  /** A zero-or-more bounded integer query parameter (the paging cursor). */
  const offsetParam = (params: URLSearchParams): number => {
    const raw = Number(params.get('offset') ?? 0)
    return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 1_000_000) : 0
  }

  /** Map a browse/session/commit service refusal to the route envelope. */
  const browseFailure = (res: ServerResponse, error: unknown): void => {
    if (error instanceof BrowseFailure) {
      // The client went away (collapsed node, view change): there is no one to
      // answer, and the upstream request has already been aborted.
      if (error.code === 'aborted') return
      fail(res, error.code === 'not-allowed' ? 400 : 200, error.code, error.message)
      return
    }
    failFrom(res, error)
  }

  const v07Routes: WebRoute[] = [
    readRoute(`${API_PREFIX}/overview`, async (params) => {
      const payload = await overview.overview(params.get('fresh') === '1')
      return { ok: true, overview: payload }
    }),
    readRoute(`${API_PREFIX}/browse/roots`, async (params) => {
      const payload = browse.roots(params.get('fresh') === '1')
      return { ok: true, ...payload }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/browse`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const uri = (params.get('uri') ?? '').trim()
        if (uri.length === 0) {
          fail(res, 400, 'invalid-request', 'uri is required')
          return
        }
        const abort = abortOnClose(res)
        try {
          const page = await browse.list(uri, {
            offset: offsetParam(params),
            limit: limitParam(params, 'limit', BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE),
            fresh: params.get('fresh') === '1',
            signal: abort.signal,
          })
          writeJson(res, 200, { ok: true, page })
        } catch (error) {
          browseFailure(res, error)
        } finally {
          abort.dispose()
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/browse/subtree`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const uri = (params.get('uri') ?? '').trim()
        if (uri.length === 0) {
          fail(res, 400, 'invalid-request', 'uri is required')
          return
        }
        const abort = abortOnClose(res)
        try {
          const subtree = await browse.subtree(uri, {
            levels: limitParam(params, 'levels', BROWSE_SUBTREE_MAX_LEVELS, BROWSE_SUBTREE_MAX_LEVELS),
            nodes: limitParam(params, 'nodes', BROWSE_SUBTREE_MAX_NODES, BROWSE_SUBTREE_MAX_NODES),
            signal: abort.signal,
          })
          writeJson(res, 200, { ok: true, subtree })
        } catch (error) {
          browseFailure(res, error)
        } finally {
          abort.dispose()
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const abort = abortOnClose(res)
        try {
          const sessionsPage = await sessions.list({
            offset: offsetParam(params),
            limit: limitParam(params, 'limit', SESSIONS_PAGE_SIZE, SESSIONS_PAGE_SIZE),
            fresh: params.get('fresh') === '1',
            signal: abort.signal,
          })
          writeJson(res, 200, { ok: true, sessions: sessionsPage })
        } catch (error) {
          browseFailure(res, error)
        } finally {
          abort.dispose()
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/recent-commits`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const params = query(req)
        const abort = abortOnClose(res)
        try {
          const recent = await recentCommits.recent({
            limit: limitParam(params, 'limit', RECENT_COMMITS_SESSION_CAP, RECENT_COMMITS_SESSION_CAP),
            fresh: params.get('fresh') === '1',
            signal: abort.signal,
          })
          writeJson(res, 200, { ok: true, recent })
        } catch (error) {
          browseFailure(res, error)
        } finally {
          abort.dispose()
        }
      },
    },
    readRoute(`${API_PREFIX}/studio-status`, async (params) => {
      const studio = await studioStatus.status(params.get('fresh') === '1')
      return { ok: true, studio }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/onboarding/state`,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        const body = await readPostBody(req, res)
        if (body === null) return
        const parsed = parseOnboardingUpdate(body)
        if (!parsed.ok) {
          fail(res, 400, 'invalid-request', parsed.error)
          return
        }
        try {
          // Writes the plugin's own state file only. No OpenViking call, ever.
          const result = onboardingStore.apply(parsed.update)
          auditOnboarding(parsed.update.action, result.writeError)
          writeJson(res, 200, { ok: true, state: result.state, writeError: result.writeError })
        } catch (error) {
          failFrom(res, error)
        }
      },
    },
  ]
  routes.push(...v07Routes)

  /* ======================================================================
   * v0.8 "Operate" read routes + evidence/download GETs
   *
   * All read-only against OpenViking except the two GETs that serve the
   * plugin's own artifacts: the one-time pack download (a capability URL for a
   * temp file this host created) and the task-evidence attachment (an in-memory
   * JSON document). Both are on the loopback+same-origin fence like every read;
   * neither mutates the server.
   * ==================================================================== */

  const v08Routes: WebRoute[] = [
    readRoute(`${API_PREFIX}/snapshot-log`, async (params) => {
      // A read route's `paths` filter is a repeated query parameter: cap it at
      // the documented SNAPSHOT_PATHS_MAX so one request cannot fan out (or be
      // logged) unbounded.
      const paths = params.getAll('paths')
      if (paths.length > SNAPSHOT_PATHS_MAX) {
        return { ok: false, error: { code: 'invalid-scope', message: `At most ${SNAPSHOT_PATHS_MAX} paths may be filtered.` } }
      }
      const payload = await snapshotService.log({
        branch: params.get('branch') ?? 'main',
        paths,
        limit: limitParam(params, 'limit', SNAPSHOT_LOG_PAGE, SNAPSHOT_LOG_MAX),
      })
      return { ok: true, ...payload }
    }),
    readRoute(`${API_PREFIX}/snapshot-show`, async (params) => {
      const ref = (params.get('ref') ?? '').trim()
      if (ref.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'ref is required' } }
      const path = params.get('path')
      const payload = await snapshotService.show({ ref, path: path === null || path.length === 0 ? null : path })
      return { ok: true, ...payload }
    }),
    readRoute(`${API_PREFIX}/snapshot-diff`, async (params) => {
      const path = (params.get('path') ?? '').trim()
      const to = (params.get('to') ?? '').trim()
      if (path.length === 0 || to.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'path and to are required' } }
      }
      const from = params.get('from')
      return { ok: true, ...(await snapshotService.diff({ path, from: from === null ? null : from, to })) }
    }),
    readRoute(`${API_PREFIX}/snapshot-diff-paths`, async (params) => {
      const to = (params.get('to') ?? '').trim()
      const paths = params.getAll('paths')
      if (to.length === 0 || paths.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'paths and to are required' } }
      }
      if (paths.length > SNAPSHOT_PATHS_MAX) {
        return { ok: false, error: { code: 'invalid-scope', message: `At most ${SNAPSHOT_PATHS_MAX} paths may be listed.` } }
      }
      const from = params.get('from')
      return {
        ok: true,
        ...(await snapshotService.diffPaths({
          paths,
          from: from === null ? null : from,
          to,
          offset: offsetParam(params),
          limit: limitParam(params, 'limit', SNAPSHOT_DIFF_PATHS_PAGE, 1000),
        })),
      }
    }),
    readRoute(`${API_PREFIX}/snapshot-versions`, async (params) => {
      const uri = (params.get('uri') ?? '').trim()
      if (uri.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'uri is required' } }
      const beforeVersion = params.get('beforeVersion')
      return {
        ok: true,
        ...(await snapshotService.versions({
          uri,
          limit: limitParam(params, 'limit', FILE_VERSIONS_PAGE, 100),
          beforeVersion: beforeVersion === null || beforeVersion.length === 0 ? null : beforeVersion,
        })),
      }
    }),
    readRoute(`${API_PREFIX}/snapshot-ignore`, async () => ({ ok: true, ...(await snapshotService.ignore()) })),
    readRoute(`${API_PREFIX}/compile`, async (params) => {
      const [capabilities, targets] = await Promise.all([
        compileService.capabilities(),
        compileService.targets({}),
      ])
      // A 0.5.1.1 server has no target registry: the capability still decides the
      // trigger, and the target list says why it is empty.
      void params
      return { ok: true, capabilities, targets }
    }),
    readRoute(`${API_PREFIX}/compile-target`, async (params) => {
      const to = (params.get('to') ?? '').trim()
      if (to.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'to is required' } }
      return { ok: true, ...(await compileService.targetConfig(to)) }
    }),
    readRoute(`${API_PREFIX}/compile-operations`, async (params) => {
      const to = (params.get('to') ?? '').trim()
      if (to.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'to is required' } }
      const cursor = params.get('cursor')
      return {
        ok: true,
        ...(await compileService.operations({
          to,
          cursor: cursor === null || cursor.length === 0 ? null : cursor,
          limit: limitParam(params, 'limit', 20, 100),
        })),
      }
    }),
    readRoute(`${API_PREFIX}/compile-operation`, async (params) => {
      const to = (params.get('to') ?? '').trim()
      const operationId = (params.get('operationId') ?? '').trim()
      if (to.length === 0 || operationId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'to and operationId are required' } }
      }
      return { ok: true, ...(await compileService.operation(to, operationId)) }
    }),
    readRoute(`${API_PREFIX}/compile-outputs`, async (params) => {
      const to = (params.get('to') ?? '').trim()
      const operationId = (params.get('operationId') ?? '').trim()
      if (to.length === 0 || operationId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'to and operationId are required' } }
      }
      const cursor = params.get('cursor')
      return {
        ok: true,
        ...(await compileService.outputs({
          to,
          operationId,
          cursor: cursor === null || cursor.length === 0 ? null : cursor,
          limit: limitParam(params, 'limit', 50, 100),
        })),
      }
    }),
    readRoute(`${API_PREFIX}/compile-submission`, async (params) => {
      const key = (params.get('key') ?? '').trim()
      if (key.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'key is required' } }
      return { ok: true, ...(await compileService.submission(key)) }
    }),
    readRoute(`${API_PREFIX}/observability`, async (params) => {
      const days = limitParam(params, 'days', OBSERVABILITY_MAX_DAYS, OBSERVABILITY_MAX_DAYS)
      const payload = await observability.read(days, params.get('fresh') === '1')
      return { ok: true, ...payload }
    }),
    readRoute(`${API_PREFIX}/pack/history`, async () => {
      // Reading the history is also a natural sweep point: expiry must not wait
      // for the next export/consume to delete an abandoned temp file.
      packBroker.sweep()
      return { ok: true, history: packHistory(audit) }
    }),
    {
      kind: 'exact',
      path: `${API_PREFIX}/task/evidence`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const taskId = (query(req).get('taskId') ?? '').trim()
        if (taskId.length === 0) {
          fail(res, 400, 'invalid-request', 'taskId is required')
          return
        }
        try {
          const exported = await evidence.evidence(taskId)
          if (!exported.ok) {
            writeJson(res, exported.error.code === 'not-found' ? 404 : 200, exported)
            return
          }
          const body = JSON.stringify(exported.evidence, null, 2)
          if (Buffer.byteLength(body, 'utf8') > TASK_EVIDENCE_MAX_BYTES) {
            // The service shrinks to fit; this is a defensive final bound.
            fail(res, 500, 'rejected-by-server', 'The evidence document exceeded its documented cap.')
            return
          }
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
    {
      kind: 'exact',
      path: `${API_PREFIX}/ops/download`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const token = (query(req).get('token') ?? '').trim()
        if (token.length === 0) {
          fail(res, 400, 'invalid-request', 'token is required')
          return
        }
        const download = packBroker.consume(token)
        if (download === null) {
          fail(res, 404, 'download-unavailable', 'This download link expired or was already used; export the pack again.')
          return
        }
        try {
          const file = statSync(download.filePath)
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': file.size,
            'content-disposition': `attachment; filename="${download.fileName}"`,
            'cache-control': 'no-store',
            // Documented binary exception: the stream is labelled but cannot
            // answer a JSON `scope-changed` envelope mid-stream; the one-time
            // token is identity-bound and the broker closes on a switch.
            'x-dsh-openviking-scope': scopeKeyNow(),
          })
          const stream = createReadStream(download.filePath)
          // Delete the one-time temp file exactly once, and only once the
          // response is finished (all bytes handed to the OS) or the client
          // aborted. Deleting on the read stream's own 'end'/'close' raced the
          // response flush; `finish` is the deterministic point where the file
          // is no longer needed and unlinking cannot truncate the download.
          let cleaned = false
          const cleanup = (): void => {
            if (cleaned) return
            cleaned = true
            try {
              unlinkSync(download.filePath)
            } catch {
              // Already gone (sweep/route race) is fine.
            }
          }
          stream.once('error', () => {
            cleanup()
            try {
              res.destroy()
            } catch {
              // The socket may already be gone.
            }
          })
          res.once('finish', cleanup)
          res.once('close', () => {
            // A completed response emits 'finish' first; this branch is the
            // client-abort path (never leave the temp file behind).
            if (!res.writableFinished) cleanup()
          })
          stream.pipe(res)
        } catch (error) {
          packBroker.remove(token)
          failFrom(res, error)
        }
      },
    },
  ]
  routes.push(...v08Routes)

  /* ======================================================================
   * v0.9 "Native II — multi-scope" read routes
   *
   * All read-only: the scope list (health/capability summaries only — never a
   * store read on another server beyond `/health`), the best-effort session-scope
   * facts and the read-only ACL report for one user-selected resource. No admin,
   * account or group endpoint is ever called (tests assert zero `/admin` paths).
   * ==================================================================== */

  const v09Routes: WebRoute[] = [
    readRoute(`${API_PREFIX}/scopes`, async (params) => ({
      ok: true,
      scopes: await scopesPayload(params.get('fresh') === '1'),
    })),
    readRoute(`${API_PREFIX}/session-scope`, async (params) => {
      const sessionId = (params.get('sessionId') ?? '').trim()
      if (sessionId.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'sessionId is required' } }
      // Deliberately does NOT call `observeSessionScope`: reading the mismatch
      // facts must not overwrite the record that produced the warning.
      return { ok: true, sessionScope: sessionScopePayload(sessionId) }
    }),
    readRoute(`${API_PREFIX}/acl`, async (params) => {
      const uri = (params.get('uri') ?? '').trim()
      if (uri.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'uri is required' } }
      if (uri.length > ACL_URI_MAX_CHARS) {
        return { ok: false, error: { code: 'invalid-request', message: 'uri is too long' } }
      }
      const acl: AclPayload = await aclService.report(uri, { fresh: params.get('fresh') === '1' })
      return { ok: true, acl }
    }),
  ]
  routes.push(...v09Routes)

  /* ---- authenticated mutation routes (decision B) ----------------------- */

  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  /** A mutation response, labelled with the scope it settled under (v0.9). */
  const jsonResponse = (status: number, body: unknown, scopeKey?: string): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers:
        scopeKey === undefined ? JSON_HEADERS : { ...JSON_HEADERS, [SCOPE_RESPONSE_HEADER]: scopeKey },
    })

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

  /** The scope-changed error body every scoped refusal uses. */
  const scopeChangedBody = (current: string): OveResult<never> => ({
    ok: false,
    error: {
      code: 'scope-changed',
      message: 'The active scope changed; reload the surface before retrying.',
      details: { scopeKey: current },
    },
  })

  /**
   * Wrap one mutation handler: POST + JSON + size cap, no throw ever, and the
   * v0.9 scope rules.
   *
   * The scope header is checked **before the body is read and before any token
   * lookup**: a mutation prepared under another scope is refused with
   * `scope-changed`, never with a token/identity answer. A mutation that itself
   * changes the scope (identity override, profile CRUD) opts out of the
   * response-time stale check via `allowScopeChange`, because its own new key is
   * the correct label.
   */
  const mutation = (
    handler: (body: Record<string, unknown>) => Promise<unknown>,
    options: { allowScopeChange?: boolean } = {},
  ): ((request: Request) => Promise<Response>) => {
    return async (request: Request): Promise<Response> => {
      try {
        if (request.method !== 'POST') {
          return jsonResponse(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        }
        const capturedTuple = scopeTupleNow()
        const current = scopeKeyNow()
        const requested = (request.headers.get(SCOPE_HEADER) ?? '').trim()
        if (requested.length > 0 && requested !== current) {
          return jsonResponse(409, scopeChangedBody(current), current)
        }
        const body = await readMutationBody(request)
        if (body === null) {
          return jsonResponse(400, { ok: false, error: { code: 'invalid-body', message: 'A JSON object body below 64 KiB is required.' } }, current)
        }
        const result = await handler(body)
        const settledTuple = scopeTupleNow()
        const settled = scopeKeyNow()
        if (options.allowScopeChange !== true && settledTuple !== capturedTuple) {
          return jsonResponse(409, scopeChangedBody(settled), settled)
        }
        return jsonResponse(200, result, settled)
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
    const add = (
      path: string,
      handler: (body: Record<string, unknown>) => Promise<unknown>,
      options: { allowScopeChange?: boolean } = {},
    ): void => {
      try {
        disposers.push(
          register.call(connectionService.fetch, {
            path,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: mutation(handler, options),
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
      const tags = stringArrayField(body, 'tags')
      const tagMode = stringField(body, 'tagMode')
      return writeService.prepare({
        action: action as WriteAction,
        target,
        ...(sessionId === undefined ? {} : { sessionId }),
        // Origin is decided host-side per entry point, never trusted from the
        // body (review S3): these Fetch routes are the dialog/panel surface. The
        // command path calls the service directly with `origin:'command'`.
        origin: 'overlay',
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
    add(`${API_PREFIX}/write/cancel`, async (body) => {
      const token = stringField(body, 'token')
      if (token === undefined || token.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'token is required.' } }
      }
      // Dismissing a dialog releases its pending slot. A token that already
      // settled is an idempotent no-op, so the client can call this blindly.
      return writeService.cancel(token)
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

    /* ---- v0.8 ops mutation family: ONE route family, discriminated action --- */
    add(`${API_PREFIX}/ops/prepare`, async (body) => {
      const action = stringField(body, 'action')
      if (action === undefined || !(OPS_ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, error: { code: 'invalid-request', message: 'Unknown or missing action.' } }
      }
      const list = (name: string): string[] =>
        Array.isArray(body[name]) ? (body[name] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []
      const text = (name: string): string => stringField(body, name) ?? ''
      let request: OpsPrepareRequest
      switch (action as OpsAction) {
        case 'snapshot-create':
          request = { action: 'snapshot-create', message: text('message'), paths: list('paths') }
          break
        case 'snapshot-restore':
          request = { action: 'snapshot-restore', projectDir: text('projectDir'), sourceCommit: text('sourceCommit') }
          break
        case 'compile-run': {
          const instruction = stringField(body, 'instruction')
          const configuredTarget = stringField(body, 'configuredTarget')
          request = {
            action: 'compile-run',
            to: text('to'),
            from: list('from'),
            skill: text('skill'),
            ...(instruction === undefined || instruction.length === 0 ? {} : { instruction }),
            ...(configuredTarget === undefined || configuredTarget.length === 0 ? {} : { configuredTarget }),
          }
          break
        }
        case 'pack-export':
          request = { action: 'pack-export', uri: text('uri'), includeVectors: body.includeVectors === true }
          break
        case 'file-version-restore': {
          const currentVersion = stringField(body, 'currentVersion')
          request = {
            action: 'file-version-restore',
            uri: text('uri'),
            restoreVersion: text('restoreVersion'),
            ...(currentVersion === undefined || currentVersion.length === 0 ? {} : { currentVersion }),
          }
          break
        }
      }
      return opsService.prepare(request)
    })
    add(`${API_PREFIX}/ops/execute`, async (body) => {
      const token = stringField(body, 'token')
      if (token === undefined || token.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'token is required.' } }
      }
      const typed = stringField(body, 'typed')
      return opsService.execute({ token, ...(typed === undefined ? {} : { typed }) })
    })
    add(`${API_PREFIX}/ops/plan`, async (body) => {
      const undoId = stringField(body, 'undoId')
      if (undoId === undefined || undoId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'undoId is required.' } }
      }
      return opsService.plan({ undoId })
    })
    add(`${API_PREFIX}/ops/undo`, async (body) => {
      const undoId = stringField(body, 'undoId')
      if (undoId === undefined || undoId.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'undoId is required.' } }
      }
      return opsService.undo({ undoId, confirmExtra: body.confirmExtra === true })
    })
    add(`${API_PREFIX}/ops/cancel`, async (body) => {
      const token = stringField(body, 'token')
      if (token === undefined || token.length === 0) {
        return { ok: false, error: { code: 'invalid-request', message: 'token is required.' } }
      }
      return opsService.cancel(token)
    })
    /* ---- v0.9: the local identity-override mutation -----------------------
     * A LOCAL plugin mutation: it writes `scope-state.json` (0600), never the
     * OpenViking store. It rides the authenticated transport because it changes
     * mutation authority, and the service refuses it while any curation/ops
     * confirmation is pending. The v0.5 profile switch keeps its existing
     * ConfigForm mechanism; this route is the in-server identity half.
     * -------------------------------------------------------------------- */
    add(`${API_PREFIX}/scope/identity`, async (body) => {
      const request: ScopeIdentityRequest = {}
      if (typeof body.account === 'string') request.account = body.account
      if (typeof body.user === 'string') request.user = body.user
      if (typeof body.peer === 'string') request.peer = body.peer
      if (Array.isArray(body.clear)) {
        request.clear = body.clear.filter(
          (entry): entry is 'account' | 'user' | 'peer' =>
            entry === 'account' || entry === 'user' || entry === 'peer',
        )
      }
      const before = identityScope()
      const outcome = scopeService.switchIdentity(request, resolvedScope)
      if (!outcome.ok) {
        // The refusal is audited as denied: an attempted identity move is exactly
        // the kind of event the trail must be able to explain.
        audit.append({
          kind: 'switch',
          action: 'identity-switch-refused',
          target: connection.endpoint,
          identity: {
            profileId: before.profileId,
            endpoint: before.endpoint,
            authMode: before.authMode,
            account: before.account,
            user: before.user,
            peer: before.peer,
            dshSessionId: null,
          },
          fingerprint: before.fingerprint,
          confirmation: null,
          preCommit: null,
          postCommit: null,
          requestId: null,
          result: 'denied',
          error: `${outcome.code}: ${outcome.message}`,
          undo: null,
          switch: { from: before.fingerprint, fromLabel: before.profileLabel, to: null, toLabel: null },
        })
        return { ok: false, error: { code: outcome.code, message: outcome.message }, scope: before }
      }
      if (!outcome.changed) {
        return {
          ok: true,
          changed: false,
          from: before.fingerprint,
          to: before.fingerprint,
          // Review B1: hand back the full scope payload so the client can adopt
          // the host's answer instead of re-reading `/scope` with a stale key.
          scope: await scopePayload(false),
          scopes: await scopesPayload(false),
          warnings: outcome.warnings,
        }
      }
      // Apply the new scope exactly like a profile switch (caches, API client,
      // persistence, audit from/to), then hand the client the fresh scope list.
      applyActiveScope()
      const after = identityScope()
      return {
        ok: true,
        changed: true,
        from: before.fingerprint,
        to: after.fingerprint,
        scope: await scopePayload(false),
        scopes: await scopesPayload(false),
        warnings: outcome.warnings,
      }
    }, { allowScopeChange: true })

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
    }, { allowScopeChange: true })
    add(`${API_PREFIX}/profiles/delete`, async (body) => {
      const id = stringField(body, 'id') ?? ''
      if (id.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'id is required.' } }
      // Review S6: the runtime Config may be empty while the active profile comes
      // from `scope-state.json`/the profiles header — guard on the *resolved*
      // scope, or deleting it leaves the live connection pointing at nothing.
      if (id === resolvedScope.profileId) {
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
      // Deleting the active profile is refused above; deleting a stale state
      // pointer (state says A, live resolution is legacy because A vanished)
      // still re-resolves so `scope-state.json` and the live scope agree again.
      if (scopeState.read().file.activeProfileId === id) applyActiveScope()
      return { ok: true, profiles: outcome.profiles }
    }, { allowScopeChange: true })
    add(`${API_PREFIX}/profiles/test`, async (body) => {
      const endpoint = (stringField(body, 'endpoint') ?? '').trim().replace(/\/+$/, '')
      if (!isProbeableEndpoint(endpoint)) {
        // Review S9: never become a general URL prober. Link-local/metadata,
        // unspecified, broadcast and multicast targets are refused; loopback and
        // LAN addresses stay allowed because a private server is a supported
        // deployment (see README Requirements for the trade-off).
        return {
          ok: false,
          error: {
            code: 'invalid-request',
            message: 'That endpoint cannot be probed (http(s), non-metadata, non-link-local addresses only).',
          },
        }
      }
      // Reachability only: no stored key is sent, so a test never authenticates
      // a candidate endpoint with the active profile's credentials.
      const health = await new OpenVikingApi(
        { endpoint, apiKey: '', account: 'default', user: 'default' },
        { dshVersion },
      ).health()
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

  host.effect(() => () => {
    // Plugin unload: delete every leftover 0600 pack temp file.
    packBroker.close()
  }, 'openviking-enhance: pack downloads')

  /**
   * v0.9 request admission + response labelling for every plugin HTTP route.
   *
   * A request naming a non-active scope is refused with `scope-changed` before
   * any handler work; a missing header stays allowed for loopback/curl use (the
   * response is still labelled). The response-time stale guard lives in
   * `writeJson`: a composed read that started under scope A and finishes after a
   * switch to B answers `scope-changed` instead of A's payload.
   */
  /**
   * v0.9 review B1: the two **discovery** routes must stay readable with a stale
   * key. The host may already be on a new scope (identity switch, profile switch,
   * another tab) while the client still holds the old key; refusing `/scope`
   * itself with `scope-changed` made the switch chain impossible to complete.
   * They still emit the response label and the regular stale-response guard.
   */
  const SCOPE_DISCOVERY_ROUTES: ReadonlySet<string> = new Set([`${API_PREFIX}/scope`, `${API_PREFIX}/scopes`])
  const scopeAdmitted = (route: WebRoute): WebRoute => ({
    ...route,
    handler: async (req, res) => {
      const active = scopeKeyNow()
      const raw = req.headers[SCOPE_HEADER]
      const requested = Array.isArray(raw) ? raw[0] : raw
      const requestedKey = typeof requested === 'string' ? requested.trim() : ''
      // Review S10: `SCOPE_KEY_MAX_CHARS` is wired here — an over-long header is a
      // caller error, not a scope mismatch to parse.
      if (requestedKey.length > SCOPE_KEY_MAX_CHARS) {
        if (typeof res.setHeader === 'function') res.setHeader(SCOPE_RESPONSE_HEADER, active)
        writeJson(res, 400, {
          ok: false,
          error: { code: 'invalid-scope', message: `The scope header exceeds ${SCOPE_KEY_MAX_CHARS} characters.` },
        } satisfies OveResult<never>)
        return
      }
      const discovery = SCOPE_DISCOVERY_ROUTES.has(route.path)
      if (!discovery && requestedKey.length > 0 && requestedKey !== active) {
        const current = scopeKeyNow()
        if (typeof res.setHeader === 'function') res.setHeader(SCOPE_RESPONSE_HEADER, current)
        writeJson(res, 409, {
          ok: false,
          error: {
            code: 'scope-changed',
            message: 'The requested scope is not the active scope.',
            details: { scopeKey: current },
          },
        } satisfies OveResult<never>)
        return
      }
      ;(res as ServerResponse & { [SCOPE_RESPONDER]?: ScopeResponder })[SCOPE_RESPONDER] = {
        capturedTuple: scopeTupleNow(),
        current: () => ({ key: scopeKeyNow(), tuple: scopeTupleNow() }),
      }
      await route.handler(req, res)
    },
  })
  host.effect(() => {
    const disposers = routes.map((route) => host.webServer.register(scopeAdmitted(route)))
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
      // A settings save can change `activeProfile`: re-resolve the scope, persist
      // it to the DSH home, reset the identity overrides and refresh every cache.
      applyActiveScope()
    } catch (error) {
      logger?.warn?.('[openviking-enhance] could not re-resolve the active scope', error)
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
