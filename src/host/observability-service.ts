/**
 * v0.8 "Operate": the read-only Observability route.
 *
 * Composes the observer endpoints the live 0.5.3 server actually answers
 * (`format=json`) plus two console aggregates (token usage day buckets and
 * context-commit 4 h buckets), each independently degradable: one failing card
 * renders an error line, never the whole page.
 *
 * Two binding decisions live here:
 *
 *  - **Never `/metrics`.** Prometheus is disabled by default and the live server
 *    answers 404 JSON; v0.5 already decided not to probe it. This service has no
 *    path to that endpoint at all.
 *  - **On demand only.** Observer endpoints can be medium-cost (`system`,
 *    `models`), so answers are cached for `OBSERVABILITY_CACHE_TTL_MS` and only
 *    requested when the user opens the segment or presses Refresh — nothing here
 *    is polled.
 */
import {
  OBSERVABILITY_CACHE_TTL_MS,
  OBSERVABILITY_MAX_DAYS,
} from '../shared/limits.ts'
import type {
  ObservabilityCard,
  ObservabilityCardId,
  ObservabilityPayload,
  ObservabilitySeries,
  PluginNotice,
} from '../shared/protocol.ts'
import type { OpenVikingApi } from './openviking-api.ts'

/** The fixed card set, in display order (each is one observer endpoint). */
const OBSERVER_CARDS: readonly ObservabilityCardId[] = ['system', 'queue', 'retrieval', 'vikingdb', 'lock', 'filesystem', 'models']

/** A card with no data yet (per-card degrade). */
function emptyCard(id: ObservabilityCardId, error: string | null): ObservabilityCard {
  return { id, name: null, available: false, healthy: null, hasErrors: null, error, facts: [], rows: [] }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Flatten one observer `status` object into bounded display facts/rows. */
function cardFromObserver(id: ObservabilityCardId, result: Record<string, unknown>): ObservabilityCard {
  const status = result.status !== null && typeof result.status === 'object' ? (result.status as Record<string, unknown>) : {}
  const facts: Array<{ key: string; value: string }> = []
  const rows: string[][] = []
  const queues = status.queues
  if (Array.isArray(queues)) {
    rows.push(['queue', 'pending', 'in_progress', 'processed', 'errors'])
    for (const queue of queues.slice(0, 20)) {
      if (queue === null || typeof queue !== 'object') continue
      const row = queue as Record<string, unknown>
      rows.push([
        String(row.queue ?? row.name ?? ''),
        String(row.pending ?? 0),
        String(row.in_progress ?? 0),
        String(row.processed ?? 0),
        String(row.errors ?? 0),
      ])
    }
  }
  for (const [key, value] of Object.entries(status)) {
    if (facts.length >= 16) break
    if (key === 'queues') continue
    if (typeof value === 'number' || typeof value === 'boolean') facts.push({ key, value: String(value) })
    else if (typeof value === 'string') facts.push({ key, value: value.slice(0, 120) })
    else if (Array.isArray(value)) facts.push({ key, value: `${value.length} row(s)` })
    else if (value !== null && typeof value === 'object') facts.push({ key, value: 'object' })
  }
  return {
    id,
    name: text(result.name),
    available: true,
    healthy: typeof result.is_healthy === 'boolean' ? result.is_healthy : null,
    hasErrors: typeof result.has_errors === 'boolean' ? result.has_errors : null,
    error: null,
    facts,
    rows,
  }
}

/** The token/context-commit console answers are untyped; normalize defensively. */
export function seriesFromConsole(raw: Record<string, unknown> | null): ObservabilitySeries {
  if (raw === null) return { available: false, error: null, columns: [], rows: [], note: 'unavailable' }
  if (raw.enabled === false) {
    return { available: false, error: null, columns: [], rows: [], note: 'console-disabled' }
  }
  const candidates = ['buckets', 'rows', 'series', 'items', 'data'] as const
  let list: unknown[] | null = null
  for (const key of candidates) {
    if (Array.isArray(raw[key])) {
      list = raw[key] as unknown[]
      break
    }
  }
  if (list === null && Array.isArray(raw)) list = raw as unknown[]
  if (list === null) {
    // A flat aggregate object: render its numeric fields as one row.
    const numeric = Object.entries(raw).filter(([, value]) => typeof value === 'number')
    if (numeric.length === 0) return { available: false, error: null, columns: [], rows: [], note: 'no-data' }
    return {
      available: true,
      error: null,
      columns: numeric.map(([key]) => key.slice(0, 40)),
      rows: [numeric.map(([, value]) => String(value))],
      note: null,
    }
  }
  const rows: string[][] = []
  const columns: string[] = []
  for (const entry of list.slice(0, 40)) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (columns.length === 0) {
      for (const key of Object.keys(record)) {
        if (key === 'bucket' || key === 'date' || key === 'label' || key === 'time') continue
        if (columns.length >= 8) break
        columns.push(key.slice(0, 40))
      }
    }
    const label = text(record.bucket) ?? text(record.date) ?? text(record.label) ?? text(record.time) ?? ''
    rows.push([label, ...columns.map((column) => String(record[column] ?? ''))])
  }
  return { available: true, error: null, columns: ['bucket', ...columns], rows, note: rows.length === 0 ? 'no-data' : null }
}

