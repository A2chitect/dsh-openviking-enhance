/**
 * Browser half → host half HTTP calls.
 *
 * The URL is **document-relative** on purpose: the DSH web shell serves the GUI
 * with `<base href="./">`, so a sub-path deployment (`/dsh/dsh/`) is the entry
 * directory. A root-absolute `/api/…` would escape that prefix and never reach
 * the plugin's route (the same reason `@linxin666/dsh-client-ui-task-board`
 * slices the leading slash off its prefix).
 *
 * Every call resolves; carrier problems become `{ok:false,error}` so a dead host
 * route renders an error line instead of breaking React's render pass.
 */
import {
  CLIENT_API_PREFIX,
  TIMELINE_DEFAULT,
  type ArchiveSummary,
  type ApiResult,
  type CommitStatus,
  type CommitTask,
  type EnhanceConfig,
  type MemoryDiff,
  type RecallContent,
  type RecallPayload,
} from '../shared/protocol.ts'

/** Relative base: no leading slash, so `<base href>` keeps working. */
const BASE = CLIENT_API_PREFIX

async function readJson<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, init)
    const body = (await response.json()) as ApiResult<T>
    if (!body || typeof body !== 'object' || !('ok' in body)) {
      return { ok: false, error: `unexpected response from ${url}` }
    }
    return body
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function fetchConfig(): Promise<ApiResult<EnhanceConfig>> {
  return readJson<EnhanceConfig>(`${BASE}/config`)
}

export interface StatusPayload {
  status: CommitStatus
}

export function fetchStatus(sessionId: string, fresh = false): Promise<ApiResult<StatusPayload>> {
  const suffix = fresh ? '&fresh=1' : ''
  return readJson<StatusPayload>(`${BASE}/status?sessionId=${encodeURIComponent(sessionId)}${suffix}`)
}

export interface CommitsPayload {
  status: CommitStatus
  tasks: CommitTask[]
  /** Counts for the newest archives, newest first — the timeline rows. */
  summaries: ArchiveSummary[]
}

export function fetchCommits(sessionId: string, summaryLimit = TIMELINE_DEFAULT): Promise<ApiResult<CommitsPayload>> {
  const query = `sessionId=${encodeURIComponent(sessionId)}&summaries=${summaryLimit}`
  return readJson<CommitsPayload>(`${BASE}/commits?${query}`)
}

export interface DiffPayload {
  diff: MemoryDiff | null
  pending: boolean
}

export function fetchDiff(sessionId: string, archiveUri: string): Promise<ApiResult<DiffPayload>> {
  const archive = encodeURIComponent(archiveUri)
  return readJson<DiffPayload>(`${BASE}/diff?sessionId=${encodeURIComponent(sessionId)}&archive=${archive}`)
}

export interface RecallResponse {
  recall: RecallPayload
}

/**
 * The current session's retrieval.
 *
 * `query` is left out on purpose for the common case: the host then searches for
 * the session's own most recent user turn, which is what the next recall would be
 * about.
 */
export function fetchRecall(
  sessionId: string,
  query?: string,
  options: { limit?: number; fresh?: boolean } = {},
): Promise<ApiResult<RecallResponse>> {
  const params = new URLSearchParams({ sessionId })
  const trimmed = (query ?? '').trim()
  if (trimmed.length > 0) params.set('query', trimmed)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.fresh === true) params.set('fresh', '1')
  return readJson<RecallResponse>(`${BASE}/recall?${params.toString()}`)
}

export interface RecallContentResponse {
  content: RecallContent
}

export function fetchRecallContent(uri: string): Promise<ApiResult<RecallContentResponse>> {
  return readJson<RecallContentResponse>(`${BASE}/recall/content?uri=${encodeURIComponent(uri)}`)
}
