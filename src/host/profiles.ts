/**
 * F12: the plugin-owned credential/scope profile store.
 *
 * This is the **secret store of record** for v0.5 (Lead sign-off decision A): a
 * named profile carries an endpoint, an auth-mode expectation, an optional API
 * key and an account/user/peer scope. `~/.openviking/ovcli.conf` stays the
 * official plugin's business and is never written by this plugin.
 *
 * File: `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/profiles.json`, mode
 * `0600`, written atomically (see `plugin-state.ts`). The API key is stored only
 * here and is never part of a route payload: `describeProfile()` returns
 * `hasApiKey` instead. A corrupt or missing file degrades to "no profiles" and
 * the plugin keeps the v0.4 connection resolution — a broken settings file must
 * not be able to take the memory UI away.
 *
 * Validation is deliberately strict and silent about dropped input: unknown
 * fields are discarded at load, a bad endpoint or id removes only that profile
 * (with an error in `storeError`), and an empty store is legal.
 */
import { join } from 'node:path'
import type { ProfileSummary, ProfilesPayload } from '../shared/protocol.ts'
import { ensureStateDir, parseJson, pluginStateDir, readFileOrNull, writePrivateFile } from './plugin-state.ts'

/** Auth modes this server family understands; `unknown` means "probe it". */
export const PROFILE_AUTH_MODES = ['dev', 'trusted', 'api_key', 'unknown'] as const
export type ProfileAuthMode = (typeof PROFILE_AUTH_MODES)[number]

/** One stored profile. `apiKey` never leaves the host. */
export interface Profile {
  id: string
  label: string
  endpoint: string
  authMode: ProfileAuthMode
  apiKey: string
  account: string
  user: string
  peerId: string
}

/** The on-disk shape (versioned for a future migration). */
export interface ProfileFile {
  version: 1
  activeProfileId: string
  profiles: Profile[]
}

/** The largest number of profiles a plugin form should carry. */
export const MAX_PROFILES = 20
const DEFAULT_ACCOUNT = 'default'
const DEFAULT_USER = 'default'
/** Ids become file keys and route parameters, so keep them boring. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Account/user names are header values: no whitespace, no separators. */
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/
/** A peer id becomes a path segment; no slashes, no dots-only. */
const PEER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/

/** Whether an endpoint is a usable http(s) origin. */
export function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Normalize an endpoint: trailing slashes removed, no normalization of the host. */
export function normalizeProfileEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** One profile from untrusted JSON, or null when it fails validation. */
export function sanitizeProfile(raw: unknown): Profile | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = str(record.id)
  if (!ID_PATTERN.test(id)) return null
  const label = str(record.label)
  if (label.length === 0 || label.length > 120) return null
  const endpoint = normalizeProfileEndpoint(str(record.endpoint))
  if (!isHttpEndpoint(endpoint)) return null
  const authRaw = str(record.authMode)
  const authMode: ProfileAuthMode =
    (PROFILE_AUTH_MODES as readonly string[]).includes(authRaw) ? (authRaw as ProfileAuthMode) : 'unknown'
  const account = str(record.account)
  const user = str(record.user)
  const peerId = str(record.peerId)
  if (account.length > 0 && !SCOPE_PATTERN.test(account)) return null
  if (user.length > 0 && !SCOPE_PATTERN.test(user)) return null
  if (peerId.length > 0 && !PEER_PATTERN.test(peerId)) return null
  return {
    id,
    label,
    endpoint,
    authMode,
    apiKey: str(record.apiKey),
    account: account.length > 0 ? account : DEFAULT_ACCOUNT,
    user: user.length > 0 ? user : DEFAULT_USER,
    peerId,
  }
}

/** Parse the whole file; unknown fields are dropped, bad profiles are skipped. */
export function parseProfileFile(raw: unknown): { ok: boolean; file: ProfileFile; error: string | null } {
  const empty: ProfileFile = { version: 1, activeProfileId: '', profiles: [] }
  if (raw === null || typeof raw !== 'object') return { ok: false, file: empty, error: 'not-an-object' }
  const record = raw as Record<string, unknown>
  const candidates = Array.isArray(record.profiles) ? record.profiles : null
  if (candidates === null) return { ok: false, file: empty, error: 'profiles-not-an-array' }
  const profiles: Profile[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const candidate of candidates) {
    const profile = sanitizeProfile(candidate)
    if (profile === null || seen.has(profile.id) || profiles.length >= MAX_PROFILES) {
      dropped += 1
      continue
    }
    seen.add(profile.id)
    profiles.push(profile)
  }
  const activeProfileId = str(record.activeProfileId)
  const activeExists = profiles.some((profile) => profile.id === activeProfileId)
  return {
    ok: true,
    file: { version: 1, activeProfileId: activeExists ? activeProfileId : '', profiles },
    error: dropped === 0 ? null : `dropped ${dropped} invalid profile${dropped === 1 ? '' : 's'}`,
  }
}

/** A redacted description: what a route/component is allowed to render. */
export function describeProfile(profile: Profile): ProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    endpoint: profile.endpoint,
    authMode: profile.authMode,
    account: profile.account,
    user: profile.user,
    peerId: profile.peerId.length > 0 ? profile.peerId : null,
    hasApiKey: profile.apiKey.length > 0,
  }
}

