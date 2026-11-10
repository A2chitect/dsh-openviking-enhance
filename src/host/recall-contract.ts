/**
 * The wire contract for the session-aware recall request.
 *
 * The recall plan has to be the same request a live turn makes, otherwise the
 * panel would explain a ranking the server never produced. This module owns the
 * three pieces of that request that are not merely "send this field with that
 * value": how the server's per-category quota budget is apportioned, which
 * optional context-face fields the mounted plugin's configuration asks for, and
 * how long the HTTP deadline must be for the two optional server stages.
 *
 * ### Provenance
 *
 * Everything below is an **interface fact** written down from the documented
 * OpenViking request/response schema and the behaviour observed through HTTP:
 * field names the server accepts, the quota weights the coding-purpose context
 * face applies, the intent each optional field carries, and the stage budgets
 * the request deadline must survive. The contract itself is recorded here, and
 * the numbers in `test/fixtures/recall-wire/context-requests.json` are derived
 * by applying that contract; no other plugin's source expression is reproduced
 * here. See `PROVENANCE.md` for the full record and `scripts/check-independence.mjs`
 * for the gate that keeps it that way.
 *
 * ### The contract, in one place
 *
 * **Quotas.** Six categories (`RECALL_QUOTA_WEIGHTS`) each receive one
 * guaranteed slot when the requested recall limit is at least six. The
 * remaining `limit - 6` slots go to the categories with the largest *unmet
 * proportional demand*, where a category's demand is
 * `limit * weight / sum(weights) - alreadyAllocated`; every award reduces the
 * winning category's remaining demand by one, and ties are broken by the
 * category order below (earlier wins). When `limit < 6` every category still
 * receives one slot, so the total intentionally exceeds the limit; that edge is
 * part of the contract and must not be "fixed". The mapping is only used when
 * the mounted memory plugin reports the recall limit as explicitly configured —
 * a default install leaves `quotas` out so the server policy applies.
 *
 * **Request body.** `query`, `mode:'context'`, `purpose:'coding'`,
 * `score_threshold` (configured value, else 0.35) and `session_id` are always
 * sent. `quotas` only when the recall limit is explicitly configured;
 * `max_tokens` only when the token cap is explicitly configured (floor 64,
 * default 1600); `dedup_turns` defaults to 5 when absent and is omitted at 0;
 * `query_expansion` only when explicitly configured (`off`/`auto`); `peer_scope`
 * is `'actor'` only for actor scope; `events_time_decay_protection` when
 * non-empty; `exclude_uris` is capped at 200; `rewrite` is `true` for `server`
 * and `'auto'` for `auto` (the mounted plugin's real call site never passes the
 * local-compressor flag, so `auto` always means the server-side rewrite);
 * `rewrite_max_bullets` only for a rewrite request when explicitly configured.
 *
 * **Timeout.** An explicit `recallContextTimeoutMs` wins (at least 1000 ms).
 * Otherwise the request needs no special deadline when it asks for neither
 * rewrite nor expansion. If it asks for either, the deadline is the configured
 * request timeout (0 when absent) raised to the stage budget: 45 s for rewrite,
 * 15 s for expansion. Those two constants are server stage budgets observed
 * through the request deadline; changing them is a deliberate contract change.
 */
import type { OvContextRequest } from './openviking-api.ts'

/**
 * One body category and its retrieval weight, in the contract's tie-break order.
 *
 * The weights are the coding-purpose distribution the context face applies;
 * they are sent as plain integers inside `quotas`, so a fraction would be a
 * different contract.
 */
export const RECALL_QUOTA_WEIGHTS: ReadonlyArray<{ category: string; weight: number }> = Object.freeze([
  Object.freeze({ category: 'events', weight: 1 }),
  Object.freeze({ category: 'entities', weight: 2 }),
  Object.freeze({ category: 'preferences', weight: 1 }),
  Object.freeze({ category: 'experiences', weight: 1 }),
  Object.freeze({ category: 'resources', weight: 3 }),
  Object.freeze({ category: 'skills', weight: 2 }),
])

/** Sum of {@link RECALL_QUOTA_WEIGHTS}; derived so it cannot drift. */
const TOTAL_WEIGHT = RECALL_QUOTA_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0)

/** Recall limit assumed when the plugin reports no explicit limit. */
export const DEFAULT_RECALL_QUOTA_LIMIT = 10
/** Token cap assumed when the plugin reports no explicit token cap. */
export const DEFAULT_RECALL_MAX_TOKENS = 1600
/** The server's own floor for a context-face token budget. */
export const MIN_RECALL_MAX_TOKENS = 64
/** The context face's default score threshold. */
export const DEFAULT_SCORE_THRESHOLD = 0.35
/** Cross-turn de-duplication window assumed when the plugin does not report one. */
export const DEFAULT_DEDUP_TURNS = 5
/** Largest `exclude_uris` list the request may carry. */
export const MAX_EXCLUDE_URIS = 200
/** The server rewrite stage's budget; the request deadline must survive it. */
export const REWRITE_STAGE_BUDGET_MS = 45_000
/** The server query-expansion stage's budget. */
export const EXPANSION_STAGE_BUDGET_MS = 15_000
/** A configured context deadline is never below this. */
export const MIN_CONTEXT_TIMEOUT_MS = 1000

/** A finite number as written, or null. */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A non-empty string as written, or null. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The quota split the configured recall limit produces.
 *
 * Implementation: base seats first, then a residual-seat auction. Each category
 * can bid for additional seats with descending remaining demand
 * `ideal - base - k`; sorting every bid and taking the top `limit - 6` is the
 * same deterministic award sequence as recomputing the maximum after each seat,
 * but it is expressed as a sort over bids instead of a mutation loop. Ties fall
 * to the earlier category because the comparator is total.
 */
