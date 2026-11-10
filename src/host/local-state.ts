/**
 * Read-only access to state the official OpenViking plugin keeps on disk.
 *
 * Two kinds, both read and never written:
 *
 *  - the **pending queue** (`~/.openviking/pending`), where
 *    `@openviking/dsh-memory-plugin` serializes writes while the server is
 *    unreachable; its entries carry `{ type, sessionId, payload, createdAt,
 *    retries, dedupKey }` and the payload is deliberately never opened;
 *  - the plugin's small **capability memos** (`~/.openviking/state/*.json`),
 *    which record "this server has no context face" and "the server downgraded
 *    peer scope" for a few hours.
 *
 * This is cross-plugin local state, so every read is opt-in, permission errors
 * degrade to "unavailable", and nothing here is cached: a doctor run should see
 * the current directory even if another process just drained it.
 */
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigSourceHealth, ConfigSourceState, PendingQueueItem, PendingQueueSummary } from '../shared/protocol.ts'
import { openVikingHome } from './config.ts'

/** One parsed `*.json` / `*.processing` file in the pending queue. */
interface PendingEntry {
  type?: unknown
  sessionId?: unknown
  createdAt?: unknown
  retries?: unknown
  dedupKey?: unknown
}

export interface LocalStateOptions {
  /** Override the OpenViking home (tests). */
  home?: string
  /** Override the pending queue directory (tests). */
  pendingDir?: string
  env?: NodeJS.ProcessEnv
}

/** The queue the official plugin uses: its env override, else the default. */
export function pendingQueueDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENVIKING_PENDING_DIR?.trim()
  if (override) return override
  return join(env.OPENVIKING_HOME?.trim() || join(homedir(), '.openviking'), 'pending')
}

/** The plugin's memo directory (context-face.json, peer-scope.json). */
export function pluginStateDir(options: LocalStateOptions = {}): string {
  const env = options.env ?? process.env
  const override = env.OPENVIKING_STATE_DIR?.trim()
  if (override) return override
  return join(options.home?.trim() || openVikingHome(), 'state')
}

/**
 * The pending queue entries for one OpenViking session.
 *
 * The summary reports file names/ages but never the payload: a pending message
 * contains transcript text, which this panel has no reason to show.
 */
export async function readPendingQueue(
  sessionId: string,
  options: LocalStateOptions = {},
): Promise<PendingQueueSummary> {
  const env = options.env ?? process.env
  const directory = options.pendingDir ?? pendingQueueDir(env)
  const explicit = env.OPENVIKING_PENDING_DIR?.trim() ? directory : null
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing queue is the normal, empty case, not a failure to report.
    if (code === 'ENOENT') {
      return { available: true, directory: explicit, total: 0, items: [], error: null }
    }
    return {
      available: false,
      directory: explicit,
      total: 0,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const items: PendingQueueItem[] = []
  let total = 0
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.processing')) continue
    // Filenames are `<sha256>_<retries>.json`; the session id lives inside.
    let raw: string
    try {
      raw = await readFile(join(directory, name), 'utf8')
    } catch {
      continue
    }
    let entry: PendingEntry
    try {
      entry = JSON.parse(raw) as PendingEntry
    } catch {
      continue
    }
    if (entry.sessionId !== sessionId) continue
    total += 1
    if (items.length >= 20) continue
    items.push({
      type: typeof entry.type === 'string' ? entry.type : 'unknown',
      createdAt: toIso(entry.createdAt),
      retries: typeof entry.retries === 'number' && Number.isFinite(entry.retries) ? Math.max(0, Math.trunc(entry.retries)) : 0,
      processing: name.endsWith('.processing'),
    })
  }
  items.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
  return { available: true, directory: explicit, total, items, error: null }
}

/** One directory's read health, without reading its contents. */
function directoryHealth(path: string, source: ConfigSourceHealth['source'], label: string): ConfigSourceHealth {
  const describe = (state: ConfigSourceState, errorCode: string | null): ConfigSourceHealth => ({
    source,
    path: label,
    state,
    errorCode,
  })
  try {
    return describe(statSync(path).isDirectory() ? 'ok' : 'wrong-shape', null)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? null
    return describe(code === 'ENOENT' ? 'missing' : code === null ? 'unknown' : 'unreadable', code)
  }
}

/**
 * Read health of the two directories this plugin reads from the OpenViking home
 * (P1-4): the official plugin's pending queue and its capability memos.
 *
 * A missing directory is normal (nothing captured yet); the Doctor only warns on
 * unreadable/wrong-shape. Contents are never inspected here.
 */
export function localStateHealth(options: LocalStateOptions = {}): ConfigSourceHealth[] {
  const env = options.env ?? process.env
  const home = env.OPENVIKING_HOME?.trim() || join(homedir(), '.openviking')
  const homeLabel = env.OPENVIKING_HOME?.trim() ? '$OPENVIKING_HOME' : '~/.openviking'
  const pendingPath = options.pendingDir ?? join(options.home?.trim() || home, 'pending')
  const pendingLabel = options.pendingDir ?? (env.OPENVIKING_PENDING_DIR?.trim() ? '$OPENVIKING_PENDING_DIR' : `${homeLabel}/pending`)
  const statePath = pluginStateDir(options)
  const stateLabel = env.OPENVIKING_STATE_DIR?.trim() ? '$OPENVIKING_STATE_DIR' : `${homeLabel}/state`
  return [
    directoryHealth(pendingPath, 'pending-queue', pendingLabel),
    directoryHealth(statePath, 'plugin-state', stateLabel),
  ]
}

/** One memo file, or null when it does not exist / cannot be parsed. */
export async function readPluginMemo<T = Record<string, unknown>>(
  name: string,
  options: LocalStateOptions = {},
): Promise<T | null> {
  try {
    const raw = await readFile(join(pluginStateDir(options), name), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}

/** `context-face.json`: the plugin's own "this server has no context face" memo. */
export interface ContextFaceMemo {
  legacyUntil?: number
}

/** `peer-scope.json`: the server rejected `peer_scope` and the plugin widened it. */
export interface PeerScopeMemo {
  legacyUntil?: number
  scope?: string
  status?: number
  at?: number
}

/** Whether a memo's `legacyUntil` is still in the future. */
export function memoActive(memo: { legacyUntil?: unknown } | null, now = Date.now()): boolean {
  return typeof memo?.legacyUntil === 'number' && Number.isFinite(memo.legacyUntil) && memo.legacyUntil > now
}

/**
 * Installed `@openviking/dsh-memory-plugin` version, when the profile's
 * node_modules can be resolved from this bundle.
 *
 * The runtime object the plugin provides carries no version, so the package
 * manifest is the only honest source. A failure is normal in a minimal
 * composition and reports null rather than failing the Doctor.
 */
export function readMemoryPluginVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const path = require.resolve('@openviking/dsh-memory-plugin/package.json')
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version
    }
    return null
  } catch {
    return null
  }
}

/** A millisecond epoch or ISO string as ISO; anything else is null. */
function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}
