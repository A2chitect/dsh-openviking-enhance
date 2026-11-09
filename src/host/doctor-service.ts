/**
 * Doctor: why is memory not working?
 *
 * The panel deliberately separates three questions that are easy to conflate:
 *
 *  1. **connection** — is the server reachable, as whom, and from which config
 *     layer did that address/identity come?
 *  2. **plugin** — is `@openviking/dsh-memory-plugin` mounted, and what effective
 *     recall/capture/commit settings does it run with?
 *  3. **capabilities** — does this server have the context face, rule search,
 *     skills and the filesystem routes this release uses?
 *
 * Every probe is a read. The only writes this plugin performs are the settings
 * form's own service writes; OpenViking never sees one. Probe results are not
 * cached: a doctor page is a deliberate, user-triggered snapshot.
 */
import type {
  ConnectionFieldOrigin,
  DoctorCapability,
  DoctorCheck,
  DoctorReport,
  PluginNotice,
} from '../shared/protocol.ts'
import type { OpenVikingApi } from './openviking-api.ts'
import type { OvConnection } from './config.ts'
import type { CommitService } from './commit-service.ts'
import { resolveSessionUri } from './commit-service.ts'
import {
  memoActive,
  readMemoryPluginVersion,
  readPendingQueue,
  readPluginMemo,
  type ContextFaceMemo,
  type LocalStateOptions,
  type PeerScopeMemo,
} from './local-state.ts'

/** The DSH generations this release is built and type-checked against. */
export const PLUGIN_DSH_RANGE = '>=0.2.2-rc.1'
/** The OpenViking versions this release's contract tests cover. */
export const TESTED_OV_RANGE = 'OpenViking 0.5.1.1 – 0.5.3'

export interface DoctorOptions {
  api: OpenVikingApi
  commit: CommitService
  /** The resolved connection (values used for display, never the key). */
  connection: OvConnection
  /** Secret-free provenance from `resolveConnectionWithOrigins`. */
  origins: ConnectionFieldOrigin[]
  /** The running app's version, when the host exposes one. */
  dshVersion?: () => string | null
  /**
   * Every tool name visible to the model, or null when the tool registry is not
   * reachable. Used to answer "are the OpenViking MCP tools visible?".
   */
  tools?: () => string[] | null
  /** Test seams. */
  now?: () => number
  localState?: LocalStateOptions
  pluginVersion?: () => string | null
}

/** Settings safe to show a person: never the API key, never a secret. */
const EFFECTIVE_KEYS = [
  'enabled',
  'autoRecall',
  'autoCapture',
  'recallLimit',
  'recallMaxTokens',
  'recallTokenBudget',
  'scoreThreshold',
  'recallDedupTurns',
  'recallQueryExpansion',
  'recallRewrite',
  'recallPeerScope',
  'commitTokenThreshold',
  'commitKeepRecentCount',
  'commitTurnThreshold',
  'profileTokenBudget',
  'captureToolResults',
  'mcpEnabled',
  'peerSource',
] as const

export class DoctorService {
  private readonly options: DoctorOptions
  private readonly now: () => number

