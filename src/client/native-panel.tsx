/**
 * The native cockpit shell (`main["openviking"]` since v0.7).
 *
 * One sidebar row, one main panel — the v0.3 registrations are unchanged. What
 * changed is the page: with `showNativeViews` on (the default) the panel opens
 * on the native Overview and offers internal views Overview / Browse / Sessions /
 * Commits / Stats, with Studio as an explicit view carrying the existing iframe
 * and its "open in a new tab" fallback. With `showNativeViews` off the page
 * renders exactly the v0.6 `StudioPanel` (the documented backwards-compatible
 * fallback for older DSH generations).
 *
 * The toolbar owns what is global: server health/version, the scope chip,
 * in-panel Back/Forward history, view switching and Refresh. Navigation state is
 * the in-memory `native-store.ts`; nothing is persisted and there is no browser
 * URL routing (DSH exposes no route API for main-panel selection).
 */
import { useCallback, useEffect, useState } from 'react'
import type { EnhanceConfig, StudioStatus } from '../shared/protocol.ts'
import { fetchConfig, fetchStudioStatus } from './host-api.ts'
import { noticeText, t, writeErrorText } from './locale.ts'
import { back, canSelectPanel, forward, navigate, useNative } from './native-store.ts'
import { ScopeChip, ScopeSwitchNoticeLine } from './scope-chip.tsx'
import { StudioPanel } from './studio-panel.tsx'
import { NativeOverview } from './native-overview.tsx'
import { NativeBrowse } from './native-browse.tsx'
import { NativeSessions } from './native-sessions.tsx'
import { NativeCommits } from './native-commits.tsx'
import { NativeStats } from './native-stats.tsx'
import { NativeOperate } from './native-operate.tsx'
import type { NativeViewId } from '../shared/protocol.ts'

/** The view switcher's order; Studio is deliberately last (the fallback). */
const VIEW_ORDER: readonly NativeViewId[] = ['overview', 'browse', 'sessions', 'commits', 'operate', 'stats', 'studio']

function viewLabel(view: NativeViewId): string {
  return t(`native.view.${view}`)
}

/**
 * The visible Studio fallback note: the probe's honest verdict above the iframe.
 *
 * Extracted and exported so the server-render harness can pin the states the
 * browser test cannot easily produce (an iframe that refuses to embed cannot
 * report why). `frameable: 'yes'` renders nothing; every other verdict keeps
 * "open in a new tab" one click away.
 */
export function StudioFallbackNote(props: { status: StudioStatus; onOpenInNewTab: () => void }) {
  if (props.status.frameable === 'yes') return null
  return (
    <div className={`ove-nat-studio-note${props.status.frameable === 'no' ? ' ove-nat-studio-blocked' : ''}`} role="status">
      <span>{t(`native.studio.note.${props.status.reason}`, { detail: props.status.detail ?? '' })}</span>
      <button type="button" className="ove-preview-button" onClick={props.onOpenInNewTab}>
        {t('native.studio.openInNewTab')}
      </button>
    </div>
  )
}

/**
 * The Studio fallback view: the v0.6 iframe plus the host probe's honest verdict.
 *
 * The probe never replaces the explicit fallback: it only explains what the
 * browser cannot report about a cross-origin frame, and "open in a new tab" stays
 * one click away in the panel toolbar *and* here. A probe request that itself
 * fails is surfaced as the same `probe-failed` note instead of leaving a blank
 * frame with no explanation.
 */
function StudioView(props: { refreshKey: number; config: EnhanceConfig | null }) {
  const [status, setStatus] = useState<StudioStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void fetchStudioStatus(props.refreshKey > 0, controller.signal).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setStatus(answer.studio)
        return
      }
      // The probe route itself failed (host route missing, transport error):
      // say so rather than rendering an unexplained empty iframe.
      setStatus({
        url: props.config?.studioUrl ?? '',
        frameable: 'unknown',
        reason: 'probe-failed',
        detail: writeErrorText(answer.error),
        observedAt: new Date().toISOString(),
      })
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [props.refreshKey, props.config?.studioUrl])

  const openInTab = (): void => {
    const url = props.config?.studioUrl ?? status?.url
    if (url !== undefined && url.length > 0 && typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="ove-nat-studio">
      {status !== null && <StudioFallbackNote status={status} onOpenInNewTab={openInTab} />}
      <StudioPanel />
    </div>
  )
}