/** The canonical identity fingerprint input: no secrets, stable ordering. */
export function fingerprintInput(input: {
  profileId: string | null
  endpoint: string
  authMode: string | null
  account: string
  user: string
  peer: string | null
}): string {
  return JSON.stringify({
    profileId: input.profileId,
    endpoint: input.endpoint,
    authMode: input.authMode,
    account: input.account,
    user: input.user,
    peer: input.peer,
  })
}

/** What a profile write asks for. `apiKey === undefined` keeps the stored secret. */
export interface ProfileInput {
  id: string
  label: string
  endpoint: string
  authMode: string
  apiKey?: string | undefined
  account: string
  user: string
  peerId: string
}

export type ProfileSaveOutcome =
  | { ok: true; profiles: ProfileSummary[] }
  | { ok: false; code: string; message: string }

export type ProfileDeleteOutcome = { ok: true; profiles: ProfileSummary[] } | { ok: false; code: string; message: string }

export interface ProfileStoreOptions {
  /** Override the state directory (tests). */
  dir?: string
  env?: NodeJS.ProcessEnv
}

/**
 * The profile file, read on demand.
 *
 * No in-memory cache: the file is tiny, it may be hand-edited, and the settings
 * form expects a save to be visible on the next read. Reads never throw.
 */
export class ProfileStore {
  private readonly directory: string

  constructor(options: ProfileStoreOptions = {}) {
    this.directory = pluginStateDir(options)
  }

  /** The absolute path of the secret store of record. */
  get path(): string {
    return join(this.directory, 'profiles.json')
  }

  /** Parse the file as it is now. */
  read(): { available: boolean; file: ProfileFile; error: string | null } {
    const raw = readFileOrNull(this.path)
    if (raw === null) return { available: false, file: { version: 1, activeProfileId: '', profiles: [] }, error: null }
    const parsed = parseProfileFile(parseJson(raw))
    return { available: parsed.ok, file: parsed.file, error: parsed.error }
  }

  /** The redacted list + active id for the profile route. */
  describe(): ProfilesPayload {
    const read = this.read()
    return {
      profiles: read.file.profiles.map(describeProfile),
      // The volatile config field is the runtime authority; the file header is
      // the fallback when no config override exists (hand-edited store).
      activeProfileId: read.file.activeProfileId.length > 0 ? read.file.activeProfileId : null,
      storeAvailable: read.available,
      storeError: read.error,
      storePath: this.path,
      warnings: [],
    }
  }

  /** The profile with this id, or null. */
  find(id: string): Profile | null {
    if (id.length === 0) return null
    const read = this.read()
    return read.file.profiles.find((profile) => profile.id === id) ?? null
  }

  /**
   * Create or update one profile.
   *
   * A stored key is replaced only when a non-empty key is supplied; an empty
   * string explicitly clears it (`apiKey: ''`), and an absent field keeps it
   * (the form never re-sends a secret it cannot display).
   */
  save(input: ProfileInput): ProfileSaveOutcome {
    const read = this.read()
    const file = read.file
    const candidate = sanitizeProfile({
      ...input,
      // Existing secret wins unless the caller asked to replace/clear it.
      apiKey:
        input.apiKey === undefined
          ? (file.profiles.find((profile) => profile.id === input.id)?.apiKey ?? '')
          : input.apiKey,
    })
    if (candidate === null) return { ok: false, code: 'invalid-profile', message: 'The profile fields are not valid.' }
    const existingIndex = file.profiles.findIndex((profile) => profile.id === candidate.id)
    if (existingIndex === -1 && file.profiles.length >= MAX_PROFILES) {
      return { ok: false, code: 'too-many-profiles', message: `At most ${MAX_PROFILES} profiles are supported.` }
    }
    const profiles = [...file.profiles]
    if (existingIndex === -1) profiles.push(candidate)
    else profiles[existingIndex] = candidate
    const next: ProfileFile = { version: 1, activeProfileId: file.activeProfileId, profiles }
    const written = this.write(next)
    if (!written.ok) return { ok: false, code: 'write-failed', message: written.error ?? 'Could not write profiles.json' }
    return { ok: true, profiles: profiles.map(describeProfile) }
  }

  /** Delete one profile. Refusing the active one is the caller's job (it owns Config). */
  delete(id: string): ProfileDeleteOutcome {
    const read = this.read()
    const file = read.file
    if (!file.profiles.some((profile) => profile.id === id)) {
      return { ok: false, code: 'profile-not-found', message: 'No profile with that id.' }
    }
    const profiles = file.profiles.filter((profile) => profile.id !== id)
    const activeProfileId = file.activeProfileId === id ? '' : file.activeProfileId
    const written = this.write({ version: 1, activeProfileId, profiles })
    if (!written.ok) return { ok: false, code: 'write-failed', message: written.error ?? 'Could not write profiles.json' }
    return { ok: true, profiles: profiles.map(describeProfile) }
  }

  /** Ensure the private store exists (used by the profile route's first read). */
  ensure(): { ok: boolean; error: string | null } {
    if (readFileOrNull(this.path) !== null) return { ok: true, error: null }
    try {
      ensureStateDir(this.directory)
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private write(file: ProfileFile): { ok: boolean; error: string | null } {
    return writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }
}
