/**
 * F6: the `/viking` read-only command.
 *
 * One command, five verbs:
 *
 *   /viking              → status (same as `/viking status`)
 *   /viking status       → endpoint, server, identity, memory plugin, DSH, session
 *   /viking doctor       → the Doctor report as text
 *   /viking recall <q>   → run this session's recall and list the hits
 *   /viking open <uri>   → stat + L0/L1 for one entry (full view lives in the tab)
 *   /viking help         → usage
 *
 * ## Why this is a separate module
 *
 * The command registry is an optional host service: a composition without
 * `@deepseek-ai/dsh-commands` must still mount every route and every tab. So the
 * registration is the guard's job (see `index.ts`), and the *verbs* live here,
 * against the same services the GUI routes use. That also makes the parsing and
 * the output unit-testable without a command registry, a host or a server.
 *
 * ## Output rules
 *
 * The host has no locale service, so these strings are English and deliberately
 * short (the result is rendered in a narrow transcript bubble). They carry no
 * API key, no request headers and no full memory body: `open` truncates the
 * tiers it prints, and `recall` prints the abstract's first line. The pull
 * towards more detail is satisfied by pointing at the preview tab, which makes
 * its own, deliberate requests.
 *
 * ## v0.4 is read-only
 *
 * There is deliberately no `commit`, `remember`, `forget`, `pause` or `resume`.
 * Those are v0.5 writes and need confirmation and an audit trail first.
 */
import { RECALL_DEFAULT_LIMIT } from '../shared/protocol.ts'
import type { CommitService } from './commit-service.ts'
import type { DoctorService } from './doctor-service.ts'
import type { OvConnection } from './config.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import type { PreviewService } from './preview-service.ts'
import type { RecallService } from './recall-service.ts'

/** One line-oriented command outcome, the registry's own result shape. */
export type VikingCommandResult = { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }

/** The invocation slice this command reads; the registry's full type is Host-only. */
export interface VikingCommandInvocation {
  /** The Agent whose UI received the command; its id IS the DSH session id. */
  readonly agent?: { readonly id?: unknown } | undefined
  readonly rawInput?: unknown
  readonly signal?: { readonly aborted?: boolean } | undefined
}

/** The registry definition this module contributes (structurally, no new dependency). */
export interface VikingCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input: { readonly hint: string }
  readonly handler: (invocation: VikingCommandInvocation) => VikingCommandResult | Promise<VikingCommandResult>
}

/** The verbs, plus the two not-a-verb outcomes. */
export type VikingSubcommand = 'status' | 'doctor' | 'recall' | 'open' | 'help' | 'unknown'

export interface ParsedVikingCommand {
  subcommand: VikingSubcommand
  /** Everything after the verb, verbatim (queries may contain spaces). */
  argument: string
}

/**
 * Parse one `/viking` raw input.
 *
 * `rawInput` is the exact text after the command name, separator whitespace
 * included. An empty input is `status`: the bare command is the status check.
 * Unknown verbs keep their argument out of the error so a typo cannot echo a
 * query into a log line twice.
 */
export function parseVikingCommand(rawInput: string): ParsedVikingCommand {
  const trimmed = (rawInput ?? '').trim()
  if (trimmed.length === 0) return { subcommand: 'status', argument: '' }
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim()
  switch (head) {
    case 'status':
    case 'state':
      return { subcommand: 'status', argument: rest }
    case 'doctor':
    case 'health':
      return { subcommand: 'doctor', argument: rest }
    case 'recall':
    case 'search':
      return { subcommand: 'recall', argument: rest }
    case 'open':
    case 'preview':
      return { subcommand: 'open', argument: rest }
    case 'help':
    case '?':
    case '--help':
    case '-h':
      return { subcommand: 'help', argument: rest }
    default:
      return { subcommand: 'unknown', argument: '' }
  }
}

/** The usage text, shared by `help` and the unknown-verb path. */
export const VIKING_USAGE = [
  '/viking status — connection, identity, memory plugin, commit state',
  '/viking doctor — the Doctor checks as text',
  '/viking recall <query> — run this session’s recall and list the hits',
  '/viking open <viking://…> — size, L0 and L1 for one entry',
  '/viking help — this list',
  'Read-only: write commands arrive in v0.5 (with confirmation and audit).',
].join('\n')

