/**
 * F9/F10: the one write protocol every v0.5 mutation goes through.
 *
 *   prepare → explicit confirm → execute → verify-read → post-commit + audit
 *
 * The rules are implementation, not documentation:
 *
 *  - **opt-in** — every entry point re-checks `enableWrites` at call time (the
 *    value is read live from the Loader's volatile config);
 *  - **fail closed** — no transport, unhealthy profile, absent snapshot
 *    capability, an uncuratable target, a changed revision, a missing pre-write
 *    `commit_oid`: each refuses *before* the mutation with a stable error code;
 *  - **single use** — a 32-byte token with a 120 s TTL, bound to the identity
 *    fingerprint + action + target; at most 8 pending, at most 3 successful
 *    writes per minute (enforced at execution, so prepared tokens cannot burst
 *    past it), and a separate quota of 10 snapshot-creating preparations per
 *    minute (prepares take a real snapshot commit even if later cancelled);
 *  - **one write in flight** per profile, no automatic retries anywhere;
 *  - **undo is a snapshot restore** — an undo handle records the pre-write
 *    commit and the directory scope; applying it first runs a `dry_run` plan
 *    and any path outside the action's own inverse set needs a second explicit
 *    confirmation;
 *  - **audit** — every executed write, undo, identity switch and *denied
 *    attempt* appends one JSONL record (no bodies, no secrets, no token).
 *
 * Two honest exceptions the design names:
 *
 *  - **force commit is not undoable** (extraction is non-deterministic); the
 *    audit entry carries the task id instead of an undo handle;
 *  - **tags are not file content** — the pre-write snapshot is still taken
 *    (binding decision C), but undo re-applies the captured tag list
 *    (`docs/api-v05.md` §2.5) rather than restoring a file that never changed.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  WRITE_CONTENT_MAX_CHARS,
  WRITE_MAX_PENDING,
  WRITE_PREPARE_RATE_LIMIT,
  WRITE_PREPARE_RATE_WINDOW_MS,
  WRITE_RATE_LIMIT,
  WRITE_RATE_WINDOW_MS,
  WRITE_TOKEN_TTL_MS,
  type AuditIdentity,
  type AuditKind,
  type ForceCommitFacts,
  type IdentityScope,
  type OveError,
  type OveResult,
  type UndoPlanPath,
  type WriteAction,
  type WriteCancelPayload,
  type WriteExecutePayload,
  type WritePreparePayload,
  type WriteRevision,
  type WriteUndoPayload,
  type WriteUndoPlan,
} from '../shared/protocol.ts'
import {
  classifyCuratableUri,
  peerOfMemoryUri,
  restoreScopeFor,
  snapshotPathsFor,
  validateTagInput,
  TAG_MAX,
  type CuratableTarget,
} from '../shared/curation.ts'
import type { AuditLog } from './audit.ts'
import type { CapabilityService } from './capability.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import type { SessionControlService } from './session-control.ts'
import { mapTask } from './activity-service.ts'
import {
  ConfirmationStore,
  MutationGate,
  SlidingWindowRate,
  type ConfirmationRecord,
} from './confirmation-store.ts'

/** What one prepare asks for. */
export interface PrepareRequest {
  action: WriteAction
  /** A `viking://` memory URI, or the DSH session id for a force commit. */
  target: string
  /** The DSH session the action is taken from — supplies the actor peer. */
  sessionId?: string
  /** Where the confirmation comes from; commands are typed-in confirmations. */
  origin?: 'overlay' | 'command' | 'api'
  /** Set-tags: the desired list, so a command card/`--confirm` can carry it. */
  tags?: string[]
  /** Set-tags: how the list is applied; defaults to `replace`. */
  tagMode?: 'replace' | 'append' | 'clear'
}

/** What one execute carries back. */
export interface ExecuteRequest {
  token: string
  /** Edit: the new body. */
  content?: string
  /** Set-tags: the desired final list (empty means clear). */
  tags?: string[]
  /** Set-tags: how to apply the list; defaults to the prepared mode. */
  tagMode?: 'replace' | 'append' | 'clear'
  /** Delete: the file name typed by the user (overlay confirmations only). */
  typed?: string
  /**
   * The action this caller believes the token was prepared for.
   *
   * `execute` refuses a mismatch *before* touching the server, which is what the
   * plain `--confirm` command fallback needs: `/viking forget --confirm <tags
   * token>` must not perform the tag write and only then report a mismatch.
   */
  expectAction?: WriteAction
}

export interface PlanRequest {
  undoId: string
}

export interface UndoRequest {
  undoId: string
  /** Set by the client after the user approved an extra-changes plan. */
  confirmExtra?: boolean
}

/** One pending confirmation (v0.8: shares the confirmation-store record shape). */
interface PendingWrite extends ConfirmationRecord {
  action: WriteAction
  target: string
  curatable: CuratableTarget | null
  sessionId: string | null
  origin: 'overlay' | 'command' | 'api'
  identityFingerprint: string
  revision: WriteRevision | null
  contentHash: string | null
  preCommit: string | null
  tagsBefore: string[] | null
  /** Set-tags: the list the requester asked for (used by command confirmations). */
  requestedTags: string[] | null
  /** Set-tags: how the requester asked to apply it. */
  tagMode: 'replace' | 'append' | 'clear' | null
  confirmWord: string | null
  facts: ForceCommitFacts | null
  createdAt: number
  expiresAt: number
  status: 'pending' | 'executing' | 'done' | 'undone' | 'failed' | 'cancelled'
  settledAt: number | null
}

/** One undo handle: everything needed to revert without keeping a body copy. */
interface UndoRecord {
  undoId: string
  action: 'edit-memory' | 'delete-memory' | 'set-tags'
  target: string
  curatable: CuratableTarget
  projectDir: string
  sourceCommit: string
  identityFingerprint: string
  tagsBefore: string[] | null
  /**
   * The state this action left behind, used to notice a same-named file that was
   * rewritten before undo (review S1). Edit: hash of the written body. Delete:
   * null (the file must still be absent). Tags: the tag list the action set.
   */
  writtenSha256: string | null
  tagsAfter: string[] | null
  sessionId: string | null
  createdAt: number
  undone: boolean
}

export interface WriteServiceOptions {
  api: OpenVikingApi
  capabilities: CapabilityService
  sessions: SessionControlService
  audit: AuditLog
  /** The active identity, secret-free, with its stable fingerprint. */
  identity: () => IdentityScope
  /** Live `enableWrites` value. */
  writesEnabled: () => boolean
  /** Whether `ctx.connection.fetch.register` exists in this composition. */
  transport: () => boolean
  /** The actor peer for a DSH session, when the memory plugin knows it. */
  actorPeer?: (sessionId: string | undefined) => string | undefined
  /** Status sink for the client's "write in flight" guard. */
  onStateChange?: () => void
  /**
   * v0.8: the shared mutation gate. When supplied, a curation write and an
   * operational action cannot run concurrently (one lock spans both services).
   */
  gate?: MutationGate
  tokenTtlMs?: number
  maxPending?: number
  rateLimit?: number
  rateWindowMs?: number
  /** Separate quota for snapshot-creating prepares (review round 2, N2). */
  prepareRateLimit?: number
  prepareRateWindowMs?: number
  now?: () => number
  randomToken?: () => string
}

