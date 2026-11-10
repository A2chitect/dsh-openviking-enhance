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
