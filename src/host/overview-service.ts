/**
 * The composed `/overview` answer: one round trip for the default native view.
 *
 * Six parts — config, scope, metrics, the mounted-plugin facts, the Studio
 * frameability probe and the onboarding checklist — are gathered behind
 * `Promise.allSettled`-style wrappers, so a single failing part degrades that
 * card instead of blanking the page. `parts` says which part was unavailable and
 * why; the payload's own fields stay nullable rather than fabricated.
 *
 * The host caches the composed answer for 5 s (`OVERVIEW_CACHE_TTL_MS`); the
 * Refresh button passes `fresh=1`. The onboarding state's `lastOpenedAt` is
 * touched through `OnboardingStore.touchOpened(enabled)`, which is throttled and
 * best effort — and skipped entirely while the `showOnboarding` switch is off,
 * so turning the checklist off also stops its local writes.
 */
import { OVERVIEW_CACHE_TTL_MS } from '../shared/limits.ts'
import type {
  EnhanceConfig,
  MetricsPayload,
  OverviewPartState,
  OverviewPayload,
  OverviewPluginFact,
  PluginNotice,
  ScopePayload,
  StudioStatus,
} from '../shared/protocol.ts'
import type { OnboardingStore } from './onboarding.ts'
import { computeOnboardingChecks } from './onboarding.ts'

export interface OverviewServiceOptions {
  /** The existing `/config` payload builder. */
  config: () => Promise<EnhanceConfig>
  /** The existing scope payload builder; `fresh` bypasses the capability cache. */
  scope: (fresh: boolean) => Promise<ScopePayload>
  /** The v0.5 metric reader. */
  metrics: (fresh: boolean) => Promise<MetricsPayload>
  /** The mounted official memory plugin, read in-process. */
  plugin: () => OverviewPluginFact
  /** The Studio frameability probe. */
  studio: (fresh: boolean) => Promise<StudioStatus>
  onboarding: OnboardingStore
  /** The live `showOnboarding` switch; false = no onboarding write from this read. */
  onboardingEnabled: () => boolean
  now?: () => number
}

interface Settled<T> {
  value: T | null
  part: OverviewPartState
}

function unavailable(error: unknown): OverviewPartState {
  return { available: false, error: error instanceof Error ? error.message : String(error) }
}

async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try {
    const value = await work()
    return { value, part: { available: true, error: null } }
  } catch (error) {
    return { value: null, part: unavailable(error) }
  }
}

export class OverviewService {
  private readonly options: OverviewServiceOptions
  private readonly now: () => number
  private cached: { at: number; payload: OverviewPayload } | null = null
  private inflight: Promise<OverviewPayload> | null = null

  constructor(options: OverviewServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Drop the composed cache (identity switch, or a `fresh=1` read). */
  resetCaches(): void {
    this.cached = null
    this.inflight = null
  }

  /** The composed overview; cached 5 s, never throws. */
  async overview(fresh = false): Promise<OverviewPayload> {
    if (!fresh && this.cached !== null && this.now() - this.cached.at < OVERVIEW_CACHE_TTL_MS) {
      return this.cached.payload
    }
    if (!fresh && this.inflight !== null) return this.inflight
    const promise = this.compose(fresh).finally(() => {
      if (this.inflight === promise) this.inflight = null
    })
    this.inflight = promise
    const payload = await promise
    this.cached = { at: this.now(), payload }
    return payload
  }

  private async compose(fresh: boolean): Promise<OverviewPayload> {
    const { options } = this
    // The plugin fact is in-process and cannot fail; it still has a part flag so
    // the shape is uniform.
    let plugin: OverviewPluginFact = { mounted: false, version: null }
    let pluginPart: OverviewPartState = { available: true, error: null }
    try {
      plugin = options.plugin()
    } catch (error) {
      pluginPart = unavailable(error)
    }

    const [config, scope, metrics, studio] = await Promise.all([
      settle(() => options.config()),
      settle(() => options.scope(fresh)),
      settle(() => options.metrics(fresh)),
      settle(() => options.studio(fresh)),
    ])

    const state = options.onboarding.touchOpened(options.onboardingEnabled())
    const checks = computeOnboardingChecks({
      config: config.value,
      scope: scope.value,
      metrics: metrics.value,
      plugin,
      studio: studio.value,
    })

    const warnings: PluginNotice[] = []
    for (const notice of config.value?.warnings ?? []) warnings.push(notice)
    for (const notice of scope.value?.warnings ?? []) warnings.push(notice)
    for (const notice of metrics.value?.warnings ?? []) warnings.push(notice)

    return {
      config: config.value,
      scope: scope.value,
      metrics: metrics.value,
      plugin,
      studio: studio.value,
      onboarding: { state, checks },
      parts: {
        config: config.part,
        scope: scope.part,
        metrics: metrics.part,
        plugin: pluginPart,
        studio: studio.part,
        onboarding: { available: true, error: null },
      },
      warnings,
      observedAt: new Date(this.now()).toISOString(),
    }
  }
}
