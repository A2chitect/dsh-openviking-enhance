/**
 * F6: the `/viking` command — read verbs as shipped in v0.4, write verbs as of
 * v0.5.
 *
 *   /viking              → status (same as `/viking status`)
 *   /viking status       → endpoint, server, identity, memory plugin, DSH, session
 *   /viking doctor       → the Doctor report as text
 *   /viking recall <q>   → run this session's recall and list the hits
 *   /viking open <uri>   → stat + L0/L1 for one entry (full view lives in the tab)
 *   /viking edit <uri>   → open the preview editor for one memory file
 *   /viking forget <uri> → prepare a delete; confirm in the card or `--confirm <token>`
 *   /viking tag <uri> <k=v…|--clear> → prepare a tag update
 *   /viking commit       → prepare a force commit for this session
 *   /viking undo <handle>→ apply a prepared undo handle
 *   /viking audit [n]    → the newest local audit records, one line each
 *   /viking help         → usage
 *
 * ## The command never writes by itself
 *
 * Every write verb *prepares* (the host takes the pre-write snapshot then) and
 * returns a confirmation envelope. The rich `conversation.chat.commandview` card
 * keyed `viking` parses the final line and renders Confirm/Cancel; a client
 * without the card gets the plain-text fallback the human line names
 * (`--confirm <token>`). The token is single-use, TTL-bound and appears in the
 * durable session log either way — never a memory body, never a secret.
 *
 * ## Output rules
 *
 * The host has no locale service, so these strings are English and deliberately
 * short (the result is rendered in a narrow transcript bubble). `open` truncates
 * the tiers it prints, `recall` prints the abstract's first line, and the write
 * envelopes carry no bodies (the edit verb only opens the editor, which loads the
 * body through its own request).
 */
import { RECALL_DEFAULT_LIMIT, type IdentityScope, type WriteAction, type WritePreparePayload } from '../shared/protocol.ts'
import { classifyCuratableUri } from '../shared/curation.ts'
import type { CommitService } from './commit-service.ts'
import type { DoctorService } from './doctor-service.ts'
import type { OvConnection } from './config.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import type { PreviewService } from './preview-service.ts'
import type { RecallService } from './recall-service.ts'
import type { AuditLog } from './audit.ts'
import { shortHash, type WriteService } from './write-service.ts'

/** One line-oriented command outcome, the registry's own result shape. */
export type VikingCommandResult = { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }

/** The invocation slice this command reads; the registry's full type is Host-only. */
export interface VikingCommandInvocation {
  /** The Agent whose UI received the command; its id IS the DSH session id. */
  readonly agent?: { readonly id?: unknown } | undefined
  readonly rawInput?: unknown
  /** The dispatching UI request's cancellation signal, threaded into every API call. */
  readonly signal?: AbortSignal | undefined
}

/** The registry definition this module contributes (structurally, no new dependency). */
export interface VikingCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input: { readonly hint: string }
  readonly handler: (invocation: VikingCommandInvocation) => VikingCommandResult | Promise<VikingCommandResult>
}

/** The verbs, plus the two not-a-verb outcomes. */
export type VikingSubcommand =
  | 'status'
  | 'doctor'
  | 'recall'
  | 'open'
  | 'edit'
  | 'forget'
  | 'tag'
  | 'commit'
  | 'undo'
  | 'audit'
  | 'help'
  | 'unknown'

/** The write verbs (registered behaviour is live-gated on `enableWrites`). */
export const VIKING_WRITE_VERBS: readonly VikingSubcommand[] = ['edit', 'forget', 'tag', 'commit', 'undo']

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
    case 'edit':
      return { subcommand: 'edit', argument: rest }
    case 'forget':
    case 'delete':
    case 'rm':
      return { subcommand: 'forget', argument: rest }
    case 'tag':
    case 'tags':
      return { subcommand: 'tag', argument: rest }
    case 'commit':
      return { subcommand: 'commit', argument: rest }
    case 'undo':
      return { subcommand: 'undo', argument: rest }
    case 'audit':
    case 'log':
      return { subcommand: 'audit', argument: rest }
    case 'help':
    case '?':
    case '--help':
    case '-h':
      return { subcommand: 'help', argument: rest }
    default:
      return { subcommand: 'unknown', argument: '' }
  }
}

/** The read-only usage lines. */
export const VIKING_USAGE = [
  '/viking status — connection, identity, memory plugin, commit state',
  '/viking doctor — the Doctor checks as text',
  '/viking recall <query> — run this session’s recall and list the hits',
  '/viking open <viking://…> — size, L0 and L1 for one entry',
  '/viking help — this list',
].join('\n')

