/**
 * The native Sessions view: a paginated list over the sessions directory plus a
 * read-only session detail.
 *
 * The server's `GET /api/v1/sessions` has no pagination, so the list pages the
 * sessions directory itself on the host (`fs/ls` with mtime-desc). Filters are
 * client-side over the loaded pages only: there is deliberately no per-row
 * fan-out.
 *
 * Detail reuses the existing bounded `/session-log` payload and the v0.6 diff
 * components — never a transcript. `messages.jsonl` is not read by this view:
 * the server exposes no title, the file is large, and the privacy rule keeps
 * message bodies out of anything but deliberate previews. Studio remains the
 * transcript reader.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MemoryDiff,
  PluginNotice,
  SessionListRow,
  SessionMemoryLog,
} from '../shared/protocol.ts'
import { copyText } from './clipboard.ts'
import { DiffView } from './commit-status.tsx'
import { fetchDiff, fetchSessionLog, fetchSessionsPage } from './host-api.ts'
import { errorText, t, writeErrorText } from './locale.ts'
import { navigate, useNative } from './native-store.ts'
import { openRightTab } from './tab-store.ts'
import { NativeWarnings } from './native-warnings.tsx'

export interface NativeSessionsProps {
  refreshKey: number
  /** Camera-ready Studio URL from the panel toolbar (`/studio/`); null while unknown. */
  studioUrl: string | null
}

type KindFilter = 'all' | 'dsh' | 'local' | 'other'

/** Middle-truncate a session id: `dsh-sess…4f21`. */
function shortSessionId(value: string): string {
  if (value.length <= 22) return value
  return `${value.slice(0, 14)}…${value.slice(-6)}`
}

function phaseLabel(log: SessionMemoryLog | null): string {
  if (log === null) return '—'
  return t(`native.sessions.state.${log.state}`)
}

interface DiffState {
  loading: boolean
  error: string | null
  diff: MemoryDiff | null
}

/** Append host warnings without duplicating an identical code+params pair. */
function mergeListWarnings(current: readonly PluginNotice[], next: readonly PluginNotice[]): PluginNotice[] {
  const seen = new Set(current.map((warning) => `${warning.code}:${JSON.stringify(warning.params ?? {})}`))
  const merged = [...current]
  for (const warning of next) {
    const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(warning)
  }
  return merged
}

