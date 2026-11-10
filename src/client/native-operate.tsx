/**
 * v0.8 "Operate": the additive Operate group inside the v0.7 native cockpit.
 *
 * Four internal sub-tabs (Snapshots / Compile / Packs / Tasks) plus one Stats
 * segment (Observability, in `native-observability.tsx`). No new sidebar/main
 * seat: the v0.7 panel navigation grows by one item, exactly as designed.
 *
 * Every read here is always available; the action buttons are rendered only when
 * `enableOps` is on (`native.switches.ops`), and the host refuses every mutation
 * with `ops-disabled` regardless of what the client draws. Every action goes
 * through `OpsDialog` (the shared prepare→confirm→execute→audit→undo UI); there
 * is deliberately no Retry button anywhere — the tested servers expose no retry
 * API, and a compile can only be "re-run as a new compile".
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ActivityTask,
  ActivityTaskDetail,
  AuditEntry,
  CompileCapabilities,
  CompileOperationRow,
  CompileSubmissionPayload,
  CompileTargetRow,
  CompileTargetsPayload,
  PackExportRow,
  SnapshotCommit,
  SnapshotLogPayload,
  TaskListPayload,
} from '../shared/protocol.ts'
import {
  cancelTask,
  fetchAudit,
  fetchCompile,
  fetchCompileOperation,
  fetchCompileOperations,
  fetchCompileOutputs,
  fetchCompileSubmission,
  fetchCompileTarget,
  fetchPackHistory,
  fetchSnapshotDiff,
  fetchSnapshotDiffPaths,
  fetchSnapshotIgnore,
  fetchSnapshotLog,
  fetchSnapshotShow,
  fetchSnapshotVersions,
  fetchTaskDetail,
  fetchTasks,
  taskEvidenceUrl,
  taskExportUrl,
} from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { navigate, useNative } from './native-store.ts'
import { ConfirmShell, OpsDialog, type OpsDialogRequest } from './ops-dialog.tsx'
import { shortTarget } from './write-dialog.tsx'

/** A bounded human-readable error for a read route. */
function errorLine(error: { code: string; message: string }): string {
  return writeErrorText(error)
}

function shortOid(oid: string): string {
  return oid.length > 12 ? `${oid.slice(0, 12)}…` : oid
}

function stamp(value: string | number | null): string {
  if (value === null) return '—'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 19)
}

