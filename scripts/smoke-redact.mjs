/**
 * Privacy redaction for the local smoke harness.
 *
 * `pnpm test` runs `scripts/smoke-host.mjs` on a maintainer's machine, where
 * OpenViking holds real memory: session ids, `viking://` leaves, query text,
 * identity and archive names. The audit rule for this project is that terminal
 * and CI output never carries private data, so the live-data path is **redacted
 * by default**; `SMOKE_VERBOSE=1` is the explicit escape hatch that prints the
 * old, detailed output for local debugging.
 *
 * What is kept, because it is what the smoke is actually checking: counts,
 * durations, booleans, states and the *shape* of a URI (scope + kind). What is
 * hidden: leaf names, session ids, archive names, query text, plan text, account
 * /user/endpoint values, home paths, and bodies.
 *
 * The functions are pure (except the archive counter) and unit-tested in
 * `test/smoke-redact.test.mjs`, so a new print in the smoke can reuse the same
 * rules instead of inventing another exception.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Whether the caller explicitly asked for the detailed output. */
export function smokeVerbose(env = process.env) {
  return env.SMOKE_VERBOSE === '1'
}

/** `sess-<first 8 hex of sha256>`: stable within a run, useless outside it. */
export function redactSessionId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
  if (text.length === 0) return text
  return `sess-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

/** Keep an endpoint only when it is the local loopback server. */
export function redactEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return '<endpoint>'
  try {
    const url = new URL(endpoint)
    return LOOPBACK_HOSTS.has(url.hostname) ? endpoint.replace(/\/+$/, '') : '<endpoint>'
  } catch {
    return '<endpoint>'
  }
}

/** `viking://<scope>/<kind>/<redacted>`; the namespace and kind are structural. */
export function redactUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('viking://')) return uri
  const rest = uri.slice('viking://'.length)
  const segments = rest.split('/').filter((segment) => segment.length > 0)
  // The last segment is the leaf; the four before it can name scope/kind.
  const kind = segments.find((segment) =>
    [
      'memories',
      'resources',
      'skills',
      'sessions',
      'history',
      'rules',
      'experiences',
      'tasks',
      'entities',
      'events',
      'preferences',
      'knowledge',
      'facts',
      'summaries',
      'profile',
      'identity',
      'soul',
    ].includes(segment),
  )
  if (kind === undefined) return 'viking://<redacted>/<redacted>'
  const kindIndex = segments.indexOf(kind)
  // Every identity-bearing scope segment is symbolised, not just peers: the
  // namespace stays (`user`/`agent`, the kind stays structural) but the account
  // or user id after it does not.
  const scope = segments
    .slice(0, kindIndex)
    .map((segment, index, all) => {
      if (all[index - 1] === 'peers' || all[index - 1] === 'actors') return '<peer>'
      if (index === 1 && (all[0] === 'user' || all[0] === 'agent')) return '<user>'
      return segment
    })
    .join('/')
  const leaf = segments.length > kindIndex + 1 ? segments[segments.length - 1] : ''
  const suffix = leaf.length > 0 ? '/<redacted>' : ''
  return `viking://${scope.length > 0 ? `${scope}/` : ''}${kind}${suffix}`
}

/** A filesystem path under a known private home, symbolised; else hidden. */
export function redactPath(path) {
  const text = typeof path === 'string' ? path : ''
  if (text.length === 0) return text
  const dshHome = process.env.DSH_HOME?.trim()
  const ovHome = process.env.OPENVIKING_HOME?.trim()
  if (dshHome !== undefined && dshHome.length > 0 && text.startsWith(dshHome)) {
    return `$DSH_HOME${text.slice(dshHome.length)}`
  }
  if (ovHome !== undefined && ovHome.length > 0 && text.startsWith(ovHome)) {
    return `$OPENVIKING_HOME${text.slice(ovHome.length)}`
  }
  return '<path>'
}

/** Query text becomes a length fact; the content is what the turn was about. */
export function redactQuery(text) {
  const length = typeof text === 'string' ? text.length : 0
  return length === 0 ? '<no query>' : `<${length} chars>`
}

/**
 * The home/identity substitutes a free-text sweep applies, longest prefix first.
 *
 * The real home directories are substituted with the same symbolic forms the
 * structured redactor uses (`$DSH_HOME`, `$OPENVIKING_HOME`), so an error string
 * stays as useful as its structured twin after redaction.
 */
function textHomePrefixes(env) {
  const pairs = []
  const dsh = env.DSH_HOME?.trim()
  if (dsh !== undefined && dsh.length > 0) pairs.push([dsh, '$DSH_HOME'])
  pairs.push([join(homedir(), '.dsh'), '$DSH_HOME'])
  const ov = env.OPENVIKING_HOME?.trim()
  if (ov !== undefined && ov.length > 0) pairs.push([ov, '$OPENVIKING_HOME'])
  pairs.push([join(homedir(), '.openviking'), '$OPENVIKING_HOME'])
  return pairs.sort((left, right) => right[0].length - left[0].length)
}

/**
 * Redact one piece of free text (an error message, a warning, a log line).
 *
 * Structured payloads are redacted key-by-key; errors are the leak that gets
 * past that, because the interesting part can appear mid-sentence:
 *
 *   `fetch failed /Users/alice/.dsh/state/profiles.json`
 *
 * The sweep therefore looks *inside* the string: known home prefixes become the
 * same symbolic forms as above, inline `viking://` URIs lose their identity and
 * leaf, any remaining absolute user-home path becomes `<path>`, and session ids
 * are hashed. Order matters: the known prefixes are replaced before the generic
 * absolute-path sweep, so `$DSH_HOME/...` survives with useful structure.
 */
