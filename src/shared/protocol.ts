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
  /** v0.5: live `enableWrites` value, so the panel header need not refetch settings. */
  writesEnabled?: boolean
  /** v0.5: the resolved active profile id, or null in legacy mode. */
  activeProfileId?: string | null
  /** v0.5: probed server auth mode (null while unknown). */
  authMode?: string | null
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
export type ConnectionSource = 'override' | 'env' | 'ovcli.local' | 'ovcli' | 'default' | 'none' | 'profile'

export interface ConnectionFieldOrigin {
  field: 'endpoint' | 'apiKey' | 'account' | 'user'
  source: ConnectionSource
  /** Environment variable or config file name; never a secret value. */
  detail: string | null
  /** Whether a value is set (for apiKey: whether one is configured). */
  configured: boolean
}

export type DoctorCapabilityState = 'available' | 'unavailable' | 'legacy' | 'unknown' | 'skipped'

/** One local configuration/metadata file the host read (or failed to read). */
export type ConfigSourceId =
  | 'ovcli.conf'
  | 'ovcli.conf.local'
  | 'profiles.json'
  | 'pending-queue'
  | 'plugin-state'

/** How a local source read went; values only, never contents. */
export type ConfigSourceState = 'ok' | 'missing' | 'malformed' | 'unreadable' | 'wrong-shape' | 'unknown'

export interface ConfigSourceHealth {
  source: ConfigSourceId
  /** Symbolic path (`~/.openviking/...`, `$DSH_HOME/...`), never a secret. */
  path: string
  state: ConfigSourceState
  /** The filesystem/parse error code when one applies, else null. */
  errorCode: string | null
}

/** The plugin's own build facts, for the Doctor (never in ordinary copy). */
export interface PluginBuildInfo {
  pluginVersion: string
  dshVersion: string | null
  nodeVersion: string
  platform: string
  userAgent: string
}

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
    /** Whether the memory plugin's MCP tools are visible to the model. */
    mcpTools: DoctorCapability & { count: number; names: string[] }
    fsStat: DoctorCapability
    observer: DoctorCapability & { avgLatencyMs: number | null; queries: number | null }
  }
  checks: DoctorCheck[]
  /** Which local config/metadata sources were readable, and how (no contents). */
  configSources: ConfigSourceHealth[]
  /** The build identity of the running bundle (plugin/DSH/Node/platform/UA). */
  build: PluginBuildInfo
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

/* ========================================================================
 * v0.4 "Act" — preview, unified search, rules/skills/experience, commands
 *
 * Everything below is read-only. The host serves these from the same
 * OpenViking HTTP API the recall tab uses; no route here writes.
 * ===================================================================== */

/* ---- F5: the `viking://` preview ------------------------------------- */

/**
 * One read tier of an entry, as the preview shows it.
 *
 * L0 (`abstract`) and L1 (`overview`) are short server-generated summaries; L2
 * (`read`) is the stored body. A directory has L0/L1 but no L2, and an older
 * server may miss a tier entirely — `available` is the UI's answer, `error` is
 * the server's own reason.
 */
export type PreviewTierId = 'l0' | 'l1' | 'l2'

/** The tiers in reading order: abstract, overview, full text. */
export const PREVIEW_TIERS: readonly PreviewTierId[] = ['l0', 'l1', 'l2']

/** Cap per tier, so one preview cannot pull an unbounded document. */
export const PREVIEW_MAX_CHARS = 20000

export interface PreviewTier {
  id: PreviewTierId
  /** The text the server returned, already capped. Empty when unavailable. */
  text: string
  /** Whether `text` was cut at {@link PREVIEW_MAX_CHARS}. */
  truncated: boolean
  /** L2 only: the 0-based line this page starts at. L0/L1 are whole, so 0. */
  offset: number
  /**
   * L2 only: the next line offset to request, or null when this is the last
   * page. The panel offers "Show more" while this is non-null.
   */
  nextOffset: number | null
  available: boolean
  /**
   * True when the server answered with its "not generated yet" placeholder
   * (`[Directory abstract is not ready]`), which is a 200 and not content.
   */
  placeholder: boolean
  /** The server's refusal, when this tier could not be read. */
  error: string | null
}

/** `fs/stat` + `fs/attrs`, flattened for the metadata block. */
export interface PreviewStat {
  uri: string
  name: string
  size: number | null
  mode: number | null
  isDir: boolean | null
  isLocked: boolean | null
  modifiedAt: string | null
  /** From `fs/attrs.context_type`, e.g. `memory` | `resource` | `skill`. */
  contextType: string | null
  /** `entities` | `events` | `preferences` | …, when the entry is a memory. */
  memoryType: string | null
  category: string | null
  tags: string[]
}

