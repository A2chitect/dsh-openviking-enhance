/**
 * F8: the read-only rules / skills / experience catalogue.
 *
 * ## Rules
 *
 * OpenViking 0.5.3 has no rule-list endpoint. Rules are files:
 *
 *   viking://~/memories/rules/<scenario_id>/abstract.md        scenario metadata
 *   viking://~/memories/rules/<scenario_id>/<atomic_id>.md     one Rule
 *
 * so the list is one `fs/ls` for the scenarios plus one per scenario, then a
 * `content/read` per rule file. Two consequences shape this service:
 *
 *  - **An absent directory is not an error.** A server whose rule library is
 *    empty answers 404 NOT_FOUND for the root; that is `rules: [], empty: true`,
 *    not a broken feature. A 404 without the server's own NOT_FOUND code — a
 *    route that does not exist on this version — is `unsupported`.
 *  - **The read is bounded.** A large library must not fan out unboundedly: a
 *    fixed scenario/rule cap keeps one panel open to a predictable number of
 *    requests.
 *
 * ## Experience
 *
 * Both Agent Evolution endpoints require an `experience_uri`; they do not list
 * anything themselves. The list therefore comes from the filesystem
 * (`viking://~/memories/experiences/`), and the trajectory/outcome reads run
 * only for the experience the user picked. An empty directory is again a normal
 * state ("no experiences yet"), not an error. The endpoints exist in dev auth
 * mode too — only the admin switch endpoint is permission-gated, and this
 * plugin never calls it.
 *
 * ## Skills
 *
 * `GET /api/v1/skills` is already the catalogue; `node_limit` only caps the
 * nodes per skill, so a large value returns the full skill files' metadata.
 */
import {
  EXPERIENCE_LIST_DEFAULT_LIMIT,
  EXPERIENCE_LIST_MAX_LIMIT,
  EXPERIENCE_OUTCOMES,
  RULE_TASK_CONTEXT_MAX,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperienceOutcome,
  type ExperiencePayload,
  type ExperienceTrajectory,
  type PluginNotice,
  type RuleListPayload,
  type RuleMatch,
  type RuleScenarioGroup,
  type RuleSearchPayload,
  type RuleSummary,
  type SkillCatalogue,
  type SkillEntry,
} from '../shared/protocol.ts'
import type { OpenVikingApi, OvFsListEntry, OvResult } from './openviking-api.ts'
import { mapPool } from './async-pool.ts'
import { isVikingUri } from './preview-service.ts'
import { parseRuleFile, parseScenarioMeta, ruleFactsFromDocument } from './rule-format.ts'
import { RULE_LIST_CONCURRENCY, RULE_LIST_DEADLINE_MS } from '../shared/limits.ts'

/** The user-scope rules root; `viking://~` is the server's caller-home alias. */
export const RULES_ROOT_URI = 'viking://~/memories/rules'
/** The user-scope experience root. */
export const EXPERIENCES_ROOT_URI = 'viking://~/memories/experiences'
/** The one path fragment an experience URI must contain, so this is not a general reader. */
export const EXPERIENCES_PATH = '/memories/experiences/'

/** Caps one catalogue read. */
export const RULES_MAX_SCENARIOS = 20
export const RULES_MAX_RULES = 100

export interface CatalogServiceOptions {
  api: OpenVikingApi
  now?: () => number
  /** Test seams for the S1 fan-out policy; production uses the shared limits. */
  ruleListDeadlineMs?: number
  ruleListConcurrency?: number
}

/**
 * Whether a failed reply means "the server does not have this route/feature"
 * rather than "the thing you asked for is missing".
 *
 * The server's own 404s carry `error.code` (`NOT_FOUND`, `INVALID_ARGUMENT`);
 * a route absent from the version this plugin is talking to is a plain HTTP
 * 404/405 with no envelope code, and a rejected body is a 400/422.
 */
