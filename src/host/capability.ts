/**
 * Profile-keyed capability probe.
 *
 * Every gate in v0.5 is a runtime probe, never a version comparison: the tested
 * server range is 0.5.1.1–0.5.3, 0.5.2 is unverified and 0.5.4 exists, so
 * "which build is this" would be a guess. The guesses are replaced by read-only
 * probes whose answers the scope route and the write service consume:
 *
 *   health     — always available; everything else degrades around it
 *   identity   — `/health` `auth_mode` (plus role/account/user when credentialed)
 *   snapshot   — `GET /snapshot/log?limit=1`: 200 = history, 404 with
 *                `details.type === "git_ref"` = feature present but no commits
 *   tasks      — `GET /tasks?limit=1`
 *   acl        — never probed by default: it needs `manage` on a resource and is
 *                inert on most installs. The UI shows an explicit "not enabled"
 *                state instead of shipping a button that always 403s.
 *
 * Snapshot capability is the load-bearing one for curation: without it, edit and
 * delete fail closed (tags stay available because they are not file content).
 * The probe result is cached briefly because scope prompts/Dialogs read it
 * repeatedly; a profile switch or `fresh=1` invalidates it.
 */
import type { ScopeCapability } from '../shared/protocol.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import { classifyRuleProbe, type RuleSearchCapability } from './catalog-service.ts'
import { PACK_CAPABILITY_TTL_MS, RULES_CAPABILITY_TTL_MS, STATUS_TIMEOUT_MS } from '../shared/limits.ts'

/** The health facts the scope banner shows, secret-free. */
export interface HealthFacts {
  ok: boolean
  version: string | null
  authMode: string | null
  role: string | null
  accountId: string | null
  userId: string | null
  latencyMs: number
  error: string | null
}

/** The snapshot capability answer, with the probe-derived kind for diagnostics. */
export interface SnapshotCapability extends ScopeCapability {
  kind: 'history' | 'no-history' | 'route-absent' | 'denied' | 'unknown'
}

/**
 * v0.8: the compile capability answer.
 *
 * The runtime answer decides, never the version: `configured && can_create`
 * gates the trigger, and the server's own reason code (`NOT_CONFIGURED`,
 * `API_KEY_REQUIRED`, …) is surfaced verbatim instead of a generic failure.
 */
export interface CompileCapability extends ScopeCapability {
  configured: boolean
  canCreate: boolean
  reason: string | null
  /** `capabilities` | `route-absent` | `denied` | `profile-unhealthy` | `unknown`. */
  kind: 'capabilities' | 'route-absent' | 'denied' | 'profile-unhealthy' | 'unknown'
}

export interface CapabilitySnapshot {
  /** Epoch milliseconds when this snapshot was taken. */
  observedAt: number
  health: HealthFacts
  snapshot: SnapshotCapability
  tasks: ScopeCapability
  /**
   * The cheap `rules/search` route probe (S2). Cached for
   * {@link RULES_CAPABILITY_TTL_MS}: a rule-route answer changes only when the
   * server build changes, not between panel opens.
   */
  rules: RuleSearchCapability
  /* ---- v0.8 runtime-probed F13 gates (never version comparisons) ---------- */
  compile: CompileCapability
  /** 0.5.3-only per-file version history (`/snapshot/versions`). */
  versions: ScopeCapability
  /** 0.5.3-only changed-path list (`/snapshot/diff-paths`). */
  diffPaths: ScopeCapability
}

export interface CapabilityOptions {
  api: OpenVikingApi
  /** Whether the authenticated mutation transport is present (writes gate). */
  transport: () => boolean
  cacheTtlMs?: number
  /** How long one rules-route probe is trusted (default S2's 10 minutes). */
  rulesCacheTtlMs?: number
  now?: () => number
}

/** The design's gate name for a capability, used as the map key in `/scope`. */
export const CAPABILITY_NAMES = ['health', 'identity', 'snapshot', 'tasks', 'rules', 'acl', 'mutation-transport'] as const

function unavailable(detail: string, kind: SnapshotCapability['kind'] = 'unknown'): SnapshotCapability {
  return { available: false, detail, kind }
}

