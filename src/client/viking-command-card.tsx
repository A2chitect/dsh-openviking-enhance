/**
 * F6: the rich `/viking` command row.
 *
 * Registered into the keyed `conversation.chat.commandview` slot under the key
 * `viking`, so `/viking` rows render this component instead of the generic
 * plain-text card — every client that sees the durable command record gets it,
 * and an unoccupied key still falls back to the generic card
 * (docs/dsh-contracts-v05.md §2).
 *
 * The host prints two lines for a prepared write: a human fallback sentence and
 * a single-line JSON envelope. This card parses the envelope and renders the
 * confirmation UI (Confirm/Cancel, a typed field for a delete, the tag list for a
 * tag update, the commit warning for a force commit). Clients without this
 * renderer still show the human line, which names the plain
 * `--confirm <token>` form — that is the documented fallback.
 *
 * The envelope never carries a memory body: the edit verb only opens the editor,
 * whose body comes from its own authenticated request.
 */
import { useCallback, useState } from 'react'
import type { OveError, WritePreparePayload } from '../shared/protocol.ts'
import { applyUndo, executeWrite, planUndo, prepareWrite } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { openPreview } from './preview-store.ts'
import { openUndoPlan, openWriteConfirm, showNotice } from './write-store.ts'
import { shortTarget } from './write-dialog.tsx'

/** The slice of the folded command node this card renders. */
export interface VikingCommandNodeLike {
  readonly name?: string | null
  readonly args?: string | null
  readonly outcome?: { readonly kind?: string; readonly text?: string | null } | null
}

/** One envelope emitted by `src/host/viking-command.ts`. */
interface EnvelopeBase {
  ov: '1'
  kind: 'confirm' | 'open-editor'
}
interface ConfirmEnvelope extends EnvelopeBase {
  kind: 'confirm'
  prepare: WritePreparePayload
  hint: string
}
interface EditorEnvelope extends EnvelopeBase {
  kind: 'open-editor'
  uri: string
}
type Envelope = ConfirmEnvelope | EditorEnvelope

/** Extract the last line carrying the plugin's envelope, or null. */
export function parseEnvelope(text: string | null | undefined): Envelope | null {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      if (record.ov !== '1') continue
      if (record.kind === 'open-editor' && typeof record.uri === 'string') {
        return { ov: '1', kind: 'open-editor', uri: record.uri }
      }
      if (record.kind === 'confirm' && record.prepare !== null && typeof record.prepare === 'object') {
        return {
          ov: '1',
          kind: 'confirm',
          prepare: record.prepare as WritePreparePayload,
          hint: typeof record.hint === 'string' ? record.hint : '',
        }
      }
    } catch {
      // Not our line (a normal multi-line command result), keep looking.
    }
  }
  return null
}

/** The text a plain client sees for a command with no envelope. */
export function plainCommandText(node: VikingCommandNodeLike): string {
  const text = node.outcome?.text ?? ''
  return text.length > 0 ? text : t('write.commandEmpty')
}

export interface VikingCommandCardProps {
  /** The folded command node from the chat slot. */
  node?: VikingCommandNodeLike
  /** The session the command ran in (needed for the actor peer). */
  sessionId?: string
}

export function VikingCommandCard({ node, sessionId }: VikingCommandCardProps) {
  const text = node?.outcome?.text ?? null
  const envelope = parseEnvelope(text)
  if (envelope === null) {
    return (
      <div className="ove-cmd">
        <pre className="ove-cmd-plain">{plainCommandText(node ?? {})}</pre>
      </div>
    )
  }
  if (envelope.kind === 'open-editor') {
    return <EditorCard uri={envelope.uri} sessionId={sessionId} />
  }
  return <ConfirmCard prepare={envelope.prepare} hint={envelope.hint} sessionId={sessionId} />
}

/* ---- open-editor --------------------------------------------------------- */

function EditorCard({ uri, sessionId }: { uri: string; sessionId?: string }) {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const open = useCallback(() => {
    // Reveal the preview page (informational) and raise the editor dialog. The
    // dialog lives in `shell.overlay`, so it works even if the right column is
    // mounted for another tab.
    openPreview(uri)
    // The prepare request is what loads the body and takes the snapshot; the
    // dialog owns it from here, exactly like the preview action bar.
    setBusy(true)
    void prepareWrite({
      action: 'edit-memory',
      target: uri,
      ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
    }).then(async (answer) => {
      setBusy(false)
      if (!answer.ok) {
        setNote(writeErrorText(answer.error))
        return
      }
      openWriteConfirm(answer)
    })
  }, [sessionId, uri])

  return (
    <div className="ove-cmd">
      <div className="ove-cmd-head">
        <span className="ove-cmd-title">{t('write.cmdEditTitle')}</span>
        <span className="ove-cmd-target" title={uri}>
          {shortTarget(uri)}
        </span>
      </div>
      <p className="ove-cmd-hint">{t('write.cmdEditHint')}</p>
      {note !== null && <p className="ove-cmd-error">{note}</p>}
      <div className="ove-cmd-actions">
        <button type="button" className="ove-write-button ove-write-primary" disabled={busy} onClick={open}>
          {busy ? t('write.working') : t('write.openEditor')}
        </button>
      </div>
    </div>
  )
}

