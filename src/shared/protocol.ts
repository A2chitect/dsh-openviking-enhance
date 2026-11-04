/**
 * Wire contract between the host half and the browser half.
 *
 * The two halves share nothing at runtime: the host registers HTTP routes on
 * `ctx.webServer` and the client half fetches them document-relatively (see
 * `src/client/host-api.ts` for why the URL must stay relative). This module is
 * the single source of truth for those paths and payloads.
 */

/** Route family owned by this plugin. Must not collide with another plugin's. */
export const API_PREFIX = '/api/openviking-enhance'

/** Browser-side base path: document-relative, never root-absolute. */
export const CLIENT_API_PREFIX = API_PREFIX.slice(1)

/** One archive directory under a session's history tree. */
export interface CommitArchive {
  /** `archive_001`, `archive_002`, … — sequential in commit order. */
  archiveId: string
  /** `viking://…/sessions/<id>/history/archive_001` */
  archiveUri: string
  /** Directory modification time, i.e. when that commit archived. */
  modTime: string | null
}

/** Counts from one commit's `memory_diff.json`. */
export interface MemoryDiffSummary {
  totalAdds: number
  totalUpdates: number
  totalDeletes: number
  totalSkipped: number
}

/**
 * Terminal state of one commit archive, from the server's own markers.
 *
 * OpenViking writes `.done` when extraction finishes and `.failed.json` when it
 * fails. Both live inside the archive directory, so unlike `session_commit` task
 * records they are not cleaned up after 24 hours / 7 days.
 *
 * `unknown` means the host could not read the markers at all (transport or auth
 * error), not that the server has no state.
 */
export type ArchiveState = 'done' | 'failed' | 'pending' | 'unknown'

/** What the server's `.failed.json` says about one failed extraction. */
export interface ArchiveFailure {
  stage: string | null
  error: string | null
  failedAt: string | null
  skipped: boolean
}

/** The newest archive, as the pill needs it. */
export interface ArchiveTerminal {
  archiveUri: string
  state: ArchiveState
  failure: ArchiveFailure | null
  /**
   * Whether this archive carried a real terminal marker (`.done` /
   * `.failed.json`) rather than a legacy diff-only success. It tells the client
   * whether the archive states, or the task list, are the trustworthy source.
   */
  markers: boolean
}

/**
 * One timeline row: an archive, its terminal state, and the counts of what it
 * changed.
 *
 * `state` comes from the archive's own markers and is what the UI must trust:
 * `summary: null` alone cannot tell a failed extraction from one that is still
 * running, and a failed extraction can still leave a partial
 * `memory_diff.json` behind.
 */
export interface ArchiveSummary {
  archiveUri: string
  summary: MemoryDiffSummary | null
  state: ArchiveState
  /** The server's own payload from `.failed.json`, when this archive failed. */
  failure: ArchiveFailure | null
}

/** Result of one memory-extraction phase, as recorded in `memory_diff.json`. */
export interface MemoryDiff {
  archiveUri: string
  extractedAt: string | null
  adds: MemoryDiffEntry[]
  updates: MemoryDiffEntry[]
  deletes: MemoryDiffEntry[]
  summary: MemoryDiffSummary
}

export interface MemoryDiffEntry {
  uri: string
  memoryType: string
  /** Present on adds and updates. */
  before?: string
  /** Present on adds and updates. */
  after?: string
  /** Deletes carry `deleted_content` instead of before/after. */
  deletedContent?: string
}

/**
 * What the pill reports.
 *
 *  - `failed`  — the host could not be asked (server or route down)
 *  - `errored` — the newest commit's memory extraction failed: the archive was
 *                written, its memories were not extracted. On a server without
 *                terminal markers this is a failed task that no later commit
 *                has superseded.
 */
export type CommitPhase = 'idle' | 'pending' | 'extracting' | 'done' | 'failed' | 'errored'

/**
 * One `session_commit` task.
 *
 * Task records are pruned by the server (`completed`/`cancelled` after ~24 h,
 * `failed` after ~7 days), so they describe live progress and serve as the
 * failure fallback on servers without archive markers — never as history. A
 * failed task carries the server's own error text and no `result`.
 */
export interface CommitTask {
  task_id: string
  /** `pending` | `running` | `cancelling` | `completed` | `failed` | `cancelled` */
  status: string
  stage: string | null
  /** Server error text, e.g. the provider's 400. Null when it succeeded. */
  error: string | null
  created_at?: number
  updated_at?: number
  created_at_iso?: string
  updated_at_iso?: string
  processing_seconds?: number
  resource_id?: string | null
  result: {
    memory_diff_uri?: string
    archive_uri?: string
    memories_extracted?: { total?: number; memory_write?: number; memory_edit?: number }
    /** Present when the extraction ran but skipped operations. */
    memory_extraction?: { skipped?: number; skipped_operations?: unknown[] }
  } | null
}

