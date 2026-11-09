/**
 * The per-turn "memory sources" tail in the conversation.
 *
 * Mounted into `conversation.chat.turnTail` — a list slot rendered once under a
 * completed turn. It shows a small "OV recall" trigger; opening it asks the host
 * to explain the recall for **that turn's prompt**.
 *
 * Two deliberate choices:
 *
 *  - **The prompt comes from the turn, not the session.** The Chat standard kit
 *    hands this slot a `useChat` selector hook, so the turn's own user message
 *    is available without replacing the message renderer (which the roadmap
 *    explicitly avoids). A turn with no human prompt renders nothing.
 *  - **The answer says it is a replay.** DSH does not retain the memory plugin's
 *    injected block, so the host repeats the same context request under the
 *    session's current state. The card says so, and shows the server-assembled
 *    block it would inject, rather than pretending those numbers are historical.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RecallExplainEntry,
  RecallExplainStats,
  RecallExplanation,
} from '../shared/protocol.ts'
import { fetchRecallExplain } from './host-api.ts'
import { noticeText, t } from './locale.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'

/** Props a `conversation.chat.turnTail` occupant receives, plus our inject face. */
export type RecallExplainProps = PropsRuntime<'conversation.chat.turnTail'> & {
  sessionId: string
  /** Open the full recall tab, for the case where explanation is not enough. */
  openRecall?: () => void
}

const BUCKET_KEYS: Record<string, string> = {
  memories: 'recall.bucket.memories',
  resources: 'recall.bucket.resources',
  skills: 'recall.bucket.skills',
}

