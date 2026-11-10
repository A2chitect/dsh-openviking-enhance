/**
 * v0.8 "Operate": ONE protocol for every controlled operational action.
 *
 *   prepare (gates + runtime capability probes + capability-specific read/dry-run)
 *     → single-use token + human plan payload (scope, params, counts, consequences)
 *     → explicit confirmation (typed word for destructive actions)
 *     → execute (re-check token/TTL/identity/gates, perform the OpenViking mutation,
 *                verify-read, audit)
 *     → optional undo handle (snapshot restore + file-version restore only)
 *
 * The v0.5 write safety rules are reused, not re-invented: the token/TTL/pending
 * logic and the single in-flight gate are the extracted `confirmation-store.ts`
 * controllers, the audit trail is the same JSONL file, and the diagnostics keep
 * the same envelope (`{ok:false, error:{code,message,details?}}`).
 *
 * Gates, all re-checked at prepare **and** execute (fail closed):
 *   1. `enableOps` true (read live);
 *   2. authenticated transport present (`ctx.connection.fetch.register`);
 *   3. healthy probed server/identity, fingerprint recorded on the token;
 *   4. action capability/version/role gate — a runtime answer, never a version;
 *   5. target allowlist;
 *   6. the shared mutation gate with `WriteService` (one mutation in flight).
 *
 * Explicitly not undoable: snapshot create (commits are append-only), compile
 * run (derived outputs + vector indexes, no rollback API) and pack export (a
 * local file). Restores are forward commits, so their undo is another forward
 * restore — history is never rewritten.
 */
import {
  COMPILE_FROM_MAX,
  COMPILE_INSTRUCTION_MAX_CHARS,
  COMPILE_SKILL_MAX_CHARS,
  OPS_MAX_PENDING,
  OPS_PREPARE_RATE_LIMIT,
  OPS_PREPARE_RATE_WINDOW_MS,
  OPS_RATE_LIMIT,
  OPS_RATE_WINDOW_MS,
  OPS_TOKEN_TTL_MS,
  SNAPSHOT_RESTORE_PLAN_PATHS,
} from '../shared/limits.ts'
import type {
  ActivityTask,
  CompileRunPlan,
  FileVersionRestorePlan,
  IdentityScope,
  OpsAction,
  OpsCancelPayload,
  OpsExecutePayload,
  OpsPlan,
  OpsPlanPath,
  OpsPreparePayload,
  OpsUndoPayload,
  OpsUndoPlan,
  OveError,
  OveResult,
  PackExportPlan,
  PluginNotice,
  SnapshotCreatePlan,
  SnapshotRestorePlan,
} from '../shared/protocol.ts'
import { isUndoableOpsAction } from '../shared/protocol.ts'
import {
  ConfirmationStore,
  MutationGate,
  SlidingWindowRate,
  mintToken,
  type ConfirmationRecord,
} from './confirmation-store.ts'
import { leafName, classifySnapshotPaths, classifySnapshotScope, SNAPSHOT_MESSAGE_MAX_CHARS } from './snapshot-service.ts'
import type { AuditLog } from './audit.ts'
import type { CapabilityService } from './capability.ts'
import type { CompileService } from './compile-service.ts'
import type { PackDownloadBroker } from './pack-service.ts'
import type { SnapshotService } from './snapshot-service.ts'

/** What one prepare asks for; the index route parses the discriminated body. */
export type OpsPrepareRequest =
  | { action: 'snapshot-create'; message: string; paths: string[] }
  | { action: 'snapshot-restore'; projectDir: string; sourceCommit: string }
  | { action: 'compile-run'; to: string; from: string[]; skill: string; instruction?: string; configuredTarget?: string }
  | { action: 'pack-export'; uri: string; includeVectors?: boolean }
  | { action: 'file-version-restore'; uri: string; restoreVersion: string; currentVersion?: string }

/** One pending confirmation; `data` is the action-specific prepared facts. */
interface PendingOps extends ConfirmationRecord {
  action: OpsAction
  target: string
  origin: 'overlay' | 'command' | 'api'
  identityFingerprint: string
  plan: OpsPlan
  data: Record<string, unknown>
}

/** One undo handle (snapshot restore-of-restore or file-version CAS restore). */
interface OpsUndoRecord {
  undoId: string
  action: 'snapshot-restore' | 'file-version-restore'
  target: string
  identityFingerprint: string
  createdAt: number
  undone: boolean
  projectDir: string
  sourceCommit: string
  /** The paths the original action itself wrote/deleted (its own inverse set). */
  expectedWrite: string[]
  expectedDelete: string[]
  /** File-version undo facts (empty for a directory restore). */
  uri: string
  priorVersion: string
  restoredVersion: string
  priorVersionNumber: number | null
  restoredVersionNumber: number | null
}

export interface OpsServiceOptions {
  capabilities: CapabilityService
  snapshot: SnapshotService
  compile: CompileService
  packs: PackDownloadBroker
  audit: AuditLog
  identity: () => IdentityScope
  /** Live `enableOps` value. */
  opsEnabled: () => boolean
  /** Whether `ctx.connection.fetch.register` exists in this composition. */
  transport: () => boolean
  /** The shared v0.5/v0.8 mutation gate. */
  gate: MutationGate
  activeUser: () => string
  now?: () => number
  randomToken?: () => string
}

/** The longest a prepared commit message may be (display + server bound). */
const CREATE_MESSAGE_MAX = 200
/** The longest a snapshot ref may be. */
const SNAPSHOT_REF_MAX = 128

export class OpsService {
  private readonly options: OpsServiceOptions
  private readonly tokens: ConfirmationStore<PendingOps>
  private readonly undos = new Map<string, OpsUndoRecord>()
  private readonly executions: SlidingWindowRate
  private readonly prepares: SlidingWindowRate
  private readonly now: () => number
  private readonly randomToken: () => string