export function isUnsupportedReply(reply: OvResult<unknown>): boolean {
  if (reply.ok) return false
  if (reply.status === 0) return false
  if (reply.errorCode !== null && reply.errorCode !== undefined) return false
  return reply.status === 404 || reply.status === 405
}

/**
 * The capability answer from one validation-only `rules/search` probe.
 *
 * The probe sends `{}`, which the HTTP layer rejects before the service runs, so
 * the reply classifies the route without spending an embedding or judge call:
 *
 *   400/422  route present (body validation rejected the request)
 *   404      route absent (bare 404) unless the reply carries a server code
 *   405      route present under a different method contract
 *   403      present but not readable for this identity
 *   200      route present but degraded (should not happen for `{}`)
 *   0/other  unknown — never a reason to hide the feature on its own
 *
 * `available` is the scope/UI answer; `kind` keeps the probe detail for the
 * Doctor without inventing copy.
 */
export interface RuleSearchCapability {
  available: boolean
  detail: string | null
  kind: 'available' | 'route-absent' | 'method-mismatch' | 'denied' | 'degraded' | 'unknown'
}

export function classifyRuleProbe(reply: OvResult<unknown>): RuleSearchCapability {
  if (reply.status === 0) {
    // Deliberate asymmetry: UI gating keeps the surface visible (an unprobed
    // route is not proof it is absent, so hiding it would be worse), but the
    // Doctor maps `kind: 'unknown'` to the unknown state — a probe that never
    // reached the server did not observe an available capability.
    return { available: true, detail: reply.error ?? 'probe-failed', kind: 'unknown' }
  }
  if (reply.status === 400 || reply.status === 422)
    return { available: true, detail: 'validation', kind: 'available' }
  if (reply.status === 404) {
    if (reply.errorCode !== null && reply.errorCode !== undefined) {
      return { available: true, detail: reply.error ?? 'not-found', kind: 'degraded' }
    }
    return { available: false, detail: 'unsupported', kind: 'route-absent' }
  }
  if (reply.status === 405) return { available: true, detail: 'method-mismatch', kind: 'method-mismatch' }
  if (reply.status === 403) return { available: false, detail: 'forbidden', kind: 'denied' }
  if (reply.ok) return { available: true, detail: 'degraded', kind: 'degraded' }
  return { available: true, detail: reply.error ?? `HTTP ${reply.status}`, kind: 'unknown' }
}

/** The last path segment of a URI, without trailing slashes. */
function tailOf(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** A file name that is a directory index rather than content. */
function isIndexFile(name: string): boolean {
  return name === 'abstract.md' || name === '.overview.md' || name === 'README.md' || name.startsWith('.')
}

/** Clamp the experience limit into the documented window. */
export function clampExperienceLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return EXPERIENCE_LIST_DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(raw), 1), EXPERIENCE_LIST_MAX_LIMIT)
}

/** Only the two documented kinds, defaulting to trajectories. */
export function normalizeExperienceKind(raw: string | undefined): ExperienceKind {
  return raw === 'outcomes' ? 'outcomes' : 'trajectories'
}

/** The five outcome classes, in the format's order, with any extras appended. */
export function normalizeOutcomes(
  raw: Array<{ outcome?: string; count?: number }> | undefined,
): ExperienceOutcome[] {
  const counts = new Map<string, number>()
  for (const entry of raw ?? []) {
    const key = typeof entry.outcome === 'string' && entry.outcome.length > 0 ? entry.outcome : 'unknown'
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0
    counts.set(key, (counts.get(key) ?? 0) + count)
  }
  const ordered: ExperienceOutcome[] = EXPERIENCE_OUTCOMES.map((outcome) => ({
    outcome,
    count: counts.get(outcome) ?? 0,
  }))
  for (const [outcome, count] of counts) {
    if (!(EXPERIENCE_OUTCOMES as readonly string[]).includes(outcome)) ordered.push({ outcome, count })
  }
  return ordered
}

