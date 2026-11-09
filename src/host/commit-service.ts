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
import type {
  ArchiveFailure,
  ArchiveState,
  ArchiveSummary,
  ArchiveTerminal,
  CommitArchive,
  CommitPhase,
  CommitStatus,
  MemoryDiff,
  MemoryDiffEntry,
  MemoryDiffSummary,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvCommitTask } from './openviking-api.ts'

/** The slice of `@openviking/dsh-memory-plugin`'s runtime this plugin reads. */
export interface OpenVikingMemoryRuntime {
  /**
   * Per-session runtime state. `config` is the plugin's fully resolved
   * configuration (its own schema merged with the profile/env/ovcli layers), so
   * the Doctor and the recall explanation read effective values from here
   * instead of re-deriving the plugin's precedence.
   */
  states?: Map<
    unknown,
    {
      ovSessionId?: string
      config?: Record<string, unknown> & { peerId?: string; commitTokenThreshold?: number }
    }
  >
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

/** Shape of `.failed.json` on the server. */
export interface RawFailedMarker {
  stage?: string
  error?: string
  failed_at?: string
  skipped?: boolean
  completed_memory_steps?: Record<string, string[]>
}

/** One archive's terminal state, read once and cached when it is final. */
interface ArchiveProbe {
  state: ArchiveState
  failure: ArchiveFailure | null
  diff: MemoryDiff | null
  /** A real `.done` / `.failed.json` was seen (not just a legacy diff). */
  markers: boolean
}

/** How long a pending archive is left alone before its markers are re-probed. */
const PENDING_ARCHIVE_RETRY_MS = 10_000

export interface CommitServiceOptions {
  api: OpenVikingApi
  /** Resolve the mounted OpenViking plugin runtime, or null when absent. */
  memoryRuntime: () => OpenVikingMemoryRuntime | null
  /** Status cache TTL; the client polls, so this keeps the server calm. */
  cacheTtlMs?: number
  /** How long a still-pending archive is left alone before its markers are re-probed. */
  pendingArchiveRetryMs?: number
}

export class CommitService {
  private readonly cache = new Map<string, { at: number; value: CommitStatus }>()
  /**
   * One probe per archive. `memory_diff.json`, `.done` and `.failed.json` are
   * immutable once written, so a terminal probe is cached for the process
   * lifetime. A pending archive is re-probed after `pendingRetryMs` — extraction
   * may still be running — instead of on every poll.
   */
  private readonly probes = new Map<string, ArchiveProbe>()
  private readonly probeRetryAt = new Map<string, number>()
  /**
   * One in-flight read per session. Several GUI tabs (or a fast poll and a
   * user-triggered refresh) then share one upstream round trip instead of
   * multiplying it.
   */
  private readonly inflight = new Map<string, Promise<CommitStatus>>()
  private readonly options: CommitServiceOptions
  private readonly cacheTtlMs: number
  private readonly pendingRetryMs: number

  // Plain field assignment rather than a constructor parameter property: the
  // latter is TypeScript-only syntax that Node's type stripping cannot erase,
  // which would make this module unimportable from the unit tests.
  constructor(options: CommitServiceOptions) {
    this.options = options
    this.cacheTtlMs = options.cacheTtlMs ?? 2500
    this.pendingRetryMs = options.pendingArchiveRetryMs ?? PENDING_ARCHIVE_RETRY_MS
  }

  /** OpenViking session key for a DSH session. */
  ovSessionId(sessionId: string): string {
    const fromPlugin = this.options.memoryRuntime()?.states?.get(sessionId)?.ovSessionId
    return typeof fromPlugin === 'string' && fromPlugin.length > 0 ? fromPlugin : `dsh-${sessionId}`
  }

  /**
   * Actor peer, when the OpenViking plugin knows it.
   *
   * Public because peer-scoped routing is not a commit concern: the recall
   * service needs the same identity to search the same peer's memories.
   */
  actorPeer(sessionId: string): string | undefined {
    const peer = this.options.memoryRuntime()?.states?.get(sessionId)?.config?.peerId
    return typeof peer === 'string' && peer.length > 0 ? peer : undefined
  }