/** The inputs the command needs; the same services the routes use. */
export interface VikingCommandOptions {
  api: OpenVikingApi
  connection: OvConnection
  commit: CommitService
  recall: RecallService
  doctor: DoctorService
  preview: PreviewService
  /** `@openviking/dsh-memory-plugin` version, when it is installed locally. */
  memoryPluginVersion?: () => string | null
  /** The running DSH release, when the host publishes one. */
  dshVersion?: () => string | null
  now?: () => number
}

/** First line of a possibly multi-line server text, bounded. */
function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A bounded one-line text. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The marker for one Doctor check status. */
export function doctorMarker(status: string): string {
  switch (status) {
    case 'ok':
      return '✓'
    case 'warn':
      return '!'
    case 'error':
      return '✗'
    case 'skipped':
      return '–'
    default:
      return '·'
  }
}

/** Shape a `viking://` URI argument, without accepting anything else. */
function vikingUriArgument(argument: string): string | null {
  const uri = argument.trim()
  return /^viking:\/\/\S+$/.test(uri) ? uri : null
}

export class VikingCommand {
  private readonly options: VikingCommandOptions

  constructor(options: VikingCommandOptions) {
    this.options = options
  }

  /** Execute one command line. Never throws: every failure is an error text. */
  async run(rawInput: string, sessionId: string): Promise<VikingCommandResult> {
    const parsed = parseVikingCommand(rawInput)
    try {
      switch (parsed.subcommand) {
        case 'status':
          return { kind: 'success', text: await this.status(sessionId) }
        case 'doctor':
          return { kind: 'success', text: await this.doctor(sessionId) }
        case 'recall':
          return await this.recall(sessionId, parsed.argument)
        case 'open':
          return await this.open(parsed.argument)
        case 'help':
          return { kind: 'success', text: VIKING_USAGE }
        default:
          return { kind: 'error', text: `Unknown /viking command.\n${VIKING_USAGE}` }
      }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The one-screen status: where, as whom, what is mounted, what is pending. */
  private async status(sessionId: string): Promise<string> {
    const { connection, commit, api, memoryPluginVersion, dshVersion } = this.options
    const health = await api.health()
    const lines: string[] = []
    lines.push(
      `OpenViking ${health.version ?? '?'} · ${health.ok ? 'healthy' : 'unreachable'} · ${connection.endpoint}`,
    )
    lines.push(`Identity: ${connection.account}/${connection.user} · auth ${connection.apiKey ? 'bearer' : 'none'}`)
    const pluginVersion = memoryPluginVersion?.() ?? null
    lines.push(
      pluginVersion === null
        ? 'Memory plugin: not installed on this machine'
        : `Memory plugin: @openviking/dsh-memory-plugin ${pluginVersion}`,
    )
    const dsh = dshVersion?.() ?? null
    if (dsh !== null) lines.push(`DSH: ${dsh}`)
    const mounted = commit.pluginMounted()
    lines.push(mounted ? 'Memory plugin state: mounted' : 'Memory plugin state: not mounted in this profile')

    try {
      const status = await commit.status(sessionId)
      const threshold = status.threshold === null ? '?' : String(status.threshold)
      lines.push(
        `Session ${sessionId}: ${status.pendingTokens} pending tokens (threshold ${threshold}) · ` +
          `${status.commitCount} commits · phase ${status.phase}`,
      )
      lines.push(
        status.lastCommitAt === null
          ? 'Last commit: none recorded'
          : `Last commit: ${status.lastCommitAt} · newest archive ${status.latest?.state ?? 'none'}`,
      )
    } catch (error) {
      lines.push(`Session ${sessionId}: commit state unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    return lines.join('\n')
  }

  /** The Doctor report as short lines; hints are left to the panel. */
  private async doctor(sessionId: string): Promise<string> {
    const report = await this.options.doctor.report(sessionId, { probe: false })
    const lines: string[] = [
      `Doctor · ${report.connection.endpoint} · server ${report.health.version ?? '?'} · ` +
        `${report.health.healthy ? 'healthy' : 'unreachable'}`,
    ]
    for (const check of report.checks) {
      const value = check.value === null ? '' : `: ${clip(check.value, 120)}`
      lines.push(`  ${doctorMarker(check.status)} ${check.id}${value}`)
    }
    if (report.warnings.length > 0) {
      lines.push(`Warnings: ${report.warnings.length} (see the Memory health tab)`)
    }
    return lines.join('\n')
  }

  /** Run the session's recall and print the ranked hits, one line each. */
  private async recall(sessionId: string, argument: string): Promise<VikingCommandResult> {
    const query = argument.trim()
    if (query.length === 0) return { kind: 'error', text: 'Usage: /viking recall <query>' }
    const payload = await this.options.recall.recall(sessionId, query, RECALL_DEFAULT_LIMIT)
    const lines: string[] = [
      `Recall “${clip(query, 80)}” · ${payload.total} hits · ${payload.latencyMs} ms`,
    ]
    for (const bucket of payload.buckets) {
      lines.push(`${bucket.bucket} (${bucket.items.length})`)
      for (const item of bucket.items) {
        const abstract = firstLine(item.abstract, 90)
        lines.push(`  ${item.score.toFixed(2)} ${clip(item.memoryType || item.contextType, 16)} ${item.uri}`)
        if (abstract.length > 0) lines.push(`       ${abstract}`)
      }
    }
    if (payload.total === 0) lines.push('  no hits')
    return { kind: 'success', text: lines.join('\n') }
  }

  /** Stat and L0/L1 for one entry; the body is the preview tab's job. */
  private async open(argument: string): Promise<VikingCommandResult> {
    const uri = vikingUriArgument(argument)
    if (uri === null) {
      return { kind: 'error', text: 'Usage: /viking open <viking://…>' }
    }
    const preview = await this.options.preview.preview(uri)
    const stat = preview.stat
    const lines: string[] = [uri]
    if (stat !== null) {
      const kind = [stat.contextType, stat.memoryType].filter((part) => part !== null && part.length > 0).join('/')
      const size = stat.size === null ? '' : ` · ${stat.size} B`
      const modified = stat.modifiedAt === null ? '' : ` · ${stat.modifiedAt}`
      lines.push(`${kind.length > 0 ? kind : stat.isDir === true ? 'directory' : 'entry'}${size}${modified}`)
      if (stat.tags.length > 0) lines.push(`tags: ${stat.tags.join(', ')}`)
    } else {
      lines.push('metadata unavailable')
    }
    for (const tier of preview.tiers) {
      const label = tier.id.toUpperCase()
      if (!tier.available) {
        lines.push(`${label}: unavailable${tier.error === null ? '' : ` (${tier.error})`}`)
        continue
      }
      const text = tier.id === 'l2' ? firstLine(tier.text, 200) : clip(tier.text, 200)
      lines.push(`${label}: ${text.length > 0 ? text : '(empty)'}${tier.truncated ? ' …' : ''}`)
    }
    lines.push('Full view: open the OpenViking preview tab (right sidebar) and click the URI.')
    return { kind: 'success', text: lines.join('\n') }
  }
}

/** Wrap the runner as the registry definition; the guard owns registration. */
export function vikingCommandDefinition(runner: VikingCommand): VikingCommandDefinition {
  return {
    name: 'viking',
    description: 'Inspect OpenViking: status, doctor, recall and URI preview (read-only)',
    input: { hint: 'status | doctor | recall <query> | open <viking://…> | help' },
    handler: async (invocation) => {
      if (invocation.signal?.aborted === true) return { kind: 'error', text: 'Cancelled.' }
      const sessionId = typeof invocation.agent?.id === 'string' ? invocation.agent.id : ''
      if (sessionId.length === 0) {
        return { kind: 'error', text: 'Cannot determine the DSH session id for this command.' }
      }
      const rawInput = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
      return runner.run(rawInput, sessionId)
    },
  }
}