export class CapabilityService {
  private readonly options: CapabilityOptions
  private readonly cacheTtlMs: number
  private readonly rulesCacheTtlMs: number
  private readonly now: () => number
  private cached: CapabilitySnapshot | null = null
  private inflight: Promise<CapabilitySnapshot> | null = null
  /**
   * v0.8: pack export is probed lazily (validation-only POST) because the
   * prepare path is the first thing that needs it; never at startup.
   */
  private packCached: ScopeCapability & { kind?: string } | null = null
  private packObservedAt = 0
  private packInflight: Promise<ScopeCapability & { kind?: string }> | null = null
  private rulesCached: RuleSearchCapability | null = null
  private rulesObservedAt = 0
  private rulesInflight: Promise<RuleSearchCapability> | null = null
  /**
   * Monotonic identity generation. A probe started before `invalidate()` may
   * still resolve afterwards; caching that answer would bind the previous
   * identity's probes into the new cache for the whole TTL, so every cache
   * write checks it is still the current generation.
   */
  private generation = 0

  constructor(options: CapabilityOptions) {
    this.options = options
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000
    this.rulesCacheTtlMs = options.rulesCacheTtlMs ?? RULES_CAPABILITY_TTL_MS
    this.now = options.now ?? Date.now
  }

  /** Forget the probe; called on a profile switch and by a `fresh=1` read. */
  invalidate(): void {
    this.generation += 1
    this.cached = null
    // Drop in-flight handles too: a caller that arrives after the switch must
    // start a probe for the new identity, not await the previous one's answer.
    this.inflight = null
    this.rulesCached = null
    this.rulesObservedAt = 0
    this.rulesInflight = null
    this.packCached = null
    this.packObservedAt = 0
  }

  /**
   * v0.8: the pack-export capability, probed lazily and cached briefly.
   *
   * The probe is a validation-only `POST /pack/export {}` (the required `uri`
   * fails before any export): 400/422 = route present, 404 = absent, 401/403 =
   * present but this identity/deployment cannot export. Cancelled by nothing —
   * it is one cheap request, only issued when the Packs tab or a pack prepare
   * asks for it.
   */
  async pack(fresh = false): Promise<ScopeCapability & { kind?: string }> {
    if (!fresh && this.packCached !== null && this.now() - this.packObservedAt < PACK_CAPABILITY_TTL_MS) {
      return this.packCached
    }
    if (this.packInflight !== null) return this.packInflight
    this.packInflight = this.options.api
      // The probe is a cheap validation request: give it the 5 s status budget,
      // not the 120 s export-stream default, so an offline/hung network cannot
      // stall every prepare/execute/Packs open behind it.
      .streamPackExport('', false, { timeoutMs: STATUS_TIMEOUT_MS })
      .then((reply) => {
        // A streaming method cannot be used for a validation probe without
        // consuming its body; the service classifies status codes only.
        const answer = classifyPackProbe(reply.status, reply.error ?? null)
        // A transport error (status 0) is not an answer: caching it would keep
        // the Packs tab disabled for 10 minutes after a transient outage. Retry
        // fresh on the next caller; only definitive answers are cached.
        if (reply.status !== 0) {
          this.packCached = answer
          this.packObservedAt = this.now()
        }
        return answer
      })
      .finally(() => {
        this.packInflight = null
      })
    return this.packInflight
  }

  /**
   * The cached rules-route capability, probing with the validation-only empty
   * body only when stale.
   *
   * This is the S2 answer the Rules section uses: it never runs a rule search,
   * and a 10-minute cache keeps opening the section free even when the scope
   * prompt has not been opened.
   */
  async rules(fresh = false): Promise<RuleSearchCapability> {
    if (!fresh && this.rulesCached !== null && this.now() - this.rulesObservedAt < this.rulesCacheTtlMs) {
      return this.rulesCached
    }
    if (this.rulesInflight !== null) return this.rulesInflight
    const generation = this.generation
    const probe = this.options.api
      .probeRuleSearchRoute()
      .then((reply) => {
        const capability = classifyRuleProbe(reply)
        // Only the current identity may populate the cache; a probe that raced
        // an `invalidate()` returns its answer to its own caller but is not
        // trusted for the new identity's TTL window.
        if (this.generation === generation) {
          this.rulesCached = capability
          this.rulesObservedAt = this.now()
        }
        return capability
      })
      .finally(() => {
        // Never clear a newer probe's handle: after invalidate() + a new call,
        // this old promise finishing must not make the next caller re-probe.
        if (this.rulesInflight === probe) this.rulesInflight = null
      })
    this.rulesInflight = probe
    return probe
  }

