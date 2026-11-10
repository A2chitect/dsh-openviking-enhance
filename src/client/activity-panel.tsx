/**
 * F11 + F10: the Activity tab (fifth right-Sidebar page type).
 *
 * Sections:
 *   **Tasks**  — one cursor page of server tasks (type/status filters), row
 *                expansion with events, cooperative Cancel, JSON export. Cancel
 *                never claims rollback: completed business writes stay.
 *   **Status** — the four cheap metric cards (each independently degradable),
 *                the session's capture state (read-only, with the honest
 *                pause/resume explanation), the failed-archive diagnosis, and
 *                the plugin's own "recent actions" audit list.
 *
 * Two behaviours matter for correctness:
 *
 *  - **Polling follows the tab, not the plugin.** The list is polled only while
 *    the panel is mounted and the document is visible; a task detail is polled
 *    only while the open task is still running (`poll-policy.ts`).
 *  - **Every render path refreshes from the server.** A cancel or export never
 *    mutates local rows optimistically; the next poll is the truth.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ACTIVITY_TASKS_DEFAULT_LIMIT,
  CANCELLABLE_TASK_TYPES,
  isCancellableStatus,
  type ActivityTask,
  type ActivityTaskDetail,
  type CaptureState,
  type FailedArchiveDiagnosis,
  type MetricsPayload,
  type ScopePayload,
  type TaskEvent,
} from '../shared/protocol.ts'
import {
  cancelTask,
  fetchAudit,
  fetchMetrics,
  fetchSessionControl,
  fetchTaskDetail,
  fetchTasks,
  prepareWrite,
  taskExportUrl,
  type SessionControlResponse,
} from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { MetricCard, MetricsCards } from './metrics-view.tsx'
import { nextPollDelay } from './poll-policy.ts'
import { ScopeChip } from './scope-chip.tsx'
import { useScope } from './scope-store.ts'
import { SessionScopeBanner } from './session-scope.tsx'
import { openWriteConfirm } from './write-store.ts'

export interface ActivityPanelProps {
  sessionId: string
}

type Section = 'tasks' | 'status'

/** The task-type filter chips (the server's own types). */
const TASK_TYPES: readonly string[] = ['session_commit', 'add_resource', 'add_skill', 'compile', 'snapshot_restore_reindex']
/** The status filter chips. */
const TASK_STATUSES: readonly string[] = ['pending', 'running', 'failed', 'completed', 'cancelled']

function formatSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value < 1) return `${Math.round(value * 1000)} ms`
  return `${value.toFixed(value >= 10 ? 0 : 1)} s`
}

function formatTime(seconds: number | null): string {
  if (seconds === null) return '—'
  try {
    return new Date(seconds * 1000).toLocaleString()
  } catch {
    return '—'
  }
}

