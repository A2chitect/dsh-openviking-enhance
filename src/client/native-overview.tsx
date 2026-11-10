/**
 * The native cockpit's default view: one composed `/overview` round trip.
 *
 * Parts degrade independently (`OverviewPayload.parts`): an unreachable server
 * leaves the identity and Studio cards readable, a metrics failure leaves the
 * stat tiles explained rather than blank. Quick actions navigate inside the
 * cockpit; Rules/Experience/Doctor open the existing right-Sidebar tabs, because
 * v0.7 deliberately does not duplicate those surfaces.
 */
import { useEffect, useState } from 'react'
import type { OverviewPayload, PluginNotice } from '../shared/protocol.ts'
import { fetchOverview } from './host-api.ts'
import { noticeText, t, writeErrorText } from './locale.ts'
import { navigate, useNative } from './native-store.ts'
import { OnboardingCard } from './onboarding-card.tsx'
import { openRightTab } from './tab-store.ts'

/** How many characters of a fingerprint the Overview shows. */
const FINGERPRINT_PREFIX = 19

function PartNotice({ label, error }: { label: string; error: string }) {
  return (
    <div className="ove-nat-part-error" role="status">
      <span className="ove-nat-part-error-label">{label}</span>
      <span>{writeErrorText({ code: 'part-unavailable', message: error })}</span>
    </div>
  )
}

function Warnings({ warnings }: { warnings: readonly PluginNotice[] }) {
  if (warnings.length === 0) return null
  return (
    <div className="ove-nat-warnings">
      {warnings.slice(0, 5).map((warning, index) => (
        <div key={`${warning.code}-${index}`}>⚠ {noticeText(warning)}</div>
      ))}
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="ove-nat-tile">
      <span className="ove-nat-tile-label">{label}</span>
      <span className="ove-nat-tile-value">{value ?? '—'}</span>
    </div>
  )
}

function CapabilityChip({ name, available }: { name: string; available: boolean }) {
  return (
    <span className={`ove-nat-chip${available ? ' ove-nat-chip-ok' : ' ove-nat-chip-muted'}`}>
      {t(`native.overview.capability.${name}`)}
    </span>
  )
}

export interface NativeOverviewProps {
  /** Incremented by the panel's Refresh control; >0 means "bypass caches". */
  refreshKey: number
}