function bytes(value: number | null): string {
  if (value === null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

/** One small section wrapper with a title and an optional action row. */
function Section(props: { title: string; hint?: string | null; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="ove-ops-section">
      <header className="ove-ops-section-head">
        <span className="ove-ops-section-title">{props.title}</span>
        {props.hint !== null && props.hint !== undefined && <span className="ove-nat-muted">{props.hint}</span>}
        <span className="ove-nat-spacer" />
        {props.actions}
      </header>
      {props.children}
    </section>
  )
}

/** The "actions are disabled" notice shown with enableOps off. */
function ActionsDisabledNotice() {
  return <p className="ove-preview-hint ove-ops-disabled-note">{t('ops.actionsDisabled')}</p>
}

/* ========================================================================
 * Snapshots
 * ===================================================================== */

function SnapshotsView(props: { refreshKey: number }) {
  const native = useNative()
  const opsEnabled = native.switches.ops
  const prefillUri = native.target.operate?.uri ?? ''
  const [pathFilter, setPathFilter] = useState<string[]>(prefillUri.length === 0 ? [] : [prefillUri])
  const [log, setLog] = useState<SnapshotLogPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SnapshotCommit | null>(null)
  const [selectedPath, setSelectedPath] = useState('')
  const [show, setShow] = useState<Awaited<ReturnType<typeof fetchSnapshotShow>> | null>(null)
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof fetchSnapshotDiff>> | null>(null)
  const [versionsUri, setVersionsUri] = useState(prefillUri)
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof fetchSnapshotVersions>> | null>(null)
  const [changed, setChanged] = useState<Awaited<ReturnType<typeof fetchSnapshotDiffPaths>> | null>(null)
  const [ignore, setIgnore] = useState<Awaited<ReturnType<typeof fetchSnapshotIgnore>> | null>(null)
  const [dialog, setDialog] = useState<OpsDialogRequest | null>(null)
  const [form, setForm] = useState<'none' | 'create' | 'restore' | 'versions'>('none')
  const [message, setMessage] = useState('')
  const [pathsText, setPathsText] = useState(prefillUri)
  const [projectDir, setProjectDir] = useState(prefillUri)
  const [sourceCommit, setSourceCommit] = useState('')

  const loadLog = useCallback(() => {
    setLoading(true)
    setError(null)
    void fetchSnapshotLog({ limit: 20, ...(pathFilter.length === 0 ? {} : { paths: pathFilter }) }).then((answer) => {
      if (answer.ok) {
        setLog(answer)
        setLoading(false)
        return
      }
      setError(errorLine(answer.error))
      setLoading(false)
    })
  }, [pathFilter])

  useEffect(() => {
    loadLog()
  }, [loadLog, props.refreshKey])

  const openCommit = (commit: SnapshotCommit): void => {
    setSelected(commit)
    setShow(null)
    setDiff(null)
    void fetchSnapshotShow(commit.oid, null).then((answer) => {
      if (answer.ok) setShow(answer)
    })
  }

  const loadDiff = (): void => {
    if (selected === null || selectedPath.trim().length === 0) return
    const from = selected.parents[0] ?? null
    void fetchSnapshotDiff({ path: selectedPath.trim(), from, to: selected.oid }).then((answer) => {
      if (answer.ok) setDiff(answer)
    })
  }

  const loadChangedPaths = (): void => {
    if (selected === null) return
    const paths = pathFilter.length > 0 ? pathFilter : selectedPath.trim().length > 0 ? [selectedPath.trim()] : []
    if (paths.length === 0) return
    void fetchSnapshotDiffPaths({ paths, from: selected.parents[0] ?? null, to: selected.oid }).then((answer) => {
      if (answer.ok) setChanged(answer)
    })
  }

  const loadIgnore = (): void => {
    void fetchSnapshotIgnore().then((answer) => {
      if (answer.ok) setIgnore(answer)
    })
  }

  const loadVersions = (): void => {
    if (versionsUri.trim().length === 0) return
    void fetchSnapshotVersions({ uri: versionsUri.trim(), limit: 20 }).then((answer) => {
      if (answer.ok) setVersions(answer)
    })
  }

  const startCreate = (): void => {
    const paths = pathsText
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    setDialog({ action: 'snapshot-create', message: message.trim(), paths })
  }

  const startRestore = (): void => {
    setDialog({ action: 'snapshot-restore', projectDir: projectDir.trim(), sourceCommit: sourceCommit.trim() })
  }

  const startVersionRestore = (versionId: string): void => {
    if (versions === null || !versions.ok) return
    setDialog({
      action: 'file-version-restore',
      uri: versions.uri,
      restoreVersion: versionId,
      ...(versions.currentVersion === null ? {} : { currentVersion: versions.currentVersion }),
    })
  }

  const commits = log?.commits ?? []

  return (
    <div className="ove-nat-view ove-ops-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('ops.snapshots.title')}</span>
        <span className="ove-nat-muted">{t('ops.snapshots.subtitle')}</span>
        <span className="ove-nat-spacer" />
        <button type="button" onClick={loadLog}>
          {t('native.refresh')}
        </button>
        {opsEnabled && (
          <>
            <button type="button" onClick={() => setForm(form === 'create' ? 'none' : 'create')}>
              {t('ops.snapshots.create')}
            </button>
            <button type="button" onClick={() => setForm(form === 'restore' ? 'none' : 'restore')}>
              {t('ops.snapshots.restore')}
            </button>
          </>
        )}
      </header>
      {!opsEnabled && <ActionsDisabledNotice />}

      <div className="ove-ops-toolbar">
        <label className="ove-write-field ove-ops-inline-field">
          <span>{t('ops.snapshots.pathFilter')}</span>
          <input
            className="ove-write-input"
            type="text"
            value={pathFilter.join(', ')}
            placeholder="viking://…"
            onChange={(event) =>
              setPathFilter(
                event.target.value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              )
            }
          />
        </label>
        <span className="ove-nat-muted">{t('ops.snapshots.branchNote')}</span>
      </div>

      {form === 'create' && opsEnabled && (
        <Section
          title={t('ops.snapshots.createTitle')}
          hint={t('ops.snapshots.createHint')}
          actions={
            <>
              <button type="button" onClick={() => setForm('none')}>
                {t('write.cancel')}
              </button>
              <button type="button" className="ove-write-primary" onClick={startCreate}>
                {t('ops.snapshots.create')}
              </button>
            </>
          }
        >
          <label className="ove-write-field">
            <span>{t('ops.message')}</span>
            <input className="ove-write-input" type="text" maxLength={200} value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <label className="ove-write-field">
            <span>{t('ops.paths')}</span>
            <textarea className="ove-write-input" rows={3} value={pathsText} onChange={(event) => setPathsText(event.target.value)} />
          </label>
        </Section>
      )}

      {form === 'restore' && opsEnabled && (
        <Section
          title={t('ops.snapshots.restoreTitle')}
          hint={t('ops.snapshots.restoreHint')}
          actions={
            <>
              <button type="button" onClick={() => setForm('none')}>
                {t('write.cancel')}
              </button>
              <button type="button" className="ove-write-primary" onClick={startRestore}>
                {t('ops.snapshots.restore')}
              </button>
            </>
          }
        >
          <label className="ove-write-field">
            <span>{t('ops.projectDir')}</span>
            <input className="ove-write-input" type="text" value={projectDir} onChange={(event) => setProjectDir(event.target.value)} />
          </label>
          <label className="ove-write-field">
            <span>{t('ops.sourceCommit')}</span>
            <input className="ove-write-input" type="text" value={sourceCommit} onChange={(event) => setSourceCommit(event.target.value)} />
          </label>
        </Section>
      )}

      {loading && log === null && <p className="ove-preview-status">{t('native.loading')}</p>}
      {error !== null && <p className="ove-preview-error">{error}</p>}
      {log !== null && !loading && commits.length === 0 && (
        <p className="ove-preview-hint">
          {log.note === 'no-snapshot-history' ? t('ops.snapshots.noHistory') : log.note === 'forbidden' ? t('ops.snapshots.forbidden') : t('ops.snapshots.empty')}
        </p>
      )}

      {commits.length > 0 && (
        <Section title={t('ops.snapshots.history')} hint={t('ops.snapshots.historyHint')}>
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.commit')}</th>
                <th>{t('ops.author')}</th>
                <th>{t('ops.when')}</th>
                <th>{t('ops.message')}</th>
              </tr>
            </thead>
            <tbody>
              {commits.map((commit) => (
                <tr
                  key={commit.oid}
                  className={selected?.oid === commit.oid ? 'ove-ops-row-active' : 'ove-ops-row'}
                  onClick={() => openCommit(commit)}
                >
                  <td>
                    <code>{shortOid(commit.oid)}</code>
                  </td>
                  <td>{commit.authorName ?? '—'}</td>
                  <td>{stamp(commit.authoredAt)}</td>
                  <td>{commit.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {selected !== null && (
        <Section title={t('ops.snapshots.commitDetail')} hint={shortOid(selected.oid)}>
          <table className="ove-ops-table">
            <tbody>
              <tr>
                <th>{t('ops.message')}</th>
                <td>{selected.message}</td>
              </tr>
              <tr>
                <th>{t('ops.parents')}</th>
                <td>{selected.parents.length === 0 ? '—' : selected.parents.map(shortOid).join(', ')}</td>
              </tr>
              <tr>
                <th>{t('ops.when')}</th>
                <td>{stamp(selected.committedAt)}</td>
              </tr>
            </tbody>
          </table>
          {show !== null && show.ok && show.note !== null && <p className="ove-write-hint">{show.note}</p>}
          <div className="ove-ops-toolbar">
            <label className="ove-write-field ove-ops-inline-field">
              <span>{t('ops.path')}</span>
              <input
                className="ove-write-input"
                type="text"
                placeholder="viking://…"
                value={selectedPath}
                onChange={(event) => setSelectedPath(event.target.value)}
              />
            </label>
            <button type="button" onClick={loadDiff} disabled={selectedPath.trim().length === 0}>
              {t('ops.snapshots.showDiff')}
            </button>
            <button type="button" onClick={loadChangedPaths} disabled={pathFilter.length === 0 && selectedPath.trim().length === 0}>
              {t('ops.snapshots.changedPaths')}
            </button>
            <button
              type="button"
              onClick={() => {
                setProjectDir(selectedPath.trim())
                setSourceCommit(selected.oid)
                setForm('restore')
              }}
              disabled={!opsEnabled}
            >
              {t('ops.snapshots.restoreThis')}
            </button>
          </div>
          {selectedPath.trim().length > 0 && (
            <div className="ove-ops-toolbar">
              <button type="button" onClick={() => void fetchSnapshotShow(selected.oid, selectedPath.trim()).then((answer) => answer.ok && setShow(answer))}>
                {t('ops.snapshots.previewFile')}
              </button>
            </div>
          )}
          {show !== null && show.ok && show.path !== null && (
            <div className="ove-ops-preview">
              <p className="ove-nat-muted">
                {show.contentType === 'binary'
                  ? t('ops.snapshots.binary')
                  : t('ops.snapshots.previewMeta', { bytes: bytes(show.bytes), truncated: show.truncated ? t('ops.yes') : t('ops.no') })}
              </p>
              {show.text !== null && <pre className="ove-ops-pre">{show.text}</pre>}
            </div>
          )}
          {diff !== null && diff.ok && (
            <div className="ove-ops-preview">
              <p className="ove-nat-muted">{t('ops.snapshots.diffMeta', { type: diff.changeType ?? '—', truncated: diff.truncated ? t('ops.yes') : t('ops.no') })}</p>
              {diff.diffText !== null ? <pre className="ove-ops-pre">{diff.diffText}</pre> : <p className="ove-write-hint">{diff.note ?? ''}</p>}
            </div>
          )}
          {changed !== null && changed.ok && (
            <div className="ove-ops-preview">
              {!changed.available && <p className="ove-write-hint">{changed.note === 'not-supported' ? t('ops.snapshots.diffPathsUnsupported') : t('ops.snapshots.versionsUnavailable')}</p>}
              {changed.available && (
                <>
                  <p className="ove-nat-muted">{t('ops.snapshots.changedTotal', { total: changed.total })}</p>
                  <ul className="ove-ops-list ove-ops-mono">
                    {changed.changes.map((change) => (
                      <li key={change.uri}>
                        {change.uri} · {change.changeType}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </Section>
      )}

      <Section
        title={t('ops.snapshots.ignore')}
        hint={t('ops.snapshots.ignoreHint')}
        actions={
          <button type="button" onClick={loadIgnore}>
            {t('ops.snapshots.loadIgnore')}
          </button>
        }
      >
        {ignore !== null && !ignore.ok && <p className="ove-preview-error">{errorLine(ignore.error)}</p>}
        {ignore !== null && ignore.ok && !ignore.available && <p className="ove-preview-hint">{t('ops.snapshots.ignoreUnavailable')}</p>}
        {ignore !== null && ignore.ok && ignore.available && (
          <pre className="ove-ops-pre">{ignore.content.length === 0 ? t('ops.snapshots.ignoreEmpty') : ignore.content}</pre>
        )}
      </Section>

      <Section
        title={t('ops.snapshots.versions')}
        hint={t('ops.snapshots.versionsHint')}
        actions={
          <button type="button" onClick={loadVersions} disabled={versionsUri.trim().length === 0}>
            {t('ops.snapshots.loadVersions')}
          </button>
        }
      >
        <label className="ove-write-field">
          <span>{t('ops.uri')}</span>
          <input className="ove-write-input" type="text" value={versionsUri} onChange={(event) => setVersionsUri(event.target.value)} />
        </label>
        {versions !== null && !versions.ok && <p className="ove-preview-error">{errorLine(versions.error)}</p>}
        {versions !== null && versions.ok && !versions.available && (
          <p className="ove-preview-hint">
            {versions.note === 'not-compile-managed' ? t('ops.snapshots.notCompileManaged') : versions.note === 'not-supported' ? t('ops.snapshots.versionsUnsupported') : t('ops.snapshots.versionsUnavailable')}
          </p>
        )}
        {versions !== null && versions.ok && versions.available && (
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.versionNumber')}</th>
                <th>{t('ops.when')}</th>
                <th>{t('ops.operationId')}</th>
                <th>{t('ops.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {versions.versions.map((version) => (
                <tr key={version.versionId} className="ove-ops-row">
                  <td>{version.versionNumber}</td>
                  <td>{stamp(version.createdAt)}</td>
                  <td>{version.operationId ?? '—'}</td>
                  <td>
                    {opsEnabled && version.versionId !== versions.currentVersion && (
                      <button type="button" onClick={() => startVersionRestore(version.versionId)}>
                        {t('ops.snapshots.restoreVersion')}
                      </button>
                    )}
                    {version.versionId === versions.currentVersion && <span className="ove-nat-muted">{t('ops.snapshots.current')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <OpsDialog
        request={dialog}
        onClose={() => {
          setDialog(null)
          loadLog()
        }}
        onDone={() => loadLog()}
      />
    </div>
  )
}

/* ========================================================================
 * Compile
 * ===================================================================== */

function CompileView(props: { refreshKey: number }) {
  const native = useNative()
  const opsEnabled = native.switches.ops
  const [capabilities, setCapabilities] = useState<CompileCapabilities | null>(null)
  const [targets, setTargets] = useState<CompileTargetsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTarget, setSelectedTarget] = useState('')
  const [targetConfig, setTargetConfig] = useState<Awaited<ReturnType<typeof fetchCompileTarget>> | null>(null)
  const [operations, setOperations] = useState<Awaited<ReturnType<typeof fetchCompileOperations>> | null>(null)
  const [selectedOperation, setSelectedOperation] = useState<CompileOperationRow | null>(null)
  const [outputs, setOutputs] = useState<Awaited<ReturnType<typeof fetchCompileOutputs>> | null>(null)
  const [dialog, setDialog] = useState<OpsDialogRequest | null>(null)
  const [form, setForm] = useState<'none' | 'manual' | 'configured'>('none')
  const [manual, setManual] = useState({ to: '', from: '', skill: '', instruction: '' })
  const [submission, setSubmission] = useState<CompileSubmissionPayload | null>(null)

  const load = useCallback((fresh: boolean) => {
    setLoading(true)
    void fetchCompile().then((answer) => {
      if (!answer.ok) {
        setError(errorLine(answer.error))
        setLoading(false)
        return
      }
      setCapabilities(answer.capabilities)
      setTargets(answer.targets)
      setError(null)
      setLoading(false)
    })
    void fresh
  }, [])

  useEffect(() => {
    load(props.refreshKey > 0)
  }, [load, props.refreshKey])

  const selectTarget = (to: string): void => {
    setSelectedTarget(to)
    setSelectedOperation(null)
    setOutputs(null)
    void fetchCompileTarget(to).then((answer) => answer.ok && setTargetConfig(answer))
    void fetchCompileOperations({ to, limit: 20 }).then((answer) => answer.ok && setOperations(answer))
  }

  const openOperation = (operation: CompileOperationRow): void => {
    setSelectedOperation(operation)
    if (selectedTarget.length > 0) {
      void fetchCompileOperation({ to: selectedTarget, operationId: operation.operationId }).then((answer) => {
        if (answer.ok && answer.operation !== null) setSelectedOperation(answer.operation)
      })
      void fetchCompileOutputs({ to: selectedTarget, operationId: operation.operationId, limit: 50 }).then((answer) => {
        if (answer.ok) setOutputs(answer)
      })
    }
  }

  const startManual = (): void => {
    setDialog({
      action: 'compile-run',
      to: manual.to.trim(),
      from: manual.from
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      skill: manual.skill.trim(),
      ...(manual.instruction.trim().length === 0 ? {} : { instruction: manual.instruction.trim() }),
    })
  }

  const startConfigured = (to: string): void => {
    setDialog({ action: 'compile-run', to, from: [], skill: '', configuredTarget: to })
  }

  const checkSubmission = (key: string): void => {
    void fetchCompileSubmission(key).then((answer) => answer.ok && setSubmission(answer))
  }

  return (
    <div className="ove-nat-view ove-ops-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('ops.compile.title')}</span>
        <span className="ove-nat-muted">{t('ops.compile.subtitle')}</span>
        <span className="ove-nat-spacer" />
        <button type="button" onClick={() => load(true)}>
          {t('native.refresh')}
        </button>
        {opsEnabled && (
          <>
            <button type="button" onClick={() => setForm(form === 'configured' ? 'none' : 'configured')}>
              {t('ops.compile.configured')}
            </button>
            <button type="button" onClick={() => setForm(form === 'manual' ? 'none' : 'manual')}>
              {t('ops.compile.manual')}
            </button>
          </>
        )}
      </header>
      {!opsEnabled && <ActionsDisabledNotice />}
      {loading && capabilities === null && <p className="ove-preview-status">{t('native.loading')}</p>}
      {error !== null && <p className="ove-preview-error">{error}</p>}

      {capabilities !== null && (
        <div className={`ove-ops-banner ${capabilities.available ? 'ove-ops-banner-ok' : 'ove-ops-banner-warn'}`}>
          <strong>{t('ops.compile.capabilities')}</strong>
          <span>
            {capabilities.configured ? t('ops.compile.configuredYes') : t('ops.compile.configuredNo')} ·{' '}
            {capabilities.canCreate ? t('ops.compile.canCreateYes') : t('ops.compile.canCreateNo')}
            {capabilities.reason !== null ? ` · ${capabilities.reason}` : ''}
          </span>
        </div>
      )}

      {form === 'configured' && opsEnabled && (
        <Section
          title={t('ops.compile.configuredTitle')}
          hint={t('ops.compile.configuredHint')}
          actions={
            <button type="button" onClick={() => setForm('none')}>
              {t('write.cancel')}
            </button>
          }
        >
          {(targets?.targets ?? []).length === 0 && <p className="ove-preview-hint">{targets?.note === 'not-supported' ? t('ops.compile.registryUnsupported') : t('ops.compile.noTargets')}</p>}
          <ul className="ove-ops-list">
            {(targets?.targets ?? []).map((target) => (
              <li key={target.to}>
                <button type="button" className="ove-write-link" onClick={() => startConfigured(target.to)}>
                  {target.to}
                </button>{' '}
                <span className="ove-nat-muted">{target.compileType ?? ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {form === 'manual' && opsEnabled && (
        <Section
          title={t('ops.compile.manualTitle')}
          hint={t('ops.compile.manualHint')}
          actions={
            <>
              <button type="button" onClick={() => setForm('none')}>
                {t('write.cancel')}
              </button>
              <button type="button" className="ove-write-primary" onClick={startManual}>
                {t('ops.compile.trigger')}
              </button>
            </>
          }
        >
          <label className="ove-write-field">
            <span>{t('ops.to')}</span>
            <input className="ove-write-input" type="text" value={manual.to} onChange={(event) => setManual({ ...manual, to: event.target.value })} />
          </label>
          <label className="ove-write-field">
            <span>{t('ops.from')}</span>
            <textarea className="ove-write-input" rows={2} value={manual.from} onChange={(event) => setManual({ ...manual, from: event.target.value })} />
          </label>
          <label className="ove-write-field">
            <span>{t('ops.skill')}</span>
            <input className="ove-write-input" type="text" value={manual.skill} onChange={(event) => setManual({ ...manual, skill: event.target.value })} />
          </label>
          <label className="ove-write-field">
            <span>{t('ops.instruction')}</span>
            <input className="ove-write-input" type="text" maxLength={500} value={manual.instruction} onChange={(event) => setManual({ ...manual, instruction: event.target.value })} />
          </label>
          <p className="ove-write-hint">{t('ops.compile.memoryExcluded')}</p>
        </Section>
      )}

      <Section title={t('ops.compile.targets')} hint={targets?.note ?? null}>
        {(targets?.targets ?? []).length === 0 && <p className="ove-preview-hint">{targets?.note === 'not-supported' ? t('ops.compile.registryUnsupported') : t('ops.compile.noTargets')}</p>}
        {(targets?.targets ?? []).length > 0 && (
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.to')}</th>
                <th>{t('ops.compile.status')}</th>
                <th>{t('ops.compile.autoUpdate')}</th>
                <th>{t('ops.compile.nextRun')}</th>
                <th>{t('ops.compile.conflicts')}</th>
              </tr>
            </thead>
            <tbody>
              {(targets?.targets ?? []).map((target) => (
                <tr
                  key={target.to}
                  className={selectedTarget === target.to ? 'ove-ops-row-active' : 'ove-ops-row'}
                  onClick={() => selectTarget(target.to)}
                >
                  <td>{target.to}</td>
                  <td>{target.status ?? '—'}</td>
                  <td>{target.autoUpdate === null ? '—' : target.autoUpdate ? t('ops.yes') : t('ops.no')}</td>
                  <td>{target.nextRunAt ?? '—'}</td>
                  <td>{target.conflicts ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {targetConfig !== null && targetConfig.ok && targetConfig.target !== null && (
          <p className="ove-nat-muted">
            {t('ops.compile.configLine', {
              from: targetConfig.target.from.join(', '),
              skill: targetConfig.target.skill ?? '—',
            })}
          </p>
        )}
      </Section>

      <Section title={t('ops.compile.operations')} hint={selectedTarget.length === 0 ? t('ops.compile.pickTarget') : selectedTarget}>
        {operations !== null && operations.ok && !operations.available && <p className="ove-preview-hint">{t('ops.compile.operationsUnsupported')}</p>}
        {operations !== null && operations.ok && operations.available && operations.operations.length === 0 && <p className="ove-preview-hint">{t('ops.compile.noOperations')}</p>}
        {operations !== null && operations.ok && operations.operations.length > 0 && (
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.operationId')}</th>
                <th>{t('ops.compile.status')}</th>
                <th>{t('ops.when')}</th>
                <th>{t('ops.compile.taskId')}</th>
              </tr>
            </thead>
            <tbody>
              {operations.operations.map((operation) => (
                <tr
                  key={operation.operationId}
                  className={selectedOperation?.operationId === operation.operationId ? 'ove-ops-row-active' : 'ove-ops-row'}
                  onClick={() => openOperation(operation)}
                >
                  <td>
                    <code>{operation.operationId}</code>
                  </td>
                  <td>{operation.status ?? '—'}</td>
                  <td>{stamp(operation.createdAt)}</td>
                  <td>{operation.taskId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {selectedOperation !== null && (
        <Section title={t('ops.compile.operationDetail')} hint={selectedOperation.operationId}>
          <table className="ove-ops-table">
            <tbody>
              <tr>
                <th>{t('ops.compile.status')}</th>
                <td>{selectedOperation.status ?? '—'}</td>
              </tr>
              <tr>
                <th>{t('ops.compile.error')}</th>
                <td>{selectedOperation.error ?? '—'}</td>
              </tr>
              <tr>
                <th>{t('ops.compile.params')}</th>
                <td>
                  <pre className="ove-ops-pre">{selectedOperation.params === null ? '—' : JSON.stringify(selectedOperation.params, null, 2)}</pre>
                </td>
              </tr>
              <tr>
                <th>{t('ops.compile.result')}</th>
                <td>
                  <pre className="ove-ops-pre">{selectedOperation.result === null ? '—' : JSON.stringify(selectedOperation.result, null, 2)}</pre>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="ove-ops-toolbar">
            {opsEnabled && selectedOperation.taskId !== null && (
              <button
                type="button"
                onClick={() => {
                  setDialog({ action: 'compile-run', to: selectedTarget, from: [], skill: '', configuredTarget: selectedTarget })
                }}
              >
                {t('ops.compile.rerun')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const to = String((selectedOperation.params ?? {}).to ?? selectedTarget)
                const from = Array.isArray((selectedOperation.params ?? {}).from) ? ((selectedOperation.params ?? {}).from as string[]) : []
                const skill = String((selectedOperation.params ?? {}).skill ?? '')
                setManual({ to, from: from.join('\n'), skill, instruction: '' })
                setForm('manual')
              }}
            >
              {t('ops.compile.rerunAsNew')}
            </button>
          </div>
        </Section>
      )}

      {outputs !== null && outputs.ok && outputs.available && (
        <Section title={t('ops.compile.outputs')} hint={outputs.operationId}>
          {outputs.outputs.length === 0 && <p className="ove-preview-hint">{t('ops.compile.noOutputs')}</p>}
          <ul className="ove-ops-list ove-ops-mono">
            {outputs.outputs.map((output) => (
              <li key={output.uri}>
                {output.uri}
                <button
                  type="button"
                  className="ove-write-link ove-ops-inline-link"
                  onClick={() => navigate({ view: 'operate', operate: { tab: 'snapshots', uri: output.uri } })}
                >
                  {t('ops.compile.viewVersions')}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {submission !== null && (
        <Section title={t('ops.compile.submission')} hint={submission.key}>
          {submission.found ? (
            <p className="ove-nat-muted">
              {t('ops.compile.submissionFound', { task: submission.taskId ?? '—', status: submission.status ?? '—' })}
            </p>
          ) : (
            <p className="ove-preview-hint">{t('ops.compile.submissionNotFound')}</p>
          )}
        </Section>
      )}

      <TaskEvidenceHint />
      <OpsDialog
        request={dialog}
        onClose={() => setDialog(null)}
        onDone={(result) => {
          if ('idempotencyKey' in result && result.idempotencyKey !== undefined && result.idempotencyKey !== null) {
            if (result.verificationPending === true) checkSubmission(result.idempotencyKey)
          }
          if (selectedTarget.length > 0) selectTarget(selectedTarget)
        }}
      />
    </div>
  )
}

/* ========================================================================
 * Packs
 * ===================================================================== */

function PacksView(props: { refreshKey: number }) {
  const native = useNative()
  const opsEnabled = native.switches.ops
  const prefill = native.target.operate?.uri ?? ''
  const [history, setHistory] = useState<PackExportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<'none' | 'export'>('none')
  const [uri, setUri] = useState(prefill)
  const [includeVectors, setIncludeVectors] = useState(false)
  const [dialog, setDialog] = useState<OpsDialogRequest | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void fetchPackHistory().then((answer) => {
      if (!answer.ok) {
        setError(errorLine(answer.error))
        setLoading(false)
        return
      }
      setHistory(answer.history.exports)
      setError(null)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, props.refreshKey])

  return (
    <div className="ove-nat-view ove-ops-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('ops.packs.title')}</span>
        <span className="ove-nat-muted">{t('ops.packs.subtitle')}</span>
        <span className="ove-nat-spacer" />
        <button type="button" onClick={load}>
          {t('native.refresh')}
        </button>
        {opsEnabled && (
          <button type="button" onClick={() => setForm(form === 'export' ? 'none' : 'export')}>
            {t('ops.packs.export')}
          </button>
        )}
      </header>
      {!opsEnabled && <ActionsDisabledNotice />}
      <p className="ove-write-warning">{t('ops.packs.privacy')}</p>

      {form === 'export' && opsEnabled && (
        <Section
          title={t('ops.packs.exportTitle')}
          hint={t('ops.packs.exportHint')}
          actions={
            <>
              <button type="button" onClick={() => setForm('none')}>
                {t('write.cancel')}
              </button>
              <button
                type="button"
                className="ove-write-primary"
                onClick={() => setDialog({ action: 'pack-export', uri: uri.trim(), includeVectors })}
              >
                {t('ops.packs.export')}
              </button>
            </>
          }
        >
          <label className="ove-write-field">
            <span>{t('ops.uri')}</span>
            <input className="ove-write-input" type="text" value={uri} onChange={(event) => setUri(event.target.value)} />
          </label>
          <label className="ove-write-check">
            <input type="checkbox" checked={includeVectors} onChange={(event) => setIncludeVectors(event.target.checked)} />
            <span>{t('ops.includeVectorsLong')}</span>
          </label>
        </Section>
      )}

      <Section title={t('ops.packs.history')} hint={t('ops.packs.historyHint')}>
        {loading && <p className="ove-preview-status">{t('native.loading')}</p>}
        {error !== null && <p className="ove-preview-error">{error}</p>}
        {!loading && history.length === 0 && <p className="ove-preview-hint">{t('ops.packs.noHistory')}</p>}
        {history.length > 0 && (
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.when')}</th>
                <th>{t('ops.uri')}</th>
                <th>{t('ops.bytes')}</th>
                <th>{t('ops.result')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="ove-ops-row">
                  <td>{row.ts}</td>
                  <td>{row.target ?? '—'}</td>
                  <td>{bytes(row.bytes)}</td>
                  <td>{row.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="ove-write-hint">{t('ops.packs.oneTimeNote')}</p>
      </Section>

      <Section title={t('ops.packs.deferred')} hint={t('ops.packs.deferredHint')}>
        <ul className="ove-ops-list">
          <li>{t('ops.packs.backupDeferred')}</li>
          <li>{t('ops.packs.importDeferred')}</li>
          <li>{t('ops.packs.restoreDeferred')}</li>
        </ul>
      </Section>

      <OpsDialog request={dialog} onClose={() => setDialog(null)} onDone={() => load()} />
    </div>
  )
}

/* ========================================================================
 * Tasks (global, all types; no retry exists)
 * ===================================================================== */

function TasksView(props: { refreshKey: number }) {
  const native = useNative()
  const opsEnabled = native.switches.ops
  const [tasks, setTasks] = useState<TaskListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState<ActivityTaskDetail | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void fetchTasks({
      limit: 20,
      ...(typeFilter.length === 0 ? {} : { taskType: typeFilter }),
      ...(statusFilter.length === 0 ? {} : { status: statusFilter }),
    }).then((answer) => {
      if (!answer.ok) {
        setError(errorLine(answer.error))
        setLoading(false)
        return
      }
      setTasks(answer)
      setError(null)
      setLoading(false)
    })
  }, [typeFilter, statusFilter])

  useEffect(() => {
    load()
  }, [load, props.refreshKey])

  const openTask = (taskId: string): void => {
    void fetchTaskDetail(taskId, true).then((answer) => {
      if (answer.ok) setSelected(answer.task)
    })
    void fetchAudit(20, undefined, { taskId }).then((answer) => {
      if (answer.ok) setAudit(answer.entries)
    })
  }

  const cancel = async (): Promise<void> => {
    if (cancelId === null) return
    setCancelBusy(true)
    setCancelError(null)
    const answer = await cancelTask(cancelId)
    setCancelBusy(false)
    if (!answer.ok) {
      setCancelError(writeErrorText(answer.error))
      return
    }
    setCancelId(null)
    load()
    openTask(cancelId)
  }

  const taskList = tasks?.tasks ?? []

  return (
    <div className="ove-nat-view ove-ops-view">
      <header className="ove-nat-headline">
        <span className="ove-nat-headline-title">{t('ops.tasks.title')}</span>
        <span className="ove-nat-muted">{t('ops.tasks.subtitle')}</span>
        <span className="ove-nat-spacer" />
        <button type="button" onClick={load}>
          {t('native.refresh')}
        </button>
      </header>
      <p className="ove-write-warning">{t('ops.tasks.noRetry')}</p>
      {!opsEnabled && <ActionsDisabledNotice />}

      <div className="ove-ops-toolbar">
        <label className="ove-write-field ove-ops-inline-field">
          <span>{t('ops.tasks.typeFilter')}</span>
          <input className="ove-write-input" type="text" value={typeFilter} placeholder="compile" onChange={(event) => setTypeFilter(event.target.value)} />
        </label>
        <label className="ove-write-field ove-ops-inline-field">
          <span>{t('ops.tasks.statusFilter')}</span>
          <input className="ove-write-input" type="text" value={statusFilter} placeholder="running" onChange={(event) => setStatusFilter(event.target.value)} />
        </label>
      </div>

      {loading && tasks === null && <p className="ove-preview-status">{t('native.loading')}</p>}
      {error !== null && <p className="ove-preview-error">{error}</p>}
      {tasks !== null && !tasks.available && <p className="ove-preview-hint">{t('ops.tasks.unavailable')}</p>}
      {tasks !== null && tasks.available && taskList.length === 0 && <p className="ove-preview-hint">{t('ops.tasks.empty')}</p>}

      {taskList.length > 0 && (
        <Section title={t('ops.tasks.list')} hint={t('ops.tasks.listHint')}>
          <table className="ove-ops-table ove-ops-table-rows">
            <thead>
              <tr>
                <th>{t('ops.compile.taskId')}</th>
                <th>{t('ops.tasks.type')}</th>
                <th>{t('ops.compile.status')}</th>
                <th>{t('ops.when')}</th>
              </tr>
            </thead>
            <tbody>
              {taskList.map((task: ActivityTask) => (
                <tr
                  key={task.taskId}
                  className={selected?.taskId === task.taskId ? 'ove-ops-row-active' : 'ove-ops-row'}
                  onClick={() => openTask(task.taskId)}
                >
                  <td>
                    <code>{task.taskId}</code>
                  </td>
                  <td>{task.taskType}</td>
                  <td>{task.status}</td>
                  <td>{stamp(task.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {selected !== null && (
        <Section title={t('ops.tasks.detail')} hint={selected.taskId}>
          <table className="ove-ops-table">
            <tbody>
              <tr>
                <th>{t('ops.tasks.type')}</th>
                <td>{selected.taskType}</td>
              </tr>
              <tr>
                <th>{t('ops.compile.status')}</th>
                <td>{selected.status}</td>
              </tr>
              <tr>
                <th>{t('ops.tasks.stage')}</th>
                <td>{selected.stage ?? '—'}</td>
              </tr>
              <tr>
                <th>{t('ops.compile.error')}</th>
                <td>{selected.error ?? '—'}</td>
              </tr>
              <tr>
                <th>{t('ops.tasks.events')}</th>
                <td>
                  {selected.events === null ? '—' : (
                    <ul className="ove-ops-list ove-ops-mono">
                      {selected.events.map((event) => (
                        <li key={event.seq}>
                          {event.seq} · {event.kind} · {event.status ?? '—'} · {event.operation ?? '—'}
                          {event.error !== null ? ` · ${event.error}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
              <tr>
                <th>{t('ops.compile.result')}</th>
                <td>
                  <pre className="ove-ops-pre">{selected.result === null ? '—' : JSON.stringify(selected.result, null, 2)}</pre>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="ove-ops-toolbar">
            {opsEnabled && (
              <button type="button" onClick={() => setCancelId(selected.taskId)}>
                {t('ops.tasks.cancel')}
              </button>
            )}
            <a className="ove-write-link" href={taskExportUrl(selected.taskId)}>
              {t('ops.tasks.exportTask')}
            </a>
            <a className="ove-write-link" href={taskEvidenceUrl(selected.taskId)}>
              {t('ops.tasks.exportEvidence')}
            </a>
            {selected.taskType === 'compile' && (
              <button type="button" onClick={() => navigate({ view: 'operate', operate: { tab: 'compile' } })}>
                {t('ops.tasks.rerunCompile')}
              </button>
            )}
          </div>
          {audit.length > 0 && (
            <div className="ove-ops-preview">
              <p className="ove-nat-muted">{t('ops.tasks.auditRows', { count: audit.length })}</p>
              <ul className="ove-ops-list ove-ops-mono">
                {audit.map((entry) => (
                  <li key={entry.id}>
                    {entry.ts} · {entry.kind}/{entry.action} · {entry.result}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {cancelId !== null && (
        <ConfirmShell
          title={t('ops.tasks.cancelTitle')}
          scopeLine={null}
          fingerprint={null}
          busy={cancelBusy}
          confirmLabel={t('ops.tasks.cancelConfirm')}
          onCancel={() => setCancelId(null)}
          onConfirm={() => void cancel()}
          error={cancelError}
          footnote={t('ops.tasks.cancelNote')}
        >
          <p className="ove-write-warning">{t('ops.tasks.cancelWarning', { task: cancelId })}</p>
        </ConfirmShell>
      )}
    </div>
  )
}

/** The evidence/export hint reused by Compile and Tasks. */
function TaskEvidenceHint() {
  return <p className="ove-write-hint">{t('ops.tasks.evidenceHint')}</p>
}

/* ========================================================================
 * The group shell
 * ===================================================================== */

const OPERATE_TABS = ['snapshots', 'compile', 'packs', 'tasks'] as const
type OperateTab = (typeof OPERATE_TABS)[number]

export function NativeOperate(props: { refreshKey: number }) {
  const native = useNative()
  const requested = native.target.operate?.tab
  const [tab, setTab] = useState<OperateTab>(requested ?? 'snapshots')

  // A deep link inside the panel switches the sub-tab without remounting the
  // whole cockpit (browse selection → "History & restore…", task → operation…).
  useEffect(() => {
    if (requested !== undefined && requested !== tab) setTab(requested)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested])

  const active = useMemo(() => tab, [tab])

  return (
    <div className="ove-nat-view ove-ops">
      <nav className="ove-ops-tabs" role="tablist" aria-label={t('native.nav.views')}>
        {OPERATE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            className={`ove-ops-tab${active === id ? ' ove-ops-tab-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(`native.operate.tab.${id}`)}
          </button>
        ))}
      </nav>
      {active === 'snapshots' && <SnapshotsView refreshKey={props.refreshKey} />}
      {active === 'compile' && <CompileView refreshKey={props.refreshKey} />}
      {active === 'packs' && <PacksView refreshKey={props.refreshKey} />}
      {active === 'tasks' && <TasksView refreshKey={props.refreshKey} />}
    </div>
  )
}

/** Re-exported so the component test can render the prefill path directly. */
export { shortTarget }
