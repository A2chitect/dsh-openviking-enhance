/**
 * This plugin's row configuration on the Plugins page.
 *
 * The Plugins page gives a row a **Configure** control only while something
 * registers here, so without this file the plugin's settings existed for the
 * Loader and for agents but not for a person in the GUI: without a registration
 * here the page renders no **Configure** control to open.
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
 *
 * The form has two halves: the connection values the host half reads, and the
 * **interface switches** (`showSidebarEntry` / `showCommitStatus` /
 * `showRecallPanel` / `showRecallExplain` / `showHealthPanel` / `showPreview` /
 * `showExplore` / `enableCommands`). The switches are preferences — the host
 * serves them so this form can persist them, and the browser half applies them
 * live through `ctx.configForms`, so saving one immediately mounts or unmounts
 * the surface without a reload. The one exception is `enableCommands`: its
 * effect is host-side (the `/viking` command registry), so the host half watches
 * the same value and registers/unregisters the command — on the next plugin
 * apply, and live where the Loader emits `loader/volatile-update`.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { configOps, type ConfigOpField } from './config-ops.ts'
import {
  deleteProfileRequest,
  fetchProfiles,
  probeEndpoint,
  saveProfile,
  testProfileEndpoint,
  type ProfileTestResponse,
  type SaveProfileRequest,
} from './host-api.ts'
import type { ProfileSummary } from '../shared/protocol.ts'
import { t, writeErrorText } from './locale.ts'
import { refreshScope } from './scope-store.ts'

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

/**
 * The interface switches, in the order they appear inside the left sidebar, the
 * composer and the right sidebar. Their Config keys match
 * `feature-toggles.ts`'s `FEATURE_CONFIG_FIELDS`, and their values are staged as
 * the strings `'true'`/`'false'` (see `config-ops.ts`).
 */
interface ToggleSpec {
  readonly key: string
  readonly label: string
  readonly hint: string
}

const FEATURE_TOGGLES: readonly ToggleSpec[] = [
  {
    key: 'showSidebarEntry',
    label: 'config.showSidebarEntry',
    hint: 'config.showSidebarEntryHint',
  },
  {
    key: 'showCommitStatus',
    label: 'config.showCommitStatus',
    hint: 'config.showCommitStatusHint',
  },
  {
    key: 'showRecallPanel',
    label: 'config.showRecallPanel',
    hint: 'config.showRecallPanelHint',
  },
  {
    key: 'showRecallExplain',
    label: 'config.showRecallExplain',
    hint: 'config.showRecallExplainHint',
  },
  {
    key: 'showHealthPanel',
    label: 'config.showHealthPanel',
    hint: 'config.showHealthPanelHint',
  },
  {
    key: 'showPreview',
    label: 'config.showPreview',
    hint: 'config.showPreviewHint',
  },
  {
    key: 'showExplore',
    label: 'config.showExplore',
    hint: 'config.showExploreHint',
  },
  {
    key: 'enableCommands',
    label: 'config.enableCommands',
    hint: 'config.enableCommandsHint',
  },
  {
    key: 'enableWrites',
    label: 'config.enableWrites',
    hint: 'config.enableWritesHint',
  },
  {
    key: 'enableOps',
    label: 'config.enableOps',
    hint: 'config.enableOpsHint',
  },
  {
    key: 'enableActivity',
    label: 'config.enableActivity',
    hint: 'config.enableActivityHint',
  },
  {
    key: 'showScopeBanner',
    label: 'config.showScopeBanner',
    hint: 'config.showScopeBannerHint',
  },
  {
    key: 'showScopeSwitcher',
    label: 'config.showScopeSwitcher',
    hint: 'config.showScopeSwitcherHint',
  },
  {
    key: 'showNativeViews',
    label: 'config.showNativeViews',
    hint: 'config.showNativeViewsHint',
  },
  {
    key: 'showOnboarding',
    label: 'config.showOnboarding',
    hint: 'config.showOnboardingHint',
  },
]

