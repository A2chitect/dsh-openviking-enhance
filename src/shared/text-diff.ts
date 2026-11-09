/**
 * A small line diff for one memory's before/after text.
 *
 * The commit browser shows what a commit actually changed, not just the URI it
 * changed. A dependency-free LCS is enough for that: memory bodies are prose or
 * short Markdown, and the diff is bounded so one huge note cannot freeze the
 * popover.
 *
 * The result is presentation-neutral: `same` rows, `add` rows and `remove` rows
 * in display order. `truncated` means the input exceeded the comparison budget
 * and the diff fell back to "all removed, then all added".
 */
export type DiffRowKind = 'same' | 'add' | 'remove'

export interface DiffRow {
  kind: DiffRowKind
  text: string
}

export interface LineDiff {
  rows: DiffRow[]
  /** Inputs exceeded the LCS budget; the rows are a coarse replacement. */
  truncated: boolean
  added: number
  removed: number
}

/** Lines compared before the fallback; 2×250 keeps the DP table small. */
const MAX_DIFF_LINES = 250

/** Split on newlines without inventing a trailing empty line for a final \n. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Line diff of `before` → `after`.
 *
 * For two 250-line bodies the LCS table is 62,500 cells, which is well under a
 * frame. Anything larger is a document, not a memory; it gets a coarse
 * remove-then-add diff and `truncated: true`.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const left = splitLines(before)
  const right = splitLines(after)
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return {
      rows: [
        ...left.map((text) => ({ kind: 'remove' as const, text })),
        ...right.map((text) => ({ kind: 'add' as const, text })),
      ],
      truncated: true,
      added: right.length,
      removed: left.length,
    }
  }

  const rows: DiffRow[] = []
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  )
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0)
    }
  }

  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ kind: 'same', text: left[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      rows.push({ kind: 'remove', text: left[i] ?? '' })
      removed += 1
      i += 1
    } else {
      rows.push({ kind: 'add', text: right[j] ?? '' })
      added += 1
      j += 1
    }
  }
  while (i < left.length) {
    rows.push({ kind: 'remove', text: left[i] ?? '' })
    removed += 1
    i += 1
  }
  while (j < right.length) {
    rows.push({ kind: 'add', text: right[j] ?? '' })
    added += 1
    j += 1
  }
  return { rows, truncated: false, added, removed }
}
