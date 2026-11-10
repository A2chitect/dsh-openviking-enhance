/**
 * v0.8 "Operate": the confirmation dialog for every controlled action.
 *
 * One component renders all five action plans plus the two undo flows, because
 * they share exactly the v0.5 write protocol: prepare → show scope/consequences
 * → explicit confirm (typed word for destructive) → execute → result with an
 * optional undo. The chrome is the shared `ConfirmShell` (scope block, error
 * line, cancel-first focus, Escape/backdrop cancel); DSH has no dialog primitive,
 * so this is the plugin's own overlay, same as `write-dialog.tsx`.
 *
 * Safety UX contract rendered for every plan:
 *  - the identity/scope it runs under (fingerprint included);
 *  - what it will change (paths/params/counts) and what it cannot undo;
 *  - the destructive actions require the scope's leaf name typed exactly;
 *  - Escape/backdrop/cancel releases the pending token (never leaves it alive);
 *  - a partial writeback and a verification-pending answer are stated, not
 *    glossed over, and there is no automatic retry anywhere.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  OpsExecutePayload,
  OpsPlan,
  OpsPreparePayload,
  OpsUndoPlan,
  OpsUndoPayload,
  OveError,
  PluginNotice,
} from '../shared/protocol.ts'
import {
  applyOpsUndo,
  cancelOps,
  downloadPack,
  executeOps,
  planOpsUndo,
  prepareOps,
  type OpsPrepareRequest,
} from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { shortTarget } from './write-dialog.tsx'

/** What the caller wants confirmed; the dialog prepares it on mount. */
export type OpsDialogRequest =
  | (OpsPrepareRequest & { action: 'snapshot-create' })
  | (OpsPrepareRequest & { action: 'snapshot-restore' })
  | (OpsPrepareRequest & { action: 'compile-run' })
  | (OpsPrepareRequest & { action: 'pack-export' })
  | (OpsPrepareRequest & { action: 'file-version-restore' })
  | { action: 'undo'; undoId: string }

