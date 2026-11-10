/**
 * The best-effort local DSH-session → scope map (v0.9 §3.3).
 *
 * A DSH session's conversation memory is captured by the **official memory
 * plugin**, whose connection this cockpit does not own. A scope switch moves
 * only this plugin's read/write target. The dangerous mismatch is therefore:
 * "the conversation is captured on server A, the cockpit is now reading server
 * B" — and the server offers no fact that says which server captured a session.
 *
 * This store is the local, privacy-light mitigation: when a session surface
 * first reads under a scope, the plugin records `{sessionId → scope key,
 * profile label, account/user/peer, observedAt}`. It deliberately records **no
 * bodies, no endpoints, no secrets** — a label and a hash are enough to warn.
 * The map is bounded (LRU over the last `SESSION_SCOPE_MAP_MAX` sessions) and
 * lives at `${DSH_HOME}/state/dsh-openviking-enhance/session-scopes.json`
 * (0600, atomic).
 *
 * It is explicitly best effort: the file may be absent (fresh install), may be
 * cleared, and can be wrong if a session was used under two scopes before the
 * map existed. A missing record means "unknown", never "matches"; the caller
 * renders the generic active-scope banner and relies on the official-plugin
 * connection-facts advisory instead of guessing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionScopeRecord } from '../shared/protocol.ts'
import { SESSION_SCOPE_MAP_MAX } from '../shared/limits.ts'
import { parseJson, pluginStateDir, writePrivateFile } from './plugin-state.ts'

/** Session ids become file keys; DSH ids are opaque but boring. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** The file schema version. */
export const SESSION_SCOPE_MAP_VERSION = 1

interface SessionScopeMapFile {
  version: typeof SESSION_SCOPE_MAP_VERSION
  entries: Record<string, SessionScopeRecord>
}

const EMPTY_MAP: SessionScopeMapFile = { version: SESSION_SCOPE_MAP_VERSION, entries: {} }

/** Validate one record from untrusted JSON; null when it must be dropped. */
function sanitizeRecord(raw: unknown): SessionScopeRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  const scopeKey = typeof record.scopeKey === 'string' ? record.scopeKey.trim() : ''
  if (!SESSION_ID_PATTERN.test(sessionId) || scopeKey.length === 0 || scopeKey.length > 200) return null
  const text = (value: unknown, max = 160): string | null =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null
  // v0.9 round 2 (N5): the endpoint is stored so legacy-mode endpoint changes
  // mismatch. Old files (pre-N5) have no endpoint → null = unknown, tolerated.
  const endpointRaw = text(record.endpoint, 400)
  const endpoint = endpointRaw === null ? null : /^https?:\/\//i.test(endpointRaw) ? endpointRaw.replace(/\/+$/, '') : null
  return {
    sessionId,
    scopeKey,
    profileId: text(record.profileId, 64),
    label: text(record.label, 120),
    account: text(record.account) ?? 'default',
    user: text(record.user) ?? 'default',
    peer: text(record.peer),
    endpoint,
    observedAt:
      typeof record.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.observedAt)
        ? record.observedAt
        : new Date(0).toISOString(),
  }
}

/** Parse the file leniently; a corrupt entry is dropped, not fatal. */
export function parseSessionScopeMap(raw: unknown): { ok: boolean; entries: Map<string, SessionScopeRecord> } {
  const entries = new Map<string, SessionScopeRecord>()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, entries }
  const record = raw as Record<string, unknown>
  if (record.version !== undefined && record.version !== SESSION_SCOPE_MAP_VERSION) return { ok: false, entries }
  const candidate = record.entries
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, entries }
  for (const value of Object.values(candidate as Record<string, unknown>)) {
    const sanitized = sanitizeRecord(value)
    if (sanitized !== null) entries.set(sanitized.sessionId, sanitized)
  }
  return { ok: true, entries }
}

export interface SessionScopeMapOptions {
  /** Override the state directory (tests). */
  dir?: string
  env?: NodeJS.ProcessEnv
  /** Bounded retention (defaults to the documented 64). */
  maxEntries?: number
}

/**
 * The bounded session→scope map.
 *
 * Reads are cheap and rare (a session surface opens), writes happen at most once
 * per session per scope — the caller compares before writing.
 */
export class SessionScopeMap {
  private readonly directory: string
  private readonly maxEntries: number

  constructor(options: SessionScopeMapOptions = {}) {
    this.directory = pluginStateDir(options)
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? SESSION_SCOPE_MAP_MAX))
  }

  /** The absolute path of the map file. */
  get path(): string {
    return join(this.directory, 'session-scopes.json')
  }

  private read(): Map<string, SessionScopeRecord> {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return new Map()
    }
    return parseSessionScopeMap(parseJson(raw)).entries
  }

  /** The recorded scope for one session, or null when never observed. */
  get(sessionId: string): SessionScopeRecord | null {
    const id = sessionId.trim()
    if (!SESSION_ID_PATTERN.test(id)) return null
    return this.read().get(id) ?? null
  }

  /**
   * Record that `sessionId` was observed under this scope.
   *
   * A no-op when the map already holds the same scope key for the session (the
   * common case: every session-surface read would otherwise rewrite the file).
   * Returns whether the file was written.
   */
  record(record: Omit<SessionScopeRecord, 'observedAt'> & { observedAt?: string }): boolean {
    const sanitized = sanitizeRecord({ ...record, observedAt: record.observedAt ?? new Date().toISOString() })
    if (sanitized === null) return false
    const entries = this.read()
    const existing = entries.get(sanitized.sessionId)
    if (existing !== undefined && existing.scopeKey === sanitized.scopeKey) return false
    entries.delete(sanitized.sessionId)
    entries.set(sanitized.sessionId, sanitized)
    // Bounded LRU by observedAt (the file order is not trusted): sort
    // **ascending** (oldest first), drop from the front until the map fits, then
    // rewrite in the same oldest→newest order. A failed write is reported as
    // false so the caller never believes a record was kept.
    const ordered = [...entries.values()].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    while (ordered.length > this.maxEntries) ordered.shift()
    const file: SessionScopeMapFile = {
      version: SESSION_SCOPE_MAP_VERSION,
      entries: Object.fromEntries(ordered.map((entry) => [entry.sessionId, entry])),
    }
    const written = writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
    return written.ok
  }
}