  /** Effective commit threshold; null when the OpenViking plugin is not mounted. */
  private threshold(sessionId: string): number | null {
    const value = this.options.memoryRuntime()?.states?.get(sessionId)?.config?.commitTokenThreshold
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /**
   * The mounted memory plugin's resolved configuration for one session.
   *
   * A snapshot of what the plugin would use right now, not this plugin's guess:
   * the official plugin resolves its own schema against the profile, the
   * environment and `ovcli.conf`. `null` means the plugin is not mounted (or
   * this session was never initialized), never "the plugin has no settings".
   */
  pluginConfig(sessionId: string): Record<string, unknown> | null {
    const config = this.options.memoryRuntime()?.states?.get(sessionId)?.config
    return config !== null && typeof config === 'object' ? config : null
  }

  /** Whether the official memory plugin is mounted at all. */
  pluginMounted(): boolean {
    return this.options.memoryRuntime() !== null
  }

  /** The mounted plugin's configured local peer, when a session has one. */
  pluginPeerSource(sessionId: string): string | null {
    const source = this.options.memoryRuntime()?.states?.get(sessionId)?.config?.peerSource
    return typeof source === 'string' && source.length > 0 ? source : null
  }

  async status(sessionId: string, options: { fresh?: boolean } = {}): Promise<CommitStatus> {
    const cached = this.cache.get(sessionId)
    if (!options.fresh && cached && Date.now() - cached.at < this.cacheTtlMs) return cached.value

    // One upstream read per session at a time. Several GUI tabs, or a poll and a
    // user-triggered refresh, then share one round trip instead of multiplying it.
    const running = this.inflight.get(sessionId)
    if (running) return running

    const work = this.readStatus(sessionId, options.fresh === true)
      .then((value) => {
        this.cache.set(sessionId, { at: Date.now(), value })
        return value
      })
      .finally(() => {
        this.inflight.delete(sessionId)
      })
    this.inflight.set(sessionId, work)
    return work
  }

  /** One uncached upstream read; `status()` owns caching and in-flight sharing. */
  private async readStatus(sessionId: string, fresh: boolean): Promise<CommitStatus> {
    const ovSessionId = this.ovSessionId(sessionId)
    const request = { actorPeerId: this.actorPeer(sessionId) }
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
        modTime: entry.modTime ?? null,
      }))
      .sort((a, b) => a.archiveId.localeCompare(b.archiveId))

    // The newest archive's terminal marker is the durable fact behind the pill.
    // `commit_count` advances when the archive is written, so counts alone cannot
    // tell "extraction still running" from "extraction failed".
    const newest = archives[archives.length - 1]
    const latestProbe = newest === undefined ? null : await this.probeArchive(sessionId, newest.archiveUri, { fresh })
    const latest: ArchiveTerminal | null =
      newest !== undefined && latestProbe !== null
        ? {
            archiveUri: newest.archiveUri,
            state: latestProbe.state,
            failure: latestProbe.failure,
            markers: latestProbe.markers,
          }
        : null
    const phase = derivePhase({
      metaOk: meta.ok,
      commitCount,
      pendingTokens,
      archiveCount: archives.length,
      latestState: latestProbe?.state ?? null,
    })

