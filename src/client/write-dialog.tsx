/**
 * The confirmation dialog (and the undo-plan dialog) — the one interaction
 * paradigm v0.5 adds: **prepare → confirm → execute → undoable result + audit**.
 *
 * Lives in `shell.overlay` so the outcome outlives the tab that asked for it; the
 * raised request comes from `write-store.ts`, which panels and the `/viking` card
 * write into. There is no shell dialog primitive (docs/dsh-contracts-v05.md §1),
 * so this component owns its markup, focus and escape behaviour:
 *
 *  - Cancel is the default focus; Confirm is not (Enter must not delete a file);
 *  - Escape and a backdrop click settle the request without executing;
 *  - the scope block is repeated in full on every action, regardless of the
 *    `showScopeBanner` switch — a confirmation is where identity must be explicit;
 *  - the body shown in the edit dialog came from the host's own read, and the
 *    host re-checks its hash on execute; a mismatch is a conflict the user must
 *    reload, not a lost update that happens silently.
 *
 * The tag grammar and the allowlist are shared with the host
 * (`src/shared/curation.ts`), so the dialog cannot offer what the host refuses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TAG_GRAMMAR, TAG_MAX as TAG_LIMIT, validateTagInput, type TagValidation } from '../shared/curation.ts'
import type { OveError, UndoPlanPath, WritePreparePayload, WriteUndoPlan } from '../shared/protocol.ts'
import { lineDiff } from '../shared/text-diff.ts'
import { applyUndo, executeWrite, prepareWrite } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import {
  closeUndoPlan,
  closeWriteConfirm,
  notifyWriteSettled,
  openUndoPlan,
  openWriteConfirm,
  setWriteBusy,
  showNotice,
  useWriteStore,
} from './write-store.ts'

/** Format a byte count for the revision line. */
function formatBytes(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return '—'
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
}