export interface CommitStatus {
  /** DSH session id. */
  sessionId: string
  /** `dsh-<sessionId>` — the OpenViking-side session key. */
  ovSessionId: string
  /** Server-side pending token count driving `commitTokenThreshold`. */
  pendingTokens: number
  /** Effective threshold, read from the OpenViking plugin when it is mounted. */
  threshold: number | null
  /** `pendingTokens / threshold`, clamped to 0…1, for the progress ring. */
  ratio: number
  /** Successful extractions counted by the server. */
  commitCount: number
  lastCommitAt: string | null
  /** Best-effort phase derived by the host; the client refines it with tasks. */
  phase: CommitPhase
  /**
   * Terminal state of the newest archive, when one exists. This is the durable
   * signal: the pill must not derive failure from the pruned task list alone.
   */
  latest: ArchiveTerminal | null
  /** One entry per archive directory found on the server. */
  archives: CommitArchive[]
}

/** How many commit records the popover shows before the user asks for the rest. */
export const TIMELINE_DEFAULT = 3
/** Upper bound for one request, so a crafted query cannot fan out unboundedly. */
export const TIMELINE_MAX = 50

/** `/config` response: everything the client half needs to render a Studio panel. */
export interface EnhanceConfig {
  ok: boolean
  /** OpenViking base URL, e.g. `http://127.0.0.1:1933`. */
  endpoint: string
  /** Ready-to-embed Studio URL, e.g. `http://127.0.0.1:1933/studio/`. */
  studioUrl: string
  /** OpenViking server version, or null while unreachable. */
  version: string | null
  healthy: boolean
  /** Identity the plugin reads and writes under. */
  account: string
  user: string
  /** Non-fatal problems worth surfacing in the panel header. */
  warnings: PluginNotice[]
}

/**
 * Recall payloads for the right-Sidebar panel.
 *
 * The panel answers "what does OpenViking retrieve for this session, and why".
 * The host asks the same session-aware route the memory plugin calls
 * (`POST /api/v1/search/search`, see `src/host/recall-service.ts`), so the panel
 * reports the server's own ranking rather than a re-implementation of it.
 */

/** One retrieved memory, resource or skill. */
export interface RecallItem {
  /** `viking://…` path of the retrieved entry. */
  uri: string
  /** Similarity score, 0…1. */
  score: number
  /** `memory` | `resource` | `skill` | … as the server labels it. */
  contextType: string
  /**
   * The entry's own kind — `entity`, `event`, `preference`, … — read host-side
   * from the path the plugin writes (`…/memories/entities/<project>/…`).
   *
   * The retrieval reply carries no memory type and this server leaves `tags`
   * empty, so the path is the only place that fact exists. Empty for entries
   * that are not under `memories/` (resources, skills, index files).
   */
  memoryType: string
  /** Level in the memory tree, when the server reports one. */
  level: number | null
  /** What the entry says, as far as the server is willing to show. */
  abstract: string
  tags: string[]
}

/** One retrieval source. Every source is searched; one may come back empty. */
export interface RecallBucket {
  /** `memories` | `resources` | `skills` — the server's own bucket name. */
  bucket: string
  /** Best-ranked entries across the targets searched for this bucket. */
  items: RecallItem[]
}

/** Where the query being shown came from. */
export type RecallQuerySource = 'session' | 'manual'

export interface RecallPayload {
  sessionId: string
  ovSessionId: string
  /** Canonical session path, or null when the server knows no such session. */
  sessionUri: string | null
  /** Actor peer the search ran as, or null when the memory plugin did not know one. */
  peer: string | null
  query: { text: string; source: RecallQuerySource }
  buckets: RecallBucket[]
  /** The server's own retrieval plan, when it explains one. */
  plan: string | null
  /** Every `viking://` target that was searched, for the panel's detail row. */
  targets: string[]
  /** Entries returned across every bucket, before the per-bucket cap. */
  total: number
  /** Wall-clock duration of the searches, in milliseconds. */
  latencyMs: number
  searchedAt: string
  /** Non-fatal problems: a target that failed, a session log with no user turn, … */
  warnings: PluginNotice[]
}

/** One entry's full text, for the panel's detail view. */
export interface RecallContent {
  uri: string
  text: string
  truncated: boolean
}

/** Entries shown per bucket before the panel offers "show all". */
export const RECALL_DEFAULT_LIMIT = 8
/** Upper bound for one request, so a crafted query cannot fan out unboundedly. */
export const RECALL_MAX_LIMIT = 25
/** Cap on `/recall/content`, so one click cannot pull an unbounded document. */
export const RECALL_CONTENT_MAX_CHARS = 20000
/** The buckets the panel renders, in display order. */
export const RECALL_BUCKETS = ['memories', 'resources', 'skills'] as const

/**
 * A message from the host, which has no language of its own.
 *
 * The host runs in Node with no locale: it reports *what happened* as a code and
 * the parameters that fill it in, and the browser half renders it through `t()` as
 * `notice.<code>`. An unknown code falls back to the code itself, so a newer host
 * talking to an older client degrades to something readable rather than blank.
 */
export interface PluginNotice {
  code: string
  params?: Record<string, string | number>
}

/** Envelope every route returns; `ok: false` carries a message, never a throw. */
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string }
