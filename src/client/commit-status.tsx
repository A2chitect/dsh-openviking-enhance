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
import { fetchCommits, fetchDiff, fetchSessionControl, prepareWrite, type CommitsPayload } from './host-api.ts'
import { t } from './locale.ts'
import { nextPollDelay, startScheduledPoll } from './poll-policy.ts'
import {
  deriveClientPhase,
  describeFailure,
  describeFailureText,
  durationSeconds,
  failedTasks,
  isActiveTask,
  taskTime,
} from '../shared/commit-state.ts'
import { lineDiff, type DiffRow } from '../shared/text-diff.ts'
import { copyText } from './clipboard.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'
import { VikingUriLink } from './viking-uri-link.tsx'
import { ensureScope, useScope } from './scope-store.ts'
import { ensureSessionScope, useSessionScope } from './session-scope.tsx'
import { canSelectPanel, openNative } from './native-store.ts'
import { openWriteConfirm } from './write-store.ts'
import { writeErrorText } from './locale.ts'

export interface CommitStatusProps {
  sessionId?: string
}

/** One failure row, from an archive marker or (legacy) a task record. */
interface FailureView {
  key: string
  /** The server task id that archived this failure, when one is still retained. */
  taskId: string | null
  time: string | null
  duration: number | null
  reason: string
  raw: string | null
  cancelled: boolean
}

/**
 * v0.9 review B3: the force-commit gate. Same three facts as the preview actions:
 * writes on, transport present, and this session not observed under another scope.
 */
export function forceCommitEnabled(input: {
  writesEnabled: boolean
  transport: boolean
  scopeMismatch: boolean
}): boolean {
  return input.writesEnabled && input.transport && !input.scopeMismatch
}

