/**
 * The session memory log: what OpenViking has captured for one DSH session,
 * how far it is from a commit, and whether anything is stuck.
 *
 * The dashboard has always been able to say "not committed" or "3 commits".
 * The harder question is the one after that: *why* is a turn not in memory yet?
 * The five states in `deriveSessionState` are the answer:
 *
 *   nothing captured → captured but under the threshold → archive written and
 *   extraction still running → extraction failed → the official plugin queued
 *   the write locally while the server was unreachable
 *
 * Every fact comes from the server or from the official plugin's opt-in local
 * queue; this module never writes and never exposes queued payloads.
 */
import type {
  ArchiveSummary,
  CommitArchive,
  PluginNotice,
  SessionLogEvent,
  SessionLogMeta,
  SessionLogTask,
  SessionMemoryLog,
  SessionMemoryState,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvCommitTask, OvSessionMeta } from './openviking-api.ts'
import type { CommitService } from './commit-service.ts'
import { resolveSessionUri } from './commit-service.ts'
import { readPendingQueue, type LocalStateOptions } from './local-state.ts'
import { isActiveTask } from '../shared/commit-state.ts'

export interface SessionLogOptions {
  api: OpenVikingApi
  commit: CommitService
  now?: () => number
  /** Test seam for the official plugin's local queue. */
  localState?: LocalStateOptions
}

/** Recent tasks shown in the log; the server prunes the records anyway. */
const TASK_LIMIT = 10
/** Recent archives whose terminal markers are re-read. */
const ARCHIVE_LIMIT = 3
/** Timeline rows kept; a long session should not render an unbounded list. */
const EVENT_LIMIT = 24

export class SessionLogService {
  private readonly options: SessionLogOptions
  private readonly now: () => number