export class WriteService {
  private readonly options: WriteServiceOptions
  /**
   * v0.8: the token/TTL/pending logic is shared with `OpsService` through
   * `confirmation-store.ts`; a write token is the same kind of record, so the
   * two services cannot drift and one bounded store spans both.
   */
  private readonly tokens: ConfirmationStore<PendingWrite>
  private readonly undos = new Map<string, UndoRecord>()
  /**
   * One mutation path at a time (review S5): the gate is set synchronously before
   * an execute or undo starts mutating and cleared when it settles. v0.8 shares
   * this gate with `OpsService`, so a curation write and an operational action
   * can never overlap.
   */
  private readonly mutationGate: MutationGate
  /**
   * Successful executions in the current rate window. Only writes that actually
   * happened spend this budget (review S2); the limit is enforced when a token
   * is executed, not when it is prepared (review round 2, N1).
   */
  private readonly executions: SlidingWindowRate
  /**
   * Snapshot-creating prepares in the current window. A prepare is **not** a
   * cheap read: it commits a snapshot before the user can approve it, so a
   * prepare→cancel loop would pollute the server's snapshot history. Cancels do
   * not reclaim this quota; only the window does (review round 2, N2).
   */
  private readonly prepares: SlidingWindowRate
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly tokenTtlMs: number

  constructor(options: WriteServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'))
    this.tokenTtlMs = options.tokenTtlMs ?? WRITE_TOKEN_TTL_MS
    this.mutationGate = options.gate ?? new MutationGate()
    this.executions = new SlidingWindowRate(options.rateLimit ?? WRITE_RATE_LIMIT, options.rateWindowMs ?? WRITE_RATE_WINDOW_MS, this.now)
    this.prepares = new SlidingWindowRate(
      options.prepareRateLimit ?? WRITE_PREPARE_RATE_LIMIT,
      options.prepareRateWindowMs ?? WRITE_PREPARE_RATE_WINDOW_MS,
      this.now,
    )
    this.tokens = new ConfirmationStore<PendingWrite>({ maxPending: options.maxPending ?? WRITE_MAX_PENDING, now: this.now })
  }

  /**
   * v0.9: how many confirmation tokens are pending or executing.
   *
   * The scope-switch guard reads this (plus the shared mutation gate): a switch
   * is refused while any curation action is unresolved, and a token prepared
   * under the previous identity stays visible but refuses with
   * `identity-changed` after an allowed switch (sign-off 3).
   */
  unresolvedCount(): number {
    let count = 0
    for (const record of this.tokens.values()) {
      if (record.status === 'pending' || record.status === 'executing') count += 1
    }
    return count
  }

  /**
   * The action a still-usable token was prepared for, or null.
   *
   * Read-only and side-effect free apart from purging expired entries. Command
   * callers compare it with the verb they were asked to confirm *before*
   * executing, so a crossed token cannot perform its own action first.
   */
  pendingAction(tokenValue: string): WriteAction | null {
    this.purge()
    const token = this.tokens.get(tokenValue)
    if (token === undefined || token.status !== 'pending') return null
    if (this.now() > token.expiresAt) return null
    return token.action
  }

