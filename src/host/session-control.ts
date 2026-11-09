/**
 * F10: read-only capture state, force commit and failed-archive diagnosis.
 *
 * ## What is honestly possible on this stack
 *
 * Capture happens **in-process** in `@openviking/dsh-memory-plugin`: it
 * subscribes to `session/event` and calls its own `runtime.capture()` /
 * `runtime.maybeCommit()`. The plugin publishes exactly one service
 * (`openvikingMemory`) with no pause/resume/force-commit API, and the server has
 * no per-session capture concept for DSH. Mutating another plugin's private
 * runtime state is rejected by design (`docs/api-v05.md` §3.4), so v0.5:
 *
 *   - **displays** the resolved capture flags from the runtime's `states` view;
 *   - explains that pause/resume needs an upstream API
 *     (`runtime.setCaptureEnabled(session, boolean)`) which does not exist;
 *   - offers force commit, which is the only supported control, always through
 *     the prepare/confirm/execute protocol.
 *
 * ## Force commit is "flush what the server already has"
 *
 * Phase 1 (archive) completes synchronously and the response says `accepted`
 * with a task id; extraction runs in the background and may fail. The official
 * plugin also auto-commits on its own thresholds, so a manual commit can make a
 * later automatic one a no-op. The host therefore runs one commit per session at
 * a time and never retries: a `412 FAILED_PRECONDITION` means a previous archive
 * failed, and retrying that archive is not implemented by the installed server
 * builds (`docs/api-v05.md` §3.2) — the UI shows the diagnosis instead.
 */
import type {
  ArchiveState,
  CaptureState,
  FailedArchiveDiagnosis,
  ForceCommitFacts,
  PluginNotice,
  SessionControlPayload,
} from '../shared/protocol.ts'
import type { CommitService } from './commit-service.ts'
import type { OpenVikingApi, OvCommitSessionResult, OvTask } from './openviking-api.ts'

export interface SessionControlOptions {
  api: OpenVikingApi
  commit: CommitService
  now?: () => number
}

/** The result of one force commit attempt, mapped for the write service. */
export interface ForceCommitOutcome {
  ok: boolean
  /** `accepted` | `skipped` | `failed`. */
  status: 'accepted' | 'skipped' | 'failed'
  taskId: string | null
  task: OvTask | null
  archiveUri: string | null
  /** A stable code for the failure reason, e.g. `failed-precondition`. */
  code: string | null
  message: string | null
  warnings: PluginNotice[]
}

export class SessionControlService {
  private readonly options: SessionControlOptions
  private readonly now: () => number