  constructor(options: SessionLogOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** One uncached read. The tab refreshes explicitly; no poll lives here. */
  async log(sessionId: string, options: { fresh?: boolean } = {}): Promise<SessionMemoryLog> {
    const { api, commit } = this.options
    const warnings: PluginNotice[] = []
    const ovSessionId = commit.ovSessionId(sessionId)
    const peer = commit.actorPeer(sessionId) ?? null
    const request = peer === undefined || peer === null ? {} : { actorPeerId: peer }

    // The commit service already reads the session and its archive listing for
    // the pill, so the log rides on that answer instead of issuing a second
    // history walk.
    const status = await commit.status(sessionId, options)
    const [meta, tasks, summaries, pending] = await Promise.all([
      api.getSession(ovSessionId, request),
      api.listCommitTasks(ovSessionId, request),
      commit.summaries(sessionId, status.archives, ARCHIVE_LIMIT, options),
      readPendingQueue(ovSessionId, this.options.localState),
    ])

    if (!meta.ok) warnings.push({ code: 'sessionFailed', params: { error: meta.error ?? `HTTP ${meta.status}` } })
    if (!pending.available) {
      warnings.push({ code: 'pendingQueueUnavailable', params: { error: pending.error ?? 'unknown' } })
    }

    const sessionMeta = meta.result
    const sessionUri = sessionMeta ? resolveSessionUri(sessionMeta, ovSessionId, api.user) : null
    const latestState = status.latest?.state ?? null
    const state = deriveSessionState({
      serverOk: meta.ok,
      totalMessageCount: sessionMeta?.total_message_count ?? 0,
      messageCount: sessionMeta?.message_count ?? 0,
      pendingTokens: status.pendingTokens,
      commitCount: status.commitCount,
      archiveCount: status.archives.length,
      activeTask: (tasks.result ?? []).some(isActiveTask),
      latestArchiveState: latestState,
      pendingQueueCount: pending.total,
    })

    const log: SessionMemoryLog = {
      sessionId,
      ovSessionId,
      sessionUri,
      peer,
      state,
      threshold: status.threshold,
      meta: toMeta(status.pendingTokens, status.commitCount, status.lastCommitAt, sessionMeta),
      tasks: (tasks.result ?? []).slice().sort((left, right) => timestampOf(right) - timestampOf(left)).slice(0, TASK_LIMIT).map(toTask),
      archives: status.archives,
      summaries,
      pending,
      events: toEvents(sessionMeta, status.archives, status.archives.length > 0 ? summaries : [], pending.items.length > 0 ? pending.items[0]?.createdAt ?? null : null),
      warnings,
      observedAt: new Date(this.now()).toISOString(),
      queueSource: 'official-plugin',
    }
    return log
  }
}

/**
 * The one state the log reports.
 *
 * Precedence matters, and is the whole point of this function:
 *
 *  1. an unreadable server has no knowable state;
 *  2. a queued write means the server has not received it yet, regardless of
 *     what the stored metadata says;
 *  3. active work beats settled facts;
 *  4. a failed newest extraction is a real loss and outranks "not committed";
 *  5. otherwise the normal lifecycle — empty, accumulating, committed.
 */
export function deriveSessionState(input: {
  serverOk: boolean
  totalMessageCount: number
  messageCount: number
  pendingTokens: number
  commitCount: number
  archiveCount: number
  activeTask: boolean
  latestArchiveState: 'done' | 'failed' | 'pending' | 'unknown' | null
  pendingQueueCount: number
}): SessionMemoryState {
  if (!input.serverOk) return 'unknown'
  if (input.pendingQueueCount > 0) return 'queued'
  // A newest archive still pending is live extraction. A newest archive that
  // failed is a terminal loss and outranks the count gap: `commit_count` only
  // advances on successful extraction, so `archiveCount > commitCount` is the
  // ordinary shape of a failed commit, not evidence that another one is running.
  if (input.activeTask || input.latestArchiveState === 'pending') return 'extracting'
  if (input.latestArchiveState === 'failed') return 'failed'
  if (input.archiveCount > input.commitCount) return 'extracting'
  if (input.totalMessageCount === 0 && input.messageCount === 0 && input.commitCount === 0) return 'no-messages'
  if (input.pendingTokens > 0 || input.messageCount > 0 || input.commitCount === 0) return 'not-committed'
  return 'committed'
}

function timestampOf(task: OvCommitTask): number {
  if (typeof task.created_at === 'number' && Number.isFinite(task.created_at)) return task.created_at
  if (typeof task.created_at_iso === 'string') {
    const parsed = Date.parse(task.created_at_iso)
    if (!Number.isNaN(parsed)) return parsed / 1000
  }
  return 0
}

function toMeta(
  pendingTokens: number,
  commitCount: number,
  lastCommitAt: string | null,
  meta: OvSessionMeta | null,
): SessionLogMeta {
  const memories = meta?.memories_extracted
  const llm = meta?.llm_token_usage
  return {
    messageCount: meta?.message_count ?? 0,
    totalMessageCount: meta?.total_message_count ?? 0,
    commitCount,
    pendingTokens,
    keepRecentCount: typeof meta?.keep_recent_count === 'number' ? meta.keep_recent_count : null,
    createdAt: meta?.created_at ?? null,
    updatedAt: meta?.updated_at ?? null,
    lastMessageAt: meta?.last_message_at ?? null,
    lastCommitAt: lastCommitAt ?? meta?.last_commit_at ?? null,
    lastAutoCommitAt: textOrNull(meta?.last_auto_commit_at),
    memoriesExtracted:
      memories === undefined
        ? null
        : {
            total: numberOr(memories.total, 0),
            memoryWrite: numberOr(memories.memory_write, 0),
            memoryEdit: numberOr(memories.memory_edit, 0),
          },
    llmTokens:
      llm === undefined
        ? null
        : {
            prompt: numberOr(llm.prompt_tokens, 0),
            completion: numberOr(llm.completion_tokens, 0),
            total: numberOr(llm.total_tokens, 0),
          },
  }
}

function toTask(task: OvCommitTask): SessionLogTask {
  return {
    taskId: typeof task.task_id === 'string' ? task.task_id : 'unknown',
    status: typeof task.status === 'string' ? task.status : 'unknown',
    stage: typeof task.stage === 'string' && task.stage.length > 0 ? task.stage : null,
    error: typeof task.error === 'string' && task.error.length > 0 ? task.error : null,
    createdAt: textOrNull(task.created_at_iso) ?? isoFromSeconds(task.created_at),
    updatedAt: textOrNull(task.updated_at_iso) ?? isoFromSeconds(task.updated_at),
    processingSeconds:
      typeof task.processing_seconds === 'number' && Number.isFinite(task.processing_seconds)
        ? Math.round(task.processing_seconds)
        : null,
    archiveUri: textOrNull(task.result?.archive_uri),
    memoryDiffUri: textOrNull(task.result?.memory_diff_uri),
  }
}

/**
 * A timeline of timestamped facts, newest first.
 *
 * This is not a full state-transition audit — the server does not retain one —
 * so every row is a fact it (or the local queue) actually recorded. The UI says
 * "recent activity" rather than claiming a state machine history.
 */
export function toEvents(
  meta: OvSessionMeta | null,
  archives: CommitArchive[],
  summaries: ArchiveSummary[],
  oldestPendingAt: string | null,
): SessionLogEvent[] {
  const events: SessionLogEvent[] = []
  const push = (at: string | null, kind: SessionLogEvent['kind'], detail: string | null = null): void => {
    const value = textOrNull(at)
    if (value !== null) events.push({ at: value, kind, detail })
  }
  push(meta?.created_at ?? null, 'created')
  push(meta?.last_message_at ?? null, 'message')
  push(textOrNull(meta?.last_auto_commit_at), 'auto-commit')
  // The archive rows below already carry the last commit's time; keep the
  // metadata row only when no archive listing was available (legacy server).
  if (archives.length === 0) push(meta?.last_commit_at ?? null, 'commit')
  const failedByUri = new Map(summaries.filter((entry) => entry.state === 'failed').map((entry) => [entry.archiveUri, entry]))
  for (const archive of archives) {
    push(archive.modTime, 'commit', archive.archiveId)
    const failed = failedByUri.get(archive.archiveUri)
    if (failed !== undefined) push(failed.failure?.failedAt ?? archive.modTime, 'failed', failed.failure?.stage ?? null)
  }
  push(oldestPendingAt, 'queued')
  return events
    .slice()
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, EVENT_LIMIT)
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isoFromSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
