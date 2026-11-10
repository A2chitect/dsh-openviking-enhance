/**
 * The user-visible timeouts and caps, in one place.
 *
 * Two audiences read these numbers:
 *
 *  1. the host services that must actually apply them;
 *  2. the "Timeouts and limits" table in both READMEs, which is part of the host
 *     contract this release documents. `test/v06-docs.test.mjs` parses the fenced
 *     `<!-- contract:limits -->` block out of both READMEs and asserts every
 *     value here appears there, so a code change cannot silently leave the
 *     documented contract stale (and vice versa). The list in that test is also
 *     checked against every numeric export of this module, so a new limit fails
 *     the suite until it is documented.
 *
 * The values that both halves of the plugin share today live in
 * `protocol.ts` (they are part of the wire payload contract); they are
 * re-exported here so this module is the single import a reader or test needs.
 * Nothing in this file may import a host module: it is shared with the client.
 */
export {
  ACTIVITY_TASKS_MAX_LIMIT,
  AUDIT_MAX_LIMIT,
  PREVIEW_MAX_CHARS,
  WRITE_BODY_MAX_BYTES,
  WRITE_CONTENT_MAX_CHARS,
  WRITE_TOKEN_TTL_MS,
} from './protocol.ts'

/** Default deadline for one OpenViking HTTP request when the caller names none. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
/** `/health` is a liveness probe: it must answer quickly or not at all. */
export const HEALTH_TIMEOUT_MS = 4_000
/** Cheap read probes: status, system status, skills, observer, tasks, stats. */
export const STATUS_TIMEOUT_MS = 5_000
/** Filesystem and content reads (`fs/ls`, `fs/stat`, `content/read`, …). */
export const FS_TIMEOUT_MS = 8_000
/** Unified `search/search` in list mode (the Explore box). */
export const LIST_SEARCH_TIMEOUT_MS = 12_000
/** `search/search` in context mode: the server runs expansion/rewrite stages. */
export const CONTEXT_SEARCH_TIMEOUT_MS = 20_000
/** One memory body read for the recall content route. */
export const RECALL_CONTENT_TIMEOUT_MS = 10_000
/** Writes (`content/write`, `fs` delete/mv/cp) wait for the server to persist. */
export const WRITE_TIMEOUT_MS = 20_000
/** Tag writes are metadata-only and should be quicker. */
export const SET_TAGS_TIMEOUT_MS = 10_000
/** Snapshot commit/restore can move a whole workspace. */
export const SNAPSHOT_TIMEOUT_MS = 30_000
/** How long the capability service trusts one rules-route probe answer. */
export const RULES_CAPABILITY_TTL_MS = 10 * 60_000
/** The Doctor's context-face probe. */
export const DOCTOR_CONTEXT_PROBE_TIMEOUT_MS = 10_000
/** The Doctor's cheap rule-route probe (validation-only POST `{}`). */
export const DOCTOR_RULES_PROBE_TIMEOUT_MS = 8_000
/** The Doctor's `fs/stat` probe. */
export const DOCTOR_FS_PROBE_TIMEOUT_MS = 5_000

/** Total deadline for one Rules listing (S1): stop scheduling past this. */
export const RULE_LIST_DEADLINE_MS = 15_000
/** How many catalogue requests one Rules listing may have in flight (S1). */
export const RULE_LIST_CONCURRENCY = 4

/** L2 lines requested per preview page; the rest is paged on demand. */
export const PREVIEW_BODY_MAX_LINES = 400
/** Largest L2 page a preview route hands back in one response. */
export const PREVIEW_BODY_MAX_LINES_RESPONSE = 1_000

/** Audit log rotation cap; older rotations are kept as `.1`, `.2`. */
export const AUDIT_MAX_BYTES = 1024 * 1024
/** How many rotated audit files are kept. */
export const AUDIT_KEEP_ROTATIONS = 2

/* ========================================================================
 * v0.7 "Native I" — native read cockpit budgets
 *
 * These are the user-perceived speed/load contract for the native views: a
 * directory page is 50 rows with 160-char abstracts and tags; sessions page 50
 * at a time; the recent-commit fan-out is capped at 8 sessions, 4 in flight and
 * a 10 s deadline; caches are short and explicit. `test/v06-docs.test.mjs`
 * asserts every value below appears in both README limit tables.
 * ===================================================================== */

