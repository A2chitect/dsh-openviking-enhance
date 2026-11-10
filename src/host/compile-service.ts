/**
 * v0.8 "Operate": the Compile inspection surfaces.
 *
 * Read-only against OpenViking: capabilities, target registry/config, operation
 * history/detail/outputs, submission lookup and per-file versions (the last
 * lives in `snapshot-service.ts` because it is a snapshot route).
 *
 * Runtime capability, never a version comparison: `/compile/capabilities` is the
 * trigger gate (`configured && can_create`), `/compile/configs` and
 * `/compile/operations` are probed by their own 404 answers and degrade to
 * "operation history needs OpenViking 0.5.3+" instead of an error pile.
 *
 * The one mutation (the confirmed trigger) is executed by `OpsService`, which
 * owns the prepare→confirm→execute→audit protocol; nothing here is reachable as
 * a bare write route.
 */
import {
  COMPILE_CONFIGS_MAX,
  COMPILE_OUTPUTS_PAGE,
  COMPILE_OPERATIONS_PAGE,
} from '../shared/limits.ts'
import type {
  CompileCapabilities,
  CompileOperationPayload,
  CompileOperationRow,
  CompileOperationsPayload,
  CompileOutputRow,
  CompileOutputsPayload,
  CompileSubmissionPayload,
  CompileTargetConfig,
  CompileTargetPayload,
  CompileTargetRow,
  CompileTargetsPayload,
  PluginNotice,
} from '../shared/protocol.ts'
import type { OpenVikingApi } from './openviking-api.ts'

/** Fold the server's epoch seconds into the ISO string the UI displays. */
function isoFromSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}

/** Display-safe string from an unknown wire value. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function mapTarget(row: { to?: string; status?: string; initialized?: boolean; running?: boolean; auto_update?: boolean; update_schedule?: unknown; next_run_at?: unknown; content_updated_at?: unknown; compile_type?: string; conflicts_num?: number }): CompileTargetRow {
  return {
    to: typeof row.to === 'string' ? row.to : '',
    status: asString(row.status),
    initialized: typeof row.initialized === 'boolean' ? row.initialized : null,
    running: typeof row.running === 'boolean' ? row.running : null,
    autoUpdate: typeof row.auto_update === 'boolean' ? row.auto_update : null,
    updateSchedule: row.update_schedule === null || row.update_schedule === undefined ? null : summarizeSchedule(row.update_schedule),
    nextRunAt: typeof row.next_run_at === 'string' ? row.next_run_at : isoFromSeconds(row.next_run_at),
    contentUpdatedAt: isoFromSeconds(row.content_updated_at),
    compileType: asString(row.compile_type),
    conflicts: typeof row.conflicts_num === 'number' ? row.conflicts_num : null,
  }
}

/** The schedule is a server config blob; show a short, non-secret summary. */
function summarizeSchedule(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 120)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    if (typeof record.mode === 'string') parts.push(record.mode)
    if (typeof record.cron === 'string') parts.push(record.cron)
    if (typeof record.interval === 'string') parts.push(record.interval)
    if (parts.length > 0) return parts.join(' · ').slice(0, 120)
  }
  return ''
}

function mapOperation(row: {
  operation_id?: string
  operation_type?: string
  actor?: string | null
  status?: string
  created_at?: number
  started_at?: number | null
  finished_at?: number | null
  params?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  error?: string | null
  meta?: { task_id?: string } | null
}): CompileOperationRow {
  return {
    operationId: typeof row.operation_id === 'string' ? row.operation_id : '',
    operationType: asString(row.operation_type),
    actor: asString(row.actor) ?? null,
    status: asString(row.status),
    createdAt: typeof row.created_at === 'number' ? row.created_at : null,
    startedAt: typeof row.started_at === 'number' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'number' ? row.finished_at : null,
    params: row.params !== null && typeof row.params === 'object' ? row.params : null,
    result: row.result !== null && typeof row.result === 'object' ? row.result : null,
    error: asString(row.error),
    taskId: row.meta !== null && row.meta !== undefined && typeof row.meta.task_id === 'string' ? row.meta.task_id : null,
  }
}

export interface CompileServiceOptions {
  api: OpenVikingApi
  now?: () => number
}

