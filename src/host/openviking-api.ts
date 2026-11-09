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
  /**
   * The server's own error code, when its envelope carries one
   * (`NOT_FOUND`, `INVALID_ARGUMENT`, …). It lets a capability gate tell
   * "this feature does not exist on this server" from "this entry does not
   * exist", which the human-readable message alone cannot.
   */
  errorCode?: string | null
  /** The server's structured error detail, e.g. `{type:"git_ref"}` on a snapshot 404. */
  errorDetails?: unknown
  /**
   * `x-request-id` from the response, when present. Every OpenViking response
   * carries one, which is what correlates a plugin audit entry with the server's
   * own request log (`GET /console/audit`).
   */
  requestId?: string | null
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
  /** Captured, not-yet-committed messages. */
  message_count: number
  /** Every message the server has received, committed or not. */
  total_message_count?: number
  commit_count: number
  memories_extracted: { total: number; memory_write: number; memory_edit: number }
  last_commit_at: string | null
  last_auto_commit_at?: string | null
  last_message_at?: string | null
  pending_tokens: number
  keep_recent_count?: number
  created_at?: string
  updated_at?: string
  llm_token_usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
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

export interface RequestOptions {
  /** Actor peer for peer-scoped sessions. Omitted when the peer is unknown. */
  actorPeerId?: string | undefined
  timeoutMs?: number
  /**
   * Caller-owned cancellation. When it aborts, the in-flight fetch aborts with
   * it, so a cancelled `/viking recall` stops burning requests instead of
   * waiting for the 12–20 s server answer.
   */
  signal?: AbortSignal | undefined
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
    // Auth-mode correction (docs/api-v05.md §5.1): in api_key mode the server
    // derives the identity from the key and ignores identity headers, so they are
    // omitted rather than implying a switch that cannot work. Not-probed keeps
    // the v0.4 behaviour, which is correct for dev/trusted.
    if (this.connection.authMode !== 'api_key') {
      if (this.connection.account) headers['X-OpenViking-Account'] = this.connection.account
      if (this.connection.user) headers['X-OpenViking-User'] = this.connection.user
    }
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
    // Fold the caller's cancellation into the timeout controller: whichever
    // fires first aborts the fetch, and the listener is always removed.
    const external = options.signal
    const cancel = (): void => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', cancel, { once: true })
    }
    try {
      const response = await fetch(`${this.connection.endpoint}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(options),
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const body: unknown = await response.json().catch(() => null)
      const requestId = response.headers.get('x-request-id')
      if (!response.ok) {
        const failure = extractFailure(body)
        return {
          ok: false,
          status: response.status,
          result: null,
          error: failure?.message ?? `HTTP ${response.status}`,
          errorCode: failure?.code ?? null,
          errorDetails: failure?.details ?? null,
          requestId,
        }
      }
      return { ok: true, status: response.status, result: unwrap<T>(body), error: null, errorCode: null, requestId }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', cancel)
    }
  }

  /**
   * `/health` answers bare, without the `{status, result}` envelope.
   *
   * `role`, `account_id` and `user_id` appear only when the request carried
   * credentials (or trusted headers); they are reported as null otherwise, which
   * the scope banner renders as "unknown identity". The optional request options
   * carry the caller's abort signal so a cancelled /viking command stops the
   * probe instead of waiting out its timeout.
   */
  async health(
    options: RequestOptions = {},
  ): Promise<{
    ok: boolean
    version: string | null
    authMode: string | null
    role: string | null
    accountId: string | null
    userId: string | null
    error: string | null
  }> {
    const response = await this.request<Record<string, unknown>>('/health', { timeoutMs: 4000, ...options })
    if (!response.ok) {
      return {
        ok: false,
        version: null,
        authMode: null,
        role: null,
        accountId: null,
        userId: null,
        error: response.error,
      }
    }
    const body = response.result
    return {
      ok: body?.healthy === true || body?.status === 'ok',
      version: typeof body?.version === 'string' ? body.version : null,
      authMode: typeof body?.auth_mode === 'string' ? body.auth_mode : null,
      role: typeof body?.role === 'string' ? body.role : null,
      accountId: typeof body?.account_id === 'string' ? body.account_id : null,
      userId: typeof body?.user_id === 'string' ? body.user_id : null,
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

  /**
   * The newer context face: the same endpoint with `mode: "context"`.
   *
   * This is what `@openviking/dsh-memory-plugin` prefers when the server has it.
   * Unlike the list mode it returns one server-assembled block plus `stats` —
   * quotas, token budget, de-duplication and exclusion accounting — which is
   * exactly what "why did this turn recall these" needs. A legacy server rejects
   * the extra fields; callers fall back to `search()`.
   */
  async searchContext(body: OvContextRequest, options: RequestOptions = {}): Promise<OvResult<OvContextResponse>> {
    return this.request<OvContextResponse>('/api/v1/search/search', { timeoutMs: 20000, ...options }, {
      method: 'POST',
      body,
    })
  }

  /** Server status. `result.user` is the authenticated request's own user. */
  async systemStatus(options: RequestOptions = {}): Promise<OvResult<OvSystemStatus>> {
    return this.request<OvSystemStatus>('/api/v1/system/status', { timeoutMs: 5000, ...options })
  }

  /**
   * Installed skills, capped at one node each.
   *
   * The Doctor only needs the count and a few names, not the whole catalog;
   * `node_limit=1` keeps the answer small even on a large library.
   */
  async listSkills(
    options: RequestOptions & { nodeLimit?: number } = {},
  ): Promise<OvResult<OvSkillList>> {
    const { nodeLimit, ...request } = options
    const limit = Math.min(Math.max(Math.trunc(nodeLimit ?? 1), 1), 1000)
    return this.request<OvSkillList>(`/api/v1/skills?node_limit=${limit}`, {
      timeoutMs: 5000,
      ...request,
    })
  }

  /** Retrieval quality metrics — query count and latency, no memory bodies. */
  async observerRetrieval(options: RequestOptions = {}): Promise<OvResult<OvObserverRetrieval>> {
    return this.request<OvObserverRetrieval>('/api/v1/observer/retrieval?format=json', { timeoutMs: 5000, ...options })
  }

  /** Rules capability probe. The server requires `task_context`; one short one. */
  async rulesSearch(taskContext: string, options: RequestOptions = {}): Promise<OvResult<OvRuleSearch>> {
    return this.request<OvRuleSearch>(
      '/api/v1/rules/search',
      { timeoutMs: 8000, ...options },
      { method: 'POST', body: { task_context: taskContext.slice(0, 2000) } },
    )
  }

  /** `fs/stat` for one `viking://` URI; the capability probe and count read. */
  async fsStat(uri: string, options: RequestOptions = {}): Promise<OvResult<OvFsStat>> {
    return this.request<OvFsStat>(`/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`, {
      timeoutMs: 5000,
      ...options,
    })
  }

  /**
   * L0 (`abstract`) or L1 (`overview`) for one entry.
   *
   * Both accept a file or a directory URI. A file's L0/L1 describes its
   * containing directory, which is the server's own model and what the preview
   * shows verbatim.
   */
  async contentFace(
    uri: string,
    tier: 'abstract' | 'overview',
    options: RequestOptions = {},
  ): Promise<OvResult<string>> {
    const response = await this.request<unknown>(
      `/api/v1/content/${tier}?uri=${encodeURIComponent(uri)}`,
      { timeoutMs: 8000, ...options },
    )
    if (!response.ok) return response as OvResult<string>
    return { ...response, result: typeof response.result === 'string' ? response.result : null }
  }

  /** The entry's context face, tags and memory metadata (`fs/attrs`). */
  async fsAttrs(uri: string, options: RequestOptions = {}): Promise<OvResult<OvFsAttrs>> {
    return this.request<OvFsAttrs>(`/api/v1/fs/attrs?uri=${encodeURIComponent(uri)}`, {
      timeoutMs: 5000,
      ...options,
    })
  }

  /** List one `viking://` directory. Takes either a full URI or a subtree. */
  async listDirectory(uri: string, options: RequestOptions = {}): Promise<OvResult<OvFsListEntry[]>> {
    const response = await this.request<OvFsListEntry[] | { items?: OvFsListEntry[] }>(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`,
      { timeoutMs: 5000, ...options },
    )
    if (!response.ok) return response as OvResult<OvFsListEntry[]>
    const raw = response.result
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
    return { ...response, result: items }
  }

  /** Trajectories produced by commits that read one Experience file. */
  async experienceTrajectories(
    experienceUri: string,
    options: RequestOptions & { limit?: number; offset?: number } = {},
  ): Promise<OvResult<OvExperienceTrajectories>> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 1000)
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0)
    return this.request<OvExperienceTrajectories>(
      `/api/v1/agent-evolution/experiences/trajectories?experience_uri=${encodeURIComponent(experienceUri)}` +
        `&limit=${limit}&offset=${offset}`,
      { timeoutMs: 8000, ...options },
    )
  }

  /** Outcome distribution across the trajectories that read one Experience. */
  async experienceOutcomes(
    experienceUri: string,
    options: RequestOptions = {},
  ): Promise<OvResult<OvExperienceOutcomes>> {
    return this.request<OvExperienceOutcomes>(
      `/api/v1/agent-evolution/experiences/outcomes?experience_uri=${encodeURIComponent(experienceUri)}`,
      { timeoutMs: 8000, ...options },
    )
  }

  /* ---- v0.5: curation writes (F9) ---------------------------------------- */

  /**
   * Replace the body of one `viking://` text file.
   *
   * `wait:false` is deliberate: the semantic/vector refresh runs in the
   * background and the caller verifies with its own read-back; waiting here
   * would block a GUI dialog on indexing. `expected_sha256` is NOT sent — 0.5.3
   * removed the field (`extra="forbid"` would reject it), so the plugin's own
   * read→hash→write→verify choreography is the safety net.
   */
  async writeContent(
    uri: string,
    content: string,
    options: RequestOptions & { mode?: 'replace' | 'append' } = {},
  ): Promise<OvResult<OvWriteResult>> {
    return this.request<OvWriteResult>('/api/v1/content/write', { timeoutMs: 20000, ...options }, {
      method: 'POST',
      body: { uri, content, mode: options.mode ?? 'replace', wait: false },
    })
  }

  /** Delete one file (non-recursive): the only delete the plugin ever issues. */
  async deletePath(uri: string, options: RequestOptions & { recursive?: boolean } = {}): Promise<OvResult<OvDeleteResult>> {
    const query = new URLSearchParams({ uri, recursive: options.recursive === true ? 'true' : 'false' })
    return this.request<OvDeleteResult>(`/api/v1/fs?${query.toString()}`, {
      timeoutMs: 20000,
      ...options,
    }, { method: 'DELETE' })
  }

  /** Replace/append/clear retrieval tags on one entry. */
  async setTags(
    uri: string,
    tags: string[],
    mode: 'replace' | 'append' | 'clear',
    options: RequestOptions = {},
  ): Promise<OvResult<OvSetTagsResult>> {
    return this.request<OvSetTagsResult>('/api/v1/content/set_tags', { timeoutMs: 10000, ...options }, {
      method: 'POST',
      body: { uri, tags, mode, recursive: false },
    })
  }

  /* ---- v0.5: snapshots, the only content undo (F9) ----------------------- */

  /**
   * Commit the current state of `paths` to the account snapshot repository.
   *
   * Non-ROOT identities **must** pass `paths`; an empty array is a no-op scope,
   * so callers always name at least the target. `noop` still returns the current
   * HEAD, which is a valid restore point — that is why the plugin treats a
   * returned `commit_oid` as the foundation of every undoable action.
   */
  async snapshotCommit(
    message: string,
    paths: string[],
    options: RequestOptions = {},
  ): Promise<OvResult<OvSnapshotCommit>> {
    return this.request<OvSnapshotCommit>('/api/v1/snapshot/commit', { timeoutMs: 30000, ...options }, {
      method: 'POST',
      body: { message, paths },
    })
  }

  /**
   * Restore (or dry-run) a directory scope from one commit.
   *
   * A forward-commit restore: the diff `source_commit → HEAD` inside
   * `project_dir` is written back and a new commit is created on top of HEAD.
   * `dry_run:true` returns the plan and writes nothing — the undo preview.
   */
  async snapshotRestore(
    projectDir: string,
    sourceCommit: string,
    options: RequestOptions & { dryRun?: boolean; message?: string } = {},
  ): Promise<OvResult<OvSnapshotRestore>> {
    return this.request<OvSnapshotRestore>('/api/v1/snapshot/restore', { timeoutMs: 30000, ...options }, {
      method: 'POST',
      body: {
        project_dir: projectDir,
        source_commit: sourceCommit,
        dry_run: options.dryRun === true,
        ...(options.message === undefined ? {} : { message: options.message }),
      },
    })
  }

  /** Snapshot history for one branch/path scope; also the capability probe. */
  async snapshotLog(
    options: RequestOptions & { branch?: string; limit?: number; paths?: string[] } = {},
  ): Promise<OvResult<OvSnapshotLogEntry[]>> {
    const params = new URLSearchParams({
      branch: options.branch ?? 'main',
      limit: String(Math.min(Math.max(Math.trunc(options.limit ?? 1), 1), 100)),
    })
    for (const path of options.paths ?? []) params.append('paths', path)
    return this.request<OvSnapshotLogEntry[]>(`/api/v1/snapshot/log?${params.toString()}`, {
      timeoutMs: 8000,
      ...options,
    })
  }

  /* ---- v0.5: force commit and the task centre (F10/F11) ------------------ */

  /** Archive + extract a session's live messages. Phase 1 is synchronous. */
  async commitSession(
    ovSessionId: string,
    body: { keep_recent_count: number },
    options: RequestOptions = {},
  ): Promise<OvResult<OvCommitSessionResult>> {
    return this.request<OvCommitSessionResult>(
      `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/commit`,
      { timeoutMs: 30000, ...options },
      { method: 'POST', body },
    )
  }

  /** One task, optionally with its execution events. */
  async getTask(
    taskId: string,
    options: RequestOptions & { includeEvents?: boolean } = {},
  ): Promise<OvResult<OvTask>> {
    const suffix = options.includeEvents === true ? '?include_events=true' : ''
    return this.request<OvTask>(`/api/v1/tasks/${encodeURIComponent(taskId)}${suffix}`, {
      timeoutMs: 8000,
      ...options,
    })
  }

  /**
   * A bounded task page.
   *
   * `pagination=cursor` makes the server answer `{items, has_more, next_cursor}`;
   * the non-cursor default returns an array of summaries.
   */
  async listTasks(
    filters: {
      taskType?: string
      status?: string
      resourceId?: string
      limit?: number
      cursor?: string
    } = {},
    options: RequestOptions = {},
  ): Promise<OvResult<OvTaskList | OvTask[]>> {
    const params = new URLSearchParams({
      pagination: 'cursor',
      limit: String(Math.min(Math.max(Math.trunc(filters.limit ?? 20), 1), 200)),
    })
    if (filters.taskType !== undefined && filters.taskType.length > 0) params.set('task_type', filters.taskType)
    if (filters.status !== undefined && filters.status.length > 0) params.set('status', filters.status)
    if (filters.resourceId !== undefined && filters.resourceId.length > 0) params.set('resource_id', filters.resourceId)
    if (filters.cursor !== undefined && filters.cursor.length > 0) params.set('cursor', filters.cursor)
    return this.request<OvTaskList | OvTask[]>(`/api/v1/tasks?${params.toString()}`, {
      timeoutMs: 8000,
      ...options,
    })
  }

  /** Cooperative cancel. Never claims rollback; the server may settle later. */
  async cancelTask(taskId: string, options: RequestOptions = {}): Promise<OvResult<OvTask>> {
    return this.request<OvTask>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      timeoutMs: 8000,
      ...options,
    }, { method: 'POST' })
  }

  /* ---- v0.5: cheap metrics (F11) ---------------------------------------- */

  async dashboardSummary(options: RequestOptions = {}): Promise<OvResult<OvDashboardSummary>> {
    return this.request<OvDashboardSummary>('/api/v1/console/dashboard/summary', { timeoutMs: 5000, ...options })
  }

  async observerQueue(options: RequestOptions = {}): Promise<OvResult<OvObserverQueue>> {
    return this.request<OvObserverQueue>('/api/v1/observer/queue?format=json', { timeoutMs: 5000, ...options })
  }

  async memoryStats(options: RequestOptions = {}): Promise<OvResult<OvMemoryStats>> {
    return this.request<OvMemoryStats>('/api/v1/stats/memories', { timeoutMs: 5000, ...options })
  }

  async sessionStats(sessionId: string, options: RequestOptions = {}): Promise<OvResult<OvSessionStats>> {
    return this.request<OvSessionStats>(
      `/api/v1/stats/sessions/${encodeURIComponent(sessionId)}`,
      { timeoutMs: 5000, ...options },
    )
  }

  /* ---- v0.5: ACL read (read-only "not enabled" state only) --------------- */

  /** The ACL report for a resource URI; resources only, and inert by default. */
  async getAcl(uri: string, options: RequestOptions = {}): Promise<OvResult<OvAclReport>> {
    return this.request<OvAclReport>(`/api/v1/acl?uri=${encodeURIComponent(uri)}`, {
      timeoutMs: 5000,
      ...options,
    })
  }
}

/** One retrieval request. Field names are the server's, snake_case included. */
export interface OvSearchRequest {
  query: string
  /**
   * The `viking://` subtree to rank within. The recall tab always names one; the
   * Explore search leaves it out so the server ranks the whole readable library.
   */
  target_uri?: string | string[]
  limit: number
  /** 0 keeps weak matches visible instead of hiding them behind the default. */
  score_threshold?: number
  session_id?: string
  /** `list` returns the three per-bucket lists; `context` one assembled block. */
  mode?: 'list' | 'context'
  /**
   * `semantic` (the default) or `keywords`. Kept typed because the server accepts
   * both; the Explore surface always asks for semantic, since the live 0.5.3
   * backend rejects keywords with INVALID_ARGUMENT.
   */
  search_type?: 'semantic' | 'keywords'
  /** Restrict to one or more context types. Rules are NOT a valid value. */
  context_type?: string | string[]
}

/**
 * The context-face request body.
 *
 * These names mirror the memory plugin's own request builder (see its
 * `buildContextSearchBody`); every optional field is sent only when the mounted
 * plugin's effective configuration says so. The server owns the mechanics —
 * quotas, tier degradation, cross-turn de-duplication.
 */
export interface OvContextRequest {
  query: string
  mode: 'context'
  purpose?: 'chat' | 'coding'
  score_threshold?: number
  session_id?: string
  dedup_turns?: number
  query_expansion?: 'off' | 'auto'
  events_time_decay_protection?: string
  max_tokens?: number
  quotas?: Record<string, number>
  peer_scope?: 'actor' | 'all'
  exclude_uris?: string[]
  rewrite?: boolean | 'auto'
  rewrite_max_bullets?: number
}

/** One entry in a context-face reply. */
export interface OvContextItem {
  uri: string
  score: number
  category?: string
  detail?: string
  text?: string
  origin?: string
  context_type?: string
  level?: number
  abstract?: string
  tags?: string[]
}

/** The accounting the context face ships beside its entries. */
export interface OvContextStats {
  searched?: Record<string, number>
  candidates?: number
  returned?: number
  dropped?: number
  deduped?: number
  excluded?: number
  max_tokens?: number
  used_tokens?: number
  quotas?: Record<string, number>
  tier_counts?: Record<string, number>
  origins?: Record<string, number>
  peer_scope?: string
  planned_queries?: string[]
  query_expansion?: string
  rewrite?: string
  score_threshold?: number
  dedup?: { turns?: number; status?: string; cooled?: number; turn?: number }
  fill?: Record<string, number>
}

export interface OvContextResponse {
  entries?: OvContextItem[]
  rendered?: string
  digest?: string
  stats?: OvContextStats
}

export interface OvSystemStatus {
  initialized?: boolean
  user?: string
}

export interface OvSkill {
  type?: string
  name?: string
  uri?: string
  root_uri?: string
  skill_md_uri?: string
  description?: string
  tags?: string[]
  allowed_tools?: string[]
}

export interface OvSkillList {
  skills?: OvSkill[]
  root_uris?: string[]
  total?: number
}

export interface OvObserverRetrieval {
  is_healthy?: boolean
  status?: {
    total_queries?: number
    avg_latency_ms?: number
    zero_result_rate?: number
    avg_results_per_query?: number
  }
}

/**
 * One matched rule, exactly as the server returns it.
 *
 * `content` is the complete stored Rule Markdown (YAML frontmatter + body); the
 * host parses the frontmatter, because the fields the tester shows
 * (`applies_when`, `exception`, `status`, `name`) live there and not at the
 * top level.
 */
export interface OvRuleMatch {
  atomic_id?: string
  revision?: number
  scenario_id?: string
  probability?: number
  uri?: string
  content?: string
}

export interface OvRuleSearch {
  rules?: OvRuleMatch[]
  scenarios?: string[]
  rendered?: string
  delivery?: { complete?: boolean; rule_count?: number; rendered_chars?: number }
  scenario_selection?: unknown
  judge?: string
  warning?: string
}

export interface OvFsStat {
  name?: string
  uri?: string
  size?: number
  mode?: number
  modTime?: string
  isDir?: boolean
  isLocked?: boolean
  count?: number
  id?: string
}

/** `fs/attrs`: the entry's context face, tags and memory metadata. */
export interface OvFsAttrs {
  uri?: string
  context_type?: string
  attrs?: {
    tags?: string[]
    memory?: {
      memory_type?: string
      category?: string
      name?: string
      version?: number
      peer_id?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}

/** One trajectory row from the Agent Evolution experience endpoints. */
export interface OvExperienceItem {
  uri?: string
  name?: string
  description?: string
  created_at?: string
  updated_at?: string
}

export interface OvExperienceTrajectories {
  experience_uri?: string
  items?: OvExperienceItem[]
  total?: number
  limit?: number
  offset?: number
  has_more?: boolean
}

export interface OvExperienceOutcomes {
  experience_uri?: string
  outcome_distribution?: Array<{ outcome?: string; count?: number }>
}

/** One entry of a `viking://` directory listing. */
export interface OvFsListEntry {
  uri: string
  size?: number
  isDir?: boolean
  modTime?: string
  abstract?: string
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

export interface OvFailure {
  message: string
  code: string | null
  /** Structured `error.details`, e.g. `{type:"git_ref"}` on a snapshot 404. */
  details: unknown
}

/** The server's error body, when it carries one. */
export function extractFailure(body: unknown): OvFailure | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const recordError = error as Record<string, unknown>
    const message = recordError.message
    if (typeof message === 'string') {
      return {
        message,
        code: typeof recordError.code === 'string' ? recordError.code : null,
        details: recordError.details ?? null,
      }
    }
  }
  if (typeof error === 'string') return { message: error, code: null, details: null }
  // FastAPI's own 404 for a route that does not exist on this version.
  if (typeof record.detail === 'string') return { message: record.detail, code: null, details: null }
  return null
}

/* ========================================================================
 * v0.5 server payloads
 *
 * Field names are the server's own (snake_case). Every optional field is
 * genuinely optional on the wire: the tested range is 0.5.1.1–0.5.3 and the
 * plugin degrades per field rather than failing a whole payload.
 * ===================================================================== */

/** `POST /api/v1/content/write` result. */
export interface OvWriteResult {
  uri?: string
  root_uri?: string
  context_type?: string
  mode?: string
  written_bytes?: number
  content_updated?: boolean
  semantic_status?: string
  vector_status?: string
}

/** `DELETE /api/v1/fs` result. */
export interface OvDeleteResult {
  uri?: string
  estimated_deleted_count?: number
  memory_cleanup?: unknown
}

/** `POST /api/v1/content/set_tags` result. */
export interface OvSetTagsResult {
  uri?: string
  updated_uris?: string[]
  root_uri?: string
  context_type?: string
  tags?: string[]
  mode?: string
  success_count?: number
  skipped_count?: number
  failed_count?: number
  tags_updated?: boolean
}

/** `POST /api/v1/snapshot/commit` result. */
export interface OvSnapshotCommit {
  result?: 'created' | 'noop'
  commit_oid?: string
  changed?: number
  ignored?: number
}

/** The dry-run plan of `POST /api/v1/snapshot/restore`. */
export interface OvSnapshotPlanDiff {
  to_write?: Array<{ path?: string; oid?: string }>
  to_delete?: Array<{ path?: string; oid?: string }>
  unchanged?: unknown[]
}

/** `POST /api/v1/snapshot/restore` result, applied or dry-run. */
export interface OvSnapshotRestore {
  result?: 'applied' | 'dry_run' | 'noop'
  new_commit_oid?: string
  source_commit?: string
  parent_commit?: string
  written?: number
  deleted?: number
  unchanged?: number
  written_paths?: string[]
  deleted_paths?: string[]
  task_id?: string
  head?: string
  source?: string
  diff?: OvSnapshotPlanDiff
}

/** One `GET /api/v1/snapshot/log` entry (git commit metadata). */
export interface OvSnapshotLogEntry {
  oid?: string
  tree?: string
  parents?: string[]
  author?: { name?: string; email?: string; time_seconds?: number; tz_offset_seconds?: number }
  committer?: { name?: string; email?: string; time_seconds?: number; tz_offset_seconds?: number }
  message?: string
}

/** `POST /api/v1/sessions/{id}/commit` result. Phase 2 runs in the background. */
export interface OvCommitSessionResult {
  session_id?: string
  status?: 'accepted' | 'skipped'
  task_id?: string | null
  archive_uri?: string | null
  archived?: boolean
  reason?: string
}

/** One task record; `result` is type-specific and never contains a memory body. */
export interface OvTask {
  task_id?: string
  task_type?: string
  status?: string
  created_at?: number
  updated_at?: number
  processing_seconds?: number
  resource_id?: string | null
  meta?: Record<string, unknown> | null
  stage?: string | null
  result?: Record<string, unknown> | null
  error?: string | null
}

/** `GET /api/v1/tasks?pagination=cursor` shape. */
export interface OvTaskList {
  items?: OvTask[]
  has_more?: boolean
  next_cursor?: string | null
}

/** `GET /api/v1/console/dashboard/summary` result. */
export interface OvDashboardSummary {
  context_counts?: { files?: number; skills?: number; memories?: number; total?: number }
  today_tokens?: { vlm_input?: number; vlm_output?: number; embedding_input?: number; total?: number }
  today_retrievals?: { find?: number; search?: number; total?: number }
}

/** `GET /api/v1/observer/queue?format=json` result. */
export interface OvObserverQueue {
  name?: string
  is_healthy?: boolean
  has_errors?: boolean
  status?: {
    queues?: Array<{
      queue?: string
      pending?: number
      in_progress?: number
      processed?: number
      requeued?: number
      errors?: number
      total?: number
    }>
  }
}

/** `GET /api/v1/stats/memories` result. */
export interface OvMemoryStats {
  total_memories?: number
  by_category?: Record<string, number>
  hotness_distribution?: Record<string, number>
  staleness?: {
    not_accessed_7d?: number
    not_accessed_30d?: number
    oldest_memory_age_days?: number
  }
}

/** `GET /api/v1/stats/sessions/{id}` result. */
export interface OvSessionStats {
  session_id?: string
  total_turns?: number
  memories_extracted?: number
}

/** `GET /api/v1/acl?uri=` result (resources only). */
export interface OvAclReport {
  uri?: string
  acl_mode?: 'inherit' | 'restricted' | string
  direct_entries?: Array<{ principal?: string; level?: string }>
  inherited_entries?: Array<{ principal?: string; level?: string }>
  effective_entries?: Array<{ principal?: string; level?: string }>
}

