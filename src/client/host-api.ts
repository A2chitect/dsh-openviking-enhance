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
  type ApiResult,
  type CommitStatus,
  type CommitTask,
  type EnhanceConfig,
  type MemoryDiff,
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
}

export function fetchCommits(sessionId: string): Promise<ApiResult<CommitsPayload>> {
  return readJson<CommitsPayload>(`${BASE}/commits?sessionId=${encodeURIComponent(sessionId)}`)
}

export interface DiffPayload {
  diff: MemoryDiff | null
  pending: boolean
}

export function fetchDiff(sessionId: string, archiveUri: string): Promise<ApiResult<DiffPayload>> {
  const archive = encodeURIComponent(archiveUri)
  return readJson<DiffPayload>(`${BASE}/diff?sessionId=${encodeURIComponent(sessionId)}&archive=${archive}`)
}