/** Tree page size: rows per `/browse` request (`fs/ls` node_limit). */
export const BROWSE_PAGE_SIZE = 50
/** Per-entry abstract cap in the tree (server `abs_limit`). */
export const BROWSE_ABSTRACT_MAX_CHARS = 160
/** The explicit "expand subtree" action never walks deeper than this. */
export const BROWSE_SUBTREE_MAX_LEVELS = 2
/** The explicit "expand subtree" action never returns more than this many nodes. */
export const BROWSE_SUBTREE_MAX_NODES = 100
/** One directory page is reused this long (in-flight requests are deduped). */
export const BROWSE_CACHE_TTL_MS = 15_000
/** At most this many directories are cached (LRU eviction after this). */
export const BROWSE_CACHE_MAX_DIRECTORIES = 100

/** Sessions browser page size (the server's `/sessions` list has no pagination). */
export const SESSIONS_PAGE_SIZE = 50
/** One sessions-directory page is reused this long (`fresh=1` bypasses it). */
export const SESSION_LIST_CACHE_TTL_MS = 15_000

/** How many sessions the recent-commits browser fans out over. */
export const RECENT_COMMITS_SESSION_CAP = 8
/** How many of that fan-out's reads may be in flight at once. */
export const RECENT_COMMITS_CONCURRENCY = 4
/** Total wall-clock budget for one recent-commits answer. */
export const RECENT_COMMITS_DEADLINE_MS = 10_000
/** One recent-commits answer is reused this long; the view is never polled. */
export const RECENT_COMMITS_CACHE_TTL_MS = 30_000

/** The composed `/overview` answer is reused this long. */
export const OVERVIEW_CACHE_TTL_MS = 5_000

/** The Studio frameability probe's request timeout. */
export const STUDIO_STATUS_TIMEOUT_MS = 4_000
/** One Studio frameability answer is reused this long. */
export const STUDIO_STATUS_TTL_MS = 60_000

/** In-panel navigation history is bounded to this many targets. */
export const NATIVE_HISTORY_MAX = 20

/* ========================================================================
 * v0.8 "Operate" — controlled-action and operational-read budgets
 *
 * The confirmation-store constants (token TTL, pending cap, prepare/execute
 * quotas) live in `protocol.ts` because they are part of the operation wire
 * contract; they are re-exported here so this module stays the one import a
 * reader or the README-contract test needs. Everything below is host-side.
 * ===================================================================== */

export {
  OPS_MAX_PENDING,
  OPS_PREPARE_RATE_LIMIT,
  OPS_PREPARE_RATE_WINDOW_MS,
  OPS_RATE_LIMIT,
  OPS_RATE_WINDOW_MS,
  OPS_TOKEN_TTL_MS,
} from './protocol.ts'

/** Largest `.ovpack` the host will stream into its private temp file (64 MiB). */
export const PACK_MAX_BYTES = 64 * 1024 * 1024
/** One-time download token lifetime; the temp file lives at most this long. */
export const PACK_DOWNLOAD_TTL_MS = 120_000
/** At most this many exported temp files may exist at once (all 0600). */
export const PACK_DOWNLOAD_MAX_ACTIVE = 2
/** A pack export can run long; the host request is bounded by this deadline. */
export const OPS_EXPORT_TIMEOUT_MS = 120_000
/** How long one pack-export capability probe answer is trusted. */
export const PACK_CAPABILITY_TTL_MS = 10 * 60_000