export function NativeSessions(props: NativeSessionsProps) {
  const native = useNative()
  const [rows, setRows] = useState<SessionListRow[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [textFilter, setTextFilter] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [log, setLog] = useState<SessionMemoryLog | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailToken, setDetailToken] = useState(0)
  const [openArchive, setOpenArchive] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<PluginNotice[]>([])
  /**
   * One list-request cycle per mount/refresh. A view switch, a Refresh or an
   * unmount aborts the previous cycle, so a page that is no longer needed stops
   * at the host and the client drops its stale answer.
   */
  const listAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listAbortRef.current = controller
    return () => {
      controller.abort()
      if (listAbortRef.current === controller) listAbortRef.current = null
    }
  }, [props.refreshKey])

  const loadPage = useCallback(async (offset: number, append: boolean): Promise<void> => {
    const signal = listAbortRef.current?.signal
    setListLoading(!append)
    const answer = await fetchSessionsPage({
      offset,
      fresh: offset === 0 && props.refreshKey > 0,
      ...(signal === undefined ? {} : { signal }),
    })
    if (signal?.aborted === true) return
    if (!answer.ok) {
      setListError(writeErrorText(answer.error))
      setListLoading(false)
      return
    }
    setListError(null)
    if (!append) setWarnings([])
    setWarnings((current) => mergeListWarnings(current, answer.sessions.warnings))
    setRows((current) => (append ? [...current, ...answer.sessions.items] : answer.sessions.items))
    setHasMore(answer.sessions.hasMore)
    setNextOffset(answer.sessions.nextOffset)
    setListLoading(false)
  }, [props.refreshKey])

  // The list loads when the view is entered and after a Refresh.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await loadPage(0, false)
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [loadPage])

  // A session-scoped deep link selects a session before the list has loaded.
  useEffect(() => {
    if (native.view !== 'sessions') return
    const sessionId = native.target.sessions?.sessionId
    if (sessionId !== undefined && sessionId.length > 0) setSelectedSessionId(sessionId)
  }, [native.view, native.target])

  // Detail loads on selection only (and on an explicit detail Refresh).
  useEffect(() => {
    if (selectedSessionId === null) {
      setLog(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    setDiffs({})
    setOpenArchive(native.target.sessions?.archiveUri ?? null)
    void fetchSessionLog(selectedSessionId, { fresh: detailToken > 0, signal: controller.signal }).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setLog(answer.log)
        setDetailError(null)
      } else {
        setLog(null)
        setDetailError(errorText(answer.error))
      }
      setDetailLoading(false)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedSessionId, detailToken, native.target.sessions?.archiveUri])

  const loadDiff = useCallback(
    async (sessionId: string, archiveUri: string): Promise<void> => {
      setDiffs((current) => ({ ...current, [archiveUri]: { loading: true, error: null, diff: current[archiveUri]?.diff ?? null } }))
      const answer = await fetchDiff(sessionId, archiveUri)
      if (!answer.ok) {
        setDiffs((current) => ({ ...current, [archiveUri]: { loading: false, error: errorText(answer.error), diff: null } }))
        return
      }
      setDiffs((current) => ({ ...current, [archiveUri]: { loading: false, error: null, diff: answer.diff } }))
    },
    [],
  )

  // A deep link may name one archive: once the detail has loaded, open that diff.
  useEffect(() => {
    const archiveUri = native.target.sessions?.archiveUri
    if (archiveUri === undefined || selectedSessionId === null || log === null) return
    if (diffs[archiveUri] !== undefined) return
    void loadDiff(selectedSessionId, archiveUri)
  }, [log, native.target.sessions?.archiveUri, selectedSessionId, loadDiff, diffs])

  const visible = rows.filter((row) => {
    if (kindFilter !== 'all' && row.kind !== kindFilter) return false
    const text = textFilter.trim().toLowerCase()
    if (text.length === 0) return true
    return row.ovSessionId.toLowerCase().includes(text)
  })

  const selectedRow = rows.find((row) => row.sessionId === selectedSessionId) ?? null

  const copyId = async (value: string): Promise<void> => {
    const ok = await copyText(value)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const openStudio = (): void => {
    if (props.studioUrl === null) {
      navigate({ view: 'studio' })
      return
    }
    if (typeof window !== 'undefined') window.open(props.studioUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="ove-sess">
      <div className="ove-sess-list-pane">
        <div className="ove-browse-toolbar">
          <span className="ove-nat-section-title">{t('native.view.sessions')}</span>
          <span className="ove-nat-spacer" />
          <button type="button" className="ove-preview-button" onClick={() => void loadPage(0, false)}>
            {t('native.refresh')}
          </button>
        </div>
        <div className="ove-sess-filters">
          <label className="ove-sess-filter">
            <span>{t('native.sessions.filter')}</span>
            <select
              className="ove-config-input"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as KindFilter)}
            >
              <option value="all">{t('native.sessions.filterAll')}</option>
              <option value="dsh">{t('native.sessions.filterDsh')}</option>
              <option value="local">{t('native.sessions.filterLocal')}</option>
              <option value="other">{t('native.sessions.filterOther')}</option>
            </select>
          </label>
          <input
            className="ove-config-input"
            placeholder={t('native.sessions.searchPlaceholder')}
            value={textFilter}
            spellCheck={false}
            onChange={(event) => setTextFilter(event.target.value)}
          />
        </div>
        <NativeWarnings warnings={warnings} />
        {listError !== null && <p className="ove-preview-error">{listError}</p>}
        {listLoading && rows.length === 0 ? (
          <p className="ove-preview-status">{t('native.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="ove-preview-hint">{rows.length === 0 ? t('native.sessions.empty') : t('native.sessions.noMatches')}</p>
        ) : (
          <ul className="ove-sess-list">
            {visible.map((row) => (
              <li key={row.ovSessionId}>
                <button
                  type="button"
                  className={`ove-sess-row${selectedSessionId !== null && row.sessionId === selectedSessionId ? ' ove-sess-row-active' : ''}`}
                  onClick={() => {
                    if (row.sessionId === null) {
                      setNote(t('native.sessions.notAddressable'))
                      return
                    }
                    setNote(null)
                    setSelectedSessionId(row.sessionId)
                  }}
                  title={row.ovSessionId}
                >
                  <code className="ove-sess-id">{shortSessionId(row.ovSessionId)}</code>
                  <span className={`ove-nat-chip ove-nat-chip-muted`}>{t(`native.sessions.kind.${row.kind}`)}</span>
                  <span className="ove-sess-time">{row.modifiedAt === null ? '—' : row.modifiedAt.slice(0, 16).replace('T', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <div className="ove-sess-more">
            <button
              type="button"
              className="ove-preview-button"
              disabled={listLoading}
              onClick={() => {
                if (nextOffset !== null) void loadPage(nextOffset, true)
              }}
            >
              {listLoading ? t('native.loading') : t('native.loadMore')}
            </button>
          </div>
        )}
        {note !== null && <p className="ove-preview-hint">{note}</p>}
      </div>

      <div className="ove-sess-detail-pane">
        {selectedSessionId === null ? (
          <p className="ove-preview-hint">{t('native.sessions.selectHint')}</p>
        ) : detailLoading && log === null ? (
          <p className="ove-preview-status">{t('native.loading')}</p>
        ) : detailError !== null ? (
          <div>
            <p className="ove-preview-error">{detailError}</p>
            <button type="button" className="ove-preview-button" onClick={() => setDetailToken((value) => value + 1)}>
              {t('native.retry')}
            </button>
          </div>
        ) : log === null ? null : (
          <div className="ove-sess-detail">
            <div className="ove-sess-detail-head">
              <span className={`ove-nat-chip ${log.state === 'committed' ? 'ove-nat-chip-ok' : log.state === 'failed' || log.state === 'unknown' ? 'ove-nat-chip-bad' : 'ove-nat-chip-muted'}`}>
                {phaseLabel(log)}
              </span>
              <code className="ove-sess-id" title={log.ovSessionId}>
                {shortSessionId(log.ovSessionId)}
              </code>
              <span className="ove-nat-spacer" />
              <button type="button" className="ove-preview-button" onClick={() => void copyId(log.ovSessionId)}>
                {copied ? t('preview.copied') : t('native.sessions.copyId')}
              </button>
              <button type="button" className="ove-preview-button" onClick={() => setDetailToken((value) => value + 1)}>
                {t('native.refresh')}
              </button>
              <button type="button" className="ove-preview-button" onClick={openStudio}>
                {t('native.openStudio')}
              </button>
              <button
                type="button"
                className="ove-preview-button"
                onClick={() => navigate({ view: 'browse', browse: { uri: log.sessionUri ?? undefined } })}
                disabled={log.sessionUri === null}
              >
                {t('native.sessions.openInBrowse')}
              </button>
              <button type="button" className="ove-preview-button" onClick={() => openRightTab('openviking-health')}>
                {t('native.openDoctor')}
              </button>
            </div>

            <div className="ove-nat-facts">
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.sessions.pending')}</span>
                <code>{`${log.meta.pendingTokens} / ${log.threshold ?? '—'}`}</code>
              </span>
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.sessions.commits')}</span>
                <code>{log.meta.commitCount}</code>
              </span>
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.sessions.lastCommit')}</span>
                <code>{log.meta.lastCommitAt ?? '—'}</code>
              </span>
              <span className="ove-nat-fact">
                <span className="ove-nat-fact-label">{t('native.sessions.pendingQueue')}</span>
                <code>{log.pending.available ? log.pending.total : '—'}</code>
              </span>
            </div>

            <div className="ove-nat-section">
              <div className="ove-nat-section-title">{t('native.sessions.tasks')}</div>
              {log.tasks.length === 0 ? (
                <p className="ove-preview-hint">{t('native.sessions.noTasks')}</p>
              ) : (
                <table className="ove-act-table">
                  <thead>
                    <tr>
                      <th>{t('native.sessions.taskId')}</th>
                      <th>{t('native.sessions.taskStatus')}</th>
                      <th>{t('native.sessions.taskStage')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.tasks.slice(0, 5).map((task) => (
                      <tr key={task.taskId}>
                        <td>{shortSessionId(task.taskId)}</td>
                        <td>{task.status}</td>
                        <td>{task.stage ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="ove-nat-section">
              <div className="ove-nat-section-title">{t('native.sessions.archives')}</div>
              {log.archives.length === 0 ? (
                <p className="ove-preview-hint">{t('native.sessions.noArchives')}</p>
              ) : (
                <ul className="ove-sess-archives">
                  {[...log.archives].reverse().slice(0, 10).map((archive) => {
                    const summary = log.summaries.find((entry) => entry.archiveUri === archive.archiveUri) ?? null
                    const diff = diffs[archive.archiveUri]
                    const open = openArchive === archive.archiveUri
                    return (
                      <li key={archive.archiveUri}>
                        <div className="ove-sess-archive-row">
                          <span className="ove-sess-archive-id">{archive.archiveId}</span>
                          <span className="ove-nat-muted">{archive.modTime ?? '—'}</span>
                          {summary !== null && (
                            <span className={`ove-nat-chip ${summary.state === 'done' ? 'ove-nat-chip-ok' : summary.state === 'failed' ? 'ove-nat-chip-bad' : 'ove-nat-chip-muted'}`}>
                              {t(`native.sessions.archiveState.${summary.state}`)}
                            </span>
                          )}
                          {summary?.summary !== null && summary?.summary !== undefined && (
                            <span className="ove-nat-muted">
                              {t('native.sessions.archiveCounts', {
                                adds: summary.summary.totalAdds,
                                updates: summary.summary.totalUpdates,
                                deletes: summary.summary.totalDeletes,
                              })}
                            </span>
                          )}
                          <span className="ove-nat-spacer" />
                          <button
                            type="button"
                            className="ove-preview-button"
                            onClick={() => {
                              setOpenArchive(open ? null : archive.archiveUri)
                              if (!open && diff === undefined) void loadDiff(selectedSessionId, archive.archiveUri)
                            }}
                          >
                            {open ? t('native.sessions.hideDiff') : t('native.sessions.showDiff')}
                          </button>
                        </div>
                        {open && (
                          <div className="ove-sess-diff">
                            {diff === undefined || (diff.loading && diff.diff === null) ? (
                              <p className="ove-preview-hint">{t('native.loading')}</p>
                            ) : diff.error !== null ? (
                              <p className="ove-preview-error">{diff.error}</p>
                            ) : diff.diff === null ? (
                              <p className="ove-preview-hint">{t('native.sessions.noDiff')}</p>
                            ) : (
                              <DiffView diff={diff.diff} />
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {log.warnings.length > 0 && (
              <div className="ove-nat-warnings">
                {log.warnings.map((warning, index) => (
                  <div key={`${warning.code}-${index}`}>⚠ {t(`notice.${warning.code}`, warning.params)}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