export class CatalogService {
  private readonly options: CatalogServiceOptions
  private readonly ruleListDeadlineMs: number
  private readonly ruleListConcurrency: number

  constructor(options: CatalogServiceOptions) {
    this.options = options
    this.ruleListDeadlineMs = options.ruleListDeadlineMs ?? RULE_LIST_DEADLINE_MS
    this.ruleListConcurrency = options.ruleListConcurrency ?? RULE_LIST_CONCURRENCY
  }

  /**
   * List the rules tree.
   *
   * **Cost policy (S2).** Opening the Rules section must not run a rule search:
   * that endpoint performs scenario vector recall and can run a judge model. The
   * capability question is answered with the validation-only empty-body probe
   * (see `probeRuleSearchRoute`) or, preferably, by the cached answer the caller
   * already holds from the capability service.
   *
   * **Fan-out policy (S1).** The listing is one root `fs/ls`, then a bounded pool
   * over scenario folders (metadata + listing), then a bounded pool over rule
   * files. Both pools share one total deadline: a slow server yields the rows
   * that arrived, plus a `ruleListTruncated` notice, instead of an unbounded
   * spinner. Hitting the scenario/rule caps is reported the same way.
   *
   * @param options.rulesAvailable the capability answer to trust. `undefined`
   * asks this service to run the cheap probe once; `false` refuses immediately.
   * @throws Error('unsupported') when the server has no rules-tree routes.
   */
  async listRules(options: { rulesAvailable?: boolean } = {}): Promise<RuleListPayload> {
    const started = this.currentTime()
    const deadline = started + this.ruleListDeadlineMs
    const warnings: PluginNotice[] = []

    if (options.rulesAvailable === false) throw new Error('unsupported')
    if (options.rulesAvailable === undefined) {
      const capability = classifyRuleProbe(await this.options.api.probeRuleSearchRoute())
      if (!capability.available) throw new Error('unsupported')
      if (capability.kind === 'unknown') {
        warnings.push({ code: 'ruleProbeFailed', params: { error: capability.detail ?? 'unknown' } })
      }
    }

    const root = await this.options.api.listDirectory(RULES_ROOT_URI)
    if (!root.ok) {
      // Only the server's OWN NOT_FOUND means "the library is empty". A bare
      // HTTP 404 is a route this version does not have (see `isUnsupportedReply`).
      if (root.errorCode === 'NOT_FOUND') return this.rulesPayload([], [], true, warnings, started)
      if (isUnsupportedReply(root)) throw new Error('unsupported')
      throw new Error(root.error ?? `HTTP ${root.status}`)
    }

    const entries = root.result ?? []
    const scenarioDirsAll = entries.filter((entry) => entry.isDir === true && !isIndexFile(tailOf(entry.uri)))
    const looseFiles = entries.filter(
      (entry) => entry.isDir !== true && entry.uri.endsWith('.md') && !isIndexFile(tailOf(entry.uri)),
    )
    const scenarioCapHit = scenarioDirsAll.length > RULES_MAX_SCENARIOS
    const scenarioDirs = scenarioDirsAll.slice(0, RULES_MAX_SCENARIOS)

    // Phase 1: scenario metadata + listing, bounded and pooled. Workers return
    // their notices instead of pushing them, so the wire payload's warning order
    // is the input order — not whichever request finished first.
    const scenarioOutcomes = await mapPool(
      scenarioDirs,
      this.ruleListConcurrency,
      async (scenario) => this.readScenario(scenario.uri),
      { deadline, now: () => this.currentTime() },
    )
    for (let index = 0; index < scenarioOutcomes.results.length; index += 1) {
      const outcome = scenarioOutcomes.results[index]
      if (outcome !== undefined) warnings.push(...outcome.warnings)
      const error = scenarioOutcomes.errors[index]
      if (error !== undefined) {
        warnings.push({ code: 'ruleScenarioFailed', params: { error: messageOf(error) } })
      }
    }

    // Phase 2: rule files, bounded and pooled. Loose root files come first, in
    // the same order the serial version read them, then each scenario's files.
    interface RuleTask {
      uri: string
      scenarioId: string | null
      scenarioName: string
    }
    const tasks: RuleTask[] = looseFiles.map((file) => ({ uri: file.uri, scenarioId: null, scenarioName: '' }))
    const scenarios: RuleScenarioGroup[] = []
    for (const outcome of scenarioOutcomes.results) {
      if (outcome === undefined || outcome.scenario === null) continue
      scenarios.push(outcome.scenario)
      for (const file of outcome.files) tasks.push(file)
    }
    const ruleCapHit = tasks.length > RULES_MAX_RULES
    const boundedTasks = tasks.slice(0, RULES_MAX_RULES)
    const ruleOutcomes = await mapPool(
      boundedTasks,
      this.ruleListConcurrency,
      async (task) => this.readRule(task.uri, task.scenarioId, task.scenarioName),
      { deadline, now: () => this.currentTime() },
    )
    const rules: RuleSummary[] = []
    for (let index = 0; index < ruleOutcomes.results.length; index += 1) {
      const outcome = ruleOutcomes.results[index]
      if (outcome !== undefined) {
        warnings.push(...outcome.warnings)
        if (outcome.rule !== null) rules.push(outcome.rule)
      }
      const error = ruleOutcomes.errors[index]
      if (error !== undefined) {
        warnings.push({ code: 'ruleReadFailed', params: { error: messageOf(error) } })
      }
    }
    // Scenario rule counts are only known after the rule phase.
    for (const scenario of scenarios) {
      scenario.ruleCount = rules.filter((rule) => rule.scenario === scenario.id).length
    }

    const partial = scenarioOutcomes.deadlineHit || ruleOutcomes.deadlineHit || ruleCapHit || scenarioCapHit
    const limitedBy = scenarioOutcomes.deadlineHit || ruleOutcomes.deadlineHit
      ? ('deadline' as const)
      : ruleCapHit
        ? ('rule-cap' as const)
        : scenarioCapHit
          ? ('scenario-cap' as const)
          : null
    if (partial) {
      warnings.push({
        code: 'ruleListTruncated',
        params: {
          rules: rules.length,
          scenarios: scenarios.length,
          elapsedMs: Math.max(0, this.currentTime() - started),
          deadlineMs: this.ruleListDeadlineMs,
        },
      })
    }
    return this.rulesPayload(
      rules,
      scenarios,
      rules.length === 0 && scenarioDirsAll.length === 0,
      warnings,
      started,
      {
        partial,
        limitedBy,
        progress: {
          rules: rules.length,
          scenarios: scenarios.length,
          elapsedMs: Math.max(0, this.currentTime() - started),
          deadlineMs: this.ruleListDeadlineMs,
          ruleCap: RULES_MAX_RULES,
          scenarioCap: RULES_MAX_SCENARIOS,
        },
      },
    )
  }