/** Snapshot history page size and the server-side cap the route enforces. */
export const SNAPSHOT_LOG_PAGE = 20
export const SNAPSHOT_LOG_MAX = 100
/** Cap on the file-at-commit text preview (bytes before truncation). */
export const SNAPSHOT_SHOW_MAX_BYTES = 65_536
/** Cap on one displayed diff (characters), independent of the server's limits. */
export const SNAPSHOT_DIFF_MAX_CHARS = 200_000
/** Most paths one commit/log filter may name. */
export const SNAPSHOT_PATHS_MAX = 16
/** Dry-run restore plans show this many rows (counts stay honest). */
export const SNAPSHOT_RESTORE_PLAN_PATHS = 50
/** Changed-paths page default/max (server allows up to 1000). */
export const SNAPSHOT_DIFF_PATHS_PAGE = 100
/** Per-file version history page (server cap 100). */
export const FILE_VERSIONS_PAGE = 20

/** Bounded compile reads. */
export const COMPILE_CONFIGS_MAX = 50
export const COMPILE_OPERATIONS_PAGE = 20
export const COMPILE_OUTPUTS_PAGE = 50
/** Most `from` URIs one manual compile may name. */
export const COMPILE_FROM_MAX = 8
/** Manual compile `skill` name length bound (a skill URI path). */
export const COMPILE_SKILL_MAX_CHARS = 128
/** Manual compile instruction length bound. */
export const COMPILE_INSTRUCTION_MAX_CHARS = 500

/** How long one observability answer is reused; the view is never polled. */
export const OBSERVABILITY_CACHE_TTL_MS = 30_000
/** Range bound for the tokens / context-commit series (days). */
export const OBSERVABILITY_MAX_DAYS = 7

/** Exported task-evidence JSON bound (bytes). */
export const TASK_EVIDENCE_MAX_BYTES = 524_288
/** Correlation arrays are capped at this many rows each in the evidence. */
export const TASK_EVIDENCE_CORRELATION_MAX = 20

/* ========================================================================
 * v0.8 PR #6 review round 1 — bounded fan-out / body deadlines and caps
 * ===================================================================== */

/** Display cap for a snapshot commit message (shared by prepare + rendering). */
export const SNAPSHOT_MESSAGE_MAX_CHARS = 200
/** A pack export body must make progress within this window or it is aborted. */
export const PACK_BODY_INACTIVITY_TIMEOUT_MS = 30_000
/** Overall deadline for one task-evidence server-request-log fan-out. */
export const EVIDENCE_LOOKUP_DEADLINE_MS = 15_000

/* ========================================================================
 * v0.9 "Native II — multi-scope" — scope persistence, probes and read-only
 * ACL budgets
 *
 * A scope is the active profile + optional identity override; the riskiest
 * code is the state file, the probe cache and the request routing. The values
 * below are the documented contract for the scope menu/Doctor and
 * `test/v06-docs.test.mjs` asserts each one appears in both README tables.
 * ===================================================================== */

/** The `scope-state.json` schema version (the header `version` field). */
export const SCOPE_STATE_VERSION = 1
/**
 * v0.9 ships the approved **clear-all-on-switch** cache policy: no per-scope
 * cache set is retained after a scope switch, so there is no retained-set bound
 * to advertise. (The design allowed a two-set LRU as the faster alternative; it
 * was not implemented, and the docs no longer claim it.)
 */
/** How long one scope health/capability summary is trusted in the menu. */
export const SCOPE_PROBE_TTL_MS = 10_000
/** `/scopes` probes at most this many configured servers concurrently (S9). */
export const SCOPE_PROBES_CONCURRENCY = 4
/** Overall deadline for one `/scopes` probe pass; late answers keep cached rows. */
export const SCOPE_PROBES_DEADLINE_MS = 8_000
/** A second switch in this window is refused as a double-click. */
export const SCOPE_SWITCH_COOLDOWN_MS = 1_000
/** Bounded local DSH-session → scope map entries (LRU). */
export const SESSION_SCOPE_MAP_MAX = 64
/** Longest accepted scope key in a request header (the fingerprint is 71 chars). */
export const SCOPE_KEY_MAX_CHARS = 200
/** Longest accepted `viking://` URI on the ACL route. */
export const ACL_URI_MAX_CHARS = 4096
/** Bounded ACL rows per table (direct/inherited/effective) in one answer. */
export const ACL_ENTRIES_MAX = 200
/** The cheap `GET /health` timeout used for per-scope menu health. */
export const SCOPE_HEALTH_TIMEOUT_MS = 4_000