  /**
   * Release a confirmation the user dismissed (review S2).
   *
   * Only a still-pending token is cancelled; a settled/executing one is a no-op
   * so the dialog can call this unconditionally when it closes. A cancelled token
   * frees its pending slot and can never execute.
   */
  cancel(tokenValue: string): OveResult<WriteCancelPayload> {
    this.purge()
    const token = this.tokens.get(tokenValue)
    if (token === undefined) return { ok: true, status: 'expired', action: null }
    if (token.status !== 'pending') return { ok: true, status: 'settled', action: null }
    token.status = 'cancelled'
    token.settledAt = this.now()
    this.options.audit.append({
      kind: 'cancel',
      action: token.action,
      target: token.target,
      identity: this.identityFor(this.options.identity(), token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: token.preCommit,
      postCommit: null,
      requestId: null,
      result: 'ok',
      error: null,
      undo: null,
    })
    this.notify()
    return { ok: true, status: 'cancelled', action: token.action }
  }

  /**
   * Step 1: validate the gates, read the current state, take the pre-write
   * snapshot and mint one single-use confirmation token.
   */
  async prepare(request: PrepareRequest): Promise<OveResult<WritePreparePayload>> {
    // A write path that is already mutating rejects new preparations rather than
    // taking a snapshot against a state that is about to change (review S5).
    if (this.mutationGate.busy) {
      return { ok: false, error: err('write-in-flight', 'A write or undo is already executing; wait for it to settle.') }
    }
    // Every snapshot-backed action needs the capability before the token exists;
    // a force commit does not touch file content and is gated only by health.
    const gate = await this.gate(
      request.action,
      request.target,
      request.sessionId ?? null,
      request.action !== 'force-commit',
    )
    if (gate !== null) return { ok: false, error: gate }
    this.purge()

    // Preparing is not free: it takes the pre-write snapshot. A separate quota
    // bounds the snapshot history a prepare→cancel loop can create (N2).
    const prepareQuota = this.checkPrepareQuota()
    if (prepareQuota !== null) {
      this.auditDenied(request.action, request.target, request.sessionId ?? null, prepareQuota)
      return { ok: false, error: prepareQuota }
    }
    if (this.tokens.atPendingCap()) {
      const error = err('too-many-pending', `At most ${this.options.maxPending ?? WRITE_MAX_PENDING} confirmations may be pending at once.`)
      this.auditDenied(request.action, request.target, request.sessionId ?? null, error)
      return { ok: false, error }
    }
    if (this.tokens.hasExecuting()) {
      const error = err('write-in-flight', 'Another write is already executing.')
      this.auditDenied(request.action, request.target, request.sessionId ?? null, error)
      return { ok: false, error }
    }

    const scope = this.options.identity()
    const actorPeerId = this.options.actorPeer?.(request.sessionId)
    const token = this.randomToken()
    const createdAt = this.now()
    const base: Omit<
      PendingWrite,
      'revision' | 'contentHash' | 'preCommit' | 'tagsBefore' | 'requestedTags' | 'tagMode' | 'confirmWord' | 'facts'
    > = {
      token,
      action: request.action,
      target: request.target,
      curatable: null,
      sessionId: request.sessionId ?? null,
      origin: request.origin ?? 'overlay',
      identityFingerprint: scope.fingerprint,
      createdAt,
      expiresAt: createdAt + this.tokenTtlMs,
      status: 'pending',
      settledAt: null,
    }

    if (request.action === 'force-commit') {
      const sessionId = (request.sessionId ?? '').trim()
      if (sessionId.length === 0) {
        return { ok: false, error: err('invalid-request', 'A force commit needs the DSH session id.') }
      }
      const facts = await this.options.sessions.facts(sessionId)
      this.tokens.set({
        ...base,
        revision: null,
        contentHash: null,
        preCommit: null,
        tagsBefore: null,
        requestedTags: null,
        tagMode: null,
        confirmWord: null,
        facts,
      })
      this.recordPrepare()
      return {
        ok: true,
        ...this.preparePayload({
          token,
          action: 'force-commit',
          target: sessionId,
          scope,
          expiresAt: createdAt + this.tokenTtlMs,
          revision: null,
          preCommit: null,
          content: null,
          contentTruncated: false,
          beforeChars: null,
          afterChars: null,
          tagsBefore: null,
          tagsAfter: null,
          tagMode: null,
          confirmWord: null,
          session: facts,
          summary: [
            `Force commit session ${sessionId}`,
            `${facts.pendingTokens ?? '?'} pending tokens · ${facts.messageCount ?? '?'} live messages · ${facts.commitCount ?? '?'} commits so far`,
            'Archives every live message and extracts memories; extraction cannot be rolled back.',
          ],
        }),
      }
    }

    const classified = classifyCuratableUri(request.target)
    if (!classified.ok) {
      const error = err('target-not-curatable', `This target is not curatable: ${classified.reason}.`, {
        reason: classified.reason,
      })
      this.auditDenied(request.action, request.target, request.sessionId ?? null, error)
      return { ok: false, error }
    }
    const target = classified.target

    // Actor-peer/target cross-check (optional review item): a session-scoped
    // write carries the session's peer, and a target URI naming another peer's
    // tree would silently curate that other scope.
    const targetPeer = peerOfMemoryUri(target.uri)
    if (targetPeer !== null && request.sessionId !== undefined && request.sessionId.length > 0) {
      const actorPeer = this.options.actorPeer?.(request.sessionId)
      if (actorPeer !== undefined && actorPeer !== targetPeer) {
        const error = err(
          'invalid-request',
          `The target belongs to peer "${targetPeer}", but this session writes as "${actorPeer}".`,
          { reason: 'peer-mismatch', targetPeer, actorPeer },
        )
        this.auditDenied(request.action, target.uri, request.sessionId, error)
        return { ok: false, error }
      }
    }

    if (request.action === 'edit-memory') {
      const current = await this.readRevision(target.uri, actorPeerId)
      if ('error' in current) {
        this.auditDenied('edit-memory', target.uri, request.sessionId ?? null, current.error)
        return { ok: false, error: current.error }
      }
      if (current.text.length > WRITE_CONTENT_MAX_CHARS) {
        const error = err('content-too-large', `The file is ${current.text.length} characters; the editor is limited to ${WRITE_CONTENT_MAX_CHARS}.`)
        this.auditDenied('edit-memory', target.uri, request.sessionId ?? null, error)
        return { ok: false, error }
      }
      const snapshot = await this.takeSnapshot('edit-memory', target, actorPeerId)
      if ('error' in snapshot) {
        this.auditDenied('edit-memory', target.uri, request.sessionId ?? null, snapshot.error)
        return { ok: false, error: snapshot.error }
      }
      this.tokens.set({
        ...base,
        curatable: target,
        revision: current.revision,
        contentHash: current.revision.sha256,
        preCommit: snapshot.commit,
        tagsBefore: null,
        requestedTags: null,
        tagMode: null,
        confirmWord: null,
        facts: null,
      })
      this.recordPrepare()
      return {
        ok: true,
        ...this.preparePayload({
          token,
          action: 'edit-memory',
          target: target.uri,
          scope,
          expiresAt: createdAt + this.tokenTtlMs,
          revision: current.revision,
          preCommit: snapshot.commit,
          content: current.text,
          contentTruncated: false,
          beforeChars: current.text.length,
          afterChars: null,
          tagsBefore: null,
          tagsAfter: null,
          tagMode: null,
          confirmWord: null,
          session: null,
          summary: [
            `Edit ${target.uri}`,
            `Revision ${shortHash(current.revision.sha256)} · ${current.revision.size} B${current.revision.modifiedAt === null ? '' : ` · ${current.revision.modifiedAt}`}`,
            `Pre-write snapshot ${shortHash(snapshot.commit)} keeps this version restoreable.`,
          ],
        }),
      }
    }

    if (request.action === 'delete-memory') {
      const current = await this.readRevision(target.uri, actorPeerId)
      if ('error' in current) {
        this.auditDenied('delete-memory', target.uri, request.sessionId ?? null, current.error)
        return { ok: false, error: current.error }
      }
      const snapshot = await this.takeSnapshot('delete-memory', target, actorPeerId)
      if ('error' in snapshot) {
        this.auditDenied('delete-memory', target.uri, request.sessionId ?? null, snapshot.error)
        return { ok: false, error: snapshot.error }
      }
      this.tokens.set({
        ...base,
        curatable: target,
        revision: current.revision,
        contentHash: current.revision.sha256,
        preCommit: snapshot.commit,
        tagsBefore: null,
        requestedTags: null,
        tagMode: null,
        confirmWord: target.fileName,
        facts: null,
      })
      this.recordPrepare()
      return {
        ok: true,
        ...this.preparePayload({
          token,
          action: 'delete-memory',
          target: target.uri,
          scope,
          expiresAt: createdAt + this.tokenTtlMs,
          revision: current.revision,
          preCommit: snapshot.commit,
          content: null,
          contentTruncated: false,
          beforeChars: current.text.length,
          afterChars: null,
          tagsBefore: null,
          tagsAfter: null,
          tagMode: null,
          confirmWord: target.fileName,
          session: null,
          summary: [
            `Delete ${target.uri} permanently`,
            `Revision ${shortHash(current.revision.sha256)} · ${current.revision.size} B`,
            `Pre-write snapshot ${shortHash(snapshot.commit)} makes this undoable while it is available.`,
            'No recycle bin: the file is removed in place, undo is a snapshot restore.',
          ],
        }),
      }
    }

    // set-tags
    const attrs = await this.options.api.fsAttrs(target.uri, actorPeerId === undefined ? {} : { actorPeerId })
    if (!attrs.ok) {
      const error = err(attrs.status === 404 ? 'not-found' : 'rejected-by-server', attrs.error ?? 'Could not read the tags.')
      this.auditDenied('set-tags', target.uri, request.sessionId ?? null, error)
      return { ok: false, error }
    }
    const tagsBefore = Array.isArray(attrs.result?.attrs?.tags)
      ? attrs.result.attrs.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    const requested = validateTags(request.tags)
    if ('error' in requested) {
      this.auditDenied('set-tags', target.uri, request.sessionId ?? null, requested.error)
      return { ok: false, error: requested.error }
    }
    const snapshot = await this.takeSnapshot('set-tags', target, actorPeerId)
    if ('error' in snapshot) {
      this.auditDenied('set-tags', target.uri, request.sessionId ?? null, snapshot.error)
      return { ok: false, error: snapshot.error }
    }
    this.tokens.set({
      ...base,
      curatable: target,
      revision: null,
      contentHash: null,
      preCommit: snapshot.commit,
      tagsBefore,
      requestedTags: request.tags === undefined ? null : requested.tags,
      tagMode: normalizeTagMode(request.tagMode, request.tags),
      confirmWord: null,
      facts: null,
    })
    this.recordPrepare()
    return {
      ok: true,
      ...this.preparePayload({
        token,
        action: 'set-tags',
        target: target.uri,
        scope,
        expiresAt: createdAt + this.tokenTtlMs,
        revision: null,
        preCommit: snapshot.commit,
        content: null,
        contentTruncated: false,
        beforeChars: null,
        afterChars: null,
        tagsBefore,
        tagsAfter: request.tags === undefined ? null : appliedTags(tagsBefore, requested.tags, normalizeTagMode(request.tagMode, request.tags)),
        tagMode: normalizeTagMode(request.tagMode, request.tags),
        confirmWord: null,
        session: null,
        summary: [
          `Set tags on ${target.uri}`,
          tagsBefore.length === 0 ? 'Current tags: none' : `Current tags: ${tagsBefore.join(', ')}`,
          `Pre-write snapshot ${shortHash(snapshot.commit)}.`,
        ],
      }),
    }
  }

  /** Step 2: consume the token, perform the write, verify, post-commit, audit. */
  async execute(request: ExecuteRequest): Promise<OveResult<WriteExecutePayload>> {
    if (this.mutationGate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or undo is already executing.') }
    }
    // Cheap token checks first: a rejected/cancelled/expired token — and above all
    // a token prepared for a *different action* — must write nothing, so they run
    // before any capability probe or server read (review B1 ordering).
    //
    // These settlement refusals (unknown/used/cancelled/expired token,
    // write-in-flight) are deliberately NOT audited: the token store already
    // constrains them, a double-click or an expired dialog is not a security
    // event, and logging every one would flood the local trail. Authorization
    // and policy denials — identity, curatable target, snapshot capability,
    // rate limits, crossed tokens — are audited.
    this.purge()
    const token = this.tokens.get(request.token)
    if (token === undefined) {
      // The token is unknown: expired entries are deleted by `purge()`, so this
      // is the honest "it was never valid (or it expired long ago)" answer.
      return { ok: false, error: err('token-expired', 'This confirmation token is unknown or expired.') }
    }
    if (token.status === 'cancelled') {
      return { ok: false, error: err('token-used', 'This confirmation was cancelled.') }
    }
    if (token.status === 'done' || token.status === 'undone' || token.status === 'failed') {
      return { ok: false, error: err('token-used', 'This confirmation was already used.') }
    }
    if (token.status === 'executing') {
      return { ok: false, error: err('write-in-flight', 'This confirmation is already executing.') }
    }
    if (this.now() > token.expiresAt) {
      this.tokens.delete(token.token)
      return { ok: false, error: err('token-expired', 'This confirmation expired; prepare the action again.') }
    }
    if (request.expectAction !== undefined && token.action !== request.expectAction) {
      const error = err(
        'invalid-request',
        `That token was prepared for ${token.action}, not ${request.expectAction}; nothing was written.`,
        { expected: request.expectAction, actual: token.action },
      )
      this.auditDenied(token.action, token.target, token.sessionId, error)
      return { ok: false, error }
    }

    const gate = await this.gateFromToken(request.token)
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
      this.auditDenied(token.action, token.target, token.sessionId, error)
      return { ok: false, error }
    }
    // The documented "three writes per minute" is enforced HERE, at execution
    // time (review round 2, N1): preparing several tokens does not let them
    // burst past it. A rate rejection keeps the token pending, so it remains
    // usable once the window rolls over.
    const rate = this.checkExecutionRate()
    if (rate !== null) {
      this.auditDenied(token.action, token.target, token.sessionId, rate)
      return { ok: false, error: rate }
    }
    // Re-check after the awaits above: a concurrent execute/undo may have claimed
    // the write path while this one was probing.
    if (this.mutationGate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or undo started while preparing this one.') }
    }
    // The shared v0.8 gate spans WriteService and OpsService.
    this.mutationGate.enter('write')
    token.status = 'executing'
    this.notify()
    try {
      const result =
        token.action === 'force-commit'
          ? await this.executeCommit(token)
          : token.action === 'edit-memory'
            ? await this.executeEdit(token, request)
            : token.action === 'delete-memory'
              ? await this.executeDelete(token, request)
              : await this.executeTags(token, request)
      // Only an execution that reached the server spends the rate budget
      // (review S2); a prepare, a cancel or a validation refusal does not.
      if (result.ok) this.executions.record()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      token.status = 'failed'
      token.settledAt = this.now()
      this.auditFailed(token, 'rejected-by-server', message)
      return { ok: false, error: err('rejected-by-server', message) }
    } finally {
      this.mutationGate.leave()
      this.notify()
    }
  }

