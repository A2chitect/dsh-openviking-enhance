/**
 * The shared metric cards, extracted from the v0.5 Activity tab.
 *
 * v0.7 adds a Stats view and an Overview to the plugin, both of which show the
 * same `MetricsPayload`. Rendering it three times by copy-paste is how the two
 * surfaces drift, so the card markup lives here and `activity-panel.tsx` imports
 * it: the Activity tab, the native Stats view and the Overview stat tiles all
 * render the same components.
 *
 * Each card is independently degradable — `MetricsPayload` models availability
 * per card — and the numbers are the server's own REST numbers (`/metrics`
 * Prometheus is never probed).
 */
import type { ReactNode } from 'react'
import type {
  MetricsDashboardCard,
  MetricsMemoriesCard,
  MetricsPayload,
  MetricsQueueCard,
  MetricsSessionCard,
} from '../shared/protocol.ts'
import { t } from './locale.ts'

/** The card shell: a title and one body, or the "unavailable" note. */
export function MetricCard({ title, available, children }: { title: string; available: boolean; children: ReactNode }) {
  return (
    <div className="ove-act-card">
      <span className="ove-act-card-title">{title}</span>
      {available ? children : <span className="ove-act-note">{t('activity.metricsUnavailable')}</span>}
    </div>
  )
}

/** Dashboard totals: context counts, tokens and retrievals. */
export function DashboardCardContent({ dashboard }: { dashboard: MetricsDashboardCard | null | undefined }) {
  return (
    <dl className="ove-act-facts">
      <div>
        <dt>{t('activity.files')}</dt>
        <dd>{dashboard?.files ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.memoriesTotal')}</dt>
        <dd>{dashboard?.memories ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.todayTokens')}</dt>
        <dd>{dashboard?.todayTokens ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.todayRetrievals')}</dt>
        <dd>{dashboard?.todayRetrievals ?? '—'}</dd>
      </div>
    </dl>
  )
}

/** The observer queue table. */
export function QueueCardContent({ queue }: { queue: MetricsQueueCard | null | undefined }) {
  if ((queue?.queues.length ?? 0) === 0) return <span className="ove-act-note">{t('activity.queueEmpty')}</span>
  return (
    <table className="ove-act-table">
      <thead>
        <tr>
          <th>{t('activity.queueName')}</th>
          <th>{t('activity.queuePending')}</th>
          <th>{t('activity.queueErrors')}</th>
        </tr>
      </thead>
      <tbody>
        {(queue?.queues ?? []).map((entry) => (
          <tr key={entry.queue}>
            <td>{entry.queue}</td>
            <td>{entry.pending + entry.inProgress}</td>
            <td className={entry.errors > 0 ? 'ove-act-error-inline' : ''}>{entry.errors}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Memory totals and staleness facts. */
export function MemoriesCardContent({ memories }: { memories: MetricsMemoriesCard | null | undefined }) {
  return (
    <dl className="ove-act-facts">
      <div>
        <dt>{t('activity.memoriesTotal')}</dt>
        <dd>{memories?.total ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.stale7d')}</dt>
        <dd>{memories?.stale7d ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.stale30d')}</dt>
        <dd>{memories?.stale30d ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.oldestDays')}</dt>
        <dd>{memories?.oldestDays ?? '—'}</dd>
      </div>
    </dl>
  )
}

/** Per-session totals (empty hint when the panel had no session to ask about). */
export function SessionCardContent({ session }: { session: MetricsSessionCard | null | undefined }) {
  if (session?.available === false && session.error === 'no-session') {
    return <span className="ove-act-note">{t('native.stats.noSession')}</span>
  }
  return (
    <dl className="ove-act-facts">
      <div>
        <dt>{t('activity.turns')}</dt>
        <dd>{session?.totalTurns ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('activity.sessionMemories')}</dt>
        <dd>{session?.memoriesExtracted ?? '—'}</dd>
      </div>
    </dl>
  )
}

/** A `{key: count}` map as a small two-column table (empty when nothing reported). */
export function CountTable({ counts, emptyLabel }: { counts: Record<string, number>; emptyLabel: string }) {
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1])
  if (entries.length === 0) return <span className="ove-act-note">{emptyLabel}</span>
  return (
    <table className="ove-act-table">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The four metric cards the Activity tab and the native Stats view share.
 *
 * Rendered as a fragment so callers can put their own cards (capture state,
 * audit trail, extra memory detail) beside them in the same grid.
 */
export function MetricsCards({ metrics }: { metrics: MetricsPayload | null }) {
  return (
    <>
      <MetricCard title={t('activity.cardDashboard')} available={metrics?.dashboard.available === true}>
        <DashboardCardContent dashboard={metrics?.dashboard} />
      </MetricCard>
      <MetricCard title={t('activity.cardQueue')} available={metrics?.queue.available === true}>
        <QueueCardContent queue={metrics?.queue} />
      </MetricCard>
      <MetricCard title={t('activity.cardMemories')} available={metrics?.memories.available === true}>
        <MemoriesCardContent memories={metrics?.memories} />
      </MetricCard>
      <MetricCard title={t('activity.cardSession')} available={metrics?.session.available === true}>
        <SessionCardContent session={metrics?.session} />
      </MetricCard>
    </>
  )
}
