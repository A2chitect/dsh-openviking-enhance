/**
 * The last active scope, persisted per DSH home.
 *
 * v0.5 kept the active identity only in the volatile runtime Config (plus the
 * `profiles.json` header as a fallback), so a restart forgot it. v0.9's Lead
 * sign-off decision 1 makes the active profile + the in-server identity
 * overrides **DSH-home state**, not DSH-session state:
 *
 * File: `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/scope-state.json`,
 * mode `0600`, written atomically (`plugin-state.ts`).
 *
 * The file deliberately contains **no secret and no endpoint**: the profile id
 * names the credential/server unit (`profiles.json` remains the secret store of
 * record) and the optional account/user/peer overrides are header selectors.
 * A corrupt file is not an activation failure: it falls back to the profile
 * header/legacy resolution and is reported through the existing config-source
 * health surface (`ConfigSourceHealth`), the same v0.6 pattern the Doctor uses
 * for `profiles.json`.
 *
 * Precedence on boot (sign-off decision 1, implemented in `scope-service.ts`):
 *
 *   1. explicit runtime Config `activeProfile` (the existing `.volatile()`
 *      override, kept for compatibility and the settings form);
 *   2. this file's `activeProfileId`;
 *   3. the `profiles.json` header `activeProfileId`;
 *   4. legacy v0.4 connection resolution.
 *
 * Identity overrides come from this file only, and are dropped when the active
 * profile changed since they were written (a profile switch resets them).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigSourceHealth } from '../shared/protocol.ts'
import { SCOPE_STATE_VERSION } from '../shared/limits.ts'
import { isValidPeerId, isValidScopeName } from './profiles.ts'
import { pluginStateDir, writePrivateFile } from './plugin-state.ts'

/** The in-server identity override persisted in the state file. */
export interface ScopeIdentityOverride {
  /** Read-scope account header override, or null for the profile default. */
  account: string | null
  /** Read-scope user header override, or null for the profile default. */
  user: string | null
  /** Peer READ selector, or null for the profile default. */
  peer: string | null
}

/** The on-disk shape; versioned for a future migration. */
export interface ScopeStateFile {
  version: typeof SCOPE_STATE_VERSION
  /** Last active profile id; '' means the legacy resolution. */
  activeProfileId: string
  identity: ScopeIdentityOverride | null
  /** ISO timestamp of the last write (diagnostics only; never trusted). */
  updatedAt: string | null
}

/** The empty state every fallback path uses. */
export function emptyScopeState(): ScopeStateFile {
  return { version: SCOPE_STATE_VERSION, activeProfileId: '', identity: null, updatedAt: null }
}

/** Ids become `profiles.json` keys; keep them boring (mirrors `profiles.ts`). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** One override field: null when unset, the value when valid, undefined when invalid. */
function overrideField(raw: unknown, pattern: (value: string) => boolean): string | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return null
  return pattern(value) ? value : undefined
}

/**
 * Parse the file leniently.
 *
 * Unknown fields are dropped, an invalid profile id degrades to '' (legacy),
 * and invalid override fields are dropped one by one — a hand-mangled state
 * file must never take the memory UI away, and `error` still tells the Doctor
 * the file was wrong.
 */
export function parseScopeState(raw: unknown): { ok: boolean; file: ScopeStateFile; error: string | null } {
  const empty = emptyScopeState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, file: empty, error: 'not-an-object' }
  }
  const record = raw as Record<string, unknown>
  const version = record.version
  if (version !== undefined && version !== SCOPE_STATE_VERSION) {
    return { ok: false, file: empty, error: 'unsupported-version' }
  }
  const activeProfileIdRaw = str(record.activeProfileId)
  const activeProfileId = ID_PATTERN.test(activeProfileIdRaw) ? activeProfileIdRaw : ''
  if (activeProfileIdRaw.length > 0 && activeProfileId === '') {
    return { ok: false, file: empty, error: 'invalid-profile-id' }
  }
  let identity: ScopeIdentityOverride | null = null
  if (record.identity !== undefined && record.identity !== null) {
    if (typeof record.identity !== 'object' || Array.isArray(record.identity)) {
      return { ok: false, file: { ...empty, activeProfileId }, error: 'invalid-identity' }
    }
    const candidate = record.identity as Record<string, unknown>
    const account = overrideField(candidate.account, isValidScopeName)
    const user = overrideField(candidate.user, isValidScopeName)
    const peer = overrideField(candidate.peer, isValidPeerId)
    if (account === undefined || user === undefined || peer === undefined) {
      return { ok: false, file: { ...empty, activeProfileId }, error: 'invalid-fields' }
    }
    identity = account === null && user === null && peer === null ? null : { account, user, peer }
  }
  const updatedAt =
    typeof record.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.updatedAt) ? record.updatedAt : null
  return {
    ok: true,
    file: { version: SCOPE_STATE_VERSION, activeProfileId, identity, updatedAt },
    error: null,
  }
}

