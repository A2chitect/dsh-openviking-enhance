/**
 * OpenViking connection resolution for the host half.
 *
 * The plugin never invents credentials: it reads the same files the OpenViking
 * CLI and `@openviking/dsh-memory-plugin` read, in the same precedence order,
 * so the panel always shows the memory space the sessions actually write to.
 *
 *   1. explicit plugin config (the loader row in cordis.patch.yml)
 *   2. process environment (`OPENVIKING_*`)
 *   3. `~/.openviking/ovcli.conf`      → `url`, `api_key`
 *      `~/.openviking/ovcli.conf.local` → `account`, `user`
 *   4. built-in defaults (loopback server, `default`/`default`)
 *
 * Never log `apiKey`. `describeConnection()` exists for diagnostics and
 * deliberately omits it.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OvConnection {
  /** Base URL without a trailing slash. */
  endpoint: string
  apiKey: string
  account: string
  user: string
}

export interface ConnectionOverrides {
  endpoint?: string | undefined
  apiKey?: string | undefined
  account?: string | undefined
  user?: string | undefined
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1933'
const DEFAULT_ACCOUNT = 'default'
const DEFAULT_USER = 'default'

function ovHome(): string {
  return process.env.OPENVIKING_HOME?.trim() || join(homedir(), '.openviking')
}

/** Read a JSON config file, returning {} for anything unreadable or malformed. */
function readJsonFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (value && value.length > 0) return value
  }
  return ''
}

/** Normalize to `scheme://host:port` with no trailing slash. */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_ENDPOINT
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Resolve the connection. `readJsonFile` failures are silent by design: a
 * missing config file is the normal case for a fresh machine, and the plugin
 * must never take the host down over it.
 */
export function resolveConnection(
  overrides: ConnectionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): OvConnection {
  const cli = readJsonFile(join(ovHome(), 'ovcli.conf'))
  const cliLocal = readJsonFile(join(ovHome(), 'ovcli.conf.local'))

  const endpoint = normalizeEndpoint(
    firstNonEmpty(
      overrides.endpoint,
      str(env.OPENVIKING_URL),
      str(env.OPENVIKING_BASE_URL),
      str(cli.url),
      DEFAULT_ENDPOINT,
    ),
  )
  const apiKey = firstNonEmpty(
    overrides.apiKey,
    str(env.OPENVIKING_BEARER_TOKEN),
    str(env.OPENVIKING_API_KEY),
    str(cli.api_key),
  )
  const account = firstNonEmpty(
    overrides.account,
    str(env.OPENVIKING_ACCOUNT),
    str(cliLocal.account),
    str(cli.account),
    DEFAULT_ACCOUNT,
  )
  const user = firstNonEmpty(
    overrides.user,
    str(env.OPENVIKING_USER),
    str(cliLocal.user),
    str(cli.user),
    DEFAULT_USER,
  )

  return { endpoint, apiKey, account, user }
}

/** Diagnostic view: everything except the key. */
export function describeConnection(connection: OvConnection): Record<string, string> {
  return {
    endpoint: connection.endpoint,
    account: connection.account,
    user: connection.user,
    auth: connection.apiKey ? 'bearer' : 'none',
  }
}
