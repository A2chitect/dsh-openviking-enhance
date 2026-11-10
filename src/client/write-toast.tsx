/**
 * The outcome toast with Undo (the second `shell.overlay` entry).
 *
 * A write result must outlive the panel/tab that asked for it, so it is rendered
 * here, frame-wide, reading one module-level notice. Markup and CSS are the
 * plugin's own (DSH has no toast primitive — docs/dsh-contracts-v05.md §1.4).
 *
 * Undo is deliberately two-step on the host side: the first call is a `dry_run`
 * snapshot plan; an undo that would touch files this action did not change opens
 * the plan dialog (`write-dialog.tsx`) instead of silently reverting them. A
 * plan that is clean applies immediately. Identity switches refuse undo on the
 * host with `identity-changed`, which the toast renders in place.
 */
import { useCallback, useState } from 'react'
import type { OveError } from '../shared/protocol.ts'
import { applyUndo, planUndo } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { shortTarget } from './write-dialog.tsx'
import { dismissNotice, notifyWriteSettled, openUndoPlan, showNotice, useWriteStore } from './write-store.ts'
import { useScope } from './scope-store.ts'
import { liveRegionForTone } from './a11y.ts'

/** How long a notice stays before it fades; failures stay until dismissed. */
const DISMISS_AFTER_MS = 20_000

export function WriteToast({ className = '' }: { className?: string }) {
  const { notice } = useWriteStore()
  const scope = useScope()
  const [error, setError] = useState<OveError | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [busy, setBusy] = useState(false)

  const undo = useCallback(async () => {
    if (notice === null || notice.undoId === null) return
    setBusy(true)
    setError(null)
    try {
      const planned = await planUndo(notice.undoId)
      if (!planned.ok) {
        setError(planned.error)
        return
      }
      if (planned.plan.extraChanges) {
        openUndoPlan(planned.plan)
        dismissNotice()
        return
      }
      const applied = await applyUndo(notice.undoId)
      if (!applied.ok) {
        setError(applied.error)
        return
      }
      notifyWriteSettled('undo', planned.plan.target)
      showNotice({
        tone: 'success',
        text:
          applied.outcome === 'tags-restored'
            ? t('write.undoTagsDone', { target: shortTarget(applied.target) })
            : t('write.undoDone', { target: shortTarget(applied.target) }),
        undoId: null,
        auditId: applied.auditId,
      })
    } finally {
      setBusy(false)
    }
  }, [notice])

  if (notice === null) return null

  const toneClass = notice.tone === 'success' ? 'ove-toast-success' : notice.tone === 'warning' ? 'ove-toast-warning' : 'ove-toast-error'

  return (
    <div className={`ove-overlay ove-toast-layer ${className}`}>
      <div className={`ove-toast ${toneClass}`} {...liveRegionForTone(notice.tone)}>
        <span className="ove-toast-text">{notice.text}</span>
        {notice.undoId !== null && scope.scope !== null && (
          <span className="ove-toast-scope" title={scope.scope.identity.fingerprint}>
            {t('write.toastScope', {
              profile: scope.scope.identity.profileLabel ?? t('scope.legacyMode'),
              account: scope.scope.identity.account,
              user: scope.scope.identity.user,
            })}
          </span>
        )}
        {notice.undoId !== null && (
          <button type="button" className="ove-toast-action" disabled={busy} onClick={() => void undo()}>
            {busy ? t('write.working') : t('write.undo')}
          </button>
        )}
        <button
          type="button"
          className="ove-toast-action ove-toast-details"
          onClick={() => setShowDetails((current) => !current)}
        >
          {t('write.details')}
        </button>
        <button type="button" className="ove-toast-dismiss" aria-label={t('write.dismiss')} onClick={() => dismissNotice()}>
          ×
        </button>
        {showDetails && notice.auditId !== null && (
          <p className="ove-toast-detail-line">{t('write.auditId', { id: notice.auditId })}</p>
        )}
        {error !== null && <p className="ove-toast-error-line">{writeErrorText(error)}</p>}
      </div>
    </div>
  )
}