/** One entry as the preview tab renders it: metadata + three read tiers. */
export interface PreviewPayload {
  uri: string
  /** Null when `fs/stat` failed but the tiers still answered. */
  stat: PreviewStat | null
  tiers: PreviewTier[]
  /** Ready-to-open Studio URL, so "open in Studio" needs no second route. */
  studioUrl: string
  observedAt: string
  warnings: PluginNotice[]
}

/* ---- F7: unified search ---------------------------------------------- */

/** The four groups the Explore "Search" segment can show. */
export const SEARCH_BUCKETS = ['memories', 'resources', 'skills', 'rules'] as const
export type SearchBucketId = (typeof SEARCH_BUCKETS)[number]

/**
 * The buckets a search request asks for when the caller names none.
 *
 * The rules bucket is deliberately absent: `rules/search` is not a pure read
 * (scenario vector recall, and an LLM judge when a Rule judge model is
 * configured), so it is an explicit opt-in in the Explore search. See the
 * "what the plugin sends (and what it costs)" README section.
 */
export const DEFAULT_SEARCH_BUCKETS = ['memories', 'resources', 'skills'] as const

export const SEARCH_DEFAULT_LIMIT = 8
export const SEARCH_MAX_LIMIT = 25

/** The server's own retrieval modes: vector similarity or literal keywords. */
export type SearchType = 'semantic' | 'keywords'

/** The rule facts the unified result row can show beside an abstract. */
export interface SearchRuleBrief {
  name: string
  status: string | null
  appliesWhen: string | null
  exception: string | null
  probability: number | null
}

/** One hit, normalized across the server's two retrieval dialects. */
export interface SearchItem {
  uri: string
  /** 0…1; for a rule match, the server's probability. */
  score: number
  /** `memory` | `resource` | `skill` | `rule`. */
  contextType: string
  /** `entities` | `events` | … for memories; empty otherwise. */
  memoryType: string
  level: number | null
  abstract: string
  tags: string[]
  /** Present only in the `rules` bucket. */
  rule: SearchRuleBrief | null
}

export interface SearchBucket {
  bucket: SearchBucketId
  items: SearchItem[]
}

export interface SearchPayload {
  query: string
  searchType: SearchType
  buckets: SearchBucket[]
  /** Entries shown across every bucket, i.e. AFTER each bucket's cap. */
  total: number
  latencyMs: number
  searchedAt: string
  warnings: PluginNotice[]
}

/* ---- F8: rules, skills, experience ----------------------------------- */

/** Longest task context the rule tester sends (the server accepts 64000). */
export const RULE_TASK_CONTEXT_MAX = 4000

/** One row of the rule list. */
export interface RuleSummary {
  /** The rule file's `atomic_id`. */
  id: string
  uri: string
  name: string
  /** `active` | `paused` | `archived` | `unknown`. */
  status: string
  scenario: string | null
  description: string | null
}

export interface RuleScenarioGroup {
  id: string
  name: string
  ruleCount: number
}

/** Why a rules listing stopped short, when it did. */
export type RuleListLimitedBy = 'deadline' | 'rule-cap' | 'scenario-cap'

/** Where a (possibly partial) rules listing stopped, for the partial notice. */
export interface RuleListProgress {
  /** Rows served in this answer. */
  rules: number
  /** Scenario folders that were attempted. */
  scenarios: number
  /** Wall-clock milliseconds the listing spent before answering. */
  elapsedMs: number
  /** The total deadline the listing was given. */
  deadlineMs: number
  /** The per-answer rule cap this listing applies. */
  ruleCap: number
  /** The per-answer scenario cap this listing applies. */
  scenarioCap: number
}

export interface RuleListPayload {
  rules: RuleSummary[]
  scenarios: RuleScenarioGroup[]
  /** True when the rules tree exists but holds no rule files yet. */
  empty: boolean
  /**
   * True when the list is usable but incomplete: the deadline stopped it or a
   * cap was reached. The rows already served stay — this is not an error state.
   */
  partial: boolean
  /** Which bound stopped the listing, or null when it is complete. */
  limitedBy: RuleListLimitedBy | null
  /** Counts for the partial notice. */
  progress: RuleListProgress
  warnings: PluginNotice[]
  observedAt: string
}

