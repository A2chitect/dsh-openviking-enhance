/**
 * Per-session OpenViking commit status.
 *
 * Mounted into `conversation.composer.dock` (list, session scope) — the flex row
 * directly under the composer, next to the shell's own stats pills — so it is
 * scoped to the session the user is looking at.
 *
 * What it shows, and where each fact comes from:
 *   pending tokens / threshold  → `GET /api/v1/sessions/dsh-<id>`
 *   commit count, last commit   → same call
 *   phase                       → the newest archive's `.done` / `.failed.json`
 *                                 marker, else the derived count phase
 *   affected memories on click  → `history/archive_00N/memory_diff.json`
 *
 * The plugin never learns about a commit from DSH: the memory plugin discards
 * the commit response and logs at `debug`, which the desktop app filters out.
 * Polling the server is therefore not a shortcut, it is the only reliable path —
 * but it is adaptive: 5 s while extraction is running, 30 s when idle, paused
 * in a hidden tab, with exponential backoff after failures (`poll-policy.ts`),
 * plus an immediate refresh when the pill is opened or the tab regains focus.
 *
 * Presentation follows the default pills exactly (see `styles.ts`): same font
 * metrics, tertiary label colour, transparent borderless 999px capsule, 14px
 * currentColor icon, tabular figures, same hover/expanded background. It renders
 * as the last item of the row, so the shell's own pills and their centring are
 * left untouched. The icon is the shell's own `IconArchiveOutlineRegular` — a
 * commit in OpenViking produces an `archive_00N`, so it is also the honest glyph —
 * taken from the sidebar row's own mark (`openviking-icon.tsx`) so the two mounts
 * read as the same thing. The label leads with "OV" because a commit pill is
 * otherwise indistinguishable from a git commit's.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TIMELINE_DEFAULT,
  TIMELINE_MAX,
  type ArchiveFailure,
  type ArchiveSummary,
  type CommitArchive,
  type CommitStatus,
  type CommitTask,
  type MemoryDiff,
  type MemoryDiffEntry,
  type MemoryDiffSummary,
} from '../shared/protocol.ts'
import { fetchCommits, fetchDiff, type CommitsPayload } from './host-api.ts'
import { t } from './locale.ts'
import { nextPollDelay } from './poll-policy.ts'
import {
  deriveClientPhase,
  describeFailure,
  describeFailureText,
  durationSeconds,
  failedTasks,
  isActiveTask,
  taskTime,
} from '../shared/commit-state.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'

export interface CommitStatusProps {
  sessionId?: string
}

/** One failure row, from an archive marker or (legacy) a task record. */
interface FailureView {
  key: string
  time: string | null
  duration: number | null
  reason: string
  raw: string | null
  cancelled: boolean
}

