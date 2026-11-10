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
  type ActivityTask,
  type ActivityTaskDetail,
  type AuditEntry,
  type CaptureState,
  type FailedArchiveDiagnosis,
  type ForceCommitFacts,
  type MetricsPayload,
  type OveResult,
  type PluginNotice,
  type ProfileSummary,
  type ProfilesPayload,
  type ScopePayload,
  type WriteAction,
  type WriteCancelPayload,
  type WriteExecutePayload,
  type WritePreparePayload,
  type WriteUndoPayload,
  type WriteUndoPlan,
  type ExperienceKind,
  type ExperiencePayload,
  type PreviewPayload,
  type RuleListPayload,
  type RuleSearchPayload,
  type SearchPayload,
  type SearchType,
  type SkillCatalogue,
  type BrowsePayload,
  type BrowseRootsPayload,
  type BrowseSubtreePayload,
  type OverviewPayload,
  type RecentCommitsPayload,
  type SessionListPayload,
  type StudioStatus,
  type OnboardingState,
  type OnboardingAction,
  type CompileCapabilities,
  type CompileOperationPayload,
  type CompileOperationsPayload,
  type CompileOutputsPayload,
  type CompileSubmissionPayload,
  type CompileTargetPayload,
  type CompileTargetsPayload,
  type DiffPathsPayload,
  type FileVersionsPayload,
  type ObservabilityPayload,
  type OpsAction,
  type OpsCancelPayload,
  type OpsExecutePayload,
  type OpsPreparePayload,
  type OpsUndoPayload,
  type OpsUndoPlan,
  type PackHistoryPayload,
  type SnapshotDiffPayload,
  type SnapshotIgnorePayload,
  type SnapshotLogPayload,
  type SnapshotShowPayload,
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
 * One entry's metadata and L0/L1, plus one bounded L2 page.
 *
 * The host reads all three tiers in this one request, so switching tiers in the
 * panel is free; L2 is paged by line offset so a large file is never downloaded
 * whole on the first open.
 */
