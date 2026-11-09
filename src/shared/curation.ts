/**
 * The writable-target allowlist for v0.5 curation — Lead sign-off decision D.
 *
 * Only **memory bodies** may be edited, deleted or re-tagged:
 *
 *   viking://user/<user>/memories/{entities,events,preferences}/<file>
 *   viking://user/<user>/peers/<peer>/memories/{entities,events,preferences}/<file>
 *
 * Everything else stays read-only in this version, and the exclusions are
 * positive checks rather than a comment:
 *
 *  - generated sidecars (`.abstract.md`, `.overview.md`, `.relations*`, any
 *    dot-file) are excluded because regenerating them is the server's job;
 *  - `rules` is a different lifecycle with no public revert API;
 *  - `sessions/history`, resources, skills and the root `profile.md` /
 *    `identity.md` / `soul.md` files are excluded per the sign-off (the
 *    recommendation in the design brief to allow the personal files was NOT
 *    adopted — the binding text lists them as excluded);
 *  - only text extensions are accepted, because the write API only creates
 *    those and a binary overwrite cannot be reviewed.
 *
 * This module is shared by both halves on purpose: the host enforces the
 * allowlist (it is the security boundary), and the client uses the same
 * function to decide whether to render the action bar at all. One authority
 * means the UI can never offer an action the host will refuse.
 */

/** A target that passed the allowlist. */
export interface CuratableTarget {
  /** The normalized `viking://` URI (no trailing slash, no duplicate separators). */
  uri: string
  /** Last path segment, e.g. `tools.md` — the typed-delete confirmation word. */
  fileName: string
  /** The memory subtree the file lives under. */
  memoryKind: 'entities' | 'events' | 'preferences'
  /** The containing directory: the snapshot/restore scope. */
  parentUri: string
}

/** The three writable memory subtrees (decision D). */
export const CURATABLE_MEMORY_KINDS = ['entities', 'events', 'preferences'] as const

/**
 * Extensions the public write API can create (docs/api-v05.md §2.1). Updating an
 * existing file with another extension is refused as well: a memory body the
 * preview cannot show as text is not reviewable before a destructive action.
 */
export const CURATABLE_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml'] as const

/** Names that are generated or owned by another lifecycle. */
function isExcludedFileName(name: string): boolean {
  if (name.startsWith('.')) return true
  const lower = name.toLowerCase()
  return lower === 'profile.md' || lower === 'identity.md' || lower === 'soul.md'
}

/** A stable code the UI/host can put in an error envelope. */
export type CuratableRefusal =
  | 'not-a-viking-path'
  | 'not-a-memory-path'
  | 'memory-kind-not-curatable'
  | 'not-a-file'
  | 'non-text-extension'
  | 'sidecar-or-protected-file'
  | 'unsafe-path'

/**
 * Normalize a candidate URI, or null when it is not a plain `viking://` path.
 *
 * Rejects dot segments, empty segments, query/fragment characters and
 * whitespace: a path that can be re-interpreted after normalization must never
 * reach a write, and the server would resolve `a/../b` differently than the
 * preview did.
 */
