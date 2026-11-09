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
import type { ConnectionFieldOrigin, ConnectionSource } from '../shared/protocol.ts'

export interface OvConnection {
  /** Base URL without a trailing slash. */
  endpoint: string
  apiKey: string
  account: string
  user: string
}

/** The connection plus a secret-free record of where each field came from. */
export interface ConnectionResolution {
  connection: OvConnection
  origins: ConnectionFieldOrigin[]
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

/** The OpenViking home the CLI and the memory plugin use. */
export function openVikingHome(): string {
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
  return resolveConnectionWithOrigins(overrides, env).connection
}

/** One resolved field, plus the layer that supplied it. */
function pick(
  candidates: Array<{ value: string; source: ConnectionSource; detail: string | null }>,
  fallback: { value: string; source: ConnectionSource; detail: string | null },
): { value: string; source: ConnectionSource; detail: string | null } {
  for (const candidate of candidates) {
    if (candidate.value.length > 0) return candidate
  }
  return fallback
}

/**
 * Resolve the connection and record the provenance of every field.
 *
 * The Doctor needs to answer "why is it pointed there?"; the same precedence
 * walk therefore also reports which layer won each field. Values themselves are
 * never echoed for `apiKey` — only whether one is configured and from where.
 */
export function resolveConnectionWithOrigins(
  overrides: ConnectionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ConnectionResolution {
  const home = env.OPENVIKING_HOME?.trim() || openVikingHome()
  const cli = readJsonFile(join(home, 'ovcli.conf'))
  const cliLocal = readJsonFile(join(home, 'ovcli.conf.local'))

  const endpoint = pick(
    [
      { value: overrides.endpoint ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_URL), source: 'env', detail: 'OPENVIKING_URL' },
      { value: str(env.OPENVIKING_BASE_URL), source: 'env', detail: 'OPENVIKING_BASE_URL' },
      { value: str(cli.url), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_ENDPOINT, source: 'default', detail: null },
  )
  const apiKey = pick(
    [
      { value: overrides.apiKey ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_BEARER_TOKEN), source: 'env', detail: 'OPENVIKING_BEARER_TOKEN' },
      { value: str(env.OPENVIKING_API_KEY), source: 'env', detail: 'OPENVIKING_API_KEY' },
      { value: str(cli.api_key), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: '', source: 'none', detail: null },
  )
  const account = pick(
    [
      { value: overrides.account ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_ACCOUNT), source: 'env', detail: 'OPENVIKING_ACCOUNT' },
      { value: str(cliLocal.account), source: 'ovcli.local', detail: 'ovcli.conf.local' },
      { value: str(cli.account), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_ACCOUNT, source: 'default', detail: null },
  )
  const user = pick(
    [
      { value: overrides.user ?? '', source: 'override', detail: 'plugin config' },
      { value: str(env.OPENVIKING_USER), source: 'env', detail: 'OPENVIKING_USER' },
      { value: str(cliLocal.user), source: 'ovcli.local', detail: 'ovcli.conf.local' },
      { value: str(cli.user), source: 'ovcli', detail: 'ovcli.conf' },
    ],
    { value: DEFAULT_USER, source: 'default', detail: null },
  )

  return {
    connection: {
      endpoint: normalizeEndpoint(endpoint.value),
      apiKey: apiKey.value,
      account: account.value,
      user: user.value,
    },
    origins: [
      { field: 'endpoint', source: endpoint.source, detail: endpoint.detail, configured: endpoint.value.length > 0 },
      // The value of an API key never leaves this module; the origin record says
      // only where it came from.
      { field: 'apiKey', source: apiKey.source, detail: apiKey.detail, configured: apiKey.value.length > 0 },
      { field: 'account', source: account.source, detail: account.detail, configured: account.value.length > 0 },
      { field: 'user', source: user.source, detail: user.detail, configured: user.value.length > 0 },
    ],
  }
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
