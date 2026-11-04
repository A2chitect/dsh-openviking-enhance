/**
 * Commit-status derivation from the signals the UI actually has: the newest
 * archive's terminal state (`.done` / `.failed.json`), the host's derived
 * status, and the raw `session_commit` task list.
 *
 * The archive marker is the durable fact. Task records are pruned by the server:
 * `completed`/`cancelled` after roughly 24 hours, `failed` after roughly 7 days.
 * That asymmetry means the newest *remaining* task is not necessarily the newest
 * commit — a stale failure can outlive every later success, and after 7 days a
 * real failure can disappear from the task list while its archive keeps the
 * marker. Tasks are therefore used for live progress and as the legacy fallback
 * when the host cannot read the archive markers.
 *
 * Pure and React-free on purpose — the client imports it, and the unit tests
 * import it directly.
 */
import type { CommitPhase, CommitStatus, CommitTask } from './protocol.ts'

/** A task that has not settled yet. */
export function isActiveTask(task: CommitTask): boolean {
  return task.status === 'pending' || task.status === 'running' || task.status === 'cancelling'
}

/** A task that ended in failure. Cancellation is deliberately not failure. */
export function isFailedTask(task: CommitTask): boolean {
  return task.status === 'failed'
}

/** A task the user cancelled; the archive exists but no memories were extracted. */
export function isCancelledTask(task: CommitTask): boolean {
  return task.status === 'cancelled'
}

/** Newest task first; tasks without a timestamp keep their given order at the end. */
export function newestFirst(tasks: CommitTask[]): CommitTask[] {
  return [...tasks].sort((a, b) => timestampOf(b) - timestampOf(a))
}

export function newestTask(tasks: CommitTask[]): CommitTask | null {
  return newestFirst(tasks)[0] ?? null
}

export function failedTasks(tasks: CommitTask[]): CommitTask[] {
  return newestFirst(tasks.filter(isFailedTask))
}

function timestampOf(task: CommitTask): number {
  if (typeof task.created_at === 'number') return task.created_at
  if (typeof task.created_at_iso === 'string') {
    const parsed = Date.parse(task.created_at_iso)
    if (!Number.isNaN(parsed)) return parsed / 1000
  }
  return 0
}

/**
 * Phase precedence, highest first:
 *
 *  1. the host could not answer at all — nothing else is knowable;
 *  2. a task is still running — work in progress outranks everything settled;
 *  3. the newest archive says `failed` — its memories are gone;
 *  4. it says `done` — the counter may lag the marker, the marker wins;
 *  5. otherwise a failed task, when no later commit has superseded it. This
 *     covers servers without markers and the short window before a modern
 *     server writes `.failed.json`;
 *  6. the newest archive is still `pending` — extraction has not finished;
 *  7. otherwise the host's count-based phase.
 *
 * A failure that a later commit has already superseded does not change the pill:
 * the popover still lists it, because those memories were genuinely lost.
 */
export function deriveClientPhase(input: {
  error: string | null
  status: CommitStatus | null
  tasks: CommitTask[]
}): CommitPhase {
  if (input.error) return 'failed'
  if (input.tasks.some(isActiveTask)) return 'extracting'

  const latest = input.status?.latest ?? null
  if (latest !== null) {
    if (latest.state === 'failed') return 'errored'
    if (latest.state === 'done') return 'done'
  }

  // The durable marker is absent or unreadable. A failed task may be the only
  // evidence — on a legacy server, or in the short window before a modern
  // server writes `.failed.json`. Never let a failure that a later commit has
  // already superseded own the pill: completed tasks are pruned after 24 h
  // while failed ones survive 7 days, so the newest remaining task can be an
  // arbitrarily old failure.
  const newest = newestTask(input.tasks)
  if (newest !== null && isFailedTask(newest) && !isSupersededByLaterCommit(newest, input.status)) {
    return 'errored'
  }
  if (latest?.state === 'pending') return 'extracting'
  return input.status?.phase ?? 'idle'
}

/**
 * Whether a later commit has already superseded this task.
 *
 * OpenViking stamps `last_commit_at` when a commit archives (before its task is
 * created) and again when extraction finishes successfully. So a failure from
 * the current commit is created *after* `last_commit_at`, while any failure
 * followed by a later commit is older than it.
 *
 * A task with no readable timestamp is never treated as superseded: the pill
 * would rather surface a real loss than hide one.
 */
export function isSupersededByLaterCommit(task: CommitTask, status: CommitStatus | null): boolean {
  const lastCommit = status?.lastCommitAt ? Date.parse(status.lastCommitAt) : Number.NaN
  if (!Number.isFinite(lastCommit)) return false
  const created = taskTimestampMs(task)
  if (!Number.isFinite(created)) return false
  return created < lastCommit
}

/** A task's creation time in milliseconds, or NaN when the server gave none. */
function taskTimestampMs(task: CommitTask): number {
  if (typeof task.created_at === 'number' && Number.isFinite(task.created_at)) {
    return task.created_at * 1000
  }
  if (typeof task.created_at_iso === 'string') {
    const parsed = Date.parse(task.created_at_iso)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Number.NaN
}

/**
 * The provider's message out of a server error string.
 *
 * OpenViking stores whatever the provider raised, which for an LLM failure is a
 * Python-repr of the HTTP body:
 *
 *   Error code: 400 - {'error': {'message': 'Thinking mode does not support
 *   this tool_choice (request_id: …)', 'type': 'invalid_request_error', …}}
 *
 * The message field is the only part a human needs, so it is unwrapped when
 * present; otherwise the text is trimmed for display and the caller keeps the
 * full string for the tooltip.
 */
export function describeFailure(task: CommitTask): string {
  return describeFailureText(task.error ?? '')
}

/**
 * The displayable reason out of one raw server error string.
 *
 * Split from `describeFailure` because archive failures carry their error in
 * `.failed.json` rather than in a task record, and both halves need the same
 * unwrapping rule.
 */
export function describeFailureText(raw: string): string {
  const text = raw.trim()
  // No copy lives in this module: both halves import it, and only one of them
  // has a language. An error with no message asks the caller for its own words.
  if (text.length === 0) return ''
  const message = /['"]message['"]\s*:\s*['"]([^'"]+)['"]/.exec(text)
  if (message?.[1]) return message[1].trim()
  const firstLine = text.split('\n')[0] ?? text
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

/** How long a task took, in whole seconds, when the server reported it. */
export function durationSeconds(task: CommitTask): number | null {
  const seconds = task.processing_seconds
  return typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds) : null
}

/** Wall-clock time of a task, short form. */
export function taskTime(task: CommitTask): string | null {
  const iso = task.created_at_iso
  if (typeof iso !== 'string') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