/**
 * One matched rule, as the read-only tester shows it.
 *
 * The server's `rules[]` carries the complete stored Rule Markdown in
 * `content`; the host parses its YAML frontmatter so the tester can show the
 * requirement, `applies_when` and `exception` as separate fields.
 */
export interface RuleMatch {
  id: string
  uri: string
  revision: number | null
  scenario: string | null
  /** The server's retrieval probability, 0…1. */
  probability: number | null
  name: string
  /** The frontmatter `content` field: the requirement sentence. */
  constraint: string
  appliesWhen: string | null
  exception: string | null
  status: string | null
  /** The Markdown body after the frontmatter. */
  body: string
}

export interface RuleSearchPayload {
  matches: RuleMatch[]
  /** The server's own assembled block, for readers who want the whole protocol. */
  rendered: string | null
  warning: string | null
  /** Whether the server considers the delivery complete. */
  complete: boolean
  latencyMs: number
  searchedAt: string
}

/** One installed skill, from `GET /api/v1/skills`. */
export interface SkillEntry {
  name: string
  uri: string
  rootUri: string | null
  /** The `SKILL.md` file: the row's preview target. */
  skillMdUri: string | null
  description: string
  tags: string[]
  allowedTools: string[]
}

export interface SkillCatalogue {
  skills: SkillEntry[]
  total: number
  /** Every skills root the server reported (user scope, agent scope, …). */
  roots: string[]
  warnings: PluginNotice[]
  observedAt: string
}

export type ExperienceKind = 'trajectories' | 'outcomes'

/** The five outcome classes the server always reports. */
export const EXPERIENCE_OUTCOMES = ['success', 'failure', 'partial', 'unknown', 'unfinished'] as const

/** One Experience file the user can inspect. */
export interface ExperienceEntry {
  uri: string
  name: string
  description: string
  modifiedAt: string | null
}

/** One trajectory produced by a commit that read an Experience. */
export interface ExperienceTrajectory {
  uri: string
  name: string
  description: string
  createdAt: string | null
  updatedAt: string | null
}

export interface ExperienceOutcome {
  outcome: string
  count: number
}

export interface ExperiencePayload {
  kind: ExperienceKind
  /** Experience files found on the server, for the picker. */
  experiences: ExperienceEntry[]
  /** The experience the items/outcomes belong to, when one was asked for. */
  selected: string | null
  items: ExperienceTrajectory[]
  outcomes: ExperienceOutcome[]
  /** True when the experiments directory exists but holds no Experience file. */
  empty: boolean
  /** A stable code the UI translates, e.g. `no-experiences`. */
  note: string | null
  warnings: PluginNotice[]
  observedAt: string
}

export const EXPERIENCE_LIST_DEFAULT_LIMIT = 20
export const EXPERIENCE_LIST_MAX_LIMIT = 100

/* ========================================================================
 * v0.5 "Collaborate" — identity/scope (F12), curation writes (F9),
 * session control (F10), task centre + metrics (F11), write commands (F6)
 *
 * Everything here is additive. The v0.4 read routes and payloads above are
 * unchanged; the new routes live under the same API prefix and the mutation
 * routes ride `ctx.connection.fetch` (0.2.2-rc.1 authenticated transport), never
 * the loopback webServer fence.
 * ===================================================================== */

/** Error envelope for every v0.5 route: a stable code plus an English message. */
export interface OveError {
  /** One of the documented codes, e.g. `writes-disabled`, `token-expired`. */
  code: string
  /** Host messages stay English; the client maps known codes to its copy. */
  message: string
  /** Structured detail a UI may render (an undo plan, a rate-limit window, …). */
  details?: unknown
}

/** The envelope v0.5 routes return; nothing throws, so this is always the shape. */
export type OveResult<T> = ({ ok: true } & T) | { ok: false; error: OveError }

/** The identity a write is about to run as, safe to show and to persist in audit. */
export interface IdentityScope {
  /** Profile id, or null in legacy (no-profile) resolution. */
  profileId: string | null
  profileLabel: string | null
  endpoint: string
  /** Probed server auth mode (`dev` | `trusted` | `api_key` | …), null while unknown. */
  authMode: string | null
  account: string
  user: string
  peer: string | null
  /** `sha256:…` over the profile descriptor; no secrets. */
  fingerprint: string
}

/** The write actions v0.5 ships. No others exist. */
export const WRITE_ACTIONS = ['edit-memory', 'delete-memory', 'set-tags', 'force-commit'] as const
export type WriteAction = (typeof WRITE_ACTIONS)[number]