/* ---- confirm ------------------------------------------------------------- */

type Phase = 'pending' | 'executing' | 'done' | 'cancelled' | 'error'

function ConfirmCard({ prepare, hint, sessionId }: { prepare: WritePreparePayload; hint: string; sessionId?: string }) {
  const [phase, setPhase] = useState<Phase>('pending')
  const [error, setError] = useState<OveError | null>(null)
  const [typed, setTyped] = useState('')
  const [undoId, setUndoId] = useState<string | null>(null)
  void sessionId

  const needsTyped = prepare.action === 'delete-memory'
  const canConfirm = needsTyped ? typed.trim() === prepare.confirmWord : true

  const confirm = useCallback(async () => {
    setPhase('executing')
    setError(null)
    const body =
      prepare.action === 'set-tags'
        ? { token: prepare.token, tags: prepare.tagsAfter ?? [] }
        : prepare.action === 'delete-memory'
          ? { token: prepare.token, typed }
          : { token: prepare.token }
    const answer = await executeWrite(body)
    if (answer.ok) {
      setPhase('done')
      setUndoId(answer.undoId)
      showNotice({
        tone: 'success',
        text:
          answer.action === 'force-commit'
            ? t('write.cmdCommitDone', { session: answer.target })
            : t('write.cmdDone', { target: shortTarget(answer.target) }),
        undoId: answer.undoId,
        auditId: answer.auditId,
      })
    } else {
      setPhase('error')
      setError(answer.error)
    }
  }, [prepare, typed])

  const undo = useCallback(async () => {
    if (undoId === null) return
    const planned = await planUndo(undoId)
    if (!planned.ok) {
      setError(planned.error)
      return
    }
    if (planned.plan.extraChanges) {
      openUndoPlan(planned.plan)
      return
    }
    const applied = await applyUndo(undoId)
    if (!applied.ok) setError(applied.error)
    else setUndoId(null)
  }, [undoId])

  void undo

  return (
    <div className="ove-cmd">
      <div className="ove-cmd-head">
        <span className="ove-cmd-title">{titleOf(prepare)}</span>
        <span className="ove-cmd-target" title={prepare.target}>
          {prepare.action === 'force-commit' ? prepare.target : shortTarget(prepare.target)}
        </span>
      </div>
      <p className="ove-cmd-scope">
        {prepare.scope.profileLabel ?? t('scope.legacyMode')} · {prepare.scope.account}/{prepare.scope.user}
        {prepare.scope.peer === null ? '' : ` · ${prepare.scope.peer}`}
      </p>
      {hint.length > 0 && <p className="ove-cmd-hint">{hint}</p>}
      {prepare.action === 'set-tags' && (
        <div className="ove-cmd-tags">
          {(prepare.tagsAfter ?? []).length === 0 ? (
            <span className="ove-cmd-hint">{t('write.noTags')}</span>
          ) : (
            (prepare.tagsAfter ?? []).map((tag) => (
              <span className="ove-cmd-tag" key={tag}>
                {tag}
              </span>
            ))
          )}
        </div>
      )}
      {needsTyped && phase === 'pending' && (
        <input
          className="ove-write-input"
          value={typed}
          placeholder={prepare.confirmWord ?? ''}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      )}
      {phase === 'done' && (
        <p className="ove-cmd-done">
          {t('write.cmdSettled')}
          {undoId === null ? '' : ` · ${t('write.cmdUndoAvailable')}`}
        </p>
      )}
      {error !== null && <p className="ove-cmd-error">{writeErrorText(error)}</p>}
      {phase === 'pending' || phase === 'executing' ? (
        <div className="ove-cmd-actions">
          <button type="button" className="ove-write-button" disabled={phase === 'executing'} onClick={() => setPhase('cancelled')}>
            {t('write.cancel')}
          </button>
          <button
            type="button"
            className={`ove-write-button ove-write-primary${prepare.action === 'delete-memory' ? ' ove-write-danger' : ''}`}
            disabled={!canConfirm || phase === 'executing'}
            onClick={() => void confirm()}
          >
            {phase === 'executing' ? t('write.working') : t('write.confirm')}
          </button>
        </div>
      ) : phase === 'cancelled' ? (
        <p className="ove-cmd-hint">{t('write.cmdCancelled')}</p>
      ) : null}
    </div>
  )
}

function titleOf(prepare: WritePreparePayload): string {
  switch (prepare.action) {
    case 'edit-memory':
      return t('write.cmdConfirmEdit')
    case 'delete-memory':
      return t('write.cmdConfirmDelete')
    case 'set-tags':
      return t('write.cmdConfirmTags')
    default:
      return t('write.cmdConfirmCommit')
  }
}
