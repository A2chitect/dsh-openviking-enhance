/**
 * F7 + F8: the Explore tab.
 *
 * One page, four read-only views behind a segmented navigation:
 *
 *   Search      unified search across memories / resources / skills / rules
 *   Rules       the rule list plus the read-only `rule_search` tester
 *   Skills      the installed skill catalogue
 *   Experience  Experience files and their trajectories / outcomes
 *
 * Why one tab: these are the "what is actually in OpenViking?" questions, and
 * each of them is one navigation away from the others — a search hit is a rule
 * you then want to test, a skill is a file you then want to preview.
 *
 * Load discipline:
 *  - **nothing loads on open except the visible segment's own list.** Search
 *    starts empty (no surprise query); Rules/Skills/Experience load their list,
 *    which is the user's click into the segment;
 *  - every request is torn down by the segment unmounting (`AbortController`),
 *    so switching segments cannot leave a stale answer overwriting a newer one;
 *  - capability gaps are *states*, not errors: a 404/unsupported route renders
 *    one translated line (`explore.rulesUnavailable`, …), never an error pile.
 *
 * Every row that names a `viking://` URI renders it through `VikingUriLink`, so
 * a hit, a rule and a skill all open the F5 preview tab.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RULE_TASK_CONTEXT_MAX,
  SEARCH_BUCKETS,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperiencePayload,
  type RuleListPayload,
  type RuleMatch,
  type RuleSearchPayload,
  type SearchPayload,
  type SkillCatalogue,
} from '../shared/protocol.ts'
import { ScopeChip } from './scope-chip.tsx'
import { fetchExperience, fetchRules, fetchRulesSearch, fetchSearch, fetchSkills } from './host-api.ts'
import { errorText, noticeText, t } from './locale.ts'
import { VikingUriLink } from './viking-uri-link.tsx'

/** Panel props: the session the tab was opened in (Explore is not session-scoped). */
export interface ExplorePanelProps {
  sessionId: string
}

const SEGMENTS = ['search', 'rules', 'skills', 'experience'] as const
type Segment = (typeof SEGMENTS)[number]

const SEGMENT_LABELS: Record<Segment, string> = {
  search: 'explore.search',
  rules: 'explore.rules',
  skills: 'explore.skills',
  experience: 'explore.experience',
}

const BUCKET_LABELS: Record<string, string> = {
  memories: 'explore.bucket.memories',
  resources: 'explore.bucket.resources',
  skills: 'explore.bucket.skills',
  rules: 'explore.bucket.rules',
}

const RULE_STATUS_LABELS: Record<string, string> = {
  active: 'explore.status.active',
  paused: 'explore.status.paused',
  archived: 'explore.status.archived',
  unknown: 'explore.status.unknown',
}

/** A rule status in the reader's language, falling back to the server's word. */
function ruleStatusLabel(status: string): string {
  const key = RULE_STATUS_LABELS[status]
  return key === undefined ? status : t(key)
}

const OUTCOME_LABELS: Record<string, string> = {
  success: 'explore.outcome.success',
  failure: 'explore.outcome.failure',
  partial: 'explore.outcome.partial',
  unknown: 'explore.outcome.unknown',
  unfinished: 'explore.outcome.unfinished',
}

/** The entry's file name: a preview link reads better than a full path. */
function fileName(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** The message for a failed request, translated for the stable codes. */
function failureText(error: string): string {
  return errorText(error)
}

/** Whether an answer is the capability-gap (`unsupported` / a route 404). */
function isUnsupported(error: string): boolean {
  return error === 'unsupported'
}

/** A search input row shared by the two query surfaces. */
function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.3 10.3 13 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function RefreshGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.7-3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M13.2 2.5v2.7h-2.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ExplorePanel(_props: ExplorePanelProps) {
  const [segment, setSegment] = useState<Segment>('search')
  return (
    <div className="ove-explore">
      <div className="ove-explore-scope-row">
        <ScopeChip compact />
      </div>
      <div className="ove-explore-nav" role="tablist" aria-label={t('explore.tabTitle')}>
        {SEGMENTS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={segment === candidate}
            className={`ove-explore-seg${segment === candidate ? ' ove-explore-seg-active' : ''}`}
            onClick={() => setSegment(candidate)}
          >
            {t(SEGMENT_LABELS[candidate])}
          </button>
        ))}
      </div>
      <div className="ove-explore-body">
        {segment === 'search' && <SearchSection />}
        {segment === 'rules' && <RulesSection />}
        {segment === 'skills' && <SkillsSection />}
        {segment === 'experience' && <ExperienceSection />}
      </div>
    </div>
  )
}