/** Every field `configOps` has to understand, text and switches alike. */
const CONFIG_OP_FIELDS: readonly ConfigOpField[] = [
  ...FIELDS.map((field) => ({ key: field.key, numeric: field.numeric === true })),
  ...FEATURE_TOGGLES.map((toggle) => ({ key: toggle.key, boolean: true })),
  // The active profile id is a plain string edited by the profile selector
  // below; it is staged through the same atomic mutate as every other field.
  { key: 'activeProfile' },
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
  /**
   * Decision A: while a named profile is active, the legacy
   * endpoint/apiKey/account/user fields are ignored by the host. The form
   * disables them (and says why) instead of letting an edit look effective.
   */
  const stagedActive = draft['activeProfile']
  const profileActive = stagedActive === undefined ? asText(resolved.activeProfile).length > 0 : stagedActive !== ''

  const valueOf = useCallback(
    (field: FieldSpec): string => draft[field.key] ?? (field.secret && field.key in overrides ? SECRET_PLACEHOLDER : asText(resolved[field.key])),
    [draft, overrides, resolved],
  )

  /**
   * A switch's current state: the staged edit while there is one, else the
   * resolved value. A missing value means on — the schema default, and the
   * plugin's behaviour before these switches existed. An empty staged value is
   * the form's "default" (an `unset`), so it also shows the resolved state.
   */
  const toggleValue = useCallback(
    (toggle: ToggleSpec): boolean => {
      const staged = draft[toggle.key]
      if (staged === 'true') return true
      if (staged === 'false') return false
      return resolved[toggle.key] !== false
    },
    [draft, resolved],
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
    const result = configOps(CONFIG_OP_FIELDS, draft)
    if (!result.ok) {
      const field = [...FIELDS, ...FEATURE_TOGGLES].find((candidate) => candidate.key === result.field)
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
              disabled={!writable || busy || (profileActive && LEGACY_FIELDS.has(field.key))}
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
              disabled={!writable || busy || (profileActive && LEGACY_FIELDS.has(field.key))}
            >
              {t('config.default')}
            </button>
          </span>
          <span className="ove-config-hint">{t(field.hint)}</span>
        </label>
      ))}

      {profileActive && <p className="ove-config-note">{t('config.legacyIgnored')}</p>}

      {/*
        The interface switches are a separate group on purpose: they are saved in
        the same atomic write, but they take effect immediately (the browser half
        observes the settings form), unlike the connection values above.
      */}
      <div className="ove-config-group">
        <span className="ove-config-group-title">{t('config.features')}</span>
        <span className="ove-config-hint">{t('config.featuresHint')}</span>
        {FEATURE_TOGGLES.map((toggle) => (
          <label className="ove-config-toggle" key={toggle.key}>
            <span className="ove-config-toggle-text">
              <span className="ove-config-label">
                {t(toggle.label)}
                {toggle.key in overrides && <span className="ove-config-badge">{t('config.overridden')}</span>}
              </span>
              <span className="ove-config-hint">{t(toggle.hint)}</span>
            </span>
            <span className="ove-config-toggle-control">
              <input
                className="ove-config-check"
                type="checkbox"
                checked={toggleValue(toggle)}
                disabled={!writable || busy}
                onChange={(event) => stage(toggle.key, event.target.checked ? 'true' : 'false')}
              />
              <button
                type="button"
                className="ove-config-button ove-config-button-sm"
                title={t('config.defaultHint')}
                onClick={() => clear(toggle.key)}
                disabled={!writable || busy}
              >
                {t('config.default')}
              </button>
            </span>
          </label>
        ))}
      </div>

      {/*
        F12: the credential/scope profiles. The profile file is the secret store
        of record; this editor lists/labels/tests them and sets the active id
        through the same atomic settings mutate as everything else.
      */}
      <ProfileEditor
        writable={writable}
        busy={busy}
        activeProfileId={stagedActive === undefined ? asText(resolved.activeProfile) : stagedActive}
        onStageActive={(id) => stage('activeProfile', id)}
      />

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


/* ========================================================================
 * F12: the profile editor
 *
 * Small on purpose (the Lead's binding decision keeps it in the existing
 * Plugins-page form rather than a new settings section): list, add, edit,
 * delete, test-connection and pick the active profile. The API key is
 * write-only here — the stored secret is never returned by the host, so the
 * field starts empty with a "configured" placeholder and an empty value keeps
 * the stored key.
 * ===================================================================== */

/** The fields the host ignores while a named profile is active. */
const LEGACY_FIELDS = new Set(['endpoint', 'apiKey', 'account', 'user'])