  /**
   * The cached probe without awaiting one.
   *
   * The identity fingerprint reads the probed auth mode synchronously; a null
   * answer means "not probed yet", which the fingerprint hashes as null rather
   * than guessing (a later probe that changes the answer changes the identity,
   * and an undo across that change is refused).
   */
  lastSnapshot(): CapabilitySnapshot | null {
    return this.cached
  }

  /** The current snapshot, probing when stale. Never throws. */
  async probe(fresh = false): Promise<CapabilitySnapshot> {
    if (!fresh && this.cached !== null && this.now() - this.cached.observedAt < this.cacheTtlMs) {
      return this.cached
    }
    if (this.inflight !== null) return this.inflight
    const generation = this.generation
    const probe = this.probeUncached(generation).finally(() => {
      if (this.inflight === probe) this.inflight = null
    })
    this.inflight = probe
    return probe
  }

  private async probeUncached(generation: number): Promise<CapabilitySnapshot> {
    const started = this.now()
    const health = await this.options.api.health()
    // An unreachable server answers the other probes with the same timeout, so a
    // dead endpoint would make `/scope` take health+snapshot+tasks timeouts before
    // rendering. Health failing means the answer is already known: degrade now.
    if (!health.ok) {
      const result: CapabilitySnapshot = {
        observedAt: this.now(),
        health: {
          ok: false,
          version: health.version,
          authMode: health.authMode,
          role: health.role,
          accountId: health.accountId,
          userId: health.userId,
          latencyMs: this.now() - started,
          error: health.error,
        },
        snapshot: unavailable('profile-unhealthy'),
        tasks: { available: false, detail: 'profile-unhealthy' },
        rules: { available: true, detail: 'profile-unhealthy', kind: 'unknown' },
        compile: {
          available: false,
          detail: 'profile-unhealthy',
          configured: false,
          canCreate: false,
          reason: null,
          kind: 'profile-unhealthy',
        },
        versions: { available: false, detail: 'profile-unhealthy' },
        diffPaths: { available: false, detail: 'profile-unhealthy' },
      }
      if (this.generation === generation) this.cached = result
      return result
    }
    // The two capability probes are independent reads; run them together so the
    // current scope prompt pays one round trip, not two.
    const staleness = this.rulesCached !== null && this.now() - this.rulesObservedAt < this.rulesCacheTtlMs
    const [snapshotResult, tasksResult, rules, compileResult, versionsResult, diffPathsResult] = await Promise.all([
      this.options.api.snapshotLog({ limit: 1 }),
      this.options.api.listTasks({ limit: 1 }),
      staleness ? Promise.resolve(this.rulesCached as RuleSearchCapability) : this.rules(),
      this.options.api.compileCapabilities(),
      // 0.5.3-only routes: the missing-required-parameter answer is the probe
      // (400 = present, 404 = absent). Both are cheap GETs.
      this.options.api.snapshotVersionsProbe(),
      this.options.api.snapshotDiffPathsProbe(),
    ])
    const snapshot = this.classifySnapshot(snapshotResult)
    const tasks: ScopeCapability = tasksResult.ok
      ? { available: true, detail: null }
      : tasksResult.status === 404
        ? { available: false, detail: 'tasks-unavailable' }
        : { available: false, detail: tasksResult.error }
    const result: CapabilitySnapshot = {
      observedAt: this.now(),
      health: {
        ok: health.ok,
        version: health.version,
        authMode: health.authMode,
        role: health.role,
        accountId: health.accountId,
        userId: health.userId,
        latencyMs: this.now() - started,
        error: health.error,
      },
      snapshot,
      tasks,
      rules,
      compile: classifyCompileProbe(compileResult),
      versions: classifyRouteProbe(versionsResult),
      diffPaths: classifyRouteProbe(diffPathsResult),
    }
    if (this.generation === generation) this.cached = result
    return result
  }

  /**
   * Classify `GET /snapshot/log?limit=1`.
   *
   * A 404 carrying `error.details.type === "git_ref"` is the feature working on
   * a fresh account (the branch has no commits yet), not an absent route — the
   * distinction a plain message comparison would lose.
   */
  private classifySnapshot(result: Awaited<ReturnType<OpenVikingApi['snapshotLog']>>): SnapshotCapability {
    if (result.ok) return { available: true, detail: null, kind: 'history' }
    const details = result.errorDetails
    const detailType =
      details !== null && typeof details === 'object' ? (details as { type?: unknown }).type : undefined
    if (result.status === 404 && detailType === 'git_ref') {
      return { available: true, detail: 'no-snapshot-history', kind: 'no-history' }
    }
    // 400 "required scope omitted" is ROOT-only paths validation: the route is
    // present, the caller identity simply is not local ROOT. Prepare always
    // passes explicit paths, so the capability is available.
    if (result.status === 400) return { available: true, detail: 'paths-required', kind: 'history' }
    if (result.status === 403) return unavailable('forbidden', 'denied')
    if (result.status === 404) return unavailable('snapshot-unavailable', 'route-absent')
    return unavailable(result.error ?? 'snapshot probe failed', 'unknown')
  }
}

