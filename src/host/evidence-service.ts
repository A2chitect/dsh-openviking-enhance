/**
 * v0.8 "Operate": the exportable task evidence (`GET /task/evidence`).
 *
 * The evidence file answers "what happened, as this plugin saw it" and is meant
 * to be handed to support: safe task fields and execution events, the local
 * audit entries the task correlates with (≤20), the server's own request-log
 * rows for those request ids (≤20, looked up on demand and only when reachable),
 * and the build/identity block. The v0.5 `/task/export` stays unchanged; this is
 * additive and labelled "Export evidence (with correlation)".
 *
 * Privacy rules (binding): the same redacted identity the audit file records,
 * server request metadata only (the server's `/console/audit` carries no
 * bodies), never a memory body, token or secret. The whole file is capped at
 * `TASK_EVIDENCE_MAX_BYTES`; when the cap is hit the correlation shrinks first
 * (server rows → audit rows → minimal task) and a warning says so.
 */
import { EVIDENCE_LOOKUP_DEADLINE_MS, TASK_EVIDENCE_CORRELATION_MAX, TASK_EVIDENCE_MAX_BYTES } from '../shared/limits.ts'
import { AUDIT_MAX_LIMIT } from '../shared/protocol.ts'
import type {
  AuditEntry,
  IdentityScope,
  OveResult,
  TaskEvidenceBuild,
  TaskEvidencePayload,
  TaskEvidenceServerRequest,
} from '../shared/protocol.ts'
import type { ActivityService } from './activity-service.ts'
import type { AuditLog } from './audit.ts'
import type { OpenVikingApi } from './openviking-api.ts'

export interface EvidenceServiceOptions {
  api: OpenVikingApi
  audit: AuditLog
  activity: ActivityService
  identity: () => IdentityScope
  build: () => TaskEvidenceBuild
  now?: () => number
}

