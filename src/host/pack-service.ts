/**
 * v0.8 "Operate": OVPack **export only** (backup/import/restore are deferred).
 *
 * Why export is a host temp file plus a one-time GET download instead of a
 * binary through the mutation transport (design §5.1/§14.7):
 *
 *  - the server answers `POST /pack/export` with a streaming zip `FileResponse`,
 *    not JSON; the v0.5 mutation wrapper is JSON-only (64 KiB body cap), and
 *    binary framing through the DSH API channel is unproven;
 *  - a host-side temp file bounds memory (64 MiB, aborted beyond), keeps the
 *    bytes off the JSON channel, and can be served with a one-time capability
 *    token so the browser never needs a persistent URL.
 *
 * Privacy rules (binding): the temp directory is 0700, each file 0600 under the
 * plugin state dir, the token is 32 random bytes and single-use, the audit
 * records metadata only (URI, bytes, request id — never content or token), and
 * files are deleted after the one download, on expiry, or on plugin unload.
 * This is user data by definition; the UI says so.
 */
import { closeSync, chmodSync, existsSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  PACK_BODY_INACTIVITY_TIMEOUT_MS,
  PACK_DOWNLOAD_MAX_ACTIVE,
  PACK_DOWNLOAD_TTL_MS,
  PACK_MAX_BYTES,
  OPS_EXPORT_TIMEOUT_MS,
} from '../shared/limits.ts'
import { AUDIT_MAX_LIMIT } from '../shared/protocol.ts'
import type { IdentityScope, PackExportRow, PackHistoryPayload, PluginNotice } from '../shared/protocol.ts'
import type { AuditLog } from './audit.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import { ensureStateDir, pluginStateDir, STATE_DIR_MODE, STATE_FILE_MODE } from './plugin-state.ts'

/** The filename fallback when neither the server header nor the URI names one. */
const DEFAULT_FILE_NAME = 'export.ovpack'