/** One resolved state-page answer (the active profile + overrides). */
export interface ScopeStateRead {
  available: boolean
  file: ScopeStateFile
  error: string | null
}

export interface ScopeStateStoreOptions {
  /** Override the state directory (tests). */
  dir?: string
  env?: NodeJS.ProcessEnv
}

/**
 * The state file, read on demand.
 *
 * No in-memory cache: the file is tiny, it may be hand-edited and the settings
 * UI expects a write to be visible on the next read — the same rule as
 * `ProfileStore`.
 */
export class ScopeStateStore {
  private readonly directory: string
  private readonly env: NodeJS.ProcessEnv
  private readonly directoryOverride: string | null

  constructor(options: ScopeStateStoreOptions = {}) {
    this.directory = pluginStateDir(options)
    this.env = options.env ?? process.env
    this.directoryOverride = options.dir !== undefined && options.dir.trim().length > 0 ? options.dir : null
  }

  /** The absolute path of the state file. */
  get path(): string {
    return join(this.directory, 'scope-state.json')
  }

  /** Parse the file as it is now. Missing is the normal fresh-machine case. */
  read(): ScopeStateRead {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return { available: false, file: emptyScopeState(), error: null }
    }
    let parsedRaw: unknown
    try {
      parsedRaw = JSON.parse(raw) as unknown
    } catch {
      // Corrupt JSON is a health item, not a reason to throw or to keep stale
      // overrides: fall back to the documented defaults.
      return { available: false, file: emptyScopeState(), error: 'malformed' }
    }
    const parsed = parseScopeState(parsedRaw)
    return { available: parsed.ok, file: parsed.file, error: parsed.error }
  }

  /**
   * Whether this store's file is readable, and if not, why (the Doctor's
   * config-source health list). Never returns file contents.
   */
  sourceHealth(): ConfigSourceHealth {
    const label = this.directoryOverride !== null
      ? join(this.directoryOverride, 'scope-state.json')
      : `${this.env.DSH_HOME?.trim() ? '$DSH_HOME' : '~/.dsh'}/state/dsh-openviking-enhance/scope-state.json`
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? null
      return {
        source: 'scope-state.json',
        path: label,
        state: code === 'ENOENT' ? 'missing' : code === null ? 'unknown' : 'unreadable',
        errorCode: code,
      }
    }
    let parsedRaw: unknown
    try {
      parsedRaw = JSON.parse(raw) as unknown
    } catch {
      return { source: 'scope-state.json', path: label, state: 'malformed', errorCode: 'InvalidJSON' }
    }
    const parsed = parseScopeState(parsedRaw)
    if (!parsed.ok) {
      return { source: 'scope-state.json', path: label, state: 'wrong-shape', errorCode: parsed.error }
    }
    return { source: 'scope-state.json', path: label, state: 'ok', errorCode: null }
  }

  /**
   * Persist the active profile and its identity overrides (atomic, 0600).
   *
   * Called only on a switch (profile or identity) — never on every read — so a
   * hand-edited file is left alone until a deliberate change replaces it.
   */
  write(activeProfileId: string, identity: ScopeIdentityOverride | null): { ok: boolean; error: string | null } {
    const normalizedId = ID_PATTERN.test(activeProfileId) ? activeProfileId : ''
    const file: ScopeStateFile = {
      version: SCOPE_STATE_VERSION,
      activeProfileId: normalizedId,
      identity:
        identity === null || (identity.account === null && identity.user === null && identity.peer === null)
          ? null
          : {
              account: identity.account !== null && isValidScopeName(identity.account) ? identity.account : null,
              user: identity.user !== null && isValidScopeName(identity.user) ? identity.user : null,
              peer: identity.peer !== null && isValidPeerId(identity.peer) ? identity.peer : null,
            },
      updatedAt: new Date().toISOString(),
    }
    return writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }
}
