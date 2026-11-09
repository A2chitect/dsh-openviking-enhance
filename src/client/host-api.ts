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
  type DoctorReport,
  type EnhanceConfig,
  type MemoryDiff,
  type RecallContent,
  type RecallExplanation,
  type RecallPayload,
  type RecallQuerySource,
  type SessionMemoryLog,
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

export interface CommitsOptions {
  /** Bypass the host's short status cache for a user-triggered refresh. */
  fresh?: boolean
  /** Cancel the request when the session changes or the pill unmounts. */
  signal?: AbortSignal
}

export function fetchCommits(
  sessionId: string,
  summaryLimit = TIMELINE_DEFAULT,
  options: CommitsOptions = {},
): Promise<ApiResult<CommitsPayload>> {
  const params = new URLSearchParams({ sessionId, summaries: String(summaryLimit) })
  if (options.fresh === true) params.set('fresh', '1')
  return readJson<CommitsPayload>(
    `${BASE}/commits?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
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

export interface ProbePayload {
  reachable: boolean
  version: string | null
  error: string | null
}

/**
 * Test one candidate endpoint before it is saved.
 *
 * The host refuses anything that is not loopback, so this cannot be turned into
 * a general-purpose fetch of an arbitrary address.
 */
export function probeEndpoint(endpoint: string): Promise<ApiResult<ProbePayload>> {
  return readJson<ProbePayload>(`${BASE}/probe?endpoint=${encodeURIComponent(endpoint)}`)
}

export interface RecallContentResponse {
  content: RecallContent
}

export function fetchRecallContent(uri: string): Promise<ApiResult<RecallContentResponse>> {
  return readJson<RecallContentResponse>(`${BASE}/recall/content?uri=${encodeURIComponent(uri)}`)
}

export interface ExplainResponse {
  explanation: RecallExplanation
}

/**
 * Explain one recall for a turn.
 *
 * The prompt is sent explicitly because the turn tail knows it; without one the
 * host falls back to the session's latest captured prompt. `source` only labels
 * where the text came from — the host does not trust it for anything else.
 */
export function fetchRecallExplain(
  sessionId: string,
  query: string,
  options: { source?: RecallQuerySource; fresh?: boolean; signal?: AbortSignal } = {},
): Promise<ApiResult<ExplainResponse>> {
  const params = new URLSearchParams({ sessionId })
  const trimmed = query.trim()
  if (trimmed.length > 0) params.set('query', trimmed)
  if (options.source !== undefined) params.set('source', options.source)
  if (options.fresh === true) params.set('fresh', '1')
  return readJson<ExplainResponse>(
    `${BASE}/recall/explain?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface SessionLogResponse {
  log: SessionMemoryLog
}

export function fetchSessionLog(
  sessionId: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<ApiResult<SessionLogResponse>> {
  const params = new URLSearchParams({ sessionId })
  if (options.fresh === true) params.set('fresh', '1')
  return readJson<SessionLogResponse>(
    `${BASE}/session-log?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface DoctorResponse {
  report: DoctorReport
}

/**
 * The Doctor snapshot. `probe=1` asks the server to exercise its optional
 * capabilities; the Plugins-page summary omits it and stays a cheap read.
 */
export function fetchDoctor(
  sessionId?: string,
  options: { probe?: boolean; signal?: AbortSignal } = {},
): Promise<ApiResult<DoctorResponse>> {
  const params = new URLSearchParams()
  if (sessionId !== undefined && sessionId.length > 0) params.set('sessionId', sessionId)
  if (options.probe === true) params.set('probe', '1')
  const suffix = params.toString()
  return readJson<DoctorResponse>(
    `${BASE}/doctor${suffix.length > 0 ? `?${suffix}` : ''}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}