export function redactFreeText(text, env = process.env) {
  if (typeof text !== 'string') return String(text)
  let out = text
  // Inline URIs first, so their path segments are not mistaken for a file path.
  out = out.replace(/viking:\/\/[^\s"'<>),;]+/g, (match) => redactUri(match))
  for (const [prefix, label] of textHomePrefixes(env)) {
    out = out.split(prefix).join(label)
  }
  // A remaining absolute path under a user home (`/Users/<id>/…`, `/home/<id>/…`).
  out = out.replace(/\/(?:Users|home|root)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g, '<path>')
  // Windows drive paths (`C:\\Users\\…`).
  out = out.replace(/[A-Za-z]:\\[^\s"'<>]+/g, '<path>')
  // Session handles are hex-shaped (`dsh-7060531e`); the package name
  // `dsh-openviking-enhance` is not one and must survive as a path segment.
  out = out.replace(/\bdsh-[0-9a-f]{8,}\b/g, (match) => redactSessionId(match))
  return out
}

/** One line of human text, truncated, for errors that might quote a body. */
export function redactText(text, limit = 80) {
  if (typeof text !== 'string') return String(text)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/**
 * Build a redactor that remembers archive names so they get stable counters.
 *
 * `summarise()` is the sweep used for whole JSON payloads: it walks the value and
 * applies the keyed rules above, so a new field named `uri`/`sessionId`/`plan`
 * cannot leak just because nobody updated the printer.
 */
export function createRedactor(env = process.env) {
  const verbose = smokeVerbose(env)
  const archiveNames = new Map()
  let archiveCount = 0

  const archiveName = (value) => {
    if (verbose) return value
    const key = String(value ?? '')
    if (key.length === 0) return key
    const known = archiveNames.get(key)
    if (known !== undefined) return known
    archiveCount += 1
    const name = `archive_${archiveCount}`
    archiveNames.set(key, name)
    return name
  }

  const redactValue = (value, key = '') => {
    if (verbose) return value
    if (value === null || value === undefined) return value
    if (typeof value === 'string') {
      const lowered = key.toLowerCase()
      if (lowered === 'sessionid' || lowered === 'ovsessionid' || lowered === 'dshsessionid') {
        return redactSessionId(value)
      }
      if (lowered === 'archiveid') return archiveName(value)
      if (lowered.endsWith('uri') || lowered === 'target' || lowered.endsWith('archive')) {
        return value.startsWith('viking://') ? redactUri(value) : archiveName(value)
      }
      if (lowered === 'endpoint') return redactEndpoint(value)
      if (lowered === 'account' || lowered === 'user' || lowered === 'apikey') {
        return value.length > 0 ? '<configured>' : '<default>'
      }
      if (
        lowered === 'plan' ||
        lowered === 'rendered' ||
        lowered === 'body' ||
        lowered === 'content' ||
        lowered === 'text' ||
        lowered === 'before' ||
        lowered === 'after' ||
        lowered === 'abstract' ||
        lowered === 'detail' ||
        lowered === 'summary' ||
        lowered === 'title'
      ) {
        return redactQuery(value)
      }
      if (lowered === 'query') return redactQuery(value)
      if (lowered === 'path' || lowered === 'storepath' || lowered === 'directory') return redactPath(value)
      if (lowered === 'error' || lowered === 'message' || lowered === 'reason' || lowered === 'warning') {
        return redactFreeText(value, env)
      }
      if (value.startsWith('viking://')) return redactUri(value)
      if (/^dsh-[0-9A-Za-z._-]{6,}$/.test(value)) return redactSessionId(value)
      return value
    }
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key))
    if (typeof value === 'object') {
      const out = {}
      for (const [childKey, childValue] of Object.entries(value)) {
        out[childKey] = redactValue(childValue, childKey)
      }
      return out
    }
    return value
  }

  return {
    verbose,
    uri: (uri) => (verbose ? uri : redactUri(uri)),
    sessionId: (id) => (verbose ? id : redactSessionId(id)),
    archiveName,
    query: (text) => (verbose ? text : redactQuery(text)),
    endpoint: (endpoint) => (verbose ? endpoint : redactEndpoint(endpoint)),
    path: (path) => (verbose ? path : redactPath(path)),
    text: (text, limit) => (verbose ? text : redactText(redactFreeText(text, env), limit)),
    value: redactValue,
    summarise: (payload) => {
      // Verbose mode reproduces the harness's historical line exactly, so an
      // operator debugging locally sees no formatting surprise either.
      if (verbose) {
        if (!payload || typeof payload !== 'object') return String(payload)
        if (payload.ok === false) return `NOT OK: ${payload.error}`
        const { ok: _ok, ...rest } = payload
        const raw = JSON.stringify(rest)
        return raw.length > 420 ? `${raw.slice(0, 420)}…` : raw
      }
      const cleaned = redactValue(payload)
      const text = JSON.stringify(cleaned)
      return text === undefined ? String(cleaned) : text.length > 420 ? `${text.slice(0, 420)}…` : text
    },
  }
}
