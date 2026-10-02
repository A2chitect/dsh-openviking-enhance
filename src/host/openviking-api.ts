/**
 * Thin, dependency-free client for the OpenViking HTTP API.
 *
 * Only the routes this feature needs are implemented, and every one of them was
 * verified against a live OpenViking 0.4.22 server:
 *
 *   GET /health                                     liveness + version
 *   GET /api/v1/sessions/{id}                       commit state for a session
 *   GET /api/v1/fs/ls?uri=…                         history archive listing
 *   GET /api/v1/content/read?uri=…                  memory_diff.json (JSON *string*)
 *   GET /api/v1/tasks?resource_id=…                 in-flight commit tasks
 *   POST /api/v1/search/search                      session-aware retrieval
 *
 * Design rules:
 *  - every method resolves; nothing throws on a dead server or an HTTP error,
 *    because a plugin route must never take a request (or the host) down;
 *  - request timeouts are mandatory so a hung server cannot wedge the GUI;
 *  - responses come back either bare (`/health`) or enveloped
 *    (`{status, result, error}`) — `unwrap` handles both.
 */
import type { CommitTask } from '../shared/protocol.ts'
import type { OvConnection } from './config.ts'

export interface OvResult<T> {
  ok: boolean
  status: number
  result: T | null
  error: string | null
}

export interface OvSessionMeta {
  session_id: string
  /**
   * Canonical `viking://` path of the session. The server's own answer, so it is
   * the only reliable source for the history directory: a session may live under
   * another user or peer than the identity this plugin reads as.
   */
  uri?: string
  /** Owner of the session; the fallback when `uri` is absent. */
  created_by_user_id?: string
  user?: { account_id?: string; user_id?: string }
  message_count: number
  commit_count: number
  memories_extracted: { total: number; memory_write: number; memory_edit: number }
  last_commit_at: string | null
  last_auto_commit_at?: string | null
  pending_tokens: number
  keep_recent_count?: number
  created_at?: string
  updated_at?: string
}

export interface OvFsEntry {
  uri: string
  size: number
  isDir: boolean
  modTime: string | null
  abstract?: string
}

/** A commit task as the server returns it; the shared shape is what we rely on. */
export type OvCommitTask = CommitTask & { task_type?: string }

interface RequestOptions {
  /** Actor peer for peer-scoped sessions. Omitted when the peer is unknown. */
  actorPeerId?: string | undefined
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8000

export class OpenVikingApi {
  private readonly connection: OvConnection

  /** Plain field assignment: parameter properties cannot be type-stripped. */
  constructor(connection: OvConnection) {
    this.connection = connection
  }

  private headers(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.connection.apiKey) headers.Authorization = `Bearer ${this.connection.apiKey}`
    if (this.connection.account) headers['X-OpenViking-Account'] = this.connection.account
    if (this.connection.user) headers['X-OpenViking-User'] = this.connection.user
    if (options.actorPeerId) headers['X-OpenViking-Actor-Peer'] = options.actorPeerId
    return headers
  }