export function allocateRecallQuotas(limit: number): Readonly<Record<string, number>> {
  const slots = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  const categories = RECALL_QUOTA_WEIGHTS.map((entry) => entry.category)
  const seats = new Map<string, number>(categories.map((category) => [category, 1]))
  if (slots < categories.length) {
    // Contract edge: every category keeps its guaranteed seat, so the totals
    // exceed the limit. The server owns how it reconciles that; the request
    // shape is what this plugin reproduces.
    return Object.freeze(Object.fromEntries(seats))
  }
  const residual = slots - categories.length
  const bids: Array<{ index: number; demand: number }> = []
  for (let index = 0; index < categories.length; index += 1) {
    const ideal = (slots * (RECALL_QUOTA_WEIGHTS[index]?.weight ?? 0)) / TOTAL_WEIGHT
    for (let seat = 0; seat < residual; seat += 1) {
      // The base seat already covers one unit of the ideal demand.
      bids.push({ index, demand: ideal - 1 - seat })
    }
  }
  bids.sort((left, right) => right.demand - left.demand || left.index - right.index)
  for (const bid of bids.slice(0, residual)) {
    const category = categories[bid.index] ?? ''
    seats.set(category, (seats.get(category) ?? 1) + 1)
  }
  return Object.freeze(Object.fromEntries(seats))
}

/** The context-face request body for one query/session/config triple. */
export function buildRecallContextBody(input: {
  query: string
  sessionId: string
  config: Record<string, unknown> | null
}): OvContextRequest {
  const config = input.config
  const body: OvContextRequest = {
    query: input.query,
    mode: 'context',
    purpose: 'coding',
    score_threshold: finiteNumberOrNull(config?.scoreThreshold) ?? DEFAULT_SCORE_THRESHOLD,
    session_id: input.sessionId,
  }

  // The two `*Configured` flags are the mounted plugin's own "was this knob
  // explicitly set" answers; honouring them keeps a default install on the
  // server's policy instead of overriding the ranking the explanation explains.
  if (config?.recallLimitConfigured === true) {
    body.quotas = allocateRecallQuotas(
      finiteNumberOrNull(config.recallLimit) ?? DEFAULT_RECALL_QUOTA_LIMIT,
    )
  }
  if (config?.recallMaxTokensConfigured === true) {
    const cap = finiteNumberOrNull(config.recallMaxTokens) ?? DEFAULT_RECALL_MAX_TOKENS
    body.max_tokens = Math.max(MIN_RECALL_MAX_TOKENS, Math.floor(cap))
  }

  const configuredDedup = finiteNumberOrNull(config?.recallDedupTurns)
  const dedupTurns = configuredDedup === null ? DEFAULT_DEDUP_TURNS : Math.max(0, Math.floor(configuredDedup))
  if (dedupTurns > 0) body.dedup_turns = dedupTurns

  if (config?.recallQueryExpansionConfigured === true) {
    const requested = textOrNull(config.recallQueryExpansion)?.trim().toLowerCase() ?? null
    body.query_expansion = requested === 'off' ? 'off' : 'auto'
  }
  if (config?.recallPeerScope === 'actor') body.peer_scope = 'actor'

  const decay = textOrNull(config?.recallEventsDecayProtection)?.trim()
  if (decay !== undefined && decay.length > 0) body.events_time_decay_protection = decay

  if (Array.isArray(config?.recallExcludeUris)) {
    const excludes = config.recallExcludeUris.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    if (excludes.length > 0) body.exclude_uris = excludes.slice(0, MAX_EXCLUDE_URIS)
  }

  const rewrite = textOrNull(config?.recallRewrite)?.trim().toLowerCase() ?? null
  if (rewrite === 'server') body.rewrite = true
  else if (rewrite === 'auto') body.rewrite = 'auto'
  if (body.rewrite !== undefined && config?.recallCompressMaxBulletsConfigured === true) {
    const bullets = finiteNumberOrNull(config.recallCompressMaxBullets)
    if (bullets !== null) body.rewrite_max_bullets = Math.max(1, Math.floor(bullets))
  }

  return body
}

/**
 * The HTTP deadline a replay must survive for the optional server stages.
 *
 * The context pipeline is serial and the expansion/rewrite stages have their own
 * fuses; a deadline shorter than the longest requested stage would report a
 * healthy but slow server as unreachable, so the floor is applied per stage and
 * the configured request timeout can only raise it. `undefined` means the plain
 * request timeout is enough.
 */
export function recallContextTimeoutMs(
  config: Record<string, unknown> | null,
  body: Pick<OvContextRequest, 'rewrite' | 'session_id' | 'query_expansion'>,
): number | undefined {
  const configured = finiteNumberOrNull(config?.recallContextTimeoutMs)
  if (configured !== null && configured > 0) return Math.max(MIN_CONTEXT_TIMEOUT_MS, Math.floor(configured))
  const wantsRewrite = body.rewrite !== undefined
  const wantsExpansion = body.session_id !== undefined && body.query_expansion !== 'off'
  if (!wantsRewrite && !wantsExpansion) return undefined
  const stageFloor = wantsRewrite ? REWRITE_STAGE_BUDGET_MS : EXPANSION_STAGE_BUDGET_MS
  return Math.max(finiteNumberOrNull(config?.timeoutMs) ?? 0, stageFloor)
}