/** One server audit row, reduced to the metadata the evidence is allowed to carry. */
function mapServerRequest(row: unknown): TaskEvidenceServerRequest | null {
  if (row === null || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const requestId =
    typeof record.request_id === 'string'
      ? record.request_id
      : typeof record.requestId === 'string'
        ? record.requestId
        : null
  if (requestId === null || requestId.length === 0) return null
  const num = (key: string): number | null => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const str = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  return {
    requestId,
    method: str('method'),
    route: str('route'),
    apiType: str('api_type'),
    statusCode: num('status_code') ?? num('statusCode'),
    durationMs: num('duration_ms') ?? num('durationMs'),
    errorCode: str('error_code') ?? str('errorCode'),
  }
}

export class EvidenceService {
  private readonly options: EvidenceServiceOptions
  private readonly now: () => number

  constructor(options: EvidenceServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Assemble one bounded evidence document for a task. Never throws. */
  async evidence(taskId: string): Promise<OveResult<{ evidence: TaskEvidencePayload; fileName: string }>> {
    const exported = await this.options.activity.exportTask(taskId)
    if (!exported.ok) return exported

    // The local audit trail is the "who confirmed it" source; v0.8 entries carry
    // the task/operation/idempotency correlation, v0.5 entries only a request id.
    const recent = this.options.audit.recent(AUDIT_MAX_LIMIT, {})
    const matched: AuditEntry[] = []
    const requestIds: string[] = []
    let idempotencyKey: string | null = null
    let operationId: string | null = null
    for (const entry of recent.entries) {
      if (entry.taskId === taskId) matched.push(entry)
    }
    for (const entry of matched) {
      if (typeof entry.idempotencyKey === 'string' && entry.idempotencyKey.length > 0) idempotencyKey = entry.idempotencyKey
      if (typeof entry.operationId === 'string' && entry.operationId.length > 0) operationId = entry.operationId
    }
    if (operationId !== null) {
      // The compile operation and its task share the correlation key: include
      // both halves so the evidence shows the trigger and the verification read.
      for (const entry of recent.entries) {
        if (entry.operationId === operationId && !matched.includes(entry)) matched.push(entry)
      }
    }
    for (const entry of matched) {
      if (typeof entry.requestId === 'string' && entry.requestId.length > 0 && !requestIds.includes(entry.requestId)) {
        requestIds.push(entry.requestId)
      }
    }
    const warnings: string[] = []
    if (matched.length === 0) warnings.push('no-local-audit-correlation')

    // Server request-log lookup: on demand, only for the ids the evidence has,
    // and each failure downgrades to a warning rather than a failed export.
    const serverRequests: TaskEvidenceServerRequest[] = []
    const idsToLookup = [...new Set(requestIds)].slice(0, TASK_EVIDENCE_CORRELATION_MAX)
    if (idsToLookup.length === 0) {
      warnings.push('no-request-ids')
    } else {
      let failures = 0
      const lookupStartedAt = this.now()
      for (const requestId of idsToLookup) {
        if (serverRequests.length >= TASK_EVIDENCE_CORRELATION_MAX) break
        // The fan-out is one `/console/audit` call per request id; that can be
        // many 8 s timeouts. Stop at the documented total deadline and say so.
        if (this.now() - lookupStartedAt > EVIDENCE_LOOKUP_DEADLINE_MS) {
          warnings.push('server-request-log-deadline')
          break
        }
        const response = await this.options.api.consoleAudit({ requestId, pageSize: 20 })
        if (!response.ok) {
          failures += 1
          continue
        }
        const rows = Array.isArray(response.result?.items)
          ? (response.result.items as unknown[])
          : Array.isArray(response.result?.audit_logs)
            ? (response.result.audit_logs as unknown[])
            : Array.isArray(response.result?.rows)
              ? (response.result.rows as unknown[])
              : []
        for (const row of rows) {
          if (serverRequests.length >= TASK_EVIDENCE_CORRELATION_MAX) break
          const mapped = mapServerRequest(row)
          if (mapped !== null) serverRequests.push(mapped)
        }
      }
      if (failures > 0) warnings.push(failures >= idsToLookup.length ? 'server-request-log-unavailable' : 'server-request-log-partial')
    }

    const scope = this.options.identity()
    const evidence: TaskEvidencePayload = {
      schema: 'dsh-openviking-enhance/task-evidence/v1',
      generatedAt: new Date(this.now()).toISOString(),
      build: this.options.build(),
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
      task: exported.task,
      correlation: {
        requestIds: requestIds.slice(0, TASK_EVIDENCE_CORRELATION_MAX),
        idempotencyKey,
        operationId,
        auditEntries: matched.slice(0, TASK_EVIDENCE_CORRELATION_MAX),
        serverRequests,
        warnings,
      },
      limits: {
        auditEntries: TASK_EVIDENCE_CORRELATION_MAX,
        serverRequests: TASK_EVIDENCE_CORRELATION_MAX,
        maxBytes: TASK_EVIDENCE_MAX_BYTES,
      },
    }
    // Enforce the documented size cap by shrinking the correlation first, then
    // the task projection; the final state is always honest (a warning says why).
    const size = (value: TaskEvidencePayload): number => Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
    if (size(evidence) > TASK_EVIDENCE_MAX_BYTES) {
      evidence.correlation.serverRequests = []
      evidence.correlation.warnings.push('server-requests-dropped-size-cap')
    }
    if (size(evidence) > TASK_EVIDENCE_MAX_BYTES) {
      evidence.correlation.auditEntries = evidence.correlation.auditEntries.slice(0, 5)
      evidence.correlation.warnings.push('audit-entries-trimmed-size-cap')
    }
    if (size(evidence) > TASK_EVIDENCE_MAX_BYTES) {
      evidence.task = minimalTask(evidence.task)
      evidence.correlation.warnings.push('task-trimmed-size-cap')
    }
    const safeId = taskId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100)
    return { ok: true, evidence, fileName: `openviking-task-evidence-${safeId}.json` }
  }
}

/** The minimal task projection used when even the safe export breaks the cap. */
function minimalTask(task: Record<string, unknown>): Record<string, unknown> {
  const pick = (key: string): unknown => task[key]
  return {
    task_id: pick('task_id'),
    task_type: pick('task_type'),
    status: pick('status'),
    error: pick('error'),
    created_at: pick('created_at'),
    updated_at: pick('updated_at'),
  }
}
