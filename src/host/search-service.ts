/**
 * F7: one search across everything OpenViking can retrieve.
 *
 * The server has two retrieval dialects, and the unified box merges them:
 *
 *  - `POST /api/v1/search/search` with `mode: "list"` ranks memories,
 *    resources and skills together. It has no rules bucket (and rejects
 *    `context_type: "rule"` with INVALID_ARGUMENT), so rules are a second call;
 *  - `POST /api/v1/rules/search` ranks the active Rules for a *task context*.
 *    The Explore search passes the typed query as that context, which is the
 *    closest read-only equivalent of "search the rules for this".
 *
 * Both are reads. A failure of the rules half is reported as a warning on an
 * otherwise usable answer — the whole search does not die because the optional
 * Rules feature is missing on an older server.
 *
 * The request's `buckets` filter maps to the server's `context_type` filter, so
 * unticking "resources" costs no extra work server-side.
 */
import {
  SEARCH_BUCKETS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type PluginNotice,
  type SearchBucket,
  type SearchBucketId,
  type SearchItem,
  type SearchPayload,
  type SearchType,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvRuleSearch, OvSearchItem } from './openviking-api.ts'
import { memoryTypeOf } from './recall-service.ts'
import { ruleFactsFromDocument } from './rule-format.ts'

/** Longest query accepted; the server accepts more, the UI never sends more. */
export const SEARCH_QUERY_MAX = 2000

export interface SearchRequest {
  query: string
  /** Raw request values: normalization happens in `search()`, not in the route. */
  searchType?: string
  buckets?: readonly string[]
  limit?: number
}

export interface SearchServiceOptions {
  api: OpenVikingApi
  now?: () => number
}

/** The server's `context_type` value for each display bucket that uses search. */
const SERVER_CONTEXT_TYPES: Partial<Record<SearchBucketId, string>> = {
  memories: 'memory',
  resources: 'resource',
  skills: 'skill',
}

/** Clamp one requested limit into the documented window. */
export function clampSearchLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(raw), 1), SEARCH_MAX_LIMIT)
}

/** Only the four known buckets survive; an empty list means "all". */
export function normalizeSearchBuckets(raw: readonly string[] | undefined): SearchBucketId[] {
  if (raw === undefined || raw.length === 0) return [...SEARCH_BUCKETS]
  const seen = new Set<SearchBucketId>()
  for (const candidate of raw) {
    if ((SEARCH_BUCKETS as readonly string[]).includes(candidate)) seen.add(candidate as SearchBucketId)
  }
  return SEARCH_BUCKETS.filter((bucket) => seen.has(bucket))
}

/** `semantic` unless the client explicitly asked for keywords. */
export function normalizeSearchType(raw: string | undefined): SearchType {
  return raw === 'keywords' ? 'keywords' : 'semantic'
}

/** One server search item in the unified result shape. */
export function toSearchItem(item: OvSearchItem, bucket: SearchBucketId): SearchItem {
  const contextType =
    typeof item.context_type === 'string' && item.context_type.length > 0
      ? item.context_type
      : (SERVER_CONTEXT_TYPES[bucket] ?? '')
  return {
    uri: item.uri,
    score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
    contextType,
    memoryType: memoryTypeOf(item.uri),
    level: typeof item.level === 'number' ? item.level : null,
    abstract: typeof item.abstract === 'string' ? item.abstract : '',
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    rule: null,
  }
}

/** The first meaningful line of a rule document, for a one-line result row. */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && candidate !== '---')
  return line ?? ''
}

export class SearchService {
  private readonly options: SearchServiceOptions

  constructor(options: SearchServiceOptions) {
    this.options = options
  }

