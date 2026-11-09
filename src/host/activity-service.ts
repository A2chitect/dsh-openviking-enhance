/**
 * F11: the task centre and the four cheap metric sources.
 *
 * Everything here is a **read** of endpoints the server already exposes; no
 * route in this module mutates OpenViking except cooperative task cancel, which
 * is deliberately explicit and never claims rollback (completed business writes
 * are not undone by `POST /tasks/{id}/cancel`).
 *
 * Design notes:
 *
 *  - **Task records are not history.** The server prunes terminal tasks (~24 h
 *    completed/cancelled, ~7 days failed), so the tab says "no tasks yet" rather
 *    than pretending to show an archive.
 *  - **Every metric card is independently degradable.** A server without
 *    `/stats/memories` still renders the dashboard card; one failing call never
 *    turns the whole Status section into an error pile.
 *  - **Data is bounded.** The list is one cursor page (max 50), the export is
 *    one task with safe fields only, and the metric cache keeps a refreshing GUI
 *    from hammering a small server.
 */
import {
  ACTIVITY_TASKS_DEFAULT_LIMIT,
  ACTIVITY_TASKS_MAX_LIMIT,
  CANCELLABLE_TASK_TYPES,
  isCancellableStatus,
  type ActivityTask,
  type ActivityTaskDetail,
  type MetricsPayload,
  type OveResult,
  type TaskEvent,
  type TaskListPayload,
  type TaskResultSummary,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvTask } from './openviking-api.ts'

/** Fields of a task that are safe to export: no `meta`, no transcript anything. */
const EXPORTED_TASK_FIELDS = [
  'task_id',
  'task_type',
  'status',
  'created_at',
  'updated_at',
  'processing_seconds',
  'resource_id',
  'stage',
  'error',
] as const

/** `result` keys that are counters/URIs, never content. */
const EXPORTED_RESULT_FIELDS = [
  'session_id',
  'archive_uri',
  'memories_extracted',
  'session_skills_extracted',
  'session_skill_uris',
  'memory_extraction',
  'effective_memory_types',
  'agent_evolution_enabled',
  'token_usage',
  'memory_diff_uri',
  'rules_root',
  'source_uris',
  'plan_reason',
  'batch_count',
  'operations',
  'written_uris',
  'write_result',
] as const

export interface ActivityOptions {
  api: OpenVikingApi
  now?: () => number
  /** Metric cache TTL: the Activity tab refreshes on demand. */
  cacheTtlMs?: number
}

/** One normalized task row; exported so the mapping is unit-testable. */
export function mapTask(raw: OvTask | null | undefined): ActivityTask {
  const result = (raw?.result ?? null) as Record<string, unknown> | null
  const sessionId = typeof result?.session_id === 'string' ? result.session_id : null
  const archiveUri = typeof result?.archive_uri === 'string' ? result.archive_uri : null
  const memoryDiffUri = typeof result?.memory_diff_uri === 'string' ? result.memory_diff_uri : null
  const extracted = result?.memories_extracted
  const extractedRecord =
    extracted !== null && typeof extracted === 'object' ? (extracted as Record<string, unknown>) : null
  const tokenUsage = result?.token_usage
  const totalTokens = readTotalTokens(tokenUsage)
  const memoriesExtracted =
    extractedRecord === null
      ? null
      : {
          total: numberOrNull(extractedRecord.total),
          memoryWrite: numberOrNull(extractedRecord.memory_write),
          memoryEdit: numberOrNull(extractedRecord.memory_edit),
        }
  return {
    taskId: typeof raw?.task_id === 'string' ? raw.task_id : '',
    taskType: typeof raw?.task_type === 'string' ? raw.task_type : 'unknown',
    status: typeof raw?.status === 'string' ? raw.status : 'unknown',
    stage: typeof raw?.stage === 'string' ? raw.stage : null,
    error: typeof raw?.error === 'string' ? raw.error : null,
    createdAt: numberOrNull(raw?.created_at),
    updatedAt: numberOrNull(raw?.updated_at),
    processingSeconds: numberOrNull(raw?.processing_seconds),
    resourceId: typeof raw?.resource_id === 'string' ? raw.resource_id : null,
    resultSummary:
      sessionId === null && archiveUri === null && memoriesExtracted === null && memoryDiffUri === null && totalTokens === null
        ? null
        : { sessionId, archiveUri, memoriesExtracted, memoryDiffUri, totalTokens },
  }
}

/** `token_usage.total.total`, or a direct number when a build flattens it. */
function readTotalTokens(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === null || typeof value !== 'object') return null
  const total = (value as Record<string, unknown>).total
  if (typeof total === 'number') return Number.isFinite(total) ? total : null
  if (total !== null && typeof total === 'object') {
    return numberOrNull((total as Record<string, unknown>).total)
  }
  return null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Normalize `result.execution_events`; null when the task carries none. */