function shortId(value: string | null): string {
  if (value === null || value.length === 0) return '—'
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`
}

/** One safe export link: an `<a download>` to the authenticated read route. */
function ExportLink({ taskId }: { taskId: string }) {
  return (
    <a className="ove-act-link" href={taskExportUrl(taskId)} download rel="noopener noreferrer">
      {t('activity.export')}
    </a>
  )
}

/* ---- Tasks --------------------------------------------------------------- */

function TaskRow({ task, sessionId, canCancel }: { task: ActivityTask; sessionId: string; canCancel: boolean }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ActivityTaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  void sessionId

  const loadDetail = useCallback(async () => {
    const answer = await fetchTaskDetail(task.taskId, true)
    if (answer.ok) setDetail(answer.task)
    else setError(writeErrorText(answer.error))
  }, [task.taskId])

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (next && detail === null) void loadDetail()
  }, [detail, loadDetail, open])

  // One open task is polled while it is still running, and only while it is
  // open: the list poll already covers the rows.
  const running =
    detail !== null &&
    open &&
    (detail.status === 'pending' || detail.status === 'running' || detail.status === 'cancelling')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void loadDetail(), 2000)
    return () => clearInterval(timer)
  }, [running, loadDetail])

  const doCancel = useCallback(async () => {
    setCancelConfirm(false)
    const answer = await cancelTask(task.taskId)
    if (!answer.ok) setNote(writeErrorText(answer.error))
    else {
      setNote(t('activity.cancelled', { status: answer.task.status }))
      await loadDetail()
    }
  }, [loadDetail, task.taskId])

  // ROOT identities cannot cancel tasks on this server (it answers 403), so the
  // action is hidden rather than offered and refused.
  const cancellable =
    canCancel && (CANCELLABLE_TASK_TYPES as readonly string[]).includes(task.taskType) && isCancellableStatus(task.status)

  return (
    <div className={`ove-act-task ove-act-status-${task.status}`}>
      <div className="ove-act-task-line">
        <button type="button" className="ove-act-task-toggle" aria-expanded={open} onClick={toggle}>
          <span className="ove-act-caret">{open ? '▾' : '▸'}</span>
          <span className="ove-act-task-type">{task.taskType}</span>
          <span className={`ove-act-badge ove-act-badge-${statusTone(task.status)}`}>{task.status}</span>
          <span className="ove-act-task-id" title={task.taskId}>
            {shortId(task.taskId)}
          </span>
          {task.stage !== null && <span className="ove-act-task-stage">{task.stage}</span>}
          {task.error !== null && (
            <span className="ove-act-task-error" title={task.error}>
              !
            </span>
          )}
          <span className="ove-act-task-age">{formatSeconds(task.processingSeconds)}</span>
        </button>
        <span className="ove-act-task-actions">
          {cancellable &&
            (cancelConfirm ? (
              <>
                <button type="button" className="ove-act-link ove-act-danger" onClick={() => void doCancel()}>
                  {t('activity.cancelConfirm')}
                </button>
                <button type="button" className="ove-act-link" onClick={() => setCancelConfirm(false)}>
                  {t('write.cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="ove-act-link" title={t('activity.cancelHint')} onClick={() => setCancelConfirm(true)}>
                {t('activity.cancel')}
              </button>
            ))}
          <ExportLink taskId={task.taskId} />
        </span>
      </div>
      {note !== null && <p className="ove-act-note">{note}</p>}
      {open && (
        <div className="ove-act-detail">
          {error !== null && <p className="ove-act-error">{error}</p>}
          {detail === null && error === null && <p className="ove-act-note">{t('activity.loading')}</p>}
          {detail !== null && (
            <>
              <dl className="ove-act-facts">
                <div>
                  <dt>{t('activity.created')}</dt>
                  <dd>{formatTime(detail.createdAt)}</dd>
                </div>
                <div>
                  <dt>{t('activity.updated')}</dt>
                  <dd>{formatTime(detail.updatedAt)}</dd>
                </div>
                <div>
                  <dt>{t('activity.stage')}</dt>
                  <dd>{detail.stage ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t('activity.resource')}</dt>
                  <dd title={detail.resourceId ?? ''}>{shortId(detail.resourceId)}</dd>
                </div>
                {detail.resultSummary?.archiveUri != null && (
                  <div>
                    <dt>{t('activity.archive')}</dt>
                    <dd title={detail.resultSummary.archiveUri}>{detail.resultSummary.archiveUri}</dd>
                  </div>
                )}
                {detail.resultSummary?.memoriesExtracted != null && (
                  <div>
                    <dt>{t('activity.memories')}</dt>
                    <dd>
                      {t('activity.memoryCounts', {
                        write: detail.resultSummary.memoriesExtracted.memoryWrite ?? 0,
                        edit: detail.resultSummary.memoriesExtracted.memoryEdit ?? 0,
                      })}
                    </dd>
                  </div>
                )}
                {detail.resultSummary?.memoryDiffUri != null && (
                  <div>
                    <dt>{t('activity.diff')}</dt>
                    <dd title={detail.resultSummary.memoryDiffUri}>{detail.resultSummary.memoryDiffUri}</dd>
                  </div>
                )}
              </dl>
              {detail.error !== null && <p className="ove-act-error">{detail.error}</p>}
              <TaskEvents events={detail.events} dropped={detail.eventsDropped} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function statusTone(status: string): string {
  if (status === 'failed' || status === 'cancelled') return 'bad'
  if (status === 'completed') return 'ok'
  return 'busy'
}

function TaskEvents({ events, dropped }: { events: TaskEvent[] | null; dropped: number | null }) {
  if (events === null) return null
  if (events.length === 0) return <p className="ove-act-note">{t('activity.noEvents')}</p>
  return (
    <div className="ove-act-events">
      <span className="ove-act-subtitle">{t('activity.events')}</span>
      {events.map((event) => (
        <div className="ove-act-event" key={`${event.seq}-${event.kind}`}>
          <span className="ove-act-event-seq">{event.seq}</span>
          <span className="ove-act-event-kind">{event.kind}</span>
          {event.status !== null && <span className="ove-act-badge">{event.status}</span>}
          {event.stage !== null && <span>{event.stage}</span>}
          {event.operation !== null && <span title={event.operation}>{shortId(event.operation)}</span>}
          {event.error !== null && <span className="ove-act-error-inline">{event.error}</span>}
        </div>
      ))}
      {dropped !== null && dropped > 0 && <p className="ove-act-note">{t('activity.eventsDropped', { count: dropped })}</p>}
    </div>
  )
}

function TasksSection({ sessionId }: { sessionId: string }) {
  const scope = useScope()
  const [tasks, setTasks] = useState<ActivityTask[] | null>(null)
  const [available, setAvailable] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [refreshAt, setRefreshAt] = useState(0)
  const [commitError, setCommitError] = useState<string | null>(null)
  const errorCount = useRef(0)
  const [hidden, setHidden] = useState(false)

  // Polling pauses while the document is hidden; a visibility change also
  // restarts it immediately (the timer is scheduled by the effect below).
  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = () => setHidden(document.visibilityState === 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const workingNow = (tasks ?? []).some((task) => isCancellableStatus(task.status))

    const load = async (): Promise<void> => {
      const answer = await fetchTasks(
        {
          ...(typeFilter.length === 0 ? {} : { taskType: typeFilter }),
          ...(statusFilter.length === 0 ? {} : { status: statusFilter }),
          limit: ACTIVITY_TASKS_DEFAULT_LIMIT,
        },
        controller.signal,
      )
      if (cancelled) return
      if (answer.ok) {
        errorCount.current = 0
        setTasks(answer.tasks)
        setAvailable(answer.available)
        setNote(answer.note)
        setHasMore(answer.hasMore)
        setNextCursor(answer.nextCursor)
      } else {
        errorCount.current += 1
      }
      timer = setTimeout(() => void load(), nextPollDelay({ working: workingNow, hidden, errorCount: errorCount.current }))
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
    // `tasks` is intentionally excluded: it is updated by this effect and would
    // restart the poll on every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter, hidden, refreshAt])

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return
    const answer = await fetchTasks({
      ...(typeFilter.length === 0 ? {} : { taskType: typeFilter }),
      ...(statusFilter.length === 0 ? {} : { status: statusFilter }),
      limit: ACTIVITY_TASKS_DEFAULT_LIMIT,
      cursor: nextCursor,
    })
    if (answer.ok) {
      setTasks((current) => [...(current ?? []), ...answer.tasks])
      setHasMore(answer.hasMore)
      setNextCursor(answer.nextCursor)
    }
  }, [nextCursor, statusFilter, typeFilter])

  /** F10 entry point: the same prepare/confirm dialog as the commit pill. */
  const forceCommit = useCallback(async () => {
    setCommitError(null)
    const answer = await prepareWrite({ action: 'force-commit', target: sessionId, sessionId })
    if (answer.ok) openWriteConfirm(answer)
    else setCommitError(writeErrorText(answer.error))
  }, [sessionId])

  const writesReady = scope.scope?.writes.enabled === true && scope.scope.writes.transport

  return (
    <div className="ove-act-section">
      <div className="ove-act-toolbar">
        <div className="ove-act-filters">
          <button
            type="button"
            className={`ove-act-chip${typeFilter === '' ? ' ove-act-chip-active' : ''}`}
            onClick={() => setTypeFilter('')}
          >
            {t('activity.allTypes')}
          </button>
          {TASK_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={`ove-act-chip${typeFilter === type ? ' ove-act-chip-active' : ''}`}
              onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
            >
              {type}
            </button>
          ))}
        </div>
        <div className="ove-act-filters">
          <button
            type="button"
            className={`ove-act-chip${statusFilter === '' ? ' ove-act-chip-active' : ''}`}
            onClick={() => setStatusFilter('')}
          >
            {t('activity.allStatuses')}
          </button>
          {TASK_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`ove-act-chip${statusFilter === status ? ' ove-act-chip-active' : ''}`}
              onClick={() => setStatusFilter(statusFilter === status ? '' : status)}
            >
              {status}
            </button>
          ))}
        </div>
        <span className="ove-act-spacer" />
        <button type="button" className="ove-act-button" onClick={() => setRefreshAt((value) => value + 1)}>
          {t('activity.refresh')}
        </button>
        {writesReady && (
          <button type="button" className="ove-act-button" onClick={() => void forceCommit()}>
            {t('activity.commitNow')}
          </button>
        )}
      </div>
      {commitError !== null && <p className="ove-act-error">{commitError}</p>}
      {scope.scope !== null && !writesReady && (
        <p className="ove-act-note">{t('activity.commitDisabled', { reason: scope.scope.writes.reason ?? 'writes-disabled' })}</p>
      )}
      {tasks === null && <p className="ove-act-note">{t('activity.loading')}</p>}
      {tasks !== null && !available && <p className="ove-act-note">{t('activity.tasksUnavailable')}</p>}
      {tasks !== null && available && tasks.length === 0 && <p className="ove-act-note">{t('activity.empty')}</p>}
      {tasks !== null &&
        tasks.map((task) => (
          <TaskRow key={task.taskId} task={task} sessionId={sessionId} canCancel={scope.scope?.role !== 'ROOT'} />
        ))}
      {hasMore && (
        <button type="button" className="ove-act-button" onClick={() => void loadMore()}>
          {t('activity.loadMore')}
        </button>
      )}
      {note !== null && !available && <p className="ove-act-note">{t('activity.exportHint')}</p>}
    </div>
  )
}

/* ---- Status -------------------------------------------------------------- */

function CaptureCard({ control }: { control: SessionControlResponse | null }) {
  const capture: CaptureState | null = control?.capture ?? null
  const diagnosis: FailedArchiveDiagnosis | null = control?.failedArchive ?? null
  return (
    <div className="ove-act-card">
      <span className="ove-act-card-title">{t('activity.capture')}</span>
      {capture === null ? (
        <span className="ove-act-note">{t('activity.metricsUnavailable')}</span>
      ) : !capture.mounted ? (
        <span className="ove-act-note">{t('activity.captureNoPlugin')}</span>
      ) : (
        <dl className="ove-act-facts">
          <div>
            <dt>{t('activity.captureEnabled')}</dt>
            <dd>{booleanText(capture.enabled)}</dd>
          </div>
          <div>
            <dt>{t('activity.captureAuto')}</dt>
            <dd>{booleanText(capture.autoCapture)}</dd>
          </div>
          <div>
            <dt>{t('activity.captureAssistant')}</dt>
            <dd>{booleanText(capture.captureAssistantTurns)}</dd>
          </div>
          <div>
            <dt>{t('activity.captureToolResults')}</dt>
            <dd>{booleanText(capture.captureToolResults)}</dd>
          </div>
          <div>
            <dt>{t('activity.threshold')}</dt>
            <dd>{capture.commitTokenThreshold ?? '—'}</dd>
          </div>
        </dl>
      )}
      <p className="ove-act-note">{t('activity.capturePauseUnavailable')}</p>
      {diagnosis !== null && (
        <div className="ove-act-diagnosis">
          <span className="ove-act-subtitle">{t('activity.failedArchive')}</span>
          <p className="ove-act-error">{diagnosis.error ?? '—'}</p>
          {diagnosis.archiveUri !== null && <p className="ove-act-note">{diagnosis.archiveUri}</p>}
          {diagnosis.memoryDiffUri !== null && <p className="ove-act-note">{diagnosis.memoryDiffUri}</p>}
          <p className="ove-act-note">{t('activity.archiveRetryUnavailable')}</p>
          {diagnosis.taskId !== null && <ExportLink taskId={diagnosis.taskId} />}
        </div>
      )}
    </div>
  )
}

function booleanText(value: boolean | null): string {
  if (value === null) return '—'
  return value ? t('write.yes') : t('write.no')
}

function StatusSection({ sessionId }: { sessionId: string }) {
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null)
  const [control, setControl] = useState<SessionControlResponse | null>(null)
  const [auditLines, setAuditLines] = useState<Array<{ ts: string; kind: string; action: string; target: string | null; result: string }>>([])
  const [refreshAt, setRefreshAt] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      const [metricsAnswer, controlAnswer, auditAnswer] = await Promise.all([
        fetchMetrics(sessionId, { signal: controller.signal }),
        fetchSessionControl(sessionId, controller.signal),
        fetchAudit(10, controller.signal),
      ])
      if (cancelled) return
      if (metricsAnswer.ok) setMetrics(metricsAnswer.metrics)
      else setError(writeErrorText(metricsAnswer.error))
      if (controlAnswer.ok) setControl(controlAnswer)
      if (auditAnswer.ok) setAuditLines(auditAnswer.entries)
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sessionId, refreshAt])

  return (
    <div className="ove-act-section">
      <div className="ove-act-toolbar">
        <span className="ove-act-spacer" />
        <button type="button" className="ove-act-button" onClick={() => setRefreshAt((value) => value + 1)}>
          {t('activity.refresh')}
        </button>
      </div>
      {error !== null && <p className="ove-act-error">{error}</p>}
      <div className="ove-act-cards">
        <MetricsCards metrics={metrics} />
        <CaptureCard control={control} />
        <div className="ove-act-card">
          <span className="ove-act-card-title">{t('activity.recentActions')}</span>
          {auditLines.length === 0 ? (
            <span className="ove-act-note">{t('activity.noActions')}</span>
          ) : (
            <ul className="ove-act-audit">
              {auditLines.map((entry, index) => (
                <li key={`${entry.ts}-${index}`}>
                  <span className={`ove-act-badge ove-act-badge-${entry.result === 'ok' ? 'ok' : 'bad'}`}>{entry.result}</span>
                  <span className="ove-act-audit-kind">{entry.kind}/{entry.action}</span>
                  {entry.target !== null && (
                    <span className="ove-act-audit-target" title={entry.target}>
                      {shortId(entry.target)}
                    </span>
                  )}
                  <span className="ove-act-audit-time">{entry.ts}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="ove-act-note">{t('activity.auditHint')}</p>
        </div>
      </div>
    </div>
  )
}

/* ---- the page ------------------------------------------------------------ */

export function ActivityPanel({ sessionId }: ActivityPanelProps) {
  const [section, setSection] = useState<Section>('tasks')
  const scope = useScope()
  const status = scope.scope?.healthy === true ? null : t('activity.unreachable')

  return (
    <div className="ove-act">
      <SessionScopeBanner sessionId={sessionId} />
      <div className="ove-act-head">
        <div className="ove-act-tabs" role="tablist" aria-label={t('activity.tabTitle')}>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'tasks'}
            className={`ove-act-tab${section === 'tasks' ? ' ove-act-tab-active' : ''}`}
            onClick={() => setSection('tasks')}
          >
            {t('activity.tasks')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'status'}
            className={`ove-act-tab${section === 'status' ? ' ove-act-tab-active' : ''}`}
            onClick={() => setSection('status')}
          >
            {t('activity.status')}
          </button>
        </div>
        <ScopeChip compact />
      </div>
      {status !== null && <p className="ove-act-note">{status}</p>}
      {section === 'tasks' ? <TasksSection sessionId={sessionId} /> : <StatusSection sessionId={sessionId} />}
    </div>
  )
}
