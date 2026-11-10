/**
 * The native Browse view's host half.
 *
 * Two read shapes, both bounded:
 *
 *  - **one directory page** (`fs/ls` with `node_limit`/`offset`/`abs_limit`/
 *    `include_tags`), cached briefly and deduped in flight, so expanding a tree
 *    node is one request and collapsing/re-expanding is free;
 *  - **one explicitly requested subtree** (`fs/tree`), capped to two levels and
 *    100 nodes. `fs/tree` flattens the whole result across levels and pages that
 *    flattened stream, so it is never used for the lazy tree itself.
 *
 * The URI allowlist lives in `shared/viking-tree.ts`: only canonical
 * `viking://` paths under `user`, `resources` or `agent` are read, and the
 * internal scratch scopes (`queue`, `temp`, `system`, `upload`, `session`) are
 * refused by code, not by convention. Nothing here writes, and nothing here
 * lists a URI the client names verbatim into a fetch primitive.
 *
 * A directory the server answers 404 for is a *stale tree path*, not an error:
 * the page is empty and a warning says so (the view collapses the node).
 */
import {
  BROWSE_ABSTRACT_MAX_CHARS,
  BROWSE_CACHE_MAX_DIRECTORIES,
  BROWSE_CACHE_TTL_MS,
  BROWSE_PAGE_SIZE,
  BROWSE_SUBTREE_MAX_LEVELS,
  BROWSE_SUBTREE_MAX_NODES,
} from '../shared/limits.ts'
import { FS_TIMEOUT_MS } from '../shared/limits.ts'
import type {
  BrowseEntry,
  BrowsePayload,
  BrowseRoot,
  BrowseRootsPayload,
  BrowseSubtreeEntry,
  BrowseSubtreePayload,
  PluginNotice,
} from '../shared/protocol.ts'
import {
  browseEntryKind,
  classifyVikingUri,
  isAllowedBrowseUri,
  normalizeVikingUri,
  tailOf,
} from '../shared/viking-tree.ts'
import type { OpenVikingApi, OvFsListEntryWithMeta, OvFsTreeEntry } from './openviking-api.ts'

export type BrowseFailureCode = 'not-allowed' | 'unreadable' | 'unsupported' | 'aborted'

/** A browse read that cannot produce a payload; the route maps it to JSON. */
export class BrowseFailure extends Error {
  readonly code: BrowseFailureCode

  constructor(code: BrowseFailureCode, message: string) {
    super(message)
    this.name = 'BrowseFailure'
    this.code = code
  }
}

export interface BrowseServiceOptions {
  api: OpenVikingApi
  /** The active identity's user, resolved live (a profile switch changes it). */
  user: () => string
  now?: () => number
}

/** The roots the tree offers, resolved from the identity (never hardcoded client-side). */
export function browseRootsFor(user: string): BrowseRoot[] {
  const base = `viking://user/${user}`
  return [
    { id: 'memories', uri: `${base}/memories`, labelKey: 'browse.root.memories', scope: 'user' },
    { id: 'peers', uri: `${base}/peers`, labelKey: 'browse.root.peers', scope: 'peer' },
    { id: 'resources', uri: 'viking://resources', labelKey: 'browse.root.resources', scope: 'account' },
    { id: 'myResources', uri: `${base}/resources`, labelKey: 'browse.root.myResources', scope: 'user' },
    { id: 'skills', uri: `${base}/skills`, labelKey: 'browse.root.skills', scope: 'user' },
    { id: 'agentSkills', uri: 'viking://agent/skills', labelKey: 'browse.root.agentSkills', scope: 'agent' },
    { id: 'rules', uri: `${base}/memories/rules`, labelKey: 'browse.root.rules', scope: 'user', shortcut: true },
    { id: 'sessions', uri: `${base}/sessions`, labelKey: 'browse.root.sessions', scope: 'user', shortcut: true },
  ]
}

interface PageCacheEntry {
  at: number
  payload: BrowsePayload
}

/** One normalized row from the server's listing. */
export function normalizeBrowseEntry(raw: OvFsListEntryWithMeta): BrowseEntry | null {
  if (raw === null || typeof raw !== 'object' || typeof raw.uri !== 'string') return null
  const uri = normalizeVikingUri(raw.uri)
  const facts = classifyVikingUri(uri)
  if (facts.kind === 'unknown' && !isAllowedBrowseUri(uri)) return null
  const isDir = raw.isDir === true
  const abstract = typeof raw.abstract === 'string' ? raw.abstract.trim() : ''
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 6)
    : []
  return {
    uri,
    name: facts.tail.length > 0 ? facts.tail : uri,
    isDir,
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : null,
    modifiedAt: typeof raw.modTime === 'string' && raw.modTime.length > 0 ? raw.modTime : null,
    abstract: abstract.length > 0 ? abstract.slice(0, BROWSE_ABSTRACT_MAX_CHARS) : null,
    tags,
    kind: browseEntryKind(uri, isDir),
  }
}

