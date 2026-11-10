/**
 * The plugin's own state directory under the DSH home.
 *
 * v0.5 is the first version that persists anything: the credential profile store
 * and the audit trail live in
 * `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/`. Both are private files —
 * `profiles.json` carries an API key, the audit log carries identity and URIs —
 * so the directory is created `0700` and every file `0600`, atomically (write a
 * temporary file, `chmod`, rename).
 *
 * Security rules that are easy to lose in a refactor, so they are stated here:
 *
 *  - the directory mode is enforced with `chmod` after creation, not only via
 *    `mkdir`'s mode (umask would widen it on some systems);
 *  - a write goes through a temporary file in the same directory and a rename,
 *    so a crash can never leave a half-written secrets file;
 *  - reads cap what they return (an audit file is attacker-influenced only in
 *    the sense that it can grow; it must never be read whole into a route
 *    response);
 *  - nothing here is imported by the client half.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** File mode for the private directory. */
export const STATE_DIR_MODE = 0o700
/** File mode for every file this plugin creates. */
export const STATE_FILE_MODE = 0o600

/** The DSH home, `$DSH_HOME` else `~/.dsh`. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.dsh')
}

/** This plugin's state directory; the caller may override it (tests, unusual homes). */
export function pluginStateDir(options: { dir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.dir !== undefined && options.dir.trim().length > 0) return options.dir
  return join(dshHome(options.env ?? process.env), 'state', 'dsh-openviking-enhance')
}

/** Create (and tighten) the private directory; throws only on a real filesystem error. */
export function ensureStateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE })
  try {
    chmodSync(directory, STATE_DIR_MODE)
  } catch {
    // A filesystem that refuses chmod (or a directory we do not own) still lets
    // the plugin run; the caller's best effort ends here.
  }
}

/** The current mode of a path, or null when it does not exist. */
export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

/** A safe JSON parse that returns null instead of throwing. */
export function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Read a UTF-8 file, or null when it is missing/unreadable. */
export function readFileOrNull(path: string, maxBytes = 4 * 1024 * 1024): string | null {
  try {
    const size = statSync(path).size
    if (size > maxBytes) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Write one private file atomically.
 *
 * The temporary name carries a random suffix so two writers cannot collide; the
 * rename is atomic on the same filesystem, so a reader sees the old or the new
 * file, never a mix. The result is reported rather than thrown: a settings save
 * must not take a route (or the host) down.
 */
export function writePrivateFile(path: string, data: string): { ok: boolean; error: string | null } {
  try {
    ensureStateDir(dirname(path))
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, data, { mode: STATE_FILE_MODE })
    try {
      chmodSync(temporary, STATE_FILE_MODE)
    } catch {
      // Best effort; the mode passed to writeFileSync already asked for 0600.
    }
    renameSync(temporary, path)
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Append one JSON line to a bounded, rotating file.
 *
 * Rotation happens before the append when the current file is already at the
 * cap, so a line is never split: `audit.jsonl` → `audit.1.jsonl` →
 * `audit.2.jsonl`, and a third old file is dropped. The audit trail is
 * best-effort by design (the write must not fail because the log is full), so
 * failures resolve to `{ok:false}` and the caller only logs them.
 */
export function appendJsonl(
  path: string,
  record: unknown,
  options: { maxBytes?: number; keep?: number } = {},
): { ok: boolean; error: string | null } {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const keep = Math.max(1, options.keep ?? 2)
  try {
    ensureStateDir(dirname(path))
    /** `audit.jsonl` → `audit.1.jsonl` (the name the design documents). */
    const rotatedName = (index: number): string =>
      path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.${index}.jsonl` : `${path}.${index}`
    if (existsSync(path)) {
      const size = statSync(path).size
      if (size >= maxBytes) {
        // Newest rotation first: `.1` moves to `.2` before the live file takes
        // `.1`'s place, so a rotation can never overwrite a readable file.
        for (let index = keep; index >= 1; index -= 1) {
          const older = rotatedName(index)
          const newer = index === 1 ? path : rotatedName(index - 1)
          try {
            if (existsSync(older)) unlinkSync(older)
            if (existsSync(newer)) renameSync(newer, older)
          } catch {
            // A rotation failure is not fatal to appending the new record.
          }
        }
      }
    }
    const line = `${JSON.stringify(record)}\n`
    const handle = openSync(path, 'a', STATE_FILE_MODE)
    try {
      fchmodSync(handle, STATE_FILE_MODE)
      writeSync(handle, line)
    } finally {
      closeSync(handle)
    }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The last `limit` parsed lines of a JSONL file, oldest→newest order preserved
 * within the returned window (newest last). Unreadable lines are skipped.
 */
export function readJsonlTail(path: string, limit: number, maxBytes = 2 * 1024 * 1024): unknown[] {
  try {
    const size = statSync(path).size
    const raw = readFileSync(path, 'utf8')
    // A file larger than the tail budget is read whole only up to a bounded
    // amount: the audit file rotates at 1 MiB, so this is a defensive cap.
    const text = size > maxBytes ? raw.slice(raw.length - maxBytes) : raw
    const lines = text.split('\n')
    // A slice from the middle of the file may start mid-line; a failed parse is
    // skipped by the parser below.
    const parsed: unknown[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const value = parseJson(trimmed)
      if (value !== null && typeof value === 'object') parsed.push(value)
    }
    return parsed.slice(Math.max(0, parsed.length - Math.max(1, limit)))
  } catch {
    return []
  }
}