  constructor(options: DoctorOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /**
   * One snapshot.
   *
   * `probe` asks the server to actually exercise the optional capabilities
   * (context face, rule search, `fs/stat`). The Plugins-page summary calls
   * without it; the full tab calls with it, because that is what the person
   * opened the page for.
   */
  async report(sessionId: string | undefined, options: { probe?: boolean } = {}): Promise<DoctorReport> {
    const { api, commit } = this.options
    const warnings: PluginNotice[] = []
    const probe = options.probe === true
    const observedAt = new Date(this.now()).toISOString()

    const started = this.now()
    const health = await api.health()
    const healthLatencyMs = Math.max(0, this.now() - started)
    if (!health.ok) {
      warnings.push({
        code: 'unreachable',
        params: { endpoint: this.options.connection.endpoint, error: health.error ?? 'unknown' },
      })
    }

    const ovSessionId = sessionId === undefined ? null : commit.ovSessionId(sessionId)
    const peer = sessionId === undefined ? null : commit.actorPeer(sessionId) ?? null
    const request = peer === null ? {} : { actorPeerId: peer }
    const config = sessionId === undefined ? null : commit.pluginConfig(sessionId)
    const mounted = commit.pluginMounted()
    if (!mounted) warnings.push({ code: 'noMemoryPlugin' })

    const [system, skills, observer, sessionMeta, pending] = await Promise.all([
      api.systemStatus(request),
      api.listSkills(request),
      api.observerRetrieval(request),
      ovSessionId === null ? Promise.resolve(null) : api.getSession(ovSessionId, request),
      ovSessionId === null ? Promise.resolve(null) : readPendingQueue(ovSessionId, this.options.localState),
    ])
    const sessionOk = sessionMeta === null ? false : sessionMeta.ok
    if (sessionMeta !== null && !sessionMeta.ok) {
      warnings.push({ code: 'sessionFailed', params: { error: sessionMeta.error ?? `HTTP ${sessionMeta.status}` } })
    }

    const peerMemo = await readPluginMemo<PeerScopeMemo>('peer-scope.json', this.options.localState)
    const peerDowngraded = memoActive(peerMemo, this.now())
    if (peerDowngraded) {
      warnings.push({
        code: 'peerScopeDowngraded',
        params: { scope: peerMemo?.scope ?? 'all', status: peerMemo?.status ?? 0 },
      })
    }
    if (pending !== null && !pending.available) {
      warnings.push({ code: 'pendingQueueUnavailable', params: { error: pending.error ?? 'unknown' } })
    }

    const contextFace = await this.contextCapability(probe, request, warnings)
    const ruleSearch = await this.rulesCapability(probe, request)
    const fsStat = await this.fsCapability(probe, request)
    const toolNames = this.options.tools?.() ?? null
    const mcpTools = toolNames === null ? null : toolNames.filter((name) => name.startsWith('mcp__openviking__'))

    const sessionUri =
      sessionMeta?.result && ovSessionId !== null
        ? resolveSessionUri(sessionMeta.result, ovSessionId, api.user)
        : null
    const compatibility = compatibilityOf(this.options.dshVersion?.() ?? null)
    const dshVersion = compatibility.dshVersion

    const checks: DoctorCheck[] = []
    checks.push(
      health.ok
        ? check('server', 'ok', health.version ? `OpenViking ${health.version}` : null, null)
        : check('server', 'error', health.error, 'doctor.hint.startServer'),
    )
    checks.push(
      sessionId === undefined
        ? check('session', 'skipped', null, null)
        : sessionOk
          ? check('session', 'ok', ovSessionId, null)
          : check('session', 'warn', sessionMeta?.error ?? null, 'doctor.hint.sessionUnknown'),
    )
    checks.push(
      mounted
        ? check('memoryPlugin', 'ok', this.options.pluginVersion?.() ?? readMemoryPluginVersion(), null)
        : check('memoryPlugin', 'warn', null, 'doctor.hint.mountPlugin'),
    )
    checks.push(
      config?.enabled === false
        ? check('pluginEnabled', 'warn', 'off', 'doctor.hint.enablePlugin')
        : config !== null
          ? check('pluginEnabled', 'ok', 'on', null)
          : check('pluginEnabled', 'skipped', null, null),
    )
    checks.push(
      config?.autoRecall === false
        ? check('recall', 'warn', 'off', 'doctor.hint.enableRecall')
        : config === null
          ? check('recall', 'skipped', null, null)
          : check('recall', 'ok', null, null),
    )
    checks.push(
      config?.autoCapture === false
        ? check('capture', 'warn', 'off', 'doctor.hint.enableCapture')
        : config === null
          ? check('capture', 'skipped', null, null)
          : check('capture', 'ok', null, null),
    )
    checks.push(
      peerDowngraded
        ? check('peerScope', 'warn', peerMemo?.scope ?? 'all', 'doctor.hint.peerScope')
        : config === null
          ? check('peerScope', 'skipped', null, null)
          : check('peerScope', 'ok', config.recallPeerScope === 'actor' ? 'actor' : 'all', null),
    )
    checks.push(
      config === null
        ? check('commitThreshold', 'skipped', null, null)
        : typeof config.commitTokenThreshold === 'number'
          ? check('commitThreshold', 'ok', `${Math.round(config.commitTokenThreshold)} tokens`, null)
          : check('commitThreshold', 'unknown', null, 'doctor.hint.thresholdUnknown'),
    )
    checks.push(
      !mounted
        ? check('mcpTools', 'skipped', null, null)
        : mcpTools === null
          ? check('mcpTools', 'unknown', null, 'doctor.hint.mcpTools')
          : mcpTools.length > 0
            ? check('mcpTools', 'ok', `${mcpTools.length} tools`, null)
            : check('mcpTools', 'warn', 'none visible', 'doctor.hint.mcpTools'),
    )
    checks.push(capabilityCheck('contextFace', contextFace))
    checks.push(capabilityCheck('rules', ruleSearch))
    checks.push(
      skills.ok
        ? check('skills', 'ok', `${skills.result?.skills?.length ?? 0} installed`, null)
        : check('skills', 'warn', skills.error ?? `HTTP ${skills.status}`, 'doctor.hint.skillsFailed'),
    )
    checks.push(
      compatibility.compatible === true
        ? check('dshVersion', 'ok', dshVersion, null)
        : compatibility.compatible === false
          ? check('dshVersion', 'warn', dshVersion, 'doctor.hint.dshVersion')
          : check('dshVersion', 'unknown', dshVersion, null),
    )
    checks.push(
      pending === null
        ? check('pendingQueue', 'skipped', null, null)
        : !pending.available
          ? check('pendingQueue', 'unknown', pending.error, 'doctor.hint.pendingQueue')
          : pending.total > 0
            ? check('pendingQueue', 'warn', `${pending.total} queued`, 'doctor.hint.pendingQueue')
            : check('pendingQueue', 'ok', 'empty', null),
    )

    const effective = effectiveConfig(config)
    const report: DoctorReport = {
      observedAt,
      endpoint: this.options.connection.endpoint,
      health: {
        healthy: health.ok,
        version: health.version,
        authMode: health.authMode,
        latencyMs: healthLatencyMs,
        error: health.error,
      },
      connection: {
        endpoint: this.options.connection.endpoint,
        origins: this.options.origins,
      },
      identity: {
        configuredAccount: this.options.connection.account,
        configuredUser: this.options.connection.user,
        serverUser: system.ok ? textOf(system.result?.user) : null,
        serverInitialized: system.ok ? system.result?.initialized === true : null,
        sessionAccount: textOf(sessionMeta?.result?.user?.account_id),
        sessionUser: textOf(sessionMeta?.result?.user?.user_id),
      },
      plugin: {
        mounted,
        version: this.options.pluginVersion?.() ?? readMemoryPluginVersion(),
        peer,
        peerSource: sessionId === undefined ? null : commit.pluginPeerSource(sessionId),
        ovSessionId,
        effective,
      },
      session: {
        known: sessionOk,
        uri: sessionUri,
        messageCount: sessionMeta?.result?.message_count ?? null,
        commitCount: sessionMeta?.result?.commit_count ?? null,
        pendingTokens: sessionMeta?.result?.pending_tokens ?? null,
        lastCommitAt: sessionMeta?.result?.last_commit_at ?? null,
      },
      capabilities: {
        contextFace,
        ruleSearch,
        skills: {
          state: skills.ok ? 'available' : 'unavailable',
          detail: skills.ok ? `${skills.result?.skills?.length ?? 0} skills` : skills.error ?? `HTTP ${skills.status}`,
          count: skills.ok ? skills.result?.skills?.length ?? 0 : null,
        },
        mcpTools: {
          state: !mounted ? 'skipped' : mcpTools === null ? 'unknown' : mcpTools.length > 0 ? 'available' : 'unavailable',
          detail: mcpTools === null ? null : `${mcpTools.length} exposed to the model`,
          count: mcpTools?.length ?? 0,
          names: (mcpTools ?? []).slice(0, 12),
        },
        fsStat,
        observer: {
          state: observer.ok ? 'available' : 'unavailable',
          detail: observer.ok
            ? `${observer.result?.status?.total_queries ?? 0} queries · ${Math.round(observer.result?.status?.avg_latency_ms ?? 0)} ms avg`
            : observer.error ?? `HTTP ${observer.status}`,
          avgLatencyMs: observer.ok ? observer.result?.status?.avg_latency_ms ?? null : null,
          queries: observer.ok ? observer.result?.status?.total_queries ?? null : null,
        },
      },
      checks,
      compatibility: {
        dshVersion,
        pluginRange: PLUGIN_DSH_RANGE,
        dshCompatible: compatibility.compatible,
        testedRange: TESTED_OV_RANGE,
      },
      warnings,
      diagnostics: {},
    }
    // A copyable, secret-free view of the same facts. It deliberately omits
    // itself to stay finite and excludes every connection secret.
    report.diagnostics = {
      observedAt,
      endpoint: report.endpoint,
      health: report.health,
      connection: report.connection,
      identity: report.identity,
      plugin: report.plugin,
      session: report.session,
      capabilities: report.capabilities,
      checks: report.checks,
      compatibility: report.compatibility,
      warnings,
    }
    return report
  }

  private async contextCapability(
    probe: boolean,
    request: { actorPeerId?: string },
    warnings: PluginNotice[],
  ): Promise<DoctorCapability> {
    const memo = await readPluginMemo<ContextFaceMemo>('context-face.json', this.options.localState)
    if (memoActive(memo, this.now())) {
      return { state: 'legacy', detail: 'the memory plugin recorded a legacy context face' }
    }
    if (!probe) return { state: 'unknown', detail: null }
    const reply = await this.options.api.searchContext(
      {
        query: 'OpenViking plugin doctor capability check',
        mode: 'context',
        purpose: 'coding',
        score_threshold: 0.35,
        // A capability probe is not a recall: keeping it out of the session and
        // expansion paths avoids an LLM call and any dedup bookkeeping on open.
        query_expansion: 'off',
      },
      { ...request, timeoutMs: 10000 },
    )
    if (reply.ok) return { state: 'available', detail: null }
    const detail = reply.error ?? `HTTP ${reply.status}`
    // A rejected mode/field is the expected legacy answer; any other failure is
    // reported as such rather than silently called "legacy".
    if (reply.status === 400 || reply.status === 404 || reply.status === 422) {
      return { state: 'legacy', detail }
    }
    warnings.push({ code: 'probeFailed', params: { target: 'context', error: detail } })
    return { state: 'unknown', detail }
  }

  private async rulesCapability(probe: boolean, request: { actorPeerId?: string }): Promise<DoctorCapability> {
    if (!probe) return { state: 'unknown', detail: null }
    const reply = await this.options.api.rulesSearch(
      'OpenViking plugin doctor: check whether the Rule search capability is available.',
      { ...request, timeoutMs: 8000 },
    )
    if (reply.ok) {
      const count = reply.result?.rules?.length ?? 0
      return { state: 'available', detail: reply.result?.warning ?? `${count} matching rules` }
    }
    return { state: 'unavailable', detail: reply.error ?? `HTTP ${reply.status}` }
  }

  private async fsCapability(probe: boolean, request: { actorPeerId?: string }): Promise<DoctorCapability> {
    if (!probe) return { state: 'unknown', detail: null }
    const reply = await this.options.api.fsStat('viking://~', { ...request, timeoutMs: 5000 })
    if (reply.ok) {
      return { state: 'available', detail: reply.result?.uri ?? null }
    }
    return { state: 'unavailable', detail: reply.error ?? `HTTP ${reply.status}` }
  }
}

function check(id: string, status: DoctorCheck['status'], value: string | null, hint: string | null): DoctorCheck {
  return { id, status, value, hint }
}

function capabilityCheck(id: string, capability: DoctorCapability): DoctorCheck {
  const status: DoctorCheck['status'] =
    capability.state === 'available'
      ? 'ok'
      : capability.state === 'legacy'
        ? 'warn'
        : capability.state === 'unavailable'
          ? 'warn'
          : capability.state === 'skipped'
            ? 'skipped'
            : 'unknown'
  const hint =
    capability.state === 'legacy'
      ? 'doctor.hint.contextLegacy'
      : capability.state === 'unavailable'
        ? `doctor.hint.${id}`
        : null
  return check(id, status, capability.detail, hint)
}

function effectiveConfig(config: Record<string, unknown> | null): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (config === null) return out
  for (const key of EFFECTIVE_KEYS) {
    const value = config[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (value === null) out[key] = null
  }
  const excludes = config.recallExcludeUris
  if (Array.isArray(excludes)) out.recallExcludeUris = `${excludes.length} URIs`
  return out
}

/** A small, dependency-free DSH generation check for the Doctor display. */
export function compatibilityOf(dshVersion: string | null): {
  dshVersion: string | null
  compatible: boolean | null
} {
  if (dshVersion === null) return { dshVersion: null, compatible: null }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(dshVersion)
  if (match === null) return { dshVersion, compatible: null }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  // A future major/minor is accepted by the manifest range but untested here;
  // report "unknown" rather than guessing incompatible.
  if (major !== 0 || minor > 2) return { dshVersion, compatible: null }
  if (minor < 2) return { dshVersion, compatible: false }
  if (patch > 2) return { dshVersion, compatible: true }
  if (patch < 2) return { dshVersion, compatible: false }
  // 0.2.2-rc.1 is the manifest's floor; a bare 0.2.2 (and later 0.2.x) is covered.
  const prerelease = match[4] ?? ''
  if (prerelease.length === 0) return { dshVersion, compatible: true }
  const rc = /^rc\.(\d+)/.exec(prerelease)
  return { dshVersion, compatible: rc !== null && Number(rc[1]) >= 1 }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