  /**
   * Run one unified search.
   *
   * @throws Error when the query is empty, or when the main retrieval call
   * fails — a route then answers `{ok:false,error}`. The optional rules call
   * never throws; its failure becomes `warnings[].code === 'rulesUnavailable'`.
   */
  async search(request: SearchRequest): Promise<SearchPayload> {
    const query = (request.query ?? '').trim()
    if (query.length === 0) throw new Error('query-required')
    const bounded = query.slice(0, SEARCH_QUERY_MAX)
    const buckets = normalizeSearchBuckets(request.buckets)
    const limit = clampSearchLimit(request.limit)
    const searchType = normalizeSearchType(request.searchType)
    const started = this.now()
    const warnings: PluginNotice[] = []

    const serverBuckets = buckets
      .map((bucket) => SERVER_CONTEXT_TYPES[bucket])
      .filter((value): value is string => value !== undefined)

    const requestFor = (type: SearchType) => ({
      query: bounded,
      // No target: the server ranks everything the caller can read, which is the
      // point of "what is actually in OpenViking?".
      mode: 'list' as const,
      search_type: type,
      context_type: serverBuckets,
      limit,
      // 0 keeps weak matches visible: this is a browse surface, and a user who
      // typed a query wants to see what exists, not only what clears the
      // session-recall default.
      score_threshold: 0,
    })

    let effectiveType = searchType
    let searchReply =
      serverBuckets.length === 0 ? null : await this.options.api.search(requestFor(searchType))

    // `search_type: "keywords"` is backend-dependent: the 0.5.3 server this
    // plugin targets answers 400 INVALID_ARGUMENT ("Keyword search is not
    // supported by the configured vector backend"). Degrade to semantic for the
    // answer and report the gap once, instead of making the whole search fail.
    if (
      searchReply !== null &&
      !searchReply.ok &&
      searchType === 'keywords' &&
      (searchReply.status === 400 || searchReply.status === 422)
    ) {
      warnings.push({
        code: 'keywordsUnavailable',
        params: { error: searchReply.error ?? `HTTP ${searchReply.status}` },
      })
      effectiveType = 'semantic'
      searchReply = await this.options.api.search(requestFor('semantic'))
    }

    if (searchReply !== null && !searchReply.ok) {
      throw new Error(searchReply.error ?? `HTTP ${searchReply.status}`)
    }

    const groups: SearchBucket[] = buckets.map((bucket) => ({
      bucket,
      items: this.itemsFor(bucket, searchReply?.result ?? null),
    }))

    if (buckets.includes('rules')) {
      const rules = await this.options.api.rulesSearch(bounded)
      const rulesBucket = groups.find((group) => group.bucket === 'rules')
      if (rulesBucket !== undefined) {
        if (rules.ok) {
          rulesBucket.items = this.ruleItems(rules.result, limit)
        } else {
          warnings.push({
            code: 'rulesUnavailable',
            params: { error: rules.error ?? `HTTP ${rules.status}` },
          })
        }
      }
    }

    const shown = groups.reduce((sum, group) => sum + group.items.length, 0)
    return {
      query: bounded,
      searchType: effectiveType,
      buckets: groups,
      total: shown,
      latencyMs: Math.max(0, this.now() - started),
      searchedAt: new Date(this.now()).toISOString(),
      warnings,
    }
  }

  /** The server's per-bucket list for one display group. */
  private itemsFor(
    bucket: SearchBucketId,
    reply: { memories?: OvSearchItem[]; resources?: OvSearchItem[]; skills?: OvSearchItem[] } | null,
  ): SearchItem[] {
    if (reply === null) return []
    const raw = bucket === 'memories' ? reply.memories : bucket === 'resources' ? reply.resources : reply.skills
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item): item is OvSearchItem => item !== null && typeof item === 'object' && typeof item.uri === 'string')
      .slice(0, SEARCH_MAX_LIMIT)
      .map((item) => toSearchItem(item, bucket))
  }

  /** Rule matches, flattened into the same row shape. */
  private ruleItems(reply: OvRuleSearch | null, limit: number): SearchItem[] {
    const raw = Array.isArray(reply?.rules) ? reply.rules : []
    const items: SearchItem[] = []
    for (const rule of raw.slice(0, limit)) {
      const uri = typeof rule.uri === 'string' && rule.uri.length > 0 ? rule.uri : ''
      const content = typeof rule.content === 'string' ? rule.content : ''
      if (uri.length === 0 && content.length === 0) continue
      const facts = ruleFactsFromDocument(uri, content, {
        id: rule.atomic_id,
        revision: rule.revision,
        scenario: rule.scenario_id,
        probability: rule.probability,
      })
      const probability =
        typeof rule.probability === 'number' && Number.isFinite(rule.probability) ? rule.probability : null
      items.push({
        uri: uri.length > 0 ? uri : `${facts.scenario ?? 'rule'}/${facts.id}`,
        score: probability ?? 0,
        contextType: 'rule',
        memoryType: '',
        level: null,
        abstract: facts.constraint.length > 0 ? facts.constraint : firstLine(facts.body),
        tags: [],
        rule: {
          name: facts.name,
          status: facts.status,
          appliesWhen: facts.appliesWhen,
          exception: facts.exception,
          probability,
        },
      })
    }
    return items
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