  /**
   * One scenario folder's metadata and rule-file URIs, read for the list.
   *
   * A missing metadata file degrades to the folder name (with a warning); a
   * failed listing is recorded and the scenario is skipped — both are catalogue
   * gaps, not listing failures.
   */
  private async readScenario(uri: string): Promise<{
    scenario: RuleScenarioGroup | null
    files: Array<{ uri: string; scenarioId: string; scenarioName: string }>
    warnings: PluginNotice[]
  }> {
    const scenarioId = tailOf(uri)
    const meta = await this.readScenarioMeta(uri, scenarioId)
    const warnings = [...meta.warnings]
    const listing = await this.options.api.listDirectory(uri)
    if (!listing.ok) {
      warnings.push({ code: 'ruleListFailed', params: { uri, error: listing.error ?? `HTTP ${listing.status}` } })
      return { scenario: null, files: [], warnings }
    }
    const files = (listing.result ?? [])
      .filter((entry) => entry.isDir !== true && entry.uri.endsWith('.md') && !isIndexFile(tailOf(entry.uri)))
      .map((entry) => ({ uri: entry.uri, scenarioId, scenarioName: meta.meta.name }))
    return { scenario: { id: meta.meta.id, name: meta.meta.name, ruleCount: 0 }, files, warnings }
  }