  constructor(options: OpsServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => mintToken())
    this.tokens = new ConfirmationStore<PendingOps>({ maxPending: OPS_MAX_PENDING, now: this.now })
    this.executions = new SlidingWindowRate(OPS_RATE_LIMIT, OPS_RATE_WINDOW_MS, this.now)
    this.prepares = new SlidingWindowRate(OPS_PREPARE_RATE_LIMIT, OPS_PREPARE_RATE_WINDOW_MS, this.now)
  }

  /** Whether the shared gate is currently held by any mutation (write or ops). */
  get mutationInFlight(): boolean {
    return this.options.gate.busy
  }

  /**
   * Step 1. Every action runs the same gates, then builds the plan the user will
   * confirm; nothing is mutated here (a restore dry-run writes nothing).
   */
  async prepare(request: OpsPrepareRequest): Promise<OveResult<OpsPreparePayload>> {
    if (this.options.gate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or operation is already executing; wait for it to settle.') }
    }
    const gate = await this.gateFor(request.action)
    if (gate !== null) return { ok: false, error: gate }
    this.tokens.purge()

    // Preparing is not free (a restore prepare runs a server-side dry-run, which
    // can be expensive), so a separate quota bounds a prepare→cancel loop.
    const prepareQuota = this.prepares.check()
    if (!prepareQuota.ok) {
      const error = err(
        'rate-limited',
        `At most ${prepareQuota.limit} operation confirmations per minute; try again in ${Math.ceil(prepareQuota.retryAfterMs / 1000)}s.`,
        { kind: 'prepare', retryAfterMs: prepareQuota.retryAfterMs, limit: prepareQuota.limit },
      )
      this.auditDenied(request.action, targetOf(request), error)
      return { ok: false, error }
    }
    if (this.tokens.atPendingCap()) {
      const error = err('too-many-pending', `At most ${OPS_MAX_PENDING} confirmations may be pending at once.`)
      this.auditDenied(request.action, targetOf(request), error)
      return { ok: false, error }
    }
    if (this.tokens.hasExecuting()) {
      const error = err('write-in-flight', 'Another operation is already executing.')
      this.auditDenied(request.action, targetOf(request), error)
      return { ok: false, error }
    }

    const scope = this.options.identity()
    const prepared = await this.prepareAction(request, scope)
    if (!prepared.ok) {
      this.auditDenied(request.action, targetOf(request), prepared.error)
      return { ok: false, error: prepared.error }
    }
    const token = this.randomToken()
    const createdAt = this.now()
    const record: PendingOps = {
      token,
      action: request.action,
      target: prepared.target,
      origin: 'overlay',
      identityFingerprint: scope.fingerprint,
      plan: prepared.plan,
      data: prepared.data,
      createdAt,
      expiresAt: createdAt + OPS_TOKEN_TTL_MS,
      status: 'pending',
      settledAt: null,
    }
    this.tokens.set(record)
    this.prepares.record()
    return {
      ok: true,
      token,
      action: request.action,
      target: prepared.target,
      scope,
      expiresAt: record.expiresAt,
      plan: prepared.plan,
      summary: prepared.summary,
    }
  }

  /**
   * Step 2. Consume the token, re-check every gate/identity/typed word, perform
   * the action, verify-read where the server allows it, and audit.
   */
  async execute(request: { token: string; typed?: string }): Promise<OveResult<OpsExecutePayload>> {
    if (this.options.gate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or operation is already executing.') }
    }
    // Settlement refusals are deliberately unaudited (double-clicks/stale dialogs
    // are not security events), exactly like the v0.5 write protocol.
    this.tokens.purge()
    const token = this.tokens.get(request.token)
    if (token === undefined) return { ok: false, error: err('token-expired', 'This confirmation token is unknown or expired.') }
    if (token.status === 'cancelled') return { ok: false, error: err('token-used', 'This confirmation was cancelled.') }
    if (token.status === 'done' || token.status === 'undone' || token.status === 'failed') {
      return { ok: false, error: err('token-used', 'This confirmation was already used.') }
    }
    if (token.status === 'executing') return { ok: false, error: err('write-in-flight', 'This confirmation is already executing.') }
    if (this.now() > token.expiresAt) {
      this.tokens.delete(token.token)
      return { ok: false, error: err('token-expired', 'This confirmation expired; prepare the action again.') }
    }
    const gate = await this.gateCore()
    if (gate !== null) return { ok: false, error: gate }
    if (this.now() > token.expiresAt) {
      this.tokens.delete(token.token)
      return { ok: false, error: err('token-expired', 'This confirmation expired; prepare the action again.') }
    }
    const scope = this.options.identity()
    if (scope.fingerprint !== token.identityFingerprint) {
      token.status = 'failed'
      token.settledAt = this.now()
      const error = err('identity-changed', 'The active identity changed after this action was prepared.')
      this.auditDenied(token.action, token.target, error)
      return { ok: false, error }
    }
    // Destructive restores always need the typed word (no command origin exists
    // for v0.8 actions: the overlay dialog is the only entry point).
    const typedWord = typedWordOf(token.plan)
    if (typedWord !== null) {
      if (typeof request.typed !== 'string' || request.typed.trim().length === 0) {
        const error = err('typed-confirmation-required', `Type "${typedWord}" to confirm this action.`, { typedWord })
        this.auditDenied(token.action, token.target, error)
        return { ok: false, error }
      }
      if (request.typed.trim() !== typedWord) {
        const error = err('typed-confirmation-mismatch', 'The typed name does not match the scope.')
        this.auditDenied(token.action, token.target, error)
        return { ok: false, error }
      }
    }
    const rate = this.executions.check()
    if (!rate.ok) {
      const error = err(
        'rate-limited',
        `At most ${rate.limit} operations per minute; try again in ${Math.ceil(rate.retryAfterMs / 1000)}s.`,
        { kind: 'execute', retryAfterMs: rate.retryAfterMs, limit: rate.limit },
      )
      this.auditDenied(token.action, token.target, error)
      return { ok: false, error }
    }
    // Re-check after the awaits: a concurrent execute/write may have claimed the
    // shared mutation path while this one was probing.
    if (this.options.gate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or operation started while preparing this one.') }
    }
    this.options.gate.enter('ops')
    token.status = 'executing'
    try {
      const result = await this.executeAction(token, scope)
      if (result.ok) this.executions.record()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      token.status = 'failed'
      token.settledAt = this.now()
      this.auditFailed(token, 'rejected-by-server', message)
      return { ok: false, error: err('rejected-by-server', message) }
    } finally {
      this.options.gate.leave()
    }
  }

  /** Step 3a: the undo dry-run plan (no mutation). */
  async plan(request: { undoId: string }): Promise<OveResult<{ plan: OpsUndoPlan }>> {
    const record = this.undos.get(request.undoId)
    if (record === undefined) return { ok: false, error: err('undo-unavailable', 'No undo handle with that id (it may have expired).') }
    const scope = this.options.identity()
    if (scope.fingerprint !== record.identityFingerprint) {
      const error = err('identity-changed', 'This action was prepared under a different identity; switch back before undoing.')
      this.auditDenied(record.action, record.target, error)
      return { ok: false, error }
    }
    return { ok: true, plan: await this.buildUndoPlan(record) }
  }

  /** Step 3b: apply the undo; extra changes need the user's second confirmation. */
  async undo(request: { undoId: string; confirmExtra?: boolean }): Promise<OveResult<OpsUndoPayload>> {
    if (this.options.gate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or operation is already executing; wait for it to settle.') }
    }
    const record = this.undos.get(request.undoId)
    if (record === undefined) return { ok: false, error: err('undo-unavailable', 'No undo handle with that id (it may have expired).') }
    const gate = await this.gateCore()
    if (gate !== null) return { ok: false, error: gate }
    if (record.undone) return { ok: false, error: err('token-used', 'This action was already undone.') }
    const scope = this.options.identity()
    if (scope.fingerprint !== record.identityFingerprint) {
      const error = err('identity-changed', 'Undo is refused after an identity switch; switch back to the original profile.')
      this.auditDenied(record.action, record.target, error)
      return { ok: false, error }
    }
    const plan = await this.buildUndoPlan(record)
    if (plan.extraChanges && request.confirmExtra !== true) {
      return { ok: false, error: err('extra-changes', 'The undo plan touches files this action did not change. Confirm explicitly to continue.', plan) }
    }
    if (this.options.gate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or operation started while this undo was prepared.') }
    }
    this.options.gate.enter('ops')
    try {
      if (record.action === 'snapshot-restore') {
        const applied = await this.options.snapshot.applyRestore(record.projectDir, record.sourceCommit)
        if (!applied.ok) {
          this.auditUndoFailed(record, applied.message)
          return { ok: false, error: err(applied.code, applied.message) }
        }
        record.undone = true
        this.publishOperationId(applied.newCommit)
        const audit = this.options.audit.append({
          kind: 'undo',
          action: record.action,
          target: record.target,
          identity: auditIdentity(scope),
          fingerprint: record.identityFingerprint,
          confirmation: 'overlay',
          preCommit: record.sourceCommit,
          postCommit: applied.newCommit,
          requestId: applied.requestId,
          result: 'undone',
          error: null,
          undo: { kind: 'snapshot-restore', projectDir: record.projectDir, sourceCommit: record.sourceCommit },
          taskId: applied.taskId,
          snapshot: { projectDir: record.projectDir, sourceCommit: record.sourceCommit, newCommit: applied.newCommit },
        })
        return {
          ok: true,
          undoId: record.undoId,
          action: record.action,
          target: record.target,
          outcome: 'restored',
          newCommit: applied.newCommit,
          taskId: applied.taskId,
          auditId: audit.id ?? '',
          newVersionId: null,
          newVersionNumber: null,
          warnings: [],
        }
      }
      const applied = await this.options.snapshot.restoreFileVersion(record.uri, record.priorVersion, record.restoredVersion)
      if (!applied.ok) {
        this.auditUndoFailed(record, applied.message)
        return { ok: false, error: err(applied.code, applied.message) }
      }
      record.undone = true
      const audit = this.options.audit.append({
        kind: 'undo',
        action: record.action,
        target: record.target,
        identity: auditIdentity(scope),
        fingerprint: record.identityFingerprint,
        confirmation: 'overlay',
        preCommit: null,
        postCommit: null,
        requestId: applied.requestId,
        result: 'undone',
        error: null,
        undo: null,
        snapshot: { projectDir: null, sourceCommit: null, newCommit: null },
      })
      return {
        ok: true,
        undoId: record.undoId,
        action: record.action,
        target: record.target,
        outcome: 'version-restored',
        newCommit: null,
        taskId: null,
        auditId: audit.id ?? '',
        newVersionId: applied.versionId,
        newVersionNumber: applied.versionNumber,
        warnings: [],
      }
    } finally {
      this.options.gate.leave()
    }
  }

  /** Release a still-pending confirmation (dialog closed/Escape). Idempotent. */
  cancel(tokenValue: string): OveResult<OpsCancelPayload> {
    this.tokens.purge()
    const token = this.tokens.get(tokenValue)
    if (token === undefined) return { ok: true, status: 'expired', action: null }
    if (token.status !== 'pending') return { ok: true, status: 'settled', action: null }
    token.status = 'cancelled'
    token.settledAt = this.now()
    this.options.audit.append({
      kind: 'cancel',
      action: token.action,
      target: token.target,
      identity: auditIdentity(this.options.identity()),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId: null,
      result: 'ok',
      error: null,
      undo: null,
    })
    return { ok: true, status: 'cancelled', action: token.action }
  }

  /* ---- gates ------------------------------------------------------------ */

  /** The master gates shared by every action (prepare and execute). */
  private async gateCore(): Promise<OveError | null> {
    if (!this.options.opsEnabled()) return err('ops-disabled', 'Operations are disabled (enableOps is off).')
    if (!this.options.transport()) return err('transport-unavailable', 'Operations need the DSH 0.2.2-rc.1 connection transport.')
    const scope = this.options.identity()
    if (scope.fingerprint.length === 0) return err('identity-ambiguous', 'The active identity is unknown; operations are refused.')
    const snapshot = await this.options.capabilities.probe()
    if (!snapshot.health.ok) return err('profile-unhealthy', snapshot.health.error ?? 'The active profile is not healthy.')
    if (snapshot.health.authMode === null) {
      return err('identity-ambiguous', 'The server did not report an auth mode, so the identity is ambiguous; operations are refused.')
    }
    return null
  }

  /** The action capability/role gate; a runtime answer, never a version string. */
  private async gateFor(action: OpsAction): Promise<OveError | null> {
    const core = await this.gateCore()
    if (core !== null) {
      this.auditDenied(action, '', core)
      return core
    }
    const snapshot = await this.options.capabilities.probe()
    if (action === 'snapshot-create' || action === 'snapshot-restore' || action === 'file-version-restore') {
      if (!snapshot.snapshot.available) {
        const error = err('snapshot-unavailable', 'This server has no snapshot capability, so restore/create actions are disabled.')
        this.auditDenied(action, '', error)
        return error
      }
      if (action === 'file-version-restore' && !snapshot.versions.available) {
        const error = err('not-supported', 'Per-file version history needs OpenViking 0.5.3+ (route not present on this server).')
        this.auditDenied(action, '', error)
        return error
      }
      return null
    }
    if (action === 'compile-run') {
      if (!snapshot.compile.available) {
        const reason =
          snapshot.compile.reason === 'API_KEY_REQUIRED'
            ? 'Compile requires an API-key credential on this deployment (can_create=false).'
            : snapshot.compile.reason === 'NOT_CONFIGURED'
              ? 'Compile is not configured on this server.'
              : 'This server does not expose a usable compile capability.'
        const error = err(snapshot.compile.reason === 'API_KEY_REQUIRED' ? 'compile-role-required' : 'compile-not-configured', reason, {
          reason: snapshot.compile.reason,
        })
        this.auditDenied(action, '', error)
        return error
      }
      return null
    }
    // pack-export
    const pack = await this.options.capabilities.pack()
    if (!pack.available) {
      const error = err(
        pack.detail === 'pack-role-required' ? 'forbidden' : 'pack-export-unavailable',
        pack.detail === 'pack-role-required'
          ? 'This deployment requires API-key authentication for OVPack export.'
          : 'This server does not expose the OVPack export route.',
      )
      this.auditDenied(action, '', error)
      return error
    }
    return null
  }

  /* ---- prepare per action ---------------------------------------------- */

  private async prepareAction(
    request: OpsPrepareRequest,
    scope: IdentityScope,
  ): Promise<
    | { ok: true; target: string; plan: OpsPlan; data: Record<string, unknown>; summary: string[] }
    | { ok: false; error: OveError }
  > {
    const user = this.options.activeUser()
    if (request.action === 'snapshot-create') {
      const message = request.message.trim()
      if (message.length === 0) return { ok: false, error: err('invalid-request', 'A commit message is required.') }
      if (message.length > CREATE_MESSAGE_MAX) {
        return { ok: false, error: err('invalid-request', `The message is limited to ${SNAPSHOT_MESSAGE_MAX_CHARS} characters.`) }
      }
      const paths = classifySnapshotPaths(request.paths, 'commit', user)
      if (!paths.ok) return { ok: false, error: err(paths.refusal.code, paths.refusal.message) }
      const plan: SnapshotCreatePlan = { kind: 'snapshot-create', message, paths: paths.paths, notUndoable: true }
      return {
        ok: true,
        target: paths.paths[0] as string,
        plan,
        data: {},
        summary: [
          `Create a snapshot of ${paths.paths.length} path${paths.paths.length === 1 ? '' : 's'}`,
          `Paths: ${paths.paths.join(', ')}`,
          `Message: ${message}`,
          'Creates a commit. Commits cannot be deleted through the API, so this action is not undoable.',
        ],
      }
    }
    if (request.action === 'snapshot-restore') {
      const scopeCheck = classifySnapshotScope(request.projectDir, 'restore', user)
      if (!scopeCheck.ok) return { ok: false, error: err(scopeCheck.refusal.code, scopeCheck.refusal.message) }
      const sourceCommit = request.sourceCommit.trim()
      if (sourceCommit.length === 0 || sourceCommit.length > SNAPSHOT_REF_MAX || /[\s\u0000-\u001f]/.test(sourceCommit)) {
        return { ok: false, error: err('invalid-request', 'A valid source commit/ref is required.') }
      }
      const dry = await this.options.snapshot.dryRunRestore(scopeCheck.uri, sourceCommit)
      if (!dry.ok) return { ok: false, error: err(dry.code, dry.message, dry.details) }
      const truncated = dry.toWrite.length + dry.toDelete.length > SNAPSHOT_RESTORE_PLAN_PATHS
      const plan: SnapshotRestorePlan = {
        kind: 'snapshot-restore',
        projectDir: scopeCheck.uri,
        sourceCommit,
        head: dry.head,
        toWrite: dry.toWrite.slice(0, SNAPSHOT_RESTORE_PLAN_PATHS).map((entry) => ({ path: entry.path, expected: true })),
        toDelete: dry.toDelete.slice(0, SNAPSHOT_RESTORE_PLAN_PATHS).map((entry) => ({ path: entry.path, expected: true })),
        unchanged: dry.unchanged,
        extraChanges: false,
        truncated,
        typedWord: leafName(scopeCheck.uri),
        notUndoable: false,
      }
      return {
        ok: true,
        target: scopeCheck.uri,
        plan,
        data: {
          head: dry.head,
          writtenPaths: dry.toWrite.map((entry) => entry.path),
          deletedPaths: dry.toDelete.map((entry) => entry.path),
        },
        summary: [
          `Restore ${scopeCheck.uri} to ${sourceCommit}`,
          `${dry.toWrite.length} file(s) will be written, ${dry.toDelete.length} deleted, ${dry.unchanged} unchanged.`,
          dry.toDelete.length > 0 ? `${dry.toDelete.length} file(s) will be deleted.` : 'No files will be deleted.',
          'Restore overwrites uncommitted changes under this directory from any session.',
          'The restore is a new commit; undo is another forward restore to the current parent.',
        ],
      }
    }
    if (request.action === 'compile-run') {
      const compilePlan = await this.buildCompilePlan(request, user)
      if (!compilePlan.ok) return { ok: false, error: compilePlan.error }
      return {
        ok: true,
        target: compilePlan.plan.to,
        plan: compilePlan.plan,
        data: {},
        summary: [
          `Compile ${compilePlan.plan.from.length} source(s) into ${compilePlan.plan.to}`,
          `Skill: ${compilePlan.plan.skill}${compilePlan.plan.instruction === null ? '' : ` · instruction: ${compilePlan.plan.instruction}`}`,
          `Idempotency-Key: ${compilePlan.plan.idempotencyKey}`,
          'Creates new output files and reindexes them; there is no undo for a compile.',
          'Cancellation is cooperative and does not roll back completed work.',
        ],
      }
    }
    if (request.action === 'pack-export') {
      const uri = classifySnapshotScope(request.uri, 'pack', user)
      if (!uri.ok) return { ok: false, error: err(uri.refusal.code, uri.refusal.message) }
      const includeVectors = request.includeVectors === true
      const plan: PackExportPlan = {
        kind: 'pack-export',
        uri: uri.uri,
        includeVectors,
        maxBytes: 64 * 1024 * 1024,
        notUndoable: true,
      }
      return {
        ok: true,
        target: uri.uri,
        plan,
        data: {},
        summary: [
          `Export ${uri.uri} as an .ovpack download`,
          `Include vectors: ${includeVectors ? 'yes' : 'no (default)'}`,
          'The file is downloaded to your machine and may contain sensitive context; delete it when done.',
          'This action does not modify the server store.',
        ],
      }
    }
    // file-version-restore
    const scopeCheck = classifySnapshotScope(request.uri, 'restore', user)
    if (!scopeCheck.ok) return { ok: false, error: err(scopeCheck.refusal.code, scopeCheck.refusal.message) }
    const restoreVersion = request.restoreVersion.trim()
    if (restoreVersion.length === 0 || restoreVersion.length > 128) {
      return { ok: false, error: err('invalid-request', 'A version id is required.') }
    }
    const versions = await this.options.snapshot.versions({ uri: scopeCheck.uri, limit: 100, beforeVersion: null })
    if (!versions.available || versions.currentVersion === null) {
      return {
        ok: false,
        error: err(
          versions.note === 'not-compile-managed' ? 'not-supported' : 'versions-unavailable',
          versions.note === 'not-compile-managed'
            ? 'Only compile output files have versions; this file has no version history.'
            : 'The version history could not be read.',
        ),
      }
    }
    const target = versions.versions.find((entry) => entry.versionId === restoreVersion)
    if (target === undefined) {
      return { ok: false, error: err('not-found', 'That version is not in this file\'s history page.') }
    }
    if (request.currentVersion !== undefined && request.currentVersion !== versions.currentVersion) {
      return { ok: false, error: err('revision-mismatch', 'The file changed while the dialog was open; reload the version list.') }
    }
    const current = versions.versions.find((entry) => entry.versionId === versions.currentVersion)
    const plan: FileVersionRestorePlan = {
      kind: 'file-version-restore',
      uri: scopeCheck.uri,
      currentVersion: versions.currentVersion,
      restoreVersion,
      restoreVersionNumber: target.versionNumber,
      currentVersionNumber: current?.versionNumber ?? null,
      typedWord: leafName(scopeCheck.uri),
      notUndoable: false,
    }
    return {
      ok: true,
      target: scopeCheck.uri,
      plan,
      data: { restoreVersion, currentVersion: versions.currentVersion },
      summary: [
        `Restore ${scopeCheck.uri} to version ${target.versionNumber}`,
        `Current version: ${current?.versionNumber ?? '?'} · target: ${target.versionNumber}`,
        'A restore creates a new version; history is never rewritten.',
        'The undo restores the pre-restore version only if the file did not change in between.',
      ],
    }
  }

  /** Build the compile plan from a configured target and/or explicit parameters. */
  private async buildCompilePlan(
    request: Extract<OpsPrepareRequest, { action: 'compile-run' }>,
    user: string,
  ): Promise<{ ok: true; plan: CompileRunPlan } | { ok: false; error: OveError }> {
    let to = request.to.trim()
    let from = request.from.map((entry) => entry.trim())
    let skill = request.skill.trim()
    let instruction = request.instruction?.trim() ?? ''
    let configuredTarget: string | null = null
    if (request.configuredTarget !== undefined && request.configuredTarget.trim().length > 0) {
      const config = await this.options.compile.targetConfig(request.configuredTarget.trim())
      if (!config.available || config.target === null) {
        return { ok: false, error: err('compile-not-configured', 'That configured target could not be read on this server.') }
      }
      configuredTarget = config.target.to
      to = config.target.to
      from = config.target.from
      skill = config.target.skill ?? ''
      instruction = instruction.length > 0 ? instruction : (config.target.instruction ?? '')
    }
    const toCheck = classifySnapshotScope(to, 'compile', user)
    if (!toCheck.ok) return { ok: false, error: err(toCheck.refusal.code, toCheck.refusal.message) }
    if (from.length === 0) return { ok: false, error: err('invalid-request', 'At least one source (from) URI is required.') }
    if (from.length > COMPILE_FROM_MAX) {
      return { ok: false, error: err('invalid-request', `At most ${COMPILE_FROM_MAX} source directories are allowed.`) }
    }
    const sources: string[] = []
    for (const entry of from) {
      const check = classifySnapshotScope(entry, 'compile', user)
      if (!check.ok) return { ok: false, error: err(check.refusal.code, check.refusal.message) }
      if (!sources.includes(check.uri)) sources.push(check.uri)
    }
    if (skill.length === 0) return { ok: false, error: err('invalid-request', 'A skill name is required.') }
    if (skill.length > COMPILE_SKILL_MAX_CHARS) {
      return { ok: false, error: err('invalid-request', `The skill name is limited to ${COMPILE_SKILL_MAX_CHARS} characters.`) }
    }
    if (skill === 'memory' || skill.endsWith('/memory')) {
      // Memory consolidation is agent-specific and outside the operator envelope.
      return { ok: false, error: err('invalid-request', 'The skill:"memory" sentinel is not available for operator-triggered compiles.') }
    }
    if (!/^[A-Za-z0-9._:/-]+$/.test(skill)) {
      return { ok: false, error: err('invalid-request', 'The skill name contains unsupported characters.') }
    }
    if (instruction.length > COMPILE_INSTRUCTION_MAX_CHARS) {
      return { ok: false, error: err('invalid-request', `The instruction is limited to ${COMPILE_INSTRUCTION_MAX_CHARS} characters.`) }
    }
    const plan: CompileRunPlan = {
      kind: 'compile-run',
      to: toCheck.uri,
      from: sources,
      skill,
      instruction: instruction.length === 0 ? null : instruction,
      configuredTarget,
      // 32-byte-ish random, non-secret, within the server's 16–128 header pattern.
      idempotencyKey: `dsh-${this.randomToken().slice(0, 24)}`,
      notUndoable: true,
    }
    return { ok: true, plan }
  }

  /* ---- execute per action ---------------------------------------------- */

  private async executeAction(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    if (token.action === 'snapshot-create') {
      return this.executeSnapshotCreate(token, scope)
    }
    if (token.action === 'snapshot-restore') {
      return this.executeSnapshotRestore(token, scope)
    }
    if (token.action === 'compile-run') {
      return this.executeCompileRun(token, scope)
    }
    if (token.action === 'pack-export') {
      return this.executePackExport(token, scope)
    }
    return this.executeFileVersionRestore(token, scope)
  }

  private finish(token: PendingOps, status: 'done' | 'failed'): void {
    token.status = status
    token.settledAt = this.now()
  }

  /** Remember the operation id from a snapshot commit verify-read (best effort). */
  private publishOperationId(_commit: string | null): void {
    // The snapshot commit oid is not a compile operation id; nothing to publish.
  }

  private async executeSnapshotCreate(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    const plan = token.plan as SnapshotCreatePlan
    const requestId = { value: null as string | null }
    const created = await this.options.snapshot.commitSnapshot(plan.message, plan.paths, requestId)
    if (!created.ok) {
      this.finish(token, 'failed')
      this.auditFailed(token, created.code, created.message, created.requestId)
      return { ok: false, error: err(created.code, created.message) }
    }
    const verified = await this.options.snapshot.verifyCommit(created.commit)
    this.finish(token, 'done')
    const audit = this.options.audit.append({
      kind: 'snapshot',
      action: 'snapshot-create',
      target: token.target,
      identity: auditIdentity(scope),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: created.commit,
      requestId: created.requestId ?? requestId.value,
      result: 'ok',
      error: null,
      undo: null,
      snapshot: { projectDir: null, sourceCommit: null, newCommit: created.commit },
    })
    return {
      ok: true,
      action: token.action,
      target: token.target,
      scope,
      auditId: audit.id ?? '',
      requestId: created.requestId ?? requestId.value,
      verified,
      warnings: verified ? [] : [{ code: 'verificationPending' }],
      undoId: null,
      postCommit: created.commit,
    }
  }

  private async executeSnapshotRestore(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    const plan = token.plan as SnapshotRestorePlan
    const head = token.data.head
    // The plan was computed against a specific HEAD; re-run the dry-run and
    // refuse if history moved (revision-mismatch, no automatic retry).
    const recheck = await this.options.snapshot.dryRunRestore(plan.projectDir, plan.sourceCommit)
    if (!recheck.ok) {
      this.finish(token, 'failed')
      this.auditFailed(token, recheck.code, recheck.message)
      return { ok: false, error: err(recheck.code, recheck.message) }
    }
    if (typeof head === 'string' && recheck.head !== null && recheck.head !== head) {
      this.finish(token, 'failed')
      const error = err('revision-mismatch', 'History moved since this plan was computed; reload and review the new plan.', {
        expectedHead: head,
        actualHead: recheck.head,
      })
      this.auditFailed(token, error.code, error.message)
      return { ok: false, error }
    }
    const applied = await this.options.snapshot.applyRestore(plan.projectDir, plan.sourceCommit)
    if (!applied.ok) {
      this.finish(token, 'failed')
      if (applied.partial !== null) {
        // Partial writeback: HEAD advanced, some VFS writes failed, a reindex
        // task exists. Report honestly and offer a new operation or an undo.
        const undo = this.rememberSnapshotUndo(token, plan.projectDir, applied.partial.parentCommit ?? '', applied.partial.writtenPaths, applied.partial.deletedPaths, scope)
        this.auditFailed(token, 'failed-partial', applied.message, applied.requestId)
        return {
          ok: true,
          action: token.action,
          target: token.target,
          scope,
          auditId: '',
          requestId: applied.requestId,
          verified: false,
          warnings: [{ code: 'restorePartial' }],
          undoId: undo,
          newCommit: applied.partial.newCommit,
          parentCommit: applied.partial.parentCommit,
          written: applied.partial.writtenPaths.length,
          deleted: applied.partial.deletedPaths.length,
          unchanged: 0,
          taskId: applied.partial.taskId,
          partial: {
            writtenPaths: applied.partial.writtenPaths,
            deletedPaths: applied.partial.deletedPaths,
            failedWrites: applied.partial.failedWrites,
            failedDeletes: applied.partial.failedDeletes,
            taskId: applied.partial.taskId,
          },
        }
      }
      this.auditFailed(token, applied.code, applied.message, applied.requestId)
      return { ok: false, error: err(applied.code, applied.message) }
    }
    const verified = await this.options.snapshot.verifyCommit(applied.newCommit)
    const undoId = this.rememberSnapshotUndo(token, plan.projectDir, applied.parentCommit ?? '', applied.writtenPaths, applied.deletedPaths, scope)
    this.finish(token, 'done')
    const audit = this.options.audit.append({
      kind: 'snapshot',
      action: 'snapshot-restore',
      target: token.target,
      identity: auditIdentity(scope),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: applied.parentCommit,
      postCommit: applied.newCommit,
      requestId: applied.requestId,
      result: 'ok',
      error: null,
      undo: undoId === null ? null : { kind: 'snapshot-restore', projectDir: plan.projectDir, sourceCommit: applied.parentCommit ?? '' },
      taskId: applied.taskId,
      snapshot: { projectDir: plan.projectDir, sourceCommit: plan.sourceCommit, newCommit: applied.newCommit },
    })
    return {
      ok: true,
      action: token.action,
      target: token.target,
      scope,
      auditId: audit.id ?? '',
      requestId: applied.requestId,
      verified,
      warnings: verified ? [] : [{ code: 'verificationPending' }],
      undoId,
      newCommit: applied.newCommit,
      parentCommit: applied.parentCommit,
      written: applied.written,
      deleted: applied.deleted,
      unchanged: applied.unchanged,
      taskId: applied.taskId,
      partial: null,
    }
  }

  private async executeCompileRun(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    const plan = token.plan as CompileRunPlan
    const triggered = await this.options.compile.trigger(
      {
        to: plan.to,
        from: plan.from,
        skill: plan.skill,
        ...(plan.instruction === null ? {} : { instruction: plan.instruction }),
      },
      plan.idempotencyKey,
    )
    if (!triggered.ok) {
      this.finish(token, 'failed')
      this.auditFailed(token, triggered.code, triggered.message, triggered.requestId)
      return { ok: false, error: err(triggered.code, triggered.message) }
    }
    const task: ActivityTask | null = triggered.task === null ? null : mapCompileTask(triggered.task)
    this.finish(token, 'done')
    const audit = this.options.audit.append({
      kind: 'compile',
      action: 'compile-run',
      target: plan.to,
      identity: auditIdentity(scope),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId: triggered.requestId,
      result: 'ok',
      error: null,
      undo: null,
      taskId: triggered.taskId,
      idempotencyKey: plan.idempotencyKey,
    })
    const verificationPending = triggered.taskId === null
    return {
      ok: true,
      action: token.action,
      target: token.target,
      scope,
      auditId: audit.id ?? '',
      requestId: triggered.requestId,
      verified: !verificationPending,
      warnings: verificationPending ? [{ code: 'compileVerificationPending' }] : [],
      undoId: null,
      taskId: triggered.taskId,
      task,
      idempotencyKey: plan.idempotencyKey,
      submissionKey: plan.idempotencyKey,
      operationId: null,
      verificationPending,
    }
  }

  private async executePackExport(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    const plan = token.plan as PackExportPlan
    const exported = await this.options.packs.export(plan.uri, plan.includeVectors)
    if (!exported.ok) {
      this.finish(token, 'failed')
      this.auditFailed(token, exported.code, exported.message, exported.requestId)
      return { ok: false, error: err(exported.code, exported.message) }
    }
    this.finish(token, 'done')
    const audit = this.options.audit.append({
      kind: 'pack',
      action: 'pack-export',
      target: plan.uri,
      identity: auditIdentity(scope),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId: exported.requestId,
      result: 'ok',
      error: null,
      undo: null,
      bytes: exported.bytes,
    })
    return {
      ok: true,
      action: token.action,
      target: token.target,
      scope,
      auditId: audit.id ?? '',
      requestId: exported.requestId,
      verified: true,
      warnings: [{ code: 'packOneTimeDownload' }],
      undoId: null,
      downloadId: exported.downloadId,
      fileName: exported.fileName,
      bytes: exported.bytes,
      expiresAt: exported.expiresAt,
    }
  }

  private async executeFileVersionRestore(token: PendingOps, scope: IdentityScope): Promise<OveResult<OpsExecutePayload>> {
    const plan = token.plan as FileVersionRestorePlan
    const applied = await this.options.snapshot.restoreFileVersion(plan.uri, plan.restoreVersion, plan.currentVersion)
    if (!applied.ok) {
      this.finish(token, 'failed')
      this.auditFailed(token, applied.code, applied.message, applied.requestId)
      return { ok: false, error: err(applied.code, applied.message) }
    }
    const undoId =
      applied.versionId === null
        ? null
        : this.rememberVersionUndo(
            token,
            plan.uri,
            plan.currentVersion,
            applied.versionId,
            plan.restoreVersionNumber,
            applied.versionNumber,
            scope,
          )
    this.finish(token, 'done')
    const audit = this.options.audit.append({
      kind: 'snapshot',
      action: 'file-version-restore',
      target: plan.uri,
      identity: auditIdentity(scope),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId: applied.requestId,
      result: 'ok',
      error: null,
      undo: undoId === null ? null : { kind: 'file-version-restore', projectDir: '', sourceCommit: '' },
      snapshot: { projectDir: null, sourceCommit: plan.restoreVersion, newCommit: null },
    })
    return {
      ok: true,
      action: token.action,
      target: token.target,
      scope,
      auditId: audit.id ?? '',
      requestId: applied.requestId,
      verified: applied.versionId !== null,
      warnings: applied.noop ? [{ code: 'versionRestoreNoop' }] : [],
      undoId,
      versionNumber: applied.versionNumber,
    }
  }

  /* ---- undo handles ----------------------------------------------------- */

  private rememberSnapshotUndo(
    token: PendingOps,
    projectDir: string,
    parentCommit: string,
    writtenPaths: string[],
    deletedPaths: string[],
    _scope: IdentityScope,
  ): string | null {
    if (parentCommit.length === 0) return null
    const undoId = this.randomToken().slice(0, 32)
    this.rememberUndo({
      undoId,
      action: 'snapshot-restore',
      target: projectDir,
      identityFingerprint: token.identityFingerprint,
      createdAt: this.now(),
      undone: false,
      projectDir,
      sourceCommit: parentCommit,
      expectedWrite: writtenPaths,
      expectedDelete: deletedPaths,
      uri: '',
      priorVersion: '',
      restoredVersion: '',
      priorVersionNumber: null,
      restoredVersionNumber: null,
    })
    return undoId
  }

  private rememberVersionUndo(
    token: PendingOps,
    uri: string,
    priorVersion: string,
    restoredVersion: string,
    priorVersionNumber: number | null,
    restoredVersionNumber: number | null,
    _scope: IdentityScope,
  ): string {
    const undoId = this.randomToken().slice(0, 32)
    this.rememberUndo({
      undoId,
      action: 'file-version-restore',
      target: uri,
      identityFingerprint: token.identityFingerprint,
      createdAt: this.now(),
      undone: false,
      projectDir: '',
      sourceCommit: '',
      expectedWrite: [],
      expectedDelete: [],
      uri,
      priorVersion,
      restoredVersion,
      priorVersionNumber,
      restoredVersionNumber,
    })
    return undoId
  }

  private rememberUndo(record: OpsUndoRecord): void {
    this.undos.set(record.undoId, record)
    while (this.undos.size > 24) {
      const oldest = this.undos.keys().next()
      if (oldest.done === true) break
      this.undos.delete(oldest.value)
    }
  }

  private async buildUndoPlan(record: OpsUndoRecord): Promise<OpsUndoPlan> {
    if (record.action === 'file-version-restore') {
      const versions = await this.options.snapshot.versions({ uri: record.uri, limit: 100, beforeVersion: null })
      const current = versions.currentVersion
      // If the file changed after the restore, the CAS would refuse; mark the
      // plan as extra so the dialog asks for the second explicit confirmation.
      const extraChanges = current !== null && current !== record.restoredVersion
      return {
        undoId: record.undoId,
        action: record.action,
        kind: 'file-version-restore',
        target: record.target,
        projectDir: '',
        sourceCommit: '',
        toWrite: [],
        toDelete: [],
        unchanged: 0,
        extraChanges,
        truncated: false,
        uri: record.uri,
        restoreVersion: record.priorVersion,
        currentVersion: current ?? record.restoredVersion,
        summary: [
          `Restore ${record.uri} to version ${record.priorVersionNumber ?? 'previous'}`,
          `Current version: ${versions.versions.find((entry) => entry.versionId === current)?.versionNumber ?? '?'}`,
          extraChanges ? 'The file changed after this restore; the undo would conflict (CAS refuses).' : 'The file is unchanged since the restore.',
        ],
      }
    }
    const dry = await this.options.snapshot.dryRunRestore(record.projectDir, record.sourceCommit)
    if (!dry.ok) {
      return {
        undoId: record.undoId,
        action: record.action,
        kind: 'snapshot-restore',
        target: record.target,
        projectDir: record.projectDir,
        sourceCommit: record.sourceCommit,
        toWrite: [],
        toDelete: [],
        unchanged: 0,
        extraChanges: true,
        truncated: false,
        uri: null,
        restoreVersion: null,
        currentVersion: null,
        summary: ['The undo dry run failed; the plan could not be computed.'],
      }
    }
    const expected = new Set([...record.expectedWrite, ...record.expectedDelete].map((entry) => basename(entry)))
    const toWrite: OpsPlanPath[] = dry.toWrite.map((entry) => ({ path: entry.path, expected: expected.has(basename(entry.path)) }))
    const toDelete: OpsPlanPath[] = dry.toDelete.map((entry) => ({ path: entry.path, expected: expected.has(basename(entry.path)) }))
    const extraChanges = [...toWrite, ...toDelete].some((entry) => !entry.expected)
    const truncated = toWrite.length + toDelete.length > SNAPSHOT_RESTORE_PLAN_PATHS
    return {
      undoId: record.undoId,
      action: record.action,
      kind: 'snapshot-restore',
      target: record.target,
      projectDir: record.projectDir,
      sourceCommit: record.sourceCommit,
      toWrite: toWrite.slice(0, SNAPSHOT_RESTORE_PLAN_PATHS),
      toDelete: toDelete.slice(0, SNAPSHOT_RESTORE_PLAN_PATHS),
      unchanged: dry.unchanged,
      extraChanges,
      truncated,
      uri: null,
      restoreVersion: null,
      currentVersion: null,
      summary: [
        `Restore ${record.projectDir} to ${record.sourceCommit} (the pre-restore parent)`,
        `${dry.toWrite.length} file(s) will be written, ${dry.toDelete.length} deleted, ${dry.unchanged} unchanged.`,
        'This appends a new commit; history is never rewritten.',
      ],
    }
  }

  /* ---- audit helpers ---------------------------------------------------- */

  private auditFailed(token: PendingOps, code: string, message: string, requestId: string | null = null): void {
    const kind = token.action === 'snapshot-create' || token.action === 'snapshot-restore' || token.action === 'file-version-restore' ? 'snapshot' : token.action === 'compile-run' ? 'compile' : 'pack'
    this.options.audit.append({
      kind,
      action: token.action,
      target: token.target,
      identity: auditIdentity(this.options.identity()),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId,
      result: 'failed',
      error: `${code}: ${message}`,
      undo: null,
    })
  }

  private auditUndoFailed(record: OpsUndoRecord, message: string): void {
    this.options.audit.append({
      kind: 'undo',
      action: record.action,
      target: record.target,
      identity: auditIdentity(this.options.identity()),
      fingerprint: record.identityFingerprint,
      confirmation: 'overlay',
      preCommit: null,
      postCommit: null,
      requestId: null,
      result: 'failed',
      error: message,
      undo: null,
    })
  }

  private auditDenied(action: string, target: string, error: OveError): void {
    this.options.audit.append({
      kind: 'denied',
      action,
      target: target.length === 0 ? null : target,
      identity: auditIdentity(this.options.identity()),
      fingerprint: this.options.identity().fingerprint,
      confirmation: null,
      preCommit: null,
      postCommit: null,
      requestId: null,
      result: 'denied',
      error: `${error.code}: ${error.message}`,
      undo: null,
    })
  }
}