interface ProfileDraft {
  id: string
  label: string
  endpoint: string
  authMode: string
  apiKey: string
  account: string
  user: string
  peerId: string
}

const EMPTY_PROFILE: ProfileDraft = {
  id: '',
  label: '',
  endpoint: 'http://127.0.0.1:1933',
  authMode: 'dev',
  apiKey: '',
  account: 'default',
  user: 'default',
  peerId: '',
}

const AUTH_MODES = ['dev', 'trusted', 'api_key', 'unknown'] as const

interface ProfileEditorProps {
  writable: boolean
  busy: boolean
  activeProfileId: string
  onStageActive: (id: string) => void
}

function ProfileEditor({ writable, busy, activeProfileId, onStageActive }: ProfileEditorProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null)
  const [storePath, setStorePath] = useState<string | null>(null)
  const [storeError, setStoreError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [editingExisting, setEditingExisting] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [probe, setProbe] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const answer = await fetchProfiles()
    if (answer.ok) {
      setProfiles(answer.profiles.profiles)
      setStorePath(answer.profiles.storePath)
      setStoreError(answer.profiles.storeError)
    } else {
      setStoreError(writeErrorText(answer.error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startAdd = () => {
    setDraft({ ...EMPTY_PROFILE })
    setEditingExisting(false)
    setProbe(null)
    setNote(null)
  }

  const startEdit = (profile: ProfileSummary) => {
    setDraft({
      id: profile.id,
      label: profile.label,
      endpoint: profile.endpoint,
      authMode: profile.authMode,
      // Never render the stored secret; an empty field keeps it on save.
      apiKey: '',
      account: profile.account,
      user: profile.user,
      peerId: profile.peerId ?? '',
    })
    setEditingExisting(true)
    setProbe(null)
    setNote(null)
  }

  const save = async () => {
    if (draft === null) return
    setLocalBusy(true)
    setNote(null)
    try {
      const request: SaveProfileRequest = {
        id: draft.id.trim(),
        label: draft.label.trim(),
        endpoint: draft.endpoint.trim(),
        authMode: draft.authMode,
        account: draft.account.trim(),
        user: draft.user.trim(),
        peerId: draft.peerId.trim(),
        ...(draft.apiKey.length > 0 ? { apiKey: draft.apiKey } : {}),
      }
      const answer = await saveProfile(request)
      if (!answer.ok) {
        setNote({ tone: 'bad', text: writeErrorText(answer.error) })
        return
      }
      setDraft(null)
      setNote({ tone: 'ok', text: t('config.profileSaved') })
      await load()
      await refreshScope()
    } finally {
      setLocalBusy(false)
    }
  }

  const remove = async (id: string) => {
    setDeleteId(null)
    setLocalBusy(true)
    try {
      const answer = await deleteProfileRequest(id)
      if (!answer.ok) setNote({ tone: 'bad', text: writeErrorText(answer.error) })
      else {
        setNote({ tone: 'ok', text: t('config.profileDeleted') })
        await load()
        await refreshScope()
      }
    } finally {
      setLocalBusy(false)
    }
  }

  const test = async () => {
    if (draft === null) return
    setProbe(t('config.checking'))
    const answer = await testProfileEndpoint(draft.endpoint.trim())
    if (!answer.ok) setProbe(writeErrorText(answer.error))
    else if (answer.reachable) setProbe(t('config.probeOk', { version: answer.version ?? t('config.probeVersionUnknown') }))
    else setProbe(t('config.probeFailed', { error: answer.error ?? t('config.unknownError') }))
  }

  const disabled = !writable || busy || localBusy

  return (
    <div className="ove-config-group ove-config-profiles">
      <span className="ove-config-group-title">{t('config.profiles')}</span>
      <span className="ove-config-hint">{t('config.profilesHint')}</span>
      {storePath !== null && <span className="ove-config-hint">{t('config.profilesPath', { path: storePath })}</span>}
      {storeError !== null && <span className="ove-config-hint">{storeError}</span>}

      <label className="ove-config-field">
        <span className="ove-config-label">{t('config.activeProfile')}</span>
        <span className="ove-config-control">
          <select
            className="ove-config-input"
            value={activeProfileId}
            disabled={disabled}
            onChange={(event) => onStageActive(event.target.value)}
          >
            <option value="">{t('config.activeProfileLegacy')}</option>
            {(profiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} ({profile.id})
              </option>
            ))}
          </select>
        </span>
        <span className="ove-config-hint">{t('config.activeProfileHint')}</span>
      </label>

      {profiles === null ? (
        <span className="ove-config-hint">{t('config.loading')}</span>
      ) : profiles.length === 0 ? (
        <span className="ove-config-hint">{t('config.noProfiles')}</span>
      ) : (
        <div className="ove-config-profile-list">
          {profiles.map((profile) => (
            <div className="ove-config-profile-row" key={profile.id}>
              <span className="ove-config-profile-label">
                {profile.label}
                <span className="ove-config-profile-meta">
                  {profile.id} · {profile.endpoint} · {profile.authMode}
                  {profile.hasApiKey ? ` · ${t('config.keyConfigured')}` : ''}
                </span>
              </span>
              <span className="ove-config-profile-actions">
                <button type="button" className="ove-config-button ove-config-button-sm" disabled={disabled} onClick={() => startEdit(profile)}>
                  {t('config.editProfile')}
                </button>
                {deleteId === profile.id ? (
                  <>
                    <button type="button" className="ove-config-button ove-config-button-sm" disabled={disabled} onClick={() => void remove(profile.id)}>
                      {t('config.confirmDelete')}
                    </button>
                    <button type="button" className="ove-config-button ove-config-button-sm" onClick={() => setDeleteId(null)}>
                      {t('config.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ove-config-button ove-config-button-sm"
                    disabled={disabled || profile.id === activeProfileId}
                    title={profile.id === activeProfileId ? t('config.deleteActiveHint') : ''}
                    onClick={() => setDeleteId(profile.id)}
                  >
                    {t('config.deleteProfile')}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {draft === null ? (
        <button type="button" className="ove-config-button" disabled={disabled || (profiles?.length ?? 0) >= 20} onClick={startAdd}>
          {t('config.addProfile')}
        </button>
      ) : (
        <div className="ove-config-profile-form">
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.profileLabel')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.label}
                disabled={disabled || editingExisting}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </span>
            <span className="ove-config-hint">{t('config.profileLabelHint')}</span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.profileId')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.id}
                spellCheck={false}
                disabled={disabled || editingExisting}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </span>
            <span className="ove-config-hint">{t('config.profileIdHint')}</span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.endpoint')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.endpoint}
                spellCheck={false}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              />
              <button type="button" className="ove-config-button" disabled={disabled} onClick={() => void test()}>
                {t('config.check')}
              </button>
            </span>
            <span className="ove-config-hint">{t('config.profileEndpointHint')}</span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.authMode')}</span>
            <span className="ove-config-control">
              <select
                className="ove-config-input"
                value={draft.authMode}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, authMode: event.target.value })}
              >
                {AUTH_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.apiKey')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={editingExisting ? t('config.keyConfigured') : ''}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </span>
            <span className="ove-config-hint">{t('config.profileKeyHint')}</span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.account')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.account}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, account: event.target.value })}
              />
            </span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.user')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.user}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, user: event.target.value })}
              />
            </span>
          </label>
          <label className="ove-config-field">
            <span className="ove-config-label">{t('config.peerId')}</span>
            <span className="ove-config-control">
              <input
                className="ove-config-input"
                value={draft.peerId}
                spellCheck={false}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, peerId: event.target.value })}
              />
            </span>
            <span className="ove-config-hint">{t('config.peerIdHint')}</span>
          </label>
          {probe !== null && <p className="ove-config-note">{probe}</p>}
          {note !== null && <p className={note.tone === 'ok' ? 'ove-config-note' : 'ove-config-error'}>{note.text}</p>}
          <div className="ove-config-actions">
            <button type="button" className="ove-config-primary" disabled={disabled} onClick={() => void save()}>
              {t('config.saveProfile')}
            </button>
            <button type="button" className="ove-config-button" disabled={disabled} onClick={() => setDraft(null)}>
              {t('config.cancel')}
            </button>
          </div>
        </div>
      )}
      {note !== null && draft === null && (
        <p className={note.tone === 'ok' ? 'ove-config-note' : 'ove-config-error'}>{note.text}</p>
      )}
      <p className="ove-config-hint">{t('config.profileWarn')}</p>
    </div>
  )
}
