/**
 * What OpenViking retrieves for one session, and why.
 *
 * This is the host behind the right-Sidebar recall panel. It asks the server the
 * same question the memory plugin asks on every turn — `POST
 * /api/v1/search/search` with `session_id` — instead of re-implementing
 * retrieval, so what the panel shows is the server's own ranking under the
 * session's own de-duplication state.
 *
 * Two things the panel needs that a single call does not give:
 *
 *  - **The query.** A recall is always about some prompt. With no explicit query
 *    the panel asks OpenViking for the session's most recent user turn
 *    (`<session>/messages.jsonl`, the plugin's own capture of the conversation)
 *    and searches for that, which is what the next recall would be about.
 *  - **Every source.** The plugin searches memories and skills; the panel also
 *    shows resources. The server ranks within one `target_uri` per call, so each
 *    source is searched at its own target and the replies are merged per bucket.
 *
 * Nothing here writes: retrieval is read-only on the server, and the session log
 * is only read.
 */
import type { RecallBucket, RecallContent, RecallItem, RecallPayload, RecallQuerySource } from '../shared/protocol.ts'
import { RECALL_BUCKETS, RECALL_CONTENT_MAX_CHARS, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT } from '../shared/protocol.ts'
import type { OpenVikingApi, OvSearchItem, OvSearchResponse } from './openviking-api.ts'
import { resolveSessionUri } from './commit-service.ts'
import type { CommitService } from './commit-service.ts'

/** Longest query taken from a session log; longer text is truncated, not sent whole. */
const MAX_QUERY_CHARS = 2000

export interface RecallServiceOptions {
  api: OpenVikingApi
  /** Session identity and actor peer come from the same place commits read them. */
  commit: CommitService
  /** How long one query's answer is reused for re-renders. */
  cacheTtlMs?: number
  now?: () => number
}

interface CacheEntry {
  at: number
  value: RecallPayload
}

export class RecallService {
  private readonly options: RecallServiceOptions
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()

  /** Plain field assignment: parameter properties cannot be type-stripped. */
  constructor(options: RecallServiceOptions) {
    this.options = options
    this.cacheTtlMs = options.cacheTtlMs ?? 15000
    this.now = options.now ?? Date.now
  }

  /**
   * Retrieve for one session.
   *
   * `query` overrides the session's own last prompt: an empty string asks the
   * session, whitespace-only is treated as absent.
   */
  async recall(
    sessionId: string,
    query?: string,
    limit = RECALL_DEFAULT_LIMIT,
    options: { fresh?: boolean } = {},
  ): Promise<RecallPayload> {
    const capped = Math.min(Math.max(Math.trunc(limit) || RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT)
    const explicit = (query ?? '').trim().slice(0, MAX_QUERY_CHARS)
    const cacheKey = `${sessionId}\u0000${explicit}\u0000${capped}`
    const cached = this.cache.get(cacheKey)
    if (!options.fresh && cached && this.now() - cached.at < this.cacheTtlMs) return cached.value

    const value = await this.collect(sessionId, explicit, capped)
    // Only successful, non-empty answers are worth reusing: an error is cheap to
    // retry and caching it would pin a dead server into the panel.
    if (value.query.text.length > 0) this.cache.set(cacheKey, { at: this.now(), value })
    return value
  }

  private async collect(sessionId: string, explicitQuery: string, limit: number): Promise<RecallPayload> {
    const started = this.now()
    const warnings: string[] = []
    const { api, commit } = this.options

    const ovSessionId = commit.ovSessionId(sessionId)
    const peer = commit.actorPeer(sessionId) ?? null
    const request = peer === null ? {} : { actorPeerId: peer }

    const meta = await api.getSession(ovSessionId, request)
    const sessionUri = meta.ok && meta.result ? resolveSessionUri(meta.result, ovSessionId, api.user) : null
    if (!meta.ok) warnings.push(`会话信息读取失败：${meta.error ?? `HTTP ${meta.status}`}`)

    let queryText = explicitQuery
    let querySource: RecallQuerySource = 'manual'
    if (queryText.length === 0 && sessionUri !== null) {
      const prompt = await this.sessionPrompt(sessionUri, request)
      if (prompt === null) warnings.push('会话日志里没有找到最近的用户提问，请手动输入检索内容。')
      else {
        queryText = prompt
        querySource = 'session'
      }
    }

    const targets = searchTargets(sessionUri, api.user, peer)
    if (queryText.length === 0) {
      return {
        sessionId,
        ovSessionId,
        sessionUri,
        peer,
        query: { text: '', source: querySource },
        buckets: emptyBuckets(),
        plan: null,
        targets: targets.map((target) => target.uri),
        total: 0,
        latencyMs: this.now() - started,
        searchedAt: new Date().toISOString(),
        warnings,
      }
    }

    const replies = await Promise.all(
      targets.map((target) =>
        api
          .search(
            {
              query: queryText,
              target_uri: target.uri,
              limit,
              score_threshold: 0,
              session_id: ovSessionId,
            },
            request,
          )
          .then((reply) => ({ target, reply })),
      ),
    )

    const merged = new Map<string, Map<string, RecallItem>>(
      RECALL_BUCKETS.map((bucket) => [bucket, new Map<string, RecallItem>()] as const),
    )
    let plan: string | null = null
    let total = 0
    for (const { target, reply } of replies) {
      if (!reply.ok || reply.result === null) {
        warnings.push(`检索 ${target.uri} 失败：${reply.error ?? `HTTP ${reply.status}`}`)
        continue
      }
      plan ??= reasoningOf(reply.result)
      for (const bucket of RECALL_BUCKETS) {
        const items = reply.result[bucket]
        if (!Array.isArray(items)) continue
        const into = merged.get(bucket)
        if (into === undefined) continue
        for (const item of items) {
          if (typeof item?.uri !== 'string' || item.uri.length === 0) continue
          total += 1
          // The same memory can be reached from two targets; keep the better
          // score rather than showing it twice.
          const existing = into.get(item.uri)
          if (existing === undefined || item.score > existing.score) into.set(item.uri, toRecallItem(item))
        }
      }
    }

    const buckets: RecallBucket[] = RECALL_BUCKETS.map((bucket) => ({
      bucket,
      items: [...(merged.get(bucket)?.values() ?? [])]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit),
    }))

    return {
      sessionId,
      ovSessionId,
      sessionUri,
      peer,
      query: { text: queryText, source: querySource },
      buckets,
      plan,
      targets: targets.map((target) => target.uri),
      total,
      latencyMs: this.now() - started,
      searchedAt: new Date().toISOString(),
      warnings,
    }
  }