/** The turn's initiating user prompt, from the Chat snapshot. Empty when none. */
export function turnPrompt(snapshot: {
  locations: { getTurn(turn: number): readonly string[] }
  nodes: { get(key: string): { kind?: string; data?: unknown } | undefined }
}, turn: number): string {
  const keys = snapshot.locations.getTurn(turn)
  for (const key of keys) {
    const node = snapshot.nodes.get(key)
    // A Chat view node wraps the raw Conversation node in `data`; the user row's
    // kind is the raw kind (`user`), and its content lives in `data.content`.
    if (node?.kind !== 'user') continue
    const data = node.data
    if (data === null || typeof data !== 'object') continue
    const text = textOfBlocks((data as { content?: unknown }).content)
    if (text.length > 0) return text
  }
  return ''
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

function fileName(uri: string): string {
  const cut = uri.lastIndexOf('/')
  return cut === -1 ? uri : uri.slice(cut + 1)
}

function scoreTone(score: number): string {
  if (score >= 0.8) return 'ove-recall-score-high'
  if (score >= 0.7) return 'ove-recall-score-mid'
  return 'ove-recall-score-low'
}

function metricsOf(explanation: RecallExplanation): Array<{ label: string; value: string }> {
  const stats = explanation.stats
  const metrics: Array<{ label: string; value: string }> = []
  metrics.push({ label: t('explain.mode'), value: explanation.mode === 'context' ? t('explain.mode.context') : t('explain.mode.search') })
  metrics.push({ label: t('explain.latency'), value: `${explanation.latencyMs} ms` })
  if (stats?.usedTokens != null || stats?.maxTokens != null) {
    metrics.push({
      label: t('explain.budget'),
      value: `${stats?.usedTokens ?? '?'} / ${stats?.maxTokens ?? '?'} tokens`,
    })
  }
  if (stats?.deduped != null) metrics.push({ label: t('explain.deduped'), value: String(stats.deduped) })
  if (stats?.dedup?.status != null) {
    metrics.push({ label: t('explain.dedup'), value: `${stats.dedup.status}${stats.dedup.turns != null ? ` · ${stats.dedup.turns} turns` : ''}` })
  }
  if (stats?.peerScope != null) metrics.push({ label: t('explain.peerScope'), value: stats.peerScope })
  if (stats?.queryExpansion != null) metrics.push({ label: t('explain.expansion'), value: stats.queryExpansion })
  if (stats?.excluded != null) metrics.push({ label: t('explain.excluded'), value: String(stats.excluded) })
  if (stats?.dropped != null) metrics.push({ label: t('explain.dropped'), value: String(stats.dropped) })
  return metrics
}

export function RecallExplainTail(props: RecallExplainProps) {
  const { sessionId, turn, useChat } = props
  const prompt = useChat((snapshot) => turnPrompt(snapshot, turn.turn))
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [explanation, setExplanation] = useState<RecallExplanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(
    async (fresh: boolean) => {
      if (prompt.length === 0) return
      const ticket = (generation.current += 1)
      setLoading(true)
      try {
        const answer = await fetchRecallExplain(sessionId, prompt, { source: 'turn', fresh })
        if (ticket !== generation.current) return
        if (answer.ok) {
          setExplanation(answer.explanation)
          setError(null)
        } else {
          setError(answer.error)
        }
      } catch (problem) {
        if (ticket !== generation.current) return
        setError(problem instanceof Error ? problem.message : String(problem))
      } finally {
        if (ticket === generation.current) setLoading(false)
      }
    },
    [prompt, sessionId],
  )

  // A new turn or prompt invalidates the old answer; the component is keyed per
  // turn in practice, but a fork or an edited message can change the prompt.
  useEffect(() => {
    setExplanation(null)
    setError(null)
    setOpen(false)
    setExpanded(null)
    generation.current += 1
  }, [sessionId, turn.turn, prompt])

  useEffect(() => {
    if (open && explanation === null && error === null && !loading) void load(false)
  }, [open, explanation, error, loading, load])

  if (prompt.length === 0) return null

  const groups = new Map<string, RecallExplainEntry[]>()
  for (const entry of explanation?.entries ?? []) {
    const list = groups.get(entry.bucket)
    if (list === undefined) groups.set(entry.bucket, [entry])
    else list.push(entry)
  }
  const shown = explanation?.entries.length ?? 0

  return (
    <div className="ove-explain" data-dsh-plugin="openviking-enhance-recall">
      <button
        type="button"
        className={`ove-explain-trigger${open ? ' ove-explain-trigger-open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <OpenVikingIcon size={12} strokeWidth={1} />
        <span>{t('explain.label')}</span>
        {explanation !== null && (
          <span className="ove-explain-trigger-count">{t('explain.count', { count: shown })}</span>
        )}
        <span className="ove-explain-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="ove-explain-card" role="dialog" aria-label={t('explain.title')}>
          <div className="ove-explain-head">
            <span className="ove-explain-heading">{t('explain.title')}</span>
            <span className="ove-explain-head-actions">
              <button type="button" className="ove-explain-icon" title={t('explain.rerun')} onClick={() => void load(true)} disabled={loading}>
                ↻
              </button>
              <button type="button" className="ove-explain-icon" title={t('explain.close')} onClick={() => setOpen(false)}>
                ✕
              </button>
            </span>
          </div>
          <p className="ove-explain-note">{t('explain.replayNote')}</p>
          <div className="ove-explain-query" title={prompt}>
            <span className="ove-explain-query-label">{t('explain.query')}</span>
            <span className="ove-explain-query-text">{prompt}</span>
          </div>

          {loading && explanation === null && <p className="ove-explain-status">{t('explain.loading')}</p>}
          {error !== null && (
            <p className="ove-explain-error">
              {t('explain.failed', { error })}{' '}
              <button type="button" className="ove-explain-link" onClick={() => void load(true)}>
                {t('explain.retry')}
              </button>
            </p>
          )}

          {explanation !== null && (
            <>
              <div className="ove-explain-metrics">
                {metricsOf(explanation).map((metric) => (
                  <span className="ove-explain-metric" key={metric.label}>
                    <span className="ove-explain-metric-label">{metric.label}</span>
                    <span className="ove-explain-metric-value">{metric.value}</span>
                  </span>
                ))}
              </div>

              {shown === 0 ? (
                <p className="ove-explain-status">{t('explain.empty')}</p>
              ) : (
                <div className="ove-explain-groups">
                  {[...groups.entries()].map(([bucket, entries]) => (
                    <section key={bucket}>
                      <div className="ove-explain-group">
                        <span>{t(BUCKET_KEYS[bucket] ?? bucket)}</span>
                        <span className="ove-explain-group-count">{entries.length}</span>
                      </div>
                      {entries.map((entry) => (
                        <ExplainEntry
                          key={entry.uri}
                          entry={entry}
                          open={expanded === entry.uri}
                          onToggle={() => setExpanded((current) => (current === entry.uri ? null : entry.uri))}
                        />
                      ))}
                    </section>
                  ))}
                </div>
              )}

              {explanation.stats !== null && (
                <details className="ove-explain-details">
                  <summary>{t('explain.accounting')}</summary>
                  <StatsTable stats={explanation.stats} />
                </details>
              )}
              {explanation.plan !== null && (
                <details className="ove-explain-details">
                  <summary>{t('explain.plan')}</summary>
                  <pre>{explanation.plan}</pre>
                </details>
              )}
              {explanation.rendered !== null && (
                <details className="ove-explain-details">
                  <summary>{t('explain.raw')}</summary>
                  <pre>{explanation.rendered}</pre>
                  {explanation.renderedTruncated && <p className="ove-explain-hint">{t('explain.truncated')}</p>}
                </details>
              )}
              {explanation.warnings.length > 0 && (
                <div className="ove-explain-warnings">
                  {explanation.warnings.map((warning, index) => (
                    <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
                  ))}
                </div>
              )}
              {props.openRecall !== undefined && (
                <button type="button" className="ove-explain-link" onClick={props.openRecall}>
                  {t('explain.openRecall')}
                </button>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ExplainEntry({ entry, open, onToggle }: { entry: RecallExplainEntry; open: boolean; onToggle: () => void }) {
  const tags = [
    ...new Set(
      [entry.category, entry.detail === null ? '' : entry.detail, entry.origin === null ? '' : entry.origin, ...entry.tags].filter(
        (tag) => tag.length > 0,
      ),
    ),
  ]
  return (
    <div className={`ove-explain-item${open ? ' ove-explain-item-open' : ''}`}>
      <button type="button" className="ove-explain-row" onClick={onToggle}>
        <span className="ove-explain-line">
          <span className="ove-explain-title" title={entry.uri}>
            {fileName(entry.uri)}
          </span>
          <span className={`ove-explain-score ${scoreTone(entry.score)}`}>{entry.score.toFixed(2)}</span>
          <span className="ove-explain-caret">{open ? '▾' : '▸'}</span>
        </span>
        {!open && <span className="ove-explain-uri-line">{entry.uri}</span>}
        {!open && entry.abstract.length > 0 && <span className="ove-explain-abstract">{entry.abstract}</span>}
        {!open && tags.length > 0 && (
          <span className="ove-explain-tags">
            {tags.map((tag) => (
              <span className="ove-explain-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="ove-explain-detail">
          <span className="ove-explain-uri">{entry.uri}</span>
          {tags.length > 0 && (
            <span className="ove-explain-tags">
              {tags.map((tag) => (
                <span className="ove-explain-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
          {entry.abstract.length > 0 ? <pre>{entry.abstract}</pre> : <p className="ove-explain-hint">{t('explain.noText')}</p>}
        </div>
      )}
    </div>
  )
}

function StatsTable({ stats }: { stats: RecallExplainStats }) {
  const rows: Array<[string, string]> = []
  for (const [key, value] of Object.entries(stats.searched)) rows.push([t('explain.searched', { category: key }), String(value)])
  for (const [key, value] of Object.entries(stats.quotas)) rows.push([t('explain.quota', { category: key }), String(value)])
  for (const [key, value] of Object.entries(stats.tierCounts)) rows.push([t('explain.tier', { tier: key }), String(value)])
  for (const [key, value] of Object.entries(stats.origins)) rows.push([t('explain.origin', { origin: key }), String(value)])
  if (stats.candidates != null) rows.push([t('explain.candidates'), String(stats.candidates)])
  if (stats.returned != null) rows.push([t('explain.returned'), String(stats.returned)])
  if (stats.plannedQueries.length > 0) rows.push([t('explain.planned'), stats.plannedQueries.join(' · ')])
  if (stats.rewrite != null) rows.push([t('explain.rewrite'), stats.rewrite])
  if (stats.scoreThreshold != null) rows.push([t('explain.threshold'), String(stats.scoreThreshold)])
  for (const [key, value] of Object.entries(stats.fill ?? {})) rows.push([t('explain.fill', { key }), String(value)])
  return (
    <dl className="ove-explain-stats">
      {rows.map(([label, value], index) => (
        <div className="ove-explain-stat" key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
