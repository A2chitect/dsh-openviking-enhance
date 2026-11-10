/**
 * v0.8 "Operate": the snapshot read surfaces + the restore/create safety rules.
 *
 * Everything here is read-only against OpenViking except the three explicit
 * helpers the shared `OpsService` calls after a confirmed action:
 * `commitSnapshot`, `dryRunRestore`, `applyRestore` and the file-version CAS
 * restore. Those are deliberately *not* reachable from any route of their own:
 * the only caller is the ops protocol, which owns the gates, token and audit.
 *
 * Why the scope checks live here rather than in the client:
 *
 *  - snapshot restore is a *directory* mutation; a client cannot be trusted to
 *    decide which directories are safe. Sessions are pipeline-owned
 *    (`messages.jsonl`, archive markers) and restoring them can corrupt capture,
 *    so `viking://user/*\/sessions/**` is refused even though the server allows
 *    it (design §3.3 / §14.6);
 *  - the creates/restores always send `paths` (non-ROOT servers require them,
 *    and on ROOT one bounded scope keeps the blast radius visible in the dialog);
 *  - every refusal carries a stable code so the client localizes it instead of
 *    showing a server body.
 */
import {
  SNAPSHOT_DIFF_MAX_CHARS,
  SNAPSHOT_MESSAGE_MAX_CHARS,
  SNAPSHOT_PATHS_MAX,
  SNAPSHOT_SHOW_MAX_BYTES,
} from '../shared/limits.ts'
import type {
  DiffPathsPayload,
  FileVersionRow,
  FileVersionsPayload,
  PluginNotice,
  SnapshotCommit,
  SnapshotDiffPayload,
  SnapshotIgnorePayload,
  SnapshotLogPayload,
  SnapshotShowPayload,
} from '../shared/protocol.ts'
import type { OpenVikingApi } from './openviking-api.ts'

/** A scope refusal: a stable code plus the human-readable explanation. */
export interface ScopeRefusal {
  code: string
  message: string
}

/** One path as the snapshot history/diff routes send it. */
export type SnapshotScopeKind = 'commit' | 'restore' | 'pack' | 'compile'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Strip the trailing slash the server strips; never normalizes `..` away. */
function trimUri(uri: string): string {
  return uri.trim().replace(/\/+$/, '')
}

/**
 * Validate one snapshot/path scope URI for the operation `kind`.
 *
 * Rules (design §3.2/§3.3/§4.2/§5.1):
 *  - must be a `viking://` URI with a non-empty scope;
 *  - no `_system`, no root-only bare `viking://`, no query/fragment/control chars,
 *    no `.`/`..` segments;
 *  - restore/commit: own-user subtrees, `viking://resources/**`,
 *    `viking://agent/skills/**` (restore), `viking://agent/**` (commit);
 *  - sessions are refused for every mutating kind;
 *  - pack export: `viking://resources/**` or `viking://user/**` only.
 */
