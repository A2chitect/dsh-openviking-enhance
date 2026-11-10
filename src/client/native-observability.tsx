/**
 * v0.8 "Operate": the Observability segment of the native Stats view.
 *
 * Read-only, on demand: the host route composes the observer endpoints plus the
 * two console aggregates (token day buckets, context-commit 4 h buckets) and
 * caches the answer; this segment only fetches when the user opens it or presses
 * Refresh. It never requests Prometheus `/metrics` (the v0.5 decision: disabled
 * by default, 404 JSON on the live server).
 *
 * The whole point is per-card degradation: one failing observer card renders its
 * own error line, never a blank page.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ObservabilityPayload } from '../shared/protocol.ts'
import { fetchObservability } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { useNative } from './native-store.ts'

const MAX_DAYS = 7
const DAY_OPTIONS: readonly number[] = [1, 2, 3, 7]

export interface NativeObservabilityProps {
  refreshKey: number
}

export function NativeObservability(props: NativeObservabilityProps) {
  const native = useNative()
  const [days, setDays] = useState(MAX_DAYS)
  const [payload, setPayload] = useState<ObservabilityPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    // Opening the segment is the fetch trigger; `refreshKey` comes from the
    // cockpit toolbar and `nonce` from this view's explicit Refresh.
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    void fetchObservability({ days, fresh: nonce > 0 }, controller.signal).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setPayload(answer)
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
  }, [days, nonce, props.refreshKey])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return (
    <div className="ove-nat-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('obs.title')}</span>
        <span className="ove-nat-muted">{t('obs.subtitle')}</span>
        <span className="ove-nat-spacer" />
        {DAY_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={days === option ? 'ove-ops-tab ove-ops-tab-active' : 'ove-ops-tab'}
            onClick={() => setDays(option)}
          >
            {t('obs.days', { count: option })}
          </button>
        ))}
        <button type="button" onClick={refresh}>
          {t('native.refresh')}
        </button>
      </header>
      <p className="ove-preview-hint">{t('obs.onDemand')}</p>
      <p className="ove-preview-hint">{t('obs.neverMetrics')}</p>
      {native.switches.nativeViews && payload?.cached === true && <p className="ove-nat-muted">{t('obs.cached')}</p>}
      {loading && payload === null && <p className="ove-preview-status">{t('native.loading')}</p>}
      {error !== null && <p className="ove-preview-error">{error}</p>}
      {payload !== null && (
        <>
          <div className="ove-act-cards">
            {payload.cards.map((card) => (
              <div key={card.id} className="ove-metric-card">
                <div className="ove-metric-title">
                  {t(`obs.card.${card.id}`)}
                  <span className={`ove-dot ${card.available ? (card.healthy === false ? 'ove-dot-bad' : 'ove-dot-ok') : 'ove-dot-bad'}`} />
                </div>
                {!card.available && <p className="ove-preview-hint">{card.error === null ? t('obs.unavailable') : t(`obs.error.${card.error}`)}</p>}
                {card.available && card.rows.length > 0 && (
                  <table className="ove-ops-table">
                    <tbody>
                      {card.rows.map((row, index) => (
                        <tr key={index}>
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {card.available && card.facts.length > 0 && (
                  <table className="ove-ops-table">
                    <tbody>
                      {card.facts.map((fact) => (
                        <tr key={fact.key}>
                          <th>{fact.key}</th>
                          <td>{fact.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>

          <div className="ove-act-cards">
            <SeriesCard title={t('obs.tokens')} series={payload.tokens} />
            <SeriesCard title={t('obs.contextCommits')} series={payload.contextCommits} />
          </div>
          {payload.warnings.length > 0 && (
            <div className="ove-nat-warnings">
              {payload.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`}>{t(`notice.${warning.code}`, warning.params)}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SeriesCard(props: { title: string; series: ObservabilityPayload['tokens'] }) {
  return (
    <div className="ove-metric-card">
      <div className="ove-metric-title">{props.title}</div>
      {!props.series.available && (
        <p className="ove-preview-hint">{props.series.note === 'console-disabled' ? t('obs.consoleDisabled') : t('obs.unavailable')}</p>
      )}
      {props.series.available && props.series.rows.length === 0 && <p className="ove-preview-hint">{t('obs.noData')}</p>}
      {props.series.available && props.series.rows.length > 0 && (
        <table className="ove-ops-table">
          <thead>
            <tr>
              {props.series.columns.map((column, index) => (
                <th key={index}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.series.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