  /**
   * The read-only rule tester: which active Rules apply to a task context?
   *
   * The server returns each matched rule as its complete stored Markdown; the
   * frontmatter is parsed here so the tester can show the requirement,
   * `applies_when` and `exception` separately instead of a raw blob.
   *
   * @throws Error('unsupported') when the server has no rule-search route.
   */
  async searchRules(taskContext: string): Promise<RuleSearchPayload> {
    const context = (taskContext ?? '').trim()
    if (context.length === 0) throw new Error('task-context-required')
    const started = Date.now()
    const reply = await this.options.api.rulesSearch(context.slice(0, RULE_TASK_CONTEXT_MAX))
    if (!reply.ok) {
      if (isUnsupportedReply(reply)) throw new Error('unsupported')
      throw new Error(reply.error ?? `HTTP ${reply.status}`)
    }
    const result = reply.result
    const matches: RuleMatch[] = (result?.rules ?? []).slice(0, RULES_MAX_RULES).map((rule) => {
      const uri = typeof rule.uri === 'string' ? rule.uri : ''
      const content = typeof rule.content === 'string' ? rule.content : ''
      const facts = ruleFactsFromDocument(uri, content, {
        id: rule.atomic_id,
        revision: rule.revision,
        scenario: rule.scenario_id,
        probability: rule.probability,
      })
      return {
        id: facts.id,
        uri: facts.uri,
        revision: facts.revision,
        scenario: facts.scenario,
        probability: facts.probability,
        name: facts.name,
        constraint: facts.constraint,
        appliesWhen: facts.appliesWhen,
        exception: facts.exception,
        status: facts.status,
        body: facts.body,
      }
    })
    return {
      matches,
      rendered: typeof result?.rendered === 'string' ? result.rendered : null,
      warning: typeof result?.warning === 'string' ? result.warning : null,
      complete: result?.delivery?.complete === true,
      latencyMs: Math.max(0, Date.now() - started),
      searchedAt: this.nowIso(),
    }
  }

  /** `GET /api/v1/skills`, mapped for the catalogue. */
  async listSkills(): Promise<SkillCatalogue> {
    const reply = await this.options.api.listSkills({ nodeLimit: 1000 })
    if (!reply.ok) {
      if (isUnsupportedReply(reply)) throw new Error('unsupported')
      throw new Error(reply.error ?? `HTTP ${reply.status}`)
    }
    const warnings: PluginNotice[] = []
    const skills: SkillEntry[] = []
    for (const raw of reply.result?.skills ?? []) {
      const uri = typeof raw.uri === 'string' ? raw.uri : typeof raw.root_uri === 'string' ? raw.root_uri : ''
      const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : tailOf(uri)
      if (name.length === 0) continue
      skills.push({
        name,
        uri: uri.length > 0 ? uri : name,
        rootUri: typeof raw.root_uri === 'string' ? raw.root_uri : null,
        skillMdUri: typeof raw.skill_md_uri === 'string' ? raw.skill_md_uri : null,
        description: typeof raw.description === 'string' ? raw.description : '',
        tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        allowedTools: Array.isArray(raw.allowed_tools)
          ? raw.allowed_tools.filter((tool): tool is string => typeof tool === 'string')
          : [],
      })
    }
    const roots = Array.isArray(reply.result?.root_uris)
      ? reply.result.root_uris.filter((root): root is string => typeof root === 'string')
      : []
    return {
      skills,
      total: typeof reply.result?.total === 'number' ? reply.result.total : skills.length,
      roots,
      warnings,
      observedAt: this.nowIso(),
    }
  }

