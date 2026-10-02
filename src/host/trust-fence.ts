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
