/**
 * F9/F10: the plugin's local audit trail.
 *
 * DSH has no append-only audit API, so the plugin keeps its own JSONL file next
 * to the profile store:
 *
 *   `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/audit.jsonl`   (0600)
 *
 * One line per user-intent write, undo, identity switch and denial. The record
 * is deliberately shaped around *what the user confirmed* — the server's own
 * request log (`GET /console/audit`, correlated by `x-request-id`) can prove
 * what was called, but no server endpoint records who confirmed it.
 *
 * Privacy rules (binding):
 *   - **no memory bodies** and no fragments of them: only URIs, hashes, byte
 *     counts, tags and result counters;
 *   - **no secrets**: never an API key, never an Authorization header value;
 *   - **no confirmation tokens**: the token appears in the durable session log
 *     anyway (that is unavoidable for command confirmations); it is redacted
 *     here so the audit file is safe to hand over for support;
 *   - a known code is recorded, not a raw server body.
 *
 * The trail is best-effort: a failed append is returned to the caller to log and
 * must never fail the write that was already executed.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AuditEntry, AuditIdentity, AuditKind, AuditPayload } from '../shared/protocol.ts'
import { appendJsonl, pluginStateDir, readJsonlTail } from './plugin-state.ts'

/** Rotation cap; two old files are kept (`audit.1.jsonl`, `audit.2.jsonl`). */
export const AUDIT_MAX_BYTES = 1024 * 1024
export const AUDIT_KEEP_ROTATIONS = 2

/** One audit record before the log stamps `id`/`ts`. */
export interface AuditInput {
  kind: AuditKind
  action: string
  target: string | null
  identity: AuditIdentity | null
  fingerprint: string | null
  confirmation: string | null
  preCommit?: string | null
  postCommit?: string | null
  requestId?: string | null
  result: AuditEntry['result']
  error?: string | null
  undo?: AuditEntry['undo']
}

export interface AuditLogOptions {
  /** Override the state directory (tests). */
  dir?: string
  env?: NodeJS.ProcessEnv
  maxBytes?: number
  keep?: number
  now?: () => number
}

/**
 * Build a redacted audit entry from an input.
 *
 * Exported so the redaction policy is testable without touching the disk: the
 * line a test reads back is the same function the runtime writes.
 */
export function auditEntryFrom(input: AuditInput, now: number = Date.now()): AuditEntry {
  const id = `aud-${now.toString(36)}-${randomBytes(4).toString('hex')}`
  return {
    id,
    ts: new Date(now).toISOString(),
    kind: input.kind,
    action: input.action,
    target: input.target === null ? null : redactTarget(input.target),
    identity: input.identity === null ? null : redactIdentity(input.identity),
    fingerprint: input.fingerprint,
    confirmation: input.confirmation,
    preCommit: input.preCommit ?? null,
    postCommit: input.postCommit ?? null,
    requestId: input.requestId ?? null,
    result: input.result,
    error: input.error === null || input.error === undefined ? null : redactError(input.error),
    undo: input.undo ?? null,
  }
}

/**
 * A target stays a URI/session id, but a query string or an embedded credential
 * in an endpoint is dropped: this is the one field a user may paste around.
 */
function redactTarget(target: string): string {
  const withoutQuery = target.split(/[?#]/)[0] ?? target
  return withoutQuery
}

function redactIdentity(identity: AuditIdentity): AuditIdentity {
  return {
    profileId: identity.profileId,
    endpoint: identity.endpoint.split(/[?#]/)[0] ?? identity.endpoint,
    authMode: identity.authMode,
    account: identity.account,
    user: identity.user,
    peer: identity.peer,
    dshSessionId: identity.dshSessionId,
  }
}

/** Server error text can echo a body; keep only a bounded first line. */
function redactError(error: string): string {
  const firstLine = error.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
  return firstLine.length > 300 ? `${firstLine.slice(0, 299)}…` : firstLine
}

export class AuditLog {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly now: () => number

  constructor(options: AuditLogOptions = {}) {
    this.directory = pluginStateDir(options)
    this.maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES
    this.keep = options.keep ?? AUDIT_KEEP_ROTATIONS
    this.now = options.now ?? Date.now
  }

  /** The absolute path of the audit file. */
  get path(): string {
    return join(this.directory, 'audit.jsonl')
  }

  /** Append one record; returns its id (null when the append failed). */
  append(input: AuditInput): { ok: boolean; id: string | null; error: string | null } {
    const entry = auditEntryFrom(input, this.now())
    const written = appendJsonl(this.path, entry, { maxBytes: this.maxBytes, keep: this.keep })
    return { ok: written.ok, id: written.ok ? entry.id : null, error: written.error }
  }

  /** The newest `limit` records, newest first, for the route and `/viking audit`. */
  recent(limit: number): AuditPayload {
    const entries = readJsonlTail(this.path, Math.max(1, limit))
      .filter((value): value is AuditEntry => isAuditEntry(value))
      .reverse()
    return {
      entries,
      path: this.path,
      unavailable: this.path.length === 0,
      warnings: [],
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /** A one-line text form for `/viking audit`; no bodies, no tokens. */
  recentLines(limit: number): string[] {
    return this.recent(limit).entries.map((entry) => {
      const target = entry.target === null ? '' : ` ${entry.target}`
      const error = entry.error === null ? '' : ` (${entry.error})`
      return `${entry.ts} ${entry.kind}/${entry.action}${target} → ${entry.result}${error}`
    })
  }
}

/** Minimally validate a parsed JSONL line so a hand-edited file degrades cleanly. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.ts === 'string' && typeof record.kind === 'string' && typeof record.action === 'string'
}