/** Sanitize one server-supplied filename into a safe attachment name. */
export function sanitizePackFileName(raw: string | null, uri: string): string {
  const candidate = (raw ?? '').trim().replace(/^["']+|["']+$/g, '').replace(/^.*[\\/]/, '')
  const fromUri = uri.replace(/\/+$/, '').split('/').pop() ?? ''
  const base = (candidate.length > 0 ? candidate : fromUri.length > 0 ? fromUri : DEFAULT_FILE_NAME)
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  const safe = base.length === 0 ? DEFAULT_FILE_NAME : base.slice(0, 120)
  return safe.toLowerCase().endsWith('.ovpack') ? safe : `${safe}.ovpack`
}

/** Parse `content-disposition`; the server sends `filename="x.ovpack"`. */
export function fileNameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8 !== null) {
    try {
      return decodeURIComponent(utf8[1] as string)
    } catch {
      return null
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain === null ? null : (plain[1] as string)
}

/** One active download capability. */
interface DownloadRecord {
  token: string
  filePath: string
  fileName: string
  bytes: number
  expiresAt: number
  identityFingerprint: string
  uri: string
}

export interface PackDownloadBrokerOptions {
  api: OpenVikingApi
  audit: AuditLog
  identity: () => IdentityScope
  /** Override the state dir (tests); the downloads dir is created under it. */
  dir?: string
  /** Host cap for one pack body (default PACK_MAX_BYTES; tests shrink it). */
  maxBytes?: number
  /** Max silence between body chunks before the export is aborted. */
  inactivityMs?: number
  /** Overall body deadline; also aborts a slow-but-alive stream. */
  totalMs?: number
  now?: () => number
  randomToken?: () => string
}

/** The one-time-token download broker; the GET route calls `consume`. */
export class PackDownloadBroker {
  private readonly options: PackDownloadBrokerOptions
  private readonly downloads = new Map<string, DownloadRecord>()
  private readonly directory: string
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly maxBytes: number
  private readonly inactivityMs: number
  private readonly totalMs: number

  constructor(options: PackDownloadBrokerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'))
    this.directory = join(options.dir ?? pluginStateDir(), 'downloads')
    this.maxBytes = options.maxBytes ?? PACK_MAX_BYTES
    this.inactivityMs = options.inactivityMs ?? PACK_BODY_INACTIVITY_TIMEOUT_MS
    this.totalMs = options.totalMs ?? OPS_EXPORT_TIMEOUT_MS
    // A restart invalidates every in-memory capability token, so any `pack-*.ovpack`
    // file left in the private downloads dir is an orphan: sweep it at startup
    // rather than leave user data on disk until the next export.
    this.sweepOrphans()
  }

  /** The private directory holding exported packs (0700, created on demand). */
  get dir(): string {
    return this.directory
  }

  /**
   * Stream one export into a private temp file, returning a one-time token.
   *
   * The whole response is counted: more than `PACK_MAX_BYTES` deletes the
   * partial file and refuses with `pack-too-large` (the copy says "use the
   * OpenViking CLI for larger packs"). The first two bytes must be the zip
   * signature (`PK`); a server error body is never written as a pack.
   */
  async export(
    uri: string,
    includeVectors: boolean,
  ): Promise<
    | { ok: true; downloadId: string; fileName: string; bytes: number; expiresAt: number; requestId: string | null; evicted: boolean }
    | { ok: false; code: string; message: string; requestId: string | null }
  > {
    this.sweep()
    // Active-capacity guard: the oldest download is dropped (and its file
    // deleted) before a new export starts, so a burst cannot fill the disk. The
    // eviction is surfaced as a warning and audited (never silent).
    let evicted = false
    while (this.downloads.size >= PACK_DOWNLOAD_MAX_ACTIVE) {
      const oldest = this.downloads.values().next()
      if (oldest.done === true) break
      const dropped = this.downloads.get(oldest.value.token)
      this.remove(oldest.value.token)
      evicted = true
      if (dropped !== undefined) {
        try {
          this.options.audit.append({
            kind: 'download',
            action: 'pack-download',
            target: dropped.uri,
            identity: auditIdentity(this.options.identity()),
            fingerprint: dropped.identityFingerprint,
            confirmation: null,
            preCommit: null,
            postCommit: null,
            requestId: null,
            result: 'failed',
            error: 'evicted-by-active-cap',
            undo: null,
            bytes: dropped.bytes,
          })
        } catch {
          // Best effort; the eviction itself already happened.
        }
      }
    }
    const response = await this.options.api.streamPackExport(uri, includeVectors, {
      timeoutMs: OPS_EXPORT_TIMEOUT_MS,
    })
    if (!response.ok || response.response === null || response.response.body === null) {
      return {
        ok: false,
        code: response.status === 404 ? 'pack-export-unavailable' : response.status === 403 || response.status === 401 ? 'forbidden' : 'pack-failed',
        message: response.error ?? 'The pack export failed.',
        requestId: response.requestId ?? null,
      }
    }
    ensureStateDir(this.directory)
    try {
      chmodSync(this.directory, STATE_DIR_MODE)
    } catch {
      // Best effort: the mode passed at mkdir already asked for 0700.
    }
    const token = this.randomToken()
    // N5: the pid makes the filename owner-scoped across plugin instances that
    // share one DSH_HOME (desktop + another profile/service). The startup sweep
    // can then leave another LIVE instance's files alone.
    const filePath = join(this.directory, `pack-${process.pid}-${token.slice(0, 16)}.ovpack`)
    const fileName = sanitizePackFileName(
      fileNameFromDisposition(response.response.headers.get('content-disposition')),
      uri,
    )
    let bytes = 0
    const handle = openSync(filePath, 'w', STATE_FILE_MODE)
    const reader = response.response.body.getReader()
    const startedAt = this.now()
    try {
      // The zip signature check happens on the first chunk, before any trust.
      let first = true
      for (;;) {
        if (this.now() - startedAt > this.totalMs) {
          await cancelReader(reader)
          closeSync(handle)
          deleteFile(filePath)
          return {
            ok: false,
            code: 'pack-failed',
            message: `The pack export exceeded the ${Math.round(this.totalMs / 1000)}s host deadline; nothing was kept.`,
            requestId: response.requestId ?? null,
          }
        }
        const next = await readWithInactivity(reader, this.inactivityMs)
        if (next === 'timeout') {
          closeSync(handle)
          deleteFile(filePath)
          return {
            ok: false,
            code: 'pack-failed',
            message: `The pack export body stalled for more than ${Math.round(this.inactivityMs / 1000)}s; the export was aborted.`,
            requestId: response.requestId ?? null,
          }
        }
        if (next.done) break
        const chunk = next.value
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)
        if (first) {
          first = false
          if (view.byteLength < 2 || view[0] !== 0x50 || view[1] !== 0x4b) {
            closeSync(handle)
            deleteFile(filePath)
            return { ok: false, code: 'pack-failed', message: 'The server did not return a zip .ovpack stream.', requestId: response.requestId ?? null }
          }
        }
        bytes += view.byteLength
        if (bytes > this.maxBytes) {
          await cancelReader(reader)
          closeSync(handle)
          deleteFile(filePath)
          return {
            ok: false,
            code: 'pack-too-large',
            message: `The export exceeded the ${Math.trunc(this.maxBytes / (1024 * 1024))} MiB host cap; use the OpenViking CLI for larger packs.`,
            requestId: response.requestId ?? null,
          }
        }
        writeSync(handle, view)
      }
      if (first) {
        closeSync(handle)
        deleteFile(filePath)
        return { ok: false, code: 'pack-failed', message: 'The export stream was empty.', requestId: response.requestId ?? null }
      }
    } catch (error) {
      await cancelReader(reader)
      deleteFile(filePath)
      return {
        ok: false,
        code: 'pack-failed',
        message: error instanceof Error ? error.message : String(error),
        requestId: response.requestId ?? null,
      }
    } finally {
      try {
        closeSync(handle)
      } catch {
        // Already closed on the refusal paths above.
      }
      try {
        chmodSync(filePath, STATE_FILE_MODE)
      } catch {
        // File may have been deleted; best effort.
      }
    }
    const expiresAt = this.now() + PACK_DOWNLOAD_TTL_MS
    const record: DownloadRecord = {
      token,
      filePath,
      fileName,
      bytes,
      expiresAt,
      identityFingerprint: this.options.identity().fingerprint,
      uri,
    }
    this.downloads.set(token, record)
    return { ok: true, downloadId: token, fileName, bytes, expiresAt, requestId: response.requestId ?? null, evicted }
  }

  /**
   * Consume one download token: the file is served once and deleted after the
   * response. Expired/unknown/replayed tokens are refused (capability semantics).
   */
  consume(token: string): { filePath: string; fileName: string; bytes: number } | null {
    this.sweep()
    const record = this.downloads.get(token)
    if (record === undefined) return null
    this.downloads.delete(token)
    // The token is a capability bound to the identity it was exported under: a
    // profile switch must make it useless even if the sweep/close path missed it.
    if (this.options.identity().fingerprint !== record.identityFingerprint) {
      deleteFile(record.filePath)
      return null
    }
    if (this.now() > record.expiresAt || !existsSync(record.filePath)) {
      deleteFile(record.filePath)
      return null
    }
    try {
      this.options.audit.append({
        kind: 'download',
        action: 'pack-download',
        target: record.uri,
        identity: auditIdentity(this.options.identity()),
        fingerprint: record.identityFingerprint,
        confirmation: 'overlay',
        preCommit: null,
        postCommit: null,
        requestId: null,
        result: 'ok',
        error: null,
        undo: null,
        bytes: record.bytes,
      })
    } catch {
      // The audit trail is best-effort; the download still proceeds.
    }
    return { filePath: record.filePath, fileName: record.fileName, bytes: record.bytes }
  }

  /** Delete one temp file and forget its token (download served or evicted). */
  remove(token: string): void {
    const record = this.downloads.get(token)
    if (record === undefined) return
    this.downloads.delete(token)
    deleteFile(record.filePath)
  }

  /** Drop expired tokens/files; called on every export/consume. */
  sweep(): void {
    const now = this.now()
    for (const [token, record] of this.downloads) {
      if (now > record.expiresAt || !existsSync(record.filePath)) {
        this.downloads.delete(token)
        deleteFile(record.filePath)
      }
    }
  }

  /** Plugin unload: delete every leftover temp file. */
  close(): void {
    for (const token of [...this.downloads.keys()]) this.remove(token)
  }

  /**
   * Startup sweep of `pack-*.ovpack` files.
   *
   * N5: `pluginStateDir()` lives under the shared `DSH_HOME/state`, so a second
   * plugin instance on the same home (another profile, or a desktop+web pair)
   * must NOT delete the other instance's live one-time download or its
   * mid-write temp file. New filenames carry the owning pid: files of a live
   * process are kept, files of a dead process are deleted. Legacy pid-less
   * filenames are only deleted once they are older than one download TTL, so a
   * freshly written file is never mistaken for an orphan.
   */
  sweepOrphans(): void {
    let entries: string[]
    try {
      entries = readdirSync(this.directory)
    } catch {
      return
    }
    const agedOut = this.now() - PACK_DOWNLOAD_TTL_MS
    for (const entry of entries) {
      const match = /^pack-(?:(\d+)-)?([0-9a-f]+)\.ovpack$/.exec(entry)
      if (match === null) continue
      const path = join(this.directory, entry)
      const ownerPid = match[1] === undefined ? null : Number(match[1])
      if (ownerPid !== null) {
        // Keep our own and any live owner's files; delete a dead owner's.
        if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue
        deleteFile(path)
        continue
      }
      // Legacy pid-less file: sweep only after it could no longer be served.
      try {
        if (statSync(path).mtimeMs > agedOut) continue
      } catch {
        continue
      }
      deleteFile(path)
    }
  }

  /** Test/diagnostics: how many one-time tokens are currently active. */
  get activeCount(): number {
    this.sweep()
    return this.downloads.size
  }
}

/** The Packs tab's "last exports" read: metadata from the local audit trail. */
export function packHistory(audit: AuditLog): PackHistoryPayload {
  const payload = audit.recent(AUDIT_MAX_LIMIT, { kind: 'pack' })
  const exports: PackExportRow[] = payload.entries.map((entry) => ({
    id: entry.id,
    ts: entry.ts,
    target: entry.target,
    result: entry.result,
    bytes: typeof entry.bytes === 'number' ? entry.bytes : null,
    error: entry.error,
  }))
  return {
    exports,
    downloadDir: null,
    maxBytes: PACK_MAX_BYTES,
    available: !payload.unavailable,
    warnings: payload.warnings as PluginNotice[],
    observedAt: payload.observedAt,
  }
}

function auditIdentity(scope: IdentityScope) {
  return {
    profileId: scope.profileId,
    endpoint: scope.endpoint,
    authMode: scope.authMode,
    account: scope.account,
    user: scope.user,
    peer: scope.peer,
    dshSessionId: null,
  }
}

function deleteFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // A file already gone (sweep race) is not an error.
  }
}

/** Cancel a body reader without letting a refusal propagate as an exception. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // A body that already errored/closed cannot be cancelled again.
  }
}

/**
 * Read one chunk, aborting when the stream stays silent for `inactivityMs`.
 *
 * S1: the request deadline only covers the response HEADERS; without this, a
 * server that sends headers and then stalls would hold the shared mutation gate
 * for undici's default body timeout. `'timeout'` is the refusal signal; the
 * caller deletes the partial file.
 */
function readWithInactivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inactivityMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The race settles with 'timeout'; cancel in the background so the socket
      // is released even if the server never answers.
      void cancelReader(reader)
      resolve('timeout')
    }, inactivityMs)
    reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        // N10: reject the outer promise directly; resolve(rejectedPromise) would
        // create an unhandled rejection when the timeout already settled.
        reject(error)
      },
    )
  })
}

/** Whether a pid is alive (ownership check for the cross-instance file sweep). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
