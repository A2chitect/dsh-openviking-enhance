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
import type {
  PluginNotice,
  RecallBucket,
  RecallContent,
  RecallEffectiveSettings,
  RecallExplainEntry,
  RecallExplainStats,
  RecallExplanation,
  RecallItem,
  RecallPayload,
  RecallQuerySource,
} from '../shared/protocol.ts'
import {
  RECALL_BUCKETS,
  RECALL_CONTENT_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_EXPLAIN_MAX_CHARS,
  RECALL_MAX_LIMIT,
} from '../shared/protocol.ts'
import type {
  OpenVikingApi,
  OvContextItem,
  OvContextRequest,
  OvContextResponse,
  OvContextStats,
  OvSearchItem,
  OvSearchResponse,
} from './openviking-api.ts'
import { resolveSessionUri } from './commit-service.ts'
import type { CommitService } from './commit-service.ts'
import { memoActive, readPluginMemo, type ContextFaceMemo, type LocalStateOptions } from './local-state.ts'

/** Longest query taken from a session log; longer text is truncated, not sent whole. */
const MAX_QUERY_CHARS = 2000

export interface RecallServiceOptions {
  api: OpenVikingApi
  /** Session identity and actor peer come from the same place commits read them. */
  commit: CommitService
  /** How long one query's answer is reused for re-renders. */
  cacheTtlMs?: number
  /** Test seam for the official plugin's local capability memo. */
  localState?: LocalStateOptions
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

  /**
   * Explain one recall: the query, every hit with the server's own score and
   * provenance, the token budget and, above all, the server's accounting.
   *
   * Two data paths, in the order the official memory plugin tries them:
   *
   *  1. the **context face** (`mode: "context"`), which returns one assembled
   *     block plus `stats` — quotas, budget, de-duplication, exclusions;
   *  2. the **per-target search** the recall panel already uses, for servers
   *     that predate the context face. It has no accounting, so `stats` is null
   *     and the card says the server is the legacy path.
   *
   * `replay` is always true and deliberately not configurable: DSH does not
   * retain the memory plugin's injected block, so this is the same request
   * replayed under the session's current state. Saying so is more useful than
   * pretending the numbers are the historical injection's.
   */
  async explain(
    sessionId: string,
    query?: string,
    options: { fresh?: boolean; source?: RecallQuerySource } = {},
  ): Promise<RecallExplanation> {
    const started = this.now()
    const warnings: PluginNotice[] = []
    const { api, commit } = this.options

    const ovSessionId = commit.ovSessionId(sessionId)
    const peer = commit.actorPeer(sessionId) ?? null
    const request = peer === null ? {} : { actorPeerId: peer }
    const config = commit.pluginConfig(sessionId)
    const effective = effectiveRecallSettings(config)

    const explicit = (query ?? '').trim().slice(0, MAX_QUERY_CHARS)
    const source: RecallQuerySource = options.source ?? (explicit.length > 0 ? 'manual' : 'session')

    const meta = await api.getSession(ovSessionId, request)
    const sessionUri = meta.ok && meta.result ? resolveSessionUri(meta.result, ovSessionId, api.user) : null
    if (!meta.ok) hints(warnings, 'sessionFailed', { error: meta.error ?? `HTTP ${meta.status}` })

    let queryText = explicit
    if (queryText.length === 0 && sessionUri !== null) {
      const prompt = await this.sessionPrompt(sessionUri, request)
      if (prompt === null) hints(warnings, 'noPrompt')
      else queryText = prompt
    }

    const base = {
      sessionId,
      ovSessionId,
      sessionUri,
      peer,
      effective,
      replay: true as const,
      searchedAt: new Date().toISOString(),
    }

    if (queryText.length === 0) {
      return {
        ...base,
        query: { text: '', source },
        mode: 'search',
        entries: [],
        stats: null,
        rendered: null,
        renderedTruncated: false,
        plan: null,
        targets: [],
        total: 0,
        latencyMs: this.now() - started,
        warnings,
      }
    }

    // The official plugin remembers a server without a context face for a few
    // hours; honouring that memo avoids one guaranteed 400 on every explanation.
    const memo = await readPluginMemo<ContextFaceMemo>('context-face.json', this.options.localState)
    let contextError: string | null = null
    if (!memoActive(memo, this.now())) {
      const body = contextRequestBody(queryText, ovSessionId, config)
      const timeoutMs = contextRequestTimeoutMs(config, body)
      const reply = await api.searchContext(
        body,
        timeoutMs === undefined ? request : { ...request, timeoutMs },
      )
      if (reply.ok && reply.result !== null) {
        return this.contextExplanation(base, queryText, source, reply.result, started, warnings)
      }
      contextError = reply.error ?? `HTTP ${reply.status}`
    }

    const fallback = await this.collect(sessionId, queryText, RECALL_DEFAULT_LIMIT)
    if (contextError !== null) {
      hints(warnings, 'contextUnavailable', { error: contextError })
    }
    for (const warning of fallback.warnings) warnings.push(warning)
    return {
      ...base,
      query: { text: fallback.query.text, source },
      mode: 'search',
      entries: entriesFromPayload(fallback),
      stats: null,
      rendered: null,
      renderedTruncated: false,
      plan: fallback.plan,
      targets: fallback.targets,
      total: fallback.total,
      latencyMs: this.now() - started,
      warnings,
    }
  }