    return {
      sessionId,
      ovSessionId,
      pendingTokens,
      threshold,
      ratio: threshold && threshold > 0 ? Math.min(1, pendingTokens / threshold) : 0,
      commitCount,
      lastCommitAt: meta.result?.last_commit_at ?? null,
      phase,
      latest,
      archives,
    }
  }

  /**
   * Commit records for a session: one per archive, oldest first.
   *
   * Archives and their terminal markers are the durable record — task records are
   * pruned by the server, so they are only consulted to label a commit that is
   * still being extracted (and as the fallback on servers without markers).
   */
  async commits(
    sessionId: string,
    summaryLimit: number,
    options: { fresh?: boolean } = {},
  ): Promise<{ status: CommitStatus; tasks: OvCommitTask[]; summaries: ArchiveSummary[] }> {
    const status = await this.status(sessionId, options)
    const tasks = await this.options.api.listCommitTasks(status.ovSessionId, {
      actorPeerId: this.actorPeer(sessionId),
    })
    const summaries = await this.summaries(sessionId, status.archives, summaryLimit, options)
    return { status, tasks: tasks.result ?? [], summaries }
  }

  /**
   * Read one archive's `memory_diff.json`, through the same cached probe the
   * timeline uses. A pending archive returns null; a failed one may still have a
   * partial diff, which is returned as-is — the caller shows the failure too.
   */
  async diff(sessionId: string, archiveUri: string): Promise<MemoryDiff | null> {
    const probe = await this.probeArchive(sessionId, archiveUri)
    return probe.diff
  }

  /**
   * Terminal states and counts for the newest `limit` archives, newest first.
   *
   * A terminal probe is memoized for the process lifetime; a pending one is
   * re-probed only after `pendingRetryMs`, so a fast poll during extraction does
   * not fan out to every archive on every tick.
   */
  async summaries(
    sessionId: string,
    archives: CommitArchive[],
    limit: number,
    options: { fresh?: boolean } = {},
  ): Promise<ArchiveSummary[]> {
    const count = Math.max(0, Math.trunc(limit))
    if (count === 0) return []
    const wanted = archives.slice(-count).reverse()
    return Promise.all(
      wanted.map(async (archive): Promise<ArchiveSummary> => {
        const probe = await this.probeArchive(sessionId, archive.archiveUri, options)
        return {
          archiveUri: archive.archiveUri,
          summary: probe.diff?.summary ?? null,
          state: probe.state,
          failure: probe.failure,
        }
      }),
    )
  }

  /**
   * Read one archive's terminal marker and diff, with an in-memory cache.
   *
   * Marker files are the durable record of the commit's extraction: `.done`
   * means it finished, `.failed.json` means it failed (and carries the server's
   * own reason). `memory_diff.json` is read in both cases because the timeline
   * counts can be partially written even on failure. Only a `pending` or
   * `unknown` archive is re-probed later.
   */
  private async probeArchive(
    sessionId: string,
    archiveUri: string,
    options: { fresh?: boolean } = {},
  ): Promise<ArchiveProbe> {
    const cached = this.probes.get(archiveUri)
    if (cached) return cached
    if (!options.fresh && (this.probeRetryAt.get(archiveUri) ?? 0) > Date.now()) {
      return { state: 'pending', failure: null, diff: null, markers: false }
    }

    const request = { actorPeerId: this.actorPeer(sessionId) }
    const base = archiveUri.replace(/\/+$/, '')
    const done = await this.options.api.readText(`${base}/.done`, request)
    const donePresent = done.ok && done.result !== null
    const doneUnreadable = !done.ok && done.status !== 404
    const [diffResponse, failedResponse] = await Promise.all([
      this.options.api.readJson<RawMemoryDiff>(`${base}/memory_diff.json`, request),
      donePresent || doneUnreadable
        ? Promise.resolve(null)
        : this.options.api.readJson<RawFailedMarker>(`${base}/.failed.json`, request),
    ])

    const diff = diffResponse.ok && diffResponse.result ? normalizeDiff(archiveUri, diffResponse.result) : null
    const failure =
      failedResponse !== null && failedResponse.ok && failedResponse.result
        ? normalizeFailure(failedResponse.result)
        : null
    const diffUnreadable = !diffResponse.ok && diffResponse.status !== 404
    const failedUnreadable = failedResponse !== null && !failedResponse.ok && failedResponse.status !== 404

    let state: ArchiveState
    if (donePresent) state = 'done'
    else if (failure !== null) state = 'failed'
    else if (doneUnreadable || diffUnreadable || failedUnreadable) state = 'unknown'
    // Legacy servers without terminal markers only wrote memory_diff.json; a
    // readable diff is the only success signal they offer.
    else if (diff !== null) state = 'done'
    else state = 'pending'

    const probe: ArchiveProbe = { state, failure, diff, markers: donePresent || failure !== null }
    if (state === 'done' || state === 'failed') {
      this.probes.set(archiveUri, probe)
      this.probeRetryAt.delete(archiveUri)
      return probe
    }
    this.probeRetryAt.set(archiveUri, Date.now() + this.pendingRetryMs)
    return probe
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
 *  - no server / no answer                        → 'failed'
 *  - the newest archive's own marker says failed  → 'errored'
 *  - it says done (the counter may lag it)        → 'done'
 *  - it is pending/unknown, or an archive exists  → 'extracting'
 *    that the server has not counted yet
 *  - nothing committed, tokens accumulating       → 'pending'
 *  - otherwise                                    → 'done' or 'idle'
 */
export function derivePhase(input: {
  metaOk: boolean
  commitCount: number
  pendingTokens: number
  archiveCount: number
  /** Terminal state of the newest archive; null when there is no archive. */
  latestState?: ArchiveState | null
}): CommitPhase {
  if (!input.metaOk) return 'failed'
  if (input.latestState === 'failed') return 'errored'
  if (input.latestState === 'done') return 'done'
  if (input.archiveCount > input.commitCount) return 'extracting'
  if (input.latestState === 'pending') return 'extracting'
  if (input.commitCount > 0) return 'done'
  return input.pendingTokens > 0 ? 'pending' : 'idle'
}

export function normalizeDiff(archiveUri: string, raw: RawMemoryDiff): MemoryDiff {  const map = (entry: RawDiffEntry): MemoryDiffEntry => ({
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

/** Normalize the server's `.failed.json` payload for the wire. */
export function normalizeFailure(raw: RawFailedMarker): ArchiveFailure {
  return {
    stage: typeof raw.stage === 'string' ? raw.stage : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    failedAt: typeof raw.failed_at === 'string' ? raw.failed_at : null,
    skipped: raw.skipped === true,
  }
}