  /** The session's most recent user prompt, from the plugin's own capture log. */
  private async sessionPrompt(
    sessionUri: string,
    request: { actorPeerId?: string },
  ): Promise<string | null> {
    const log = await this.options.api.readText(`${sessionUri}/messages.jsonl`, request)
    if (!log.ok || log.result === null) return null
    return latestUserPrompt(log.result)
  }

  /** One entry's full text, for the panel's detail view. */
  async content(uri: string): Promise<RecallContent | { error: string }> {
    if (!uri.startsWith('viking://')) {
      return { error: 'only viking:// entries can be read' }
    }
    const read = await this.options.api.readText(uri, { timeoutMs: 10000 })
    if (!read.ok || read.result === null) {
      return { error: read.error ?? `HTTP ${read.status}` }
    }
    const text = read.result
    return {
      uri,
      text: text.slice(0, RECALL_CONTENT_MAX_CHARS),
      truncated: text.length > RECALL_CONTENT_MAX_CHARS,
    }
  }
}

/**
 * The `viking://` targets one recall searches, in the plugin's own spirit.
 *
 * The user root covers the shared library; the peer's own tree is what the
 * session's own commits wrote, and is searched separately because the server
 * ranks within one target per call. Both memory targets feed the same bucket.
 */
export function searchTargets(
  sessionUri: string | null,
  user: string,
  peer: string | null,
): Array<{ bucket: string; uri: string }> {
  const root = userRootOf(sessionUri) ?? `viking://user/${user}`
  const targets: Array<{ bucket: string; uri: string }> = [{ bucket: 'memories', uri: `${root}/memories` }]
  if (peer !== null && peer.length > 0) {
    targets.push({ bucket: 'memories', uri: `${root}/peers/${peer}/memories` })
  }
  targets.push({ bucket: 'resources', uri: `${root}/resources` }, { bucket: 'skills', uri: `${root}/skills` })
  return targets
}

/** `viking://user/<user>` from a session path, or null when it is not one. */
export function userRootOf(sessionUri: string | null): string | null {
  if (sessionUri === null) return null
  const match = /^(viking:\/\/user\/[^/]+)/.exec(sessionUri)
  return match?.[1] ?? null
}

/**
 * The last user turn in a session's `messages.jsonl`.
 *
 * The file is the memory plugin's capture of the conversation and is reset when
 * the session is archived, so it holds the turns since the last commit — exactly
 * the window a "what would be recalled now" question is about. Lines are JSON
 * objects with a `role` and `parts`; anything unparseable is skipped rather than
 * failing the whole read.
 */
export function latestUserPrompt(jsonl: string): string | null {
  const lines = jsonl.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as { role?: unknown; parts?: unknown }
    if (record.role !== 'user') continue
    const text = textOfParts(record.parts)
    if (text.length > 0) return text.slice(0, MAX_QUERY_CHARS)
  }
  return null
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  const chunks: string[] = []
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') chunks.push(candidate.text)
  }
  return chunks.join('\n').trim()
}

function reasoningOf(response: OvSearchResponse): string | null {
  const reasoning = response.query_plan?.reasoning
  return typeof reasoning === 'string' && reasoning.trim().length > 0 ? reasoning.trim() : null
}

/** Plural path segment → the singular kind a tag names. */
const MEMORY_KINDS: Record<string, string> = {
  entities: 'entity',
  events: 'event',
  preferences: 'preference',
  experiences: 'experience',
  facts: 'fact',
  knowledge: 'knowledge',
  summaries: 'summary',
}

/**
 * The entry's own kind, read from the path the plugin writes.
 *
 * Retrieval says only `context_type` (memory/resource/skill) and this server
 * leaves `tags` empty, so `…/memories/events/2026/10/02/x.md` is the only place
 * that "this is an event" exists. An entry outside `memories/` has no kind.
 */
export function memoryTypeOf(uri: string): string {
  const segment = /\/memories\/([^/]+)\//.exec(uri)?.[1]
  if (segment === undefined) return ''
  return MEMORY_KINDS[segment] ?? segment
}

function toRecallItem(item: OvSearchItem): RecallItem {
  return {
    uri: item.uri,
    score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
    contextType: typeof item.context_type === 'string' ? item.context_type : '',
    memoryType: memoryTypeOf(item.uri),
    level: typeof item.level === 'number' ? item.level : null,
    abstract: typeof item.abstract === 'string' ? item.abstract : '',
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }
}

function emptyBuckets(): RecallBucket[] {
  return RECALL_BUCKETS.map((bucket) => ({ bucket, items: [] }))
}