  /**
   * List experiences, and — when one is selected — its trajectories or outcome
   * distribution.
   *
   * @throws Error('invalid-experience-uri') when the selected URI is not an
   * experience path, and Error('unsupported') when this server lacks the Agent
   * Evolution endpoints.
   */
  async experience(kind: ExperienceKind, experienceUri: string | undefined, limit?: number): Promise<ExperiencePayload> {
    const warnings: PluginNotice[] = []
    const experiences = await this.listExperiences(warnings)
    const selected = (experienceUri ?? '').trim().length > 0 ? (experienceUri ?? '').trim() : null
    if (selected !== null && (!isVikingUri(selected) || !selected.includes(EXPERIENCES_PATH))) {
      throw new Error('invalid-experience-uri')
    }
    if (selected === null) {
      return {
        kind,
        experiences,
        selected: null,
        items: [],
        outcomes: [],
        empty: experiences.length === 0,
        note: experiences.length === 0 ? 'no-experiences' : null,
        warnings,
        observedAt: this.nowIso(),
      }
    }

    if (kind === 'outcomes') {
      const reply = await this.options.api.experienceOutcomes(selected)
      if (!reply.ok) return this.experienceFailure(reply, { experiences, selected, kind, warnings })
      return {
        kind,
        experiences,
        selected,
        items: [],
        outcomes: normalizeOutcomes(reply.result?.outcome_distribution),
        empty: false,
        note: null,
        warnings,
        observedAt: this.nowIso(),
      }
    }

    const reply = await this.options.api.experienceTrajectories(selected, { limit: clampExperienceLimit(limit) })
    if (!reply.ok) return this.experienceFailure(reply, { experiences, selected, kind, warnings })
    const items: ExperienceTrajectory[] = (reply.result?.items ?? [])
      .filter((item) => typeof item.uri === 'string' && item.uri.length > 0)
      .map((item) => ({
        uri: item.uri as string,
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : tailOf(item.uri as string),
        description: typeof item.description === 'string' ? item.description : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : null,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : null,
      }))
    return {
      kind,
      experiences,
      selected,
      items,
      outcomes: [],
      empty: false,
      note: null,
      warnings,
      observedAt: this.nowIso(),
    }
  }

  /** Directory listing of the experiences root; an absent directory is empty. */
  private async listExperiences(warnings: PluginNotice[]): Promise<ExperienceEntry[]> {
    const reply = await this.options.api.listDirectory(EXPERIENCES_ROOT_URI)
    if (!reply.ok) {
      if (reply.errorCode === 'NOT_FOUND') return []
      if (isUnsupportedReply(reply)) throw new Error('unsupported')
      throw new Error(reply.error ?? `HTTP ${reply.status}`)
    }
    return (reply.result ?? [])
      .filter((entry) => !isIndexFile(tailOf(entry.uri)))
      .slice(0, RULES_MAX_RULES)
      .map((entry) => this.toExperienceEntry(entry))
  }

  /** One experience row from a directory entry. */
  private toExperienceEntry(entry: OvFsListEntry): ExperienceEntry {
    const name = tailOf(entry.uri).replace(/\.md$/, '')
    const description = typeof entry.abstract === 'string' ? entry.abstract.slice(0, 400) : ''
    return {
      uri: entry.uri,
      name: name.length > 0 ? name : entry.uri,
      description,
      modifiedAt: typeof entry.modTime === 'string' ? entry.modTime : null,
    }
  }

