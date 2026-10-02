/**
 * The recall panel — what OpenViking retrieves for the session in view.
 *
 * Mounted into the right Sidebar as its own tab type (see `index.tsx` for the
 * registration). The body is an ordinary session slot so the panel follows the
 * session it was opened in, not the one on screen.
 *
 * What it shows, and where each fact comes from — all of it host-side, one route:
 *   the query          → the session's own last user turn, or what you type
 *   entries + scores   → `POST /api/v1/search/search` with `session_id`
 *   the three buckets  → the same reply, split into memories/resources/skills
 *   the retrieval plan → the reply's `query_plan.reasoning`
 *   an entry's full text → `/recall/content`, on demand, one click
 *
 * Two deliberate choices:
 *
 *  - **The query is editable.** The default is the session's own last prompt, so
 *    opening the tab answers "what is about to be recalled"; typing one answers
 *    "what would this recall", which is how you find out why something did or did
 *    not come back.
 *  - **Full text is lazy.** Retrieval returns abstracts; the body of an entry is a
 *    second request, made only when a row is opened, so a panel full of memories
 *    costs one round trip.
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

/** `viking://user/default/peers/<peer>/memories/events/x.md` → `peers/<peer>/events/x.md`. */
function shortUri(uri: string): string {
  return uri.replace(/^viking:\/\/user\/[^/]+\//, '').replace(/^memories\//, '')
}

function formatScore(score: number): string {
  return score.toFixed(2)
}

function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
}