export function NativeCockpit() {
  const native = useNative()
  const [config, setConfig] = useState<EnhanceConfig | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void fetchConfig().then((answer) => {
      if (cancelled) return
      if (answer.ok) setConfig(answer)
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  const studioUrl = config?.studioUrl ?? null
  const canBack = native.index > 0
  const canForward = native.index < native.history.length - 1

  return (
    <div className="ove-panel ove-native" data-dsh-plugin="openviking-enhance">
      <div className="ove-toolbar ove-native-toolbar">
        <span className={`ove-dot ${config?.healthy === true ? 'ove-dot-ok' : 'ove-dot-bad'}`} />
        <span className="ove-title">OpenViking</span>
        {config?.version != null && <span className="ove-empty">{`v${config.version}`}</span>}
        {config !== null && config.account.length > 0 && (
          <span className="ove-empty">{`${config.account}/${config.user}`}</span>
        )}
        <span className="ove-spacer" />
        <ScopeChip compact />
        <div className="ove-native-nav" role="group" aria-label={t('native.nav.label')}>
          <button type="button" onClick={() => back()} disabled={!canBack} title={t('native.nav.back')}>
            ←
          </button>
          <button type="button" onClick={() => forward()} disabled={!canForward} title={t('native.nav.forward')}>
            →
          </button>
        </div>
        <button type="button" onClick={refresh} title={t('native.refreshHint')}>
          {t('native.refresh')}
        </button>
        <button
          type="button"
          title={t('panel.openInTab')}
          onClick={() => {
            if (studioUrl !== null && typeof window !== 'undefined') window.open(studioUrl, '_blank', 'noopener,noreferrer')
          }}
        >
          {t('panel.newTab')}
        </button>
      </div>

      <ScopeSwitchNoticeLine />
      <nav className="ove-native-tabs" role="tablist" aria-label={t('native.nav.views')}>
        {VIEW_ORDER.map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={native.view === view}
            className={`ove-native-tab${native.view === view ? ' ove-native-tab-active' : ''}`}
            onClick={() => navigate({ view })}
          >
            {viewLabel(view)}
          </button>
        ))}
      </nav>

      {config !== null && config.warnings.length > 0 && (
        <div className="ove-nat-warnings ove-native-toolbar-warnings">
          {config.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>⚠ {noticeText(warning)}</div>
          ))}
        </div>
      )}

      <div className="ove-native-body">
        {native.view === 'overview' && <NativeOverview refreshKey={refreshKey} />}
        {native.view === 'browse' && <NativeBrowse refreshKey={refreshKey} />}
        {native.view === 'sessions' && <NativeSessions refreshKey={refreshKey} studioUrl={studioUrl} />}
        {native.view === 'commits' && <NativeCommits refreshKey={refreshKey} />}
        {native.view === 'stats' && <NativeStats refreshKey={refreshKey} />}
        {native.view === 'operate' && <NativeOperate refreshKey={refreshKey} />}
        {native.view === 'studio' && <StudioView refreshKey={refreshKey} config={config} />}
      </div>

      {!canSelectPanel() && (
        <p className="ove-nat-hint">{t('native.fallback.previewTab')}</p>
      )}
    </div>
  )
}

/**
 * The `main["openviking"]` page component.
 *
 * `showNativeViews` is read from the module store the settings watcher fills, so
 * flipping it live re-renders this page without a remount; off means exactly the
 * v0.6 Studio page.
 */
export function OpenVikingPanel() {
  const native = useNative()
  return native.switches.nativeViews ? <NativeCockpit /> : <StudioPanel />
}
