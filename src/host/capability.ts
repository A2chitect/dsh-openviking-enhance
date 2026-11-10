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
import { RULES_CAPABILITY_TTL_MS } from '../shared/limits.ts'

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
    this.rulesCached = null
    this.rulesObservedAt = 0
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
    this.rulesInflight = this.options.api
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
        this.rulesInflight = null
      })
    return this.rulesInflight
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
    this.inflight = this.probeUncached(generation).finally(() => {
      this.inflight = null
    })
    return this.inflight
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
      }
      if (this.generation === generation) this.cached = result
      return result
    }
    // The two capability probes are independent reads; run them together so the
    // current scope prompt pays one round trip, not two.
    const staleness = this.rulesCached !== null && this.now() - this.rulesObservedAt < this.rulesCacheTtlMs
    const [snapshotResult, tasksResult, rules] = await Promise.all([
      this.options.api.snapshotLog({ limit: 1 }),
      this.options.api.listTasks({ limit: 1 }),
      staleness ? Promise.resolve(this.rulesCached as RuleSearchCapability) : this.rules(),
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
  }
}