export function CommitStatusPill({ sessionId }: CommitStatusProps) {
  const [status, setStatus] = useState<CommitStatus | null>(null)
  const [tasks, setTasks] = useState<CommitTask[]>([])
  const [summaries, setSummaries] = useState<CommitsPayload['summaries']>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<MemoryDiff | null>(null)
  const [diffPending, setDiffPending] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** How many commit records to fetch counts for; the popover widens this on demand. */
  const [summaryLimit, setSummaryLimit] = useState(TIMELINE_DEFAULT)
  const wrap = useRef<HTMLSpanElement | null>(null)
  /** Set by the polling effect so opening the popover can refresh immediately. */
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let errorCount = 0
    let inFlight = false
    const controller = new AbortController()

    function schedule(delay: number): void {
      if (cancelled || delay <= 0) return
      timer = setTimeout(() => void run(false), delay)
    }

    async function run(fresh: boolean): Promise<void> {
      if (cancelled || inFlight) return
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      inFlight = true
      const result = await fetchCommits(id, summaryLimit, { fresh, signal: controller.signal })
      inFlight = false
      if (cancelled) return

      let working = false
      if (result.ok) {
        setStatus(result.status)
        setTasks(result.tasks)
        setSummaries(result.summaries)
        setError(null)
        errorCount = 0
        working = result.tasks.some(isActiveTask)
      } else {
        setError(result.error)
        errorCount += 1
      }
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(nextPollDelay({ working, hidden, errorCount }))
    }

    refreshRef.current = () => void run(true)

    const onVisibility = (): void => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Stop paying for polls while the tab is in the background. The next
        // visibility event refreshes immediately.
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return
      }
      refreshRef.current?.()
    }
    const onFocus = (): void => {
      refreshRef.current?.()
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
    void run(true)

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
      refreshRef.current = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
    }
  }, [sessionId, summaryLimit])

  useEffect(() => {
    if (!open) return
    refreshRef.current?.()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openArchive = useCallback(
    async (archiveUri: string) => {
      if (!sessionId) return
      setSelected(archiveUri)
      setDiff(null)
      setDiffPending(true)
      const result = await fetchDiff(sessionId, archiveUri)
      setDiffPending(false)
      if (result.ok) setDiff(result.diff)
      else setError(result.error)
    },
    [sessionId],
  )

  if (!sessionId) return null

  // The archive markers are the accurate signal and every poll already carries
  // them, so the phase is derived from those rather than from the task list:
  // `commit_count` advances when the archive is written, so a failed or
  // in-flight extraction is invisible to a count comparison. See
  // shared/commit-state.ts.
  const running = tasks.filter(isActiveTask)
  const phase = deriveClientPhase({ error, status, tasks })
  const text = phaseLabel(phase, status)
  const archives = status ? [...status.archives].reverse() : []
  const summaryByUri = new Map(summaries.map((entry) => [entry.archiveUri, entry]))
  // Newest first; only the newest few until the user asks for the rest.
  const visibleTimeline = summaryLimit > TIMELINE_DEFAULT ? archives : archives.slice(0, TIMELINE_DEFAULT)

  // A failed archive state can only come from `.failed.json`, so it also proves
  // marker support. A diff-only "done" may be a legacy server, which still needs
  // the task list for its failures.
  const archiveMode =
    status?.latest?.markers === true || summaries.some((entry) => entry.state === 'failed')
  const failedArchives = summaries.filter((entry) => entry.state === 'failed')
  const failureViews = archiveMode
    ? archiveFailureViews(failedArchives, status?.archives ?? [])
    : taskFailureViews(tasks)
  const failureRows = failureViews.filter((view) => !view.cancelled)
  const latestFailure = status?.latest?.state === 'failed' ? status.latest.failure : null
  const selectedEntry = selected !== null ? (summaryByUri.get(selected) ?? null) : null

  return (
    <span className="ove-dock" ref={wrap} data-dsh-plugin="openviking-enhance-status">
      <button
        type="button"
        className={`ove-pill${phase === 'errored' ? ' ove-pill-errored' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('pill.aria', { text })}
        title={tooltip(status, error, phase, failureRows, latestFailure)}
        onClick={() => setOpen((value) => !value)}
      >
        <OpenVikingIcon size={14} strokeWidth={1} />
        <span className={`ove-label${phase === 'extracting' ? ' ove-pulse' : ''}`}>
          {'OV'}
          <span className="ove-sep" aria-hidden="true">
            ·
          </span>
          {text}
        </span>
      </button>
      {open ? (
        <div className="ove-pop" role="dialog" aria-label={t('pill.detailTitle')}>
          <div className="ove-pop-title">
            <span className="ove-pop-title-label">
              <OpenVikingIcon size={14} strokeWidth={1} />
              {t('pill.detailHeading')}
            </span>
            <span className="ove-row-count">{status ? t('pill.commitCount', { count: status.commitCount }) : '—'}</span>
          </div>
          <div className="ove-pop-rule" aria-hidden="true" />
          <dl className="ove-facts">
            <dt>{t('pill.session')}</dt>
            <dd>
              <code>{status?.ovSessionId ?? '—'}</code>
            </dd>
            <dt>{t('pill.pending')}</dt>
            <dd>
              {status ? `${status.pendingTokens}${status.threshold ? ` / ${status.threshold}` : ''} tokens` : '—'}
            </dd>
            <dt>{t('pill.lastCommit')}</dt>
            <dd>{status?.lastCommitAt ? formatTime(status.lastCommitAt) : '—'}</dd>
            {running.length > 0 ? (
              <>
                <dt>{t('pill.inProgress')}</dt>
                <dd>{running.map((task) => task.status).join(', ')}</dd>
              </>
            ) : null}
          </dl>

          {error ? <div className="ove-facts ove-empty">{t('pill.readFailed', { error })}</div> : null}

          {failureRows.length > 0 ? (
            <div className="ove-section">
              <div className="ove-section-title ove-error">{t('pill.failedExtractions', { count: failureRows.length })}</div>
              <div className="ove-empty">{t('pill.failedExtractionsHint')}</div>
              {failureRows.slice(0, 4).map((failure) => (
                <div className="ove-failure" key={failure.key}>
                  <div className="ove-failure-head">
                    <span>{failure.time ?? '—'}</span>
                    <span className="ove-row-count">
                      {failure.duration !== null ? `${failure.duration}s` : ''}
                    </span>
                  </div>
                  <div className="ove-failure-msg" title={failure.raw ?? undefined}>
                    {failure.reason}
                  </div>
                </div>
              ))}
              {failureRows.length > 4 ? <div className="ove-empty">{t('pill.moreFailures', { count: failureRows.length - 4 })}</div> : null}
            </div>
          ) : null}

          <div className="ove-section">
            <div className="ove-section-title">
              {t('pill.commits')}
              {archives.length > visibleTimeline.length ? t('pill.commitsNewest', { shown: visibleTimeline.length, total: archives.length }) : t('pill.commitsTotal', { total: archives.length })}
            </div>
            {archives.length === 0 ? (
              <div className="ove-empty">{t('pill.noCommits')}</div>
            ) : (
              <div className="ove-timeline">
                {visibleTimeline.map((archive) => {
                  const entry = summaryByUri.get(archive.archiveUri) ?? null
                  const failed = entry?.state === 'failed'
                  const isNewest = archive.archiveUri === archives[archives.length - 1]?.archiveUri
                  return (
                    <button
                      key={archive.archiveId}
                      type="button"
                      className={`ove-tl-row${failed ? ' ove-tl-row-failed' : ''}`}
                      title={failed ? archiveFailureText(entry?.failure ?? null) : undefined}
                      onClick={() => void openArchive(archive.archiveUri)}
                    >
                      <span className="ove-tl-dot" aria-hidden="true" />
                      <span className="ove-tl-time">{formatShortTime(archive.modTime)}</span>
                      <span className={`ove-tl-counts${entry?.summary ? '' : ' ove-muted'}`}>
                        {timelineLabel(entry, isNewest && running.length > 0)}
                      </span>
                      <span className="ove-tl-open">{t('pill.affected')}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {archives.length > visibleTimeline.length ? (
              <button type="button" className="ove-row ove-tl-more" onClick={() => setSummaryLimit(TIMELINE_MAX)}>
                <span>{t('pill.showAll', { total: archives.length })}</span>
                <span className="ove-row-count">↓</span>
              </button>
            ) : null}
          </div>

          {selectedEntry?.state === 'failed' ? <FailureDetail failure={selectedEntry.failure} /> : null}
          {diffPending ? <div className="ove-section ove-empty">{t('pill.readingDiff', { archive: selected ?? '' })}</div> : null}
          {diff ? <DiffView diff={diff} /> : null}
          {!diffPending && selected && !diff && selectedEntry?.state !== 'failed' ? (
            <div className="ove-section ove-empty">{t('pill.diffMissing')}</div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

/** Failure rows built from the durable archive markers. */
function archiveFailureViews(failures: ArchiveSummary[], archives: CommitArchive[]): FailureView[] {
  const modTimeByUri = new Map(archives.map((archive) => [archive.archiveUri, archive.modTime]))
  return failures.map((entry) => ({
    key: entry.archiveUri,
    time: formatShortTime(entry.failure?.failedAt ?? modTimeByUri.get(entry.archiveUri) ?? null),
    duration: null,
    reason: archiveFailureText(entry.failure),
    raw: entry.failure?.error ?? null,
    cancelled: isCancelledFailure(entry.failure),
  }))
}

/** Failure rows from task records — the fallback for servers without markers. */
function taskFailureViews(tasks: CommitTask[]): FailureView[] {
  return failedTasks(tasks).map((task) => ({
    key: task.task_id,
    time: taskTime(task),
    duration: durationSeconds(task),
    reason: failureReason(task),
    raw: task.error,
    cancelled: false,
  }))
}

function isCancelledFailure(failure: ArchiveFailure | null): boolean {
  return failure?.stage === 'cancelled'
}

function archiveFailureText(failure: ArchiveFailure | null): string {
  const reason = describeFailureText(failure?.error ?? '')
  if (reason.length > 0) return reason
  return failure?.stage ? t('pill.stageReason', { stage: failure.stage }) : t('pill.noReason')
}

function FailureDetail({ failure }: { failure: ArchiveFailure | null }) {
  const cancelled = isCancelledFailure(failure)
  return (
    <div className="ove-section">
      <div className={`ove-section-title${cancelled ? '' : ' ove-error'}`}>
        {cancelled ? t('pill.archive.cancelled') : t('pill.archive.failed')}
      </div>
      <div className="ove-failure">
        <div className="ove-failure-head">
          <span>{failure?.failedAt ? formatShortTime(failure.failedAt) : '—'}</span>
          <span className="ove-row-count">{failure?.stage ?? ''}</span>
        </div>
        <div className="ove-failure-msg" title={failure?.error ?? undefined}>
          {cancelled ? '' : archiveFailureText(failure)}
        </div>
      </div>
    </div>
  )
}

function DiffView({ diff }: { diff: MemoryDiff }) {
  const { summary } = diff
  return (
    <div className="ove-section">
      <div className="ove-section-title">
        {t('pill.diffSummary', { adds: summary.totalAdds, updates: summary.totalUpdates, deletes: summary.totalDeletes })}
      </div>
      <div className="ove-empty">{diff.archiveUri}</div>
      <Group title={t('pill.group.adds')} entries={diff.adds} />
      <Group title={t('pill.group.updates')} entries={diff.updates} />
      <Group title={t('pill.group.deletes')} entries={diff.deletes} />
      {summary.totalAdds + summary.totalUpdates + summary.totalDeletes === 0 ? (
        <div className="ove-empty">{t('pill.noMemoryChange')}</div>
      ) : null}
    </div>
  )
}

function Group({ title, entries }: { title: string; entries: MemoryDiffEntry[] }) {
  if (entries.length === 0) return null
  return (
    <details className="ove-group" open>
      <summary>
        {t('pill.groupTitle', { title, count: entries.length })}
      </summary>
      {entries.map((entry) => (
        <div className="ove-entry" key={entry.uri}>
          <div className="ove-uri">{entry.uri}</div>
          <div className="ove-type">{entry.memoryType}</div>
        </div>
      ))}
    </details>
  )
}

/**
 * One timeline row's right-hand text.
 *
 * The archive marker decides first: a failed extraction must not read as
 * "no detail", and a partial `memory_diff.json` does not make it successful.
 */
function timelineLabel(entry: ArchiveSummary | null, running: boolean): string {
  if (entry?.state === 'failed') {
    return isCancelledFailure(entry.failure) ? t('pill.archive.cancelled') : t('pill.archive.failed')
  }
  if (entry?.state === 'pending') return t('pill.phase.extracting')
  const summary = entry?.summary ?? null
  if (!summary) return running ? t('pill.phase.extracting') : t('pill.phase.noDetail')
  const parts: string[] = []
  if (summary.totalAdds > 0) parts.push(t('pill.phaseAdds', { count: summary.totalAdds }))
  if (summary.totalUpdates > 0) parts.push(t('pill.phaseUpdates', { count: summary.totalUpdates }))
  if (summary.totalDeletes > 0) parts.push(t('pill.phaseDeletes', { count: summary.totalDeletes }))
  if (parts.length === 0) return t('pill.phase.unchanged')
  return parts.join(' · ')
}

/** Archive timestamp, short form; the browser renders it in local time. */
function formatShortTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The reason a failed extraction shows, in the reader's language.
 *
 * `describeFailure` returns the server's own message and nothing else, so the
 * wording of "there was no message" is decided here rather than in shared code.
 */
function failureReason(task: CommitTask): string {
  const reason = describeFailure(task)
  if (reason.length > 0) return reason
  return task.stage ? t('pill.stageReason', { stage: task.stage }) : t('pill.noReason')
}

function phaseLabel(phase: string, status: CommitStatus | null): string {
  switch (phase) {
    case 'failed':
      return t('pill.label.failed')
    case 'errored':
      return status?.latest?.state === 'failed' && isCancelledFailure(status.latest.failure)
        ? t('pill.label.cancelled')
        : t('pill.label.errored')
    case 'extracting':
      return t('pill.label.extracting')
    case 'done':
      return t('pill.label.commits', { count: status?.commitCount ?? 0 })
    case 'pending':
      return status ? `${formatTokens(status.pendingTokens)}/${formatTokens(status.threshold ?? 0)}` : t('pill.label.pending')
    default:
      return t('pill.label.idle')
  }
}

function tooltip(
  status: CommitStatus | null,
  error: string | null,
  phase: string,
  failures: FailureView[],
  latestFailure: ArchiveFailure | null,
): string {
  if (error) return t('pill.tip.readFailed', { error })
  if (!status) return t('pill.tip.reading')

  const lines: string[] = [t('pill.tip.session', { id: status.ovSessionId })]
  if (phase === 'errored') {
    if (latestFailure) {
      lines.unshift(
        isCancelledFailure(latestFailure)
          ? t('pill.tip.cancelled')
          : t('pill.tip.failure', { reason: archiveFailureText(latestFailure) }),
      )
    } else if (failures[0]) {
      lines.unshift(
        failures[0].cancelled
          ? t('pill.tip.cancelled')
          : t('pill.tip.failure', { reason: failures[0].reason }),
      )
    }
  } else if (failures.length > 0) {
    // Historical failures are real losses, but they do not own the current
    // commit's state. Say so instead of calling them "the last extraction".
    lines.push(t('pill.tip.historyFailures', { count: failures.length }))
  } else {
    lines.push(t('pill.tip.pending', { tokens: `${status.pendingTokens}${status.threshold ? ` / ${status.threshold}` : ''}` }))
  }
  lines.push(t('pill.tip.commitCount', { count: status.commitCount }))
  if (status.lastCommitAt) lines.push(t('pill.tip.lastCommit', { time: formatTime(status.lastCommitAt) }))
  return lines.join('\n')
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
