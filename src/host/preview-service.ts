/**
 * F5: one `viking://` entry, as the preview tab needs it.
 *
 * This is the read-only composition of four existing server routes:
 *
 *   GET /api/v1/fs/stat            size, mode, timestamps, dir-ness
 *   GET /api/v1/fs/attrs           context face: tags + memory metadata
 *   GET /api/v1/content/abstract   L0 — the short abstract
 *   GET /api/v1/content/overview   L1 — the overview
 *   GET /api/v1/content/read       L2 — the stored body
 *
 * The server returns the tiers as plain strings inside its `{status, result}`
 * envelope; everything the UI needs is assembled here so the panel makes one
 * request, not six.
 *
 * Degradation is per tier, never all-or-nothing: a directory has L0/L1 but no
 * L2 body, an older server may lack `fs/attrs`, and any single failure keeps the
 * other tiers readable. The whole call fails only when the entry itself is
 * unreadable — which is what a 404 on every route means.
 *
 * Never echoed: the API key, or any request header. The URI is user-supplied
 * and must be a `viking://` path: this service is not a generic fetch.
 */
import {
  PREVIEW_MAX_CHARS,
  type PluginNotice,
  type PreviewPayload,
  type PreviewStat,
  type PreviewTier,
  type PreviewTierId,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvFsAttrs, OvFsStat } from './openviking-api.ts'

export interface PreviewServiceOptions {
  api: OpenVikingApi
  /** Ready-to-embed Studio URL (`endpoint + studioPath`), resolved at activation. */
  studioUrl: () => string
  now?: () => number
}

/** Longest URI accepted; longer than any real path and still bounded. */
export const PREVIEW_URI_MAX = 4096

/** Whether a string names a `viking://` path. */
export function isVikingUri(uri: string): boolean {
  return /^viking:\/\/\S/.test(uri.trim())
}

/** The viewer's refusal codes, kept stable for the UI to translate. */
export type PreviewFailureCode = 'not-a-viking-path' | 'not-found' | 'unreadable'

/** A preview that cannot be assembled, with a code the route maps to JSON. */
export class PreviewFailure extends Error {
  readonly code: PreviewFailureCode

  constructor(code: PreviewFailureCode, message: string) {
    super(message)
    this.name = 'PreviewFailure'
    this.code = code
  }
}

/**
 * The server's placeholder bodies for a sidecar that has not been generated yet.
 *
 * L0/L1 are directory-level sidecars; a directory whose abstract never ran
 * answers 200 with the literal text `# <uri> [Directory abstract is not ready]`
 * (and the overview equivalent at L1). Rendering that string as the entry's
 * summary would be a lie, so the tier is marked instead.
 */
const NOT_READY_PLACEHOLDER = /\[Directory (?:abstract|overview) is not ready\]/

/** Whether a tier body is the server's "not generated yet" placeholder. */
export function isPlaceholderTier(text: string): boolean {
  return NOT_READY_PLACEHOLDER.test(text)
}

/** Every page of a tier, capped, and honest about the cap. */
function tierOf(id: PreviewTierId, text: string | null, error: string | null): PreviewTier {
  if (text === null) return { id, text: '', truncated: false, available: false, placeholder: false, error }
  return {
    id,
    text: text.slice(0, PREVIEW_MAX_CHARS),
    truncated: text.length > PREVIEW_MAX_CHARS,
    available: true,
    placeholder: isPlaceholderTier(text),
    error: null,
  }
}

/** One field from an optional attrs payload, without trusting its shape. */
function attrText(...candidates: Array<unknown>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return null
}

/** The last path segment, for a URI the server did not name. */
function tailOf(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** Flatten `fs/stat` + `fs/attrs` into the metadata the panel renders. */
export function normalizePreviewStat(
  uri: string,
  stat: OvFsStat | null,
  attrs: OvFsAttrs | null,
): PreviewStat | null {
  if (stat === null && attrs === null) return null
  const memory = attrs?.attrs?.memory
  const tags = Array.isArray(attrs?.attrs?.tags)
    ? attrs.attrs.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  return {
    uri: attrText(stat?.uri, attrs?.uri, uri) ?? uri,
    name: attrText(stat?.name) ?? tailOf(uri) ?? uri,
    size: typeof stat?.size === 'number' ? stat.size : null,
    mode: typeof stat?.mode === 'number' ? stat.mode : null,
    isDir: typeof stat?.isDir === 'boolean' ? stat.isDir : null,
    isLocked: typeof stat?.isLocked === 'boolean' ? stat.isLocked : null,
    modifiedAt: attrText(stat?.modTime),
    contextType: attrText(attrs?.context_type),
    memoryType: attrText(memory?.memory_type),
    category: attrText(memory?.category),
    tags,
  }
}

export class PreviewService {
  private readonly options: PreviewServiceOptions

  constructor(options: PreviewServiceOptions) {
    this.options = options
  }

  /**
   * Read one entry's metadata and L0/L1/L2.
   *
   * @throws {PreviewFailure} `not-a-viking-path` for anything that is not a
   * `viking://` URI, `not-found` when the server knows no such entry, and
   * `unreadable` for any other total failure (transport, auth).
   */
  async preview(rawUri: string): Promise<PreviewPayload> {
    const uri = (rawUri ?? '').trim()
    if (!isVikingUri(uri) || uri.length > PREVIEW_URI_MAX) {
      throw new PreviewFailure('not-a-viking-path', 'not-a-viking-path')
    }

    const { api } = this.options
    const [stat, attrs, abstract, overview, read] = await Promise.all([
      api.fsStat(uri),
      api.fsAttrs(uri),
      api.contentFace(uri, 'abstract'),
      api.contentFace(uri, 'overview'),
      api.readText(uri),
    ])

    const warnings: PluginNotice[] = []
    if (!attrs.ok) {
      warnings.push({
        code: 'attrsUnavailable',
        params: { error: attrs.error ?? `HTTP ${attrs.status}` },
      })
    }

    const tiers: PreviewTier[] = [
      tierOf('l0', abstract.ok ? abstract.result : null, abstract.ok ? null : (abstract.error ?? `HTTP ${abstract.status}`)),
      tierOf('l1', overview.ok ? overview.result : null, overview.ok ? null : (overview.error ?? `HTTP ${overview.status}`)),
      tierOf('l2', read.ok ? read.result : null, read.ok ? null : (read.error ?? `HTTP ${read.status}`)),
    ]

    const anyTier = tiers.some((tier) => tier.available)
    if (!stat.ok && !anyTier) {
      // A 404 on every route means the entry itself does not exist. Anything
      // else (transport error, auth) is the server being unreadable.
      if (stat.status === 404) throw new PreviewFailure('not-found', stat.error ?? 'not-found')
      throw new PreviewFailure('unreadable', stat.error ?? `HTTP ${stat.status}`)
    }

    return {
      uri,
      stat: normalizePreviewStat(uri, stat.ok ? stat.result : null, attrs.ok ? attrs.result : null),
      tiers,
      studioUrl: this.options.studioUrl(),
      observedAt: new Date(this.now()).toISOString(),
      warnings,
    }
  }

  /** Test seam: the current clock, in milliseconds. */
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