/** The actions undo can revert (force commit deliberately cannot be undone). */
export function isUndoableAction(action: string): action is 'edit-memory' | 'delete-memory' | 'set-tags' {
  return action === 'edit-memory' || action === 'delete-memory' || action === 'set-tags'
}

/** A redacted profile row: the API key is never part of any payload. */
export interface ProfileSummary {
  id: string
  label: string
  endpoint: string
  /** Configured expectation (`dev` | `trusted` | `api_key`); actual mode is probed. */
  authMode: string
  account: string
  user: string
  peerId: string | null
  /** Whether a secret is stored; the secret itself never leaves the host. */
  hasApiKey: boolean
}

export interface ProfilesPayload {
  profiles: ProfileSummary[]
  activeProfileId: string | null
  /** False when the file is absent/unreadable — the plugin keeps legacy resolution. */
  storeAvailable: boolean
  storeError: string | null
  /** The secret store of record, shown in the settings form. */
  storePath: string
  warnings: PluginNotice[]
}

/** One capability gate as the scope route reports it. */
export interface ScopeCapability {
  available: boolean
  /** A short English fact or the refusal; the client maps known codes. */
  detail: string | null
}

export interface ScopePayload {
  identity: IdentityScope
  activeProfileId: string | null
  /** Server-reported role, when the credential exposes one. */
  role: string | null
  version: string | null
  healthy: boolean
  writes: {
    /** `enableWrites` master switch (host-read live). */
    enabled: boolean
    /** `ctx.connection.fetch.register` present in this composition. */
    transport: boolean
    /** Stable code naming the first failing gate; null when writes may proceed. */
    reason: string | null
  }
  /** Per-capability answers keyed by the design's gate names. */
  capabilities: Record<string, ScopeCapability>
  warnings: PluginNotice[]
  observedAt: string
}

/** The revision a write was prepared against; shown in the dialog and checked on execute. */
export interface WriteRevision {
  /** `sha256:` + the full hex digest; the dialog shows a 12-char prefix. */
  sha256: string
  size: number
  modifiedAt: string | null
}

/** Force-commit facts read before the confirmation dialog is shown. */
export interface ForceCommitFacts {
  sessionId: string
  /** OpenViking-side session key, e.g. `dsh-<id>`. */
  ovSessionId: string
  pendingTokens: number | null
  messageCount: number | null
  commitCount: number | null
  lastCommitAt: string | null
}

/** What `/write/prepare` returns: a single-use token plus everything the dialog shows. */
export interface WritePreparePayload {
  token: string
  action: WriteAction
  /** `viking://…` URI, or the DSH session id for a force commit. */
  target: string
  scope: IdentityScope
  /** Epoch milliseconds; the token is useless afterwards. */
  expiresAt: number
  revision: WriteRevision | null
  /** Snapshot commit_oid taken before the write; null when no snapshot was needed. */
  preCommit: string | null
  /** Edit only: the current body (bounded). Never put this in logs/command text. */
  content: string | null
  contentTruncated: boolean
  beforeChars: number | null
  afterChars: number | null
  /** Set-tags: the tags read before the edit, and the requested final list. */
  tagsBefore: string[] | null
  tagsAfter: string[] | null
  /** Set-tags: `replace` (the editor's set is final), `append`, or `clear`. */
  tagMode: 'replace' | 'append' | 'clear' | null
  /** Delete: the file name the user must type to confirm. Never the body. */
  confirmWord: string | null
  /** Force commit: session facts read before the dialog. */
  session: ForceCommitFacts | null
  /** Short English lines for logs and the plain-text command fallback. */
  summary: string[]
}

/** What `/write/execute` returns after the write settled and was audited. */
export interface WriteExecutePayload {
  action: WriteAction
  target: string
  scope: IdentityScope
  /** Id of the local audit entry written for this action. */
  auditId: string
  /** Undo handle id; null for force-commit. */
  undoId: string | null
  postCommit: string | null
  /** OpenViking `x-request-id`, when the response carried one. */
  requestId: string | null
  /** Force commit: the async extraction task. */
  taskId: string | null
  task: ActivityTask | null
  /** Edit/set-tags: the revision/tags read back after the write. */
  revision: WriteRevision | null
  tags: string[] | null
  /** False means "written, verification pending" — the undo handle still exists. */
  verified: boolean
  warnings: PluginNotice[]
}

/** One path in the undo dry-run plan. */
export interface UndoPlanPath {
  path: string
  /** False when restoring this path is outside the action's own inverse set. */
  expected: boolean
}