export function mapTaskEvents(raw: OvTask | null | undefined): { events: TaskEvent[] | null; dropped: number | null } {
  const result = (raw?.result ?? null) as Record<string, unknown> | null
  const container = result?.execution_events
  if (container === null || container === undefined || typeof container !== 'object') {
    return { events: null, dropped: null }
  }
  const record = container as Record<string, unknown>
  const items = Array.isArray(record.items) ? record.items : []
  const events: TaskEvent[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const event = item as Record<string, unknown>
    events.push({
      seq: numberOrNull(event.seq) ?? 0,
      recordedAt: numberOrNull(event.recorded_at),
      kind: typeof event.kind === 'string' ? event.kind : 'unknown',
      status: typeof event.status === 'string' ? event.status : null,
      stage: typeof event.stage === 'string' ? event.stage : null,
      operation: typeof event.operation === 'string' ? event.operation : null,
      error: typeof event.error === 'string' ? event.error : null,
    })
  }
  return { events, dropped: numberOrNull(record.dropped_count) }
}

/** The export projection: whitelisted top-level fields + whitelisted result keys. */
export function safeTaskExport(raw: OvTask): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const field of EXPORTED_TASK_FIELDS) {
    const value = (raw as Record<string, unknown>)[field]
    if (value !== undefined) output[field] = value
  }
  const result = raw.result
  if (result !== null && result !== undefined && typeof result === 'object') {
    const record = result as Record<string, unknown>
    const safe: Record<string, unknown> = {}
    for (const field of EXPORTED_RESULT_FIELDS) {
      if (record[field] !== undefined) safe[field] = record[field]
    }
    if (Array.isArray(record.execution_events)) safe.execution_events = record.execution_events
    output.result = safe
  }
  output.exported_at = new Date().toISOString()
  return output
}

export function isCancellableTask(task: ActivityTask): boolean {
  return (CANCELLABLE_TASK_TYPES as readonly string[]).includes(task.taskType) && isCancellableStatus(task.status)
}

export class ActivityService {
  private readonly options: ActivityOptions
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private metricsCache: { at: number; sessionId: string | null; value: MetricsPayload } | null = null

  constructor(options: ActivityOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000
  }

