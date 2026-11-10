/**
 * The first-run onboarding checklist (F14 start).
 *
 * Deliberately **not** a modal wizard and not `settings.onboarding`: this is
 * about the OpenViking connection and the plugin's own runtime, so it ships as a
 * read-only checklist card surfaced in two places from one component (the native
 * Overview and a Plugins-page Setup card).
 *
 * The persisted state — the plugin's sixth local file — is
 * `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/onboarding.json`, created
 * `0600` atomically through the v0.5 `plugin-state.ts` helpers. It contains only
 * dismissal/completion timestamps and step ids and the last full-check counts:
 * never an endpoint, account, user, key, peer, memory URI or memory body. A
 * missing or corrupt file is "first run", not an error (the Doctor's
 * config-source health already reports unreadable state).
 *
 * The cheap checks are computed from the composed `/overview` parts (no extra
 * OpenViking calls); "run full check" is an explicit user action that goes
 * through the existing `/doctor?probe=1` route and records the counts here.
 */
import { ONBOARDING_STEP_IDS, type OnboardingCheck, type OnboardingState } from '../shared/protocol.ts'
import type {
  EnhanceConfig,
  MetricsPayload,
  OverviewPluginFact,
  ScopePayload,
  StudioStatus,
} from '../shared/protocol.ts'
import { pluginStateDir, readFileOrNull, writePrivateFile } from './plugin-state.ts'
import { join } from 'node:path'

/** The file name inside the plugin state directory. */
export const ONBOARDING_FILE = 'onboarding.json'

/** The state a first run (or an unreadable file) starts from. */
export function freshOnboardingState(): OnboardingState {
  return {
    version: 1,
    dismissedAt: null,
    completedStepIds: [],
    lastOpenedAt: null,
    lastFullCheck: null,
  }
}

/** Longest string a state field may carry; anything longer is a corrupt file. */
const MAX_STATE_STRING = 64
/** Upper bound for a full-check counter, so a corrupt file cannot claim absurd values. */
const MAX_CHECK_COUNT = 10_000

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STATE_STRING ? value : null
}

function boundedCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(Math.trunc(value), MAX_CHECK_COUNT)
}

/**
 * Validate one parsed file into the state shape.
 *
 * Every field is re-derived from the parsed JSON rather than trusted: the file
 * is local, but it is still the only mutable input to a route.
 */
export function normalizeOnboardingState(parsed: unknown): OnboardingState {
  const fresh = freshOnboardingState()
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fresh
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return fresh
  const completed: string[] = []
  if (Array.isArray(record.completedStepIds)) {
    for (const value of record.completedStepIds) {
      if (typeof value !== 'string') continue
      if (!(ONBOARDING_STEP_IDS as readonly string[]).includes(value)) continue
      if (!completed.includes(value)) completed.push(value)
    }
  }
  let lastFullCheck: OnboardingState['lastFullCheck'] = null
  const rawCheck = record.lastFullCheck
  if (rawCheck !== null && typeof rawCheck === 'object' && !Array.isArray(rawCheck)) {
    const check = rawCheck as Record<string, unknown>
    const at = boundedString(check.at)
    const ok = boundedCount(check.ok)
    const warn = boundedCount(check.warn)
    const error = boundedCount(check.error)
    if (at !== null && ok !== null && warn !== null && error !== null) {
      lastFullCheck = { at, ok, warn, error }
    }
  }
  return {
    version: 1,
    dismissedAt: boundedString(record.dismissedAt),
    completedStepIds: completed.slice(0, ONBOARDING_STEP_IDS.length),
    lastOpenedAt: boundedString(record.lastOpenedAt),
    lastFullCheck,
  }
}

/** One validated `POST /onboarding/state` request. */
export type OnboardingUpdate =
  | { action: 'dismiss' }
  | { action: 'reset' }
  | { action: 'complete-step'; stepId: string }
  | { action: 'full-check'; ok: number; warn: number; error: number }

export type OnboardingParseResult =
  | { ok: true; update: OnboardingUpdate }
  | { ok: false; error: string }

/**
 * Validate the route's body.
 *
 * The route is a *local-state* POST, so it runs the same enum/length validation
 * the other guarded routes run — a local file write still must not accept an
 * arbitrary object from a caller.
 */