export function classifySnapshotScope(
  raw: string,
  kind: SnapshotScopeKind,
  activeUser: string,
): { ok: true; uri: string } | { ok: false; refusal: ScopeRefusal } {
  const uri = trimUri(raw)
  const refuse = (code: string, message: string): { ok: false; refusal: ScopeRefusal } => ({
    ok: false,
    refusal: { code, message },
  })
  if (uri.length === 0) return refuse('invalid-scope', 'A viking:// scope is required.')
  if (CONTROL_CHARS.test(uri)) return refuse('invalid-scope', 'The scope contains control characters.')
  if (uri.includes('?') || uri.includes('#')) return refuse('invalid-scope', 'The scope must not contain a query or fragment.')
  if (!uri.startsWith('viking://')) return refuse('invalid-scope', 'The scope must be a viking:// URI.')
  const parts = uri.slice('viking://'.length).split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return refuse('invalid-scope', 'The viking:// root cannot be an operation scope.')
  if (parts.some((part) => part === '.' || part === '..')) return refuse('invalid-scope', 'The scope must not contain . or .. segments.')
  if (parts.includes('_system')) return refuse('invalid-scope', 'The internal _system scope is not an operation scope.')
  // B2: `parts` tolerates empty segments (`viking://user//alice`, `viking:///user/alice`),
  // so every SAFETY comparison and every value sent downstream must use the
  // canonical form. Comparing the raw string while validating the normalized
  // segments is exactly how the sessions ancestor rule was bypassed.
  const canonical = `viking://${parts.join('/')}`
  const scope = parts[0] as string
  const rest = parts.slice(1)
  if (kind === 'pack') {
    // v0.8 review S2: a pack is full user data (it includes the session
    // transcripts). Export only the ACTIVE user's own tree, never the bare
    // `viking://user` root and never another identity's tree.
    if (scope === 'user') {
      const user = rest[0] ?? ''
      if (user.length === 0) {
        return refuse('invalid-scope', 'Name the active user scope (viking://user/<user>); the bare viking://user tree is not exportable.')
      }
      if (user !== activeUser) {
        return refuse('invalid-scope', `That user scope is not the active identity (${activeUser}).`)
      }
    } else if (scope !== 'resources') {
      return refuse('invalid-scope', 'OVPack export supports viking://resources/** and the active user tree only.')
    }
  } else if (scope === 'user') {
    const user = rest[0] ?? ''
    if (user.length === 0) return refuse('invalid-scope', 'Name the user subtree, not viking://user.')
    if (user !== activeUser) {
      return refuse('invalid-scope', `That user scope is not the active identity (${activeUser}).`)
    }
    // B1: sessions are pipeline-owned, and a scope that CONTAINS the sessions
    // directory is just as dangerous as the directory itself (restoring the
    // whole `viking://user/<me>` would rewrite sessions/** and corrupt capture).
    // Refuse the sessions tree, its descendants, and every ancestor of it.
    const sessions = `viking://user/${user}/sessions`
    if (
      canonical === sessions ||
      canonical.startsWith(`${sessions}/`) ||
      sessions.startsWith(`${canonical}/`)
    ) {
      return refuse(
        'restore-scope-refused',
        'Sessions are pipeline-owned: a restore/commit scope may not be, contain, or be contained by the sessions directory.',
      )
    }
  } else if (scope === 'agent') {
    // Commit allows agent-scope reads (documented); restore only agent skills.
    if (kind === 'restore' && rest[0] !== 'skills') {
      return refuse('restore-scope-refused', 'Only viking://agent/skills/** may be restored.')
    }
    if (kind === 'compile' && rest[0] !== 'skills') {
      return refuse('invalid-scope', 'A compile target may live under viking://agent/skills/** only.')
    }
  } else if (scope !== 'resources') {
    return refuse('invalid-scope', `The viking://${scope}/ scope is not an operation scope.`)
  }
  if (kind === 'restore' && parts.length < 2) {
    return refuse('restore-scope-refused', 'A restore needs a concrete directory scope, not the whole tree.')
  }
  // The canonical form is the contract downstream: plan.projectDir, the audit
  // snapshot columns, the typed word and the undo handle all carry this exact
  // string, so support can tell what the server actually restored.
  return { ok: true, uri: canonical }
}

/** Validate a bounded path list (commit paths / diff-path filter). */
export function classifySnapshotPaths(
  inputs: unknown,
  kind: SnapshotScopeKind,
  activeUser: string,
): { ok: true; paths: string[] } | { ok: false; refusal: ScopeRefusal } {
  if (!Array.isArray(inputs)) return { ok: false, refusal: { code: 'invalid-scope', message: 'paths must be an array.' } }
  if (inputs.length === 0) return { ok: false, refusal: { code: 'invalid-scope', message: 'At least one path is required.' } }
  if (inputs.length > SNAPSHOT_PATHS_MAX) {
    return { ok: false, refusal: { code: 'invalid-scope', message: `At most ${SNAPSHOT_PATHS_MAX} paths are allowed.` } }
  }
  const paths: string[] = []
  for (const entry of inputs) {
    if (typeof entry !== 'string') return { ok: false, refusal: { code: 'invalid-scope', message: 'Every path must be a string.' } }
    const classified = classifySnapshotScope(entry, kind, activeUser)
    if (!classified.ok) return classified
    if (!paths.includes(classified.uri)) paths.push(classified.uri)
  }
  return { ok: true, paths }
}