/** Whether a failed `fs/ls` answer means "this directory does not exist any more". */
function isNotFound(answer: { status: number; errorCode?: string | null }): boolean {
  return answer.status === 404 || answer.errorCode === 'NOT_FOUND'
}

/**
 * Whether a failed answer means "this server build does not have the route".
 *
 * A 405/501 (or the generic `unsupported` code some builds use) is a server
 * capability answer, not a stale path: rendering it as an empty tree would claim
 * "nothing here" when the truth is "this build cannot list it".
 */
function isUnsupportedRoute(answer: { status: number; errorCode?: string | null }): boolean {
  return answer.status === 405 || answer.status === 501 || answer.errorCode === 'UNSUPPORTED'
}

export class BrowseService {
  private readonly options: BrowseServiceOptions
  private readonly now: () => number
  /** `uri\0offset` → page; Map insertion order doubles as the LRU order. */
  private readonly cache = new Map<string, PageCacheEntry>()
  private readonly inflight = new Map<string, Promise<BrowsePayload>>()
  private cachedRoots: { user: string; payload: BrowseRootsPayload } | null = null

  constructor(options: BrowseServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop every cached answer (identity switch, or a user-triggered refresh). */
  resetCaches(): void {
    this.cache.clear()
    this.inflight.clear()
    this.cachedRoots = null
  }

  /** The roots for the active identity. No listing happens here. */
  roots(fresh = false): BrowseRootsPayload {
    const user = this.options.user()
    if (!fresh && this.cachedRoots !== null && this.cachedRoots.user === user) return this.cachedRoots.payload
    const payload: BrowseRootsPayload = {
      roots: browseRootsFor(user),
      warnings: [],
      observedAt: new Date(this.now()).toISOString(),
    }
    this.cachedRoots = { user, payload }
    return payload
  }

  /**
   * One directory page.
   *
   * @throws {BrowseFailure} `not-allowed` for a URI outside the allowlist,
   * `unreadable` for a transport/auth failure and `aborted` when the caller
   * cancelled while the request was in flight. The personal tree is pinned to
   * the active identity, so another user's `viking://user/<u>/…` path is refused
   * rather than listed.
   */
  async list(
    rawUri: string,
    options: { offset?: number; limit?: number; fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<BrowsePayload> {
    const uri = normalizeVikingUri(rawUri)
    if (!isAllowedBrowseUri(uri, { user: this.options.user() })) throw new BrowseFailure('not-allowed', 'not-allowed')
    const limit = clampLimit(options.limit)
    const offset = clampOffset(options.offset)
    const key = `${uri}\u0000${offset}\u0000${limit}`
    const cached = this.cache.get(key)
    if (options.fresh !== true && cached !== undefined && this.now() - cached.at < BROWSE_CACHE_TTL_MS) {
      // Refresh the LRU position: Map preserves insertion order.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.payload
    }
    const running = this.inflight.get(key)
    if (options.fresh !== true && running !== undefined) return running

    const work = this.fetchPage(uri, offset, limit, options.signal)
      .then((payload) => {
        if (this.cache.size >= BROWSE_CACHE_MAX_DIRECTORIES) {
          const oldest = this.cache.keys().next()
          if (!oldest.done) this.cache.delete(oldest.value)
        }
        this.cache.set(key, { at: this.now(), payload })
        return payload
      })
      .finally(() => {
        // Compare the promise, not just the key: a `fresh=1` call may have
        // replaced the in-flight entry while this one was settling.
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
  ): Promise<BrowsePayload> {
    const answer = await this.options.api.listDirectoryPage(uri, {
      limit,
      offset,
      includeTags: true,
      absLimit: BROWSE_ABSTRACT_MAX_CHARS,
      timeoutMs: FS_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    })
    if (signal?.aborted === true) throw new BrowseFailure('aborted', 'aborted')
    const warnings: PluginNotice[] = []
    if (!answer.ok) {
      if (isNotFound(answer)) {
        // A stale tree path: the directory moved between listing and expansion.
        warnings.push({ code: 'staleDirectory', params: { uri } })
        return emptyPage(uri, warnings, this.now())
      }
      throw new BrowseFailure('unreadable', answer.error ?? `HTTP ${answer.status}`)
    }
    const page = answer.result
    const user = this.options.user()
    const entries = (page?.entries ?? [])
      .map(normalizeBrowseEntry)
      .filter((entry): entry is BrowseEntry => entry !== null && isAllowedBrowseUri(entry.uri, { user }))
    return {
      uri,
      entries,
      hasMore: page?.hasMore === true,
      nextOffset: page?.nextOffset ?? null,
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  /**
   * The explicit bounded subtree: at most two levels and 100 nodes.
   *
   * This is the one place `fs/tree` is used; the UI puts it behind a labelled
   * action with the cost note, because the server's cap applies to the flattened
   * result and paging it is not the same as paging a directory.
   */
  async subtree(
    rawUri: string,
    options: { levels?: number; nodes?: number; signal?: AbortSignal } = {},
  ): Promise<BrowseSubtreePayload> {
    const uri = normalizeVikingUri(rawUri)
    if (!isAllowedBrowseUri(uri, { user: this.options.user() })) throw new BrowseFailure('not-allowed', 'not-allowed')
    const levels = Math.min(Math.max(Math.trunc(options.levels ?? BROWSE_SUBTREE_MAX_LEVELS), 1), BROWSE_SUBTREE_MAX_LEVELS)
    const nodes = Math.min(Math.max(Math.trunc(options.nodes ?? BROWSE_SUBTREE_MAX_NODES), 1), BROWSE_SUBTREE_MAX_NODES)
    const answer = await this.options.api.fsTree(uri, {
      levels,
      nodes,
      timeoutMs: FS_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (options.signal?.aborted === true) throw new BrowseFailure('aborted', 'aborted')
    const warnings: PluginNotice[] = []
    if (!answer.ok) {
      if (isNotFound(answer)) {
        // A stale path: the directory moved since the tree page was listed.
        warnings.push({ code: 'staleDirectory', params: { uri } })
        return { uri, entries: [], truncated: false, levels, nodes, warnings, observedAt: new Date(this.now()).toISOString() }
      }
      if (isUnsupportedRoute(answer)) {
        // The tree route is absent on this build: that is distinct from "the
        // directory is empty", and the client must be able to say so.
        throw new BrowseFailure('unsupported', answer.error ?? `HTTP ${answer.status}`)
      }
      throw new BrowseFailure('unreadable', answer.error ?? `HTTP ${answer.status}`)
    }
    const page = answer.result
    const entries = (page?.entries ?? [])
      .slice(0, nodes)
      .map((raw) => normalizeSubtreeEntry(uri, raw))
      .filter((entry): entry is BrowseSubtreeEntry => entry !== null)
    return {
      uri,
      entries,
      truncated: page?.hasMore === true,
      levels,
      nodes,
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }
}

/** One flattened node, with the depth/relative path the "show subtree" list needs. */
export function normalizeSubtreeEntry(rootUri: string, raw: OvFsTreeEntry): BrowseSubtreeEntry | null {
  if (raw === null || typeof raw !== 'object' || typeof raw.uri !== 'string') return null
  const uri = normalizeVikingUri(raw.uri)
  const relPath =
    typeof raw.rel_path === 'string' && raw.rel_path.length > 0
      ? raw.rel_path
      : typeof raw.relPath === 'string' && raw.relPath.length > 0
        ? raw.relPath
        : uri.startsWith(`${rootUri}/`)
          ? uri.slice(rootUri.length + 1)
          : tailOf(uri)
  const isDir = raw.isDir === true
  const depth =
    typeof raw.level === 'number' && raw.level >= 0
      ? raw.level
      : typeof raw.depth === 'number' && raw.depth >= 0
        ? raw.depth
        : Math.max(0, relPath.split('/').filter((segment) => segment.length > 0).length - 1)
  return {
    uri,
    relPath,
    depth,
    name: tailOf(uri) || uri,
    isDir,
    kind: browseEntryKind(uri, isDir),
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : null,
    modifiedAt: typeof raw.modTime === 'string' && raw.modTime.length > 0 ? raw.modTime : null,
  }
}

/** A size clamp that tolerates a crafted query string. */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return BROWSE_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(raw), 1), BROWSE_PAGE_SIZE)
}

/** A non-negative, bounded offset; anything else starts at the top. */
function clampOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0
  return Math.min(Math.max(Math.trunc(raw), 0), 1_000_000)
}

function emptyPage(uri: string, warnings: PluginNotice[], now: number): BrowsePayload {
  return {
    uri,
    entries: [],
    hasMore: false,
    nextOffset: null,
    warnings,
    observedAt: new Date(now).toISOString(),
  }
}
