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
  API_PREFIX,
  RECALL_DEFAULT_LIMIT,
  TIMELINE_DEFAULT,
  TIMELINE_MAX,
  type ApiResult,
  type EnhanceConfig,
  type PluginNotice,
} from '../shared/protocol.ts'
import { describeConnection, resolveConnection } from './config.ts'
import { isLoopbackHostname, isTrustedLocalRequest } from './trust-fence.ts'
import { CommitService, isArchiveUriForSession, type OpenVikingMemoryRuntime } from './commit-service.ts'
import { OpenVikingApi } from './openviking-api.ts'
import { RecallService } from './recall-service.ts'

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
  logger?: { info?(message: string): void; warn?(message: string, error?: unknown): void }
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
  const connection = resolveConnection({
    endpoint: configText(config.endpoint),
    apiKey: configText(config.apiKey),
    account: configText(config.account),
    user: configText(config.user),
  })
  const logger = host.logger
  logger?.info?.(`[openviking-enhance] ${JSON.stringify(describeConnection(connection))}`)

  const api = new OpenVikingApi(connection)
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

  const configPayload = async (): Promise<ApiResult<EnhanceConfig>> => {
    const health = await api.health()
    const warnings: PluginNotice[] = []
    if (!health.ok) warnings.push({ code: 'unreachable', params: { endpoint: connection.endpoint, error: health.error ?? 'unknown' } })
    if (!memoryRuntime()) {
      warnings.push({ code: 'noMemoryPlugin' })
    }
    return {
      ok: true,
      endpoint: connection.endpoint,
      studioUrl: `${connection.endpoint}${studioPath}`,
      version: health.version,
      healthy: health.ok,
      account: connection.account,
      user: connection.user,
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
          const { status, tasks, summaries } = await service.commits(sessionId, limit)
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
  ]

  host.effect(() => {
    const disposers = routes.map((route) => host.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'openviking-enhance: http routes')
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