/** The directory leaf name a typed confirmation requires (never a URI). */
export function leafName(uri: string): string {
  const trimmed = trimUri(uri)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** A commit as the UI shows it: message capped to one display-safe line. */
export function mapSnapshotCommit(raw: {
  oid?: string
  parents?: string[]
  author?: { name?: string; time_seconds?: number }
  committer?: { time_seconds?: number }
  message?: string
}): SnapshotCommit {
  const message = (raw.message ?? '').split(/\r?\n/)[0] ?? ''
  return {
    oid: raw.oid ?? '',
    parents: Array.isArray(raw.parents) ? raw.parents.filter((parent): parent is string => typeof parent === 'string') : [],
    authorName: typeof raw.author?.name === 'string' ? raw.author.name : null,
    authoredAt: typeof raw.author?.time_seconds === 'number' ? raw.author.time_seconds : null,
    committedAt:
      typeof raw.committer?.time_seconds === 'number'
        ? new Date(raw.committer.time_seconds * 1000).toISOString()
        : typeof raw.author?.time_seconds === 'number'
          ? new Date(raw.author.time_seconds * 1000).toISOString()
          : null,
    message: message.length > SNAPSHOT_MESSAGE_MAX_CHARS ? `${message.slice(0, SNAPSHOT_MESSAGE_MAX_CHARS - 1)}…` : message,
  }
}

/** Detect text vs binary well enough for a read-only preview (NUL/control ratio). */
export function classifyPreviewContent(bytes: Uint8Array): 'text' | 'binary' {
  if (bytes.byteLength === 0) return 'text'
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return 'binary'
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / sample.byteLength > 0.1 ? 'binary' : 'text'
}

/** What a 404 on a snapshot route means, by the server's own error details. */
export function snapshotFailureNote(
  status: number,
  errorCode: string | null | undefined,
  errorDetails: unknown,
): { note: string; unavailable: boolean } {
  const details = errorDetails !== null && typeof errorDetails === 'object' ? (errorDetails as { type?: unknown }) : null
  const detailType = typeof details?.type === 'string' ? details.type : null
  if (status === 404 && (detailType === 'git_ref' || detailType === 'git_blob')) {
    return { note: detailType === 'git_blob' ? 'blob-not-found' : 'no-snapshot-history', unavailable: false }
  }
  if (status === 403 || status === 401) return { note: 'forbidden', unavailable: false }
  if (status === 404) return { note: 'snapshot-unavailable', unavailable: true }
  if (status === 400 || status === 422) {
    // A present route validating our arguments: for `versions` this is the
    // documented NOT_COMPILE_MANAGED answer.
    if (errorCode === 'FAILED_PRECONDITION') return { note: 'not-compile-managed', unavailable: false }
    return { note: 'invalid-request', unavailable: false }
  }
  if (status === 413 || errorCode === 'RESOURCE_EXHAUSTED') return { note: 'diff-too-large', unavailable: false }
  return { note: errorCode ?? 'snapshot-unavailable', unavailable: false }
}

export interface SnapshotServiceOptions {
  api: OpenVikingApi
  /** The active identity's user id (own user scope allowlist). */
  user: () => string
  now?: () => number
}

export class SnapshotService {
  private readonly options: SnapshotServiceOptions
  private readonly now: () => number

  constructor(options: SnapshotServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** `/snapshot-log`: bounded, filtered commit history; never throws. */
  async log(input: { branch?: string; paths?: string[]; limit: number }): Promise<SnapshotLogPayload> {
    const branch = input.branch === undefined || input.branch.length === 0 ? 'main' : input.branch
    const paths = input.paths ?? []
    const response = await this.options.api.snapshotLog({ branch, limit: input.limit, ...(paths.length === 0 ? {} : { paths }) })
    const warnings: PluginNotice[] = []
    if (response.ok) {
      return {
        branch,
        commits: (response.result ?? []).map((entry) => mapSnapshotCommit(entry)),
        paths,
        unavailable: false,
        note: null,
        warnings,
        observedAt: new Date(this.now()).toISOString(),
      }
    }
    const classified = snapshotFailureNote(response.status, response.errorCode, response.errorDetails)
    if (classified.unavailable) warnings.push({ code: 'snapshotLogUnavailable' })
    return {
      branch,
      commits: [],
      paths,
      unavailable: classified.unavailable,
      note: classified.note,
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /** `/snapshot-show`: commit metadata or one bounded, text-only file preview. */
  async show(input: { ref: string; path: string | null }): Promise<SnapshotShowPayload> {
    const observedAt = new Date(this.now()).toISOString()
    const ref = input.ref.trim()
    if (ref.length === 0) {
      return {
        ref,
        path: input.path,
        commit: null,
        text: null,
        truncated: false,
        bytes: null,
        contentType: 'empty',
        available: false,
        note: 'invalid-request',
        warnings: [],
        observedAt,
      }
    }
    if (input.path === null) {
      const response = await this.options.api.snapshotShowMeta(ref)
      if (!response.ok) {
        const classified = snapshotFailureNote(response.status, response.errorCode, response.errorDetails)
        return {
          ref,
          path: null,
          commit: null,
          text: null,
          truncated: false,
          bytes: null,
          contentType: 'empty',
          available: false,
          note: classified.note,
          warnings: [],
          observedAt,
        }
      }
      return {
        ref,
        path: null,
        commit: mapSnapshotCommit(response.result ?? {}),
        text: null,
        truncated: false,
        bytes: null,
        contentType: 'empty',
        available: true,
        note: null,
        warnings: [],
        observedAt,
      }
    }
    const blob = await this.options.api.snapshotShowBlob(ref, input.path, { maxBytes: SNAPSHOT_SHOW_MAX_BYTES })
    if (!blob.ok || blob.bytes === null) {
      const classified = snapshotFailureNote(blob.status, blob.errorCode, null)
      return {
        ref,
        path: input.path,
        commit: null,
        text: null,
        truncated: false,
        bytes: null,
        contentType: classified.note === 'blob-not-found' ? 'empty' : 'binary',
        available: false,
        note: classified.note,
        warnings: [],
        observedAt,
      }
    }
    const contentType = classifyPreviewContent(blob.bytes)
    if (contentType === 'binary') {
      return {
        ref,
        path: input.path,
        commit: null,
        text: null,
        truncated: blob.truncated,
        bytes: blob.size,
        contentType: 'binary',
        available: true,
        note: 'binary-not-previewable',
        warnings: [],
        observedAt,
      }
    }
    const text = new TextDecoder('utf-8').decode(blob.bytes)
    return {
      ref,
      path: input.path,
      commit: null,
      text,
      truncated: blob.truncated,
      bytes: blob.size,
      contentType: text.length === 0 ? 'empty' : 'text',
      available: true,
      note: blob.truncated ? 'preview-truncated' : null,
      warnings: [],
      observedAt,
    }
  }

  /** `/snapshot-diff`: one file between two commits, display-capped. */
  async diff(input: { path: string; from: string | null; to: string }): Promise<SnapshotDiffPayload> {
    const observedAt = new Date(this.now()).toISOString()
    const response = await this.options.api.snapshotDiff(input.path, input.from, input.to)
    if (!response.ok) {
      const classified = snapshotFailureNote(response.status, response.errorCode, response.errorDetails)
      return {
        path: input.path,
        fromCommit: input.from ?? '',
        toCommit: input.to,
        changeType: null,
        diffText: null,
        truncated: false,
        available: false,
        note: classified.note,
        warnings: [],
        observedAt,
      }
    }
    const rawText = typeof response.result?.diff_text === 'string' ? response.result.diff_text : ''
    const truncated = rawText.length > SNAPSHOT_DIFF_MAX_CHARS
    return {
      path: response.result?.path ?? input.path,
      fromCommit: response.result?.from_commit ?? input.from ?? '',
      toCommit: response.result?.to_commit ?? input.to,
      changeType: typeof response.result?.change_type === 'string' ? response.result.change_type : null,
      diffText: truncated ? rawText.slice(0, SNAPSHOT_DIFF_MAX_CHARS) : rawText,
      truncated,
      available: true,
      note: truncated ? 'diff-truncated' : null,
      warnings: [],
      observedAt,
    }
  }

  /** `/snapshot-diff-paths` (0.5.3): a bounded changed-path page. */
  async diffPaths(input: {
    paths: string[]
    from: string | null
    to: string
    offset: number
    limit: number
  }): Promise<DiffPathsPayload> {
    const observedAt = new Date(this.now()).toISOString()
    const response = await this.options.api.snapshotDiffPaths(input.paths, input.from, input.to, {
      offset: input.offset,
      limit: input.limit,
    })
    if (!response.ok) {
      const classified = snapshotFailureNote(response.status, response.errorCode, response.errorDetails)
      return {
        paths: input.paths,
        fromCommit: input.from,
        toCommit: input.to,
        changes: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
        available: false,
        note: response.status === 404 ? 'not-supported' : classified.note,
        warnings: [],
        observedAt,
      }
    }
    const rows = Array.isArray(response.result?.changes) ? response.result.changes : []
    return {
      paths: input.paths,
      fromCommit: input.from,
      toCommit: input.to,
      changes: rows
        .map((row) => ({ uri: typeof row.uri === 'string' ? row.uri : '', changeType: typeof row.change_type === 'string' ? row.change_type : '' }))
        .filter((row) => row.uri.length > 0),
      total: typeof response.result?.total === 'number' ? response.result.total : rows.length,
      hasMore: response.result?.has_more === true,
      nextOffset: typeof response.result?.next_offset === 'number' ? response.result.next_offset : null,
      available: true,
      note: null,
      warnings: [],
      observedAt,
    }
  }

  /** `/snapshot-versions` (0.5.3): a compile-output file's version history. */
  async versions(input: { uri: string; limit: number; beforeVersion: string | null }): Promise<FileVersionsPayload> {
    const observedAt = new Date(this.now()).toISOString()
    const response = await this.options.api.snapshotVersions(input.uri, {
      limit: input.limit,
      ...(input.beforeVersion === null ? {} : { beforeVersion: input.beforeVersion }),
    })
    if (!response.ok) {
      const details = response.errorDetails
      const detailsCode =
        details !== null && typeof details === 'object' && typeof (details as { code?: unknown }).code === 'string'
          ? (details as { code: string }).code
          : null
      const note =
        response.status === 404 || response.status === 400
          ? 'not-supported'
          : response.status === 412 || detailsCode === 'NOT_COMPILE_MANAGED' || response.errorCode === 'FAILED_PRECONDITION'
            ? 'not-compile-managed'
            : response.status === 403
              ? 'forbidden'
              : 'versions-unavailable'
      return {
        uri: input.uri,
        to: null,
        currentVersion: null,
        total: 0,
        versions: [],
        nextBeforeVersion: null,
        available: false,
        note,
        warnings: [],
        observedAt,
      }
    }
    const versions: FileVersionRow[] = (response.result?.versions ?? []).map((entry) => ({
      versionId: typeof entry.version_id === 'string' ? entry.version_id : '',
      versionNumber: typeof entry.version_number === 'number' ? entry.version_number : 0,
      createdAt: typeof entry.created_at === 'number' ? new Date(entry.created_at * 1000).toISOString() : null,
      snapshotId: typeof entry.snapshot_id === 'string' ? entry.snapshot_id : null,
      operationId:
        entry.meta !== null && typeof entry.meta === 'object' && typeof (entry.meta as { operation_id?: unknown }).operation_id === 'string'
          ? ((entry.meta as { operation_id: string }).operation_id)
          : null,
      source: typeof entry.source === 'string' ? entry.source : null,
    }))
    return {
      uri: response.result?.uri ?? input.uri,
      to: typeof response.result?.to === 'string' ? response.result.to : null,
      currentVersion: typeof response.result?.current_version === 'string' ? response.result.current_version : null,
      total: typeof response.result?.total === 'number' ? response.result.total : versions.length,
      versions,
      nextBeforeVersion:
        typeof response.result?.next_before_version === 'string' ? response.result.next_before_version : null,
      available: true,
      note: null,
      warnings: [],
      observedAt,
    }
  }

  /** `/snapshot-ignore`: read-only display of the account ignore file. */
  async ignore(): Promise<SnapshotIgnorePayload> {
    const observedAt = new Date(this.now()).toISOString()
    const response = await this.options.api.snapshotIgnore()
    if (!response.ok) {
      const classified = snapshotFailureNote(response.status, response.errorCode, response.errorDetails)
      return { content: '', available: false, note: classified.note, observedAt }
    }
    return {
      content: typeof response.result === 'string' ? response.result : '',
      available: true,
      note: null,
      observedAt,
    }
  }

  /* ---- the four mutation helpers (called only by OpsService) ------------ */

  /** `POST /snapshot/commit`: create one commit (no undo; append-only). */
  async commitSnapshot(message: string, paths: string[], requestId: { value: string | null }): Promise<
    | { ok: true; commit: string | null; requestId: string | null }
    | { ok: false; code: string; message: string; requestId: string | null }
  > {
    const response = await this.options.api.snapshotCommit(message, paths)
    requestId.value = response.requestId ?? null
    if (!response.ok) {
      return { ok: false, code: response.status === 404 ? 'snapshot-unavailable' : 'rejected-by-server', message: response.error ?? 'The snapshot commit failed.', requestId: response.requestId ?? null }
    }
    return {
      ok: true,
      commit: typeof response.result?.commit_oid === 'string' ? response.result.commit_oid : null,
      requestId: response.requestId ?? null,
    }
  }

  /** A dry-run restore plan plus the HEAD the plan was computed against. */
  async dryRunRestore(projectDir: string, sourceCommit: string): Promise<
    | {
        ok: true
        head: string | null
        toWrite: Array<{ path: string; oid: string | null }>
        toDelete: Array<{ path: string; oid: string | null }>
        unchanged: number
      }
    | { ok: false; code: string; message: string; status: number; details?: unknown }
  > {
    const response = await this.options.api.snapshotRestore(projectDir, sourceCommit, { dryRun: true })
    if (!response.ok) {
      return {
        ok: false,
        code: response.status === 404 ? 'not-found' : response.status === 409 ? 'revision-mismatch' : 'rejected-by-server',
        message: response.error ?? 'The restore dry run failed.',
        status: response.status,
        details: response.errorDetails,
      }
    }
    const diff = response.result?.diff
    return {
      ok: true,
      head: typeof response.result?.head === 'string' ? response.result.head : null,
      toWrite: (diff?.to_write ?? []).map((entry) => ({ path: typeof entry.path === 'string' ? entry.path : '', oid: typeof entry.oid === 'string' ? entry.oid : null })),
      toDelete: (diff?.to_delete ?? []).map((entry) => ({ path: typeof entry.path === 'string' ? entry.path : '', oid: typeof entry.oid === 'string' ? entry.oid : null })),
      unchanged: Array.isArray(diff?.unchanged) ? diff.unchanged.length : 0,
    }
  }

  /** Apply a directory restore (`dry_run:false`), surfacing partial writeback. */
  async applyRestore(projectDir: string, sourceCommit: string): Promise<
    | {
        ok: true
        newCommit: string | null
        parentCommit: string | null
        written: number
        deleted: number
        unchanged: number
        writtenPaths: string[]
        deletedPaths: string[]
        taskId: string | null
        requestId: string | null
      }
    | {
        ok: false
        partial:
          | {
            newCommit: string | null
            parentCommit: string | null
            writtenPaths: string[]
            deletedPaths: string[]
            failedWrites: string[]
            failedDeletes: string[]
            taskId: string | null
          }
          | null
        code: string
        message: string
        status: number
        requestId: string | null
      }
  > {
    const response = await this.options.api.snapshotRestore(projectDir, sourceCommit, { dryRun: false })
    if (!response.ok) {
      const details = response.errorDetails
      const partial =
        response.errorCode === 'RESTORE_WRITEBACK_PARTIAL' && details !== null && typeof details === 'object'
          ? mapPartial(details as Record<string, unknown>)
          : null
      return {
        ok: false,
        partial,
        code:
          partial !== null
            ? 'rejected-by-server'
            : response.status === 409
              ? 'revision-mismatch'
              : response.status === 404
                ? 'not-found'
                : 'rejected-by-server',
        message: response.error ?? 'The restore failed.',
        status: response.status,
        requestId: response.requestId ?? null,
      }
    }
    const result = response.result ?? {}
    return {
      ok: true,
      newCommit: typeof result.new_commit_oid === 'string' ? result.new_commit_oid : null,
      parentCommit: typeof result.parent_commit === 'string' ? result.parent_commit : null,
      written: typeof result.written === 'number' ? result.written : 0,
      deleted: typeof result.deleted === 'number' ? result.deleted : 0,
      unchanged: typeof result.unchanged === 'number' ? result.unchanged : 0,
      writtenPaths: Array.isArray(result.written_paths) ? result.written_paths.filter((entry): entry is string => typeof entry === 'string') : [],
      deletedPaths: Array.isArray(result.deleted_paths) ? result.deleted_paths.filter((entry): entry is string => typeof entry === 'string') : [],
      taskId: typeof result.task_id === 'string' ? result.task_id : null,
      requestId: response.requestId ?? null,
    }
  }

  /** The file-version CAS restore (0.5.3): a new version, history never rewritten. */
  async restoreFileVersion(
    uri: string,
    restoreVersion: string,
    currentVersion: string,
  ): Promise<
    | { ok: true; versionId: string | null; versionNumber: number | null; requestId: string | null; noop: boolean }
    | { ok: false; code: string; message: string; requestId: string | null }
  > {
    const response = await this.options.api.snapshotRestoreFileVersion(uri, restoreVersion, currentVersion)
    if (!response.ok) {
      const code =
        response.status === 409 || response.errorCode === 'CONFLICT' || response.errorCode === 'FAILED_PRECONDITION'
          ? 'revision-mismatch'
          : response.status === 404
            ? 'not-found'
            : 'rejected-by-server'
      return { ok: false, code, message: response.error ?? 'The version restore failed.', requestId: response.requestId ?? null }
    }
    return {
      ok: true,
      versionId: typeof response.result?.version_id === 'string' ? response.result.version_id : null,
      versionNumber: typeof response.result?.version_number === 'number' ? response.result.version_number : null,
      requestId: response.requestId ?? null,
      noop: response.result?.result === 'noop',
    }
  }

  /**
   * Verify a just-created commit through the snapshot log.
   *
   * The retry exists for ONE case: the server answered successfully but HEAD has
   * not advanced yet (a visibility lag). A failed request (`!ok`, including a
   * timeout) is NOT retried: both call sites hold the shared mutation gate, and
   * three 8 s timeouts would keep every curation write and ops action refused as
   * `write-in-flight` for up to 24 s. Only successful stale answers get the
   * bounded three-attempt, ~0.2 s retry. The branch is passed through so the
   * read looks at the same history the action wrote to (v0.8 actions use the
   * documented fixed `main` branch).
   */
  async verifyCommit(commit: string | null, branch = 'main'): Promise<boolean> {
    if (commit === null) return false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(100)
      const response = await this.options.api.snapshotLog({ branch, limit: 1 })
      if (!response.ok) return false
      const newest = (response.result ?? [])[0]
      if (typeof newest?.oid === 'string' && newest.oid === commit) return true
    }
    return false
  }
}

/** Normalize the partial-writeback error payload the server documents. */
function mapPartial(details: Record<string, unknown>): {
  newCommit: string | null
  parentCommit: string | null
  writtenPaths: string[]
  deletedPaths: string[]
  failedWrites: string[]
  failedDeletes: string[]
  taskId: string | null
} {
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
  const pairs = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((entry) => (Array.isArray(entry) ? entry.map(String).join(': ') : String(entry)))
      : []
  return {
    newCommit: typeof details.new_commit_oid === 'string' ? details.new_commit_oid : null,
    parentCommit: typeof details.parent_commit === 'string' ? details.parent_commit : null,
    writtenPaths: strings(details.written_paths),
    deletedPaths: strings(details.deleted_paths),
    failedWrites: pairs(details.failed_writes),
    failedDeletes: pairs(details.failed_deletes),
    taskId: typeof details.task_id === 'string' ? details.task_id : null,
  }
}

/** Small bounded delay for read-back verification only (never a write retry). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
