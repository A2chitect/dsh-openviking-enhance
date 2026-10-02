/**
 * Per-session OpenViking commit status.
 *
 * Mounted into `conversation.composer.dock` (list, session scope) — the flex row
 * directly under the composer, next to the context meter — so it is scoped to
 * the session the user is looking at.
 *
 * What it shows, and where each fact comes from:
 *   pending tokens / threshold  → `GET /api/v1/sessions/dsh-<id>`
 *   commit count, last commit   → same call
 *   phase                       → archive count vs. counted commits
 *   affected memories on click  → `history/archive_00N/memory_diff.json`
 *
 * The plugin never learns about a commit from DSH: the memory plugin discards
 * the commit response and logs at `debug`, which the desktop app filters out.
 * Polling the server is therefore not a shortcut, it is the only reliable path.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitStatus, MemoryDiff, MemoryDiffEntry } from '../shared/protocol.ts'
import { fetchCommits, fetchDiff, type CommitTaskSummary } from './host-api.ts'

export interface CommitStatusProps {
  sessionId?: string
}

const POLL_MS = 5000

export function CommitStatusPill({ sessionId }: CommitStatusProps) {
  const [status, setStatus] = useState<CommitStatus | null>(null)
  const [tasks, setTasks] = useState<CommitTaskSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<MemoryDiff | null>(null)
  const [diffPending, setDiffPending] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const wrap = useRef<HTMLSpanElement | null>(null)

  const poll = useCallback(async () => {
    if (!sessionId) return
    const result = await fetchCommits(sessionId)
    if (result.ok) {
      setStatus(result.status)
      setTasks(result.tasks)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(timer)
  }, [poll, sessionId])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openArchive = useCallback(
    async (archiveUri: string) => {
      if (!sessionId) return
      setSelected(archiveUri)
      setDiff(null)
      setDiffPending(true)
      const result = await fetchDiff(sessionId, archiveUri)
      setDiffPending(false)
      if (result.ok) setDiff(result.diff)
      else setError(result.error)
    },
    [sessionId],
  )

  if (!sessionId) return null

  const phase = error ? 'failed' : (status?.phase ?? 'idle')
  const label = phaseLabel(phase, status)
  const pending = tasks.filter((task) => task.status === 'running' || task.status === 'pending')

  return (
    <span className="ove-pill-wrap" ref={wrap}>
      <button
        type="button"
        className={`ove-pill ove-pill-phase-${phase}`}
        onClick={() => setOpen((value) => !value)}
        title={tooltip(status, error)}
        data-dsh-plugin="openviking-enhance-status"
      >
        <span>OV</span>
        {phase === 'pending' && status ? (
          <span className="ove-bar" aria-hidden="true">
            <i style={{ width: `${Math.round(status.ratio * 100)}%` }} />
          </span>
        ) : null}
        <span>{label}</span>
      </button>
      {open ? (
        <div className="ove-pop" role="dialog" aria-label="OpenViking 提交详情">
          <h4>OpenViking 提交状态</h4>
          <div className="ove-meta">
            {status ? (
              <>
                会话 <code>{status.ovSessionId}</code>
                <br />
                已提交 {status.commitCount} 次
                {status.lastCommitAt ? ` · 最近 ${formatTime(status.lastCommitAt)}` : ''}
                {status.threshold ? ` · 待提交 ${status.pendingTokens}/${status.threshold} tokens` : ''}
              </>
            ) : error ? (
              `读取失败：${error}`
            ) : (
              '读取中…'
            )}
          </div>

          {pending.length > 0 ? (
            <div className="ove-empty">
              抽取中：{pending.length} 个任务（{pending.map((task) => task.status).join(', ')}）
            </div>
          ) : null}

          {status && status.archives.length > 0 ? (
            <ul>
              {[...status.archives].reverse().map((archive) => (
                <li key={archive.archiveId}>
                  <button type="button" className="ove-pill ove-archive" onClick={() => void openArchive(archive.archiveUri)}>
                    <span>{archive.archiveId}</span>
                    <span className="ove-empty">查看影响 →</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ove-empty">本会话尚无提交。达到 token 阈值或会话结束时自动提交。</div>
          )}

          {diffPending ? <div className="ove-empty">正在读取 {selected}…</div> : null}
          {diff ? <DiffView diff={diff} /> : null}
          {!diffPending && selected && !diff ? (
            <div className="ove-empty">该归档还没有 memory_diff.json —— 抽取仍在进行。</div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

function DiffView({ diff }: { diff: MemoryDiff }) {
  const { summary } = diff
  return (
    <div>
      <h4>
        影响记忆：新增 {summary.totalAdds} · 更新 {summary.totalUpdates} · 删除 {summary.totalDeletes}
      </h4>
      <div className="ove-meta">{diff.archiveUri}</div>
      <Group title="新增" entries={diff.adds} />
      <Group title="更新" entries={diff.updates} />
      <Group title="删除" entries={diff.deletes} />
      {summary.totalAdds + summary.totalUpdates + summary.totalDeletes === 0 ? (
        <div className="ove-empty">本次提交未改变任何记忆。</div>
      ) : null}
    </div>
  )
}

function Group({ title, entries }: { title: string; entries: MemoryDiffEntry[] }) {
  if (entries.length === 0) return null
  return (
    <details className="ove-group" open>
      <summary>
        {title}（{entries.length}）
      </summary>
      {entries.map((entry) => (
        <div className="ove-entry" key={entry.uri}>
          <div className="ove-uri">{entry.uri}</div>
          <div className="ove-type">{entry.memoryType}</div>
        </div>
      ))}
    </details>
  )
}

function phaseLabel(phase: string, status: CommitStatus | null): string {
  switch (phase) {
    case 'failed':
      return '不可用'
    case 'extracting':
      return '抽取中…'
    case 'done':
      return `${status?.commitCount ?? 0} 次提交`
    case 'pending':
      return status ? `${formatTokens(status.pendingTokens)}/${formatTokens(status.threshold ?? 0)}` : '待提交'
    default:
      return '未提交'
  }
}

function tooltip(status: CommitStatus | null, error: string | null): string {
  if (error) return `OpenViking 读取失败：${error}`
  if (!status) return '正在读取 OpenViking 提交状态'
  return [
    `OpenViking 会话：${status.ovSessionId}`,
    `待提交 tokens：${status.pendingTokens}${status.threshold ? ` / ${status.threshold}` : ''}`,
    `提交次数：${status.commitCount}`,
    status.lastCommitAt ? `最近提交：${status.lastCommitAt}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
