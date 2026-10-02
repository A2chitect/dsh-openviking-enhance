/**
 * Per-session commit state, assembled from OpenViking rather than from DSH.
 *
 * Why not read the state from `@openviking/dsh-memory-plugin`? It exposes
 * `openvikingMemory` (a plain `ctx.provide` value), but that object carries no
 * commit status, no history and no emitter, and the plugin drops the commit
 * response's `task_id`/`archive_uri` while logging only at `debug` — which the
 * desktop app filters out. Every fact below therefore comes from the server,
 * which also makes this half immune to plugin upgrades.
 *
 * Two seams into the plugin are still used, both optional:
 *   - `states.get(sessionId).ovSessionId` — the authoritative OpenViking
 *     session key (falls back to `dsh-<sessionId>`);
 *   - `states.get(sessionId).config.peerId` — the actor peer, required for
 *     peer-scoped (git-repo) workspaces, else the memory listing comes back
 *     empty.
 */
import type { CommitArchive, CommitPhase, CommitStatus, MemoryDiff, MemoryDiffEntry } from '../shared/protocol.ts'
import type { OpenVikingApi, OvCommitTask } from './openviking-api.ts'

/** The slice of `@openviking/dsh-memory-plugin`'s runtime this plugin reads. */
export interface OpenVikingMemoryRuntime {
  states?: Map<unknown, { ovSessionId?: string; config?: { peerId?: string; commitTokenThreshold?: number } }>
}

/** Shape of `memory_diff.json` on the server. */
interface RawMemoryDiff {
  archive_uri?: string
  extracted_at?: string
  operations?: {
    adds?: RawDiffEntry[]
    updates?: RawDiffEntry[]
    deletes?: RawDiffEntry[]
  }
  summary?: { total_adds?: number; total_updates?: number; total_deletes?: number; total_skipped?: number }
}

interface RawDiffEntry {
  uri?: string
  memory_type?: string
  before?: string
  after?: string
  deleted_content?: string
}

export interface CommitServiceOptions {
  api: OpenVikingApi
  /** Resolve the mounted OpenViking plugin runtime, or null when absent. */
  memoryRuntime: () => OpenVikingMemoryRuntime | null
  /** Status cache TTL; the client polls, so this keeps the server calm. */
  cacheTtlMs?: number
}

export class CommitService {
  private readonly cache = new Map<string, { at: number; value: CommitStatus }>()
  private readonly options: CommitServiceOptions
  private readonly cacheTtlMs: number

  // Plain field assignment rather than a constructor parameter property: the
  // latter is TypeScript-only syntax that Node's type stripping cannot erase,
  // which would make this module unimportable from the unit tests.
  constructor(options: CommitServiceOptions) {
    this.options = options
    this.cacheTtlMs = options.cacheTtlMs ?? 2500
  }

  /** OpenViking session key for a DSH session. */
  ovSessionId(sessionId: string): string {
    const fromPlugin = this.options.memoryRuntime()?.states?.get(sessionId)?.ovSessionId
    return typeof fromPlugin === 'string' && fromPlugin.length > 0 ? fromPlugin : `dsh-${sessionId}`
  }

  /** Actor peer, when the OpenViking plugin knows it. */
  private peerId(sessionId: string): string | undefined {
    const peer = this.options.memoryRuntime()?.states?.get(sessionId)?.config?.peerId
    return typeof peer === 'string' && peer.length > 0 ? peer : undefined
  }