export function NativeOverview(props: NativeOverviewProps) {
  const native = useNative()
  const [payload, setPayload] = useState<OverviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    void fetchOverview(props.refreshKey > 0, controller.signal).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setPayload(answer.overview)
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
  }, [props.refreshKey])

  if (loading && payload === null) {
    return (
      <div className="ove-nat-view">
        <p className="ove-preview-status">{t('native.loading')}</p>
      </div>
    )
  }
  if (error !== null && payload === null) {
    return (
      <div className="ove-nat-view">
        <p className="ove-preview-error">{t('native.overview.failed', { error })}</p>
        <p className="ove-preview-hint">{t('native.offlineHint')}</p>
        <div className="ove-nat-actions">
          <button type="button" className="ove-preview-button" onClick={() => openRightTab('openviking-health')}>
            {t('native.openDoctor')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'studio' })}>
            {t('native.openStudio')}
          </button>
        </div>
      </div>
    )
  }
  if (payload === null) return null

  const config = payload.config
  const scope = payload.scope
  const metrics = payload.metrics
  const dashboard = metrics?.dashboard
  const studio = payload.studio
  const identity = scope?.identity ?? null
  const fingerprint = identity === null ? null : identity.fingerprint.slice(0, FINGERPRINT_PREFIX)

  return (
    <div className="ove-nat-view ove-nat-overview">
      <header className="ove-nat-headline">
        <span className={`ove-dot ${config?.healthy === true ? 'ove-dot-ok' : 'ove-dot-bad'}`} />
        <span className="ove-nat-headline-title">{t('native.overview.title')}</span>
        {config?.version != null && <span className="ove-nat-muted">{`OpenViking v${config.version}`}</span>}
        {config?.authMode != null && <span className="ove-nat-muted">{t('native.overview.authMode', { mode: config.authMode })}</span>}
        <span className="ove-nat-spacer" />
        {studio !== null && (
          <span className={`ove-nat-chip ${studio.frameable === 'no' ? 'ove-nat-chip-bad' : studio.frameable === 'yes' ? 'ove-nat-chip-ok' : 'ove-nat-chip-muted'}`}>
            {t(`native.studio.frameable.${studio.frameable}`)}
          </span>
        )}
      </header>

      {payload.parts.config.error !== null && <PartNotice label={t('native.overview.part.config')} error={payload.parts.config.error} />}
      {payload.parts.scope.error !== null && <PartNotice label={t('native.overview.part.scope')} error={payload.parts.scope.error} />}
      {payload.parts.metrics.error !== null && <PartNotice label={t('native.overview.part.metrics')} error={payload.parts.metrics.error} />}
      {payload.parts.studio.error !== null && <PartNotice label={t('native.overview.part.studio')} error={payload.parts.studio.error} />}

      <section className="ove-nat-section">
        <div className="ove-nat-section-title">{t('native.overview.identity')}</div>
        {scope === null ? (
          <p className="ove-preview-hint">{t('native.overview.partUnavailable')}</p>
        ) : (
          <div className="ove-nat-facts">
            <span className="ove-nat-fact">
              <span className="ove-nat-fact-label">{t('native.overview.account')}</span>
              <code>{identity?.account ?? '—'}</code>
            </span>
            <span className="ove-nat-fact">
              <span className="ove-nat-fact-label">{t('native.overview.user')}</span>
              <code>{identity?.user ?? '—'}</code>
            </span>
            {identity?.peer !== null && identity?.peer !== undefined && (
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.overview.peer')}</span>
                <code>{identity.peer}</code>
              </span>
            )}
            {identity?.profileLabel != null && (
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.overview.profile')}</span>
                <code>{identity.profileLabel}</code>
              </span>
            )}
            {fingerprint !== null && (
              <span className="ove-nat-fact" title={identity?.fingerprint ?? ''}>
                <span className="ove-nat-fact-label">{t('native.overview.fingerprint')}</span>
                <code>{fingerprint}…</code>
              </span>
            )}
            <span className="ove-nat-fact">
              <span className="ove-nat-fact-label">{t('native.overview.writes')}</span>
              <code>{scope.writes.enabled ? t('native.overview.on') : t('native.overview.off')}</code>
            </span>
          </div>
        )}
      </section>

      <section className="ove-nat-section">
        <div className="ove-nat-section-title">{t('native.overview.stats')}</div>
        {metrics === null ? (
          <p className="ove-preview-hint">{t('native.overview.partUnavailable')}</p>
        ) : (
          <div className="ove-nat-tiles">
            <Tile label={t('activity.files')} value={dashboard?.files ?? null} />
            <Tile label={t('native.overview.skills')} value={dashboard?.skills ?? null} />
            <Tile label={t('activity.memoriesTotal')} value={dashboard?.memories ?? null} />
            <Tile label={t('native.overview.visibleTotal')} value={dashboard?.total ?? null} />
            <Tile label={t('activity.todayTokens')} value={dashboard?.todayTokens ?? null} />
            <Tile label={t('activity.todayRetrievals')} value={dashboard?.todayRetrievals ?? null} />
          </div>
        )}
        {dashboard != null && !dashboard.available && (
          <p className="ove-preview-hint">{t('activity.metricsUnavailable')}</p>
        )}
      </section>

      <section className="ove-nat-section">
        <div className="ove-nat-section-title">{t('native.overview.capabilities')}</div>
        {scope === null ? (
          <p className="ove-preview-hint">{t('native.overview.partUnavailable')}</p>
        ) : (
          <div className="ove-nat-chips">
            {Object.entries(scope.capabilities).map(([name, capability]) => (
              <CapabilityChip key={name} name={name} available={capability.available} />
            ))}
            {studio !== null && (
              <span className={`ove-nat-chip ${studio.frameable === 'no' ? 'ove-nat-chip-bad' : 'ove-nat-chip-muted'}`}>
                {t('native.overview.capability.studio')}: {t(`native.studio.frameable.${studio.frameable}`)}
              </span>
            )}
          </div>
        )}
        <p className="ove-preview-hint">{t('native.overview.capabilitiesHint')}</p>
      </section>

      <OnboardingCard
        onboarding={payload.onboarding}
        enabled={native.switches.onboarding}
        onStateChange={(state) => {
          setPayload((current) => {
            if (current === null || current.onboarding === null) return current
            return { ...current, onboarding: { ...current.onboarding, state } }
          })
        }}
      />

      <section className="ove-nat-section">
        <div className="ove-nat-section-title">{t('native.overview.quickActions')}</div>
        <div className="ove-nat-actions">
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'browse', browse: {} })}>
            {t('native.overview.action.browseMemories')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'sessions' })}>
            {t('native.view.sessions')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'commits' })}>
            {t('native.view.commits')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'stats' })}>
            {t('native.view.stats')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => openRightTab('openviking-explore')}>
            {t('native.overview.action.rulesExperience')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => openRightTab('openviking-health')}>
            {t('native.openDoctor')}
          </button>
          <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'studio' })}>
            {t('native.openStudio')}
          </button>
        </div>
      </section>

      <p className="ove-nat-hint">{t('native.overview.notDoNote')}</p>
      <Warnings warnings={payload.warnings} />
    </div>
  )
}