/** The undo preview: `POST /write/plan`. Applying needs `POST /write/undo`. */
export interface WriteUndoPlan {
  undoId: string
  action: WriteAction
  target: string
  projectDir: string
  sourceCommit: string
  toWrite: UndoPlanPath[]
  toDelete: UndoPlanPath[]
  unchanged: number
  /** True when the plan touches paths the confirmed action did not change. */
  extraChanges: boolean
  /** True when this undo is a tag re-apply (no snapshot restore is involved). */
  tagsOnly: boolean
}

/** The outcome of `write/cancel`: only a still-pending token can be cancelled. */
export interface WriteCancelPayload {
  /** `cancelled` = this call freed the pending slot; `settled`/`expired` = no-op. */
  status: 'cancelled' | 'settled' | 'expired'
  /** The action the cancelled token had prepared, when it was still pending. */
  action: WriteAction | null
}

/** Result of applying an undo. */
export interface WriteUndoPayload {
  undoId: string
  action: WriteAction
  target: string
  outcome: 'restored' | 'tags-restored'
  newCommit: string | null
  taskId: string | null
  auditId: string | null
  warnings: PluginNotice[]
}

/* ---- F10: session control (read-only capture state + diagnosis) ---------- */

export interface CaptureState {
  /** Whether the official memory plugin is mounted in this profile. */
  mounted: boolean
  enabled: boolean | null
  autoCapture: boolean | null
  captureAssistantTurns: boolean | null
  captureToolResults: boolean | null
  commitTokenThreshold: number | null
  /**
   * Always false in v0.5: pausing capture needs an upstream runtime API
   * (`runtime.setCaptureEnabled(session, boolean)`) that the official plugin
   * does not expose. The UI states this instead of shipping a dead button.
   */
  canPause: false
}

export interface FailedArchiveDiagnosis {
  /** The failed archive's URI, when the newest archive is the failed one. */
  archiveUri: string | null
  taskId: string | null
  error: string | null
  state: ArchiveState | null
  /** `memory_diff.json` is written even when extraction failed; it is the audit. */
  memoryDiffUri: string | null
}

export interface SessionControlPayload {
  sessionId: string
  ovSessionId: string
  capture: CaptureState
  session: ForceCommitFacts | null
  failedArchive: FailedArchiveDiagnosis | null
  warnings: PluginNotice[]
  observedAt: string
}

/* ---- F11: task centre and metrics ---------------------------------------- */

/** A short, safe projection of a task `result`: counters and URIs only. */
export interface TaskResultSummary {
  sessionId: string | null
  archiveUri: string | null
  memoriesExtracted: { total: number | null; memoryWrite: number | null; memoryEdit: number | null } | null
  memoryDiffUri: string | null
  totalTokens: number | null
}

/** One task row as the Activity tab renders it (live server shape, flattened). */
export interface ActivityTask {
  taskId: string
  taskType: string
  status: string
  stage: string | null
  error: string | null
  /** Unix seconds, as the server sends them. */
  createdAt: number | null
  updatedAt: number | null
  processingSeconds: number | null
  resourceId: string | null
  resultSummary: TaskResultSummary | null
}

/** One execution event of a task; `GET /tasks/{id}?include_events=true`. */
export interface TaskEvent {
  seq: number
  recordedAt: number | null
  kind: string
  status: string | null
  stage: string | null
  operation: string | null
  error: string | null
}

/** One task, expanded (`GET ${API_PREFIX}/task`). */
export interface ActivityTaskDetail extends ActivityTask {
  events: TaskEvent[] | null
  eventsDropped: number | null
  result: Record<string, unknown> | null
  meta: Record<string, unknown> | null
}

/** The task types `POST /tasks/{id}/cancel` supports (live server contract). */
export const CANCELLABLE_TASK_TYPES = [
  'add_resource',
  'add_skill',
  'compile',
  'session_commit',
  'admin_reindex',
  'snapshot_restore_reindex',
] as const

/** Whether a task's status is still cooperative-cancellable. */
export function isCancellableStatus(status: string): boolean {
  return status === 'pending' || status === 'running' || status === 'cancelling'
}

export interface TaskListPayload {
  tasks: ActivityTask[]
  hasMore: boolean
  nextCursor: string | null
  /** False when this server build does not expose the task routes. */
  available: boolean
  /** A stable code the Activity tab can localize ("tasks-unavailable"). */
  note: string | null
  warnings: PluginNotice[]
  observedAt: string
}

/** The four cheap metric sources, each independently degradable. */
export interface MetricsDashboardCard {
  available: boolean
  error: string | null
  files: number | null
  skills: number | null
  memories: number | null
  total: number | null
  todayTokens: number | null
  todayRetrievals: number | null
}