/** The shared dialog chrome: scope, error line, cancel-first footer. */
export function ConfirmShell(props: {
  title: string
  scopeLine: string | null
  fingerprint: string | null
  children: ReactNode
  error: string | null
  busy: boolean
  confirmLabel: string
  onCancel: () => void
  onConfirm: (() => void) | null
  extraLabel?: string
  onExtra?: (() => void) | null
  footnote?: string | null
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    // Cancel-first focus: the safe action is the default one.
    cancelRef.current?.focus()
  }, [])
  const danger = props.confirmLabel.length > 0
  return (
    <div className="ove-overlay ove-write-backdrop" role="presentation" onClick={props.busy ? undefined : props.onCancel}>
      <div
        className="ove-write-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ove-write-head">
          <span className="ove-write-title">{props.title}</span>
          {props.scopeLine !== null && (
            <span className="ove-write-scope" title={props.fingerprint ?? undefined}>
              {props.scopeLine}
            </span>
          )}
        </div>
        <div className="ove-ops-body">{props.children}</div>
        {props.error !== null && <p className="ove-write-error">{props.error}</p>}
        {props.footnote !== null && props.footnote !== undefined && <p className="ove-write-footnote">{props.footnote}</p>}
        <div className="ove-write-actions">
          <button ref={cancelRef} type="button" className="ove-write-button" disabled={props.busy} onClick={props.onCancel}>
            {t('write.cancel')}
          </button>
          {props.onExtra !== undefined && props.onExtra !== null && (
            <button type="button" className="ove-write-button" disabled={props.busy} onClick={props.onExtra}>
              {props.extraLabel ?? t('ops.applyExtra')}
            </button>
          )}
          {props.onConfirm !== null && (
            <button
              type="button"
              className={`ove-write-button ${danger ? 'ove-write-primary' : ''}`}
              disabled={props.busy}
              onClick={props.onConfirm}
            >
              {props.busy ? t('write.working') : props.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function scopeLineOf(prepared: OpsPreparePayload): string {
  const scope = prepared.scope
  return `${scope.profileLabel ?? t('scope.legacyMode')} · ${scope.account}/${scope.user} · ${shortHash(scope.fingerprint)}`
}

function shortHash(value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  return `${hex.slice(0, 12)}…`
}

function NoticeList({ warnings }: { warnings: PluginNotice[] }) {
  if (warnings.length === 0) return null
  return (
    <div className="ove-nat-warnings">
      {warnings.map((warning, index) => (
        <div key={`${warning.code}-${index}`}>{t(`notice.${warning.code}`, warning.params)}</div>
      ))}
    </div>
  )
}

/** The plan body, one branch per action; the strings are the confirmation copy. */
function PlanBody(props: { plan: OpsPlan; typed: string; onTyped: (value: string) => void }) {
  const plan = props.plan
  if (plan.kind === 'snapshot-create') {
    return (
      <>
        <p className="ove-write-warning">{t('ops.createConsequence')}</p>
        <p className="ove-write-target">{plan.message}</p>
        <ul className="ove-ops-list">
          {plan.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </>
    )
  }
  if (plan.kind === 'snapshot-restore') {
    return (
      <>
        <p className="ove-write-warning">
          {t('ops.restoreConsequence', { dir: plan.projectDir, commit: plan.sourceCommit, deleted: plan.toDelete.length })}
        </p>
        <p className="ove-write-target">
          {t('ops.restoreCounts', { write: plan.toWrite.length, delete: plan.toDelete.length, unchanged: plan.unchanged })}
        </p>
        <PlanPaths rows={[...plan.toWrite, ...plan.toDelete]} truncated={plan.truncated} />
        {plan.head !== null && <p className="ove-write-hint">{t('ops.planHead', { head: shortHash(plan.head) })}</p>}
        <TypedWord word={plan.typedWord} value={props.typed} onChange={props.onTyped} />
      </>
    )
  }
  if (plan.kind === 'compile-run') {
    return (
      <>
        <p className="ove-write-warning">{t('ops.compileConsequence')}</p>
        <table className="ove-ops-table">
          <tbody>
            <tr>
              <th>{t('ops.to')}</th>
              <td>{plan.to}</td>
            </tr>
            <tr>
              <th>{t('ops.from')}</th>
              <td>{plan.from.join(', ')}</td>
            </tr>
            <tr>
              <th>{t('ops.skill')}</th>
              <td>{plan.skill}</td>
            </tr>
            {plan.instruction !== null && (
              <tr>
                <th>{t('ops.instruction')}</th>
                <td>{plan.instruction}</td>
              </tr>
            )}
            <tr>
              <th>{t('ops.idempotencyKey')}</th>
              <td>
                <code>{plan.idempotencyKey}</code>
              </td>
            </tr>
            {plan.configuredTarget !== null && (
              <tr>
                <th>{t('ops.configuredTarget')}</th>
                <td>{plan.configuredTarget}</td>
              </tr>
            )}
          </tbody>
        </table>
      </>
    )
  }
  if (plan.kind === 'pack-export') {
    return (
      <>
        <p className="ove-write-warning">{t('ops.packConsequence')}</p>
        <table className="ove-ops-table">
          <tbody>
            <tr>
              <th>{t('ops.uri')}</th>
              <td>{plan.uri}</td>
            </tr>
            <tr>
              <th>{t('ops.includeVectors')}</th>
              <td>{plan.includeVectors ? t('ops.yes') : t('ops.no')}</td>
            </tr>
            <tr>
              <th>{t('ops.maxBytes')}</th>
              <td>{formatBytes(plan.maxBytes)}</td>
            </tr>
          </tbody>
        </table>
      </>
    )
  }
  return (
    <>
      <p className="ove-write-warning">{t('ops.versionConsequence')}</p>
      <table className="ove-ops-table">
        <tbody>
          <tr>
            <th>{t('ops.uri')}</th>
            <td>{plan.uri}</td>
          </tr>
          <tr>
            <th>{t('ops.currentVersion')}</th>
            <td>{plan.currentVersionNumber ?? shortHash(plan.currentVersion)}</td>
          </tr>
          <tr>
            <th>{t('ops.restoreVersion')}</th>
            <td>{plan.restoreVersionNumber ?? shortHash(plan.restoreVersion)}</td>
          </tr>
        </tbody>
      </table>
      <TypedWord word={plan.typedWord} value={props.typed} onChange={props.onTyped} />
    </>
  )
}

function PlanPaths(props: { rows: Array<{ path: string; expected: boolean }>; truncated: boolean }) {
  if (props.rows.length === 0) return <p className="ove-write-hint">{t('write.planEmpty')}</p>
  return (
    <ul className="ove-ops-list ove-ops-mono">
      {props.rows.map((row, index) => (
        <li key={`${row.path}-${index}`} className={row.expected ? '' : 'ove-ops-extra'}>
          {row.path}
          {row.expected ? '' : ` · ${t('ops.unexpectedPath')}`}
        </li>
      ))}
      {props.truncated && <li className="ove-write-hint">{t('ops.planTruncated')}</li>}
    </ul>
  )
}

function TypedWord(props: { word: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="ove-write-field">
      <span>{t('ops.typeToConfirm', { word: props.word })}</span>
      <input
        className="ove-write-input"
        type="text"
        value={props.value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** The result panel after a successful execute. */
function ResultBody(props: {
  result: OpsExecutePayload
  undoId: string | null
  onUndo: () => void
  busy: boolean
  onClose: () => void
}) {
  const result = props.result
  return (
    <>
      <p className="ove-ops-done">{t('ops.done')}</p>
      {result.warnings.length > 0 && <NoticeList warnings={result.warnings} />}
      {result.partial !== undefined && result.partial !== null && (
        <div className="ove-ops-partial">
          <p className="ove-write-warning">{t('ops.restorePartial')}</p>
          <p className="ove-write-hint">
            {t('ops.restorePartialCounts', {
              written: result.partial.writtenPaths.length,
              failed: result.partial.failedWrites.length + result.partial.failedDeletes.length,
              task: result.partial.taskId ?? t('ops.none'),
            })}
          </p>
        </div>
      )}
      <table className="ove-ops-table">
        <tbody>
          {result.postCommit !== undefined && result.postCommit !== null && (
            <tr>
              <th>{t('ops.commit')}</th>
              <td>{shortHash(result.postCommit)}</td>
            </tr>
          )}
          {result.newCommit !== undefined && result.newCommit !== null && (
            <tr>
              <th>{t('ops.newCommit')}</th>
              <td>{shortHash(result.newCommit)}</td>
            </tr>
          )}
          {result.parentCommit !== undefined && result.parentCommit !== null && (
            <tr>
              <th>{t('ops.parentCommit')}</th>
              <td>{shortHash(result.parentCommit)}</td>
            </tr>
          )}
          {result.taskId !== undefined && result.taskId !== null && (
            <tr>
              <th>{t('ops.taskId')}</th>
              <td>{result.taskId}</td>
            </tr>
          )}
          {result.idempotencyKey !== undefined && result.idempotencyKey !== null && (
            <tr>
              <th>{t('ops.idempotencyKey')}</th>
              <td>
                <code>{result.idempotencyKey}</code>
              </td>
            </tr>
          )}
          {result.versionNumber !== undefined && result.versionNumber !== null && (
            <tr>
              <th>{t('ops.versionNumber')}</th>
              <td>{result.versionNumber}</td>
            </tr>
          )}
          {result.fileName !== undefined && result.fileName !== null && (
            <tr>
              <th>{t('ops.fileName')}</th>
              <td>{result.fileName}</td>
            </tr>
          )}
          {result.bytes !== undefined && result.bytes !== null && (
            <tr>
              <th>{t('ops.bytes')}</th>
              <td>{formatBytes(result.bytes)}</td>
            </tr>
          )}
          <tr>
            <th>{t('ops.auditId')}</th>
            <td>{result.auditId}</td>
          </tr>
        </tbody>
      </table>
      {result.verificationPending === true && (
        <p className="ove-write-hint">{t('ops.verificationPending')}</p>
      )}
      <div className="ove-write-actions">
        <button type="button" className="ove-write-button" onClick={props.onClose}>
          {t('ops.close')}
        </button>
        {result.downloadId !== undefined && result.downloadId !== null && result.fileName !== undefined && result.fileName !== null && (
          <DownloadButton downloadId={result.downloadId} fileName={result.fileName} />
        )}
        {props.undoId !== null && (
          <button type="button" className="ove-write-button" disabled={props.busy} onClick={props.onUndo}>
            {props.busy ? t('write.working') : t('ops.undo')}
          </button>
        )}
      </div>
    </>
  )
}

function DownloadButton(props: { downloadId: string; fileName: string }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const download = useCallback(async () => {
    setBusy(true)
    const answer = await downloadPack(props.downloadId, props.fileName)
    setBusy(false)
    if (!answer.ok) setError(answer.error)
  }, [props.downloadId, props.fileName])
  return (
    <>
      <button type="button" className="ove-write-button ove-write-primary" disabled={busy} onClick={() => void download()}>
        {busy ? t('write.working') : t('ops.download')}
      </button>
      {error !== null && <p className="ove-write-error">{error}</p>}
    </>
  )
}

/** The undo plan panel: shows the inverse paths and the extra-changes rule. */
function UndoPlanBody(props: { plan: OpsUndoPlan; extra: boolean; extraConfirm: boolean }) {
  return (
    <>
      <p className="ove-write-warning">{t('ops.undoConsequence')}</p>
      {props.plan.kind === 'snapshot-restore' ? (
        <PlanPaths rows={[...props.plan.toWrite, ...props.plan.toDelete]} truncated={props.plan.truncated} />
      ) : (
        <p className="ove-write-target">
          {t('ops.versionUndoLine', {
            uri: props.plan.uri ?? '',
            prior: props.plan.restoreVersion !== null ? shortHash(props.plan.restoreVersion) : '?',
            current: props.plan.currentVersion !== null ? shortHash(props.plan.currentVersion) : '?',
          })}
        </p>
      )}
      {props.extra && <p className="ove-write-warning">{t('write.planExtra')}</p>}
      {props.extraConfirm && <p className="ove-write-hint">{t('ops.confirmExtraHint')}</p>}
    </>
  )
}

/**
 * The dialog state machine. `onDone` lets the caller show a toast/refresh a list;
 * the undo flow lives here so both the toast and the history row share it.
 */
export function OpsDialog(props: {
  request: OpsDialogRequest | null
  onClose: () => void
  onDone?: (result: OpsExecutePayload | OpsUndoPayload) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'confirm' | 'executing' | 'result' | 'undo-plan' | 'undoing' | 'undo-done' | 'error'>('idle')
  const [prepared, setPrepared] = useState<OpsPreparePayload | null>(null)
  const [error, setError] = useState<OveError | null>(null)
  const [result, setResult] = useState<OpsExecutePayload | null>(null)
  const [undoPlan, setUndoPlan] = useState<OpsUndoPlan | null>(null)
  const [undoResult, setUndoResult] = useState<OpsUndoPayload | null>(null)
  const [extraConfirm, setExtraConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  const tokenRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Prepare on open; cancel the pending token when the dialog goes away.
  useEffect(() => {
    tokenRef.current = null
    setPrepared(null)
    setResult(null)
    setUndoPlan(null)
    setUndoResult(null)
    setError(null)
    setExtraConfirm(false)
    setTyped('')
    if (props.request === null) {
      setPhase('idle')
      return
    }
    if (props.request.action === 'undo') {
      void loadUndoPlan(props.request.undoId)
      return
    }
    let cancelled = false
    setPhase('loading')
    void prepareOps(props.request).then((answer) => {
      if (cancelled) return
      if (!answer.ok) {
        setError(answer.error)
        setPhase('error')
        return
      }
      tokenRef.current = answer.token
      setPrepared(answer)
      setPhase('confirm')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request])

  const close = useCallback(() => {
    const token = tokenRef.current
    tokenRef.current = null
    if (token !== null) void cancelOps(token)
    props.onClose()
  }, [props.onClose])

  // Escape cancels (never confirms).
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !['executing', 'undoing'].includes(phase)) close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [close, phase])

  const loadUndoPlan = async (undoId: string): Promise<void> => {
    setPhase('loading')
    const answer = await planOpsUndo(undoId)
    if (!mountedRef.current) return
    if (!answer.ok) {
      setError(answer.error)
      setPhase('error')
      return
    }
    setUndoPlan(answer.plan)
    setExtraConfirm(false)
    setPhase('undo-plan')
  }

  const execute = useCallback(async () => {
    if (prepared === null) return
    const token = tokenRef.current
    if (token === null) return
    setPhase('executing')
    setError(null)
    const answer = await executeOps(token, typed)
    if (!mountedRef.current) return
    if (!answer.ok) {
      setError(answer.error)
      // A typed-confirmation refusal keeps the token usable: back to confirm.
      if (answer.error.code === 'typed-confirmation-required' || answer.error.code === 'typed-confirmation-mismatch') {
        setPhase('confirm')
      } else {
        tokenRef.current = null
        setPhase('error')
      }
      return
    }
    tokenRef.current = null
    setResult(answer)
    setPhase('result')
    props.onDone?.(answer)
  }, [prepared, typed, props])

  const applyUndo = useCallback(async () => {
    if (undoPlan === null) return
    setPhase('undoing')
    setError(null)
    const answer = await applyOpsUndo(undoPlan.undoId, extraConfirm)
    if (!mountedRef.current) return
    if (!answer.ok) {
      setError(answer.error)
      setPhase('undo-plan')
      return
    }
    setUndoResult(answer)
    setPhase('undo-done')
    props.onDone?.(answer)
  }, [undoPlan, extraConfirm, props])

  if (props.request === null) return null

  const requestsUndo = props.request.action === 'undo'
  const undoBusy = phase === 'undoing' || phase === 'loading'
  const title = requestsUndo
    ? t('ops.undoTitle')
    : prepared === null
      ? t('ops.title')
      : t(`ops.title.${prepared.action}`)

  if (phase === 'loading') {
    return (
      <ConfirmShell
        title={title}
        scopeLine={prepared === null ? null : scopeLineOf(prepared)}
        fingerprint={prepared?.scope.fingerprint ?? null}
        error={null}
        busy={true}
        confirmLabel=""
        onCancel={close}
        onConfirm={null}
      >
        <p className="ove-preview-status">{t('ops.preparing')}</p>
      </ConfirmShell>
    )
  }

  if (phase === 'error') {
    return (
      <ConfirmShell
        title={title}
        scopeLine={prepared === null ? null : scopeLineOf(prepared)}
        fingerprint={prepared?.scope.fingerprint ?? null}
        error={error === null ? t('ops.failed') : writeErrorText(error)}
        busy={false}
        confirmLabel=""
        onCancel={close}
        onConfirm={null}
      >
        <p className="ove-write-hint">{t('ops.prepareFailed')}</p>
      </ConfirmShell>
    )
  }

  if (phase === 'result' && result !== null) {
    return (
      <ConfirmShell
        title={title}
        scopeLine={scopeLineOf({ ...(prepared as OpsPreparePayload), scope: result.scope })}
        fingerprint={result.scope.fingerprint}
        error={null}
        busy={false}
        confirmLabel=""
        onCancel={close}
        onConfirm={null}
      >
        <ResultBody
          result={result}
          undoId={result.undoId}
          busy={undoBusy}
          onClose={close}
          onUndo={() => {
            if (result.undoId === null) return
            void loadUndoPlan(result.undoId)
          }}
        />
      </ConfirmShell>
    )
  }

  if ((phase === 'undo-plan' || phase === 'undoing') && undoPlan !== null) {
    return (
      <ConfirmShell
        title={t('ops.undoTitle')}
        scopeLine={prepared === null ? null : scopeLineOf(prepared)}
        fingerprint={prepared?.scope.fingerprint ?? null}
        error={error === null ? null : writeErrorText(error)}
        busy={undoBusy}
        confirmLabel={t('write.applyUndo')}
        onCancel={close}
        onConfirm={() => void applyUndo()}
        extraLabel={undoPlan.extraChanges ? t('write.applyExtra') : undefined}
        onExtra={
          undoPlan.extraChanges
            ? () => {
                setExtraConfirm(true)
                void applyUndoWithExtra()
              }
            : undefined
        }
        footnote={t('ops.undoHint')}
      >
        <UndoPlanBody plan={undoPlan} extra={undoPlan.extraChanges} extraConfirm={extraConfirm} />
        {undoPlan.summary.length > 0 && (
          <ul className="ove-ops-list">
            {undoPlan.summary.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </ConfirmShell>
    )
  }

  // The extra button must use the freshly-set flag; React state is async, so the
  // extra path calls the same apply with an explicit extra=true request.
  async function applyUndoWithExtra(): Promise<void> {
    if (undoPlan === null) return
    setPhase('undoing')
    setError(null)
    const answer = await applyOpsUndo(undoPlan.undoId, true)
    if (!mountedRef.current) return
    if (!answer.ok) {
      setError(answer.error)
      setPhase('undo-plan')
      return
    }
    setUndoResult(answer)
    setPhase('undo-done')
    props.onDone?.(answer)
  }

  if (phase === 'undo-done' && undoResult !== null) {
    return (
      <ConfirmShell
        title={t('ops.undoTitle')}
        scopeLine={prepared === null ? null : scopeLineOf(prepared)}
        fingerprint={prepared?.scope.fingerprint ?? null}
        error={null}
        busy={false}
        confirmLabel=""
        onCancel={close}
        onConfirm={null}
      >
        <p className="ove-ops-done">{t('ops.undoDone')}</p>
        <table className="ove-ops-table">
          <tbody>
            {undoResult.newCommit !== null && (
              <tr>
                <th>{t('ops.commit')}</th>
                <td>{shortHash(undoResult.newCommit)}</td>
              </tr>
            )}
            {undoResult.taskId !== null && (
              <tr>
                <th>{t('ops.taskId')}</th>
                <td>{undoResult.taskId}</td>
              </tr>
            )}
            {undoResult.newVersionNumber !== null && (
              <tr>
                <th>{t('ops.versionNumber')}</th>
                <td>{undoResult.newVersionNumber}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="ove-write-actions">
          <button type="button" className="ove-write-button" onClick={close}>
            {t('ops.close')}
          </button>
        </div>
      </ConfirmShell>
    )
  }

  if (prepared === null) return null
  return (
    <ConfirmShell
      title={title}
      scopeLine={scopeLineOf(prepared)}
      fingerprint={prepared.scope.fingerprint}
      error={error === null ? null : writeErrorText(error)}
      busy={false}
      confirmLabel={confirmLabelFor(prepared)}
      onCancel={close}
      onConfirm={() => void execute()}
      footnote={t('ops.notAutomaticRetry')}
    >
      <PlanBody plan={prepared.plan} typed={typed} onTyped={setTyped} />
      {prepared.summary.length > 0 && (
        <ul className="ove-ops-list">
          {prepared.summary.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </ConfirmShell>
  )
}

function confirmLabelFor(prepared: OpsPreparePayload): string {
  if (prepared.action === 'pack-export') return t('ops.confirmExport')
  if (prepared.action === 'compile-run') return t('ops.confirmCompile')
  if (prepared.action === 'snapshot-create') return t('ops.confirmCreate')
  return t('ops.confirmRestore')
}
