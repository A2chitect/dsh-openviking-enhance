/**
 * F5: the `viking://` preview tab (right Sidebar), rebuilt on the shared body.
 *
 * The tab keeps what is tab-specific: the address bar, the v0.5 curation action
 * bar and the delete tombstone. The metadata/tier/paging rendering lives in
 * `preview-body.tsx` since v0.7, which is also what the native cockpit's Browse
 * preview pane mounts (read-only). One implementation, two mounts.
 *
 * The selection is module state, not slot props: any URI the plugin renders can
 * call `openPreview(uri)`; the tab body subscribes through `usePreviewTarget`, so
 * an already-open preview re-targets instead of relying on a second tab.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { classifyCuratableUri } from '../shared/curation.ts'
import type { PreviewPayload } from '../shared/protocol.ts'
import { prepareWrite } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { PreviewBody } from './preview-body.tsx'
import { openPreview, usePreviewTarget } from './preview-store.ts'
import { SessionScopeBanner } from './session-scope.tsx'
import { ScopeChip } from './scope-chip.tsx'
import { ensureScope, useScope } from './scope-store.ts'
import { canSelectPanel, openNative } from './native-store.ts'
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
  const [reloadToken, setReloadToken] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const scope = useScope()
  const writeState = useWriteStore()

  useEffect(() => {
    setDraft(targetUri ?? '')
    setActionError(null)
  }, [targetUri])

  // The scope chip and the write gates are shared state; a panel that never
  // asks would render a stale "no profile" chip.
  useEffect(() => {
    void ensureScope()
  }, [])

  // After a write settles, re-read the entry from the server. Never optimistic: a
  // verified write is the only state the panel is allowed to show.
  useEffect(() => {
    if (writeState.lastWriteSeq === 0) return
    if (writeState.lastWriteTarget !== null && writeState.lastWriteTarget !== targetUri) return
    setReloadToken((value) => value + 1)
  }, [writeState.lastWriteSeq, writeState.lastWriteTarget, targetUri])

  /**
   * The address-bar action: navigate to a different URI, or refetch the one
   * already shown. Re-recording the same target would emit nothing (the store
   * dedupes identical targets), so a true refresh bumps the body's token.
   */
  const submit = useCallback(() => {
    const next = draft.trim()
    if (next.length === 0) return
    if (next === targetUri) setReloadToken((value) => value + 1)
    else openPreview(next)
  }, [draft, targetUri])

  /** Explicit deep link into the native cockpit (never fired by a plain URI click). */
  const openCockpit = useCallback(() => {
    if (targetUri === null) return
    openNative({ view: 'browse', browse: { uri: targetUri } })
  }, [targetUri])

  /** The curation action bar (v0.5): only for a curatable memory file with writes live. */
  const renderActions = useCallback(
    (payload: PreviewPayload): ReactNode => {
      const classification = classifyCuratableUri(payload.uri)
      const curatable = classification !== null && classification.ok && payload.stat?.isDir === false
      const writesReady = scope.scope !== null && scope.scope.writes.enabled && scope.scope.writes.transport
      const prepareAction = async (action: 'edit-memory' | 'delete-memory' | 'set-tags'): Promise<void> => {
        setActionError(null)
        const answer = await prepareWrite({
          action,
          target: payload.uri,
          ...(props.sessionId.length === 0 ? {} : { sessionId: props.sessionId }),
        })
        if (answer.ok) openWriteConfirm(answer)
        else setActionError(writeErrorText(answer.error))
      }
      if (payload.stat?.isDir !== false) return null
      if (curatable) {
        return writesReady ? (
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
            {actionError !== null && <span className="ove-preview-error">{actionError}</span>}
          </div>
        ) : (
          <p className="ove-preview-hint">
            {t('write.actionsDisabled', { reason: scope.scope?.writes.reason ?? 'writes-disabled' })}
          </p>
        )
      }
      return (
        <p className="ove-preview-hint">
          {t('write.readOnlyInVersion', { reason: classification?.ok === false ? classification.reason : 'not-memory-body' })}
        </p>
      )
    },
    [props.sessionId, scope.scope, actionError],
  )

  /**
   * The delete tombstone: after a confirmed delete the panel re-reads the server,
   * which now answers "not found". That is the honest result — the undo handle
   * lives in the outcome toast.
   */
  const renderError = useCallback(
    (error: string): ReactNode => {
      if (writeState.lastWriteAction === 'delete-memory' && writeState.lastWriteTarget === targetUri) {
        return (
          <div className="ove-preview-tombstone">
            <p className="ove-preview-status">{t('preview.deleted', { uri: targetUri ?? '' })}</p>
            <p className="ove-preview-hint">{t('preview.deletedHint')}</p>
          </div>
        )
      }
      return <p className="ove-preview-error">{error}</p>
    },
    [writeState.lastWriteAction, writeState.lastWriteTarget, targetUri],
  )

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
        <button type="button" className="ove-preview-button" onClick={submit} disabled={draft.trim().length === 0}>
          {t('preview.refresh')}
        </button>
        {targetUri !== null && canSelectPanel() && (
          <button type="button" className="ove-preview-button" onClick={openCockpit} title={t('native.openCockpitHint')}>
            {t('native.openCockpit')}
          </button>
        )}
        <span className="ove-preview-spacer" />
        <ScopeChip compact />
      </div>

      <SessionScopeBanner sessionId={props.sessionId} />
      {targetUri === null ? (
        <div className="ove-preview-body">
          <p className="ove-preview-status">{t('preview.empty')}</p>
          <p className="ove-preview-hint">{t('preview.emptyHint')}</p>
        </div>
      ) : (
        <PreviewBody
          uri={targetUri}
          reloadToken={reloadToken}
          renderActions={renderActions}
          renderError={renderError}
        />
      )}
    </div>
  )
}