  /** One bounded, optionally filtered task page. */
  async tasks(
    filters: { taskType?: string; status?: string; limit?: number; cursor?: string } = {},
  ): Promise<TaskListPayload> {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? ACTIVITY_TASKS_DEFAULT_LIMIT), 1), ACTIVITY_TASKS_MAX_LIMIT)
    const response = await this.options.api.listTasks({
      ...(filters.taskType === undefined ? {} : { taskType: filters.taskType }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
      limit,
    })
    if (!response.ok) {
      const header = rawPageHeader(response.result)
      // The list route answers either an array or a cursor page; a failure has
      // no payload at all, so the note is derived from the status.
      const available = response.status !== 404 && response.status !== 403
      return {
        tasks: header.items.map(mapTask),
        hasMore: header.hasMore,
        nextCursor: header.nextCursor,
        available,
        note:
          response.status === 404
            ? 'tasks-unavailable'
            : response.status === 403
              ? 'tasks-forbidden'
              : 'tasks-error',
        warnings: response.error === null ? [] : [{ code: 'probeFailed', params: { target: 'tasks', error: response.error } }],
        observedAt: new Date(this.now()).toISOString(),
      }
    }
    const page = rawPageHeader(response.result)
    return {
      tasks: page.items.map(mapTask),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      available: true,
      note: null,
      warnings: [],
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /** One task, optionally with its execution events. */
  async task(
    taskId: string,
    options: { events?: boolean } = {},
  ): Promise<OveResult<{ task: ActivityTaskDetail }>> {
    const response = await this.options.api.getTask(taskId, { includeEvents: options.events === true })
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status === 404 ? 'not-found' : 'rejected-by-server',
          message: response.error ?? `HTTP ${response.status}`,
        },
      }
    }
    const raw = response.result ?? {}
    const mapped = mapTask(raw)
    const events = mapTaskEvents(raw)
    return {
      ok: true,
      task: {
        ...mapped,
        events: events.events,
        eventsDropped: events.dropped,
        result: raw.result ?? null,
        meta: null,
      },
    }
  }

  /** The roadmap's "failures are exportable": one task as safe JSON. */
  async exportTask(taskId: string): Promise<OveResult<{ task: Record<string, unknown>; fileName: string }>> {
    const response = await this.options.api.getTask(taskId, { includeEvents: true })
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status === 404 ? 'not-found' : 'rejected-by-server',
          message: response.error ?? `HTTP ${response.status}`,
        },
      }
    }
    const raw = response.result ?? {}
    const task = safeTaskExport(raw)
    const fileName = `openviking-task-${(typeof raw.task_id === 'string' ? raw.task_id : taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
    return { ok: true, task, fileName }
  }

  /**
   * Cooperative cancel. Returns the settled/updated task record.
   *
   * The server refuses ROOT identities (403), terminal/unsupported tasks (412)
   * and unknown tasks (404); those map to codes the tab localizes. Cancel never
   * rolls back a completed business write and the UI says so.
   */
  async cancel(taskId: string): Promise<OveResult<{ task: ActivityTask }>> {
    const response = await this.options.api.cancelTask(taskId)
    if (!response.ok) {
      const code =
        response.status === 403
          ? 'root-cannot-cancel'
          : response.status === 412
            ? 'not-cancellable'
            : response.status === 404
              ? 'not-found'
              : 'rejected-by-server'
      return { ok: false, error: { code, message: response.error ?? `HTTP ${response.status}` } }
    }
    return { ok: true, task: mapTask(response.result) }
  }

  /** The four cheap metric sources, each independently degradable. */
  async metrics(options: { sessionId?: string; ovSessionId?: string; fresh?: boolean } = {}): Promise<MetricsPayload> {
    const sessionId = options.sessionId ?? null
    const ovSessionId = options.ovSessionId ?? null
    if (
      options.fresh !== true &&
      this.metricsCache !== null &&
      this.metricsCache.sessionId === sessionId &&
      this.now() - this.metricsCache.at < this.cacheTtlMs
    ) {
      return this.metricsCache.value
    }

    const [dashboard, queue, memories, session] = await Promise.all([
      this.options.api.dashboardSummary(),
      this.options.api.observerQueue(),
      this.options.api.memoryStats(),
      ovSessionId === null ? Promise.resolve(null) : this.options.api.sessionStats(ovSessionId),
    ])

    const dash = dashboard.ok ? (dashboard.result ?? {}) : null
    const queueBody = queue.ok ? (queue.result ?? {}) : null
    const memoryBody = memories.ok ? (memories.result ?? {}) : null
    const sessionBody = session !== null && session.ok ? (session.result ?? {}) : null

    const payload: MetricsPayload = {
      sessionId,
      dashboard: {
        available: dashboard.ok,
        error: dashboard.ok ? null : 'metrics-unavailable',
        files: numberOrNull(dash?.context_counts?.files),
        skills: numberOrNull(dash?.context_counts?.skills),
        memories: numberOrNull(dash?.context_counts?.memories),
        total: numberOrNull(dash?.context_counts?.total),
        todayTokens: numberOrNull(dash?.today_tokens?.total),
        todayRetrievals: numberOrNull(dash?.today_retrievals?.total),
      },
      queue: {
        available: queue.ok,
        error: queue.ok ? null : 'metrics-unavailable',
        queues: (queueBody?.status?.queues ?? []).map((entry) => ({
          queue: typeof entry.queue === 'string' ? entry.queue : 'unknown',
          pending: numberOrNull(entry.pending) ?? 0,
          inProgress: numberOrNull(entry.in_progress) ?? 0,
          errors: numberOrNull(entry.errors) ?? 0,
          processed: numberOrNull(entry.processed) ?? 0,
        })),
      },
      memories: {
        available: memories.ok,
        error: memories.ok ? null : 'metrics-unavailable',
        total: numberOrNull(memoryBody?.total_memories),
        byCategory: recordOfNumbers(memoryBody?.by_category),
        hotness: recordOfNumbers(memoryBody?.hotness_distribution),
        stale7d: numberOrNull(memoryBody?.staleness?.not_accessed_7d),
        stale30d: numberOrNull(memoryBody?.staleness?.not_accessed_30d),
        oldestDays: numberOrNull(memoryBody?.staleness?.oldest_memory_age_days),
      },
      session: {
        available: session !== null && session.ok,
        error: session === null ? 'no-session' : session.ok ? null : 'metrics-unavailable',
        sessionId,
        totalTurns: numberOrNull(sessionBody?.total_turns),
        memoriesExtracted: numberOrNull(sessionBody?.memories_extracted),
      },
      prometheus: false,
      warnings: [],
      observedAt: new Date(this.now()).toISOString(),
    }
    this.metricsCache = { at: this.now(), sessionId, value: payload }
    return payload
  }
}

/** A task list reply as a cursor page, whether the server sent a page or an array. */
function rawPageHeader(raw: unknown): { items: OvTask[]; hasMore: boolean; nextCursor: string | null } {
  if (Array.isArray(raw)) return { items: raw as OvTask[], hasMore: false, nextCursor: null }
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    const items = Array.isArray(record.items) ? (record.items as OvTask[]) : []
    return {
      items,
      hasMore: record.has_more === true,
      nextCursor: typeof record.next_cursor === 'string' ? record.next_cursor : null,
    }
  }
  return { items: [], hasMore: false, nextCursor: null }
}

function recordOfNumbers(value: unknown): Record<string, number> {
  const output: Record<string, number> = {}
  if (value === null || typeof value !== 'object') return output
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = numberOrNull(entry)
    if (parsed !== null) output[key] = parsed
  }
  return output
}