export function fetchPreview(
  uri: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ApiResult<PreviewResponse>> {
  const params = new URLSearchParams({ uri })
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return readJson<PreviewResponse>(`${BASE}/preview?${params.toString()}`)
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

/* ========================================================================
 * v0.5 routes: identity/scope, activity, audit and the authenticated
 * mutation transport
 *
 * The mutation calls are POSTs to the SAME document-relative API prefix: in the
 * 0.2.2-rc.1 composition those paths are served by `ctx.connection.fetch`, which
 * authenticates the request before our handler sees it. There is no secret in
 * these bodies except the confirmation token, which is single-use and short-TTL.
 * ===================================================================== */

/** Parse a v0.5 envelope (`{ok:true, …}` or `{ok:false, error:{code,message}}`). */
async function readOve<T>(url: string, init?: RequestInit): Promise<OveResult<T>> {
  try {
    const response = await fetch(url, init)
    const body = (await response.json()) as OveResult<T>
    if (body === null || typeof body !== 'object' || !('ok' in body)) {
      return { ok: false, error: { code: 'unexpected-response', message: `unexpected response from ${url}` } }
    }
    return body
  } catch (error) {
    return {
      ok: false,
      error: { code: 'transport-error', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/** POST one JSON body to a mutation route. */
function postOve<T>(url: string, body: unknown, signal?: AbortSignal): Promise<OveResult<T>> {
  return readOve<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

export interface ScopeResponse {
  scope: ScopePayload
}

/** The active identity, health, capability map and the write gates. */
export function fetchScope(fresh = false): Promise<OveResult<ScopeResponse>> {
  return readOve<ScopeResponse>(`${BASE}/scope${fresh ? '?fresh=1' : ''}`)
}

export interface ProfilesResponse {
  profiles: ProfilesPayload
}

/** The redacted profile list (never an API key). */
export function fetchProfiles(): Promise<OveResult<ProfilesResponse>> {
  return readOve<ProfilesResponse>(`${BASE}/profiles`)
}

export interface TasksResponse {
  tasks: ActivityTask[]
  hasMore: boolean
  nextCursor: string | null
  available: boolean
  note: string | null
  warnings: PluginNotice[]
  observedAt: string
}

export function fetchTasks(
  filters: { taskType?: string; status?: string; limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<OveResult<TasksResponse>> {
  const params = new URLSearchParams()
  if (filters.taskType !== undefined && filters.taskType.length > 0) params.set('taskType', filters.taskType)
  if (filters.status !== undefined && filters.status.length > 0) params.set('status', filters.status)
  if (filters.cursor !== undefined && filters.cursor.length > 0) params.set('cursor', filters.cursor)
  if (filters.limit !== undefined) params.set('limit', String(filters.limit))
  const suffix = params.toString()
  return readOve<TasksResponse>(
    `${BASE}/tasks${suffix.length > 0 ? `?${suffix}` : ''}`,
    signal === undefined ? undefined : { signal },
  )
}

export interface TaskDetailResponse {
  task: ActivityTaskDetail
}

export function fetchTaskDetail(
  taskId: string,
  events = true,
  signal?: AbortSignal,
): Promise<OveResult<TaskDetailResponse>> {
  const params = new URLSearchParams({ taskId })
  if (events) params.set('events', '1')
  return readOve<TaskDetailResponse>(
    `${BASE}/task?${params.toString()}`,
    signal === undefined ? undefined : { signal },
  )
}

/** The attachment URL for one task export; put it on an `<a download>` element. */
export function taskExportUrl(taskId: string): string {
  return `${BASE}/task/export?taskId=${encodeURIComponent(taskId)}`
}

export interface MetricsResponse {
  metrics: MetricsPayload
}

export function fetchMetrics(
  sessionId?: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<OveResult<MetricsResponse>> {
  const params = new URLSearchParams()
  if (sessionId !== undefined && sessionId.length > 0) params.set('sessionId', sessionId)
  if (options.fresh === true) params.set('fresh', '1')
  const suffix = params.toString()
  return readOve<MetricsResponse>(
    `${BASE}/metrics${suffix.length > 0 ? `?${suffix}` : ''}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface AuditResponse {
  entries: AuditEntry[]
  path: string
  unavailable: boolean
  warnings: PluginNotice[]
  observedAt: string
}

export interface AuditFilters {
  kind?: string
  action?: string
  taskId?: string
  operationId?: string
}

export function fetchAudit(
  limit = 20,
  signal?: AbortSignal,
  filters: AuditFilters = {},
): Promise<OveResult<AuditResponse>> {
  const params = new URLSearchParams({ limit: String(limit) })
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value)
  }
  return readOve<AuditResponse>(
    `${BASE}/audit?${params.toString()}`,
    signal === undefined ? undefined : { signal },
  )
}

export interface SessionControlResponse {
  sessionId: string
  ovSessionId: string
  capture: CaptureState
  session: ForceCommitFacts | null
  failedArchive: FailedArchiveDiagnosis | null
  warnings: PluginNotice[]
  observedAt: string
}

export function fetchSessionControl(
  sessionId: string,
  signal?: AbortSignal,
): Promise<OveResult<SessionControlResponse>> {
  return readOve<SessionControlResponse>(
    `${BASE}/session-control?sessionId=${encodeURIComponent(sessionId)}`,
    signal === undefined ? undefined : { signal },
  )
}

/* ---- mutations (authenticated `ctx.connection.fetch` routes) -------------- */

export interface PrepareWriteRequest {
  action: WriteAction
  target: string
  sessionId?: string
  tags?: string[]
  tagMode?: 'replace' | 'append' | 'clear'
}

/** Step 1: snapshot + single-use token + everything the dialog renders. */
export function prepareWrite(request: PrepareWriteRequest): Promise<OveResult<WritePreparePayload>> {
  return postOve<WritePreparePayload>(`${BASE}/write/prepare`, request)
}

export interface ExecuteWriteRequest {
  token: string
  content?: string
  tags?: string[]
  tagMode?: 'replace' | 'append' | 'clear'
  typed?: string
}

/** Step 2: perform the confirmed write, verify, post-commit and audit. */
export function executeWrite(request: ExecuteWriteRequest): Promise<OveResult<WriteExecutePayload>> {
  return postOve<WriteExecutePayload>(`${BASE}/write/execute`, request)
}

/**
 * Release a confirmation the user dismissed (dialog closed/Escape/Cancel).
 *
 * The host only frees a still-pending token; a settled one is an idempotent
 * no-op, so callers can send this without checking the outcome.
 */
export function cancelWrite(token: string): Promise<OveResult<WriteCancelPayload>> {
  return postOve<WriteCancelPayload>(`${BASE}/write/cancel`, { token })
}

/** The undo dry-run plan (no mutation). */
export function planUndo(undoId: string): Promise<OveResult<{ plan: WriteUndoPlan }>> {
  return postOve<{ plan: WriteUndoPlan }>(`${BASE}/write/plan`, { undoId })
}

/** Apply the undo; `confirmExtra` after the user approves an extra-changes plan. */
export function applyUndo(undoId: string, confirmExtra = false): Promise<OveResult<WriteUndoPayload>> {
  return postOve<WriteUndoPayload>(`${BASE}/write/undo`, { undoId, confirmExtra })
}

export function cancelTask(taskId: string): Promise<OveResult<{ task: ActivityTask }>> {
  return postOve<{ task: ActivityTask }>(`${BASE}/task/cancel`, { taskId })
}

export interface SaveProfileRequest {
  id: string
  label: string
  endpoint: string
  authMode: string
  /** Absent keeps the stored key; an empty string clears it. */
  apiKey?: string
  account: string
  user: string
  peerId: string
}

export function saveProfile(request: SaveProfileRequest): Promise<OveResult<{ profiles: ProfileSummary[] }>> {
  return postOve<{ profiles: ProfileSummary[] }>(`${BASE}/profiles/save`, request)
}

export function deleteProfileRequest(id: string): Promise<OveResult<{ profiles: ProfileSummary[] }>> {
  return postOve<{ profiles: ProfileSummary[] }>(`${BASE}/profiles/delete`, { id })
}

export interface ProfileTestResponse {
  reachable: boolean
  version: string | null
  authMode: string | null
  error: string | null
}

/** Reachability test for a candidate endpoint; never sends a stored key. */
export function testProfileEndpoint(endpoint: string): Promise<OveResult<ProfileTestResponse>> {
  return postOve<ProfileTestResponse>(`${BASE}/profiles/test`, { endpoint })
}

/* ========================================================================
 * v0.7 native cockpit routes
 *
 * All read routes use the v0.5 Ove envelope (`{ok:true, …}` / `{ok:false,
 * error:{code,message}}`) and every helper accepts an AbortSignal, because the
 * views cancel in-flight reads on view change, collapse and identity switch.
 * The one POST writes the plugin's own onboarding state file; it never reaches
 * OpenViking.
 * ===================================================================== */

export interface OverviewResponse {
  overview: OverviewPayload
}

/** One composed round trip for the default native Overview. */
export function fetchOverview(fresh = false, signal?: AbortSignal): Promise<OveResult<OverviewResponse>> {
  return readOve<OverviewResponse>(
    `${BASE}/overview${fresh ? '?fresh=1' : ''}`,
    signal === undefined ? undefined : { signal },
  )
}

/** The identity-aware browse roots; no listing happens in this call. */
export function fetchBrowseRoots(fresh = false, signal?: AbortSignal): Promise<OveResult<BrowseRootsPayload>> {
  return readOve<BrowseRootsPayload>(
    `${BASE}/browse/roots${fresh ? '?fresh=1' : ''}`,
    signal === undefined ? undefined : { signal },
  )
}

export interface BrowsePageResponse {
  page: BrowsePayload
}

/** One directory page of the lazy tree. */
export function fetchBrowsePage(
  uri: string,
  options: { offset?: number; limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
): Promise<OveResult<BrowsePageResponse>> {
  const params = new URLSearchParams({ uri })
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.fresh === true) params.set('fresh', '1')
  return readOve<BrowsePageResponse>(
    `${BASE}/browse?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface BrowseSubtreeResponse {
  subtree: BrowseSubtreePayload
}

/** The explicit bounded "expand subtree" action (≤2 levels, ≤100 nodes). */
export function fetchBrowseSubtree(
  uri: string,
  options: { levels?: number; nodes?: number; signal?: AbortSignal } = {},
): Promise<OveResult<BrowseSubtreeResponse>> {
  const params = new URLSearchParams({ uri })
  if (options.levels !== undefined) params.set('levels', String(options.levels))
  if (options.nodes !== undefined) params.set('nodes', String(options.nodes))
  return readOve<BrowseSubtreeResponse>(
    `${BASE}/browse/subtree?${params.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface SessionsPageResponse {
  sessions: SessionListPayload
}

/** One page of session directories (the server's own list has no pagination). */
export function fetchSessionsPage(
  options: { offset?: number; limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
): Promise<OveResult<SessionsPageResponse>> {
  const params = new URLSearchParams()
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.fresh === true) params.set('fresh', '1')
  const suffix = params.toString()
  return readOve<SessionsPageResponse>(
    `${BASE}/sessions${suffix.length > 0 ? `?${suffix}` : ''}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface RecentCommitsResponse {
  recent: RecentCommitsPayload
}

/** The bounded recent-commit fan-out (≤8 sessions, 10 s deadline, 30 s cache). */
export function fetchRecentCommits(
  options: { limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
): Promise<OveResult<RecentCommitsResponse>> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.fresh === true) params.set('fresh', '1')
  const suffix = params.toString()
  return readOve<RecentCommitsResponse>(
    `${BASE}/recent-commits${suffix.length > 0 ? `?${suffix}` : ''}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  )
}

export interface StudioStatusResponse {
  studio: StudioStatus
}

/** The host-side frameability probe (never a browser-side guess). */
export function fetchStudioStatus(fresh = false, signal?: AbortSignal): Promise<OveResult<StudioStatusResponse>> {
  return readOve<StudioStatusResponse>(
    `${BASE}/studio-status${fresh ? '?fresh=1' : ''}`,
    signal === undefined ? undefined : { signal },
  )
}

export interface OnboardingStateRequest {
  action: OnboardingAction
  stepId?: string
  ok?: number
  warn?: number
  error?: number
}

export interface OnboardingStateResponse {
  state: OnboardingState
  writeError: string | null
}

/** Persist one onboarding checklist action (dismiss/reset/complete-step/full-check). */
export function postOnboardingState(request: OnboardingStateRequest): Promise<OveResult<OnboardingStateResponse>> {
  return postOve<OnboardingStateResponse>(`${BASE}/onboarding/state`, request)
}


/* ========================================================================
 * v0.8 "Operate" — read routes, the ops mutation family and the download
 *
 * The read helpers keep the v0.5/v0.7 shape: document-relative URL, abortable,
 * every failure an envelope. The mutation helpers ride the SAME authenticated
 * transport routes as v0.5 writes (`ctx.connection.fetch`), never a loopback
 * POST. The one binary surface is the pack download: a normal fetch of the
 * one-time GET, turned into a client-side anchor download so the browser never
 * persists a capability URL.
 * ===================================================================== */

export type SnapshotLogResponse = SnapshotLogPayload
export type SnapshotShowResponse = SnapshotShowPayload
export type SnapshotDiffResponse = SnapshotDiffPayload
export type SnapshotDiffPathsResponse = DiffPathsPayload
export type SnapshotVersionsResponse = FileVersionsPayload
export type SnapshotIgnoreResponse = SnapshotIgnorePayload

export function fetchSnapshotLog(
  input: { branch?: string; paths?: string[]; limit?: number } = {},
  signal?: AbortSignal,
): Promise<OveResult<SnapshotLogResponse>> {
  const params = new URLSearchParams()
  if (input.branch !== undefined && input.branch.length > 0) params.set('branch', input.branch)
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  for (const path of input.paths ?? []) params.append('paths', path)
  return readOve<SnapshotLogResponse>(`${BASE}/snapshot-log?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchSnapshotShow(
  ref: string,
  path: string | null,
  signal?: AbortSignal,
): Promise<OveResult<SnapshotShowResponse>> {
  const params = new URLSearchParams({ ref })
  if (path !== null && path.length > 0) params.set('path', path)
  return readOve<SnapshotShowResponse>(`${BASE}/snapshot-show?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchSnapshotDiff(
  input: { path: string; from: string | null; to: string },
  signal?: AbortSignal,
): Promise<OveResult<SnapshotDiffResponse>> {
  const params = new URLSearchParams({ path: input.path, to: input.to })
  if (input.from !== null && input.from.length > 0) params.set('from', input.from)
  return readOve<SnapshotDiffResponse>(`${BASE}/snapshot-diff?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchSnapshotDiffPaths(
  input: { paths: string[]; from: string | null; to: string; offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<OveResult<SnapshotDiffPathsResponse>> {
  const params = new URLSearchParams({ to: input.to })
  for (const path of input.paths) params.append('paths', path)
  if (input.from !== null && input.from.length > 0) params.set('from', input.from)
  if (input.offset !== undefined) params.set('offset', String(input.offset))
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  return readOve<SnapshotDiffPathsResponse>(`${BASE}/snapshot-diff-paths?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchSnapshotVersions(
  input: { uri: string; limit?: number; beforeVersion?: string | null },
  signal?: AbortSignal,
): Promise<OveResult<SnapshotVersionsResponse>> {
  const params = new URLSearchParams({ uri: input.uri })
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.beforeVersion !== undefined && input.beforeVersion !== null && input.beforeVersion.length > 0) {
    params.set('beforeVersion', input.beforeVersion)
  }
  return readOve<SnapshotVersionsResponse>(`${BASE}/snapshot-versions?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchSnapshotIgnore(signal?: AbortSignal): Promise<OveResult<SnapshotIgnoreResponse>> {
  return readOve<SnapshotIgnoreResponse>(`${BASE}/snapshot-ignore`, signal === undefined ? undefined : { signal })
}

export interface CompileResponse {
  capabilities: CompileCapabilities
  targets: CompileTargetsPayload
}

export function fetchCompile(signal?: AbortSignal): Promise<OveResult<CompileResponse>> {
  return readOve<CompileResponse>(`${BASE}/compile`, signal === undefined ? undefined : { signal })
}

export function fetchCompileTarget(to: string, signal?: AbortSignal): Promise<OveResult<CompileTargetPayload>> {
  return readOve<CompileTargetPayload>(`${BASE}/compile-target?to=${encodeURIComponent(to)}`, signal === undefined ? undefined : { signal })
}

export function fetchCompileOperations(
  input: { to: string; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<OveResult<CompileOperationsPayload>> {
  const params = new URLSearchParams({ to: input.to })
  if (input.cursor !== undefined && input.cursor !== null && input.cursor.length > 0) params.set('cursor', input.cursor)
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  return readOve<CompileOperationsPayload>(`${BASE}/compile-operations?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchCompileOperation(
  input: { to: string; operationId: string },
  signal?: AbortSignal,
): Promise<OveResult<CompileOperationPayload>> {
  const params = new URLSearchParams({ to: input.to, operationId: input.operationId })
  return readOve<CompileOperationPayload>(`${BASE}/compile-operation?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchCompileOutputs(
  input: { to: string; operationId: string; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<OveResult<CompileOutputsPayload>> {
  const params = new URLSearchParams({ to: input.to, operationId: input.operationId })
  if (input.cursor !== undefined && input.cursor !== null && input.cursor.length > 0) params.set('cursor', input.cursor)
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  return readOve<CompileOutputsPayload>(`${BASE}/compile-outputs?${params.toString()}`, signal === undefined ? undefined : { signal })
}

export function fetchCompileSubmission(key: string, signal?: AbortSignal): Promise<OveResult<CompileSubmissionPayload>> {
  return readOve<CompileSubmissionPayload>(`${BASE}/compile-submission?key=${encodeURIComponent(key)}`, signal === undefined ? undefined : { signal })
}

export function fetchObservability(
  input: { days?: number; fresh?: boolean } = {},
  signal?: AbortSignal,
): Promise<OveResult<ObservabilityPayload>> {
  const params = new URLSearchParams()
  if (input.days !== undefined) params.set('days', String(input.days))
  if (input.fresh === true) params.set('fresh', '1')
  const suffix = params.toString().length === 0 ? '' : `?${params.toString()}`
  return readOve<ObservabilityPayload>(`${BASE}/observability${suffix}`, signal === undefined ? undefined : { signal })
}

export interface PackHistoryResponse {
  history: PackHistoryPayload
}

export function fetchPackHistory(signal?: AbortSignal): Promise<OveResult<PackHistoryResponse>> {
  return readOve<PackHistoryResponse>(`${BASE}/pack/history`, signal === undefined ? undefined : { signal })
}

/** The evidence attachment URL; opened as an anchor (a download, not a JSON read). */
export function taskEvidenceUrl(taskId: string): string {
  return `${BASE}/task/evidence?taskId=${encodeURIComponent(taskId)}`
}

/* ---- ops mutations (authenticated `ctx.connection.fetch` routes) --------- */

export interface OpsPrepareRequest {
  action: OpsAction
  message?: string
  paths?: string[]
  projectDir?: string
  sourceCommit?: string
  to?: string
  from?: string[]
  skill?: string
  instruction?: string
  configuredTarget?: string
  uri?: string
  includeVectors?: boolean
  restoreVersion?: string
  currentVersion?: string
}

/** Step 1: gates + dry-run/read + a single-use token and the human plan. */
export function prepareOps(request: OpsPrepareRequest): Promise<OveResult<OpsPreparePayload>> {
  return postOve<OpsPreparePayload>(`${BASE}/ops/prepare`, request)
}

/** Step 2: perform the confirmed operation (typed word for destructive). */
export function executeOps(token: string, typed?: string): Promise<OveResult<OpsExecutePayload>> {
  return postOve<OpsExecutePayload>(`${BASE}/ops/execute`, { token, ...(typed === undefined ? {} : { typed }) })
}

/** Release a dismissed confirmation (idempotent for settled tokens). */
export function cancelOps(token: string): Promise<OveResult<OpsCancelPayload>> {
  return postOve<OpsCancelPayload>(`${BASE}/ops/cancel`, { token })
}

/** The undo dry-run plan (no mutation). */
export function planOpsUndo(undoId: string): Promise<OveResult<{ plan: OpsUndoPlan }>> {
  return postOve<{ plan: OpsUndoPlan }>(`${BASE}/ops/plan`, { undoId })
}

/** Apply the undo; `confirmExtra` after the user approves an extra-changes plan. */
export function applyOpsUndo(undoId: string, confirmExtra = false): Promise<OveResult<OpsUndoPayload>> {
  return postOve<OpsUndoPayload>(`${BASE}/ops/undo`, { undoId, confirmExtra })
}

/**
 * Fetch the one-time pack download and save it through a synthetic anchor.
 *
 * The token is a capability: it is consumed by this request and never placed in
 * browser history or the audit. A replayed/expired token is an explicit error
 * ("export the pack again"), never a silent reuse.
 */
export async function downloadPack(
  downloadId: string,
  fileName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${BASE}/ops/download?token=${encodeURIComponent(downloadId)}`)
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } | string }
        if (typeof body.error === 'object' && body.error !== null && typeof body.error.message === 'string') {
          detail = body.error.message
        }
      } catch {
        // Non-JSON refusal: the status line is the diagnostic.
      }
      return { ok: false, error: detail }
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
