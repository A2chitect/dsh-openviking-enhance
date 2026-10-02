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
}

/** Result of one memory-extraction phase, as recorded in `memory_diff.json`. */
export interface MemoryDiff {
  archiveUri: string
  extractedAt: string | null
  adds: MemoryDiffEntry[]
  updates: MemoryDiffEntry[]
  deletes: MemoryDiffEntry[]
  summary: { totalAdds: number; totalUpdates: number; totalDeletes: number; totalSkipped: number }
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

/** Why a commit is not finished yet; drives the spinner copy in the UI. */
export type CommitPhase = 'idle' | 'pending' | 'extracting' | 'done' | 'failed'

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
  /** Best-effort phase; see `commit-service.ts` for how it is derived. */
  phase: CommitPhase
  /** One entry per archive directory found on the server. */
  archives: CommitArchive[]
}

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
  warnings: string[]
}

/** Envelope every route returns; `ok: false` carries a message, never a throw. */
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string }