export function RecallPanel({ sessionId }: RecallPanelProps) {
  const [payload, setPayload] = useState<RecallPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  /** The query the current payload belongs to; '' means "the session's own". */
  const [applied, setApplied] = useState('')
  const [limit, setLimit] = useState(RECALL_DEFAULT_LIMIT)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, RecallContent | { error: string }>>({})
  const [note, setNote] = useState<string | null>(null)
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
          const warnings = answer.recall.warnings ?? []
          setNote(warnings.length > 0 ? warnings.join(' · ') : null)
        } else {
          setError(answer.error)
          setPayload(null)
          setNote(null)
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

  // A new session means a new question: drop everything and start over rather
  // than showing the previous session's memories under the new session's name.
  useEffect(() => {
    setPayload(null)
    setError(null)
    setExpanded(null)
    setBodies({})
    setNote(null)
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

  const reset = useCallback(() => {
    setDraft('')
    setApplied('')
    setLimit(RECALL_DEFAULT_LIMIT)
    setExpanded(null)
    void load('', false, RECALL_DEFAULT_LIMIT)
  }, [load])

  const showAll = useCallback(() => {
    setLimit(RECALL_MAX_LIMIT)
    void load(applied, false, RECALL_MAX_LIMIT)
  }, [applied, load])

  const toggle = useCallback((uri: string) => {
    setExpanded((current) => (current === uri ? null : uri))
    setBodies((current) => {
      if (uri in current) return current
      void fetchRecallContent(uri).then((answer) => {
        setBodies((latest) => ({
          ...latest,
          [uri]: answer.ok ? answer.content : { error: answer.error },
        }))
      })
      // Mark as in flight so a second expand does not double-fetch.
      return { ...current, [uri]: { uri, text: '', truncated: false } }
    })
  }, [])

  const buckets = payload?.buckets ?? []
  const shown = buckets.reduce((sum, bucket) => sum + bucket.items.length, 0)
  const hidden = Math.max((payload?.total ?? 0) - shown, 0)

  return (
    <div className="ove-recall">
      <div className="ove-recall-search">
        <input
          className="ove-recall-input"
          value={draft}
          placeholder="默认用本会话最近一次提问检索"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') search()
            if (event.key === 'Escape') reset()
          }}
        />
        <button type="button" className="ove-recall-button" onClick={search} disabled={loading}>
          检索
        </button>
        <button
          type="button"
          className="ove-recall-button"
          title="重新检索（跳过缓存）"
          onClick={() => void load(applied, true, limit)}
          disabled={loading}
        >
          刷新
        </button>
      </div>

      <div className="ove-recall-facts">
        <span className="ove-recall-query" title={payload?.query.text ?? ''}>
          {payload === null
            ? '读取中…'
            : payload.query.text.length === 0
              ? '没有可用的检索内容'
              : payload.query.text}
        </span>
        <span className="ove-recall-origin">
          {payload === null
            ? ''
            : payload.query.source === 'session'
              ? '来自本会话'
              : applied.length > 0
                ? '手动输入'
                : '来自本会话'}
        </span>
      </div>

      {payload !== null && (
        <div className="ove-recall-stats">
          <span>{shown} 条</span>
          <span>{payload.latencyMs} ms</span>
          <span>{formatTime(payload.searchedAt)}</span>
          {payload.peer !== null && <span title={payload.peer}>peer 检索</span>}
        </div>
      )}

      {note !== null && <p className="ove-recall-note">{note}</p>}
      {error !== null && <p className="ove-recall-error">{error}</p>}

      {/* A search is not instant: the server expands and re-ranks the query, which
          costs seconds on a long prompt. Saying so beats an empty panel. */}
      {loading && payload === null && error === null && (
        <p className="ove-recall-empty">检索中…（服务端会做查询扩展，首次通常要几秒）</p>
      )}

      {payload !== null && payload.query.text.length === 0 && error === null && (
        <p className="ove-recall-empty">
          这个会话还没有可检索的提问。在上面输入内容后回车即可查看会召回哪些记忆。
        </p>
      )}

      {payload?.plan != null && (
        <details className="ove-recall-plan">
          <summary>检索计划</summary>
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

      {payload !== null && payload.targets.length > 0 && (
        <details className="ove-recall-targets">
          <summary>检索范围（{payload.targets.length}）</summary>
          <ul>
            {payload.targets.map((target) => (
              <li key={target}>{target}</li>
            ))}
          </ul>
        </details>
      )}
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
  const label = BUCKET_LABELS[bucket.bucket] ?? bucket.bucket
  return (
    <section className="ove-recall-bucket">
      <h4 className="ove-recall-heading">
        <span>{label}</span>
        <span className="ove-recall-count">{bucket.items.length}</span>
      </h4>
      {bucket.items.length === 0 ? (
        <p className="ove-recall-empty">{loading ? '检索中…' : '无命中'}</p>
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
  return (
    <div className={`ove-recall-item${open ? ' ove-recall-item-open' : ''}`}>
      <button type="button" className="ove-recall-row" onClick={() => onToggle(item.uri)}>
        <span className="ove-recall-score">{formatScore(item.score)}</span>
        <span className="ove-recall-path" title={item.uri}>
          {shortUri(item.uri)}
        </span>
        <span className="ove-recall-caret">{open ? '▾' : '▸'}</span>
      </button>
      {item.abstract.length > 0 && !open && <p className="ove-recall-abstract">{item.abstract}</p>}
      {(item.tags.length > 0 || item.contextType.length > 0 || item.level !== null) && !open && (
        <div className="ove-recall-tags">
          {item.contextType.length > 0 && <span className="ove-recall-tag">{item.contextType}</span>}
          {item.level !== null && <span className="ove-recall-tag">L{item.level}</span>}
          {item.tags.map((tag) => (
            <span className="ove-recall-tag ove-recall-tag-quiet" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="ove-recall-body">
          {body === undefined || (body as RecallContent).text === '' ? (
            <p className="ove-recall-empty">载入中…</p>
          ) : 'error' in body ? (
            <p className="ove-recall-error">{body.error}</p>
          ) : (
            <>
              <pre>{body.text}</pre>
              {body.truncated && <p className="ove-recall-note">内容过长，已截断显示。</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