  /** One request; resolves to a result envelope and never throws. */
  private async request<T>(
    path: string,
    options: RequestOptions = {},
    init: { method?: string; body?: unknown } = {},
  ): Promise<OvResult<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.connection.endpoint}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(options),
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          result: null,
          error: extractError(body) ?? `HTTP ${response.status}`,
        }
      }
      return { ok: true, status: response.status, result: unwrap<T>(body), error: null }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** `/health` answers bare, without the `{status, result}` envelope. */
  async health(): Promise<{ ok: boolean; version: string | null; authMode: string | null; error: string | null }> {
    const response = await this.request<Record<string, unknown>>('/health', { timeoutMs: 4000 })
    if (!response.ok) return { ok: false, version: null, authMode: null, error: response.error }
    const body = response.result
    return {
      ok: body?.healthy === true || body?.status === 'ok',
      version: typeof body?.version === 'string' ? body.version : null,
      authMode: typeof body?.auth_mode === 'string' ? body.auth_mode : null,
      error: null,
    }
  }

  async getSession(ovSessionId: string, options: RequestOptions = {}): Promise<OvResult<OvSessionMeta>> {
    return this.request<OvSessionMeta>(`/api/v1/sessions/${encodeURIComponent(ovSessionId)}`, {
      timeoutMs: 5000,
      ...options,
    })
  }

  /** The identity this client reads as. Only a last-resort path fallback. */
  get user(): string {
    return this.connection.user
  }

  /**
   * List the `history/archive_00N` directories under a session.
   *
   * Takes the session's own `viking://` URI rather than an id: building the path
   * from this client's configured user silently returned nothing for sessions
   * owned by another user or peer, which then looked like "never committed".
   */
  async listHistory(sessionUri: string, options: RequestOptions = {}): Promise<OvResult<OvFsEntry[]>> {
    const uri = `${sessionUri.replace(/\/+$/, '')}/history`
    return this.request<OvFsEntry[]>(`/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`, {
      timeoutMs: 5000,
      ...options,
    })
  }

  /** Commit tasks for one session. Records are pruned over time — not history. */
  async listCommitTasks(ovSessionId: string, options: RequestOptions = {}): Promise<OvResult<OvCommitTask[]>> {
    const query = `task_type=session_commit&resource_id=${encodeURIComponent(ovSessionId)}`
    const response = await this.request<OvCommitTask[] | { items?: OvCommitTask[] }>(
      `/api/v1/tasks?${query}`,
      { timeoutMs: 5000, ...options },
    )
    if (!response.ok) return response as OvResult<OvCommitTask[]>
    const raw = response.result
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
    return { ...response, result: items }
  }

  /**
   * Read a text file out of `viking://`.
   *
   * `content/read` nests the file body inside the envelope, and for JSON files
   * the body is itself a JSON *string* — callers that expect JSON must parse
   * twice (`readJson` below).
   */
  async readText(uri: string, options: RequestOptions = {}): Promise<OvResult<string>> {
    const response = await this.request<unknown>(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      { timeoutMs: 8000, ...options },
    )
    if (!response.ok) return response as OvResult<string>
    return { ...response, result: typeof response.result === 'string' ? response.result : null }
  }

  /** Read a `viking://` file that holds JSON, tolerating the double encoding. */
  async readJson<T>(uri: string, options: RequestOptions = {}): Promise<OvResult<T>> {
    const text = await this.readText(uri, options)
    if (!text.ok || text.result === null) return text as OvResult<T>
    return { ...text, result: parseMaybeDoubleEncoded<T>(text.result) }
  }

  /**
   * Session-aware retrieval — the call the memory plugin itself makes.
   *
   * `session_id` is what makes the answer session-specific: the server applies
   * its own peer penalties and cross-turn de-duplication against that session, so
   * the same query under two sessions legitimately ranks differently. The reply
   * carries every bucket at once plus the server's `query_plan`.
   */
  async search(body: OvSearchRequest, options: RequestOptions = {}): Promise<OvResult<OvSearchResponse>> {
    return this.request<OvSearchResponse>('/api/v1/search/search', { timeoutMs: 12000, ...options }, {
      method: 'POST',
      body,
    })
  }
}

/** One retrieval request. Field names are the server's, snake_case included. */
export interface OvSearchRequest {
  query: string
  /** The `viking://` subtree to rank within. */
  target_uri: string
  limit: number
  /** 0 keeps weak matches visible instead of hiding them behind the default. */
  score_threshold?: number
  session_id?: string
}

/** One retrieved entry, exactly as the server ranks it. */
export interface OvSearchItem {
  uri: string
  score: number
  context_type?: string
  level?: number
  abstract?: string
  tags?: string[]
}

/**
 * A retrieval reply. The three buckets are always present (empty when nothing
 * matched); `query_plan` explains the retrieval and is absent on some servers.
 */
export interface OvSearchResponse {
  memories?: OvSearchItem[]
  resources?: OvSearchItem[]
  skills?: OvSearchItem[]
  total?: number
  query_plan?: { reasoning?: string } & Record<string, unknown>
}

/** Everything OpenViking's `content/read` returns is base64-free text, but the
 * envelope sometimes wraps JSON in a JSON string; parse until it stops or we
 * run out of nesting. */
export function parseMaybeDoubleEncoded<T>(raw: string): T | null {
  let value: unknown = raw
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value !== 'string') break
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return (value ?? null) as T | null
}

/** Pull the `result` field out of an enveloped response, or the body itself. */
function unwrap<T>(body: unknown): T | null {
  if (body === null || typeof body !== 'object') return (body as T) ?? null
  const record = body as Record<string, unknown>
  if ('result' in record) return (record.result as T) ?? null
  return record as T
}

function extractError(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof error === 'string') return error
  return null
}