export interface MetricsQueueCard {
  available: boolean
  error: string | null
  queues: Array<{ queue: string; pending: number; inProgress: number; errors: number; processed: number }>
}

export interface MetricsMemoriesCard {
  available: boolean
  error: string | null
  total: number | null
  byCategory: Record<string, number>
  hotness: Record<string, number>
  stale7d: number | null
  stale30d: number | null
  oldestDays: number | null
}

export interface MetricsSessionCard {
  available: boolean
  error: string | null
  sessionId: string | null
  totalTurns: number | null
  memoriesExtracted: number | null
}

export interface MetricsPayload {
  sessionId: string | null
  dashboard: MetricsDashboardCard
  queue: MetricsQueueCard
  memories: MetricsMemoriesCard
  session: MetricsSessionCard
  /** Always false in v0.5: Prometheus `/metrics` is disabled by default. */
  prometheus: false
  warnings: PluginNotice[]
  observedAt: string
}

/* ---- local audit trail (the plugin's JSONL file) ------------------------- */

export type AuditKind =
  | 'write'
  | 'commit'
  | 'undo'
  | 'switch'
  | 'denied'
  | 'profile'
  | 'cancel'
  /** v0.7: local onboarding-state actions (dismiss/reset/forget/…); never OpenViking. */
  | 'onboarding'

export interface AuditIdentity {
  profileId: string | null
  endpoint: string
  authMode: string | null
  account: string
  user: string
  peer: string | null
  dshSessionId: string | null
}

/** One line of `audit.jsonl`; never contains a memory body or a secret. */
export interface AuditEntry {
  id: string
  ts: string
  kind: AuditKind
  action: WriteAction | string
  target: string | null
  identity: AuditIdentity | null
  fingerprint: string | null
  /** `overlay` | `command` | `api` — where the explicit confirmation came from. */
  confirmation: string | null
  preCommit: string | null
  postCommit: string | null
  requestId: string | null
  result: 'ok' | 'failed' | 'undone' | 'denied'
  error: string | null
  undo: { kind: string; projectDir: string; sourceCommit: string } | null
}

export interface AuditPayload {
  entries: AuditEntry[]
  /** The audit file path, so the UI can say where the record lives. */
  path: string
  /** True when the file could not be read at all (missing is not an error). */
  unavailable: boolean
  warnings: PluginNotice[]
  observedAt: string
}

/** Token TTL: the confirmation is useless after two minutes. */
export const WRITE_TOKEN_TTL_MS = 120_000
/** At most this many un-settled confirmations may exist at once. */
export const WRITE_MAX_PENDING = 8
/** At most this many successful executions per window, per profile. */
export const WRITE_RATE_LIMIT = 3
export const WRITE_RATE_WINDOW_MS = 60_000
/**
 * A separate, larger quota for *confirmation preparations*.
 *
 * Every prepare takes a real snapshot commit before the user can approve it, so
 * an unmetered prepare→cancel loop can create server-side snapshot history
 * indefinitely (review round 2). Preparations are counted even when the token is
 * later cancelled; only the window, not a cancel, returns the quota.
 */
export const WRITE_PREPARE_RATE_LIMIT = 10
export const WRITE_PREPARE_RATE_WINDOW_MS = 60_000
/** Largest body the edit dialog may load/apply; the server accepts more but a
 * human review of a larger blob is not meaningful and the route stays cheap. */
export const WRITE_CONTENT_MAX_CHARS = 64 * 1024
/** Upper bound of the JSON body the mutation routes accept. */
export const WRITE_BODY_MAX_BYTES = 64 * 1024
/** Bounded task list page. */
export const ACTIVITY_TASKS_DEFAULT_LIMIT = 20
export const ACTIVITY_TASKS_MAX_LIMIT = 50
/** Bounded audit tail. */
export const AUDIT_DEFAULT_LIMIT = 20
export const AUDIT_MAX_LIMIT = 100

/** The stable error codes the design names; the client localizes known ones. */
export const WRITE_ERROR_CODES = [
  'writes-disabled',
  'transport-unavailable',
  'snapshot-unavailable',
  'profile-unhealthy',
  'identity-ambiguous',
  'target-not-curatable',
  'revision-mismatch',
  'token-expired',
  'token-used',
  'token-mismatch',
  'identity-changed',
  'rate-limited',
  'too-many-pending',
  'write-in-flight',
  'content-too-large',
  'invalid-tags',
  'invalid-request',
  'typed-confirmation-required',
  'typed-confirmation-mismatch',
  'extra-changes',
  'undo-unavailable',
  'not-found',
  'not-supported',
  'rejected-by-server',
  'verification-pending',
  'settings-unavailable',
  'invalid-body',
  'method-not-allowed',
  'forbidden',
] as const
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number]

