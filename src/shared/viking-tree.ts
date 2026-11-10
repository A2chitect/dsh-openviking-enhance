/**
 * Pure `viking://` path classification shared by both halves.
 *
 * The native Browse view and the host services must agree on what an entry *is*
 * (icon, scope badge, read-only marker) and on which URIs may be read at all.
 * Keeping that judgement here — with no Node and no React imports — is what makes
 * it unit-testable and impossible for the two halves to drift.
 *
 * The server itself reports `isDir`, `size` and `modTime`; it does NOT report a
 * semantic kind. Everything below is derived from the path shape only, which is
 * a documented part of the OpenViking layout (`viking://user/<user>/memories…`,
 * `viking://resources…`, `viking://agent/skills…`, sessions under
 * `viking://user/<user>/sessions/<ov-session-id>/…`).
 */
import type { BrowseEntryKind, BrowseRootId } from './protocol.ts'

/** The broad ownership scope a URI lives in, for labels and cache keys. */
export type VikingScope = 'user' | 'peer' | 'account' | 'agent' | 'session' | 'unknown'

/** Everything the tree row needs to know about one path. */
export interface VikingUriFacts {
  /** The normalized URI this was derived from (no trailing slash). */
  uri: string
  /** Last path segment; empty for `viking://` itself. */
  tail: string
  /**
   * The semantic kind of the *leaf* at this path. For a directory the caller
   * should prefer {@link browseEntryKind}, which maps directories to
   * `directory`/`session`/`archive`/`agent` instead.
   */
  kind: BrowseEntryKind
  scope: VikingScope
  /** Which configured root this URI belongs under, when it belongs to one. */
  rootId: BrowseRootId | null
}

/** Longest URI the browse tree accepts; longer than any real path, still bounded. */
export const BROWSE_URI_MAX_CHARS = 4096

/** Top-level `viking://` scopes this plugin will never browse or read. */
const INTERNAL_SCOPES = new Set(['queue', 'temp', 'system', 'upload', 'session', 'sessions', 'trash'])

/** A path segment that could escape the tree. */
function hasUnsafeSegment(value: string): boolean {
  if (value.includes('\\')) return true
  if (value.includes('?' ) || value.includes('#')) return true
  return value.split('/').some((segment) => segment === '..' || segment === '.')
}

/** Whether a string names a `viking://` path (same rule as the preview service). */
export function isVikingUri(uri: string): boolean {
  return /^viking:\/\/\S/.test((uri ?? '').trim())
}

/**
 * Normalize a `viking://` URI: trim, collapse duplicate slashes, drop a trailing
 * slash. Anything that is not a viking URI is returned trimmed and unchanged.
 */
export function normalizeVikingUri(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed.startsWith('viking://')) return trimmed
  const rest = trimmed.slice('viking://'.length).replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return rest.length === 0 ? 'viking://' : `viking://${rest}`
}

/** Path segments after `viking://`. */
export function vikingSegments(uri: string): string[] {
  const normalized = normalizeVikingUri(uri)
  if (normalized === 'viking://') return []
  return normalized.slice('viking://'.length).split('/')
}

/** The last path segment, for a row label. */
export function tailOf(uri: string): string {
  const segments = vikingSegments(uri)
  return segments.length === 0 ? '' : (segments[segments.length - 1] ?? '')
}

