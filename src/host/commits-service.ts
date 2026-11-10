/**
 * The bounded recent-commit browser's host half.
 *
 * There is no global commit history on the server: archives live per session and
 * task records are pruned (~24 h / 7 days), so a true cross-session history does
 * not exist. The honest maximum is a bounded fan-out over the newest sessions:
 * the newest ≤8 sessions from the directory page, each read through the existing
 * `CommitService.status()` (session meta + history listing + newest-archive
 * marker), plus the newest one or two archives' summary counts. Reads run through
 * the v0.6 `async-pool` with concurrency 4 and a 10 s total deadline, and the
 * answer is a first-class partial: rows that answered are kept, the rest are
 * explained by `limitedBy`/`progress` (the same pattern as the v0.6 rule list).
 *
 * The answer is cached 30 s and is never polled.
 */
import { mapPool } from './async-pool.ts'
import {
  RECENT_COMMITS_CACHE_TTL_MS,
  RECENT_COMMITS_CONCURRENCY,
  RECENT_COMMITS_DEADLINE_MS,
  RECENT_COMMITS_SESSION_CAP,
} from '../shared/limits.ts'
import type {
  ArchiveSummary,
  CommitStatus,
  PluginNotice,
  RecentCommitRow,
  RecentCommitsLimitedBy,
  RecentCommitsPayload,
} from '../shared/protocol.ts'
import type { SessionListRow } from '../shared/protocol.ts'
import type { CommitService } from './commit-service.ts'
import { BrowseFailure } from './browse-service.ts'
import type { SessionsService } from './sessions-service.ts'

export interface RecentCommitsServiceOptions {
  commit: CommitService
  sessions: SessionsService
  now?: () => number
}

/** How many archives' summaries one row shows (state + add/update/delete counts). */
export const RECENT_COMMIT_SUMMARIES = 2

export class RecentCommitsService {
  private readonly options: RecentCommitsServiceOptions
  private readonly now: () => number
  private cached: { at: number; key: string; payload: RecentCommitsPayload } | null = null
  private inflight: { key: string; promise: Promise<RecentCommitsPayload> } | null = null

  constructor(options: RecentCommitsServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop the cached answer (identity switch). */
  resetCaches(): void {
    this.cached = null
    this.inflight = null
  }

  /**
   * The bounded recent-commit list.
   *
   * @param options.limit requested session count; clamped to the documented cap
   * @throws {BrowseFailure} `unreadable`/`aborted` only when the session listing
   * itself fails — a per-session failure is a row-level `error`, not a refusal.
   */
  async recent(
    options: { limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<RecentCommitsPayload> {
    const limit = clampLimit(options.limit)
    const key = String(limit)
    if (options.fresh !== true && this.cached !== null && this.cached.key === key && this.now() - this.cached.at < RECENT_COMMITS_CACHE_TTL_MS) {
      return this.cached.payload
    }
    if (options.fresh !== true && this.inflight !== null && this.inflight.key === key) return this.inflight.promise

    const started = this.now()
    const promise = this.compute(limit, started, options.signal)
      .then((payload) => {
        this.cached = { at: this.now(), key, payload }
        return payload
      })
      .finally(() => {
        if (this.inflight?.key === key) this.inflight = null
      })
    this.inflight = { key, promise }
    return promise
  }

  private async compute(
    limit: number,
    started: number,
    signal: AbortSignal | undefined,
  ): Promise<RecentCommitsPayload> {
    const warnings: PluginNotice[] = []
    const listing = await this.options.sessions.list({ offset: 0, limit, signal })
    warnings.push(...listing.warnings)
    if (signal?.aborted === true) throw new BrowseFailure('aborted', 'aborted')

    const rows = listing.items
    const deadline = started + RECENT_COMMITS_DEADLINE_MS
    const outcome = await mapPool(
      rows,
      RECENT_COMMITS_CONCURRENCY,
      async (row): Promise<RecentCommitRow> => this.readRow(row),
      {
        deadline,
        ...(signal === undefined ? {} : { signal }),
        now: this.now,
      },
    )

    const items = outcome.results.filter((row): row is RecentCommitRow => row !== undefined)
    const deadlineHit = outcome.deadlineHit || outcome.aborted
    // The fan-out is also truncated when the directory page itself has more
    // sessions than the cap; that is a session-cap partial, not a deadline one.
    const cappedBySessions = listing.hasMore
    const partial = deadlineHit || cappedBySessions
    const limitedBy: RecentCommitsLimitedBy | null = deadlineHit ? 'deadline' : cappedBySessions ? 'session-cap' : null
    return {
      items,
      partial,
      limitedBy,
      progress: {
        sessionsScanned: outcome.started,
        elapsedMs: Math.max(0, this.now() - started),
        deadlineMs: RECENT_COMMITS_DEADLINE_MS,
        sessionCap: limit,
      },
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /** One session's commit facts; any failure becomes this row's `error`. */
  private async readRow(row: SessionListRow): Promise<RecentCommitRow> {
    const base: RecentCommitRow = {
      ovSessionId: row.ovSessionId,
      sessionId: row.sessionId,
      uri: row.uri,
      modifiedAt: row.modifiedAt,
      status: null,
      summaries: [],
      error: null,
    }
    if (row.sessionId === null) {
      // Another harness's session: this plugin's per-session routes are keyed by
      // the DSH session id, so the honest answer is "not addressable", not an
      // invented id that would read as an empty session.
      return { ...base, error: 'unsupported-session' }
    }
    try {
      const status: CommitStatus = await this.options.commit.status(row.sessionId)
      let summaries: ArchiveSummary[] = []
      if (status.archives.length > 0) {
        summaries = await this.options.commit.summaries(
          row.sessionId,
          status.archives,
          RECENT_COMMIT_SUMMARIES,
        )
      }
      return { ...base, status, summaries }
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return RECENT_COMMITS_SESSION_CAP
  return Math.min(Math.max(Math.trunc(raw), 1), RECENT_COMMITS_SESSION_CAP)
}
