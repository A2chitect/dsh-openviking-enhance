/**
 * F5: the `viking://` preview tab.
 *
 * A third right-Sidebar page type (see `index.tsx` for the two-stage
 * registration). It shows one entry: metadata from `fs/stat`+`fs/attrs`, then
 * the server's three read tiers — L0 abstract, L1 overview, L2 full text — with
 * a switcher, a copy-URI control and "open in Studio".
 *
 * Two design points:
 *
 *  - **The selection is module state, not slot props.** Any URI the plugin
 *    renders can call `openPreview(uri)`; the tab body subscribes through
 *    `usePreviewTarget`, so an already-open preview re-targets instead of
 *    relying on a second tab. The address bar at the top is the same mechanism:
 *    it sets the target for every preview surface.
 *  - **Text only, never HTML.** L2 is the stored Markdown body; rendering it as
 *    text keeps a memory body from ever becoming markup in the GUI.
 *
 * The whole payload arrives in one host request (all three tiers), so switching
 * between L0/L1/L2 is instant and there is no per-tier request to race.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { classifyCuratableUri } from '../shared/curation.ts'
import {
  PREVIEW_MAX_CHARS,
  PREVIEW_TIERS,
  type PreviewPayload,
  type PreviewStat,
  type PreviewTier,
  type PreviewTierId,
} from '../shared/protocol.ts'
import { copyText } from './clipboard.ts'
import { fetchPreview, prepareWrite } from './host-api.ts'
import { errorText, noticeText, t, writeErrorText } from './locale.ts'
import { openPreview, usePreviewTarget } from './preview-store.ts'
import { ScopeChip } from './scope-chip.tsx'
import { ensureScope, useScope } from './scope-store.ts'
import { notifyWriteSettled, openWriteConfirm, useWriteStore } from './write-store.ts'

/**
 * The slice of the framework's per-tab information this panel reads.
 *
 * The real type is `SidebarRightTabInfo` from
 * `@deepseek-ai/dsh-client-ui-sidebar-right/client`; only the navigation is used
 * here, and keeping the dependency structural makes the component renderable in
 * the server-side tests and on harness generations that predate the hook.
 */
export interface PreviewTabInfoLike {
  readonly tab: {
    readonly navigation: {
      /** What the `openTab(kind, {params})` call carried. */
      readonly params: unknown
      /** Incremented on every navigation to this tab. */
      readonly revision: number
    }
  }
}

/** The framework-bound `useTabInfo` hook the tab slot injects. */
export type UsePreviewTabInfo = () => PreviewTabInfoLike

/** Panel props: the session the tab was opened in (the preview itself is global). */
export interface PreviewPanelProps {
  sessionId: string
  /** Present on the live sidebar; absent in server renders and older harnesses. */
  useTabInfo?: UsePreviewTabInfo
}

/** The target URI out of `navigation.params`, when it has one. */
export function previewUriParam(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const uri = (params as { uri?: unknown }).uri
  return typeof uri === 'string' && uri.trim().length > 0 ? uri.trim() : null
}

const TIER_LABELS: Record<PreviewTierId, string> = {
  l0: 'preview.tier.l0',
  l1: 'preview.tier.l1',
  l2: 'preview.tier.l2',
}