  /** The context-face answer, mapped onto the explanation contract. */
  private contextExplanation(
    base: Pick<
      RecallExplanation,
      'sessionId' | 'ovSessionId' | 'sessionUri' | 'peer' | 'effective' | 'replay' | 'searchedAt'
    >,
    queryText: string,
    source: RecallQuerySource,
    response: OvContextResponse,
    started: number,
    warnings: PluginNotice[],
  ): RecallExplanation {
    const entries = (response.entries ?? []).map(toExplainEntry)
    const rendered = typeof response.rendered === 'string' ? response.rendered : null
    return {
      ...base,
      query: { text: queryText, source },
      mode: 'context',
      entries,
      stats: toExplainStats(response.stats),
      rendered: rendered === null ? null : rendered.slice(0, RECALL_EXPLAIN_MAX_CHARS),
      renderedTruncated: rendered !== null && rendered.length > RECALL_EXPLAIN_MAX_CHARS,
      plan: null,
      targets: [],
      total: entries.length,
      latencyMs: this.now() - started,
      warnings,
    }
  }

  private async collect(sessionId: string, explicitQuery: string, limit: number): Promise<RecallPayload> {
    const started = this.now()
    const warnings: PluginNotice[] = []
    const { api, commit } = this.options

    const ovSessionId = commit.ovSessionId(sessionId)
    const peer = commit.actorPeer(sessionId) ?? null
    const request = peer === null ? {} : { actorPeerId: peer }

    const meta = await api.getSession(ovSessionId, request)
    const sessionUri = meta.ok && meta.result ? resolveSessionUri(meta.result, ovSessionId, api.user) : null
    if (!meta.ok) warnings.push({ code: 'sessionFailed', params: { error: meta.error ?? `HTTP ${meta.status}` } })

    let queryText = explicitQuery
    let querySource: RecallQuerySource = 'manual'
    if (queryText.length === 0 && sessionUri !== null) {
      const prompt = await this.sessionPrompt(sessionUri, request)
      if (prompt === null) warnings.push({ code: 'noPrompt' })
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
        warnings.push({ code: 'targetFailed', params: { target: target.uri, error: reply.error ?? `HTTP ${reply.status}` } })
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
      return { error: 'not-a-viking-path' }
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

/** Push one host notice; the wording lives in the client's `notice.*` table. */
function hints(list: PluginNotice[], code: string, params?: Record<string, string | number>): void {
  list.push(params === undefined ? { code } : { code, params })
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The context-face request the mounted memory plugin would build for this
 * session, minus the parts that depend on its local compressor.
 *
 * `recallLimitConfigured` / `recallMaxTokensConfigured` are the plugin's own
 * "was this knob explicitly set" flags: it sends `quotas` and `max_tokens` only
 * when they are, so a default install keeps the server's policy. Sending them
 * unconditionally would change the very ranking the explanation is meant to
 * show.
 */
export function contextRequestBody(
  query: string,
  ovSessionId: string,
  config: Record<string, unknown> | null,
): OvContextRequest {
  // These fallbacks only feed the two `*Configured` branches below; when the
  // knobs are unset the fields are omitted and the server's own defaults apply.
  // Keeping the fallbacks aligned with 0.5.32's DEFAULT_CONTEXT_* values is a
  // last-resort guard, not a claim about a future server.
  const limit = Math.max(1, Math.floor(asNumber(config?.recallLimit) ?? 10))
  const maxTokens = Math.max(64, Math.floor(asNumber(config?.recallMaxTokens) ?? 1600))
  const body: OvContextRequest = {
    query,
    mode: 'context',
    purpose: 'coding',
    score_threshold: asNumber(config?.scoreThreshold) ?? 0.35,
    session_id: ovSessionId,
  }
  if (config?.recallLimitConfigured === true) body.quotas = codingQuotas(limit)
  if (config?.recallMaxTokensConfigured === true) body.max_tokens = maxTokens
  const dedup = asNumber(config?.recallDedupTurns)
  const dedupTurns = dedup === null ? 5 : Math.max(0, Math.floor(dedup))
  if (dedupTurns > 0) body.dedup_turns = dedupTurns
  if (config?.recallQueryExpansionConfigured === true) {
    body.query_expansion = config.recallQueryExpansion === 'off' ? 'off' : 'auto'
  }
  if (config?.recallPeerScope === 'actor') body.peer_scope = 'actor'
  const decay = asText(config?.recallEventsDecayProtection)
  if (decay !== null) body.events_time_decay_protection = decay
  const exclude = config?.recallExcludeUris
  if (Array.isArray(exclude)) {
    const uris = exclude.filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (uris.length > 0) body.exclude_uris = uris.slice(0, 200)
  }
  const rewrite = asText(config?.recallRewrite)
  // The official plugin's real call site never passes `localCompressorAvailable`,
  // so `auto` always sends the server-side rewrite. Mirror it rather than quietly
  // sending a different request than the one the turn made.
  if (rewrite === 'server') body.rewrite = true
  else if (rewrite === 'auto') body.rewrite = 'auto'
  if (body.rewrite !== undefined) {
    const bullets = asNumber(config?.recallCompressMaxBullets)
    if (config?.recallCompressMaxBulletsConfigured === true && bullets !== null) {
      body.rewrite_max_bullets = Math.max(1, Math.floor(bullets))
    }
  }
  return body
}

/**
 * The HTTP deadline for one context request, derived the way the memory plugin
 * derives it.
 *
 * The server pipeline is serial and the expansion and rewrite stages have their
 * own fuses; a request that asks for either must survive the longest of them or
 * the card would report a healthy server as unreachable. An explicit
 * `recallContextTimeoutMs` wins; otherwise the floor is 45 s for rewrite and 15 s
 * for expansion, never below the plugin's `timeoutMs`.
 */
export function contextRequestTimeoutMs(
  config: Record<string, unknown> | null,
  body: Pick<OvContextRequest, 'rewrite' | 'session_id' | 'query_expansion'>,
): number | undefined {
  const configured = asNumber(config?.recallContextTimeoutMs)
  if (configured !== null && configured > 0) return Math.max(1000, Math.floor(configured))
  const wantsRewrite = body.rewrite !== undefined
  const wantsExpansion = body.session_id !== undefined && body.query_expansion !== 'off'
  if (!wantsRewrite && !wantsExpansion) return undefined
  const floor = wantsRewrite ? 45_000 : 15_000
  return Math.max(asNumber(config?.timeoutMs) ?? 0, floor)
}

/**
 * The plugin's coding-purpose quota split, mirrored exactly.
 *
 * This is only used when the person explicitly configured a recall limit. The
 * weights and the largest-remainder loop are copied from the memory plugin's
 * `codingQuotas`; a different split would send a different request than the one
 * a real turn makes.
 */
export function codingQuotas(limit: number): Record<string, number> {
  const weights: Record<string, number> = {
    events: 1,
    entities: 2,
    preferences: 1,
    experiences: 1,
    resources: 3,
    skills: 2,
  }
  const slots = Math.max(1, Math.floor(limit))
  const order = Object.keys(weights)
  const quotas: Record<string, number> = Object.fromEntries(order.map((key) => [key, 0]))
  if (slots < order.length) {
    for (const key of order) quotas[key] = 1
    return quotas
  }
  for (const key of order) quotas[key] = 1
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  const ideals: Record<string, number> = Object.fromEntries(
    order.map((key) => [key, (slots * (weights[key] ?? 0)) / totalWeight]),
  )
  const allocated = () => order.reduce((sum, key) => sum + (quotas[key] ?? 0), 0)
  while (allocated() < slots) {
    const key = order.reduce((best, candidate) =>
      (ideals[candidate] ?? 0) - (quotas[candidate] ?? 0) > (ideals[best] ?? 0) - (quotas[best] ?? 0)
        ? candidate
        : best,
    )
    quotas[key] = (quotas[key] ?? 0) + 1
  }
  return quotas
}

/** The effective, non-secret memory-plugin values the explanation used. */
export function effectiveRecallSettings(
  config: Record<string, unknown> | null,
): RecallEffectiveSettings | null {
  if (config === null) return null
  return {
    scoreThreshold: asNumber(config.scoreThreshold),
    recallLimit: asNumber(config.recallLimit),
    recallMaxTokens: asNumber(config.recallMaxTokens),
    recallTokenBudget: asNumber(config.recallTokenBudget),
    dedupTurns: asNumber(config.recallDedupTurns),
    queryExpansion: asText(config.recallQueryExpansion),
    rewrite: asText(config.recallRewrite),
    peerScope: asText(config.recallPeerScope),
    commitTokenThreshold: asNumber(config.commitTokenThreshold),
  }
}

/** The display group for a hit, from its URI or the server's category. */
export function bucketOf(uri: string, category: string | null): string {
  if (category === 'skills' || uri.includes('/skills/')) return 'skills'
  if (category === 'resources' || uri.includes('/resources/')) return 'resources'
  return 'memories'
}

function toExplainEntry(item: OvContextItem): RecallExplainEntry {
  const category = asText(item.category) ?? memoryTypeOf(item.uri)
  const text = asText(item.text) ?? asText(item.abstract) ?? ''
  return {
    uri: item.uri,
    score: Number.isFinite(item.score) ? item.score : 0,
    bucket: bucketOf(item.uri, category),
    category: category.length > 0 ? category : 'memory',
    detail: asText(item.detail),
    origin: asText(item.origin),
    abstract: text,
    memoryType: memoryTypeOf(item.uri) || category,
    level: typeof item.level === 'number' && Number.isFinite(item.level) ? item.level : null,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }
}

function toExplainStats(stats: OvContextStats | undefined): RecallExplainStats | null {
  if (stats === undefined) return null
  const dedup = stats.dedup
  return {
    searched: stats.searched ?? {},
    candidates: stats.candidates ?? null,
    returned: stats.returned ?? null,
    dropped: stats.dropped ?? null,
    deduped: stats.deduped ?? null,
    excluded: stats.excluded ?? null,
    maxTokens: stats.max_tokens ?? null,
    usedTokens: stats.used_tokens ?? null,
    quotas: stats.quotas ?? {},
    tierCounts: stats.tier_counts ?? {},
    origins: stats.origins ?? {},
    peerScope: asText(stats.peer_scope),
    plannedQueries: Array.isArray(stats.planned_queries)
      ? stats.planned_queries.filter((value): value is string => typeof value === 'string')
      : [],
    queryExpansion: asText(stats.query_expansion),
    rewrite: asText(stats.rewrite),
    scoreThreshold: asNumber(stats.score_threshold),
    dedup:
      dedup === undefined
        ? null
        : {
            turns: asNumber(dedup.turns),
            status: asText(dedup.status),
            cooled: asNumber(dedup.cooled),
            turn: asNumber(dedup.turn),
          },
    fill: stats.fill ?? null,
  }
}

function entriesFromPayload(payload: RecallPayload): RecallExplainEntry[] {
  return payload.buckets.flatMap((bucket) =>
    bucket.items.map((item) => ({
      uri: item.uri,
      score: item.score,
      bucket: bucket.bucket,
      category: item.memoryType || item.contextType || bucket.bucket,
      detail: item.level === null ? null : `L${item.level}`,
      origin: null,
      abstract: item.abstract,
      memoryType: item.memoryType,
      level: item.level,
      tags: item.tags,
    })),
  )
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