  constructor(options: SessionControlOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /**
   * The official plugin's resolved capture flags for one session.
   *
   * Read-only. `null` fields mean the mounted plugin does not expose that field
   * on this generation, not that capture is off.
   */
  captureState(sessionId: string): CaptureState {
    const config = this.options.commit.pluginConfig(sessionId)
    const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
    const number = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null
    return {
      mounted: config !== null,
      enabled: bool(config?.enabled),
      autoCapture: bool(config?.autoCapture ?? config?.capture),
      captureAssistantTurns: bool(config?.captureAssistantTurns),
      captureToolResults: bool(config?.captureToolResults),
      commitTokenThreshold: number(config?.commitTokenThreshold),
      // Binding: no runtime control exists, so the UI must not pretend.
      canPause: false,
    }
  }

  /** Force-commit facts: the dialog shows these before the user confirms. */
  async facts(sessionId: string): Promise<ForceCommitFacts> {
    const ovSessionId = this.options.commit.ovSessionId(sessionId)
    const status = await this.options.commit.status(sessionId, { fresh: true }).catch(() => null)
    const meta = await this.options.api
      .getSession(ovSessionId, { actorPeerId: this.options.commit.actorPeer(sessionId) })
      .catch(() => null)
    return {
      sessionId,
      ovSessionId,
      pendingTokens: status?.pendingTokens ?? meta?.result?.pending_tokens ?? null,
      messageCount: meta?.result?.message_count ?? null,
      commitCount: status?.commitCount ?? meta?.result?.commit_count ?? null,
      lastCommitAt: status?.lastCommitAt ?? meta?.result?.last_commit_at ?? null,
    }
  }

  /**
   * The full read model for the F10 row: capture state, session facts and the
   * failed-archive diagnosis (the newest archive's terminal marker plus the
   * failed task's error, sanitized).
   */
  async read(sessionId: string): Promise<SessionControlPayload> {
    const warnings: PluginNotice[] = []
    let session: ForceCommitFacts | null = null
    let failedArchive: FailedArchiveDiagnosis | null = null
    try {
      session = await this.facts(sessionId)
    } catch (error) {
      warnings.push({ code: 'sessionFailed', params: { error: message(error) } })
    }
    try {
      const commits = await this.options.commit.commits(sessionId, 3)
      const latest = commits.status.latest
      if (latest !== null && latest.state === 'failed') {
        const failedTask = commits.tasks.find((task) => task.status === 'failed') ?? null
        failedArchive = {
          archiveUri: latest.archiveUri,
          taskId: failedTask?.task_id ?? null,
          error: latest.failure?.error ?? failedTask?.error ?? 'extraction failed',
          state: latest.state,
          memoryDiffUri:
            failedTask?.result?.memory_diff_uri ??
            (latest.archiveUri.length > 0 ? `${latest.archiveUri}/memory_diff.json` : null),
        }
      } else if (latest === null) {
        // No archives at all is not a failure; leave null. A failed task without
        // an archive marker is the legacy server fallback.
        const failedTask = commits.tasks.find((task) => task.status === 'failed') ?? null
        if (failedTask !== null) {
          failedArchive = {
            archiveUri: failedTask.result?.archive_uri ?? null,
            taskId: failedTask.task_id,
            error: failedTask.error ?? 'extraction failed',
            state: 'failed',
            memoryDiffUri: failedTask.result?.memory_diff_uri ?? null,
          }
        }
      }
    } catch (error) {
      warnings.push({ code: 'sessionFailed', params: { error: message(error) } })
    }
    return {
      sessionId,
      ovSessionId: this.options.commit.ovSessionId(sessionId),
      capture: this.captureState(sessionId),
      session,
      failedArchive,
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /**
   * Execute one force commit after the confirmation token was consumed.
   *
   * Always `keep_recent_count: 0` (archive everything, like the official
   * plugin), always with the session's actor peer so peer-scoped workspaces
   * archive into the right scope. Never retries, never hides a skipped result.
   */
  async forceCommit(sessionId: string): Promise<ForceCommitOutcome> {
    const ovSessionId = this.options.commit.ovSessionId(sessionId)
    const actorPeerId = this.options.commit.actorPeer(sessionId)
    const response = await this.options.api.commitSession(
      ovSessionId,
      { keep_recent_count: 0 },
      actorPeerId === undefined ? {} : { actorPeerId },
    )
    if (!response.ok) {
      const code =
        response.status === 412
          ? 'failed-precondition'
          : response.status === 404
            ? 'not-supported'
            : response.status === 403
              ? 'forbidden'
              : 'rejected-by-server'
      return {
        ok: false,
        status: 'failed',
        taskId: null,
        task: null,
        archiveUri: null,
        code,
        message: response.error ?? `HTTP ${response.status}`,
        warnings: [],
      }
    }
    const result: OvCommitSessionResult = response.result ?? {}
    if (result.status === 'skipped') {
      return {
        ok: true,
        status: 'skipped',
        taskId: null,
        task: null,
        archiveUri: null,
        code: null,
        message: result.reason ?? 'no_messages',
        warnings: [{ code: 'commitSkipped', params: { reason: result.reason ?? 'no_messages' } }],
      }
    }
    const taskId = typeof result.task_id === 'string' && result.task_id.length > 0 ? result.task_id : null
    const task = taskId === null ? null : await this.options.api.getTask(taskId).then((task) => task.result ?? null)
    return {
      ok: true,
      status: 'accepted',
      taskId,
      task,
      archiveUri: result.archive_uri ?? null,
      code: null,
      message: null,
      warnings: [],
    }
  }

  /** `archive_001`-style state from the commit service, for the diagnosis row. */
  static stateOf(value: unknown): ArchiveState | null {
    return value === 'done' || value === 'failed' || value === 'pending' || value === 'unknown' ? value : null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