/** Human bytes: `3110 B`, `12.4 KB`, `1.2 MB`. */
function formatBytes(size: number | null): string {
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
function firstAvailableTier(payload: PreviewPayload | null): PreviewTierId {
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
function MetaBlock({ stat }: { stat: PreviewStat }) {
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

/** A glyph for the address bar, matching the recall panel's 14px chrome. */
function LinkGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 9.5 9.5 6.5M5.2 8.3 3.9 9.6a2.4 2.4 0 0 0 0 3.4 2.4 2.4 0 0 0 3.4 0l1.3-1.3M10.8 7.7l1.3-1.3a2.4 2.4 0 0 0 0-3.4 2.4 2.4 0 0 0-3.4 0L7.4 4.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PreviewPanel(props: PreviewPanelProps) {
  // Params-first: the live sidebar hands the target through `openTab`, which is
  // also how a re-open of the same page re-targets it. The store is the fallback
  // for harness generations whose `openTab` ignores params, and the channel the
  // tab's own address bar uses.
  const info = props.useTabInfo === undefined ? undefined : props.useTabInfo()
  const paramUri = info === undefined ? null : previewUriParam(info.tab.navigation.params)
  const target = usePreviewTarget()
  const targetUri = paramUri ?? target?.uri ?? null
  const [draft, setDraft] = useState(targetUri ?? '')
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tierId, setTierId] = useState<PreviewTierId>('l0')
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** L2 paging state: "Show more" appends one bounded page instead of the whole file. */
  const [pageLoading, setPageLoading] = useState(false)
  const scope = useScope()
  const writeState = useWriteStore()
  /** Guards a slow reply from a previous URI overwriting the current one. */
  const generation = useRef(0)
  const loadedUri = useRef<string | null>(null)

  const load = useCallback(async (uri: string) => {
    const ticket = (generation.current += 1)
    setLoading(true)
    setCopied(false)
    try {
      const answer = await fetchPreview(uri)
      if (ticket !== generation.current) return
      if (answer.ok) {
        setPayload(answer.preview)
        loadedUri.current = answer.preview.uri
        setError(null)
        setTierId(firstAvailableTier(answer.preview))
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
  }, [])

  // The target IS the request: a click anywhere sets it, and this effect loads
  // whatever the newest target is. Clearing the target clears the panel.
  useEffect(() => {
    if (targetUri === null) {
      setDraft('')
      setPayload(null)
      setError(null)
      setLoading(false)
      generation.current += 1
      return
    }
    setDraft(targetUri)
    void load(targetUri)
  }, [targetUri, load])

  // The scope chip and the write gates are shared state; a panel that never
  // asks would render a stale "no profile" chip.
  useEffect(() => {
    void ensureScope()
  }, [])

  // After a write settles, re-read the entry from the server. Never optimistic:
  // a verified write is the only state the panel is allowed to show.
  useEffect(() => {
    if (writeState.lastWriteSeq === 0) return
    const target = loadedUri.current
    if (target === null) return
    if (writeState.lastWriteTarget !== null && writeState.lastWriteTarget !== target) return
    void load(target)
  }, [writeState.lastWriteSeq, writeState.lastWriteTarget, load])

  /**
   * The address-bar action: navigate to a different URI, or refetch the one
   * already shown. Re-recording the same target would emit nothing (the store
   * dedupes identical targets), so a true refresh calls the loader itself.
   *
   * A different URI goes through `openPreview`, not `setPreviewTarget`: a page
   * opened from a link carries its target in the tab's navigation params, which
   * take priority over the store, so recording the store alone would leave the
   * address bar looking dead. Routing through the opener navigates the same
   * channel the links use; on harness generations whose `openTab` ignores params
   * the store fallback still carries the target.
   */
  const submit = useCallback(() => {
    const next = draft.trim()
    if (next.length === 0) return
    if (next === targetUri) void load(next)
    else openPreview(next)
  }, [draft, targetUri, load])

  /**
   * Append the next L2 line page.
   *
   * The first read asks for `PREVIEW_BODY_MAX_LINES`; the server's `offset` is a
   * 0-based line number, so each click is one more bounded read. The displayed
   * text stays capped at `PREVIEW_MAX_CHARS`; when the server says there is no
   * next page (or the display cap is hit) the control disappears.
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
        setActionError(errorText(answer.error))
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
        setActionError(problem instanceof Error ? problem.message : String(problem))
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

  /* ---- v0.5: the curation action bar (F9) ----------------------------- */

  const classification = payload === null ? null : classifyCuratableUri(payload.uri)
  const curatable = classification !== null && classification.ok && payload?.stat?.isDir === false
  const writesReady =
    scope.scope !== null && scope.scope.writes.enabled && scope.scope.writes.transport
  const prepareAction = async (action: 'edit-memory' | 'delete-memory' | 'set-tags'): Promise<void> => {
    if (payload === null) return
    setActionError(null)
    const answer = await prepareWrite({
      action,
      target: payload.uri,
      ...(props.sessionId.length === 0 ? {} : { sessionId: props.sessionId }),
    })
    if (answer.ok) openWriteConfirm(answer)
    else setActionError(writeErrorText(answer.error))
  }

  return (
    <div className="ove-preview">
      <div className="ove-preview-bar">
        <label className="ove-preview-field">
          <span className="ove-preview-field-icon">
            <LinkGlyph />
          </span>
          <input
            className="ove-preview-input"
            value={draft}
            placeholder={t('preview.addressPlaceholder')}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </label>
        <button
          type="button"
          className="ove-preview-button"
          onClick={submit}
          disabled={loading || draft.trim().length === 0}
        >
          {t('preview.refresh')}
        </button>
        {payload !== null && (
          <>
            <button type="button" className="ove-preview-button" onClick={() => void copy()}>
              {copied ? t('preview.copied') : t('preview.copyUri')}
            </button>
            <button type="button" className="ove-preview-button" onClick={openStudio}>
              {t('preview.openStudio')}
            </button>
          </>
        )}
        <span className="ove-preview-spacer" />
        <ScopeChip compact />
      </div>

      <div className="ove-preview-body">
        {targetUri === null && (
          <>
            <p className="ove-preview-status">{t('preview.empty')}</p>
            <p className="ove-preview-hint">{t('preview.emptyHint')}</p>
          </>
        )}

        {loading && payload === null && <p className="ove-preview-status">{t('preview.loading')}</p>}

        {/* F9: after a confirmed delete the panel re-reads the server, which now
            answers "not found". That is the honest tombstone: the action is done,
            and the undo handle lives in the outcome toast. */}
        {error !== null && payload === null && writeState.lastWriteAction === 'delete-memory' && writeState.lastWriteTarget === targetUri && (
          <div className="ove-preview-tombstone">
            <p className="ove-preview-status">{t('preview.deleted', { uri: targetUri ?? '' })}</p>
            <p className="ove-preview-hint">{t('preview.deletedHint')}</p>
          </div>
        )}
        {error !== null && payload === null && !(writeState.lastWriteAction === 'delete-memory' && writeState.lastWriteTarget === targetUri) && (
          <p className="ove-preview-error">{errorText(error)}</p>
        )}

        {payload !== null && (
          <>
            <div className="ove-preview-uri-row">
              <span className="ove-preview-uri" title={payload.uri}>
                {payload.uri}
              </span>
            </div>
            {/*
              F9 action bar: only for a curatable memory file and only when the
              writes switch and the authenticated transport are both live. Every
              button raises the same prepare/confirm dialog as `/viking forget`.
            */}
            {payload.stat?.isDir === false &&
              (curatable ? (
                writesReady ? (
                  <div className="ove-preview-actions">
                    <span className="ove-preview-actions-title">{t('write.actionsTitle')}</span>
                    <button type="button" className="ove-preview-button" onClick={() => void prepareAction('edit-memory')}>
                      {t('write.edit')}
                    </button>
                    <button type="button" className="ove-preview-button" onClick={() => void prepareAction('set-tags')}>
                      {t('write.tags')}
                    </button>
                    <button
                      type="button"
                      className="ove-preview-button ove-preview-danger"
                      onClick={() => void prepareAction('delete-memory')}
                    >
                      {t('write.delete')}
                    </button>
                  </div>
                ) : (
                  <p className="ove-preview-hint">
                    {t('write.actionsDisabled', { reason: scope.scope?.writes.reason ?? 'writes-disabled' })}
                  </p>
                )
              ) : (
                <p className="ove-preview-hint">{t('write.readOnlyInVersion', { reason: classification?.ok === false ? classification.reason : 'not-memory-body' })}</p>
              ))}
            {actionError !== null && <p className="ove-preview-error">{actionError}</p>}
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

            {tier !== undefined && (
              <div className="ove-preview-text-wrap">
                {!tier.available ? (
                  tier.id === 'l2' && payload.stat?.isDir === true ? (
                    <p className="ove-preview-hint">{t('preview.directoryBody')}</p>
                  ) : (
                    <p className="ove-preview-error">
                      {t('preview.tierUnavailable', { error: errorText(tier.error ?? '') })}
                    </p>
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
                        <button
                          type="button"
                          className="ove-preview-button"
                          disabled={pageLoading}
                          onClick={() => void showMore()}
                        >
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
    </div>
  )
}
