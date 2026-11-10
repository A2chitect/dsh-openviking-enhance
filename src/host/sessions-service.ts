/**
 * The paginated session browser's host half.
 *
 * The server's `GET /api/v1/sessions` has NO pagination (a live 0.5.3 store
 * answered 168 rows in one array), so this service pages the sessions
 * directory itself: `fs/ls` on `viking://user/<user>/sessions` with
 * `node_limit`/`offset` and a server-side mtime-desc sort. The client filters
 * kind/id-substring over the loaded pages only; there is deliberately no
 * per-row fan-out (that would be three requests per session).
 *
 * Session *detail* stays the existing `/session-log` route: it is already
 * bounded (latest 3 archive probes, latest 10 tasks, latest 24 events) and
 * cached per session, so this service never reads a session's inside.
 */
import { SESSION_LIST_CACHE_TTL_MS, SESSIONS_PAGE_SIZE } from '../shared/limits.ts'
import { FS_TIMEOUT_MS } from '../shared/limits.ts'
import type { PluginNotice, SessionListPayload, SessionListRow } from '../shared/protocol.ts'
import { dshSessionIdOf, normalizeVikingUri, sessionKindOf, tailOf } from '../shared/viking-tree.ts'
import type { OpenVikingApi, OvFsListEntryWithMeta } from './openviking-api.ts'
import { BrowseFailure } from './browse-service.ts'

export interface SessionsServiceOptions {
  api: OpenVikingApi
  user: () => string
  now?: () => number
}

/** One session directory row out of an `fs/ls` entry. */
export function normalizeSessionRow(raw: OvFsListEntryWithMeta): SessionListRow | null {
  if (raw === null || typeof raw !== 'object' || typeof raw.uri !== 'string') return null
  const uri = normalizeVikingUri(raw.uri)
  const ovSessionId = tailOf(uri)
  if (ovSessionId.length === 0) return null
  return {
    ovSessionId,
    sessionId: dshSessionIdOf(ovSessionId),
    uri,
    modifiedAt: typeof raw.modTime === 'string' && raw.modTime.length > 0 ? raw.modTime : null,
    kind: sessionKindOf(ovSessionId),
  }
}

export class SessionsService {
  private readonly options: SessionsServiceOptions
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; payload: SessionListPayload }>()
  private readonly inflight = new Map<string, Promise<SessionListPayload>>()

  constructor(options: SessionsServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop cached pages (identity switch). */
  resetCaches(): void {
    this.cache.clear()
    this.inflight.clear()
  }

  /** The sessions directory URI for the active identity. */
  sessionsUri(): string {
    return `viking://user/${this.options.user()}/sessions`
  }

  /**
   * One page of session directories, newest first.
   *
   * A 404 is a normal empty tree (a fresh server has no session directory yet):
   * the page is empty with a `staleDirectory` warning, not an error.
   */
  async list(
    options: { offset?: number; limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionListPayload> {
    const limit = clampLimit(options.limit)
    const offset = clampOffset(options.offset)
    const uri = this.sessionsUri()
    const key = `${uri}\u0000${offset}\u0000${limit}`
    const cached = this.cache.get(key)
    if (options.fresh !== true && cached !== undefined && this.now() - cached.at < SESSION_LIST_CACHE_TTL_MS) return cached.payload
    const running = this.inflight.get(key)
    if (options.fresh !== true && running !== undefined) return running

    const work = this.fetchPage(uri, offset, limit, options.signal)
      .then((payload) => {
        this.cache.set(key, { at: this.now(), payload })
        return payload
      })
      .finally(() => {
        // Compare the promise: a `fresh=1` call may have replaced the entry.
        if (this.inflight.get(key) === work) this.inflight.delete(key)
      })
    this.inflight.set(key, work)
    return work
  }

  private async fetchPage(
    uri: string,
    offset: number,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionListPayload> {
    const answer = await this.options.api.listDirectoryPage(uri, {
      limit,
      offset,
      sortBy: 'mtime',
      sortOrder: 'desc',
      timeoutMs: FS_TIMEOUT_MS,
      // v0.9: the sessions browser is a sessionless read (peer READ selector).
      readPeer: true,
      ...(signal === undefined ? {} : { signal }),
    })
    if (signal?.aborted === true) throw new BrowseFailure('aborted', 'aborted')
    const warnings: PluginNotice[] = []
    if (!answer.ok) {
      if (answer.status === 404 || answer.errorCode === 'NOT_FOUND') {
        // A fresh server has no sessions directory yet; the client renders the
        // warning so this never silently reads as "no sessions ever".
        warnings.push({ code: 'staleDirectory', params: { uri } })
        return { items: [], hasMore: false, nextOffset: null, warnings, observedAt: new Date(this.now()).toISOString() }
      }
      if (answer.status === 405 || answer.status === 501 || answer.errorCode === 'UNSUPPORTED') {
        throw new BrowseFailure('unsupported', answer.error ?? `HTTP ${answer.status}`)
      }
      throw new BrowseFailure('unreadable', answer.error ?? `HTTP ${answer.status}`)
    }
    const page = answer.result
    const items = (page?.entries ?? [])
      .filter((entry) => entry.isDir !== false)
      .map(normalizeSessionRow)
      .filter((row): row is SessionListRow => row !== null)
    return {
      items,
      hasMore: page?.hasMore === true,
      nextOffset: page?.nextOffset ?? null,
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SESSIONS_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(raw), 1), SESSIONS_PAGE_SIZE)
}

function clampOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0
  return Math.min(Math.max(Math.trunc(raw), 0), 1_000_000)
}