/** The write verb usage lines; only listed when writes are enabled. */
export const VIKING_WRITE_USAGE = [
  '/viking edit <viking://…> — open the preview editor for one memory file',
  '/viking forget <viking://…> — prepare a delete (typed confirmation in the card)',
  '/viking tag <viking://…> <key=value|--clear> — prepare a tag update',
  '/viking commit — prepare a force commit for this session (not undoable)',
  '/viking undo <handle> — apply an undo handle from a recent result',
  '/viking audit [n] — the newest local audit records',
].join('\n')

/** The usage text for the current writes switch. */
export function vikingUsage(writesEnabled: boolean): string {
  return writesEnabled ? `${VIKING_USAGE}\n${VIKING_WRITE_USAGE}` : `${VIKING_USAGE}\nWrites are off: enable “Writes” in the plugin settings to curate memories.`
}

/** The inputs the command needs; the same services the routes use. */
export interface VikingCommandOptions {
  api: OpenVikingApi
  connection: OvConnection
  commit: CommitService
  recall: RecallService
  doctor: DoctorService
  preview: PreviewService
  /** The write protocol; present whenever the host half is running. */
  writes: WriteService
  /** The live `enableWrites` value. */
  writesEnabled: () => boolean
  /** The active identity, for the editor envelope's scope block. */
  identity: () => IdentityScope
  /** The local audit trail (`/viking audit`, and the undo confirmation record). */
  audit: AuditLog
  /** `@openviking/dsh-memory-plugin` version, when it is installed locally. */
  memoryPluginVersion?: () => string | null
  /** The running DSH release, when the host publishes one. */
  dshVersion?: () => string | null
  now?: () => number
}

/** Thrown when the dispatching request is cancelled; mapped to one short outcome. */
class CommandCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CommandCancelled'
  }
}

/** The one error result for a cancelled command, never a partial answer. */
const CANCELLED: VikingCommandResult = { kind: 'error', text: 'Cancelled.' }

/** Stop between awaits when the UI request that dispatched the command is gone. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CommandCancelled()
}

/**
 * Short English for the stable error codes the browser half also translates
 * (`error.notFound`, …). The host has no locale service, but a command result
 * is read by a person: it must not print a bare code like `not-found` when a
 * sentence is available. Server messages and unknown codes pass through as-is.
 */
const COMMAND_ERROR_TEXT: Record<string, string> = {
  'not-found': 'OpenViking has no such entry.',
  'not-a-viking-path': 'Only viking:// paths can be previewed.',
  'invalid-experience-uri': 'That is not an Experience file path.',
  'query-required': 'Type something to search for.',
  'task-context-required': 'Describe the task first.',
}

