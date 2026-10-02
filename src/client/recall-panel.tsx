/**
 * The recall panel — what OpenViking retrieves for the session in view.
 *
 * Mounted into the right Sidebar as its own tab type (see `index.tsx` for the
 * registration). The body is an ordinary session slot, so the panel follows the
 * session it was opened in rather than the one on screen.
 *
 * What it shows, and where each fact comes from — all of it host-side, one route:
 *   the query          → the session's own last user turn, or what you type
 *   entries + scores   → `POST /api/v1/search/search` with `session_id`
 *   the three buckets  → the same reply, split into memories/resources/skills
 *   the retrieval plan → the reply's `query_plan.reasoning`
 *   an entry's full text → `/recall/content`, on demand, one click
 *
 * The layout is the shipped right Sidebar's own: a 38px header over a body that
 * scrolls itself (the pane does not scroll a tab body), rows that are borderless
 * with a hover fill, and a bold group label with its count on one baseline. Those
 * declarations live in `styles.ts`, next to the shipped rules they were copied
 * from.
 *
 * Two deliberate choices:
 *
 *  - **The query is editable.** The default is the session's own last prompt, so
 *    opening the tab answers "what is about to be recalled"; typing one answers
 *    "what would this recall", which is how you find out why something did or did
 *    not come back. The field always shows the query the rows below belong to.
 *  - **Full text is lazy.** Retrieval returns abstracts; the body of an entry is a
 *    second request made only when a row is opened, so a panel of memories costs
 *    one round trip.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  type RecallBucket,
  type RecallContent,
  type RecallItem,
  type RecallPayload,
} from '../shared/protocol.ts'
import { fetchRecall, fetchRecallContent } from './host-api.ts'

/** Panel props: the session this tab was opened in. */
export interface RecallPanelProps {
  sessionId: string
}

const BUCKET_LABELS: Record<string, string> = {
  memories: '记忆',
  resources: '资源',
  skills: '技能',
}

/**
 * The entry's file name. The title line shows only this: the full `viking://`
 * path is one hover away (`title`) and one click away (the detail block), and a
 * relative path in front of a name that is already long enough to be truncated
 * only cost the name its room.
 */
function fileName(uri: string): string {
  const cut = uri.lastIndexOf('/')
  return cut === -1 ? uri : uri.slice(cut + 1)
}

/**
 * How strong a match looks.
 *
 * The bands follow the server's own reported score distribution — min 0.60,
 * average 0.755, max 0.92 over 438 queries — rather than a 0…1 intuition, so a
 * coloured number means the same thing on this machine as it does in the
 * observer. Colour is never the only signal: the number itself is right there.
 */
function scoreTone(score: number): string {
  if (score >= 0.8) return 'ove-recall-score-high'
  if (score >= 0.7) return 'ove-recall-score-mid'
  return 'ove-recall-score-low'
}

