/**
 * v0.8: the confirmation protocol's shared machinery.
 *
 * v0.5 wrote the token / TTL / pending-cap / rate-quota / single-in-flight logic
 * inside `WriteService`. v0.8 adds a second family of mutations (`OpsService`),
 * and the Lead sign-off requires both to share exactly one controller: at most
 * one curation write **or** operational action may be in flight per profile, and
 * the token/rate rules must be written once so the two services cannot drift.
 *
 * Extracted here (behaviour-preserving for `WriteService`, which keeps its
 * public API and tests):
 *
 *  - {@link MutationGate} — the single in-flight lock spanning both services;
 *  - {@link SlidingWindowRate} — the timestamp-window quota both services use
 *    for successful executions and for preparation quotas;
 *  - {@link ConfirmationStore} — the bounded single-use token store with TTL
 *    purging, shared by both services;
 *  - {@link mintToken} — the 32-byte hex capability token.
 *
 * Nothing here touches the network, the disk or the clock directly: `now` is
 * injectable so tests can drive expiry deterministically.
 */
import { randomBytes } from 'node:crypto'

/** The settlement statuses a confirmation token moves through. */
export type ConfirmationStatus = 'pending' | 'executing' | 'done' | 'undone' | 'failed' | 'cancelled'

/** The minimal record shape the store can purge and bound. */
export interface ConfirmationRecord {
  token: string
  status: ConfirmationStatus
  createdAt: number
  expiresAt: number
  settledAt: number | null
}

/** A 32-byte opaque capability token (hex, 64 chars). */
export function mintToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The single mutation path, shared by the write and ops services.
 *
 * `enter()` is synchronous and must be called immediately before the first
 * mutation (and before any further `await`), so two executes — or an ops action
 * racing a curation write — cannot run their mutations concurrently. v0.8
 * extends v0.5's one-write rule to one curation-or-operational action per
 * profile; the refusal code stays `write-in-flight` so clients keep one story.
 */
export class MutationGate {
  private inFlight = false
  private owner: string | null = null

  /** Claim the mutation path; false when another action is already mutating. */
  enter(owner = 'mutation'): boolean {
    if (this.inFlight) return false
    this.inFlight = true
    this.owner = owner
    return true
  }

  /** Release the mutation path (always from `finally`). */
  leave(): void {
    this.inFlight = false
    this.owner = null
  }

  get busy(): boolean {
    return this.inFlight
  }

  /** Which service holds the path (`write` | `ops` | …); diagnostics only. */
  get currentOwner(): string | null {
    return this.owner
  }
}

/** The result of a quota check: allowed, or the bounded refusal facts. */
export type RateDecision =
  | { ok: true }
  | { ok: false; retryAfterMs: number; limit: number; windowMs: number }

/**
 * A sliding-window rate quota.
 *
 * Successful executions and preparation preparations are counted separately:
 * v0.5 review round 2 established that a prepare is not free (it may take a
 * server-side snapshot/dry-run), so cancels never refund it — only the window
 * rolls over. Timestamps are pruned on every check, so the list is bounded by
 * the quota itself.
 */
export class SlidingWindowRate {
  private readonly stamps: number[] = []
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = Math.max(1, Math.trunc(limit))
    this.windowMs = Math.max(1, Math.trunc(windowMs))
    this.now = now
  }

  /** Whether one more entry fits in the current window; does not record it. */
  check(): RateDecision {
    this.prune()
    if (this.stamps.length < this.limit) return { ok: true }
    const oldest = this.stamps[0] as number
    return {
      ok: false,
      retryAfterMs: Math.max(0, oldest + this.windowMs - this.now()),
      limit: this.limit,
      windowMs: this.windowMs,
    }
  }

  /** Record one successful event (only a real execution/prepare spends quota). */
  record(): void {
    this.stamps.push(this.now())
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs
    while (this.stamps.length > 0 && (this.stamps[0] as number) < cutoff) this.stamps.shift()
  }
}

export interface ConfirmationStoreOptions {
  /** At most this many un-settled confirmations may exist at once. */
  maxPending: number
  /** How long a settled record is kept for idempotent cancel/no-op answers. */
  settledRetentionMs?: number
  now?: () => number
}

/**
 * Bounded, single-use confirmation tokens.
 *
 * The store is deliberately in-memory and session-scoped (the audit file is the
 * durable record of what happened, not of what may still happen): a restart
 * makes every outstanding token useless and every undo handle unavailable, which
 * is the documented behaviour for both v0.5 and v0.8.
 */
export class ConfirmationStore<T extends ConfirmationRecord> {
  private readonly records = new Map<string, T>()
  private readonly maxPending: number
  private readonly settledRetentionMs: number
  private readonly now: () => number

  constructor(options: ConfirmationStoreOptions) {
    this.maxPending = Math.max(1, Math.trunc(options.maxPending))
    this.settledRetentionMs = options.settledRetentionMs ?? 10 * 60_000
    this.now = options.now ?? Date.now
  }

  get(token: string): T | undefined {
    return this.records.get(token)
  }

  set(record: T): void {
    this.records.set(record.token, record)
  }

  delete(token: string): void {
    this.records.delete(token)
  }

  get size(): number {
    return this.records.size
  }

  values(): IterableIterator<T> {
    return this.records.values()
  }

  /** Every still-pending record (the pending cap applies to these). */
  pending(): T[] {
    return [...this.records.values()].filter((record) => record.status === 'pending')
  }

  /** Whether any record is currently executing (an in-flight settlement). */
  hasExecuting(): boolean {
    for (const record of this.records.values()) if (record.status === 'executing') return true
    return false
  }

  /** Whether another pending record would exceed the documented cap. */
  atPendingCap(): boolean {
    return this.pending().length >= this.maxPending
  }

  /**
   * Drop expired pending tokens and long-settled records.
   *
   * Expired pending tokens are deleted (an execute answers `token-expired`);
   * settled records are kept briefly so a double cancel/execute gets the
   * idempotent `settled`/`token-used` answer instead of "never existed".
   */
  purge(): void {
    const now = this.now()
    for (const [key, record] of this.records) {
      if (record.status === 'pending' && record.expiresAt < now) {
        this.records.delete(key)
        continue
      }
      if (record.status !== 'pending' && record.settledAt !== null && now - record.settledAt > this.settledRetentionMs) {
        this.records.delete(key)
      }
    }
  }
}
