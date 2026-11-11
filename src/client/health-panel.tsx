/**
 * The Memory health tab: session capture/commit state plus the Doctor.
 *
 * One right-sidebar page, two questions that belong together:
 *
 *  - **Session log** — has this session been captured, how far from a commit is
 *    it, is extraction running/failed, and is a write queued locally?
 *  - **Doctor** — is the server reachable, as whom, is the memory plugin
 *    mounted, which optional capabilities does this server have, and did the
 *    connection come from the profile, the environment or `ovcli.conf`?
 *
 * Both surfaces are read-only. The only periodic request is the session log
 * (15 s while the tab is visible); the Doctor's probes run only on open or on an
 * explicit refresh, because each one is a real request to the server.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DoctorCheck,
  DoctorReport,
  PendingQueueSummary,
  SessionLogEvent,
  SessionLogTask,
  SessionMemoryLog,
  SessionMemoryState,
} from '../shared/protocol.ts'
import { fetchDoctor, fetchSessionLog } from './host-api.ts'
import { SessionScopeBanner } from './session-scope.tsx'
import { ScopeChip } from './scope-chip.tsx'
import { copyText } from './clipboard.ts'
import { noticeText, t } from './locale.ts'
import { startVisibleInterval } from './poll-policy.ts'
import { canSelectPanel, openNative } from './native-store.ts'

export interface HealthPanelProps {
  sessionId: string
}

const STATE_TONE: Record<SessionMemoryState, string> = {
  'no-messages': 'ove-health-state-idle',
  'not-committed': 'ove-health-state-ok',
  extracting: 'ove-health-state-busy',
  failed: 'ove-health-state-bad',
  queued: 'ove-health-state-warn',
  committed: 'ove-health-state-good',
  unknown: 'ove-health-state-unknown',
}

const CHECK_TONE: Record<DoctorCheck['status'], string> = {
  ok: 'ove-health-state-good',
  warn: 'ove-health-state-warn',
  error: 'ove-health-state-bad',
  unknown: 'ove-health-state-unknown',
  skipped: 'ove-health-state-idle',
}

export function HealthPanel({ sessionId }: HealthPanelProps) {
  const [log, setLog] = useState<SessionMemoryLog | null>(null)
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [doctorLoading, setDoctorLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const generation = useRef(0)
  const busy = useRef(false)

  const load = useCallback(
    async (probe: boolean, fresh: boolean) => {
      const ticket = (generation.current += 1)
      busy.current = true
      setLogLoading(true)
      if (!fresh) setDoctorLoading(true)
      const [logAnswer, doctorAnswer] = await Promise.all([
        fetchSessionLog(sessionId, { fresh }),
        fetchDoctor(sessionId, { probe }),
      ])
      if (ticket !== generation.current) return
      busy.current = false
      setLogLoading(false)
      setDoctorLoading(false)
      if (logAnswer.ok) {
        setLog(logAnswer.log)
        setLogError(null)
      } else {
        setLogError(logAnswer.error)
      }
      if (doctorAnswer.ok) {
        setReport(doctorAnswer.report)
        setDoctorError(null)
      } else {
        setDoctorError(doctorAnswer.error)
      }
    },
    [sessionId],
  )

  // A new session is a new page: drop the previous answer before the next one.
  useEffect(() => {
    setLog(null)
    setReport(null)
    setLogError(null)
    setDoctorError(null)
    setCopied(null)
    generation.current += 1
    void load(true, false)
    return () => {
      generation.current += 1
    }
  }, [load])

  // The log is the live part. Keep it fresh while the tab is on screen, and
  // stop paying for it when the document is hidden.
  useEffect(() => {
    return startVisibleInterval(() => {
      if (busy.current) return
      const ticket = generation.current
      void fetchSessionLog(sessionId, { fresh: false }).then((answer) => {
        if (ticket !== generation.current || !answer.ok) return
        setLog(answer.log)
        setLogError(null)
      })
    }, 15_000)
  }, [sessionId])

  const copy = useCallback(async (label: string, text: string) => {
    if (await copyText(text)) setCopied(label)
  }, [])

  return (
    <div className="ove-health" data-dsh-plugin="openviking-enhance-health">
      <SessionScopeBanner sessionId={sessionId} />
      <div className="ove-health-bar">
        <span className="ove-health-title">{t('health.title')}</span>
        <ScopeChip compact />
        <span className="ove-health-spacer" />
        {canSelectPanel() && (
          <button
            type="button"
            className="ove-health-button"
            title={t('native.openSessionInCockpit')}
            onClick={() => openNative({ view: 'sessions', sessions: { sessionId } })}
          >
            {t('native.openSessionInCockpit')}
          </button>
        )}
        <button type="button" className="ove-health-button" onClick={() => void load(true, true)} disabled={logLoading || doctorLoading}>
          {logLoading || doctorLoading ? t('health.loading') : t('health.refresh')}
        </button>
      </div>
      <div className="ove-health-body">
        {log !== null ? <StateBanner log={log} /> : null}
        {logError !== null && (
          <p className="ove-health-error">
            {t('health.logFailed', { error: logError })}{' '}
            <button type="button" className="ove-health-link" onClick={() => void load(false, true)}>
              {t('health.retry')}
            </button>
          </p>
        )}

        {log !== null ? (
          <>
            <Facts log={log} />
            {log.events.length > 0 ? <Timeline events={log.events} /> : null}
            <Tasks tasks={log.tasks} />
            <Queue pending={log.pending} />
            {log.warnings.length > 0 ? (
              <div className="ove-health-hint">
                {log.warnings.map((warning, index) => (
                  <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        <div className="ove-health-rule" aria-hidden="true" />
        <div className="ove-health-section-title">
          <span>{t('health.doctor')}</span>
          {report !== null && (
            <button
              type="button"
              className="ove-health-link"
              onClick={() => void copy('all', JSON.stringify(report.diagnostics, null, 2))}
            >
              {copied === 'all' ? t('health.copied') : t('health.copy')}
            </button>
          )}
        </div>
        {doctorLoading && report === null ? <p className="ove-health-hint">{t('health.probing')}</p> : null}
        {doctorError !== null && (
          <p className="ove-health-error">
            {t('health.doctorFailed', { error: doctorError })}{' '}
            <button type="button" className="ove-health-link" onClick={() => void load(true, true)}>
              {t('health.retry')}
            </button>
          </p>
        )}
        {report !== null ? <Doctor report={report} /> : null}
      </div>
    </div>
  )
}

function StateBanner({ log }: { log: SessionMemoryLog }) {
  return (
    <div className={`ove-health-banner ${STATE_TONE[log.state]}`}>
      <span className="ove-health-dot" aria-hidden="true" />
      <span className="ove-health-state">{t(`health.state.${log.state}`)}</span>
      <span className="ove-health-state-hint">{t(`health.stateHint.${log.state}`)}</span>
    </div>
  )
}

function Facts({ log }: { log: SessionMemoryLog }) {
  const meta = log.meta
  const threshold = log.threshold === null ? t('health.unknown') : String(log.threshold)
  return (
    <dl className="ove-health-facts">
      <dt>{t('health.session')}</dt>
      <dd>
        <code>{log.ovSessionId}</code>
      </dd>
      <dt>{t('health.peer')}</dt>
      <dd>{log.peer ?? '—'}</dd>
      <dt>{t('health.messages')}</dt>
      <dd>{`${meta.messageCount} / ${meta.totalMessageCount}`}</dd>
      <dt>{t('health.pending')}</dt>
      <dd>{`${meta.pendingTokens} / ${threshold}`}</dd>
      <dt>{t('health.commits')}</dt>
      <dd>{meta.commitCount}</dd>
      <dt>{t('health.lastCommit')}</dt>
      <dd>{formatTime(meta.lastCommitAt)}</dd>
      <dt>{t('health.lastAutoCommit')}</dt>
      <dd>{formatTime(meta.lastAutoCommitAt)}</dd>
      <dt>{t('health.lastMessage')}</dt>
      <dd>{formatTime(meta.lastMessageAt)}</dd>
      <dt>{t('health.extracted')}</dt>
      <dd>
        {meta.memoriesExtracted === null
          ? '—'
          : t('health.extractedValue', {
              total: meta.memoriesExtracted.total,
              write: meta.memoriesExtracted.memoryWrite,
              edit: meta.memoriesExtracted.memoryEdit,
            })}
      </dd>
    </dl>
  )
}

function Timeline({ events }: { events: SessionLogEvent[] }) {
  return (
    <section className="ove-health-section">
      <div className="ove-health-section-title">{t('health.timeline')}</div>
      <div className="ove-health-timeline">
        {events.map((event, index) => (
          <div className="ove-health-event" key={`${event.at}-${event.kind}-${index}`}>
            <span className={`ove-health-event-dot ${eventTone(event.kind)}`} aria-hidden="true" />
            <span className="ove-health-event-time">{formatTime(event.at)}</span>
            <span className="ove-health-event-label">{t(`health.event.${event.kind}`)}</span>
            {event.detail !== null ? <span className="ove-health-event-detail">{event.detail}</span> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function eventTone(kind: SessionLogEvent['kind']): string {
  switch (kind) {
    case 'failed':
      return 'ove-health-state-bad'
    case 'queued':
      return 'ove-health-state-warn'
    case 'commit':
    case 'auto-commit':
      return 'ove-health-state-good'
    default:
      return 'ove-health-state-idle'
  }
}

function Tasks({ tasks }: { tasks: SessionLogTask[] }) {
  if (tasks.length === 0) return null
  return (
    <section className="ove-health-section">
      <div className="ove-health-section-title">{t('health.tasks')}</div>
      {tasks.slice(0, 5).map((task) => (
        <div className="ove-health-task" key={task.taskId}>
          <div className="ove-health-task-head">
            <span className={`ove-health-task-status ${taskTone(task.status)}`}>{task.status}</span>
            {task.stage !== null ? <span className="ove-health-hint">{task.stage}</span> : null}
            <span className="ove-health-spacer" />
            <span className="ove-health-hint">{formatTime(task.createdAt)}</span>
            {task.processingSeconds !== null ? <span className="ove-health-hint">{task.processingSeconds}s</span> : null}
          </div>
          {task.error !== null ? <div className="ove-health-error">{task.error}</div> : null}
          <div className="ove-health-task-id">
            <code>{task.taskId}</code>
          </div>
        </div>
      ))}
    </section>
  )
}

function taskTone(status: string): string {
  if (status === 'failed') return 'ove-health-state-bad'
  if (status === 'cancelled') return 'ove-health-state-warn'
  if (status === 'completed') return 'ove-health-state-good'
  return 'ove-health-state-busy'
}

function Queue({ pending }: { pending: PendingQueueSummary }) {
  return (
    <section className="ove-health-section">
      <div className="ove-health-section-title">
        <span>{t('health.queue')}</span>
        <span className="ove-health-hint">{t('health.queueSource')}</span>
      </div>
      {!pending.available ? (
        <p className="ove-health-error">{t('health.queueUnavailable', { error: pending.error ?? 'unknown' })}</p>
      ) : pending.total === 0 ? (
        <p className="ove-health-hint">{t('health.queueEmpty')}</p>
      ) : (
        <>
          <p className="ove-health-hint">{t('health.queueCount', { count: pending.total })}</p>
          {pending.items.map((item, index) => (
            <div className="ove-health-event" key={`${item.createdAt ?? 'item'}-${index}`}>
              <span className="ove-health-event-dot ove-health-state-warn" aria-hidden="true" />
              <span className="ove-health-event-time">{formatTime(item.createdAt)}</span>
              <span className="ove-health-event-label">{item.type}</span>
              <span className="ove-health-event-detail">
                {t('health.queueRetries', { count: item.retries })}
                {item.processing ? ` · ${t('health.queueProcessing')}` : ''}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

function Doctor({ report }: { report: DoctorReport }) {
  return (
    <>
      <div className="ove-health-meta">
        <span className={`ove-health-dot ${report.health.healthy ? 'ove-health-state-good' : 'ove-health-state-bad'}`} />
        <span>{report.health.healthy ? t('health.reachable', { version: report.health.version ?? '?' }) : t('health.unreachable')}</span>
        <span className="ove-health-spacer" />
        <span className="ove-health-hint">{report.health.latencyMs} ms</span>
      </div>

      <dl className="ove-health-facts">
        <dt>{t('health.endpoint')}</dt>
        <dd>
          <code>{report.endpoint}</code>
        </dd>
        <dt>{t('health.identity')}</dt>
        <dd>{`${report.identity.configuredAccount}/${report.identity.configuredUser}`}</dd>
        <dt>{t('health.serverUser')}</dt>
        <dd>{report.identity.serverUser ?? '—'}</dd>
        <dt>{t('health.plugin')}</dt>
        <dd>
          {report.plugin.mounted
            ? `${t('health.pluginMounted')}${report.plugin.version ? ` · ${report.plugin.version}` : ''}`
            : t('health.pluginMissing')}
        </dd>
        <dt>{t('health.peerSource')}</dt>
        <dd>{report.plugin.peerSource ?? '—'}</dd>
        <dt>{t('health.compat')}</dt>
        <dd>
          {`DSH ${report.compatibility.dshVersion ?? t('health.unknown')} · ${report.compatibility.testedRange}`}
        </dd>
      </dl>

      <section className="ove-health-section">
        <div className="ove-health-section-title">{t('health.checks')}</div>
        {report.checks.map((check) => (
          <div className="ove-health-check-block" key={check.id}>
            <div className="ove-health-check">
              <span className={`ove-health-dot ${CHECK_TONE[check.status]}`} aria-hidden="true" />
              <span className="ove-health-check-name">{t(`doctor.check.${check.id}`)}</span>
              <span className="ove-health-check-value">{check.value ?? ''}</span>
            </div>
            {check.hint !== null && check.status !== 'ok' ? (
              <div className="ove-health-hint">{t(check.hint)}</div>
            ) : null}
          </div>
        ))}
      </section>

      <section className="ove-health-section">
        <div className="ove-health-section-title">{t('health.capabilities')}</div>
        <div className="ove-health-chips">
          {Object.entries(report.capabilities).map(([key, capability]) => (
            <span
              className={`ove-health-chip ${capability.state === 'available' ? 'ove-health-state-good' : capability.state === 'legacy' ? 'ove-health-state-warn' : capability.state === 'unavailable' ? 'ove-health-state-bad' : 'ove-health-state-idle'}`}
              key={key}
              title={capability.detail ?? undefined}
            >
              {t(`doctor.cap.${key}`)}
              <span className="ove-health-chip-state">{capability.state}</span>
            </span>
          ))}
        </div>
      </section>

      <section className="ove-health-section">
        <div className="ove-health-section-title">{t('health.effective')}</div>
        {Object.keys(report.plugin.effective).length === 0 ? (
          <p className="ove-health-hint">{t('health.effectiveEmpty')}</p>
        ) : (
          <dl className="ove-health-facts">
            {Object.entries(report.plugin.effective).map(([key, value]) => (
              <div className="ove-health-fact-row" key={key}>
                <dt>{t(`doctor.effective.${key}`)}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="ove-health-section">
        <div className="ove-health-section-title">{t('health.origins')}</div>
        <dl className="ove-health-facts">
          {report.connection.origins.map((origin) => (
            <div className="ove-health-fact-row" key={origin.field}>
              <dt>{t(`health.origin.${origin.field}`)}</dt>
              <dd>
                {origin.source}
                {origin.detail !== null ? ` · ${origin.detail}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {report.warnings.length > 0 ? (
        <div className="ove-health-hint">
          {report.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
          ))}
        </div>
      ) : null}
      <div className="ove-health-hint">
        <code>{`curl -s ${report.endpoint}/health`}</code>
      </div>
    </>
  )
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
