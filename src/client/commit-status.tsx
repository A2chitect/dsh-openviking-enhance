/**
 * Per-session OpenViking commit status.
 *
 * Mounted into `conversation.composer.dock` (list, session scope) — the flex row
 * directly under the composer, next to the shell's own stats pills — so it is
 * scoped to the session the user is looking at.
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
 *
 * Presentation follows the default pills exactly (see `styles.ts`): same font
 * metrics, tertiary label colour, transparent borderless 999px capsule, 14px
 * currentColor icon, tabular figures, same hover/expanded background. It renders
 * as the last item of the row, so the shell's own pills and their centring are
 * left untouched. The icon is the shell's own `IconArchiveOutlineRegular` — a
 * commit in OpenViking produces an `archive_00N`, so it is also the honest glyph —
 * taken from the sidebar row's own mark (`openviking-icon.tsx`) so the two mounts
 * read as the same thing. The label leads with "OV" because a commit pill is
 * otherwise indistinguishable from a git commit's.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitStatus, CommitTask, MemoryDiff, MemoryDiffEntry } from '../shared/protocol.ts'
import { fetchCommits, fetchDiff } from './host-api.ts'
import {
  deriveClientPhase,
  describeFailure,
  isActiveTask,
  durationSeconds,
  failedTasks,
  taskTime,
} from '../shared/commit-state.ts'
import { OpenVikingIcon } from './openviking-icon.tsx'

export interface CommitStatusProps {
  sessionId?: string
}

const POLL_MS = 5000

export function CommitStatusPill({ sessionId }: CommitStatusProps) {
  const [status, setStatus] = useState<CommitStatus | null>(null)
  const [tasks, setTasks] = useState<CommitTask[]>([])
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

  // The task list is the accurate signal and this poll already carries it, so the
  // phase is derived from it rather than from the host's archive-vs-counter view:
  // `commit_count` advances when the archive is written, so a failed or in-flight
  // extraction is invisible to a count comparison. See shared/commit-state.ts.
  const running = tasks.filter(isActiveTask)
  const failures = failedTasks(tasks)
  const phase = deriveClientPhase({ error, status, tasks })
  const text = phaseLabel(phase, status)
  const archives = status ? [...status.archives].reverse() : []

  return (
    <span className="ove-dock" ref={wrap} data-dsh-plugin="openviking-enhance-status">
      <button
        type="button"
        className={`ove-pill${phase === 'errored' ? ' ove-pill-errored' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`OpenViking：${text}`}
        title={tooltip(status, error, failures)}
        onClick={() => setOpen((value) => !value)}
      >
        <OpenVikingIcon size={14} strokeWidth={1} />
        <span className={`ove-label${phase === 'extracting' ? ' ove-pulse' : ''}`}>
          {'OV'}
          <span className="ove-sep" aria-hidden="true">
            ·
          </span>
          {text}
        </span>
      </button>
      {open ? (
        <div className="ove-pop" role="dialog" aria-label="OpenViking 提交详情">
          <div className="ove-pop-title">
            <span className="ove-pop-title-label">
              <OpenVikingIcon size={14} strokeWidth={1} />
              OpenViking 提交
            </span>
            <span className="ove-row-count">{status ? `${status.commitCount} 次` : '—'}</span>
          </div>
          <div className="ove-pop-rule" aria-hidden="true" />
          <dl className="ove-facts">
            <dt>会话</dt>
            <dd>
              <code>{status?.ovSessionId ?? '—'}</code>
            </dd>
            <dt>待提交</dt>
            <dd>
              {status ? `${status.pendingTokens}${status.threshold ? ` / ${status.threshold}` : ''} tokens` : '—'}
            </dd>
            <dt>最近提交</dt>
            <dd>{status?.lastCommitAt ? formatTime(status.lastCommitAt) : '—'}</dd>
            {running.length > 0 ? (
              <>
                <dt>进行中</dt>
                <dd>{running.map((task) => task.status).join(', ')}</dd>
              </>
            ) : null}
          </dl>

          {error ? <div className="ove-facts ove-empty">读取失败：{error}</div> : null}

          {failures.length > 0 ? (
            <div className="ove-section">
              <div className="ove-section-title ove-error">记忆抽取失败 {failures.length} 次</div>
              <div className="ove-empty">归档已写入，但这几次提交的记忆没有被抽取出来。</div>
              {failures.slice(0, 4).map((task) => (
                <div className="ove-failure" key={task.task_id}>
                  <div className="ove-failure-head">
                    <span>{taskTime(task) ?? '—'}</span>
                    <span className="ove-row-count">
                      {durationSeconds(task) !== null ? `${durationSeconds(task)}s` : ''}
                    </span>
                  </div>
                  <div className="ove-failure-msg" title={task.error ?? undefined}>
                    {describeFailure(task)}
                  </div>
                </div>
              ))}
              {failures.length > 4 ? <div className="ove-empty">…另有 {failures.length - 4} 次失败</div> : null}
            </div>
          ) : null}

          <div className="ove-section">
            <div className="ove-section-title">提交记录</div>
            {archives.length === 0 ? (
              <div className="ove-empty">本会话尚无提交。达到 token 阈值或会话结束时自动提交。</div>
            ) : (
              archives.map((archive) => (
                <button
                  key={archive.archiveId}
                  type="button"
                  className="ove-row"
                  onClick={() => void openArchive(archive.archiveUri)}
                >
                  <span>{archive.archiveId}</span>
                  <span className="ove-row-count">查看影响 →</span>
                </button>
              ))
            )}
          </div>

          {diffPending ? <div className="ove-section ove-empty">正在读取 {selected}…</div> : null}
          {diff ? <DiffView diff={diff} /> : null}
          {!diffPending && selected && !diff ? (
            <div className="ove-section ove-empty">该归档还没有 memory_diff.json —— 抽取仍在进行。</div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

function DiffView({ diff }: { diff: MemoryDiff }) {
  const { summary } = diff
  return (
    <div className="ove-section">
      <div className="ove-section-title">
        影响记忆：新增 {summary.totalAdds} · 更新 {summary.totalUpdates} · 删除 {summary.totalDeletes}
      </div>
      <div className="ove-empty">{diff.archiveUri}</div>
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
    case 'errored':
      return '抽取失败'
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

function tooltip(status: CommitStatus | null, error: string | null, failures: CommitTask[]): string {
  if (error) return `OpenViking 读取失败：${error}`
  if (!status) return '正在读取 OpenViking 提交状态'
  const newest = failures[0]
  if (newest) {
    return [
      `最近一次记忆抽取失败：${describeFailure(newest)}`,
      `OpenViking 会话：${status.ovSessionId}`,
      `已提交 ${status.commitCount} 次（其中 ${failures.length} 次抽取失败）`,
    ].join('\n')
  }
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
