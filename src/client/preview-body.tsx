/**
 * The shared `viking://` preview body (v0.7 extraction).
 *
 * Rendering one entry — metadata from `fs/stat`+`fs/attrs`, the three read tiers
 * (L0/L1/L2), paging the L2 body, "not generated yet" placeholders, copy-URI and
 * open-in-Studio — used to live inside the v0.4 preview tab. v0.7 adds a native
 * preview pane in the cockpit's Browse view, and two implementations would drift
 * (and let the read-only pane grow a write path). So the body is this component;
 * the right-Sidebar `PreviewPanel` keeps its address bar, tab chrome and the v0.5
 * curation action bar (passed in through `renderActions`), while the native pane
 * passes `readOnly` and renders no write surface at all.
 *
 * Text only, never HTML: L2 is the stored Markdown body and is rendered as text,
 * so a memory body can never become markup in the GUI.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  PREVIEW_MAX_CHARS,
  PREVIEW_TIERS,
  type PreviewPayload,
  type PreviewStat,
  type PreviewTier,
  type PreviewTierId,
} from '../shared/protocol.ts'
import { copyText } from './clipboard.ts'
import { fetchPreview } from './host-api.ts'
import { errorText, noticeText, t } from './locale.ts'

const TIER_LABELS: Record<PreviewTierId, string> = {
  l0: 'preview.tier.l0',
  l1: 'preview.tier.l1',
  l2: 'preview.tier.l2',
}

/** Human bytes: `3110 B`, `12.4 KB`, `1.2 MB`. */
export function formatBytes(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** The first tier the server actually returned, falling back to L0. */
export function firstAvailableTier(payload: PreviewPayload | null): PreviewTierId {
  const found = payload?.tiers.find((tier) => tier.available)
  return found?.id ?? 'l0'
}

/** One metadata row; a null value is omitted by the caller. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ove-preview-meta-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

/** The metadata block: only the facts the server actually reported. */
export function MetaBlock({ stat }: { stat: PreviewStat }) {
  const type = [stat.contextType, stat.memoryType, stat.category].filter(
    (part): part is string => part !== null && part.length > 0,
  )
  const rows: Array<{ label: string; value: string }> = [
    { label: t('preview.name'), value: stat.name },
    { label: t('preview.type'), value: type.length > 0 ? type.join(' / ') : stat.isDir === true ? 'directory' : 'file' },
    { label: t('preview.size'), value: formatBytes(stat.size) },
    ...(stat.modifiedAt === null ? [] : [{ label: t('preview.modified'), value: stat.modifiedAt }]),
    ...(stat.isLocked === true ? [{ label: t('preview.locked'), value: '🔒' }] : []),
    ...(stat.tags.length === 0 ? [] : [{ label: t('preview.tags'), value: stat.tags.join(', ') }]),
  ]
  return (
    <details className="ove-preview-meta" open>
      <summary>{t('preview.metadata')}</summary>
      <dl>
        {rows.map((row) => (
          <MetaRow key={row.label} label={row.label} value={row.value} />
        ))}
      </dl>
    </details>
  )
}

export interface PreviewBodyProps {
  /** The `viking://` entry to show. */
  uri: string
  /**
   * The native pane's mode: no address bar (that is the tab's job) and no write
   * path. The parent's `renderActions` is simply not passed, and this flag is
   * used for the read-only hint only.
   */
  readOnly?: boolean
  /** Bumped by the surrounding view's Refresh control. */
  refreshKey?: number
  /** Bumped after a write settles, so the tab re-reads the server. */
  reloadToken?: number
  /** Rendered after the URI row when a payload exists (the curation bar). */
  renderActions?: (payload: PreviewPayload) => ReactNode
  /** Replaces the plain error line (the preview tab's delete tombstone). */
  renderError?: (error: string) => ReactNode
  /** Native pane: how to reach the action-capable Preview tab for this entry. */
  onOpenInActions?: (uri: string) => void
  /** Extra class on the scrolling body (native panes size differently). */
  className?: string
}

/**
 * The preview body. One host request returns stat + L0/L1 + one bounded L2 page;
 * "Show more" asks for the next offset instead of downloading the file.
 */
export function PreviewBody(props: PreviewBodyProps) {
  const { uri, readOnly = false, refreshKey = 0, reloadToken = 0, className } = props
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tierId, setTierId] = useState<PreviewTierId>('l0')
  const [copied, setCopied] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  /** Guards a slow reply from a previous URI overwriting the current one. */
  const generation = useRef(0)

  const load = useCallback(
    async (target: string) => {
      const ticket = (generation.current += 1)
      setLoading(true)
      setCopied(false)
      try {
        const answer = await fetchPreview(target)
        if (ticket !== generation.current) return
        if (answer.ok) {
          setPayload(answer.preview)
          setError(null)
          setTierId(firstAvailableTier(answer.preview))
          setPageError(null)
        } else {
          setPayload(null)
          setError(answer.error)
        }
      } catch (problem) {
        if (ticket !== generation.current) return
        setPayload(null)
        setError(problem instanceof Error ? problem.message : String(problem))
      } finally {
        if (ticket === generation.current) setLoading(false)
      }
    },
    [],
  )

  // The target IS the request: a click elsewhere sets the URI and this effect
  // loads whatever the newest target is.
  useEffect(() => {
    const trimmed = uri.trim()
    if (trimmed.length === 0) {
      setPayload(null)
      setError(null)
      setLoading(false)
      generation.current += 1
      return
    }
    void load(trimmed)
  }, [uri, refreshKey, reloadToken, load])

  /**
   * Append the next L2 line page.
   *
   * The displayed text stays capped at `PREVIEW_MAX_CHARS`; when the server says
   * there is no next page (or the display cap is hit) the control disappears.
   */
  const showMore = useCallback(async () => {
    if (payload === null) return
    const l2 = payload.tiers.find((candidate) => candidate.id === 'l2')
    if (l2 === undefined || l2.nextOffset === null) return
    const ticket = generation.current
    setPageLoading(true)
    try {
      const answer = await fetchPreview(payload.uri, { offset: l2.nextOffset })
      if (generation.current !== ticket) return
      if (!answer.ok) {
        setPageError(errorText(answer.error))
        return
      }
      const page = answer.preview.tiers.find((candidate) => candidate.id === 'l2')
      if (page === undefined) return
      setPayload((current) => {
        if (current === null || current.uri !== payload.uri) return current
        const currentL2 = current.tiers.find((candidate) => candidate.id === 'l2')
        if (currentL2 === undefined) return current
        const separator = currentL2.text.length > 0 && !currentL2.text.endsWith('\n') && page.text.length > 0 ? '\n' : ''
        const merged = `${currentL2.text}${separator}${page.text}`
        const clipped = merged.length > PREVIEW_MAX_CHARS
        return {
          ...current,
          tiers: current.tiers.map((candidate) =>
            candidate.id === 'l2'
              ? {
                  ...candidate,
                  text: merged.slice(0, PREVIEW_MAX_CHARS),
                  truncated: clipped || candidate.truncated || page.truncated,
                  nextOffset: clipped ? null : page.nextOffset,
                }
              : candidate,
          ),
        }
      })
    } catch (problem) {
      if (generation.current === ticket) {
        setPageError(problem instanceof Error ? problem.message : String(problem))
      }
    } finally {
      if (generation.current === ticket) setPageLoading(false)
    }
  }, [payload])

  const copy = useCallback(async () => {
    if (payload === null) return
    const ok = await copyText(payload.uri)
    if (ok) setCopied(true)
  }, [payload])

  const openStudio = useCallback(() => {
    if (payload === null || typeof window === 'undefined') return
    window.open(payload.studioUrl, '_blank', 'noopener,noreferrer')
  }, [payload])

  const tier: PreviewTier | undefined = payload?.tiers.find((candidate) => candidate.id === tierId)
  const trimmedUri = uri.trim()

  return (
    <div className={`ove-preview-body${className === undefined ? '' : ` ${className}`}`}>
      {trimmedUri.length === 0 && (
        <>
          <p className="ove-preview-status">{t('preview.empty')}</p>
          <p className="ove-preview-hint">{t('preview.emptyHint')}</p>
        </>
      )}

      {loading && payload === null && <p className="ove-preview-status">{t('preview.loading')}</p>}

      {error !== null && payload === null && trimmedUri.length > 0 && (
        props.renderError === undefined ? <p className="ove-preview-error">{errorText(error)}</p> : props.renderError(error)
      )}

      {payload !== null && (
        <>
          <div className="ove-preview-uri-row">
            <span className="ove-preview-uri" title={payload.uri}>
              {payload.uri}
            </span>
            <span className="ove-preview-inline-actions">
              <button type="button" className="ove-preview-button" onClick={() => void copy()}>
                {copied ? t('preview.copied') : t('preview.copyUri')}
              </button>
              <button type="button" className="ove-preview-button" onClick={openStudio}>
                {t('preview.openStudio')}
              </button>
              {readOnly && props.onOpenInActions !== undefined && (
                <button type="button" className="ove-preview-button" onClick={() => props.onOpenInActions?.(payload.uri)}>
                  {t('native.preview.curate')}
                </button>
              )}
            </span>
          </div>
          {props.renderActions?.(payload)}
          {payload.stat !== null && <MetaBlock stat={payload.stat} />}
          {payload.stat !== null && payload.stat.isDir === false && (
            <p className="ove-preview-hint">{t('preview.sidecarNote')}</p>
          )}

          <div className="ove-preview-tiers" role="tablist" aria-label={t('preview.metadata')}>
            {PREVIEW_TIERS.map((id) => {
              const candidate = payload.tiers.find((entry) => entry.id === id)
              const available = candidate?.available === true
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tierId === id}
                  className={`ove-preview-tier${tierId === id ? ' ove-preview-tier-active' : ''}`}
                  title={available ? t(TIER_LABELS[id]) : t('preview.tierUnavailable', { error: candidate?.error ?? '—' })}
                  disabled={!available}
                  onClick={() => setTierId(id)}
                >
                  {t(TIER_LABELS[id])}
                </button>
              )
            })}
          </div>

          {pageError !== null && <p className="ove-preview-error">{pageError}</p>}

          {tier !== undefined && (
            <div className="ove-preview-text-wrap">
              {!tier.available ? (
                tier.id === 'l2' && payload.stat?.isDir === true ? (
                  <p className="ove-preview-hint">{t('preview.directoryBody')}</p>
                ) : (
                  <p className="ove-preview-error">{t('preview.tierUnavailable', { error: errorText(tier.error ?? '') })}</p>
                )
              ) : tier.placeholder ? (
                <p className="ove-preview-hint">{t('preview.notGenerated')}</p>
              ) : tier.text.length === 0 ? (
                <p className="ove-preview-hint">{t('preview.emptyText')}</p>
              ) : (
                <>
                  <pre className="ove-preview-text">{tier.text}</pre>
                  {tier.truncated && <p className="ove-preview-hint">{t('preview.truncated')}</p>}
                  {tier.id === 'l2' && tier.nextOffset !== null && (
                    <div className="ove-preview-more">
                      <button type="button" className="ove-preview-button" disabled={pageLoading} onClick={() => void showMore()}>
                        {pageLoading ? t('preview.loading') : t('preview.showMore')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {payload.warnings.length > 0 && (
            <div className="ove-preview-warnings">
              {payload.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