export function normalizeVikingUri(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('viking://')) return null
  if (/[\s?#]/.test(trimmed)) return null
  const body = trimmed.slice('viking://'.length)
  if (body.length === 0) return null
  const segments = body.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null
  if (segments[0] !== 'user') return null
  return `viking://${segments.join('/')}`
}

/** Everything up to (not including) the last segment. */
export function parentUriOf(uri: string): string {
  const index = uri.lastIndexOf('/')
  return index <= 'viking://'.length ? uri : uri.slice(0, index)
}

/** The last segment of a URI. */
export function fileNameOf(uri: string): string {
  const index = uri.lastIndexOf('/')
  return index === -1 ? uri : uri.slice(index + 1)
}

/**
 * Read one candidate as a writable memory target.
 *
 * Returns the parsed target or a stable refusal code — never a throw. The host
 * keeps the detail for the client's localized copy; the refusal code is the
 * contract (the design names `target-not-curatable` as the error code and this
 * is the reason inside it).
 */
export function classifyCuratableUri(raw: string): { ok: true; target: CuratableTarget } | { ok: false; reason: CuratableRefusal } {
  const uri = normalizeVikingUri(raw)
  if (uri === null) return { ok: false, reason: raw.trim().startsWith('viking://') ? 'unsafe-path' : 'not-a-viking-path' }
  const segments = uri.slice('viking://'.length).split('/')
  const user = segments[1]
  if (segments.length < 2 || user === undefined || user.length === 0) return { ok: false, reason: 'not-a-memory-path' }

  // Two shapes are legal: the user's own memory tree, and one visible peer's.
  let memoriesIndex: number
  if (segments[2] === 'memories') {
    memoriesIndex = 2
  } else if (segments[2] === 'peers' && typeof segments[4] === 'string' && segments[4] === 'memories') {
    // segments: user, <u>, peers, <peer>, memories, <kind>, …
    memoriesIndex = 4
  } else {
    return { ok: false, reason: 'not-a-memory-path' }
  }

  const kind = segments[memoriesIndex + 1]
  if (kind !== 'entities' && kind !== 'events' && kind !== 'preferences') {
    return { ok: false, reason: 'memory-kind-not-curatable' }
  }
  const rest = segments.slice(memoriesIndex + 2)
  if (rest.length === 0) return { ok: false, reason: 'not-a-file' }
  const fileName = rest[rest.length - 1] as string
  if (isExcludedFileName(fileName)) return { ok: false, reason: 'sidecar-or-protected-file' }
  const dot = fileName.lastIndexOf('.')
  const extension = dot === -1 ? '' : fileName.slice(dot).toLowerCase()
  if (!(CURATABLE_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, reason: 'non-text-extension' }
  }
  return {
    ok: true,
    target: {
      uri,
      fileName,
      memoryKind: kind,
      parentUri: parentUriOf(uri),
    },
  }
}

/** Convenience for the client's action bar: does this URI pass decision D? */
export function isCuratableUri(raw: string): boolean {
  return classifyCuratableUri(raw).ok
}

/** The snapshot commit scope for one action: the file for a delete, else its directory. */
export function snapshotPathsFor(action: 'edit-memory' | 'delete-memory' | 'set-tags', target: CuratableTarget): string[] {
  // Deletions are recorded by naming the file itself; an existing directory
  // expands recursively and would snapshot unrelated siblings for a single file.
  return action === 'delete-memory' ? [target.uri] : [target.parentUri]
}

/** The restore scope for an undo: always the containing directory (file restore is unverified). */
export function restoreScopeFor(target: CuratableTarget): string {
  return target.parentUri
}

/* ---- the tag grammar the host and the tags editor share ------------------ */

/**
 * The tag grammar: `key=value`, no spaces (docs/api-v05.md §2.5).
 *
 * Shared so the editor refuses an invalid chip before any request, and the host
 * refuses it again before `content/set_tags` — one authority, two enforcement
 * points.
 */
export const TAG_GRAMMAR = 'key=value'
export const TAG_PATTERN = /^[A-Za-z0-9_.-]+=.+$/
export const TAG_MAX = 32
export const TAG_MAX_CHARS = 128

export type TagValidation = { ok: true; tag: string } | { ok: false; reason: 'empty' | 'grammar' | 'too-long' }

/** Validate one tag string; the host also dedupes and caps list length. */
export function validateTagInput(input: string): TagValidation {
  const tag = input.trim()
  if (tag.length === 0) return { ok: false, reason: 'empty' }
  if (tag.length > TAG_MAX_CHARS) return { ok: false, reason: 'too-long' }
  if (!TAG_PATTERN.test(tag)) return { ok: false, reason: 'grammar' }
  return { ok: true, tag }
}