export function parseOnboardingUpdate(body: Record<string, unknown>): OnboardingParseResult {
  const action = body.action
  if (action === 'dismiss') return { ok: true, update: { action: 'dismiss' } }
  if (action === 'reset') return { ok: true, update: { action: 'reset' } }
  if (action === 'complete-step') {
    const stepId = body.stepId
    if (typeof stepId !== 'string' || !(ONBOARDING_STEP_IDS as readonly string[]).includes(stepId)) {
      return { ok: false, error: 'invalid-step' }
    }
    return { ok: true, update: { action: 'complete-step', stepId } }
  }
  if (action === 'full-check') {
    const counts = [body.ok, body.warn, body.error]
    if (counts.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CHECK_COUNT)) {
      return { ok: false, error: 'invalid-counts' }
    }
    return {
      ok: true,
      update: {
        action: 'full-check',
        ok: Math.trunc(body.ok as number),
        warn: Math.trunc(body.warn as number),
        error: Math.trunc(body.error as number),
      },
    }
  }
  return { ok: false, error: 'invalid-action' }
}

export interface OnboardingStoreOptions {
  /** Override the state directory (tests). */
  dir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** How long a `touchOpened()` may be skipped; 60 s keeps a cached overview cheap. */
  touchThrottleMs?: number
}

/**
 * The persisted checklist state, plus the write actions the route exposes.
 *
 * Every write is atomic (`writePrivateFile`) and best effort: a read-only home
 * directory must not break the panel, so `apply` reports the failure while the
 * in-memory answer stays useful.
 */
export class OnboardingStore {
  private readonly options: OnboardingStoreOptions
  private readonly now: () => number
  private cached: OnboardingState | null = null
  private lastTouchAt = 0

  constructor(options: OnboardingStoreOptions = {}) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** The absolute file path (diagnostics only; never echoed with contents). */
  filePath(): string {
    return join(pluginStateDir({ ...(this.options.dir === undefined ? {} : { dir: this.options.dir }), ...(this.options.env === undefined ? {} : { env: this.options.env }) }), ONBOARDING_FILE)
  }

  /** The current state; a missing/corrupt file is a first run. */
  read(): OnboardingState {
    if (this.cached !== null) return this.cached
    const raw = readFileOrNull(this.filePath())
    let parsed: unknown = null
    try {
      parsed = raw === null ? null : JSON.parse(raw)
    } catch {
      parsed = null
    }
    this.cached = normalizeOnboardingState(parsed)
    return this.cached
  }

  /**
   * Apply one validated action.
   *
   * Returns the new state even when the file write failed; `writeError` says so
   * (the UI can still show the dismissed card for this session, but the state
   * will not survive a reload — and saying that is better than pretending).
   */
  apply(update: OnboardingUpdate): { state: OnboardingState; writeError: string | null } {
    const current = this.read()
    const at = new Date(this.now()).toISOString()
    let next: OnboardingState
    switch (update.action) {
      case 'dismiss':
        next = { ...current, dismissedAt: at }
        break
      case 'reset':
        next = { ...freshOnboardingState() }
        break
      case 'complete-step': {
        const completed = current.completedStepIds.includes(update.stepId)
          ? current.completedStepIds
          : [...current.completedStepIds, update.stepId]
        next = { ...current, completedStepIds: completed }
        break
      }
      case 'full-check':
        next = {
          ...current,
          lastFullCheck: { at, ok: update.ok, warn: update.warn, error: update.error },
        }
        break
    }
    const written = writePrivateFile(this.filePath(), `${JSON.stringify(next, null, 2)}\n`)
    this.cached = next
    return { state: next, writeError: written.ok ? null : written.error }
  }

  /**
   * Record that the native cockpit was opened.
   *
   * Throttled to once per minute and best effort: the default view must not write
   * a file on every cached overview read, and a home directory that cannot be
   * written must not make opening the panel fail.
   */
  touchOpened(): OnboardingState {
    const current = this.read()
    if (this.now() - this.lastTouchAt < (this.options.touchThrottleMs ?? 60_000)) return current
    this.lastTouchAt = this.now()
    const next: OnboardingState = { ...current, lastOpenedAt: new Date(this.now()).toISOString() }
    const written = writePrivateFile(this.filePath(), `${JSON.stringify(next, null, 2)}\n`)
    if (written.ok) this.cached = next
    return this.cached ?? current
  }
}