/* ========================================================================
 * Search
 * ===================================================================== */

function SearchSection() {
  const [draft, setDraft] = useState('')
  const [payload, setPayload] = useState<SearchPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * S2: rules are searched only on explicit request. `rules/search` runs
   * scenario vector recall and (with a configured Rule judge model) an LLM
   * judgment per candidate, so the extra bucket costs the server real work.
   * The choice is remembered for this mounted panel session only.
   */
  const [includeRules, setIncludeRules] = useState(false)
  const generation = useRef(0)

  // The semantic/keywords control the design brief first imagined is NOT here:
  // the live 0.5.3 backend rejects `search_type: "keywords"` with
  // INVALID_ARGUMENT (the configured vector backend has no full-text index), so
  // the search is always the server's semantic list mode. The host keeps the
  // fallback for a future backend that grows keyword support.
  const run = useCallback(async (query: string, includeRulesNow: boolean) => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    const ticket = (generation.current += 1)
    setLoading(true)
    try {
      const answer = await fetchSearch({
        query: trimmed,
        ...(includeRulesNow ? { buckets: [...SEARCH_BUCKETS] } : {}),
      })
      if (ticket !== generation.current) return
      if (answer.ok) {
        setPayload(answer.search)
        setError(null)
      } else {
        setPayload(null)
        setError(answer.error)
      }
    } catch (problem) {
      if (ticket !== generation.current) return
      setPayload(null)
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [])

  const groups = payload?.buckets.filter((bucket) => bucket.items.length > 0) ?? []

  return (
    <div className="ove-explore-search">
      <div className="ove-explore-bar">
        <label className="ove-explore-field">
          <span className="ove-explore-field-icon">
            <SearchGlyph />
          </span>
          <input
            className="ove-explore-input"
            value={draft}
            placeholder={t('explore.queryPlaceholder')}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run(draft, includeRules)
            }}
          />
        </label>
        <button
          type="button"
          className="ove-explore-button"
          onClick={() => void run(draft, includeRules)}
          disabled={loading || draft.trim().length === 0}
        >
          {t('explore.search')}
        </button>
        <button
          type="button"
          className="ove-explore-icon"
          title={t('explore.refresh')}
          aria-label={t('explore.refresh')}
          onClick={() => void run(payload?.query ?? draft, includeRules)}
          disabled={loading || (payload === null && draft.trim().length === 0)}
        >
          <RefreshGlyph />
        </button>
      </div>

      <div className="ove-explore-options">
        <label className="ove-explore-toggle">
          <input
            type="checkbox"
            checked={includeRules}
            onChange={(event) => setIncludeRules(event.target.checked)}
          />
          <span>{t('explore.includeRules')}</span>
        </label>
        <span className="ove-explore-hint">{t('explore.includeRulesHint')}</span>
      </div>

      {loading && <p className="ove-explore-status">{t('explore.searching')}</p>}
      {!loading && payload === null && error === null && <p className="ove-explore-status">{t('explore.searchEmpty')}</p>}
      {error !== null && <p className="ove-explore-error">{failureText(error)}</p>}

      {payload !== null && (
        <>
          <div className="ove-explore-meta">
            <span>“{payload.query}”</span>
            <span>{payload.total}</span>
            <span>{payload.latencyMs} ms</span>
          </div>
          {groups.length === 0 ? (
            <p className="ove-explore-status">{t('explore.noHits')}</p>
          ) : (
            groups.map((bucket) => (
              <section key={bucket.bucket}>
                <div className="ove-explore-group">
                  <span className="ove-explore-group-name">{t(BUCKET_LABELS[bucket.bucket] ?? bucket.bucket)}</span>
                  <span className="ove-explore-group-count">{bucket.items.length}</span>
                </div>
                {bucket.items.map((item) => (
                  <div className="ove-explore-hit" key={`${bucket.bucket}:${item.uri}`}>
                    <div className="ove-explore-hit-line">
                      <VikingUriLink uri={item.uri} label={fileName(item.uri)} className="ove-explore-hit-name" />
                      <span className="ove-explore-score">{item.score.toFixed(2)}</span>
                    </div>
                    {item.rule !== null && (
                      <div className="ove-explore-hit-tags">
                        <span className="ove-explore-tag">{item.rule.name}</span>
                        {item.rule.status !== null && (
                          <span className="ove-explore-tag">{ruleStatusLabel(item.rule.status)}</span>
                        )}
                      </div>
                    )}
                    {item.abstract.length > 0 && <p className="ove-explore-hit-abstract">{item.abstract}</p>}
                  </div>
                ))}
              </section>
            ))
          )}
          {payload.warnings.length > 0 && (
            <div className="ove-explore-hint">
              {payload.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ========================================================================
 * Rules
 * ===================================================================== */

function RulesSection() {
  const [list, setList] = useState<RuleListPayload | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  /** One in-flight listing; unmount or a refresh aborts the previous one. */
  const controller = useRef<AbortController | null>(null)

  const loadList = useCallback(async () => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setListLoading(true)
    try {
      const answer = await fetchRules(next.signal)
      if (next.signal.aborted) return
      if (answer.ok) {
        setList(answer.list)
        setListError(null)
      } else {
        setList(null)
        setListError(answer.error)
      }
    } catch (problem) {
      if (next.signal.aborted) return
      setList(null)
      setListError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      if (!next.signal.aborted) setListLoading(false)
    }
  }, [])

  // No setState after unmount: the abort stops the request and the guards above
  // drop its answer even if the response had already been delivered.
  useEffect(() => {
    void loadList()
    return () => {
      controller.current?.abort()
      controller.current = null
    }
  }, [loadList])

  return (
    <div className="ove-explore-rules">
      <RuleTester />
      <section>
        <div className="ove-explore-group">
          <span className="ove-explore-group-name">{t('explore.rules')}</span>
          <span className="ove-explore-group-count">{list?.rules.length ?? 0}</span>
        </div>
        {list !== null && list.partial && (
          <div className="ove-explore-hint ove-explore-partial">
            <span>
              {t('explore.rulesPartial', {
                rules: list.progress.rules,
                ruleCap: list.progress.ruleCap,
                deadlineMs: list.progress.deadlineMs,
              })}
            </span>
            <button
              type="button"
              className="ove-explore-icon"
              title={t('explore.refresh')}
              aria-label={t('explore.refresh')}
              onClick={() => void loadList()}
            >
              <RefreshGlyph />
            </button>
          </div>
        )}
        {listLoading && <p className="ove-explore-status">{t('explore.loading')}</p>}
        {listError !== null &&
          (isUnsupported(listError) ? (
            <p className="ove-explore-status">{t('explore.rulesUnavailable')}</p>
          ) : (
            <p className="ove-explore-error">{failureText(listError)}</p>
          ))}
        {list !== null && list.rules.length === 0 && (
          <p className="ove-explore-status">{t('explore.rulesEmpty')}</p>
        )}
        {list?.rules.map((rule) => (
          <div className="ove-explore-hit" key={rule.uri}>
            <div className="ove-explore-hit-line">
              <VikingUriLink uri={rule.uri} label={rule.name} className="ove-explore-hit-name" />
              <span className="ove-explore-tag">{ruleStatusLabel(rule.status)}</span>
              {rule.scenario !== null && <span className="ove-explore-tag">{rule.scenario}</span>}
            </div>
            {rule.description !== null && <p className="ove-explore-hit-abstract">{rule.description}</p>}
          </div>
        ))}
        {list !== null && list.warnings.length > 0 && (
          <div className="ove-explore-hint">
            {list.warnings.map((warning, index) => (
              <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function RuleTester() {
  const [taskContext, setTaskContext] = useState('')
  const [result, setResult] = useState<RuleSearchPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  // A tester run is abandoned on unmount like the list itself: a slow server
  // must not deliver state into a torn-down component.
  useEffect(() => {
    return () => {
      controller.current?.abort()
      controller.current = null
    }
  }, [])

  const run = useCallback(async () => {
    const context = taskContext.trim()
    if (context.length === 0) return
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    const ticket = (generation.current += 1)
    setLoading(true)
    try {
      const answer = await fetchRulesSearch(context, next.signal)
      if (next.signal.aborted) return
      if (ticket !== generation.current) return
      if (answer.ok) {
        setResult(answer.rules)
        setError(null)
      } else {
        setResult(null)
        setError(answer.error)
      }
    } catch (problem) {
      if (next.signal.aborted) return
      if (ticket !== generation.current) return
      setResult(null)
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      if (!next.signal.aborted && ticket === generation.current) setLoading(false)
    }
  }, [taskContext])

  return (
    <section className="ove-explore-tester">
      <div className="ove-explore-group">
        <span className="ove-explore-group-name">{t('explore.rulesTest')}</span>
        <span className="ove-explore-group-count">{t('explore.rulesMatches', { count: result?.matches.length ?? 0 })}</span>
      </div>
      <textarea
        className="ove-explore-textarea"
        value={taskContext}
        placeholder={t('explore.rulesTaskPlaceholder')}
        spellCheck={false}
        rows={3}
        maxLength={RULE_TASK_CONTEXT_MAX}
        onChange={(event) => setTaskContext(event.target.value)}
      />
      <div className="ove-explore-tester-actions">
        <button
          type="button"
          className="ove-explore-button"
          onClick={() => void run()}
          disabled={loading || taskContext.trim().length === 0}
        >
          {loading ? t('explore.rulesTesting') : t('explore.rulesTest')}
        </button>
        {result !== null && <span className="ove-explore-hint">{result.latencyMs} ms</span>}
      </div>
      {/* S2 cost wording: this is a server-side search, unlike the file reads above. */}
      <p className="ove-explore-hint">{t('explore.rulesTestCost')}</p>
      {error !== null &&
        (isUnsupported(error) ? (
          <p className="ove-explore-status">{t('explore.rulesUnavailable')}</p>
        ) : (
          <p className="ove-explore-error">{failureText(error)}</p>
        ))}
      {result !== null && result.matches.length === 0 && (
        <p className="ove-explore-status">{t('explore.rulesNoMatches')}</p>
      )}
      {result?.matches.map((match) => (
        <RuleCard key={`${match.uri}:${match.id}`} match={match} />
      ))}
      {result !== null && result.warning !== null && <p className="ove-explore-hint">{result.warning}</p>}
      {result?.rendered != null && result.rendered.length > 0 && (
        <details className="ove-explore-details">
          <summary>{t('explore.rulesRendered')}</summary>
          <pre>{result.rendered}</pre>
        </details>
      )}
    </section>
  )
}

function RuleCard({ match }: { match: RuleMatch }) {
  const facts: Array<{ label: string; value: string }> = []
  if (match.constraint.length > 0) facts.push({ label: t('explore.ruleConstraint'), value: match.constraint })
  if (match.appliesWhen !== null) facts.push({ label: t('explore.ruleAppliesWhen'), value: match.appliesWhen })
  if (match.exception !== null) facts.push({ label: t('explore.ruleException'), value: match.exception })
  const meta = [
    match.status === null ? '' : match.status,
    match.scenario === null ? '' : match.scenario,
    match.probability === null ? '' : `${t('explore.ruleProbability')} ${match.probability.toFixed(2)}`,
  ].filter((part) => part.length > 0)
  return (
    <div className="ove-explore-rule">
      <div className="ove-explore-hit-line">
        {match.uri.length > 0 ? (
          <VikingUriLink uri={match.uri} label={match.name} className="ove-explore-hit-name" />
        ) : (
          <span className="ove-explore-hit-name">{match.name}</span>
        )}
        {meta.map((part) => (
          <span className="ove-explore-tag" key={part}>
            {part}
          </span>
        ))}
      </div>
      <dl className="ove-explore-facts">
        {facts.map((fact) => (
          <div className="ove-explore-fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {match.body.length > 0 && (
        <details className="ove-explore-details">
          <summary>{t('explore.ruleBody')}</summary>
          <pre>{match.body}</pre>
        </details>
      )}
    </div>
  )
}

/* ========================================================================
 * Skills
 * ===================================================================== */

function SkillsSection() {
  const [catalogue, setCatalogue] = useState<SkillCatalogue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true)
    try {
      const answer = await fetchSkills(signal)
      if (signal.aborted) return
      if (answer.ok) {
        setCatalogue(answer.catalogue)
        setError(null)
      } else {
        setCatalogue(null)
        setError(answer.error)
      }
    } catch (problem) {
      if (signal.aborted) return
      setCatalogue(null)
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  return (
    <section className="ove-explore-skills">
      <div className="ove-explore-group">
        <span className="ove-explore-group-name">{t('explore.skills')}</span>
        <span className="ove-explore-group-count">{catalogue?.total ?? 0}</span>
      </div>
      {loading && <p className="ove-explore-status">{t('explore.loading')}</p>}
      {error !== null &&
        (isUnsupported(error) ? (
          <p className="ove-explore-status">{t('explore.skillsUnavailable')}</p>
        ) : (
          <p className="ove-explore-error">{failureText(error)}</p>
        ))}
      {catalogue !== null && catalogue.skills.length === 0 && (
        <p className="ove-explore-status">{t('explore.skillsEmpty')}</p>
      )}
      {catalogue?.skills.map((skill) => {
        const target = skill.skillMdUri ?? skill.uri
        return (
          <div className="ove-explore-hit" key={skill.uri}>
            <div className="ove-explore-hit-line">
              <VikingUriLink uri={target} label={skill.name} className="ove-explore-hit-name" />
              {skill.tags.map((tag) => (
                <span className="ove-explore-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
            {skill.description.length > 0 && <p className="ove-explore-hit-abstract">{skill.description}</p>}
            {skill.skillMdUri !== null && skill.skillMdUri !== target && (
              <p className="ove-explore-hint">{t('explore.skillOpen')}</p>
            )}
          </div>
        )
      })}
      {catalogue !== null && catalogue.warnings.length > 0 && (
        <div className="ove-explore-hint">
          {catalogue.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ========================================================================
 * Experience
 * ===================================================================== */

function ExperienceSection() {
  const [kind, setKind] = useState<ExperienceKind>('trajectories')
  const [payload, setPayload] = useState<ExperiencePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Guards a slow answer from an earlier experience/kind overwriting the current one. */
  const generation = useRef(0)

  const load = useCallback(async (nextKind: ExperienceKind, selected: string | null) => {
    const ticket = (generation.current += 1)
    setLoading(true)
    try {
      const answer = await fetchExperience(nextKind, selected ?? undefined)
      if (ticket !== generation.current) return
      if (answer.ok) {
        setPayload(answer.experience)
        setError(null)
      } else {
        setPayload(null)
        setError(answer.error)
      }
    } catch (problem) {
      if (ticket !== generation.current) return
      setPayload(null)
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [])

  // The list itself is the first read; selecting an experience or switching the
  // kind refetches with that selection.
  useEffect(() => {
    void load('trajectories', null)
  }, [load])

  const select = (uri: string) => {
    void load(kind, uri)
  }

  const switchKind = (next: ExperienceKind) => {
    setKind(next)
    void load(next, payload?.selected ?? null)
  }

  const selected = payload?.selected ?? null

  return (
    <section className="ove-explore-experience">
      <div className="ove-explore-group">
        <span className="ove-explore-group-name">{t('explore.experience')}</span>
        <span className="ove-explore-group-count">{payload?.experiences.length ?? 0}</span>
      </div>

      {loading && <p className="ove-explore-status">{t('explore.loading')}</p>}
      {error !== null &&
        (isUnsupported(error) ? (
          <p className="ove-explore-status">{t('explore.experienceUnavailable')}</p>
        ) : (
          <p className="ove-explore-error">{failureText(error)}</p>
        ))}

      {payload !== null && payload.experiences.length === 0 && (
        <p className="ove-explore-status">{t('explore.experienceEmpty')}</p>
      )}

      {payload !== null && payload.experiences.length > 0 && (
        <>
          <p className="ove-explore-hint">{t('explore.experiencePick')}</p>
          <div className="ove-explore-picker">
            {payload.experiences.map((experience: ExperienceEntry) => (
              <button
                key={experience.uri}
                type="button"
                className={`ove-explore-pick${selected === experience.uri ? ' ove-explore-pick-active' : ''}`}
                title={experience.uri}
                onClick={() => select(experience.uri)}
              >
                {experience.name}
              </button>
            ))}
          </div>
        </>
      )}

      {selected !== null && (
        <>
          <div className="ove-explore-type" role="group" aria-label={t('explore.experience')}>
            {(['trajectories', 'outcomes'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={kind === candidate}
                className={`ove-explore-type-btn${kind === candidate ? ' ove-explore-type-active' : ''}`}
                onClick={() => switchKind(candidate)}
              >
                {t(candidate === 'trajectories' ? 'explore.trajectories' : 'explore.outcomes')}
              </button>
            ))}
          </div>

          {kind === 'trajectories' && payload !== null && payload.items.length === 0 && (
            <p className="ove-explore-status">{t('explore.trajectoryEmpty')}</p>
          )}
          {kind === 'trajectories' &&
            payload?.items.map((item) => (
              <div className="ove-explore-hit" key={item.uri}>
                <div className="ove-explore-hit-line">
                  <VikingUriLink uri={item.uri} label={item.name} className="ove-explore-hit-name" />
                  {item.createdAt !== null && <span className="ove-explore-tag">{item.createdAt}</span>}
                </div>
                {item.description.length > 0 && <p className="ove-explore-hit-abstract">{item.description}</p>}
              </div>
            ))}

          {kind === 'outcomes' && payload !== null && (
            <dl className="ove-explore-facts">
              {payload.outcomes.map((outcome) => (
                <div className="ove-explore-fact" key={outcome.outcome}>
                  <dt>{t(OUTCOME_LABELS[outcome.outcome] ?? outcome.outcome)}</dt>
                  <dd>{outcome.count}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  )
}