function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/** Panel-local chrome, not the brand mark: the field's 14px glyph. */
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
      <path
        d="M13.2 2.5v2.7h-2.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function RecallPanel({ sessionId }: RecallPanelProps) {
  const [payload, setPayload] = useState<RecallPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  /** The query the rows on screen belong to; '' means "the session's own". */
  const [applied, setApplied] = useState('')
  const [limit, setLimit] = useState(RECALL_DEFAULT_LIMIT)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, RecallContent | { error: string }>>({})
  /** Guards against a slow reply from a previous session overwriting this one. */
  const generation = useRef(0)

  const load = useCallback(
    async (query: string, fresh: boolean, nextLimit: number) => {
      const ticket = (generation.current += 1)
      setLoading(true)
      try {
        const answer = await fetchRecall(sessionId, query, {
          limit: nextLimit,
          ...(fresh ? { fresh: true } : {}),
        })
        if (ticket !== generation.current) return
        if (answer.ok) {
          setPayload(answer.recall)
          setError(null)
          // A session-derived query goes into the field: the rows below are its
          // answer, so the field must not read as empty while they are shown.
          if (answer.recall.query.source === 'session') setDraft(answer.recall.query.text)
        } else {
          setError(answer.error)
          setPayload(null)
        }
      } catch (problem) {
        if (ticket !== generation.current) return
        setError(problem instanceof Error ? problem.message : String(problem))
        setPayload(null)
      } finally {
        if (ticket === generation.current) setLoading(false)
      }
    },
    [sessionId],
  )

  // A new session is a new question: drop everything rather than showing the
  // previous session's memories under the new session's name.
  useEffect(() => {
    setPayload(null)
    setError(null)
    setExpanded(null)
    setBodies({})
    setDraft('')
    setApplied('')
    setLimit(RECALL_DEFAULT_LIMIT)
    void load('', false, RECALL_DEFAULT_LIMIT)
  }, [load])

  const search = useCallback(() => {
    const next = draft.trim()
    setApplied(next)
    setLimit(RECALL_DEFAULT_LIMIT)
    setExpanded(null)
    void load(next, false, RECALL_DEFAULT_LIMIT)
  }, [draft, load])

  const showAll = useCallback(() => {
    setLimit(RECALL_MAX_LIMIT)
    void load(applied, false, RECALL_MAX_LIMIT)
  }, [applied, load])

  const toggle = useCallback((uri: string) => {
    setExpanded((current) => (current === uri ? null : uri))
    setBodies((current) => {
      if (uri in current) return current
      void fetchRecallContent(uri).then((answer) => {
        setBodies((latest) => ({ ...latest, [uri]: answer.ok ? answer.content : { error: answer.error } }))
      })
      // Marked in flight so a second expand does not fetch twice.
      return { ...current, [uri]: { uri, text: '', truncated: false } }
    })
  }, [])

  const buckets = payload?.buckets ?? []
  const shown = buckets.reduce((sum, bucket) => sum + bucket.items.length, 0)
  const hidden = Math.max((payload?.total ?? 0) - shown, 0)

  return (
    <div className="ove-recall">
      <div className="ove-recall-bar">
        <label className="ove-recall-field">
          <span className="ove-recall-field-icon">
            <SearchGlyph />
          </span>
          <input
            className="ove-recall-input"
            value={draft}
            placeholder="本会话最近一次提问"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search()
            }}
          />
        </label>
        <button type="button" className="ove-recall-button" onClick={search} disabled={loading}>
          检索
        </button>
        <button
          type="button"
          className="ove-recall-icon"
          title="重新检索（跳过缓存）"
          aria-label="重新检索"
          onClick={() => void load(applied, true, limit)}
          disabled={loading}
        >
          <RefreshGlyph />
        </button>
      </div>

      <div className="ove-recall-body">
        {payload !== null && (
          <div className="ove-recall-meta">
            <span>{payload.query.source === 'session' ? '本会话提问' : '手动输入'}</span>
            <span>{shown} 条</span>
            <span>{payload.latencyMs} ms</span>
            <span>{formatTime(payload.searchedAt)}</span>
            {payload.peer !== null && <span>peer 检索</span>}
          </div>
        )}

        {error !== null && <p className="ove-recall-error">{error}</p>}

        {/* A search is not instant: the server expands and re-ranks the query,
            which costs seconds on a long prompt. Saying so beats an empty panel. */}
        {loading && payload === null && error === null && (
          <p className="ove-recall-status">检索中…（服务端会做查询扩展，首次通常要几秒）</p>
        )}

        {payload !== null && payload.query.text.length === 0 && error === null && (
          <p className="ove-recall-status">
            这个会话还没有可检索的提问。在上面输入内容后回车，即可看到会召回哪些记忆。
          </p>
        )}

        {payload?.plan != null && (
          <details className="ove-recall-plan">
            <summary><span className="ove-recall-summary">检索计划</span></summary>
            <pre>{payload.plan}</pre>
          </details>
        )}

        {buckets.map((bucket) => (
          <Bucket
            key={bucket.bucket}
            bucket={bucket}
            loading={loading}
            expanded={expanded}
            bodies={bodies}
            onToggle={toggle}
          />
        ))}

        {hidden > 0 && limit < RECALL_MAX_LIMIT && (
          <button type="button" className="ove-recall-more" onClick={showAll} disabled={loading}>
            显示全部（另有 {hidden} 条）
          </button>
        )}

        {(payload?.warnings.length ?? 0) > 0 && (
          <div className="ove-recall-hint">
            {payload?.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}

        {payload !== null && payload.targets.length > 0 && (
          <details className="ove-recall-targets">
            <summary><span className="ove-recall-summary">检索范围（{payload.targets.length}）</span></summary>
            <ul>
              {payload.targets.map((target) => (
                <li key={target}>{target}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}

interface BucketProps {
  bucket: RecallBucket
  loading: boolean
  expanded: string | null
  bodies: Record<string, RecallContent | { error: string }>
  onToggle: (uri: string) => void
}

function Bucket({ bucket, loading, expanded, bodies, onToggle }: BucketProps) {
  return (
    <section>
      <div className="ove-recall-group">
        <span className="ove-recall-group-name">{BUCKET_LABELS[bucket.bucket] ?? bucket.bucket}</span>
        <span className="ove-recall-group-count">{bucket.items.length}</span>
      </div>
      {bucket.items.length === 0 ? (
        <p className="ove-recall-hint">{loading ? '检索中…' : '无命中'}</p>
      ) : (
        bucket.items.map((item) => (
          <Item
            key={item.uri}
            item={item}
            open={expanded === item.uri}
            body={bodies[item.uri]}
            onToggle={onToggle}
          />
        ))
      )}
    </section>
  )
}

interface ItemProps {
  item: RecallItem
  open: boolean
  body: RecallContent | { error: string } | undefined
  onToggle: (uri: string) => void
}

function Item({ item, open, body, onToggle }: ItemProps) {
  // The kind first (entity / event / preference / …), then the level of the
  // memory tree, then anything the server itself tagged.
  const tags = [
    ...new Set(
      [item.memoryType || item.contextType, item.level === null ? '' : `L${item.level}`, ...item.tags].filter(
        (tag) => tag.length > 0,
      ),
    ),
  ]
  return (
    <div className={`ove-recall-item${open ? ' ove-recall-item-open' : ''}`}>
      {/* One button for the whole collapsed card: the abstract and the tags sit
          inside it, so anywhere on the card opens it. */}
      <button type="button" className="ove-recall-row" onClick={() => onToggle(item.uri)}>
        <span className="ove-recall-line">
          <span className="ove-recall-title" title={item.uri}>
            {fileName(item.uri)}
          </span>
          <span className={`ove-recall-score ${scoreTone(item.score)}`}>{item.score.toFixed(2)}</span>
          <span className="ove-recall-caret">{open ? '▾' : '▸'}</span>
        </span>
        {!open && item.abstract.length > 0 && (
          <span className="ove-recall-abstract">{item.abstract}</span>
        )}
        {!open && tags.length > 0 && (
          <span className="ove-recall-tags">
            {tags.map((tag) => (
              <span className="ove-recall-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="ove-recall-detail">
          <span className="ove-recall-uri">{item.uri}</span>
          {body === undefined || (body as RecallContent).text === '' ? (
            <p className="ove-recall-hint">载入中…</p>
          ) : 'error' in body ? (
            <p className="ove-recall-error">{body.error}</p>
          ) : (
            <>
              <pre>{body.text}</pre>
              {body.truncated && <p className="ove-recall-hint">内容过长，已截断显示。</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