/* ========================================================================
 * v0.7 "Native I — no iframe for reading"
 *
 * The native cockpit reads the server directly through the host: a lazy
 * `viking://` tree, a paginated session browser, a bounded recent-commit
 * fan-out, the metric cards the Activity tab already renders, a composed
 * overview and the read-only onboarding checklist. Everything here is
 * additive; every view is behind the `showNativeViews` switch and degrades per
 * part instead of failing whole.
 * ===================================================================== */

/** The browse roots the host resolves from the active identity. */
export type BrowseRootId =
  | 'memories'
  | 'peers'
  | 'resources'
  | 'myResources'
  | 'skills'
  | 'agentSkills'
  | 'rules'
  | 'sessions'

/** The ownership scope a root belongs to, for the read-only/shared badge. */
export type BrowseRootScope = 'user' | 'account' | 'agent' | 'peer'

/**
 * One root the Browse view can expand.
 *
 * Only the URI and label live here: the host resolves them from the identity, so
 * the client never hardcodes `viking://user/<user>/…`. No listing happens here;
 * each root is expanded lazily and shows its own empty state.
 */
export interface BrowseRoot {
  id: BrowseRootId
  uri: string
  /** Locale key for the root label (never customer-specific copy). */
  labelKey: string
  scope: BrowseRootScope
  /** True for a root that opens another view instead of expanding in place. */
  shortcut?: boolean
}

export interface BrowseRootsPayload {
  roots: BrowseRoot[]
  warnings: PluginNotice[]
  observedAt: string
}

/** What one tree row is, derived from its path by `viking-tree.ts`. */
export type BrowseEntryKind =
  | 'directory'
  | 'memory'
  | 'resource'
  | 'skill'
  | 'rule'
  | 'session'
  | 'archive'
  | 'agent'
  | 'file'
  | 'unknown'

/** One directory page: exactly the facts a lazy tree row renders. */
export interface BrowseEntry {
  uri: string
  /** Last path segment (the row label). */
  name: string
  isDir: boolean
  size: number | null
  modifiedAt: string | null
  /** Server abstract, capped to the documented 160 chars. */
  abstract: string | null
  tags: string[]
  kind: BrowseEntryKind
}

export interface BrowsePayload {
  uri: string
  entries: BrowseEntry[]
  hasMore: boolean
  nextOffset: number | null
  warnings: PluginNotice[]
  observedAt: string
}

/** One flattened node of the explicitly requested bounded subtree. */
export interface BrowseSubtreeEntry {
  uri: string
  /** Path relative to the requested root, as the server reported it. */
  relPath: string
  /** 0 for a direct child of the requested URI. */
  depth: number
  name: string
  isDir: boolean
  kind: BrowseEntryKind
  size: number | null
  modifiedAt: string | null
}

export interface BrowseSubtreePayload {
  uri: string
  entries: BrowseSubtreeEntry[]
  /** True when the server's node cap stopped the flattened listing. */
  truncated: boolean
  levels: number
  nodes: number
  warnings: PluginNotice[]
  observedAt: string
}

/** One row of the paginated session browser. */
export interface SessionListRow {
  /** OpenViking session key (the sessions directory entry name). */
  ovSessionId: string
  /**
   * The DSH session id when the key names one (`dsh-*`); null for another
   * harness's session, whose detail routes this plugin cannot address.
   */
  sessionId: string | null
  /** `viking://…/sessions/<ovSessionId>` */
  uri: string
  modifiedAt: string | null
  kind: 'dsh' | 'local' | 'other'
}

export interface SessionListPayload {
  items: SessionListRow[]
  hasMore: boolean
  nextOffset: number | null
  warnings: PluginNotice[]
  observedAt: string
}

/** Why the bounded recent-commit fan-out stopped early. */
export type RecentCommitsLimitedBy = 'deadline' | 'session-cap'

export interface RecentCommitsProgress {
  /** Sessions whose status read was attempted. */
  sessionsScanned: number
  elapsedMs: number
  deadlineMs: number
  sessionCap: number
}

/** One session's commit facts in the recent-commits browser. */
export interface RecentCommitRow {
  ovSessionId: string
  sessionId: string | null
  uri: string
  modifiedAt: string | null
  /** Null when the session is not addressable or its status read failed. */
  status: CommitStatus | null
  /** The newest 1–2 archives' extraction counts, newest first. */
  summaries: ArchiveSummary[]
  error: string | null
}

