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
import { isVikingUri } from './preview-service.ts'
import { parseRuleFile, parseScenarioMeta, ruleFactsFromDocument } from './rule-format.ts'

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

  constructor(options: CatalogServiceOptions) {
    this.options = options
  }

  /**
   * List the rules tree.
   *
   * @throws Error('unsupported') when the server has no rules-tree routes;
   * everything else degrades into `empty` or a warning.
   */
  async listRules(): Promise<RuleListPayload> {
    const warnings: PluginNotice[] = []
    // Capability gate first: Rules exist in 0.5.3+ only, and on an older server
    // the rules root is ALSO a 404 NOT_FOUND — indistinguishable, from the
    // filesystem alone, from "Rules exist but nothing is compiled yet". A minimal
    // `rules/search` probe is the documented capability answer: 200 (even with
    // the empty-library warning) = the feature exists; a generic 404/405 = the
    // route is absent on this build.
    const probe = await this.options.api.rulesSearch('OpenViking rule capability probe')
    if (!probe.ok) {
      if (isUnsupportedReply(probe)) throw new Error('unsupported')
      throw new Error(probe.error ?? `HTTP ${probe.status}`)
    }
    const root = await this.options.api.listDirectory(RULES_ROOT_URI)
    if (!root.ok) {
      // Only the server's OWN NOT_FOUND means "the library is empty". A bare
      // HTTP 404 is a route this version does not have (see `isUnsupportedReply`).
      if (root.errorCode === 'NOT_FOUND') return this.rulesPayload([], [], true, warnings)
      if (isUnsupportedReply(root)) throw new Error('unsupported')
      throw new Error(root.error ?? `HTTP ${root.status}`)
    }

    const entries = root.result ?? []
    const scenarios: RuleScenarioGroup[] = []
    const rules: RuleSummary[] = []
    const scenarioDirs = entries.filter((entry) => entry.isDir === true && !isIndexFile(tailOf(entry.uri)))
    const looseFiles = entries.filter(
      (entry) => entry.isDir !== true && entry.uri.endsWith('.md') && !isIndexFile(tailOf(entry.uri)),
    )

    // Rule files directly under the root: treat them as one unnamed scenario.
    for (const file of looseFiles.slice(0, RULES_MAX_RULES)) {
      const rule = await this.readRule(file.uri, null, warnings, '')
      if (rule !== null) rules.push(rule)
    }

    for (const scenario of scenarioDirs.slice(0, RULES_MAX_SCENARIOS)) {
      const scenarioId = tailOf(scenario.uri)
      const meta = await this.readScenarioMeta(scenario.uri, scenarioId, warnings)
      const listing = await this.options.api.listDirectory(scenario.uri)
      if (!listing.ok) {
        warnings.push({ code: 'ruleListFailed', params: { uri: scenario.uri, error: listing.error ?? `HTTP ${listing.status}` } })
        continue
      }
      const files = (listing.result ?? []).filter(
        (entry) => entry.isDir !== true && entry.uri.endsWith('.md') && !isIndexFile(tailOf(entry.uri)),
      )
      for (const file of files) {
        if (rules.length >= RULES_MAX_RULES) break
        const rule = await this.readRule(file.uri, scenarioId, warnings, meta.name)
        if (rule !== null) rules.push(rule)
      }
      scenarios.push({ id: meta.id, name: meta.name, ruleCount: rules.filter((rule) => rule.scenario === scenarioId).length })
      if (rules.length >= RULES_MAX_RULES) break
    }

    return this.rulesPayload(rules, scenarios, rules.length === 0 && scenarioDirs.length === 0, warnings)
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

  /** One rule file → the list row; unreadable files become warnings, not gaps. */
  private async readRule(
    uri: string,
    scenarioId: string | null,
    warnings: PluginNotice[],
    scenarioName: string,
  ): Promise<RuleSummary | null> {
    const reply = await this.options.api.readText(uri)
    if (!reply.ok || reply.result === null) {
      warnings.push({ code: 'ruleUnreadable', params: { uri, error: reply.error ?? `HTTP ${reply.status}` } })
      return null
    }
    const parsed = parseRuleFile(uri, reply.result, scenarioId)
    return {
      id: parsed.facts.id.length > 0 ? parsed.facts.id : tailOf(uri).replace(/\.md$/, ''),
      uri,
      name: parsed.facts.name,
      status: parsed.facts.status ?? 'unknown',
      scenario: parsed.facts.scenario === null ? (scenarioName.length > 0 ? scenarioName : null) : parsed.facts.scenario,
      description: (parsed.document.fields.description ?? '').trim() || null,
    }
  }

  /** Scenario metadata from `<scenario>/abstract.md`, falling back to the id. */
  private async readScenarioMeta(uri: string, scenarioId: string, warnings: PluginNotice[]) {
    const abstractUri = `${uri.replace(/\/+$/, '')}/abstract.md`
    const reply = await this.options.api.readText(abstractUri)
    if (!reply.ok || reply.result === null) {
      // A scenario without metadata is still a scenario — its id becomes the
      // name — but the failed read is recorded like every other catalogue read
      // failure, so the panel can say the name may be missing.
      warnings.push({
        code: 'ruleScenarioUnreadable',
        params: { uri: abstractUri, error: reply.error ?? `HTTP ${reply.status}` },
      })
      return parseScenarioMeta(scenarioId, '')
    }
    return parseScenarioMeta(scenarioId, reply.result)
  }

  /** One payload for both the "empty library" and the listed case. */
  private rulesPayload(
    rules: RuleSummary[],
    scenarios: RuleScenarioGroup[],
    empty: boolean,
    warnings: PluginNotice[],
  ): RuleListPayload {
    return { rules, scenarios, empty, warnings, observedAt: this.nowIso() }
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString()
  }
}
