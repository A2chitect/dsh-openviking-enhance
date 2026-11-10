/**
 * Host-side Studio frameability probe.
 *
 * A cross-origin iframe cannot report *why* it failed to render: there is no
 * error event for an `X-Frame-Options`/CSP refusal, `load` can fire for the
 * browser's blocked-frame page, and the parent may not inspect the child
 * document. Guessing from the client is therefore not honest. This probe asks
 * the server itself for `/studio/`, reads the two headers that decide framing,
 * and classifies the answer — the client shows the reason and keeps "open in a
 * new tab" one click away.
 *
 * Privacy rules: the probe sends **no credentials and no cookies** (a plain,
 * anonymous GET), follows no redirect into a secret and reports only header
 * facts, never the page body. The request is bounded by its own timeout, and the
 * constructed URL is the same `endpoint + studioPath` the iframe would load.
 *
 * The GUI's own origin is deliberately NOT known here: the host has no business
 * knowing which port the browser reached it on, so an explicit CSP origin list
 * cannot be compared and is reported as `unknown` rather than assumed either way.
 */
import { STUDIO_STATUS_TIMEOUT_MS, STUDIO_STATUS_TTL_MS } from '../shared/limits.ts'
import type { StudioFrameable, StudioStatus, StudioStatusReason } from '../shared/protocol.ts'

export interface StudioStatusOptions {
  /** The ready-to-embed Studio URL (`endpoint + studioPath`), resolved live. */
  studioUrl: () => string
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
  now?: () => number
}

/** The classification of one probe answer; pure and unit-tested. */
export interface StudioProbeFacts {
  /** HTTP status, or 0 when the request never completed. */
  status: number
  headers: { get(name: string): string | null }
  error: string | null
}

/** Split a `Content-Security-Policy` header into directive → value tokens. */
export function parseCspFrameAncestors(header: string): string[] | null {
  for (const directive of header.split(';')) {
    const parts = directive.trim().split(/\s+/)
    if ((parts[0] ?? '').toLowerCase() !== 'frame-ancestors') continue
    return parts.slice(1).filter((token) => token.length > 0)
  }
  return null
}

/**
 * Classify the probe's answer.
 *
 * - `X-Frame-Options: DENY` blocks everything; `SAMEORIGIN` blocks the GUI's
 *   different port (a different origin), so both are `no`;
 * - a CSP `frame-ancestors` list containing `'none'` is `no`; a list whose only
 *   usable sources are `'self'`/`'none'` is also `no`; a wildcard/scheme source
 *   or an explicit origin list the host cannot compare to the GUI origin is
 *   `unknown` (framing may work; the fallback hint stays visible);
 * - 401/403 means Studio may render a login: framing is `unknown`;
 * - any other non-2xx is `http-error`; a transport failure/timeout is
 *   `probe-failed`.
 */
export function classifyStudioProbe(facts: StudioProbeFacts): { frameable: StudioFrameable; reason: StudioStatusReason; detail: string | null } {
  if (facts.error !== null) {
    return { frameable: 'unknown', reason: 'probe-failed', detail: facts.error }
  }
  const xfo = facts.headers.get('x-frame-options')?.trim().toLowerCase() ?? ''
  if (xfo.length > 0) {
    if (xfo === 'deny') return { frameable: 'no', reason: 'x-frame-options', detail: 'DENY' }
    if (xfo === 'sameorigin') return { frameable: 'no', reason: 'x-frame-options', detail: 'SAMEORIGIN' }
    // ALLOW-FROM is ignored by current browsers; report it as unknown, not as a lie.
    if (xfo.startsWith('allow-from')) return { frameable: 'unknown', reason: 'x-frame-options', detail: xfo.toUpperCase() }
    return { frameable: 'unknown', reason: 'x-frame-options', detail: xfo.toUpperCase() }
  }
  const csp = facts.headers.get('content-security-policy')
  if (csp !== null && csp.length > 0) {
    const ancestors = parseCspFrameAncestors(csp)
    if (ancestors !== null) {
      const lowered = ancestors.map((token) => token.toLowerCase())
      if (lowered.includes("'none'")) return { frameable: 'no', reason: 'csp-frame-ancestors', detail: 'frame-ancestors none' }
      const onlySelf = lowered.every((token) => token === "'self'")
      if (onlySelf) return { frameable: 'no', reason: 'csp-frame-ancestors', detail: 'frame-ancestors self' }
      // Wildcard/scheme sources, or an explicit origin list the host cannot
      // compare against the (unknown) GUI origin: framing may work.
      return { frameable: 'unknown', reason: 'csp-frame-ancestors', detail: 'frame-ancestors cannot be verified' }
    }
  }
  if (facts.status === 401 || facts.status === 403) {
    return { frameable: 'unknown', reason: 'auth-required', detail: `HTTP ${facts.status}` }
  }
  if (facts.status < 200 || facts.status >= 300) {
    return { frameable: 'unknown', reason: 'http-error', detail: `HTTP ${facts.status}` }
  }
  return { frameable: 'yes', reason: 'ok', detail: null }
}

export class StudioStatusService {
  private readonly options: StudioStatusOptions
  private readonly now: () => number
  private cached: { url: string; at: number; status: StudioStatus } | null = null
  private inflight: { url: string; promise: Promise<StudioStatus> } | null = null

  constructor(options: StudioStatusOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop the cached answer (identity switch). */
  resetCaches(): void {
    this.cached = null
    this.inflight = null
  }

  /** The frameability answer; cached 60 s, never throws. */
  async status(fresh = false): Promise<StudioStatus> {
    const url = this.options.studioUrl()
    if (!fresh && this.cached !== null && this.cached.url === url && this.now() - this.cached.at < STUDIO_STATUS_TTL_MS) {
      return this.cached.status
    }
    if (!fresh && this.inflight !== null && this.inflight.url === url) return this.inflight.promise
    const promise = this.probe(url).finally(() => {
      if (this.inflight?.url === url) this.inflight = null
    })
    this.inflight = { url, promise }
    const status = await promise
    this.cached = { url, at: this.now(), status }
    return status
  }

  /** One anonymous, bounded GET; every failure becomes `probe-failed`. */
  private async probe(url: string): Promise<StudioStatus> {
    const fetchImpl = this.options.fetch ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STUDIO_STATUS_TIMEOUT_MS)
    let facts: StudioProbeFacts
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        // No credentials, no cookies: this is a header probe, not a login.
        credentials: 'omit',
        headers: { accept: 'text/html' },
        signal: controller.signal,
      })
      facts = { status: response.status, headers: response.headers, error: null }
      // Drain/cancel the body; only the headers matter.
      try {
        await response.body?.cancel()
      } catch {
        // A body that cannot be cancelled is not a probe failure.
      }
    } catch (error) {
      facts = {
        status: 0,
        headers: { get: () => null },
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
    const classified = classifyStudioProbe(facts)
    return {
      url,
      frameable: classified.frameable,
      reason: classified.reason,
      detail: classified.detail,
      observedAt: new Date(this.now()).toISOString(),
    }
  }
}
