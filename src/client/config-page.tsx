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
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { probeEndpoint } from './host-api.ts'

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
    label: 'OpenViking 地址',
    hint: '留空则读 ~/.openviking/ovcli.conf，再退回 http://127.0.0.1:1933',
    placeholder: 'http://127.0.0.1:1933',
  },
  { key: 'apiKey', label: 'API Key', hint: '服务端开启鉴权时才需要；建议写在 ovcli.conf 里', secret: true },
  { key: 'account', label: 'Account', hint: '留空 = default' },
  { key: 'user', label: 'User', hint: '留空 = default' },
  { key: 'studioPath', label: 'Studio 路径', hint: '默认 /studio/', placeholder: '/studio/' },
  { key: 'cacheTtlMs', label: '状态缓存（毫秒）', hint: '默认 2500', numeric: true, placeholder: '2500' },
  { key: 'recallCacheTtlMs', label: '召回缓存（毫秒）', hint: '默认 15000', numeric: true, placeholder: '15000' },
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
  return <span>{endpoint.length > 0 ? `OpenViking · ${endpoint}` : 'OpenViking · 未配置地址'}</span>
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

  /** Every staged edit as one atomic operation list. */
  const operations = (): SettingsPathOpView[] | string => {
    const ops: SettingsPathOpView[] = []
    for (const [key, staged] of Object.entries(draft)) {
      const field = FIELDS.find((candidate) => candidate.key === key)
      if (field === undefined) continue
      if (staged.length === 0) {
        ops.push({ op: 'unset', path: [key] })
        continue
      }
      if (field.numeric === true) {
        const parsed = Number(staged)
        if (!Number.isFinite(parsed)) return `${field.label} 需要一个数字`
        ops.push({ op: 'set', path: [key], value: parsed })
        continue
      }
      ops.push({ op: 'set', path: [key], value: staged })
    }
    return ops
  }

  const save = async () => {
    if (form === undefined) return
    const ops = operations()
    if (typeof ops === 'string') {
      setNote({ tone: 'bad', text: ops })
      return
    }
    if (ops.length === 0) {
      setNote({ tone: 'ok', text: '没有改动。' })
      return
    }
    setBusy(true)
    try {
      // The revision read with the snapshot is the fence: a write against a
      // namespace someone else changed comes back false, and the draft stays.
      const accepted = await form.mutate(ops, state?.revision)
      if (accepted) {
        setDraft({})
        setNote({ tone: 'ok', text: '已保存。宿主会在下一次组合时用上新值。' })
      } else {
        setNote({ tone: 'bad', text: '宿主拒绝了这次修改（可能已被别处改动），你的改动还留在表单里。' })
      }
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    const candidate = valueOf(FIELDS[0] as FieldSpec).trim()
    setProbe('检测中…')
    const answer = await probeEndpoint(candidate)
    if (!answer.ok) setProbe(answer.error)
    else if (answer.reachable) setProbe(`连上了：OpenViking ${answer.version ?? '(版本未知)'}`)
    else setProbe(`连不上：${answer.error ?? '未知错误'}`)
  }

  if (state === undefined || state.status === 'loading') {
    return <p className="ove-config-note">正在读取配置…</p>
  }
  if (state.status === 'unavailable') {
    return (
      <p className="ove-config-note">
        这个部署没有把本插件的配置暴露给客户端（远程 Web 或未挂载 settings），请在 profile 的 cordis.patch.yml 里配置。
      </p>
    )
  }

  return (
    <div className="ove-config">
      {!writable && <p className="ove-config-note">当前 profile 不接受写入，下面只能查看。</p>}
      {FIELDS.map((field) => (
        <label className="ove-config-field" key={field.key}>
          <span className="ove-config-label">
            {field.label}
            {field.key in overrides && <span className="ove-config-badge">已覆盖</span>}
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
                检测
              </button>
            )}
            <button
              type="button"
              className="ove-config-button"
              title="清空该字段，恢复为默认"
              onClick={() => clear(field.key)}
              disabled={!writable || busy}
            >
              默认
            </button>
          </span>
          <span className="ove-config-hint">{field.hint}</span>
        </label>
      ))}

      {probe !== null && <p className="ove-config-note">{probe}</p>}
      {note !== null && (
        <p className={note.tone === 'ok' ? 'ove-config-note' : 'ove-config-error'}>{note.text}</p>
      )}

      <div className="ove-config-actions">
        <button type="button" className="ove-config-primary" onClick={() => void save()} disabled={!writable || busy}>
          保存
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
          放弃改动
        </button>
      </div>
    </div>
  )
}