/** `viking://user/u/memories/preferences/tools.md` → `preferences/tools.md-`. */
export function shortTarget(uri: string): string {
  const body = uri.replace(/^viking:\/\//, '')
  const segments = body.split('/').filter((segment) => segment.length > 0)
  return segments.slice(-2).join('/') || uri
}

/** The scope block every dialog repeats, derived from the prepare payload. */
function ScopeBlock({ prepare }: { prepare: WritePreparePayload }) {
  const scope = prepare.scope
  return (
    <dl className="ove-write-scope">
      <div>
        <dt>{t('write.scopeProfile')}</dt>
        <dd>{scope.profileLabel ?? t('scope.legacyMode')}</dd>
      </div>
      <div>
        <dt>{t('write.scopeEndpoint')}</dt>
        <dd>{scope.endpoint}</dd>
      </div>
      <div>
        <dt>{t('write.scopeIdentity')}</dt>
        <dd>
          {scope.account}/{scope.user}
          {scope.peer === null ? '' : ` · ${scope.peer}`}
          {scope.authMode === null ? '' : ` · ${scope.authMode}`}
        </dd>
      </div>
      <div>
        <dt>{t('write.scopeFingerprint')}</dt>
        <dd>{`sha256:${scope.fingerprint.replace(/^sha256:/, '').slice(0, 12)}…`}</dd>
      </div>
    </dl>
  )
}

/** One inline error: the localized code, plus the host's own message as fallback. */
function ErrorLine({ error }: { error: OveError }) {
  return (
    <p className="ove-write-error" role="alert">
      {writeErrorText(error)}
    </p>
  )
}

export interface WriteDialogProps {
  /** Extra class hook for tests, not used by the app. */
  className?: string
}

/**
 * The frame-wide dialog entry.
 *
 * Renders nothing while no confirmation or undo plan is pending — that is the
 * shipped overlay pattern, and it is also why the overlay can be registered
 * unconditionally (it costs one null render).
 */
export function WriteDialog({ className = '' }: WriteDialogProps) {
  const state = useWriteStore()
  if (state.plan !== null) return <UndoPlanDialog plan={state.plan} className={className} />
  if (state.confirm === null) return null
  return <ConfirmDialog prepare={state.confirm} className={className} />
}

function ConfirmDialog({ prepare, className }: { prepare: WritePreparePayload; className: string }) {
  const busy = useWriteStore().busy
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const [error, setError] = useState<OveError | null>(null)
  const [content, setContent] = useState(prepare.content ?? '')
  const [typed, setTyped] = useState('')
  const [tags, setTags] = useState<string[]>(prepare.tagsBefore ?? [])
  const [appendTags, setAppendTags] = useState(prepare.tagMode === 'append')
  const [tagDraft, setTagDraft] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)

  // Cancel is the default focus: a confirmation that can be accepted by pressing
  // Enter from a text field is how accidental deletions happen.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [prepare.token])

  // A reload after a conflict (or expiry) raises a NEW prepare payload into the
  // same dialog component, so the editable state must follow the new token: React
  // keeps the local state across the prop change, and stale text would otherwise
  // be written against a fresh revision.
  useEffect(() => {
    setContent(prepare.content ?? '')
    setTyped('')
    setTags(prepare.tagsBefore ?? [])
    setTagDraft('')
    setTagError(null)
    setAppendTags(prepare.tagMode === 'append')
    setError(null)
    setShowDiff(false)
  }, [prepare.token, prepare.content, prepare.tagsBefore, prepare.tagMode])

  const close = useCallback(() => {
    if (busy) return
    closeWriteConfirm()
  }, [busy])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const unchanged = prepare.action === 'edit-memory' ? content === (prepare.content ?? '') : false
  const tagsChanged = prepare.action === 'set-tags' ? !sameTagSet(tags, prepare.tagsBefore ?? []) : false
  /** Codes after which the host kept the token usable (validation only). */
  const TOKEN_KEPT_CODES = new Set([
    'typed-confirmation-required',
    'typed-confirmation-mismatch',
    'invalid-tags',
    'content-too-large',
    'invalid-request',
  ])
  const tokenSettled = error !== null && !TOKEN_KEPT_CODES.has(error.code)

  const canConfirm = ((): boolean => {
    if (busy || tokenSettled) return false
    if (prepare.action === 'edit-memory') return content.length > 0 && !unchanged
    if (prepare.action === 'delete-memory') return typed.trim() === prepare.confirmWord
    if (prepare.action === 'set-tags') return tagsChanged && tagError === null
    return true
  })()

  const succeed = useCallback(
    (result: { undoId: string | null; auditId: string; taskId?: string | null; warnings?: Array<{ code: string }> }) => {
      closeWriteConfirm(true)
      notifyWriteSettled(prepare.action, prepare.target)
      const skipped = (result.warnings ?? []).some((warning) => warning.code === 'commitSkipped')
      showNotice({
        tone: prepare.action === 'force-commit' ? 'warning' : 'success',
        text: successText(prepare, result.taskId ?? null, skipped),
        undoId: result.undoId,
        auditId: result.auditId,
      })
    },
    [prepare],
  )

  const confirm = useCallback(async () => {
    if (!canConfirm) return
    setError(null)
    setWriteBusy(true)
    try {
      const body =
        prepare.action === 'edit-memory'
          ? { token: prepare.token, content }
          : prepare.action === 'delete-memory'
            ? { token: prepare.token, typed }
            : prepare.action === 'set-tags'
              ? { token: prepare.token, tags, tagMode: appendTags ? ('append' as const) : ('replace' as const) }
              : { token: prepare.token }
      const answer = await executeWrite(body)
      if (answer.ok) succeed(answer)
      else setError(answer.error)
    } finally {
      setWriteBusy(false)
    }
  }, [appendTags, canConfirm, content, prepare, succeed, tags, typed])

  /** Re-run prepare after a conflict/expiry: a fresh snapshot and token. */
  const reload = useCallback(async () => {
    setError(null)
    setWriteBusy(true)
    try {
      const answer = await prepareWrite({
        action: prepare.action,
        target: prepare.target,
        ...(prepare.session === null ? {} : { sessionId: prepare.session.sessionId }),
      })
      if (answer.ok) {
        if (answer.content !== null) setContent(answer.content)
        setTyped('')
        setTags(answer.tagsBefore ?? [])
        setError(null)
        openWriteConfirm(answer)
      } else setError(answer.error)
    } finally {
      setWriteBusy(false)
    }
  }, [prepare])

  const addTag = useCallback(() => {
    const candidate = tagDraft.trim()
    const validation: TagValidation = validateTagInput(candidate)
    if (!validation.ok) {
      setTagError(t('write.tagInvalid'))
      return
    }
    if (tags.includes(candidate)) {
      setTagError(t('write.tagDuplicate'))
      return
    }
    if (tags.length >= TAG_LIMIT) {
      setTagError(t('write.tagLimit', { limit: TAG_LIMIT }))
      return
    }
    setTags([...tags, candidate])
    setTagDraft('')
    setTagError(null)
  }, [tagDraft, tags])

  const diff = useMemo(
    () => (prepare.action === 'edit-memory' && showDiff ? lineDiff(prepare.content ?? '', content) : null),
    [prepare, content, showDiff],
  )

  const title = ((): string => {
    switch (prepare.action) {
      case 'edit-memory':
        return t('write.titleEdit')
      case 'delete-memory':
        return t('write.titleDelete')
      case 'set-tags':
        return t('write.titleTags')
      default:
        return t('write.titleCommit')
    }
  })()

  const conflict = error !== null && (error.code === 'revision-mismatch' || error.code === 'token-expired' || error.code === 'token-used')

  return (
    <div className={`ove-overlay ove-write-overlay ${className}`}>
      <div className="ove-write-backdrop" onClick={close} />
      <div className="ove-write-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ove-write-head">
          <span className="ove-write-title">{title}</span>
          <span className="ove-write-target" title={prepare.target}>
            {prepare.action === 'force-commit' ? prepare.target : shortTarget(prepare.target)}
          </span>
        </div>

        <ScopeBlock prepare={prepare} />

        {prepare.action === 'edit-memory' && (
          <>
            <p className="ove-write-hint">
              {t('write.revisionLine', {
                hash: (prepare.revision?.sha256 ?? '').replace(/^sha256:/, '').slice(0, 12),
                size: formatBytes(prepare.revision?.size ?? null),
              })}
              {prepare.revision?.modifiedAt === null || prepare.revision?.modifiedAt === undefined
                ? ''
                : ` · ${prepare.revision.modifiedAt}`}
            </p>
            <div className="ove-write-diffbar">
              <span>{t('write.charCount', { count: content.length })}</span>
              <button type="button" className="ove-write-link" onClick={() => setShowDiff((current) => !current)}>
                {showDiff ? t('write.hideDiff') : t('write.showDiff')}
              </button>
            </div>
            {diff === null ? (
              <textarea
                className="ove-write-editor"
                value={content}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setContent(event.target.value)}
              />
            ) : (
              <div className="ove-write-diff">
                {diff.rows.map((row, index) => (
                  <div key={index} className={`ove-write-diff-row ove-write-diff-${row.kind}`}>
                    <span className="ove-write-diff-mark">
                      {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
                    </span>
                    <span>{row.text}</span>
                  </div>
                ))}
                {diff.truncated && <p className="ove-write-hint">{t('write.diffTruncated')}</p>}
              </div>
            )}
            {unchanged && <p className="ove-write-hint">{t('write.noChanges')}</p>}
          </>
        )}

        {prepare.action === 'delete-memory' && (
          <>
            <p className="ove-write-warning">{t('write.deleteWarning')}</p>
            <label className="ove-write-field">
              <span>{t('write.typeToConfirm', { word: prepare.confirmWord ?? '' })}</span>
              <input
                className="ove-write-input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                placeholder={prepare.confirmWord ?? ''}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          </>
        )}

        {prepare.action === 'set-tags' && (
          <>
            <p className="ove-write-hint">{t('write.tagsHint')}</p>
            <div className="ove-write-tags">
              {tags.length === 0 && <span className="ove-write-hint">{t('write.noTags')}</span>}
              {tags.map((tag) => (
                <span className="ove-write-tag" key={tag}>
                  {tag}
                  <button
                    type="button"
                    className="ove-write-tag-remove"
                    aria-label={t('write.removeTag', { tag })}
                    disabled={busy}
                    onClick={() => setTags(tags.filter((candidate) => candidate !== tag))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="ove-write-tagbar">
              <input
                className="ove-write-input"
                value={tagDraft}
                disabled={busy}
                placeholder={t('write.tagPlaceholder')}
                spellCheck={false}
                title={t('write.tagGrammar', { grammar: TAG_GRAMMAR })}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addTag()
                  }
                }}
              />
              <button type="button" className="ove-write-button" disabled={busy || tagDraft.trim().length === 0} onClick={addTag}>
                {t('write.addTag')}
              </button>
              <button type="button" className="ove-write-button" disabled={busy || tags.length === 0} onClick={() => setTags([])}>
                {t('write.clearTags')}
              </button>
            </div>
            <label className="ove-write-field ove-write-append">
              <span className="ove-write-toggle-text">{t('write.appendMode')}</span>
              <input
                className="ove-config-check"
                type="checkbox"
                checked={appendTags}
                disabled={busy}
                onChange={(event) => setAppendTags(event.target.checked)}
              />
            </label>
            {tagError !== null && <p className="ove-write-error">{tagError}</p>}
          </>
        )}

        {prepare.action === 'force-commit' && (
          <>
            <p className="ove-write-warning">{t('write.commitWarning')}</p>
            <dl className="ove-write-facts">
              <div>
                <dt>{t('write.pendingTokens')}</dt>
                <dd>{prepare.session?.pendingTokens ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('write.liveMessages')}</dt>
                <dd>{prepare.session?.messageCount ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('write.commitsSoFar')}</dt>
                <dd>{prepare.session?.commitCount ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('write.lastCommit')}</dt>
                <dd>{prepare.session?.lastCommitAt ?? t('write.never')}</dd>
              </div>
            </dl>
            <p className="ove-write-hint">{t('write.commitOnce')}</p>
          </>
        )}

        {error !== null && <ErrorLine error={error} />}
        {prepare.action === 'delete-memory' || prepare.action === 'force-commit' ? (
          <p className="ove-write-footnote">
            {prepare.preCommit === null
              ? t('write.auditOnly')
              : t('write.preCommitLine', { commit: (prepare.preCommit ?? '').slice(0, 12) })}
          </p>
        ) : null}

        <div className="ove-write-actions">
          {conflict && prepare.action === 'edit-memory' && (
            <button type="button" className="ove-write-button" disabled={busy} onClick={() => void reload()}>
              {t('write.reload')}
            </button>
          )}
          <button ref={cancelRef} type="button" className="ove-write-button" disabled={busy} onClick={close}>
            {t('write.cancel')}
          </button>
          <button
            type="button"
            className={`ove-write-button ove-write-primary${prepare.action === 'delete-memory' ? ' ove-write-danger' : ''}`}
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            {busy ? t('write.working') : actionLabel(prepare.action)}
          </button>
        </div>
      </div>
    </div>
  )
}

function actionLabel(action: WritePreparePayload['action']): string {
  switch (action) {
    case 'edit-memory':
      return t('write.confirmSave')
    case 'delete-memory':
      return t('write.confirmDelete')
    case 'set-tags':
      return t('write.confirmTags')
    default:
      return t('write.confirmCommit')
  }
}

/** The toast's success line, built from the prepare facts (and task id when one exists). */
export function successText(prepare: WritePreparePayload, taskId: string | null = null, skipped = false): string {
  switch (prepare.action) {
    case 'edit-memory':
      return t('write.doneEdit', { target: shortTarget(prepare.target) })
    case 'delete-memory':
      return t('write.doneDelete', { target: shortTarget(prepare.target) })
    case 'set-tags':
      return t('write.doneTags', { target: shortTarget(prepare.target), count: (prepare.tagsBefore ?? []).length })
    default:
      if (skipped) return t('write.commitSkipped')
      return taskId === null
        ? t('write.doneCommit', { session: prepare.target })
        : t('write.doneCommitTask', { session: prepare.target, task: taskId })
  }
}

function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((tag, index) => tag === b[index])
}