  /**
   * A failed trajectory/outcome read.
   *
   * An experience file that vanished is a note, not an error; a route the
   * server does not have is `unsupported`; anything else is a real failure.
   */
  private experienceFailure(
    reply: OvResult<unknown>,
    context: {
      experiences: ExperienceEntry[]
      selected: string
      kind: ExperienceKind
      warnings: PluginNotice[]
    },
  ): ExperiencePayload {
    if (reply.status === 0) throw new Error(reply.error ?? 'unreachable')
    if (reply.errorCode === 'NOT_FOUND') {
      return {
        kind: context.kind,
        experiences: context.experiences,
        selected: context.selected,
        items: [],
        outcomes: [],
        empty: true,
        note: 'not-found',
        warnings: context.warnings,
        observedAt: this.nowIso(),
      }
    }
    if (isUnsupportedReply(reply)) throw new Error('unsupported')
    throw new Error(reply.error ?? `HTTP ${reply.status}`)
  }

  /**
   * One rule file → the list row plus its own notices.
   *
   * Returning the notice rather than pushing it keeps the concurrent phase's
   * wire order deterministic; the caller appends results in input order.
   */
  private async readRule(
    uri: string,
    scenarioId: string | null,
    scenarioName: string,
  ): Promise<{ rule: RuleSummary | null; warnings: PluginNotice[] }> {
    const reply = await this.options.api.readText(uri)
    if (!reply.ok || reply.result === null) {
      return {
        rule: null,
        warnings: [{ code: 'ruleUnreadable', params: { uri, error: reply.error ?? `HTTP ${reply.status}` } }],
      }
    }
    const parsed = parseRuleFile(uri, reply.result, scenarioId)
    return {
      rule: {
        id: parsed.facts.id.length > 0 ? parsed.facts.id : tailOf(uri).replace(/\.md$/, ''),
        uri,
        name: parsed.facts.name,
        status: parsed.facts.status ?? 'unknown',
        scenario:
          parsed.facts.scenario === null ? (scenarioName.length > 0 ? scenarioName : null) : parsed.facts.scenario,
        description: (parsed.document.fields.description ?? '').trim() || null,
      },
      warnings: [],
    }
  }

  /** Scenario metadata from `<scenario>/abstract.md`, falling back to the id. */
  private async readScenarioMeta(
    uri: string,
    scenarioId: string,
  ): Promise<{ meta: ReturnType<typeof parseScenarioMeta>; warnings: PluginNotice[] }> {
    const abstractUri = `${uri.replace(/\/+$/, '')}/abstract.md`
    const reply = await this.options.api.readText(abstractUri)
    if (!reply.ok || reply.result === null) {
      // A scenario without metadata is still a scenario — its id becomes the
      // name — but the failed read is recorded like every other catalogue read
      // failure, so the panel can say the name may be missing.
      return {
        meta: parseScenarioMeta(scenarioId, ''),
        warnings: [
          {
            code: 'ruleScenarioUnreadable',
            params: { uri: abstractUri, error: reply.error ?? `HTTP ${reply.status}` },
          },
        ],
      }
    }
    return { meta: parseScenarioMeta(scenarioId, reply.result), warnings: [] }
  }

  /** One payload for both the "empty library" and the listed case. */
  private rulesPayload(
    rules: RuleSummary[],
    scenarios: RuleScenarioGroup[],
    empty: boolean,
    warnings: PluginNotice[],
    started: number,
    bounds: Pick<RuleListPayload, 'partial' | 'limitedBy' | 'progress'> = {
      partial: false,
      limitedBy: null,
      progress: {
        rules: rules.length,
        scenarios: scenarios.length,
        elapsedMs: Math.max(0, this.currentTime() - started),
        deadlineMs: this.ruleListDeadlineMs,
        ruleCap: RULES_MAX_RULES,
        scenarioCap: RULES_MAX_SCENARIOS,
      },
    },
  ): RuleListPayload {
    return {
      rules,
      scenarios,
      empty,
      partial: bounds.partial,
      limitedBy: bounds.limitedBy,
      progress: bounds.progress,
      warnings,
      observedAt: this.nowIso(),
    }
  }

  private currentTime(): number {
    return this.options.now?.() ?? Date.now()
  }

  private nowIso(): string {
    return new Date(this.currentTime()).toISOString()
  }
}

/** One thrown value as a short message for a warning parameter. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