/* ---- small helpers ------------------------------------------------------- */

/** The target an early refusal can name (the request's own primary field). */
function targetOf(request: OpsPrepareRequest): string {
  if (request.action === 'snapshot-create') return request.paths[0] ?? ''
  if (request.action === 'snapshot-restore') return request.projectDir
  if (request.action === 'compile-run') return request.to
  return request.uri
}

/** The typed confirmation word a plan requires, or null (not destructive). */
function typedWordOf(plan: OpsPlan): string | null {
  return plan.kind === 'snapshot-restore' || plan.kind === 'file-version-restore' ? plan.typedWord : null
}

/** The basename of a plan path (relative path or full URI, both handled). */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Map a compile TaskRecord body into the shared ActivityTask shape. */
function mapCompileTask(record: Record<string, unknown>): ActivityTask {
  const str = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  const num = (key: string): number | null => (typeof record[key] === 'number' ? (record[key] as number) : null)
  return {
    taskId: str('task_id') ?? '',
    taskType: str('task_type') ?? 'compile',
    status: str('status') ?? 'pending',
    stage: str('stage'),
    error: str('error'),
    createdAt: num('created_at'),
    updatedAt: num('updated_at'),
    processingSeconds: num('processing_seconds'),
    resourceId: str('resource_id'),
    resultSummary: null,
  }
}

/** The redacted audit identity; the same shape v0.5 records. */
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

function err(code: string, message: string, details?: unknown): OveError {
  return details === undefined ? { code, message } : { code, message, details }
}