/* ---- the undo-plan dialog ------------------------------------------------ */

function planPaths(paths: UndoPlanPath[]): string {
  return paths.map((entry) => entry.path).filter((path) => path.length > 0).join('\n')
}

function UndoPlanDialog({ plan, className }: { plan: WriteUndoPlan; className: string }) {
  const busy = useWriteStore().busy
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const [error, setError] = useState<OveError | null>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [plan.undoId])

  const close = useCallback(() => {
    if (!busy) closeUndoPlan()
  }, [busy])

  const apply = useCallback(async () => {
    setError(null)
    setWriteBusy(true)
    try {
      const answer = await applyUndo(plan.undoId, plan.extraChanges)
      if (answer.ok) {
        closeUndoPlan()
        notifyWriteSettled('undo', plan.target)
        showNotice({
          tone: 'success',
          text:
            answer.outcome === 'tags-restored'
              ? t('write.undoTagsDone', { target: shortTarget(plan.target) })
              : t('write.undoDone', { target: shortTarget(plan.target) }),
          undoId: null,
          auditId: answer.auditId,
        })
      } else setError(answer.error)
    } finally {
      setWriteBusy(false)
    }
  }, [plan])

  return (
    <div className={`ove-overlay ove-write-overlay ${className}`}>
      <div className="ove-write-backdrop" onClick={close} />
      <div className="ove-write-dialog" role="dialog" aria-modal="true" aria-label={t('write.planTitle')}>
        <div className="ove-write-head">
          <span className="ove-write-title">{t('write.planTitle')}</span>
          <span className="ove-write-target" title={plan.target}>
            {shortTarget(plan.target)}
          </span>
        </div>
        <p className="ove-write-hint">{t('write.planHint', { dir: plan.projectDir })}</p>
        {plan.extraChanges ? (
          <p className="ove-write-warning">{t('write.planExtra')}</p>
        ) : (
          <p className="ove-write-hint">{t('write.planClean')}</p>
        )}
        <div className="ove-write-plan">
          {plan.toWrite.length > 0 && (
            <div>
              <span className="ove-write-plan-title">{t('write.planWrite')}</span>
              <pre>{planPaths(plan.toWrite)}</pre>
            </div>
          )}
          {plan.toDelete.length > 0 && (
            <div>
              <span className="ove-write-plan-title">{t('write.planDelete')}</span>
              <pre>{planPaths(plan.toDelete)}</pre>
            </div>
          )}
          {plan.toWrite.length === 0 && plan.toDelete.length === 0 && (
            <span className="ove-write-hint">{t('write.planEmpty')}</span>
          )}
        </div>
        {error !== null && <ErrorLine error={error} />}
        <div className="ove-write-actions">
          <button ref={cancelRef} type="button" className="ove-write-button" disabled={busy} onClick={close}>
            {t('write.cancel')}
          </button>
          <button type="button" className="ove-write-button ove-write-primary" disabled={busy} onClick={() => void apply()}>
            {busy ? t('write.working') : plan.extraChanges ? t('write.applyExtra') : t('write.applyUndo')}
          </button>
        </div>
      </div>
    </div>
  )
}
