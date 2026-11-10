/**
 * The native Stats view.
 *
 * Reuses the v0.5 `MetricsPayload` (`/console/dashboard/summary`,
 * `/observer/queue`, `/stats/memories`, `/stats/sessions`) and the metric cards
 * extracted from the Activity tab, so the two surfaces cannot drift. Prometheus
 * `/metrics` is never probed (v0.5 decision); `prometheus` stays `false`.
 *
 * The native panel is root-scoped, so the default request carries no session id:
 * the session card renders its documented `no-session` hint instead of an error.
 * A session-scoped deep link may pass one; the card then fills in.
 */
import { useEffect, useState } from 'react'
import type { MetricsPayload } from '../shared/protocol.ts'
import { fetchMetrics } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { CountTable, MemoriesCardContent, MetricCard, MetricsCards, QueueCardContent } from './metrics-view.tsx'
import { NativeObservability } from './native-observability.tsx'
import { useNative } from './native-store.ts'

export interface NativeStatsProps {
  refreshKey: number
}

/**
 * v0.8: the Stats view gains a second segment. Metrics is the v0.7 cards (the
 * default, unchanged); Observability is the new on-demand observer/console view.
 * Nothing is fetched for the segment that is not shown.
 */
export function NativeStats(props: NativeStatsProps) {
  const native = useNative()
  const requested = native.target.stats?.segment
  const [segment, setSegment] = useState<'metrics' | 'observability'>(requested === 'observability' ? 'observability' : 'metrics')
  useEffect(() => {
    if (requested !== undefined && requested !== segment) setSegment(requested)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested])
  return (
    <div className="ove-nat-view ove-stats-segments">
      <nav className="ove-ops-tabs" role="tablist" aria-label={t('native.view.stats')}>
        <button
          type="button"
          role="tab"
          aria-selected={segment === 'metrics'}
          className={`ove-ops-tab${segment === 'metrics' ? ' ove-ops-tab-active' : ''}`}
          onClick={() => setSegment('metrics')}
        >
          {t('native.stats.segment.metrics')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={segment === 'observability'}
          className={`ove-ops-tab${segment === 'observability' ? ' ove-ops-tab-active' : ''}`}
          onClick={() => setSegment('observability')}
        >
          {t('native.stats.segment.observability')}
        </button>
      </nav>
      {segment === 'metrics' ? <MetricsSegment refreshKey={props.refreshKey} /> : <NativeObservability refreshKey={props.refreshKey} />}
    </div>
  )
}

function MetricsSegment(props: NativeStatsProps) {
  const native = useNative()
  const sessionId = native.target.stats?.sessionId
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    void fetchMetrics(sessionId, { fresh: props.refreshKey > 0, signal: controller.signal }).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setMetrics(answer.metrics)
        setError(null)
      } else {
        setError(writeErrorText(answer.error))
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sessionId, props.refreshKey])

  if (loading && metrics === null) {
    return (
      <div className="ove-nat-view">
        <p className="ove-preview-status">{t('native.loading')}</p>
      </div>
    )
  }
  if (error !== null && metrics === null) {
    return (
      <div className="ove-nat-view">
        <p className="ove-preview-error">{t('native.stats.failed', { error })}</p>
        <p className="ove-preview-hint">{t('native.stats.failedHint')}</p>
      </div>
    )
  }
  if (metrics === null) return null

  return (
    <div className="ove-nat-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('native.view.stats')}</span>
        <span className="ove-nat-muted">{t('native.stats.sourceNote')}</span>
        <span className="ove-nat-spacer" />
        <span className="ove-nat-muted">{metrics.observedAt}</span>
      </header>

      <div className="ove-act-cards">
        <MetricsCards metrics={metrics} />
        <MetricCard title={t('native.stats.byCategory')} available={metrics.memories.available}>
          <CountTable counts={metrics.memories.byCategory} emptyLabel={t('native.stats.noData')} />
        </MetricCard>
        <MetricCard title={t('native.stats.hotness')} available={metrics.memories.available}>
          <CountTable counts={metrics.memories.hotness} emptyLabel={t('native.stats.noData')} />
        </MetricCard>
        <MetricCard title={t('native.stats.queueDetail')} available={metrics.queue.available}>
          <QueueCardContent queue={metrics.queue} />
        </MetricCard>
        <MetricCard title={t('native.stats.memoryDetail')} available={metrics.memories.available}>
          <MemoriesCardContent memories={metrics.memories} />
        </MetricCard>
      </div>

      <p className="ove-preview-hint">{t('native.stats.prometheusNote')}</p>
      {metrics.warnings.length > 0 && (
        <div className="ove-nat-warnings">
          {metrics.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>{t(`notice.${warning.code}`, warning.params)}</div>
          ))}
        </div>
      )}
    </div>
  )
}