/** The composed parts the cheap checklist reads (no extra OpenViking calls). */
export interface OnboardingCheckInput {
  config: EnhanceConfig | null
  scope: ScopePayload | null
  metrics: MetricsPayload | null
  plugin: OverviewPluginFact
  studio: StudioStatus | null
}

function check(
  id: OnboardingCheck['id'],
  status: OnboardingCheck['status'],
  hintKey: string | null = null,
  detail: string | null = null,
): OnboardingCheck {
  return { id, status, labelKey: `onboarding.step.${id}`, hintKey, detail }
}

/**
 * The six cheap checks, derived only from the composed overview parts.
 *
 * Every check answers "is this working, and what should the person do next" from
 * data the panel already fetched; the expensive context-face/MCP-tool probes stay
 * in the full Doctor check behind the explicit button.
 */
export function computeOnboardingChecks(input: OnboardingCheckInput): OnboardingCheck[] {
  const { config, scope, metrics, plugin, studio } = input
  const checks: OnboardingCheck[] = []

  const unreachable = config?.warnings.some((warning) => warning.code === 'unreachable') === true
  if (config === null) checks.push(check('endpoint', 'unknown', 'onboarding.hint.endpointUnknown'))
  else if (unreachable) checks.push(check('endpoint', 'error', 'onboarding.hint.endpointUnreachable'))
  else checks.push(check('endpoint', 'ok'))

  if (config === null) checks.push(check('health', 'unknown', 'onboarding.hint.healthUnknown'))
  else if (config.healthy) checks.push(check('health', 'ok', null, config.version === null ? null : `v${config.version}`))
  else checks.push(check('health', 'error', 'onboarding.hint.startServer'))

  if (scope === null) checks.push(check('identity', 'unknown', 'onboarding.hint.identityUnknown'))
  else {
    const identity = scope.identity
    const detail = identity.account.length > 0 && identity.user.length > 0 ? `${identity.account}/${identity.user}` : null
    if (!scope.healthy) checks.push(check('identity', 'error', 'onboarding.hint.identityUnavailable', detail))
    else if (scope.capabilities.identity?.available === false) checks.push(check('identity', 'warn', 'onboarding.hint.identityUnverified', detail))
    else checks.push(check('identity', 'ok', null, detail))
  }

  if (plugin.mounted) {
    checks.push(check('memoryPlugin', 'ok', null, plugin.version === null ? null : `v${plugin.version}`))
  } else {
    checks.push(check('memoryPlugin', 'warn', 'onboarding.hint.memoryPlugin'))
  }

  if (scope === null) {
    checks.push(check('capabilities', 'unknown', 'onboarding.hint.capabilitiesUnknown'))
  } else {
    const entries = Object.values(scope.capabilities)
    const available = entries.filter((entry) => entry.available).length
    const metricsAvailable =
      metrics !== null && (metrics.dashboard.available || metrics.queue.available || metrics.memories.available)
    if (!scope.healthy) {
      checks.push(check('capabilities', 'error', 'onboarding.hint.capabilitiesUnavailable'))
    } else if (studio !== null && studio.frameable === 'no') {
      checks.push(check('capabilities', 'warn', 'onboarding.hint.studioBlocked', 'studio'))
    } else if (!metricsAvailable) {
      checks.push(check('capabilities', 'warn', 'onboarding.hint.statsUnavailable', `${available}/${entries.length}`))
    } else {
      checks.push(check('capabilities', 'ok', null, `${available}/${entries.length}`))
    }
  }

  const fsReadsAvailable = config?.healthy === true
  const metricsAvailable = metrics !== null && (metrics.dashboard.available || metrics.memories.available)
  const firstStep = fsReadsAvailable ? 'browse' : metricsAvailable ? 'stats' : 'studio'
  checks.push(check('firstStep', 'ok', `onboarding.firstStep.${firstStep}`))

  return checks
}
