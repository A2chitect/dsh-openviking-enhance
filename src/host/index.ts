/**
 * Host half of `dsh-openviking-enhance`.
 *
 * Responsibilities:
 *  1. resolve the local OpenViking connection (same files the CLI reads);
 *  2. expose four read-only JSON routes on the DSH web server for the browser
 *     half — config, commit status, commit list, and one commit's memory diff;
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
import { API_PREFIX, type ApiResult, type EnhanceConfig } from '../shared/protocol.ts'
import { describeConnection, resolveConnection } from './config.ts'
import { CommitService, type OpenVikingMemoryRuntime } from './commit-service.ts'
import { OpenVikingApi } from './openviking-api.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'openviking-enhance'

/** The web server is the only hard requirement; the OpenViking plugin is optional. */
export const inject = ['webServer']

export const Config = z.object({
  /** Override the OpenViking base URL; default comes from `~/.openviking/ovcli.conf`. */
  endpoint: z.string().default(''),
  /** Override the API key (prefer the config file; this is for unusual setups). */
  apiKey: z.string().default(''),
  /** Override the identity the panel reads under. */
  account: z.string().default(''),
  user: z.string().default(''),
  /** Studio path appended to the endpoint when building the iframe URL. */
  studioPath: z.string().default('/studio/'),
  /** Status cache TTL in milliseconds. */
  cacheTtlMs: z.number().default(2500),
})

export interface EnhanceConfigInput {
  endpoint?: string
  apiKey?: string
  account?: string
  user?: string
  studioPath?: string
  cacheTtlMs?: number
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

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
}

/**
 * Guard for the archive parameter: the browser half may only ask for a diff
 * that lives under this session's own history tree. Anything else is refused,
 * so the route cannot be turned into a generic `viking://` file reader.
 */
export function isArchiveUriForSession(uri: string, ovSessionId: string): boolean {
  if (!uri.startsWith('viking://')) return false
  const marker = `/sessions/${ovSessionId}/history/archive_`
  return uri.includes(marker) && !uri.includes('..')
}

export function apply(ctx: Context, config: EnhanceConfigInput = {}): void {
  const host = ctx as unknown as HostContext
  const connection = resolveConnection({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    account: config.account,
    user: config.user,
  })
  const logger = host.logger
  logger?.info?.(`[openviking-enhance] ${JSON.stringify(describeConnection(connection))}`)

  const api = new OpenVikingApi(connection)
  const studioPath = normalizeStudioPath(config.studioPath)

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
    cacheTtlMs: config.cacheTtlMs ?? 2500,
  })

  const configPayload = async (): Promise<ApiResult<EnhanceConfig>> => {
    const health = await api.health()
    const warnings: string[] = []
    if (!health.ok) warnings.push(`OpenViking unreachable at ${connection.endpoint}: ${health.error ?? 'unknown error'}`)
    if (!memoryRuntime()) {
      warnings.push('@openviking/dsh-memory-plugin is not mounted: session ids fall back to "dsh-<session>" and pending-token thresholds are unknown.')
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

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (_req, res) => {
        writeJson(res, 200, await configPayload())
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
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
        const sessionId = query(req).get('sessionId') ?? ''
        if (!sessionId) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' } satisfies ApiResult<never>)
          return
        }
        try {
          const { status, tasks } = await service.commits(sessionId)
          writeJson(res, 200, { ok: true, status, tasks })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/diff`,
      handler: async (req, res) => {
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
  ]

  host.effect(() => {
    const disposers = routes.map((route) => host.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'openviking-enhance: http routes')
}

function normalizeStudioPath(path: string | undefined): string {
  const raw = (path ?? '').trim() || '/studio/'
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