  /** Effective commit threshold; null when the OpenViking plugin is not mounted. */
  private threshold(sessionId: string): number | null {
    const value = this.options.memoryRuntime()?.states?.get(sessionId)?.config?.commitTokenThreshold
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  async status(sessionId: string, options: { fresh?: boolean } = {}): Promise<CommitStatus> {
    const cached = this.cache.get(sessionId)
    if (!options.fresh && cached && Date.now() - cached.at < this.cacheTtlMs) return cached.value

    const ovSessionId = this.ovSessionId(sessionId)
    const request = { actorPeerId: this.peerId(sessionId) }
    // Sequential, not parallel: the history path must be derived from the
    // session's own `uri`, which only the first call can answer. It costs one
    // round trip (~7 ms) and removes a whole class of "never committed" lies for
    // sessions owned by another user or peer.
    const meta = await this.options.api.getSession(ovSessionId, request)
    const historyUri = resolveSessionUri(meta.result, ovSessionId, this.options.api.user)
    const history = await this.options.api.listHistory(historyUri, request)

    const pendingTokens = meta.result?.pending_tokens ?? 0
    const commitCount = meta.result?.commit_count ?? 0
    const threshold = this.threshold(sessionId)
    const archives = (history.result ?? [])
      .filter((entry) => entry.isDir)
      .map<CommitArchive>((entry) => ({
        archiveId: entry.uri.split('/').pop() ?? entry.uri,
        archiveUri: entry.uri,
      }))
      .sort((a, b) => a.archiveId.localeCompare(b.archiveId))

    let phase = derivePhase({ metaOk: meta.ok, commitCount, pendingTokens, archiveCount: archives.length })
    if (phase === 'extracting') {
      // The counter lags an archive in two different situations: extraction is
      // still running, or its task failed and the counter will never catch up
      // (the operations are written to the archive regardless). Ask the archive
      // itself: `memory_diff.json` appears exactly when extraction finished, so
      // this settles the ambiguity instead of leaving the pill spinning forever.
      const newest = archives[archives.length - 1]
      const probe = await this.options.api.readText(`${newest?.archiveUri}/memory_diff.json`, request)
      phase = probe.ok && probe.result !== null ? 'done' : 'extracting'
    }

    const value: CommitStatus = {
      sessionId,
      ovSessionId,
      pendingTokens,
      threshold,
      ratio: threshold && threshold > 0 ? Math.min(1, pendingTokens / threshold) : 0,
      commitCount,
      lastCommitAt: meta.result?.last_commit_at ?? null,
      phase,
      archives,
    }
    this.cache.set(sessionId, { at: Date.now(), value })
    return value
  }

  /**
   * Commit records for a session: one per archive, oldest first.
   *
   * Archives are the durable record — task records are pruned by the server, so
   * they are only consulted to label a commit that is still being extracted.
   */
  async commits(sessionId: string): Promise<{ status: CommitStatus; tasks: OvCommitTask[] }> {
    const status = await this.status(sessionId)
    const tasks = await this.options.api.listCommitTasks(status.ovSessionId, {
      actorPeerId: this.peerId(sessionId),
    })
    return { status, tasks: tasks.result ?? [] }
  }

  /** Read and normalize one archive's `memory_diff.json`. */
  async diff(sessionId: string, archiveUri: string): Promise<MemoryDiff | null> {
    const uri = `${archiveUri.replace(/\/+$/, '')}/memory_diff.json`
    const response = await this.options.api.readJson<RawMemoryDiff>(uri, {
      actorPeerId: this.peerId(sessionId),
    })
    if (!response.ok || !response.result) return null
    return normalizeDiff(archiveUri, response.result)
  }
}

/**
 * Guard for the `archive` parameter of the diff route: the browser half may only
 * ask for a diff under this session's own history tree. Anything else is refused,
 * so the route cannot be turned into a generic `viking://` file reader.
 */
export function isArchiveUriForSession(uri: string, ovSessionId: string): boolean {
  if (!uri.startsWith('viking://')) return false
  const marker = `/sessions/${ovSessionId}/history/archive_`
  return uri.includes(marker) && !uri.includes('..')
}

/**
 * The session's canonical `viking://` path, according to the server's own answer.
 * It returns the *session* directory: `OpenVikingApi.listHistory` owns the
 * `/history` suffix, and appending it here too was a real bug (the request went
 * to `history/history` and every session reported zero archives).
 *
 * Preference order:
 *  1. the session's canonical `uri` — correct for any user or peer namespace;
 *  2. its `created_by_user_id`, for servers that omit `uri` on the detail route;
 *  3. the identity this plugin reads as, which is right for the common case and
 *     wrong exactly when another user or peer owns the session.
 */
export function resolveSessionUri(
  meta: { uri?: string; created_by_user_id?: string } | null | undefined,
  ovSessionId: string,
  fallbackUser: string,
): string {
  const uri = typeof meta?.uri === 'string' ? meta.uri.trim() : ''
  if (uri.startsWith('viking://')) return uri.replace(/\/+$/, '')
  const owner = typeof meta?.created_by_user_id === 'string' && meta.created_by_user_id.length > 0
    ? meta.created_by_user_id
    : fallbackUser
  return `viking://user/${owner}/sessions/${ovSessionId}`
}

/**
 * Phase rules, in order:
 *  - no server / no answer        → 'failed'
 *  - an archive exists that the server has not counted yet → 'extracting'
 *    (`status()` then probes that archive's `memory_diff.json`: present means
 *    the counter merely lags, so the phase settles to 'done')
 *  - nothing committed, tokens accumulating → 'pending'
 *  - otherwise                    → 'done' or 'idle'
 */
export function derivePhase(input: {
  metaOk: boolean
  commitCount: number
  pendingTokens: number
  archiveCount: number
}): CommitPhase {
  if (!input.metaOk) return 'failed'
  if (input.archiveCount > input.commitCount) return 'extracting'
  if (input.commitCount > 0) return 'done'
  return input.pendingTokens > 0 ? 'pending' : 'idle'
}

export function normalizeDiff(archiveUri: string, raw: RawMemoryDiff): MemoryDiff {
  const map = (entry: RawDiffEntry): MemoryDiffEntry => ({
    uri: entry.uri ?? '',
    memoryType: entry.memory_type ?? 'unknown',
    ...(entry.before !== undefined ? { before: entry.before } : {}),
    ...(entry.after !== undefined ? { after: entry.after } : {}),
    ...(entry.deleted_content !== undefined ? { deletedContent: entry.deleted_content } : {}),
  })
  const adds = (raw.operations?.adds ?? []).map(map)
  const updates = (raw.operations?.updates ?? []).map(map)
  const deletes = (raw.operations?.deletes ?? []).map(map)
  const summary = raw.summary
  return {
    archiveUri,
    extractedAt: raw.extracted_at ?? null,
    adds,
    updates,
    deletes,
    // Prefer the recorded summary; fall back to counting, because a failed
    // extraction can leave `summary` absent while the arrays are present.
    summary: {
      totalAdds: summary?.total_adds ?? adds.length,
      totalUpdates: summary?.total_updates ?? updates.length,
      totalDeletes: summary?.total_deletes ?? deletes.length,
      totalSkipped: summary?.total_skipped ?? 0,
    },
  }
}