/** Local date `YYYY-MM-DD` for a Date (the console's viewer-local format). */
function localDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface ObservabilityServiceOptions {
  api: OpenVikingApi
  now?: () => number
  cacheTtlMs?: number
}

export class ObservabilityService {
  private readonly options: ObservabilityServiceOptions
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private cached: { days: number; payload: ObservabilityPayload } | null = null

  constructor(options: ObservabilityServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? OBSERVABILITY_CACHE_TTL_MS
  }

  /** Forget the cache (identity switch / plugin unload). */
  resetCaches(): void {
    this.cached = null
  }

  /**
   * One composed answer. `fresh` (the Refresh button) bypasses the cache; the
   * default call reuses an answer younger than the documented TTL.
   */
  async read(days: number, fresh: boolean): Promise<ObservabilityPayload> {
    const boundedDays = Math.min(Math.max(Math.trunc(days), 1), OBSERVABILITY_MAX_DAYS)
    if (!fresh && this.cached !== null && this.cached.days === boundedDays && this.now() - Date.parse(this.cached.payload.observedAt) < this.cacheTtlMs) {
      return { ...this.cached.payload, cached: true }
    }
    const warnings: PluginNotice[] = []
    const observedAt = new Date(this.now()).toISOString()
    const end = new Date(this.now())
    const start = new Date(end.getTime() - (boundedDays - 1) * 24 * 60 * 60 * 1000)
    const startDate = localDate(start)
    const endDate = localDate(end)

    const cardResults = await Promise.all(
      OBSERVER_CARDS.map(async (id): Promise<ObservabilityCard> => {
        const response = await this.options.api.observerJson(id)
        if (!response.ok) {
          warnings.push({ code: 'observabilityCardUnavailable', params: { card: id } })
          return emptyCard(id, response.status === 404 ? 'not-supported' : response.error ?? 'unavailable')
        }
        return cardFromObserver(id, response.result ?? {})
      }),
    )
    const [tokensResponse, contextResponse] = await Promise.all([
      this.options.api.consoleTokens(startDate, endDate),
      this.options.api.consoleContextCommits(startDate, endDate, { bucket: '4h' }),
    ])
    if (!tokensResponse.ok) warnings.push({ code: 'observabilityTokensUnavailable' })
    if (!contextResponse.ok) warnings.push({ code: 'observabilityContextCommitsUnavailable' })
    const payload: ObservabilityPayload = {
      days: boundedDays,
      cacheTtlMs: this.cacheTtlMs,
      cached: false,
      cards: cardResults,
      tokens: tokensResponse.ok ? seriesFromConsole(tokensResponse.result ?? null) : { available: false, error: tokensResponse.error, columns: [], rows: [], note: 'unavailable' },
      contextCommits: contextResponse.ok
        ? seriesFromConsole(contextResponse.result ?? null)
        : { available: false, error: contextResponse.error, columns: [], rows: [], note: 'unavailable' },
      warnings,
      observedAt,
    }
    this.cached = { days: boundedDays, payload }
    return payload
  }
}