/** A URI is a plain `viking://` path with no query/fragment/whitespace/escapes. */
function isCanonical(uri: string): boolean {
  const trimmed = (uri ?? '').trim()
  if (trimmed.length === 0 || trimmed.length > BROWSE_URI_MAX_CHARS) return false
  if (/[?#\s]/.test(trimmed)) return false
  if (hasUnsafeSegment(trimmed.slice('viking://'.length))) return false
  return true
}

/**
 * Which top-level families the Browse view may read.
 *
 * `user` is the personal tree (memories, peers, resources, skills, sessions),
 * `resources` is the account-shared resource tree and `agent` is the account's
 * shared skill tree. Everything else is either an internal server scratch area
 * or something this read-only release has no business listing.
 *
 * `options.user`, when given, pins the personal tree to the **active identity**:
 * `viking://user/<other-user>/…` is refused, so a crafted query string cannot
 * turn the read-only cockpit into a cross-user reader. The account-shared trees
 * (`viking://resources`, `viking://agent/skills`) stay readable at account
 * level; a profile switch changes which user tree is addressable.
 */
export interface BrowseAllowlistOptions {
  /** The active identity's user; omitted = structural allowlist only. */
  user?: string
}

export function isAllowedBrowseUri(uri: string, options: BrowseAllowlistOptions = {}): boolean {
  const trimmed = (uri ?? '').trim()
  if (!isVikingUri(trimmed) || !isCanonical(trimmed)) return false
  const segments = vikingSegments(trimmed)
  const top = segments[0]
  if (top === undefined) return false
  if (INTERNAL_SCOPES.has(top)) return false
  if (top === 'resources' || top === 'agent') return true
  if (top !== 'user') return false
  if (options.user === undefined) return true
  const owner = segments[1]
  return typeof owner === 'string' && owner.length > 0 && owner === options.user
}

/** Whether the URI is the top-level shared resources tree. */
function isSharedResources(segments: readonly string[]): boolean {
  return segments[0] === 'resources'
}

/** The root id a path belongs to, if it is under one of the configured roots. */
function rootIdOf(segments: readonly string[]): BrowseRootId | null {
  const [top, a, b, c, d, e] = segments
  if (top === 'resources') return 'resources'
  if (top === 'agent' && a === 'skills') return 'agentSkills'
  if (top !== 'user' || typeof a !== 'string') return null
  // `viking://user/<user>/...`
  const section = b
  if (section === 'memories') return c === 'rules' ? 'rules' : 'memories'
  if (section === 'peers') return 'peers'
  if (section === 'resources') return 'myResources'
  if (section === 'skills') return 'skills'
  if (section === 'sessions') return 'sessions'
  return null
}

/** The scope a path lives in, for labels and read-only badges. */
function scopeOf(segments: readonly string[]): VikingScope {
  const [top, , section] = segments
  if (top === 'resources') return 'account'
  if (top === 'agent') return 'agent'
  if (top === 'user') {
    if (section === 'peers') return 'peer'
    if (section === 'sessions') return 'session'
    return 'user'
  }
  return 'unknown'
}

/**
 * The semantic kind of a leaf path.
 *
 * The caller has the server's `isDir`; a directory is reported by
 * {@link browseEntryKind} as a directory (or a session/archive/agent node, which
 * are directories with a meaning). This function therefore describes what the
 * path names when it is a file, and stays a best-effort hint for directories.
 */
function kindOf(segments: readonly string[]): BrowseEntryKind {
  const [top, a, b, c, d, e] = segments
  if (top === 'resources') return 'resource'
  if (top === 'agent') return a === 'skills' ? 'skill' : 'unknown'
  if (top !== 'user') return 'unknown'
  if (b === 'memories') {
    if (c === 'rules') return 'rule'
    return 'memory'
  }
  if (b === 'resources') return 'resource'
  if (b === 'skills') return 'skill'
  if (b === 'sessions') {
    // Segments: user / <u> / sessions / <ov id> / history / archive_00N.
    // `…/sessions/<id>` is a session; `…/history/archive_00N` is an archive;
    // `…/history` itself and files below are plain paths.
    if (segments.length === 4) return 'session'
    if (segments[4] === 'history' && (segments[5] ?? '').startsWith('archive_')) return 'archive'
    return 'file'
  }
  if (b === 'peers') {
    // A peer's own tree repeats the user tree's sections; a peer node itself is
    // the agent entry. Segments: user / <u> / peers / <peer> / <section> / …
    if (d === 'memories') return e === 'rules' ? 'rule' : 'memory'
    if (d === 'resources') return 'resource'
    if (d === 'skills') return 'skill'
    return 'agent'
  }
  return 'file'
}

/**
 * Classify one `viking://` path.
 *
 * Never throws: anything that is not a canonical viking path classifies as
 * `{ kind: 'unknown', scope: 'unknown', rootId: null }` so a caller rendering a
 * tree row cannot crash on malformed server data.
 */
export function classifyVikingUri(uri: string): VikingUriFacts {
  const normalized = normalizeVikingUri(uri)
  if (!isVikingUri(normalized) || !isCanonical(normalized)) {
    return { uri: normalized, tail: tailOf(normalized), kind: 'unknown', scope: 'unknown', rootId: null }
  }
  const segments = vikingSegments(normalized)
  return {
    uri: normalized,
    tail: segments.length === 0 ? '' : (segments[segments.length - 1] as string),
    kind: kindOf(segments),
    scope: scopeOf(segments),
    rootId: rootIdOf(segments),
  }
}

/**
 * The row kind for a real directory entry: directories keep a meaning only where
 * the tree model has one (sessions, archives, peer agents); everything else is a
 * plain expandable directory.
 */
export function browseEntryKind(uri: string, isDir: boolean): BrowseEntryKind {
  if (!isDir) return classifyVikingUri(uri).kind
  const segments = vikingSegments(normalizeVikingUri(uri))
  const [top, , section, sessionOrDir, fourth, fifth] = segments
  if (top === 'user' && section === 'sessions') {
    // `…/sessions/<id>` is a session; `…/sessions/<id>/history` is a plain
    // directory and `…/sessions/<id>/history/archive_00N` is an archive.
    if (segments.length === 4 && sessionOrDir !== undefined) return 'session'
    if (segments.length === 6 && fourth === 'history' && fifth?.startsWith('archive_') === true) return 'archive'
    return 'directory'
  }
  if (top === 'user' && section === 'peers' && segments.length === 4) return 'agent'
  return 'directory'
}

/** Whether a browse row is a shortcut row (opens another view instead of expanding). */
export function isShortcutRoot(rootId: BrowseRootId): boolean {
  return rootId === 'rules' || rootId === 'sessions'
}

/** How a session directory name maps to the harness that created it. */
export type SessionKind = 'dsh' | 'local' | 'other'

/**
 * Which harness owns a server session id.
 *
 * OpenViking session keys are the memory plugin's `dsh-<dsh session id>` in this
 * deployment; `local-*` is the documented other-local-harness prefix; anything
 * else is shown generically rather than guessed at.
 */
export function sessionKindOf(ovSessionId: string): SessionKind {
  const id = (ovSessionId ?? '').trim()
  if (id.startsWith('dsh-')) return 'dsh'
  if (id.startsWith('local-')) return 'local'
  return 'other'
}

/**
 * The DSH session id behind an OpenViking session key, or null when the key does
 * not name one this plugin can address.
 *
 * `/session-log` and `/commits` are keyed by the DSH session id (the host maps it
 * back through `CommitService.ovSessionId`). A `local-*` session belongs to
 * another harness, and calling those routes with an invented id would make the
 * server look empty — null is the honest answer.
 */
export function dshSessionIdOf(ovSessionId: string): string | null {
  const id = (ovSessionId ?? '').trim()
  if (id.startsWith('dsh-') && id.length > 'dsh-'.length) return id.slice('dsh-'.length)
  return null
}

/** The OpenViking session key for a DSH session id (the inverse of the above). */
export function ovSessionIdOf(sessionId: string): string {
  const id = (sessionId ?? '').trim()
  return id.startsWith('dsh-') ? id : `dsh-${id}`
}
