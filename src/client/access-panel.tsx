/**
 * v0.9 §5: the read-only ACL **Access** tab.
 *
 * Shown in the Browse preview pane beside Preview, and only for
 * `viking://resources/**` URIs (the one path family the shipped server's ACL
 * route accepts). It renders one of the four explicit states and never guesses
 * whether ACL is "enabled":
 *
 *   available        — the server returned a report: direct/inherited/effective
 *                      tables (bounded by the host) plus the visibility class
 *   denied-no-manage — 403: ACL may be enabled without this identity having
 *                      `manage`, **or** ACL may be disabled; the copy says both
 *   only-resources   — the server only supports resources URIs
 *   unsupported      — the route is absent on this build
 *
 * There are no grant/revoke/edit controls (those are admin operations and out of
 * scope) and no share/invite button: the tested server builds have no sharing API
 * at all. The panel says that explicitly instead of pretending.
 */
import { useEffect, useState } from 'react'
import type { AclEntry, AclPayload, AclViewState } from '../shared/protocol.ts'
import { fetchAcl } from './host-api.ts'
import { t } from './locale.ts'

/** The four ACL states' localized headline. */
function stateTitle(state: AclViewState): string {
  return t(`acl.state.${state}`)
}

/** The state explanation, including the deliberate 403 ambiguity. */
function stateDetail(acl: AclPayload): string {
  if (acl.state === 'denied-no-manage') return t('acl.deniedHint')
  if (acl.state === 'only-resources') return t('acl.onlyResourcesHint')
  if (acl.state === 'unsupported') return t('acl.unsupportedHint')
  return ''
}

/** The visibility classification's localized label. */
function visibilityLabel(visibility: AclPayload['visibility']): string {
  return t(`acl.visibility.${visibility}`)
}

function AclTable({ title, entries }: { title: string; entries: AclEntry[] }) {
  return (
    <div className="ove-acl-table">
      <div className="ove-acl-table-title">{t(title, { count: entries.length })}</div>
      {entries.length === 0 ? (
        <p className="ove-preview-hint">{t('acl.empty')}</p>
      ) : (
        <table className="ove-acl">
          <thead>
            <tr>
              <th>{t('acl.principal')}</th>
              <th>{t('acl.level')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.principal}:${entry.level}`}>
                <td title={entry.principal}>{entry.principal}</td>
                <td>{entry.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export interface AccessPanelProps {
  uri: string
  refreshKey: number
}

/** The Access tab body for one selected resource URI. */
export function AccessPanel({ uri, refreshKey }: AccessPanelProps) {
  const [acl, setAcl] = useState<AclPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Start in the loading state: the SSR/first paint says it is reading instead of
  // rendering an empty panel (the effect runs immediately after mount).
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetchAcl(uri, refreshKey > 0).then((answer) => {
      if (cancelled) return
      setLoading(false)
      if (answer.ok) {
        setAcl(answer.acl)
        return
      }
      setError(answer.error.message)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [uri, refreshKey])

  if (loading && acl === null) return <p className="ove-preview-status">{t('acl.loading')}</p>
  if (error !== null) return <p className="ove-preview-error">{error}</p>
  if (acl === null) return null
  return (
    <div className="ove-acl-panel">
      <div className="ove-acl-header">
        <span className={`ove-acl-state ove-acl-state-${acl.state}`}>{stateTitle(acl.state)}</span>
        <span className="ove-preview-hint">{visibilityLabel(acl.visibility)}</span>
        <span className="ove-spacer" />
        {acl.version !== null && <span className="ove-empty">{`v${acl.version}`}</span>}
        {acl.role !== null && <span className="ove-empty">{acl.role}</span>}
      </div>
      {stateDetail(acl) !== '' && <p className="ove-preview-hint">{stateDetail(acl)}</p>}
      {acl.detail !== null && acl.state !== 'available' && (
        <p className="ove-preview-hint" title={acl.detail}>
          {acl.detail}
        </p>
      )}
      {acl.state === 'available' && (
        <>
          <p className="ove-preview-hint">
            {t('acl.mode', { mode: acl.aclMode ?? t('scope.unknown') })}
          </p>
          <AclTable title="acl.direct" entries={acl.direct} />
          <AclTable title="acl.inherited" entries={acl.inherited} />
          <AclTable title="acl.effective" entries={acl.effective} />
        </>
      )}
      <p className="ove-acl-sharing">{t('acl.noSharingApi')}</p>
      <p className="ove-preview-hint">{t('acl.privacy')}</p>
    </div>
  )
}
