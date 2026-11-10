/**
 * Trust fence for this plugin's HTTP routes.
 *
 * ## Why this exists
 *
 * The DSH web server's authentication gate covers the application document, not
 * plugin routes: `GET /` answers 401 without the launch token, while
 * `GET /api/openviking-enhance/config` answers 200 to a bare `curl`. That is fine
 * while the UI is only reachable on loopback — anything on the machine can read
 * `~/.openviking` directly anyway — but the whole point of these routes is that
 * they return memory metadata, and `/diff` returns memory *bodies*. The moment
 * this UI is bound to a non-loopback interface or reached through a tunnel or
 * reverse proxy, they become an unauthenticated read API over a personal memory
 * store.
 *
 * So every route requires the request to look like what it actually is: a
 * same-origin document on the loopback interface. There is no token to leak and
 * nothing to configure.
 *
 * ## What each check buys
 *
 * | Check | Blocks |
 * | --- | --- |
 * | socket remote address is loopback | any off-machine connection, including through a proxy on another host |
 * | `Host` header names loopback | a proxy or tunnel that reaches us over loopback but fronts a public name |
 * | `sec-fetch-site` is not `cross-site` | a page on another site issuing a cross-site request to a loopback port (DNS-rebinding class) |
 * | `Origin`, when present, equals `Host` | a same-site-but-different-port caller, and any cross-origin browser fetch |
 *
 * `X-Forwarded-For` is deliberately never consulted: this service is not behind a
 * trusted proxy, so a client-settable header must not be able to assert its own
 * trustworthiness. A reverse proxy that needs to reach these routes has to be
 * allowlisted explicitly, which is a deliberate code change rather than a config
 * toggle.
 *
 * Deliberately *not* enforced: the browser-presence marker some plugins add (a
 * custom header). It would block `curl` too, and a forged `Origin` slips past that
 * kind of tripwire regardless — while the socket/Host/origin checks above carry
 * the authority. Keeping plain `curl` working on loopback is worth more here: the
 * documented smoke harness depends on it.
 */
import type { IncomingMessage } from 'node:http'

/** IPv4 127/8 predicate (four decimal octets, first is 127). */
export function isIPv4Loopback(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, `::1`, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names the loopback authority (`localhost`, `[::1]`, 127/8). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Parse a `Host` header into a URL, accepting only a plausible authority. */
function hostUrl(host: string | undefined): URL | null {
  if (typeof host !== 'string' || host.length === 0) return null
  try {
    return new URL(`http://${host}`)
  } catch {
    return null
  }
}

/**
 * The fence itself: a loopback socket on a loopback authority, without a
 * cross-site fetch marker, and with `Origin` — when the browser sends one —
 * naming that same authority.
 */
export function isTrustedLocalRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false

  const authority = hostUrl(request.headers.host)
  if (authority === null) return false
  if (!isLoopbackHostname(authority.hostname)) return false

  if (request.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    // A sandboxed iframe sends the literal `null`; it is not this document's
    // origin, so it fails here rather than falling through to trust.
    return parsed.host === authority.host
  } catch {
    return false
  }
}

/**
 * The one narrow widening of the fence: read-only JSON POST routes.
 *
 * v0.4's search, rule tester and (later) other query routes are POSTs because
 * their input is a body, not a URL — and v0.3's fence rejects every non-GET
 * method. The widening is deliberately per-property rather than a method
 * allowlist:
 *
 *  - **still same-origin loopback**: `isTrustedLocalRequest` is unchanged, so a
 *    cross-site page, a public `Host`, or an off-machine socket is refused
 *    exactly as before;
 *  - **JSON content type only**: a POST is still a CSRF-shaped request when it
 *    comes from a form and carries `text/plain` or `application/x-www-form-
 *    urlencoded`. Requiring `application/json` means the browser must have sent
 *    a preflighted CORS request for a cross-origin caller, which a loopback
 *    listener never authorises.
 *  - **small body cap**: 64 KiB. A read-only route has no business accepting a
 *    large upload, and the cap is enforced against the actual streamed bytes,
 *    not only against a spoofable `Content-Length`.
 *
 * Nothing here decides *which* routes may be POST: that is the route table's
 * job (`index.ts`), and every POST route must be one of the documented
 * read-only ones. A write route cannot reuse these helpers without deliberately
 * adding one — which is precisely the code change a review would see.
 */
export const READ_ONLY_JSON_BODY_MAX = 64 * 1024

/** Whether a `Content-Type` header names JSON (parameters allowed). */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return false
  const [mediaType] = raw.split(';')
  return (mediaType ?? '').trim().toLowerCase() === 'application/json'
}

export type JsonBodyError = 'content-type' | 'too-large' | 'invalid-json'

/** The outcome of reading one read-only POST body. */
export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: JsonBodyError }

/** Whether a parsed JSON value is an object (not an array or a scalar). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and parse one bounded JSON request body.
 *
 * Resolves rather than throwing, including on a stream error: the route turns
 * the result into a JSON error, and a broken client connection must not produce
 * an unhandled rejection. The cap is checked twice — once against the
 * `Content-Length` a well-behaved client declares (cheap early refusal) and
 * once against the bytes actually received (the authoritative check).
 */
export async function readReadOnlyJsonBody(
  request: AsyncIterable<Uint8Array | string> & {
    headers?: Record<string, string | string[] | undefined>
    resume?: () => void
  },
  cap = READ_ONLY_JSON_BODY_MAX,
): Promise<JsonBodyResult> {
  if (!isJsonContentType(request.headers?.['content-type'])) {
    // Drain the refused body, exactly like the too-large branch below: a route
    // that answers 415 without reading can look like a connection reset to a
    // client still sending a large non-JSON payload.
    request.resume?.()
    return { ok: false, error: 'content-type' }
  }
  const declared = request.headers?.['content-length']
  const declaredLength = typeof declared === 'string' ? Number(declared) : NaN
  if (Number.isFinite(declaredLength) && declaredLength > cap) return { ok: false, error: 'too-large' }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of request) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      total += bytes.byteLength
      if (total > cap) {
        // Drain what is left so the response can be written, rather than
        // resetting the socket mid-request.
        request.resume?.()
        return { ok: false, error: 'too-large' }
      }
      chunks.push(bytes)
    }
  } catch {
    return { ok: false, error: 'invalid-json' }
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return { ok: false, error: 'invalid-json' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: 'invalid-json' }
  }
}
