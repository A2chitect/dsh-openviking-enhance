/**
 * This plugin's row configuration on the Plugins page.
 *
 * The Plugins page gives a row a **Configure** control only while something
 * registers here, so without this file the plugin's settings existed for the
 * Loader and for agents but not for a person in the GUI (see PUBLISHING.md).
 * The page itself owns the values: it reads the entry's volatile fields and
 * hands this component a snapshot plus one atomic write — nothing here talks to
 * the Host directly, and a write is validated against the plugin's `Config`
 * before it is persisted.
 *
 * Editing rules, all of them the page's contract rather than this file's ideas:
 *
 *  - the resolved value is what the plugin runs with; the *base* is the layer it
 *    reverts to when a field is cleared, and a field is "overridden" when it is
 *    present in the raw user layer — not when its value differs (an override
 *    equal to the default is still an override);
 *  - every edit is staged locally and submitted in ONE `mutate` carrying the
 *    revision this component read, so a concurrent write is refused instead of
 *    silently overwriting it, and a refusal keeps the draft for a retry;
 *  - clearing a field is an `unset`, which restores inheritance rather than
 *    writing an empty string.
 */
import { useCallback, useState } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { configOps } from './config-ops.ts'
import { probeEndpoint } from './host-api.ts'
import { t } from './locale.ts'

interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly hint: string
  readonly placeholder?: string
  readonly secret?: boolean
  readonly numeric?: boolean
}

/** The Config fields in the order a person should meet them. */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'endpoint',
    label: 'config.endpoint',
    hint: 'config.endpointHint',
    placeholder: 'http://127.0.0.1:1933',
  },
  { key: 'apiKey', label: 'config.apiKey', hint: 'config.apiKeyHint', secret: true },
  { key: 'account', label: 'config.account', hint: 'config.accountHint' },
  { key: 'user', label: 'config.user', hint: 'config.userHint' },
  { key: 'studioPath', label: 'config.studioPath', hint: 'config.studioPathHint', placeholder: '/studio/' },
  { key: 'cacheTtlMs', label: 'config.cacheTtl', hint: 'config.cacheTtlHint', numeric: true, placeholder: '2500' },
  { key: 'recallCacheTtlMs', label: 'config.recallCacheTtl', hint: 'config.recallCacheTtlHint', numeric: true, placeholder: '15000' },
]

const SECRET_PLACEHOLDER = '••••••••'

/** One value as an input shows it. `undefined`/`null` are an empty field. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * The row's one-liner, shown where the page wants a `summary`.
 *
 * A row whose package has no description falls back to this, so it says what the
 * plugin is pointed at rather than repeating the package name.
 */
function SummaryLine({ form }: { form: PluginConfigViewProps['form'] }) {
  const resolved = (form?.state.value ?? {}) as Record<string, unknown>
  const endpoint = asText(resolved.endpoint)
  return <span>{endpoint.length > 0 ? `OpenViking · ${endpoint}` : t('config.summaryUnset')}</span>
}

export function ConfigPage(props: PluginConfigViewProps) {
  if (props.view === 'summary') return <SummaryLine form={props.form} />
  return <ConfigForm form={props.form} />
}

function ConfigForm({ form }: { form: PluginConfigViewProps['form'] }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [probe, setProbe] = useState<string | null>(null)

  const state = form?.state
  const resolved = (state?.value ?? {}) as Record<string, unknown>
  const overrides = (state?.user ?? {}) as Record<string, unknown>
  const base = (state?.base ?? {}) as Record<string, unknown>
  const writable = state?.writable === true

  const valueOf = useCallback(
    (field: FieldSpec): string => draft[field.key] ?? (field.secret && field.key in overrides ? SECRET_PLACEHOLDER : asText(resolved[field.key])),
    [draft, overrides, resolved],
  )

  const stage = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setNote(null)
  }

  const clear = (key: string) => {
    setDraft((current) => ({ ...current, [key]: '' }))
    setNote(null)
  }

  const save = async () => {
    if (form === undefined) return
    // Staging → operations is pure and tested on its own (`config-ops.ts`); this
    // only words the refusal.
    const result = configOps(FIELDS, draft)
    if (!result.ok) {
      const field = FIELDS.find((candidate) => candidate.key === result.field)
      setNote({
        tone: 'bad',
        text: t('config.needNumber', { label: field === undefined ? result.field : t(field.label) }),
      })
      return
    }
    const ops = result.ops
    if (ops.length === 0) {
      setNote({ tone: 'ok', text: t('config.noChanges') })
      return
    }
    setBusy(true)
    try {
      // The revision read with the snapshot is the fence: a write against a
      // namespace someone else changed comes back false, and the draft stays.
      const accepted = await form.mutate(ops, state?.revision)
      if (accepted) {
        setDraft({})
        setNote({ tone: 'ok', text: t('config.saved') })
      } else {
        setNote({ tone: 'bad', text: t('config.refused') })
      }
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    const candidate = valueOf(FIELDS[0] as FieldSpec).trim()
    setProbe(t('config.checking'))
    const answer = await probeEndpoint(candidate)
    // One route error has copy of its own; anything else is a diagnostic and is
    // shown as the host wrote it.
    if (!answer.ok) setProbe(answer.error === 'endpoint-not-loopback' ? t('config.probeRefused') : answer.error)
    else if (answer.reachable) setProbe(t('config.probeOk', { version: answer.version ?? t('config.probeVersionUnknown') }))
    else setProbe(t('config.probeFailed', { error: answer.error ?? t('config.unknownError') }))
  }

  if (state === undefined || state.status === 'loading') {
    return <p className="ove-config-note">{t('config.loading')}</p>
  }
  if (state.status === 'unavailable') {
    return (
      <p className="ove-config-note">
        {t('config.unavailable')}
      </p>
    )
  }

  return (
    <div className="ove-config">
      {!writable && <p className="ove-config-note">{t('config.readonly')}</p>}
      {FIELDS.map((field) => (
        <label className="ove-config-field" key={field.key}>
          <span className="ove-config-label">
            {t(field.label)}
            {field.key in overrides && <span className="ove-config-badge">{t('config.overridden')}</span>}
          </span>
          <span className="ove-config-control">
            <input
              className="ove-config-input"
              type={field.secret ? 'password' : 'text'}
              value={valueOf(field)}
              placeholder={field.placeholder ?? (field.key in base ? asText(base[field.key]) : '')}
              spellCheck={false}
              disabled={!writable || busy}
              onChange={(event) => stage(field.key, event.target.value)}
            />
            {field.key === 'endpoint' && (
              <button type="button" className="ove-config-button" onClick={() => void test()} disabled={busy}>
                {t('config.check')}
              </button>
            )}
            <button
              type="button"
              className="ove-config-button"
              title={t('config.defaultHint')}
              onClick={() => clear(field.key)}
              disabled={!writable || busy}
            >
              {t('config.default')}
            </button>
          </span>
          <span className="ove-config-hint">{t(field.hint)}</span>
        </label>
      ))}

      {probe !== null && <p className="ove-config-note">{probe}</p>}
      {note !== null && (
        <p className={note.tone === 'ok' ? 'ove-config-note' : 'ove-config-error'}>{note.text}</p>
      )}

      <div className="ove-config-actions">
        <button type="button" className="ove-config-primary" onClick={() => void save()} disabled={!writable || busy}>
          {t('config.save')}
        </button>
        <button
          type="button"
          className="ove-config-button"
          onClick={() => {
            setDraft({})
            setNote(null)
          }}
          disabled={busy || Object.keys(draft).length === 0}
        >
          {t('config.discard')}
        </button>
      </div>
    </div>
  )
}
