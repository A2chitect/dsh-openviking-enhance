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
export type RecallQuerySource = 'session' | 'manual' | 'turn'

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

/**
 * One hit as the recall explanation shows it.
 *
 * The context face returns a flat list with the server's own category, read
 * tier and provenance; the fallback search returns the old bucketed shape.
 * `bucket` is the display group either way, and `category` is the server's
 * finer answer (`events`, `entities`, `resources`, …).
 */
export interface RecallExplainEntry {
  uri: string
  score: number
  /** `memories` | `resources` | `skills` — the group the panel renders. */
  bucket: string
  /** The server's own category, when it names one. */
  category: string
  /** `overview` | `full` | `abstract` | `uri` — the read tier the server served. */
  detail: string | null
  /** `self` | `actor_peer` | `other_peer`, when the server reports provenance. */
  origin: string | null
  abstract: string
  memoryType: string
  level: number | null
  tags: string[]
}

/**
 * The context face's own accounting for one answer.
 *
 * Every field is optional on the wire: these are the server's diagnostics, and a
 * version that omits one must degrade to "unknown", not fail the whole card.
 * The panel explains a recall with exactly these numbers rather than guessing
 * from the hit list.
 */
export interface RecallExplainStats {
  /** Per-category searched counts, e.g. `{ events: 18, entities: 12 }`. */
  searched: Record<string, number>
  candidates: number | null
  returned: number | null
  dropped: number | null
  deduped: number | null
  excluded: number | null
  maxTokens: number | null
  usedTokens: number | null
  quotas: Record<string, number>
  tierCounts: Record<string, number>
  origins: Record<string, number>
  peerScope: string | null
  plannedQueries: string[]
  queryExpansion: string | null
  rewrite: string | null
  scoreThreshold: number | null
  /** Cross-turn de-duplication: how many turns, whether it ran, how many cooled. */
  dedup: { turns: number | null; status: string | null; cooled: number | null; turn: number | null } | null
  fill: Record<string, number> | null
}

/** Effective values read from the mounted memory plugin, when it exposes them. */
export interface RecallEffectiveSettings {
  scoreThreshold: number | null
  recallLimit: number | null
  recallMaxTokens: number | null
  recallTokenBudget: number | null
  dedupTurns: number | null
  queryExpansion: string | null
  rewrite: string | null
  peerScope: string | null
  commitTokenThreshold: number | null
}

/**
 * "Why did this turn recall these?" — the answer to the question the dashboard
 * could never answer.
 *
 * `replay: true` is deliberate and is never omitted: DSH does not retain the
 * memory plugin's injected block, so this is the same context request replayed
 * for the turn's prompt under the session's current state. The card says so
 * instead of pretending to show the historical injection. `rendered` is the
 * server-assembled block this replay would inject.
 */
export interface RecallExplanation {
  sessionId: string
  ovSessionId: string
  sessionUri: string | null
  peer: string | null
  query: { text: string; source: RecallQuerySource }
  /** The server's assembled context face, or the per-target search fallback. */
  mode: 'context' | 'search'
  entries: RecallExplainEntry[]
  stats: RecallExplainStats | null
  rendered: string | null
  renderedTruncated: boolean
  plan: string | null
  targets: string[]
  total: number
  latencyMs: number
  searchedAt: string
  warnings: PluginNotice[]
  /** Always true: the original injection is not retained; this is a replay. */
  replay: true
  effective: RecallEffectiveSettings | null
}

/** Cap on the assembled block returned by `/recall/explain`. */
export const RECALL_EXPLAIN_MAX_CHARS = 20000

/**
 * The one state the session log reports.
 *
 * These are the five states the dashboard must distinguish — plus the normal
 * committed state and "the host could not ask":
 *
 *  - `no-messages`   nothing was ever captured for this session
 *  - `not-committed` messages are captured and accumulate toward the threshold
 *  - `extracting`    a commit archived and its memory extraction is still running
 *  - `failed`        the newest extraction failed; its memories are missing
 *  - `queued`        the official plugin's local pending queue holds writes
 *  - `committed`     the newest commit finished and nothing is waiting
 *  - `unknown`       the server or its session answer could not be read
 */
export type SessionMemoryState =
  | 'no-messages'
  | 'not-committed'
  | 'extracting'
  | 'failed'
  | 'queued'
  | 'committed'
  | 'unknown'

export interface SessionLogMeta {
  /** Captured, not-yet-committed messages on the server. */
  messageCount: number
  /** Every message the server has ever received for this session. */
  totalMessageCount: number
  commitCount: number
  pendingTokens: number
  keepRecentCount: number | null
  createdAt: string | null
  updatedAt: string | null
  lastMessageAt: string | null
  lastCommitAt: string | null
  lastAutoCommitAt: string | null
  memoriesExtracted: { total: number; memoryWrite: number; memoryEdit: number } | null
  llmTokens: { prompt: number; completion: number; total: number } | null
}

