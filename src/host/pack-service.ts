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
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
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

  constructor(options: PackDownloadBrokerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'))
    this.directory = join(options.dir ?? pluginStateDir(), 'downloads')
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
    | { ok: true; downloadId: string; fileName: string; bytes: number; expiresAt: number; requestId: string | null }
    | { ok: false; code: string; message: string; requestId: string | null }
  > {
    this.sweep()
    // Active-capacity guard: the oldest download is dropped (and its file
    // deleted) before a new export starts, so a burst cannot fill the disk.
    while (this.downloads.size >= PACK_DOWNLOAD_MAX_ACTIVE) {
      const oldest = this.downloads.values().next()
      if (oldest.done === true) break
      this.remove(oldest.value.token)
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
    const filePath = join(this.directory, `pack-${token.slice(0, 16)}.ovpack`)
    const fileName = sanitizePackFileName(
      fileNameFromDisposition(response.response.headers.get('content-disposition')),
      uri,
    )
    let bytes = 0
    const handle = openSync(filePath, 'w', STATE_FILE_MODE)
    try {
      // The zip signature check happens on the first chunk, before any trust.
      let first = true
      for await (const chunk of response.response.body as unknown as AsyncIterable<Uint8Array>) {
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
        if (bytes > PACK_MAX_BYTES) {
          closeSync(handle)
          deleteFile(filePath)
          return {
            ok: false,
            code: 'pack-too-large',
            message: `The export exceeded the ${Math.trunc(PACK_MAX_BYTES / (1024 * 1024))} MiB host cap; use the OpenViking CLI for larger packs.`,
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
    return { ok: true, downloadId: token, fileName, bytes, expiresAt, requestId: response.requestId ?? null }
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

/** Read the first bytes of a file; exported for the smoke/unit checks. */
export function readSignature(path: string, bytes = 2): Uint8Array | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = new Uint8Array(bytes)
      readSync(fd, buffer, 0, bytes, 0)
      return buffer
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** The file size on disk, or null; exported for diagnostics. */
export function fileBytes(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