  /** Step 3a: the undo dry-run plan (no mutation). */
  async plan(request: PlanRequest): Promise<OveResult<{ plan: WriteUndoPlan }>> {
    const record = this.undos.get(request.undoId)
    if (record === undefined) return { ok: false, error: err('undo-unavailable', 'No undo handle with that id (it may have expired).') }
    const scope = this.options.identity()
    if (scope.fingerprint !== record.identityFingerprint) {
      this.auditDenied('undo', record.target, record.sessionId, err('identity-changed', 'identity changed'))
      return {
        ok: false,
        error: err('identity-changed', 'This action was prepared under a different identity; switch back before undoing.', {
          action: record.action,
        }),
      }
    }
    if (record.action === 'set-tags') {
      const actorPeerId = this.options.actorPeer?.(record.sessionId ?? undefined)
      const stale = await this.isUndoStale(record, actorPeerId)
      return {
        ok: true,
        plan: {
          undoId: record.undoId,
          action: record.action,
          target: record.target,
          projectDir: '',
          sourceCommit: record.sourceCommit,
          toWrite: [],
          toDelete: [],
          unchanged: 0,
          // Tags are re-applied, not restored: a same-named tag list changed after
          // the action would be overwritten, so it takes the extra confirmation too.
          extraChanges: stale,
          tagsOnly: true,
        },
      }
    }
    const planned = await this.dryRunPlan(record)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, plan: planned.plan }
  }

  /**
   * Step 3b: apply the undo.
   *
   * A plan with extra changes needs `confirmExtra`; the refusal carries the plan
   * so the dialog can list exactly what else would be reverted. "Extra" includes
   * a same-named file rewritten after the action (review S1) — the revision this
   * action left behind is compared with the current one before applying.
   *
   * The `settling` flag makes undo exclusive with execute and with another undo
   * (review S5): it is set synchronously before the first mutation and cleared in
   * `finally`, so a failure never strands the write path.
   */
  async undo(request: UndoRequest): Promise<OveResult<WriteUndoPayload>> {
    // Settlement refusals below (unknown/expired handle, already undone,
    // write-in-flight) are deliberately unaudited: like the execute-side token
    // refusals, a double-click or a stale toast is not a security event and
    // auditing each one would flood the local trail. Identity/authorization
    // refusals are audited.
    if (this.mutationGate.busy) {
      return { ok: false, error: err('write-in-flight', 'A write or undo is already executing; wait for it to settle.') }
    }
    const record = this.undos.get(request.undoId)
    if (record === undefined) return { ok: false, error: err('undo-unavailable', 'No undo handle with that id (it may have expired).') }
    const guard = await this.gate(record.action, record.target, record.sessionId, record.action !== 'set-tags')
    if (guard !== null) return { ok: false, error: guard }
    if (record.undone) return { ok: false, error: err('token-used', 'This action was already undone.') }
    const scope = this.options.identity()
    if (scope.fingerprint !== record.identityFingerprint) {
      const error = err('identity-changed', 'Undo is refused after an identity switch; switch back to the original profile.')
      this.auditDenied('undo', record.target, record.sessionId, error)
      return { ok: false, error }
    }
    if (this.mutationGate.busy) {
      return { ok: false, error: err('write-in-flight', 'Another write or undo started while this undo was prepared.') }
    }
    this.mutationGate.enter('write')

    const actorPeerId = this.options.actorPeer?.(record.sessionId ?? undefined)
    try {
      if (record.action === 'set-tags') {
        if (await this.isUndoStale(record, actorPeerId) && request.confirmExtra !== true) {
          return {
            ok: false,
            error: err(
              'extra-changes',
              'The tags changed after this action; undoing would overwrite them. Confirm explicitly to continue.',
              { tagsOnly: true },
            ),
          }
        }
        const tags = record.tagsBefore ?? []
        const mode: 'clear' | 'replace' = tags.length === 0 ? 'clear' : 'replace'
        const applied = await this.options.api.setTags(record.target, tags, mode, actorPeerId === undefined ? {} : { actorPeerId })
        if (!applied.ok) {
          this.auditUndoFailed(record, applied.error ?? 'could not restore tags')
          return { ok: false, error: err('rejected-by-server', applied.error ?? 'Could not restore the previous tags.') }
        }
        record.undone = true
        const audit = this.options.audit.append({
          kind: 'undo',
          action: record.action,
          target: record.target,
          identity: this.identityFor(scope, record.sessionId),
          fingerprint: record.identityFingerprint,
          confirmation: 'overlay',
          preCommit: record.sourceCommit,
          postCommit: null,
          requestId: applied.requestId ?? null,
          result: 'undone',
          error: null,
          undo: null,
        })
        return {
          ok: true,
          undoId: record.undoId,
          action: record.action,
          target: record.target,
          outcome: 'tags-restored',
          newCommit: null,
          taskId: null,
          auditId: audit.id ?? '',
          warnings: [],
        }
      }

      const planned = await this.dryRunPlan(record)
      if ('error' in planned) return { ok: false, error: planned.error }
      if (planned.plan.extraChanges && request.confirmExtra !== true) {
        return {
          ok: false,
          error: err('extra-changes', 'The restore plan touches files this action did not change, or the file changed after it.', planned.plan),
        }
      }
      const applied = await this.options.api.snapshotRestore(record.projectDir, record.sourceCommit, {
        dryRun: false,
        message: `undo ${record.action} ${record.target}`,
        ...(actorPeerId === undefined ? {} : { actorPeerId }),
      })
      if (!applied.ok) {
        this.auditUndoFailed(record, applied.error ?? 'restore failed')
        return {
          ok: false,
          error: err(
            applied.status === 409 ? 'rejected-by-server' : 'not-supported',
            applied.error ?? 'The server refused the restore.',
          ),
        }
      }
      record.undone = true
      const newCommit = applied.result?.new_commit_oid ?? null
      const audit = this.options.audit.append({
        kind: 'undo',
        action: record.action,
        target: record.target,
        identity: this.identityFor(scope, record.sessionId),
        fingerprint: record.identityFingerprint,
        confirmation: 'overlay',
        preCommit: record.sourceCommit,
        postCommit: newCommit,
        requestId: applied.requestId ?? null,
        result: 'undone',
        error: null,
        undo: { kind: 'snapshot-restore', projectDir: record.projectDir, sourceCommit: record.sourceCommit },
      })
      return {
        ok: true,
        undoId: record.undoId,
        action: record.action,
        target: record.target,
        outcome: 'restored',
        newCommit,
        taskId: typeof applied.result?.task_id === 'string' ? applied.result.task_id : null,
        auditId: audit.id ?? '',
        warnings: [],
      }
    } finally {
      this.mutationGate.leave()
      this.notify()
    }
  }

  /* ---- per-action execution ------------------------------------------- */

  private async executeEdit(token: PendingWrite, request: ExecuteRequest): Promise<OveResult<WriteExecutePayload>> {
    const target = token.curatable
    if (target === null) return this.failToken(token, err('invalid-request', 'The token has no target.'))
    if (typeof request.content !== 'string') return this.keepToken(token, err('invalid-request', 'The edit needs the new body.'))
    if (request.content.length > WRITE_CONTENT_MAX_CHARS) {
      return this.keepToken(token, err('content-too-large', `The body is limited to ${WRITE_CONTENT_MAX_CHARS} characters.`))
    }
    const actorPeerId = this.options.actorPeer?.(token.sessionId ?? undefined)
    const current = await this.readRevision(target.uri, actorPeerId)
    if ('error' in current) return this.failToken(token, current.error)
    if (token.contentHash !== null && current.revision.sha256 !== token.contentHash) {
      return this.failToken(
        token,
        err('revision-mismatch', 'The file changed on the server since this dialog was opened; reload it.', {
          expected: token.revision,
          actual: current.revision,
        }),
      )
    }
    const written = await this.options.api.writeContent(target.uri, request.content, actorPeerId === undefined ? {} : { actorPeerId })
    if (!written.ok) {
      return this.failToken(
        token,
        err(
          written.status === 404 ? 'not-supported' : 'rejected-by-server',
          written.error ?? 'The server refused the write.',
        ),
      )
    }
    const verified = await this.verifyContent(target.uri, request.content, actorPeerId)
    const postCommit = await this.postCommit('edit-memory', target, actorPeerId)
    const revision = verified.revision ?? current.revision
    const writtenSha256 = `sha256:${createHash('sha256').update(request.content, 'utf8').digest('hex')}`
    const undo = this.recordUndo('edit-memory', target, token, writtenSha256, null)
    const audit = this.options.audit.append({
      kind: 'write',
      action: 'edit-memory',
      target: target.uri,
      identity: this.identityFor(this.options.identity(), token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: token.preCommit,
      postCommit,
      requestId: written.requestId ?? null,
      result: 'ok',
      error: null,
      undo: undo === null ? null : { kind: 'snapshot-restore', projectDir: undo.projectDir, sourceCommit: undo.sourceCommit },
    })
    token.status = 'done'
    token.settledAt = this.now()
    return {
      ok: true,
      action: 'edit-memory',
      target: target.uri,
      scope: this.options.identity(),
      auditId: audit.id ?? '',
      undoId: undo?.undoId ?? null,
      postCommit,
      requestId: written.requestId ?? null,
      taskId: null,
      task: null,
      revision,
      tags: null,
      verified: verified.verified,
      warnings: verified.verified ? [] : [{ code: 'verificationPending' }],
    }
  }

  private async executeDelete(token: PendingWrite, request: ExecuteRequest): Promise<OveResult<WriteExecutePayload>> {
    const target = token.curatable
    if (target === null) return this.failToken(token, err('invalid-request', 'The token has no target.'))
    if (token.origin !== 'command') {
      if (typeof request.typed !== 'string' || request.typed.trim().length === 0) {
        return this.keepToken(token, err('typed-confirmation-required', 'Type the file name to confirm the delete.'))
      }
      if (request.typed.trim() !== token.confirmWord) {
        return this.keepToken(token, err('typed-confirmation-mismatch', 'The typed file name does not match.'))
      }
    }
    const actorPeerId = this.options.actorPeer?.(token.sessionId ?? undefined)
    const current = await this.readRevision(target.uri, actorPeerId)
    if ('error' in current) return this.failToken(token, current.error)
    if (token.contentHash !== null && current.revision.sha256 !== token.contentHash) {
      return this.failToken(
        token,
        err('revision-mismatch', 'The file changed on the server since this dialog was opened; reload it.', {
          expected: token.revision,
          actual: current.revision,
        }),
      )
    }
    const deleted = await this.options.api.deletePath(target.uri, {
      recursive: false,
      ...(actorPeerId === undefined ? {} : { actorPeerId }),
    })
    if (!deleted.ok) {
      return this.failToken(
        token,
        err(deleted.status === 404 && deleted.errorCode === null ? 'not-supported' : 'rejected-by-server', deleted.error ?? 'The server refused the delete.'),
      )
    }
    // Verify the file is gone: an idempotent delete answers 200 even for a
    // missing path, so the confirmation must come from the read. Only a 404
    // *proves* absence (review S6); a 403/500/timeout leaves verification
    // pending rather than reporting a success the plugin cannot see.
    let verified = false
    for (let attempt = 0; attempt < 3 && !verified; attempt += 1) {
      if (attempt > 0) await sleep(250)
      const stat = await this.options.api.fsStat(target.uri, actorPeerId === undefined ? {} : { actorPeerId })
      if (!stat.ok && stat.status === 404) verified = true
    }
    const postCommit = await this.postCommit('delete-memory', target, actorPeerId)
    const undo = this.recordUndo('delete-memory', target, token, null, null)
    const audit = this.options.audit.append({
      kind: 'write',
      action: 'delete-memory',
      target: target.uri,
      identity: this.identityFor(this.options.identity(), token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: token.preCommit,
      postCommit,
      requestId: deleted.requestId ?? null,
      result: 'ok',
      error: null,
      undo: undo === null ? null : { kind: 'snapshot-restore', projectDir: undo.projectDir, sourceCommit: undo.sourceCommit },
    })
    token.status = 'done'
    token.settledAt = this.now()
    return {
      ok: true,
      action: 'delete-memory',
      target: target.uri,
      scope: this.options.identity(),
      auditId: audit.id ?? '',
      undoId: undo?.undoId ?? null,
      postCommit,
      requestId: deleted.requestId ?? null,
      taskId: null,
      task: null,
      revision: null,
      tags: null,
      verified,
      warnings: verified ? [] : [{ code: 'verificationPending' }],
    }
  }

  private async executeTags(token: PendingWrite, request: ExecuteRequest): Promise<OveResult<WriteExecutePayload>> {
    const target = token.curatable
    if (target === null) return this.failToken(token, err('invalid-request', 'The token has no target.'))
    const requested = request.tags ?? token.requestedTags ?? []
    const validated = validateTags(requested)
    if ('error' in validated) return this.keepToken(token, validated.error)
    const tags = validated.tags
    const mode = resolveTagMode(request.tagMode ?? token.tagMode, tags)
    const actorPeerId = this.options.actorPeer?.(token.sessionId ?? undefined)
    const written = await this.options.api.setTags(target.uri, tags, mode, actorPeerId === undefined ? {} : { actorPeerId })
    if (!written.ok) {
      return this.failToken(
        token,
        err(written.status === 400 ? 'rejected-by-server' : 'rejected-by-server', written.error ?? 'The server refused the tag update.', {
          // 0.5.3 gates tags by namespace: surface the server's own message, it
          // is the only place that fact exists.
          namespace: written.error,
        }),
      )
    }
    const expected =
      mode === 'append' && token.tagsBefore !== null
        ? [...new Set([...token.tagsBefore, ...tags])]
        : mode === 'clear'
          ? []
          : tags
    const readBack = await this.verifyTags(target.uri, expected, actorPeerId)
    const postCommit = await this.postCommit('set-tags', target, actorPeerId)
    // Tags are not file content: undo re-applies the captured list. The list the
    // action set is recorded so a later tag edit can be noticed at undo time.
    const undo = this.recordTagsUndo(target, token, readBack ?? expected)
    const audit = this.options.audit.append({
      kind: 'write',
      action: 'set-tags',
      target: target.uri,
      identity: this.identityFor(this.options.identity(), token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: token.preCommit,
      postCommit,
      requestId: written.requestId ?? null,
      result: 'ok',
      error: null,
      undo: { kind: 'tags-reapply', projectDir: '', sourceCommit: token.preCommit ?? '' },
    })
    token.status = 'done'
    token.settledAt = this.now()
    return {
      ok: true,
      action: 'set-tags',
      target: target.uri,
      scope: this.options.identity(),
      auditId: audit.id ?? '',
      undoId: undo.undoId,
      postCommit,
      requestId: written.requestId ?? null,
      taskId: null,
      task: null,
      revision: null,
      tags: readBack ?? tags,
      verified: readBack !== null,
      warnings: readBack === null ? [{ code: 'verificationPending' }] : [],
    }
  }

  private async executeCommit(token: PendingWrite): Promise<OveResult<WriteExecutePayload>> {
    const sessionId = token.target
    const outcome = await this.options.sessions.forceCommit(sessionId)
    const scope = this.options.identity()
    if (!outcome.ok) {
      token.status = 'failed'
      token.settledAt = this.now()
      const error = err(
        outcome.code === 'not-supported' ? 'not-supported' : 'rejected-by-server',
        outcome.message ?? 'The commit failed.',
        { reason: outcome.code },
      )
      this.auditCommit(token, scope, 'failed', null, error.message)
      return { ok: false, error }
    }
    const audit = this.auditCommit(token, scope, 'ok', outcome.taskId, null)
    token.status = 'done'
    token.settledAt = this.now()
    return {
      ok: true,
      action: 'force-commit',
      target: sessionId,
      scope,
      auditId: audit.id ?? '',
      undoId: null,
      postCommit: null,
      requestId: null,
      taskId: outcome.taskId,
      task: outcome.task === null ? null : mapTask(outcome.task),
      revision: null,
      tags: null,
      verified: true,
      warnings: outcome.warnings,
    }
  }

  /* ---- helpers --------------------------------------------------------- */

  private preparePayload(input: WritePreparePayload): WritePreparePayload {
    return input
  }

  private async gate(
    action: string,
    target: string,
    sessionId: string | null,
    requireSnapshot = false,
  ): Promise<OveError | null> {
    return this.gateCore(action, target, sessionId, requireSnapshot)
  }

  private async gateFromToken(tokenValue: string): Promise<OveError | null> {
    // Gating an execute does not repeat the capability probe's snapshot check:
    // the token already proved it at prepare time, and the identity check below
    // covers the switch case. The master switch/transport are cheap and live.
    if (!this.options.writesEnabled()) return err('writes-disabled', 'Writes are disabled (enableWrites is off).')
    if (!this.options.transport()) return err('transport-unavailable', 'Writes need the DSH 0.2.2-rc.1 connection transport.')
    const scope = this.options.identity()
    if (scope.fingerprint.length === 0) return err('identity-ambiguous', 'The active identity is unknown; writes are refused.')
    // A token that is unknown at this point is answered by `execute`, not here.
    const token = this.tokens.get(tokenValue)
    if (token !== undefined) {
      const snapshot = await this.options.capabilities.probe()
      if (!snapshot.health.ok) return err('profile-unhealthy', snapshot.health.error ?? 'The active profile is not healthy.')
    }
    return null
  }

  private async gateCore(action: string, target: string, sessionId: string | null, requireSnapshot: boolean): Promise<OveError | null> {
    if (!this.options.writesEnabled()) {
      const error = err('writes-disabled', 'Writes are disabled (enableWrites is off).')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    if (!this.options.transport()) {
      const error = err('transport-unavailable', 'Writes need the DSH 0.2.2-rc.1 connection transport.')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    const scope = this.options.identity()
    if (scope.fingerprint.length === 0) {
      const error = err('identity-ambiguous', 'The active identity is unknown; writes are refused.')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    const snapshot = await this.options.capabilities.probe()
    if (!snapshot.health.ok) {
      const error = err('profile-unhealthy', snapshot.health.error ?? 'The active profile is not healthy.')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    if (snapshot.health.authMode === null) {
      const error = err('identity-ambiguous', 'The server did not report an auth mode, so the identity is ambiguous; writes are refused.')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    if (requireSnapshot && !snapshot.snapshot.available) {
      const error = err('snapshot-unavailable', 'This server has no snapshot capability, so edits and deletes are disabled.')
      this.auditDenied(action, target, sessionId, error)
      return error
    }
    return null
  }

  private async readRevision(
    uri: string,
    actorPeerId: string | undefined,
  ): Promise<{ text: string; revision: WriteRevision } | { error: OveError }> {
    const [text, stat] = await Promise.all([
      this.options.api.readText(uri, actorPeerId === undefined ? {} : { actorPeerId }),
      this.options.api.fsStat(uri, actorPeerId === undefined ? {} : { actorPeerId }),
    ])
    if (!text.ok || text.result === null) {
      return {
        error: err(
          text.status === 404 ? 'not-found' : 'rejected-by-server',
          text.error ?? 'The file could not be read.',
        ),
      }
    }
    const body = text.result
    const sha256 = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
    return {
      text: body,
      revision: {
        sha256,
        size: stat.result?.size ?? Buffer.byteLength(body, 'utf8'),
        modifiedAt: stat.result?.modTime ?? null,
      },
    }
  }

  private async takeSnapshot(
    action: WriteAction,
    target: CuratableTarget,
    actorPeerId: string | undefined,
  ): Promise<{ commit: string } | { error: OveError }> {
    const paths = snapshotPathsFor(snapshotAction(action), target)
    const response = await this.options.api.snapshotCommit(
      `pre-write: ${action} ${target.uri}`,
      paths,
      actorPeerId === undefined ? {} : { actorPeerId },
    )
    const commit = response.result?.commit_oid
    if (!response.ok || typeof commit !== 'string' || commit.length === 0) {
      // Fail closed: no pre-write commit_oid means no undo handle, so the write
      // is not offered at all (binding decision C).
      return {
        error: err(
          'snapshot-unavailable',
          `The pre-write snapshot failed, so the ${action} is refused (fail closed). ${response.error ?? ''}`.trim(),
          { paths },
        ),
      }
    }
    return { commit }
  }

  private async postCommit(
    action: WriteAction,
    target: CuratableTarget,
    actorPeerId: string | undefined,
  ): Promise<string | null> {
    const response = await this.options.api.snapshotCommit(
      `post-write: ${action} ${target.uri}`,
      snapshotPathsFor(snapshotAction(action), target),
      actorPeerId === undefined ? {} : { actorPeerId },
    )
    // Best effort by design: the write already happened and is verified; a failed
    // post-commit only means the next snapshot diff will include the change.
    return response.ok ? response.result?.commit_oid ?? null : null
  }

  private async verifyContent(
    uri: string,
    expected: string,
    actorPeerId: string | undefined,
  ): Promise<{ verified: boolean; revision: WriteRevision | null }> {
    // The write API is asynchronous on the server side, but content is committed
    // synchronously before the response; three short retries cover a transient
    // read lag without ever retrying the write itself.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(250)
      const read = await this.options.api.readText(uri, actorPeerId === undefined ? {} : { actorPeerId })
      if (!read.ok || read.result === null) continue
      const sha256 = `sha256:${createHash('sha256').update(read.result, 'utf8').digest('hex')}`
      if (read.result === expected) {
        return { verified: true, revision: { sha256, size: Buffer.byteLength(read.result, 'utf8'), modifiedAt: null } }
      }
    }
    return { verified: false, revision: null }
  }

  private async verifyTags(
    uri: string,
    expected: string[],
    actorPeerId: string | undefined,
  ): Promise<string[] | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(250)
      const attrs = await this.options.api.fsAttrs(uri, actorPeerId === undefined ? {} : { actorPeerId })
      if (!attrs.ok) continue
      const tags = Array.isArray(attrs.result?.attrs?.tags)
        ? attrs.result.attrs.tags.filter((tag): tag is string => typeof tag === 'string')
        : []
      if (sameTags(tags, expected)) return tags
    }
    return null
  }

  private recordUndo(
    action: 'edit-memory' | 'delete-memory',
    target: CuratableTarget,
    token: PendingWrite,
    writtenSha256: string | null,
    tagsAfter: string[] | null,
  ): { undoId: string; projectDir: string; sourceCommit: string } | null {
    if (token.preCommit === null) return null
    const undo: UndoRecord = {
      undoId: randomBytes(16).toString('hex'),
      action,
      target: target.uri,
      curatable: target,
      projectDir: restoreScopeFor(target),
      sourceCommit: token.preCommit,
      identityFingerprint: token.identityFingerprint,
      tagsBefore: null,
      writtenSha256,
      tagsAfter,
      sessionId: token.sessionId,
      createdAt: this.now(),
      undone: false,
    }
    this.rememberUndo(undo)
    return { undoId: undo.undoId, projectDir: undo.projectDir, sourceCommit: undo.sourceCommit }
  }

  private recordTagsUndo(target: CuratableTarget, token: PendingWrite, tagsAfter: string[]): { undoId: string } {
    const undo: UndoRecord = {
      undoId: randomBytes(16).toString('hex'),
      action: 'set-tags',
      target: target.uri,
      curatable: target,
      // Tags are re-applied, not restored from a file; the scope stays empty on
      // purpose so a plan cannot pretend to be a snapshot restore.
      projectDir: '',
      sourceCommit: token.preCommit ?? '',
      identityFingerprint: token.identityFingerprint,
      tagsBefore: token.tagsBefore,
      writtenSha256: null,
      tagsAfter,
      sessionId: token.sessionId,
      createdAt: this.now(),
      undone: false,
    }
    this.rememberUndo(undo)
    return { undoId: undo.undoId }
  }

  private rememberUndo(undo: UndoRecord): void {
    this.undos.set(undo.undoId, undo)
    // Bound the in-memory undo window: it is deliberately not persisted, so a
    // reload loses it and a long session cannot grow it without limit. Map
    // iteration order is insertion order, so the first key is the oldest handle.
    while (this.undos.size > 24) {
      const { value } = this.undos.keys().next()
      if (value === undefined) break
      this.undos.delete(value)
    }
  }

  /** The current tag list of a target, or null when it cannot be read. */
  private async currentTags(uri: string, actorPeerId: string | undefined): Promise<string[] | null> {
    const attrs = await this.options.api.fsAttrs(uri, actorPeerId === undefined ? {} : { actorPeerId })
    if (!attrs.ok) return null
    return Array.isArray(attrs.result?.attrs?.tags)
      ? attrs.result.attrs.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
  }

  /**
   * Whether the target changed after this action wrote it (review S1).
   *
   * Undo is a directory-scoped snapshot restore, so without this check a
   * same-named file rewritten after the action would be rolled back silently.
   * A changed/unreadable target marks the plan `extraChanges`, which requires the
   * user's second explicit confirmation before the restore is applied.
   *
   *  - edit: the file must still hold the body this action wrote;
   *  - delete: the file must still be absent (a recreated file would be
   *    overwritten by the restore);
   *  - tags: the list must still be the one this action set.
   */
  private async isUndoStale(record: UndoRecord, actorPeerId: string | undefined): Promise<boolean> {
    if (record.action === 'set-tags') {
      const current = await this.currentTags(record.target, actorPeerId)
      if (current === null) return true
      return !sameTags(current, record.tagsAfter ?? [])
    }
    if (record.action === 'delete-memory') {
      const stat = await this.options.api.fsStat(record.target, actorPeerId === undefined ? {} : { actorPeerId })
      // 404 is the expected state after a successful delete; anything else means
      // the path is back (or cannot be read, which is not provably the same).
      return !(!stat.ok && stat.status === 404)
    }
    if (record.writtenSha256 === null) return true
    const current = await this.readRevision(record.target, actorPeerId)
    if ('error' in current) return true
    return current.revision.sha256 !== record.writtenSha256
  }

  private async dryRunPlan(record: UndoRecord): Promise<{ plan: WriteUndoPlan } | { error: OveError }> {
    const actorPeerId = this.options.actorPeer?.(record.sessionId ?? undefined)
    const response = await this.options.api.snapshotRestore(record.projectDir, record.sourceCommit, {
      dryRun: true,
      ...(actorPeerId === undefined ? {} : { actorPeerId }),
    })
    if (!response.ok) {
      return {
        error: err(
          response.status === 404 ? 'not-supported' : 'rejected-by-server',
          response.error ?? 'The undo dry run failed.',
        ),
      }
    }
    const diff = response.result?.diff
    const toWrite = (diff?.to_write ?? []).map((entry) => this.planPath(entry.path, record.target))
    const toDelete = (diff?.to_delete ?? []).map((entry) => this.planPath(entry.path, record.target))
    // A path outside the action's own inverse set *or* a target rewritten after
    // the action both mean the second confirmation is required (review S1).
    const stale = await this.isUndoStale(record, actorPeerId)
    return {
      plan: {
        undoId: record.undoId,
        action: record.action,
        target: record.target,
        projectDir: record.projectDir,
        sourceCommit: record.sourceCommit,
        toWrite,
        toDelete,
        unchanged: Array.isArray(diff?.unchanged) ? diff.unchanged.length : 0,
        extraChanges: stale || [...toWrite, ...toDelete].some((entry) => !entry.expected),
        tagsOnly: false,
      },
    }
  }

  /**
   * Whether one restore-plan path is the action's own inverse.
   *
   * The scope is the file's parent directory, so the only expected path is the
   * file itself. A plan path may be relative to the scope (`tools.md`) or a full
   * URI depending on the server build; comparing the basename covers both and
   * errs on the side of "unexpected" for anything else.
   */
  private planPath(raw: string | undefined, target: string): UndoPlanPath {
    const path = typeof raw === 'string' ? raw : ''
    const expectedName = target.slice(target.lastIndexOf('/') + 1)
    const planName = path.slice(path.lastIndexOf('/') + 1)
    return { path, expected: planName === expectedName }
  }

  /** Record one successful snapshot-creating prepare (N2 quota). */
  private recordPrepare(): void {
    this.prepares.record()
  }

  private checkExecutionRate(): OveError | null {
    const decision = this.executions.check()
    if (decision.ok) return null
    return err(
      'rate-limited',
      `At most ${decision.limit} writes per minute; try again in ${Math.ceil(decision.retryAfterMs / 1000)}s.`,
      { kind: 'execute', retryAfterMs: decision.retryAfterMs, limit: decision.limit },
    )
  }

  private checkPrepareQuota(): OveError | null {
    const decision = this.prepares.check()
    if (decision.ok) return null
    return err(
      'rate-limited',
      `At most ${decision.limit} confirmations per minute (each one takes a snapshot); try again in ${Math.ceil(decision.retryAfterMs / 1000)}s.`,
      { kind: 'prepare', retryAfterMs: decision.retryAfterMs, limit: decision.limit },
    )
  }

  private purge(): void {
    this.tokens.purge()
  }

  /**
   * A validation-only refusal (a mistyped name, an invalid tag) keeps the token
   * usable: the confirmation itself is still valid and the user should be able
   * to correct the input. The refusal is audited as a denied attempt.
   */
  private keepToken(token: PendingWrite, error: OveError): { ok: false; error: OveError } {
    token.status = 'pending'
    this.auditDenied(token.action, token.target, token.sessionId, error)
    this.notify()
    return { ok: false, error }
  }

  private failToken(token: PendingWrite, error: OveError): { ok: false; error: OveError } {
    token.status = 'failed'
    token.settledAt = this.now()
    this.auditFailed(token, error.code, error.message)
    return { ok: false, error }
  }

  private auditFailed(token: PendingWrite, code: string, message: string): void {
    const kind: AuditKind = token.action === 'force-commit' ? 'commit' : 'write'
    this.options.audit.append({
      kind,
      action: token.action,
      target: token.target,
      identity: this.identityFor(this.options.identity(), token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: token.preCommit,
      postCommit: null,
      requestId: null,
      result: 'failed',
      error: `${code}: ${message}`,
      undo: null,
    })
  }

  private auditCommit(
    token: PendingWrite,
    scope: IdentityScope,
    result: 'ok' | 'failed',
    taskId: string | null,
    error: string | null,
  ): { id: string | null } {
    return this.options.audit.append({
      kind: 'commit',
      action: 'force-commit',
      target: token.target,
      identity: this.identityFor(scope, token.sessionId),
      fingerprint: token.identityFingerprint,
      confirmation: token.origin,
      preCommit: null,
      postCommit: null,
      requestId: null,
      result,
      error: error === null ? null : `${error}${taskId === null ? '' : ` · task ${taskId}`}`,
      undo: null,
    })
  }

  private auditDenied(action: string, target: string, sessionId: string | null, error: OveError): void {
    this.options.audit.append({
      kind: 'denied',
      action,
      target,
      identity: this.identityFor(this.options.identity(), sessionId),
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

  private auditUndoFailed(record: UndoRecord, message: string): void {
    this.options.audit.append({
      kind: 'undo',
      action: record.action,
      target: record.target,
      identity: this.identityFor(this.options.identity(), record.sessionId),
      fingerprint: record.identityFingerprint,
      confirmation: 'overlay',
      preCommit: record.sourceCommit,
      postCommit: null,
      requestId: null,
      result: 'failed',
      error: message,
      undo: null,
    })
  }

  private identityFor(scope: IdentityScope, sessionId: string | null): AuditIdentity {
    return {
      profileId: scope.profileId,
      endpoint: scope.endpoint,
      authMode: scope.authMode,
      account: scope.account,
      user: scope.user,
      peer: scope.peer,
      dshSessionId: sessionId,
    }
  }

  private notify(): void {
    try {
      this.options.onStateChange?.()
    } catch {
      // A subscriber must not be able to break a write.
    }
  }
}

/** `sha256:abcdef…` → `sha256:abcdef…` with the first 12 hex chars shown. */
export function shortHash(value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  return `sha256:${hex.slice(0, 12)}…`
}

/** Validate a requested tag list with the shared grammar; host-side codes. */
export function validateTags(input: unknown): { tags: string[] } | { error: OveError } {
  if (input === undefined || input === null) return { tags: [] }
  if (!Array.isArray(input)) return { error: err('invalid-tags', 'Tags must be an array of key=value strings.') }
  if (input.length > TAG_MAX) return { error: err('invalid-tags', `At most ${TAG_MAX} tags are allowed.`) }
  const tags: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') return { error: err('invalid-tags', 'Every tag must be a string.') }
    const validation = validateTagInput(entry)
    if (!validation.ok) {
      return { error: err('invalid-tags', `Invalid tag "${entry.slice(0, 40)}"; expected key=value with no spaces.`) }
    }
    if (!tags.includes(validation.tag)) tags.push(validation.tag)
  }
  return { tags }
}

/** Order-insensitive tag comparison for the read-back check. */
function sameTags(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((tag, index) => tag === b[index])
}

/** A requested tag mode, or the one implied by the requested list. */
function normalizeTagMode(mode: 'replace' | 'append' | 'clear' | undefined, tags: string[] | undefined): 'replace' | 'append' | 'clear' {
  if (mode === 'append' || mode === 'clear' || mode === 'replace') return mode
  return tags !== undefined && tags.length === 0 ? 'clear' : 'replace'
}

/** The mode one execution uses: an explicit request wins, then the token's mode. */
function resolveTagMode(mode: 'replace' | 'append' | 'clear' | null, tags: string[]): 'replace' | 'append' | 'clear' {
  if (mode === 'append' || mode === 'clear' || mode === 'replace') return mode
  return tags.length === 0 ? 'clear' : 'replace'
}

/** The tag list a confirmation dialog shows for the requested mode. */
function appliedTags(before: string[], requested: string[], mode: 'replace' | 'append' | 'clear'): string[] {
  if (mode === 'clear') return []
  if (mode === 'append') return [...new Set([...before, ...requested])]
  return requested
}

/** Narrow a write action to the three snapshot-backed ones (prepared tokens only). */
function snapshotAction(action: WriteAction): 'edit-memory' | 'delete-memory' | 'set-tags' {
  return action === 'delete-memory' || action === 'set-tags' ? action : 'edit-memory'
}

function err(code: string, message: string, details?: unknown): OveError {
  return details === undefined ? { code, message } : { code, message, details }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