export class CompileService {
  private readonly options: CompileServiceOptions
  private readonly now: () => number

  constructor(options: CompileServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  /** `GET /compile/capabilities` (0.5.1.1+): the trigger gate's runtime answer. */
  async capabilities(): Promise<CompileCapabilities> {
    const response = await this.options.api.compileCapabilities()
    if (!response.ok) {
      return {
        available: false,
        configured: false,
        canCreate: false,
        reason: null,
        note: response.status === 404 ? 'compile-unavailable' : response.status === 403 ? 'compile-role-required' : 'compile-unavailable',
      }
    }
    const configured = response.result?.configured === true
    const canCreate = response.result?.can_create === true
    const reason = asString(response.result?.reason_code)
    return {
      available: configured && canCreate,
      configured,
      canCreate,
      reason,
      note: configured && canCreate ? null : (reason ?? 'compile-unavailable'),
    }
  }

  /** `GET /compile/configs`: the 0.5.3 target registry (bounded page). */
  async targets(input: { limit?: number; cursor?: string | null } = {}): Promise<CompileTargetsPayload> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? COMPILE_CONFIGS_MAX), 1), COMPILE_CONFIGS_MAX)
    const response = await this.options.api.compileConfigs({
      limit,
      ...(input.cursor === null || input.cursor === undefined || input.cursor.length === 0 ? {} : { cursor: input.cursor }),
    })
    if (!response.ok) {
      return {
        available: false,
        targets: [],
        nextCursor: null,
        note: response.status === 404 ? 'not-supported' : response.status === 403 ? 'forbidden' : 'compile-unavailable',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    const rows = Array.isArray(response.result?.targets) ? response.result.targets : []
    return {
      available: true,
      targets: rows.map(mapTarget),
      nextCursor: asString(response.result?.next_cursor),
      note: rows.length === 0 ? 'no-targets' : null,
      warnings: [],
      observedAt: this.stamp(),
    }
  }

  /** `GET /compile/config?to=` (0.5.3 target config, read-only). */
  async targetConfig(to: string): Promise<CompileTargetPayload> {
    const response = await this.options.api.compileConfig(to)
    if (!response.ok) {
      return {
        available: false,
        target: null,
        note: response.status === 404 ? 'target-not-found' : response.status === 403 ? 'forbidden' : 'not-supported',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    const row = response.result ?? {}
    const config: CompileTargetConfig = {
      to: typeof row.to === 'string' ? row.to : to,
      from: Array.isArray(row.from) ? row.from.filter((entry): entry is string => typeof entry === 'string') : [],
      skill: asString(row.skill),
      instruction: asString(row.instruction),
      autoUpdate: typeof row.auto_update === 'boolean' ? row.auto_update : null,
      updateSchedule: row.update_schedule === null || row.update_schedule === undefined ? null : summarizeSchedule(row.update_schedule),
      status: asString(row.status),
      compileType: asString(row.compile_type),
      conflicts: typeof row.conflicts_num === 'number' ? row.conflicts_num : null,
    }
    return { available: true, target: config, note: null, warnings: [], observedAt: this.stamp() }
  }

  /** `GET /compile/operations` (0.5.3): the operation list for one target. */
  async operations(input: { to: string; cursor?: string | null; limit?: number }): Promise<CompileOperationsPayload> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? COMPILE_OPERATIONS_PAGE), 1), 100)
    const response = await this.options.api.compileOperations(input.to, {
      limit,
      ...(input.cursor === null || input.cursor === undefined || input.cursor.length === 0 ? {} : { cursor: input.cursor }),
    })
    if (!response.ok) {
      return {
        to: input.to,
        operations: [],
        hasMore: false,
        nextCursor: null,
        available: false,
        note: response.status === 404 ? 'not-supported' : response.status === 403 ? 'forbidden' : 'compile-unavailable',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    const rows = Array.isArray(response.result?.operations) ? response.result.operations : []
    return {
      to: input.to,
      operations: rows.map(mapOperation),
      hasMore: asString(response.result?.next_cursor) !== null,
      nextCursor: asString(response.result?.next_cursor),
      available: true,
      note: null,
      warnings: [],
      observedAt: this.stamp(),
    }
  }

  /** `GET /compile/operations/{id}` (0.5.3): one operation's public view. */
  async operation(to: string, operationId: string): Promise<CompileOperationPayload> {
    const response = await this.options.api.compileOperation(to, operationId)
    if (!response.ok) {
      return {
        to,
        operation: null,
        available: false,
        note: response.status === 404 ? 'operation-not-found' : 'compile-unavailable',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    return {
      to,
      operation: mapOperation(response.result ?? {}),
      available: true,
      note: null,
      warnings: [],
      observedAt: this.stamp(),
    }
  }

  /** `GET /compile/operations/{id}/outputs` (0.5.3): versioned output refs. */
  async outputs(input: { to: string; operationId: string; cursor?: string | null; limit?: number }): Promise<CompileOutputsPayload> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? COMPILE_OUTPUTS_PAGE), 1), 100)
    const response = await this.options.api.compileOutputs(input.to, input.operationId, {
      limit,
      ...(input.cursor === null || input.cursor === undefined || input.cursor.length === 0 ? {} : { cursor: input.cursor }),
    })
    if (!response.ok) {
      return {
        to: input.to,
        operationId: input.operationId,
        outputs: [],
        hasMore: false,
        nextCursor: null,
        available: false,
        note: response.status === 404 ? 'not-supported' : 'compile-unavailable',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    const rows: CompileOutputRow[] = (Array.isArray(response.result?.outputs) ? response.result.outputs : []).map((row) => ({
      uri: typeof row.uri === 'string' ? row.uri : '',
      versionId: typeof row.version_id === 'string' ? row.version_id : null,
      snapshotId: typeof row.snapshot_id === 'string' ? row.snapshot_id : null,
    }))
    return {
      to: input.to,
      operationId: input.operationId,
      outputs: rows.filter((row) => row.uri.length > 0),
      hasMore: asString(response.result?.next_cursor) !== null,
      nextCursor: asString(response.result?.next_cursor),
      available: true,
      note: null,
      warnings: [],
      observedAt: this.stamp(),
    }
  }

  /** `GET /compile/submissions/{key}` (0.5.1.1+): read-only idempotency recovery. */
  async submission(key: string): Promise<CompileSubmissionPayload> {
    const response = await this.options.api.compileSubmission(key)
    if (!response.ok) {
      return {
        key,
        found: false,
        taskId: null,
        status: null,
        taskType: null,
        available: response.status !== 404,
        note: response.status === 404 ? 'submission-not-found' : 'not-supported',
        warnings: [],
        observedAt: this.stamp(),
      }
    }
    return {
      key,
      found: true,
      taskId: asString(response.result?.task_id),
      status: asString(response.result?.status),
      taskType: asString(response.result?.task_type),
      available: true,
      note: null,
      warnings: [],
      observedAt: this.stamp(),
    }
  }

  /**
   * The trigger call itself (called only by `OpsService` after confirmation).
   *
   * The Idempotency-Key is host-generated and non-secret; a lost response is
   * recovered through `submission(key)`, never by an automatic retry.
   */
  async trigger(
    input: { to: string; from: string[]; skill: string; instruction?: string },
    idempotencyKey: string,
  ): Promise<
    | { ok: true; taskId: string | null; status: string | null; task: Record<string, unknown> | null; requestId: string | null }
    | { ok: false; code: string; message: string; requestId: string | null; status: number }
  > {
    const response = await this.options.api.compileCreate(input, idempotencyKey)
    if (!response.ok) {
      const code =
        response.status === 404
          ? 'compile-unavailable'
          : response.status === 401 || response.status === 403
            ? 'compile-role-required'
            : 'rejected-by-server'
      return { ok: false, code, message: response.error ?? 'The compile trigger failed.', requestId: response.requestId ?? null, status: response.status }
    }
    const result = (response.result ?? null) as Record<string, unknown> | null
    return {
      ok: true,
      taskId: result !== null && typeof result.task_id === 'string' ? result.task_id : null,
      status: result !== null && typeof result.status === 'string' ? result.status : null,
      task: result,
      requestId: response.requestId ?? null,
    }
  }
}

/** The warnings a UI shows when a read degrades; kept beside the service. */
export function compileWarnings(...codes: Array<string | null>): PluginNotice[] {
  return codes.filter((code): code is string => code !== null).map((code) => ({ code }))
}