export function CommitStatusPill({ sessionId }: CommitStatusProps) {
  const [status, setStatus] = useState<CommitStatus | null>(null)
  const [tasks, setTasks] = useState<CommitTask[]>([])
  const [summaries, setSummaries] = useState<CommitsPayload['summaries']>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<MemoryDiff | null>(null)
  const [diffPending, setDiffPending] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [captureLine, setCaptureLine] = useState<string | null>(null)
  const scope = useScope()
  // v0.9: a session last seen under another scope must not offer a force-commit
  // (the write would land under a different identity than the conversation was
  // captured under); the mismatch banner explains how to switch back.
  const sessionScope = useSessionScope(sessionId ?? '')
  const scopeMismatch = sessionScope.payload?.mismatch === true
  // v0.9 review B3: a switch must force-refetch the session-scope facts; the
  // previous answer is scope-dependent state.
  const scopeKey = scope.scope?.identity.fingerprint ?? ''
  useEffect(() => {
    if (!sessionId) return
    void ensureSessionScope(sessionId, true)
  }, [sessionId, scopeKey])
  const [selected, setSelected] = useState<string | null>(null)
  /** How many commit records to fetch counts for; the popover widens this on demand. */
  const [summaryLimit, setSummaryLimit] = useState(TIMELINE_DEFAULT)
  const wrap = useRef<HTMLSpanElement | null>(null)
  /** The newest archive the user asked for; late replies from older clicks lose. */
  const diffGeneration = useRef(0)
  /** Set by the polling effect so opening the popover can refresh immediately. */
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    let cancelled = false
    let inFlight = false
    let lastErrorCount = 0
    let lastWorking = false
    const controller = new AbortController()

    async function run(fresh: boolean): Promise<void> {
      if (cancelled || inFlight) return
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
        lastErrorCount = 0
        working = result.tasks.some(isActiveTask)
      } else {
        setError(result.error)
        lastErrorCount += 1
      }
      lastWorking = working
    }
    // The scheduler owns visibility and the "do not schedule" contract, so a
    // hidden document owns no timer and the active cadence follows the latest
    // successful answer (review S2 pattern, shared with Activity).
    const dispose = startScheduledPoll(() => run(false), () =>
      nextPollDelay({ working: lastWorking, hidden: false, errorCount: lastErrorCount }),
    )
    refreshRef.current = () => void run(true)
    void run(false)
    return () => {
      cancelled = true
      controller.abort()
      refreshRef.current = null
      dispose()
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
      const ticket = (diffGeneration.current += 1)
      setSelected(archiveUri)
      setDiff(null)
      setDiffPending(true)
      const result = await fetchDiff(sessionId, archiveUri)
      if (ticket !== diffGeneration.current) return
      setDiffPending(false)
      if (result.ok) setDiff(result.diff)
      else setError(result.error)
    },
    [sessionId],
  )

  const openSessionId = sessionId !== undefined && open ? sessionId : null
  // F10: read-only capture state, fetched only while the popover is open. The
  // pause/resume gap is stated in the UI; the official plugin exposes no API.
  useEffect(() => {
    if (openSessionId === null) return
    let cancelled = false
    void fetchSessionControl(openSessionId).then((answer) => {
      if (cancelled || !answer.ok) return
      const capture = answer.capture
      if (!capture.mounted) setCaptureLine(t('pill.captureNoPlugin'))
      else {
        setCaptureLine(
          t('pill.captureLine', {
            enabled: capture.enabled === true ? t('write.yes') : capture.enabled === false ? t('write.no') : '—',
            auto: capture.autoCapture === true ? t('write.yes') : capture.autoCapture === false ? t('write.no') : '—',
            threshold: capture.commitTokenThreshold ?? '—',
          }),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [openSessionId])

  // The scope chip's store is shared; asking once here keeps the popover's
  // "Commit now" gate in sync with the identity panel.
  useEffect(() => {
    void ensureScope()
  }, [])

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
    ? archiveFailureViews(failedArchives, status?.archives ?? [], tasks)
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
          {/*
            F10: force commit lives here (and in the Activity tab and `/viking
            commit`). It always goes through the prepared confirmation dialog —
            never one-click — and it is the only supported session control: the
            official plugin exposes no pause/resume API.
          */}
          <div className="ove-pop-actions">
            {canSelectPanel() ? (
              <button
                type="button"
                className="ove-diff-action"
                onClick={() => openNative({ view: 'sessions', sessions: { sessionId } })}
              >
                {t('native.openSessionInCockpit')}
              </button>
            ) : null}
            {forceCommitEnabled({
              writesEnabled: scope.scope !== null && scope.scope.writes.enabled,
              transport: scope.scope !== null && scope.scope.writes.transport,
              scopeMismatch,
            }) ? (
              <button
                type="button"
                className="ove-diff-action"
                onClick={async () => {
                  setCommitError(null)
                  const answer = await prepareWrite({ action: 'force-commit', target: sessionId, sessionId })
                  if (answer.ok) openWriteConfirm(answer)
                  else setCommitError(writeErrorText(answer.error))
                }}
              >
                {t('pill.commitNow')}
              </button>
            ) : (
              <span className="ove-row-count">
                {scopeMismatch ? t('scope.session.actionsDisabled') : t('pill.commitDisabled')}
              </span>
            )}
          </div>
          {commitError !== null ? <div className="ove-empty ove-error">{commitError}</div> : null}
          {captureLine !== null ? <div className="ove-empty">{captureLine}</div> : null}
          <div className="ove-empty">{t('pill.capturePauseUnavailable')}</div>
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

          {selectedEntry?.state === 'failed' ? (
            <FailureDetail failure={selectedEntry.failure} task={taskForArchive(tasks, selected)} />
          ) : null}
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
function archiveFailureViews(
  failures: ArchiveSummary[],
  archives: CommitArchive[],
  tasks: CommitTask[],
): FailureView[] {
  const modTimeByUri = new Map(archives.map((archive) => [archive.archiveUri, archive.modTime]))
  return failures.map((entry) => {
    const task = taskForArchive(tasks, entry.archiveUri)
    return {
      key: entry.archiveUri,
      taskId: task?.task_id ?? null,
      time: formatShortTime(entry.failure?.failedAt ?? modTimeByUri.get(entry.archiveUri) ?? null),
      duration: task ? durationSeconds(task) : null,
      reason: archiveFailureText(entry.failure),
      raw: entry.failure?.error ?? null,
      cancelled: isCancelledFailure(entry.failure),
    }
  })
}

/** The task record that produced one archive, when it has not been pruned yet. */
function taskForArchive(tasks: CommitTask[], archiveUri: string | null): CommitTask | null {
  if (archiveUri === null) return null
  return tasks.find((task) => task.result?.archive_uri === archiveUri) ?? null
}

/** Failure rows from task records — the fallback for servers without markers. */
function taskFailureViews(tasks: CommitTask[]): FailureView[] {
  return failedTasks(tasks).map((task) => ({
    key: task.task_id,
    taskId: task.task_id,
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

function FailureDetail({ failure, task }: { failure: ArchiveFailure | null; task: CommitTask | null }) {
  const cancelled = isCancelledFailure(failure)
  const [copied, setCopied] = useState(false)
  const raw = failure?.error ?? task?.error ?? null
  const time = failure?.failedAt
    ? formatShortTime(failure.failedAt)
    : task
      ? taskTime(task) ?? '—'
      : '—'
  return (
    <div className="ove-section">
      <div className={`ove-section-title${cancelled ? '' : ' ove-error'}`}>
        {cancelled ? t('pill.archive.cancelled') : t('pill.archive.failed')}
      </div>
      <div className="ove-failure">
        <div className="ove-failure-head">
          <span>{time}</span>
          <span className="ove-row-count">{failure?.stage ?? task?.stage ?? ''}</span>
        </div>
        {task !== null && (
          <div className="ove-failure-task">
            {t('pill.taskId')} <code>{task.task_id}</code>
          </div>
        )}
        <div className="ove-failure-msg" title={raw ?? undefined}>
          {cancelled ? '' : archiveFailureText(failure)}
        </div>
        {raw !== null && raw.length > 0 ? (
          <div className="ove-failure-actions">
            <button
              type="button"
              className="ove-diff-action"
              onClick={() => void markCopied(raw, setCopied)}
            >
              {copied ? t('pill.copied') : t('pill.copyError')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The three change kinds, in the order the diff browser shows them. */
type DiffFilter = 'all' | 'adds' | 'updates' | 'deletes'

interface DiffGroup {
  key: Exclude<DiffFilter, 'all'>
  title: string
  entries: MemoryDiffEntry[]
}

/**
 * One commit's memory changes, with the part the old popover never showed: the
 * text before and after.
 *
 * The summary/filters are local state because this is a browsing surface, not a
 * status: switching a filter must not refetch the commit or disturb the pill.
 */
export function DiffView({ diff }: { diff: MemoryDiff }) {
  const { summary } = diff
  const [filter, setFilter] = useState<DiffFilter>('all')
  // The diff-type filter is a filter group, not a tab strip: with a diff shown it
  // replaces the list rather than swapping a persistent panel (only the empty
  // state is a panel). `aria-pressed` states the selection without pretending a
  // tabpanel exists for every button (review S1).

  const [openKey, setOpenKey] = useState<string | null>(null)
  const groups: DiffGroup[] = [
    { key: 'adds', title: t('pill.group.adds'), entries: diff.adds },
    { key: 'updates', title: t('pill.group.updates'), entries: diff.updates },
    { key: 'deletes', title: t('pill.group.deletes'), entries: diff.deletes },
  ]
  const total = summary.totalAdds + summary.totalUpdates + summary.totalDeletes
  const visible = filter === 'all' ? groups : groups.filter((group) => group.key === filter)
  const shown = visible.reduce((count, group) => count + group.entries.length, 0)
  return (
    <div className="ove-section">
      <div className="ove-diff-head">
        <span className="ove-section-title">
          {t('pill.diffSummary', { adds: summary.totalAdds, updates: summary.totalUpdates, deletes: summary.totalDeletes })}
        </span>
        <button type="button" className="ove-diff-action" onClick={() => exportDiff(diff)}>
          {t('pill.export')}
        </button>
      </div>
      <div className="ove-empty ove-diff-archive">
        <VikingUriLink uri={diff.archiveUri} />
      </div>
      {total === 0 ? (
        <div className="ove-empty">{t('pill.noMemoryChange')}</div>
      ) : (
        <>
          <div className="ove-diff-filters" role="group" aria-label={t('pill.filter.label')}>
            {(['all', 'adds', 'updates', 'deletes'] as const).map((candidate) => {
              const count =
                candidate === 'all'
                  ? total
                  : candidate === 'adds'
                    ? summary.totalAdds
                    : candidate === 'updates'
                      ? summary.totalUpdates
                      : summary.totalDeletes
              return (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={filter === candidate}
                  className={`ove-diff-filter${filter === candidate ? ' ove-diff-filter-active' : ''}`}
                >
                  {t(`pill.filter.${candidate}`)}
                  <span className="ove-diff-filter-count">{count}</span>
                </button>
              )
            })}
          </div>
          {shown === 0 ? (
            <div className="ove-empty">{t('pill.filter.empty')}</div>
          ) : (
            visible.map((group) => (
              <section key={group.key}>
                <div className="ove-diff-group">
                  <span>{group.title}</span>
                  <span className="ove-row-count">{group.entries.length}</span>
                </div>
                {group.entries.map((entry) => {
                  const key = `${group.key}:${entry.uri}`
                  return (
                    <DiffEntry
                      key={key}
                      entry={entry}
                      kind={group.key}
                      open={openKey === key}
                      onToggle={() => setOpenKey((current) => (current === key ? null : key))}
                    />
                  )
                })}
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}

export function DiffEntry({
  entry,
  kind,
  open,
  onToggle,
}: {
  entry: MemoryDiffEntry
  kind: DiffGroup['key']
  open: boolean
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)
  const preview = firstLine(kind === 'updates' ? entry.after ?? entry.before ?? '' : kind === 'adds' ? entry.after ?? '' : entry.deletedContent ?? entry.before ?? '')
  const rows = diffRowsFor(entry, kind)
  return (
    <div className={`ove-diff-entry${open ? ' ove-diff-entry-open' : ''}`}>
      <div className="ove-diff-entry-head">
        <button type="button" className="ove-diff-row" aria-expanded={open} onClick={onToggle}>
          <span className="ove-diff-kind" data-kind={kind} aria-hidden="true">
            {kind === 'adds' ? '+' : kind === 'updates' ? '±' : '−'}
          </span>
          <span className="ove-diff-name" title={entry.uri}>
            {fileName(entry.uri)}
          </span>
          <span className="ove-diff-type">{entry.memoryType}</span>
          {!open && preview.length > 0 ? <span className="ove-diff-preview">{preview}</span> : null}
          <span className="ove-diff-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>
        <button
          type="button"
          className="ove-diff-action"
          title={t('pill.copyUri')}
          onClick={() => void markCopied(entry.uri, setCopied)}
        >
          {copied ? t('pill.copied') : t('pill.copyUri')}
        </button>
      </div>
      {open ? (
        <div className="ove-diff-detail">
          <VikingUriLink uri={entry.uri} className="ove-diff-uri" />
          {rows.length === 0 ? (
            <p className="ove-empty">{t('pill.diffNoText')}</p>
          ) : (
            <div className="ove-diff-body">
              {rows.map((row: DiffRow, index: number) => (
                <div className={`ove-diff-line ove-diff-line-${row.kind}`} key={`${index}-${row.text.slice(0, 24)}`}>
                  <span className="ove-diff-sign" aria-hidden="true">
                    {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
                  </span>
                  <span className="ove-diff-text">{row.text.length > 0 ? row.text : ' '}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** The text diff for one change, as display rows. */
function diffRowsFor(entry: MemoryDiffEntry, kind: DiffGroup['key']): DiffRow[] {
  if (kind === 'updates') {
    if (entry.before === undefined && entry.after === undefined) return []
    return lineDiff(entry.before ?? '', entry.after ?? '').rows
  }
  if (kind === 'adds') return entry.after === undefined ? [] : lineDiff('', entry.after).rows
  return lineDiff(entry.deletedContent ?? entry.before ?? '', '').rows
}

/** First non-empty line, for the collapsed preview. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

function fileName(uri: string): string {
  const cut = uri.lastIndexOf('/')
  return cut === -1 ? uri : uri.slice(cut + 1)
}

/** Copy feedback: one-way, so a re-render cannot flip the label back mid-click. */
async function markCopied(text: string, set: (value: boolean) => void): Promise<void> {
  if (await copyText(text)) set(true)
}

/** Download one commit's changes as JSON, a user-initiated local export. */
export function exportDiff(diff: MemoryDiff): void {
  if (typeof document === 'undefined') return
  const archiveId = diff.archiveUri.split('/').pop() ?? 'commit'
  const body = JSON.stringify(
    {
      archiveUri: diff.archiveUri,
      extractedAt: diff.extractedAt,
      summary: diff.summary,
      adds: diff.adds,
      updates: diff.updates,
      deletes: diff.deletes,
    },
    null,
    2,
  )
  const blob = new Blob([body], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `openviking-${archiveId}.json`
  anchor.click()
  // Revoke after the browser has started the download; revoking in the same
  // task can cancel it on some engines.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
