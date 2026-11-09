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
  type ExperienceKind,
  type ExperiencePayload,
  type PreviewPayload,
  type RuleListPayload,
  type RuleSearchPayload,
  type SearchPayload,
  type SearchType,
  type SkillCatalogue,
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

/* ---- v0.4: read-only preview + Explore routes ------------------------- */

/** POST a JSON body to a read-only route. The routes refuse other media types. */
function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<ApiResult<T>> {
  return readJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

export interface PreviewResponse {
  preview: PreviewPayload
}

/**
 * One entry's metadata and L0/L1/L2.
 *
 * The host reads all three tiers in this one request, so switching tiers in the
 * panel is free and there is no per-tier loading state to race.
 */
export function fetchPreview(uri: string): Promise<ApiResult<PreviewResponse>> {
  return readJson<PreviewResponse>(`${BASE}/preview?uri=${encodeURIComponent(uri)}`)
}

export interface SearchResponse {
  search: SearchPayload
}

/** One unified search across the server's four buckets (rules included). */
export function fetchSearch(
  request: { query: string; searchType?: SearchType; buckets?: readonly string[]; limit?: number },
  signal?: AbortSignal,
): Promise<ApiResult<SearchResponse>> {
  return postJson<SearchResponse>(`${BASE}/search`, request, signal)
}

export interface RulesSearchResponse {
  rules: RuleSearchPayload
}

/**
 * The read-only rule tester: which active Rules apply to this task context?
 *
 * The input is a task description, not a search query — that is the server's
 * own contract for `rules/search`, and the panel says so where it is typed.
 */
export function fetchRulesSearch(
  taskContext: string,
  signal?: AbortSignal,
): Promise<ApiResult<RulesSearchResponse>> {
  return postJson<RulesSearchResponse>(`${BASE}/rules/search`, { taskContext }, signal)
}

export interface RulesResponse {
  list: RuleListPayload
}

export function fetchRules(signal?: AbortSignal): Promise<ApiResult<RulesResponse>> {
  return readJson<RulesResponse>(
    `${BASE}/rules`,
    signal === undefined ? undefined : { signal },
  )
}

export interface SkillsResponse {
  catalogue: SkillCatalogue
}

export function fetchSkills(signal?: AbortSignal): Promise<ApiResult<SkillsResponse>> {
  return readJson<SkillsResponse>(
    `${BASE}/skills`,
    signal === undefined ? undefined : { signal },
  )
}

export interface ExperienceResponse {
  experience: ExperiencePayload
}

/** Experiences first; when one is selected, its trajectories or outcomes. */
export function fetchExperience(
  kind: ExperienceKind,
  experienceUri?: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ApiResult<ExperienceResponse>> {
  const params = new URLSearchParams({ kind })
  if (experienceUri !== undefined && experienceUri.length > 0) params.set('experienceUri', experienceUri)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return readJson<ExperienceResponse>(
    `${BASE}/experience?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}
