/**
 * Commit-status derivation from the two signals the UI actually has: the host's
 * derived status, and the raw `session_commit` task list.
 *
 * The task list is the only place a failed extraction is observable. When memory
 * extraction fails, OpenViking still writes the archive and still advances
 * `commit_count`, so every other signal looks identical to success: the count
 * matches the archive count, the archive exists, and only `memory_diff.json` is
 * missing. That is precisely why this needs to be surfaced rather than inferred.
 *
 * Pure and React-free on purpose — the client imports it, and the unit tests
 * import it directly.
 */
import type { CommitPhase, CommitStatus, CommitTask } from './protocol.ts'

/** A task that has not settled yet. */
export function isActiveTask(task: CommitTask): boolean {
  return task.status === 'pending' || task.status === 'running' || task.status === 'cancelling'
}

/** A task that ended without producing memories. */
export function isFailedTask(task: CommitTask): boolean {
  return task.status === 'failed' || task.status === 'cancelled'
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
 *  2. a task is still running — work in progress outranks an older failure;
 *  3. the newest task failed — the archive exists, its memories do not;
 *  4. otherwise the host's derived phase.
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
  const newest = newestTask(input.tasks)
  if (newest !== null && isFailedTask(newest)) return 'errored'
  return input.status?.phase ?? 'idle'
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
  const raw = (task.error ?? '').trim()
  if (raw.length === 0) return task.stage ? `抽取失败（阶段：${task.stage}）` : '抽取失败（服务端未给出原因）'
  const message = /['"]message['"]\s*:\s*['"]([^'"]+)['"]/.exec(raw)
  if (message?.[1]) return message[1].trim()
  const firstLine = raw.split('\n')[0] ?? raw
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