/** Render a stable error code (or a server message) as command text. */
export function commandErrorText(error: string): string {
  return COMMAND_ERROR_TEXT[error.trim()] ?? error
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

/** One outgoing confirmation envelope, as the `viking` command card parses it. */
export interface VikingConfirmEnvelope {
  ov: '1'
  kind: 'confirm'
  prepare: WritePreparePayload
  /** One short English instruction for clients that cannot render the card. */
  hint: string
}

/** The editor-opening envelope (`/viking edit` never writes). */
export interface VikingEditorEnvelope {
  ov: '1'
  kind: 'open-editor'
  uri: string
  scope: IdentityScope
}

/** `--confirm <token>` in a write verb's argument. */
export function confirmTokenArgument(argument: string): string | null {
  const match = /(?:^|\s)--confirm(?:\s+|=)?([0-9a-f]{16,128})(?:\s|$)/i.exec(argument)
  return match?.[1] ?? null
}

/** The action's plain-text confirmation command, for the human fallback line. */
function fallbackCommand(subcommand: VikingSubcommand): string {
  return subcommand === 'tag' ? '/viking tag <uri> <key=value…> --confirm' : `/viking ${subcommand} --confirm`
}

export class VikingCommand {
  private readonly options: VikingCommandOptions

  constructor(options: VikingCommandOptions) {
    this.options = options
  }

  /**
   * Execute one command line. Never throws: every failure is an error text.
   *
   * `signal` is the dispatching UI request's cancellation. It is checked between
   * every await and threaded into the recall/doctor/preview services (whose API
   * requests abort with it), so a cancelled `/viking recall` stops instead of
   * holding a 12–20 s retrieval open to completion.
   */
  async run(rawInput: string, sessionId: string, signal?: AbortSignal): Promise<VikingCommandResult> {
    const parsed = parseVikingCommand(rawInput)
    try {
      throwIfCancelled(signal)
      switch (parsed.subcommand) {
        case 'status':
          return { kind: 'success', text: await this.status(sessionId, signal) }
        case 'doctor':
          return { kind: 'success', text: await this.doctor(sessionId, signal) }
        case 'recall':
          return await this.recall(sessionId, parsed.argument, signal)
        case 'open':
          return await this.open(parsed.argument, signal)
        case 'edit':
          return await this.edit(parsed.argument)
        case 'forget':
          return await this.forget(sessionId, parsed.argument)
        case 'tag':
          return await this.tag(sessionId, parsed.argument)
        case 'commit':
          return await this.commit(sessionId, parsed.argument)
        case 'undo':
          return await this.undo(parsed.argument)
        case 'audit':
          return this.audit(parsed.argument)
        case 'help':
          return { kind: 'success', text: vikingUsage(this.options.writesEnabled()) }
        default:
          return { kind: 'error', text: `Unknown /viking command.\n${vikingUsage(this.options.writesEnabled())}` }
      }
    } catch (error) {
      if (error instanceof CommandCancelled || signal?.aborted === true) return CANCELLED
      return { kind: 'error', text: commandErrorText(error instanceof Error ? error.message : String(error)) }
    }
  }

  /** The one-screen status: where, as whom, what is mounted, what is pending. */
  private async status(sessionId: string, signal?: AbortSignal): Promise<string> {
    const { connection, commit, api, memoryPluginVersion, dshVersion } = this.options
    throwIfCancelled(signal)
    const health = await api.health(signal === undefined ? {} : { signal })
    throwIfCancelled(signal)
    const lines: string[] = []
    lines.push(
      `OpenViking ${health.version ?? '?'} · ${health.ok ? 'healthy' : 'unreachable'} · ${connection.endpoint}`,
    )
    const scope = this.options.identity()
    const peer = scope.peer === null ? '' : ` · peer ${scope.peer}`
    lines.push(
      `Identity: ${scope.account}/${scope.user}${peer} · auth ${health.authMode ?? (connection.apiKey ? 'bearer' : 'none')}` +
        `${scope.profileId === null ? ' · no profile' : ` · profile ${scope.profileLabel ?? scope.profileId}`}`,
    )
    lines.push(`Writes: ${this.options.writesEnabled() ? 'enabled' : 'disabled (enableWrites is off)'}`)
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
      throwIfCancelled(signal)
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
  private async doctor(sessionId: string, signal?: AbortSignal): Promise<string> {
    throwIfCancelled(signal)
    const report = await this.options.doctor.report(
      sessionId,
      signal === undefined ? { probe: false } : { probe: false, signal },
    )
    throwIfCancelled(signal)
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
  private async recall(
    sessionId: string,
    argument: string,
    signal?: AbortSignal,
  ): Promise<VikingCommandResult> {
    const query = argument.trim()
    if (query.length === 0) return { kind: 'error', text: 'Usage: /viking recall <query>' }
    throwIfCancelled(signal)
    const payload = await this.options.recall.recall(
      sessionId,
      query,
      RECALL_DEFAULT_LIMIT,
      signal === undefined ? {} : { signal },
    )
    throwIfCancelled(signal)
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
  private async open(argument: string, signal?: AbortSignal): Promise<VikingCommandResult> {
    const uri = vikingUriArgument(argument)
    if (uri === null) {
      return { kind: 'error', text: 'Usage: /viking open <viking://…>' }
    }
    throwIfCancelled(signal)
    const preview = await this.options.preview.preview(uri, signal === undefined ? {} : { signal })
    throwIfCancelled(signal)
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

  /* ---- write verbs (prepare only; the card / --confirm executes) -------- */

  /** `/viking edit <uri>`: no write, only the editor envelope. */
  private async edit(argument: string): Promise<VikingCommandResult> {
    if (!this.requireWrites()) return this.writesDisabled()
    const uri = vikingUriArgument(argument)
    if (uri === null) return { kind: 'error', text: 'Usage: /viking edit <viking://…>' }
    const classified = classifyCuratableUri(uri)
    if (!classified.ok) {
      return { kind: 'error', text: `Not curatable in this version (${classified.reason}); resources, skills, rules and sidecars stay read-only.` }
    }
    const envelope: VikingEditorEnvelope = {
      ov: '1',
      kind: 'open-editor',
      uri: classified.target.uri,
      scope: this.options.identity(),
    }
    return {
      kind: 'success',
      text: `Open the editor for ${classified.target.uri} (button below, or click the URI in the preview tab).\n${JSON.stringify(envelope)}`,
    }
  }

  /** `/viking forget <uri> [--confirm <token>]`. */
  private async forget(sessionId: string, argument: string): Promise<VikingCommandResult> {
    if (!this.requireWrites()) return this.writesDisabled()
    const token = confirmTokenArgument(argument)
    if (token !== null) return this.executeToken(token, 'delete-memory')
    const uri = vikingUriArgument(argument)
    if (uri === null) return { kind: 'error', text: 'Usage: /viking forget <viking://…>' }
    const prepared = await this.options.writes.prepare({
      action: 'delete-memory',
      target: uri,
      sessionId,
      origin: 'command',
    })
    if (!prepared.ok) return { kind: 'error', text: `${prepared.error.code}: ${prepared.error.message}` }
    return this.confirmResult(prepared, 'forget', 'Type the file name in the card (or use the plain --confirm form).')
  }

  /** `/viking tag <uri> <k=v …>` or `/viking tag <uri> --clear`. */
  private async tag(sessionId: string, argument: string): Promise<VikingCommandResult> {
    if (!this.requireWrites()) return this.writesDisabled()
    const token = confirmTokenArgument(argument)
    if (token !== null) return this.executeToken(token, 'set-tags')
    const withoutConfirm = argument.replace(/--confirm(?:\s+|=)?[0-9a-f]{16,128}/i, '').trim()
    const appendMode = /(?:^|\s)--append(?:\s|$)/.test(withoutConfirm)
    const cleaned = withoutConfirm.replace(/(?:^|\s)--append(?=\s|$)/, ' ').trim()
    const space = cleaned.search(/\s/)
    const uri = vikingUriArgument(space === -1 ? cleaned : cleaned.slice(0, space))
    const rest = space === -1 ? '' : cleaned.slice(space + 1).trim()
    if (uri === null) return { kind: 'error', text: 'Usage: /viking tag <viking://…> <key=value…> | --clear | --append <key=value…>' }
    const clear = rest === '--clear' || rest === 'clear'
    const tags = clear ? [] : rest.split(/\s+/).filter((part) => part.length > 0)
    if (rest.length === 0) return { kind: 'error', text: 'Usage: /viking tag <uri> <key=value…> | --clear | --append <key=value…>' }
    const prepared = await this.options.writes.prepare({
      action: 'set-tags',
      target: uri,
      sessionId,
      origin: 'command',
      tags,
      tagMode: clear ? 'clear' : appendMode ? 'append' : 'replace',
    })
    if (!prepared.ok) return { kind: 'error', text: `${prepared.error.code}: ${prepared.error.message}` }
    return this.confirmResult(prepared, 'tag', 'Confirm the tag list in the card (empty list clears).')
  }

  /** `/viking commit [--confirm <token>]`. */
  private async commit(sessionId: string, argument: string): Promise<VikingCommandResult> {
    if (!this.requireWrites()) return this.writesDisabled()
    const token = confirmTokenArgument(argument)
    if (token !== null) return this.executeToken(token, 'force-commit')
    const prepared = await this.options.writes.prepare({
      action: 'force-commit',
      target: sessionId,
      sessionId,
      origin: 'command',
    })
    if (!prepared.ok) return { kind: 'error', text: `${prepared.error.code}: ${prepared.error.message}` }
    return this.confirmResult(prepared, 'commit', 'Confirmation is always required; extraction cannot be rolled back.')
  }

  /** `/viking undo <handle>`: plan first, apply when the plan is clean. */
  private async undo(argument: string): Promise<VikingCommandResult> {
    if (!this.requireWrites()) return this.writesDisabled()
    const undoId = argument.trim()
    if (!/^[0-9a-f]{16,64}$/i.test(undoId)) {
      return { kind: 'error', text: 'Usage: /viking undo <handle id from a write result>' }
    }
    const plan = await this.options.writes.plan({ undoId })
    if (!plan.ok) return { kind: 'error', text: `${plan.error.code}: ${plan.error.message}` }
    if (plan.plan.extraChanges) {
      return {
        kind: 'error',
        text:
          'This undo would also revert files the action did not change, or the target was rewritten after the action. ' +
          'Review the plan and confirm it in the undo dialog instead.',
      }
    }
    const applied = await this.options.writes.undo({ undoId })
    if (!applied.ok) return { kind: 'error', text: `${applied.error.code}: ${applied.error.message}` }
    return {
      kind: 'success',
      text:
        applied.outcome === 'tags-restored'
          ? `Undone: previous tags restored on ${applied.target}.`
          : `Undone: ${applied.target} restored from snapshot ${shortHash(applied.newCommit ?? '')}.` +
            (applied.taskId === null ? '' : ` Reindex task ${applied.taskId}.`),
    }
  }

  /** `/viking audit [n]`: the local trail, one line each. No bodies, no tokens. */
  private audit(argument: string): VikingCommandResult {
    const requested = Number(argument.trim() || '10')
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 10
    const lines = this.options.audit.recentLines(limit)
    if (lines.length === 0) return { kind: 'success', text: 'No audit records yet.' }
    return { kind: 'success', text: lines.join('\n') }
  }

  /* ---- shared write-command helpers ------------------------------------ */

  private requireWrites(): boolean {
    return this.options.writesEnabled()
  }

  private writesDisabled(): VikingCommandResult {
    return {
      kind: 'error',
      text: 'Write commands are disabled. Turn on “Writes” in the plugin settings (Plugins → OpenViking → Configure).',
    }
  }

  /**
   * Execute a prepared token from a plain `--confirm` command.
   *
   * The token's action is checked host-side **before** execution: a crossed token
   * (`/viking forget --confirm <tags token>`) must not perform its own action and
   * only then report a mismatch. `execute({expectAction})` enforces the same rule
   * inside the write service, so the ordering cannot regress here alone.
   */
  private async executeToken(token: string, action: string): Promise<VikingCommandResult> {
    const pending = this.options.writes.pendingAction(token)
    if (pending === null) {
      return { kind: 'error', text: 'token-expired: that confirmation is unknown, expired or already settled; prepare the action again.' }
    }
    if (pending !== action) {
      return { kind: 'error', text: `invalid-request: that token was prepared for ${pending}, not ${action}; nothing was written.` }
    }
    const executed = await this.options.writes.execute({ token, expectAction: action as WriteAction })
    if (!executed.ok) return { kind: 'error', text: `${executed.error.code}: ${executed.error.message}` }
    if (executed.undoId !== null) {
      return {
        kind: 'success',
        text: `Done: ${executed.action} on ${executed.target}. Undo handle: ${executed.undoId} (or use the undo toast in the interface).`,
      }
    }
    if (executed.action === 'force-commit') {
      const task = executed.taskId === null ? 'nothing to commit' : `task ${executed.taskId}`
      return { kind: 'success', text: `Commit accepted: ${task}. Extraction runs in the background; follow it in the Activity tab.` }
    }
    return { kind: 'success', text: `Done: ${executed.action} on ${executed.target}.` }
  }

  /** A prepared action as the human line + the card envelope. */
  private confirmResult(
    prepared: { ok: true } & WritePreparePayload,
    subcommand: VikingSubcommand,
    hint: string,
  ): VikingCommandResult {
    const safe: WritePreparePayload = { ...prepared, content: null, contentTruncated: false }
    const envelope: VikingConfirmEnvelope = { ov: '1', kind: 'confirm', prepare: safe, hint }
    const expiresIn = Math.max(0, Math.round((prepared.expiresAt - (this.options.now?.() ?? Date.now())) / 1000))
    const instruction =
      `Confirm in the card below, or run ${fallbackCommand(subcommand)} ${prepared.token} within ${expiresIn}s.`
    const summary = prepared.summary.length > 0 ? prepared.summary[0] : `Prepared ${prepared.action} on ${prepared.target}`
    return { kind: 'success', text: `${summary}\n${instruction}\n${JSON.stringify(envelope)}` }
  }
}

/** Wrap the runner as the registry definition; the guard owns registration. */
export function vikingCommandDefinition(runner: VikingCommand): VikingCommandDefinition {
  return {
    name: 'viking',
    description: 'Inspect and curate OpenViking: status, doctor, recall, preview, and confirmed memory writes',
    input: {
      hint: 'status | doctor | recall <query> | open <viking://…> | edit | forget | tag | commit | undo | audit | help',
    },
    handler: async (invocation) => {
      if (invocation.signal?.aborted === true) return CANCELLED
      const sessionId = typeof invocation.agent?.id === 'string' ? invocation.agent.id : ''
      if (sessionId.length === 0) {
        return { kind: 'error', text: 'Cannot determine the DSH session id for this command.' }
      }
      const rawInput = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
      // The registry settles a cancelled handler as an error; threading the
      // signal means the underlying retrieval aborts too instead of finishing
      // in the background.
      return runner.run(rawInput, sessionId, invocation.signal)
    },
  }
}