/** Classify `GET /compile/capabilities`; the runtime answer decides the gate. */
function classifyCompileProbe(result: Awaited<ReturnType<OpenVikingApi['compileCapabilities']>>): CompileCapability {
  if (result.ok) {
    const configured = result.result?.configured === true
    const canCreate = result.result?.can_create === true
    const reason = typeof result.result?.reason_code === 'string' ? result.result.reason_code : null
    return {
      available: configured && canCreate,
      detail: configured && canCreate ? null : (reason ?? 'compile-unavailable'),
      configured,
      canCreate,
      reason,
      kind: 'capabilities',
    }
  }
  if (result.status === 404) return { available: false, detail: 'compile-unavailable', configured: false, canCreate: false, reason: null, kind: 'route-absent' }
  if (result.status === 401 || result.status === 403) {
    return { available: false, detail: 'compile-role-required', configured: false, canCreate: false, reason: null, kind: 'denied' }
  }
  return {
    available: false,
    detail: result.error ?? 'compile-unavailable',
    configured: false,
    canCreate: false,
    reason: null,
    kind: 'unknown',
  }
}

/**
 * Classify a missing-parameter route probe: 400/422 means the route exists (it
 * validated the missing argument), 404 means the route is absent on this build.
 */
function classifyRouteProbe(result: Awaited<ReturnType<OpenVikingApi['snapshotVersionsProbe']>>): ScopeCapability {
  if (result.ok) return { available: true, detail: null }
  if (result.status === 400 || result.status === 422) return { available: true, detail: null }
  if (result.status === 404) return { available: false, detail: 'not-supported' }
  if (result.status === 401 || result.status === 403) return { available: false, detail: 'forbidden' }
  return { available: false, detail: result.error ?? 'unknown' }
}

/** Classify the validation-only pack-export probe by status code. */
function classifyPackProbe(status: number, error: string | null): ScopeCapability & { kind?: string } {
  if (status === 400 || status === 422) return { available: true, detail: null, kind: 'route-present' }
  if (status === 404) return { available: false, detail: 'not-supported', kind: 'route-absent' }
  if (status === 401 || status === 403) return { available: false, detail: 'pack-role-required', kind: 'denied' }
  // 0 = transport error; a 200 for an empty URI is unexpected but present.
  if (status === 200) return { available: true, detail: null, kind: 'route-present' }
  return { available: false, detail: error ?? 'pack-export-unavailable', kind: 'unknown' }
}

/**
 * Build the `/scope` capability map.
 *
 * Kept beside the probe so a new gate has one obvious place: the write service
 * reads the same names, and the client renders the same table.
 */
export function scopeCapabilities(
  snapshot: CapabilitySnapshot,
  transport: boolean,
  writesEnabled: boolean,
  opsEnabled = false,
): Record<string, ScopeCapability> {
  return {
    health: { available: snapshot.health.ok, detail: snapshot.health.ok ? null : snapshot.health.error },
    identity: {
      available: snapshot.health.authMode !== null,
      detail: snapshot.health.authMode === null ? 'identity-unknown' : null,
    },
    snapshot: { available: snapshot.snapshot.available, detail: snapshot.snapshot.detail },
    tasks: snapshot.tasks,
    rules: { available: snapshot.rules.available, detail: snapshot.rules.detail },
    acl: { available: false, detail: 'not-enabled' },
    'mutation-transport': { available: transport, detail: transport ? null : 'transport-unavailable' },
    'writes-master': { available: writesEnabled, detail: writesEnabled ? null : 'writes-disabled' },
    /* ---- v0.8 Operate gates -------------------------------------------- */
    compile: { available: snapshot.compile.available, detail: snapshot.compile.detail },
    'snapshot-versions': snapshot.versions,
    'snapshot-diff-paths': snapshot.diffPaths,
    'ops-master': { available: opsEnabled, detail: opsEnabled ? null : 'ops-disabled' },
  }
}