/** One `session_commit` task, flattened for the log. */
export interface SessionLogTask {
  taskId: string
  status: string
  stage: string | null
  error: string | null
  createdAt: string | null
  updatedAt: string | null
  processingSeconds: number | null
  archiveUri: string | null
  memoryDiffUri: string | null
}

/**
 * One write the official memory plugin queued locally while the server was
 * unreachable. The payload is deliberately never read: it can contain transcript
 * content, and the log only needs to say that a write is waiting.
 */
export interface PendingQueueItem {
  type: string
  createdAt: string | null
  retries: number
  processing: boolean
}

export interface PendingQueueSummary {
  /** Whether the local queue directory could be read at all. */
  available: boolean
  /** `OPENVIKING_PENDING_DIR`, when it overrides the default location. */
  directory: string | null
  total: number
  items: PendingQueueItem[]
  error: string | null
}

export type SessionLogEventKind = 'created' | 'message' | 'commit' | 'auto-commit' | 'failed' | 'queued'

/** One timestamped fact on the session's activity timeline. */
export interface SessionLogEvent {
  at: string
  kind: SessionLogEventKind
  /** A server-side detail, e.g. the failed stage. Never memory content. */
  detail: string | null
}

/** The session memory log: capture, pending tokens and commit progress. */
export interface SessionMemoryLog {
  sessionId: string
  ovSessionId: string
  sessionUri: string | null
  peer: string | null
  state: SessionMemoryState
  /** Effective commit threshold from the memory plugin; null when unknown. */
  threshold: number | null
  meta: SessionLogMeta
  tasks: SessionLogTask[]
  archives: CommitArchive[]
  summaries: ArchiveSummary[]
  pending: PendingQueueSummary
  /** Recent timestamped facts, newest first. Not a full state-transition audit. */
  events: SessionLogEvent[]
  warnings: PluginNotice[]
  observedAt: string
  /** The queue is the official plugin's local state, not this plugin's. */
  queueSource: 'official-plugin'
}

/** Where one connection value came from. */
export type ConnectionSource = 'override' | 'env' | 'ovcli.local' | 'ovcli' | 'default' | 'none'

export interface ConnectionFieldOrigin {
  field: 'endpoint' | 'apiKey' | 'account' | 'user'
  source: ConnectionSource
  /** Environment variable or config file name; never a secret value. */
  detail: string | null
  /** Whether a value is set (for apiKey: whether one is configured). */
  configured: boolean
}

export type DoctorCapabilityState = 'available' | 'unavailable' | 'legacy' | 'unknown' | 'skipped'

export interface DoctorCapability {
  state: DoctorCapabilityState
  /** A short server fact, e.g. `233 queries`, or the failing status. */
  detail: string | null
}

export type DoctorCheckStatus = 'ok' | 'warn' | 'error' | 'unknown' | 'skipped'

export interface DoctorCheck {
  id: string
  status: DoctorCheckStatus
  /** A short, already-readable fact. */
  value: string | null
  /** What to do when this check is not ok. Copy key under `doctor.hint.*`. */
  hint: string | null
}

export interface DoctorReport {
  observedAt: string
  endpoint: string
  health: { healthy: boolean; version: string | null; authMode: string | null; latencyMs: number; error: string | null }
  connection: {
    endpoint: string
    origins: ConnectionFieldOrigin[]
  }
  identity: {
    configuredAccount: string
    configuredUser: string
    serverUser: string | null
    serverInitialized: boolean | null
    sessionAccount: string | null
    sessionUser: string | null
  }
  plugin: {
    mounted: boolean
    version: string | null
    peer: string | null
    peerSource: string | null
    ovSessionId: string | null
    /** Effective, non-secret settings the mounted plugin exposes. */
    effective: Record<string, string | number | boolean | null>
  }
  session: {
    known: boolean
    uri: string | null
    messageCount: number | null
    commitCount: number | null
    pendingTokens: number | null
    lastCommitAt: string | null
  }
  capabilities: {
    contextFace: DoctorCapability
    ruleSearch: DoctorCapability
    skills: DoctorCapability & { count: number | null }
    fsStat: DoctorCapability
    observer: DoctorCapability & { avgLatencyMs: number | null; queries: number | null }
  }
  checks: DoctorCheck[]
  compatibility: {
    /** DSH version detected from the running web host, when it exposes one. */
    dshVersion: string | null
    /** The semver range this plugin's manifest declares. */
    pluginRange: string
    dshCompatible: boolean | null
    /** The OpenViking range this release is tested against. */
    testedRange: string
  }
  warnings: PluginNotice[]
  /** A copyable, secret-free snapshot of everything above. */
  diagnostics: Record<string, unknown>
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