export interface RecentCommitsPayload {
  items: RecentCommitRow[]
  /** True when the list is usable but incomplete (deadline or session cap). */
  partial: boolean
  limitedBy: RecentCommitsLimitedBy | null
  progress: RecentCommitsProgress
  warnings: PluginNotice[]
  observedAt: string
}

/**
 * Whether the host-side probe believes Studio may be embedded.
 *
 * `unknown` is a real answer: the host deliberately does not know the GUI's own
 * origin, so an explicit CSP `frame-ancestors` origin list cannot be compared
 * against it. The Studio view keeps "open in a new tab" one click away.
 */
export type StudioFrameable = 'yes' | 'no' | 'unknown'

export type StudioStatusReason =
  | 'ok'
  | 'x-frame-options'
  | 'csp-frame-ancestors'
  | 'http-error'
  | 'auth-required'
  | 'probe-failed'

export interface StudioStatus {
  /** The Studio URL the iframe would load. */
  url: string
  frameable: StudioFrameable
  reason: StudioStatusReason
  /** A short, secret-free explanation of the classification. */
  detail: string | null
  observedAt: string
}

/** The persisted onboarding progress. Contains no endpoint, identity or memory values. */
export interface OnboardingState {
  version: 1
  /** ISO timestamp of the user's dismissal, or null while the card is shown. */
  dismissedAt: string | null
  /** Step ids the user marked done (there is no automatic completion). */
  completedStepIds: string[]
  /** When the native cockpit was last opened, for "first run" wording. */
  lastOpenedAt: string | null
  /** Counts from the last full Doctor check the user ran. */
  lastFullCheck: { at: string; ok: number; warn: number; error: number } | null
}

export type OnboardingCheckStatus = 'ok' | 'warn' | 'error' | 'skipped' | 'unknown'

/**
 * One read-only setup check.
 *
 * `id` is stable (persisted step ids use it); `labelKey`/`hintKey` are locale
 * keys so both languages are first-class; `detail` is a short server fact, never
 * an endpoint, account, key or memory body.
 */
export interface OnboardingCheck {
  id: string
  status: OnboardingCheckStatus
  labelKey: string
  hintKey: string | null
  detail: string | null
}

export interface OnboardingPayload {
  state: OnboardingState
  checks: OnboardingCheck[]
}

/** A per-part availability flag of the composed overview. */
export interface OverviewPartState {
  available: boolean
  error: string | null
}

/**
 * The mounted official memory plugin, as `/overview` reports it.
 *
 * Deliberately identity-free: the peer is a per-session runtime fact (the
 * cockpit is root-scoped and has no session), so reporting "a peer" here would
 * read as the identity's peer. The session-scoped tabs/Doctor own that display.
 */
export interface OverviewPluginFact {
  mounted: boolean
  version: string | null
}

/**
 * One composed round trip for the default view.
 *
 * Every part except `parts`/`warnings`/`observedAt` may be null: one failing
 * part degrades that card, never the page. `parts` says why.
 */
export interface OverviewPayload {
  config: EnhanceConfig | null
  scope: ScopePayload | null
  metrics: MetricsPayload | null
  plugin: OverviewPluginFact
  studio: StudioStatus | null
  onboarding: OnboardingPayload | null
  parts: {
    config: OverviewPartState
    scope: OverviewPartState
    metrics: OverviewPartState
    plugin: OverviewPartState
    studio: OverviewPartState
    onboarding: OverviewPartState
  }
  warnings: PluginNotice[]
  observedAt: string
}

/** The native cockpit's internal views. */
export type NativeViewId = 'overview' | 'browse' | 'sessions' | 'commits' | 'stats' | 'studio'

/** A deep-link target for the native cockpit (in-memory navigation history). */
export interface NativeTarget {
  view: NativeViewId
  browse?: { uri?: string }
  sessions?: { sessionId?: string; archiveUri?: string }
  commits?: { sessionId?: string }
  stats?: { sessionId?: string }
}

/** The actions the local onboarding-state route accepts. */
export const ONBOARDING_ACTIONS = ['dismiss', 'reset', 'forget', 'complete-step', 'full-check'] as const
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number]

/** The stable step ids the checklist renders (also the only ids `complete-step` accepts). */
export const ONBOARDING_STEP_IDS = [
  'endpoint',
  'health',
  'identity',
  'memoryPlugin',
  'capabilities',
  'firstStep',
] as const
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]
