/**
 * The native Commits view: a bounded recent-activity browser.
 *
 * There is no global commit history on the server — archives live per session and
 * task records are pruned — so this view shows the host's bounded fan-out: the
 * newest ≤8 sessions, each read with the existing `CommitService`, pool 4, 10 s
 * deadline, 30 s cache. A partial answer is first-class: the rows that answered
 * stay, and `limitedBy`/`progress` explain the truncation in exactly the v0.6
 * partial-notice pattern. The view is never polled.
 */
import { useCallback, useEffect, useState } from 'react'
import type { MemoryDiff, RecentCommitRow, RecentCommitsPayload } from '../shared/protocol.ts'
import { DiffView } from './commit-status.tsx'
import { fetchDiff, fetchRecentCommits } from './host-api.ts'
import { errorText, t, writeErrorText } from './locale.ts'
import { navigate } from './native-store.ts'

export interface NativeCommitsProps {
  refreshKey: number
}

interface DiffState {
  loading: boolean
  error: string | null
  diff: MemoryDiff | null
}

function phaseText(row: RecentCommitRow): string {
  if (row.error !== null) return t('native.commits.rowError')
  if (row.status === null) return '—'
  // The commit phases (`idle`/`pending`/`extracting`/`done`/`failed`/`errored`)
  // are their own vocabulary; the session-state keys are a different set.
  return t(`native.commits.phase.${row.status.phase}`)
}

function summaryText(row: RecentCommitRow): string | null {
  const newest = row.summaries[0]
  if (newest === undefined || newest.summary === null) return null
  return t('native.sessions.archiveCounts', {
    adds: newest.summary.totalAdds,
    updates: newest.summary.totalUpdates,
    deletes: newest.summary.totalDeletes,
  })
}

export function NativeCommits(props: NativeCommitsProps) {
  const [payload, setPayload] = useState<RecentCommitsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openArchive, setOpenArchive] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    void fetchRecentCommits({ fresh: props.refreshKey > 0, signal: controller.signal }).then((answer) => {
      if (cancelled) return
      if (answer.ok) {
        setPayload(answer.recent)
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

  const loadDiff = useCallback(async (row: RecentCommitRow, archiveUri: string): Promise<void> => {
    if (row.sessionId === null) return
    setDiffs((current) => ({ ...current, [archiveUri]: { loading: true, error: null, diff: current[archiveUri]?.diff ?? null } }))
    const answer = await fetchDiff(row.sessionId, archiveUri)
    if (!answer.ok) {
      setDiffs((current) => ({ ...current, [archiveUri]: { loading: false, error: errorText(answer.error), diff: null } }))
      return
    }
    setDiffs((current) => ({ ...current, [archiveUri]: { loading: false, error: null, diff: answer.diff } }))
  }, [])

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
        <p className="ove-preview-error">{t('native.commits.failed', { error })}</p>
        <p className="ove-preview-hint">{t('native.commits.failedHint')}</p>
      </div>
    )
  }
  if (payload === null) return null

  const partialText =
    payload.limitedBy === 'deadline'
      ? t('native.commits.partialDeadline', {
          sessions: payload.progress.sessionsScanned,
          elapsedMs: payload.progress.elapsedMs,
          deadlineMs: payload.progress.deadlineMs,
        })
      : payload.limitedBy === 'session-cap'
        ? t('native.commits.partialSessionCap', { cap: payload.progress.sessionCap })
        : null

  return (
    <div className="ove-nat-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('native.view.commits')}</span>
        <span className="ove-nat-muted">{t('native.commits.scopeNote')}</span>
        <span className="ove-nat-spacer" />
        {payload.items.length > 0 && (
          <span className="ove-nat-muted">{t('native.commits.count', { count: payload.items.length })}</span>
        )}
      </header>

      {partialText !== null && (
        <div className="ove-nat-partial" role="status">
          <span>{partialText}</span>
        </div>
      )}
      {payload.warnings.length > 0 && (
        <div className="ove-nat-warnings">
          {payload.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>{t(`notice.${warning.code}`, warning.params)}</div>
          ))}
        </div>
      )}

      {payload.items.length === 0 ? (
        <div>
          <p className="ove-preview-hint">{t('native.commits.empty')}</p>
          <div className="ove-nat-actions">
            <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'sessions' })}>
              {t('native.view.sessions')}
            </button>
            <button type="button" className="ove-preview-button" onClick={() => navigate({ view: 'studio' })}>
              {t('native.openStudio')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="ove-commits-list">
          {payload.items.map((row) => {
            const newestArchive = row.status?.archives[row.status.archives.length - 1]
            const diff = newestArchive === undefined ? undefined : diffs[newestArchive.archiveUri]
            const open = newestArchive !== undefined && openArchive === newestArchive.archiveUri
            return (
              <li key={row.ovSessionId} className="ove-commits-row">
                <div className="ove-commits-head">
                  <code className="ove-sess-id" title={row.ovSessionId}>
                    {row.ovSessionId}
                  </code>
                  <span className={`ove-nat-chip ${row.error !== null ? 'ove-nat-chip-bad' : row.status?.phase === 'errored' || row.status?.phase === 'failed' ? 'ove-nat-chip-bad' : row.status?.phase === 'done' ? 'ove-nat-chip-ok' : 'ove-nat-chip-muted'}`}>
                    {phaseText(row)}
                  </span>
                  <span className="ove-nat-muted">
                    {row.status === null
                      ? row.error === 'unsupported-session'
                        ? t('native.commits.unsupported')
                        : '—'
                      : t('native.sessions.commits') + ` ${row.status.commitCount}`}
                  </span>
                  {row.status !== null && (
                    <span className="ove-nat-muted">
                      {t('native.sessions.pending')}: {row.status.pendingTokens}
                    </span>
                  )}
                  {row.modifiedAt !== null && <span className="ove-nat-muted">{row.modifiedAt.slice(0, 16).replace('T', ' ')}</span>}
                  <span className="ove-nat-spacer" />
                  {summaryText(row) !== null && <span className="ove-nat-muted">{summaryText(row)}</span>}
                  {row.sessionId !== null && (
                    <>
                      <button
                        type="button"
                        className="ove-preview-button"
                        onClick={() => {
                          if (newestArchive === undefined) return
                          setOpenArchive(open ? null : newestArchive.archiveUri)
                          if (!open && diff === undefined) void loadDiff(row, newestArchive.archiveUri)
                        }}
                        disabled={newestArchive === undefined}
                      >
                        {open ? t('native.sessions.hideDiff') : t('native.sessions.showDiff')}
                      </button>
                      <button
                        type="button"
                        className="ove-preview-button"
                        onClick={() => navigate({ view: 'sessions', sessions: { sessionId: row.sessionId as string } })}
                      >
                        {t('native.commits.openSession')}
                      </button>
                    </>
                  )}
                </div>
                {open && newestArchive !== undefined && (
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

      <p className="ove-preview-hint">{t('native.commits.costNote')}</p>
    </div>
  )
}
