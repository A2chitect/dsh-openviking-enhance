/**
 * The commit-diff type filter, as a pure function.
 *
 * The filter is a browsing aid over one commit's already-loaded diff: it never
 * refetches and never touches status. `DiffView` renders the four stateful
 * buttons (a filter group with `aria-pressed`, not a tab strip — the list is
 * replaced rather than swapped for a persistent panel), and this module owns the
 * selection math so it can be unit-tested without a DOM.
 */
import type { MemoryDiffEntry } from '../shared/protocol.ts'

/** One diff-type bucket as the server returns it (groups with their titles). */
export type DiffFilter = 'all' | 'adds' | 'updates' | 'deletes'

export interface DiffGroup {
  key: 'adds' | 'updates' | 'deletes'
  title: string
  entries: MemoryDiffEntry[]
}

/**
 * Filter the rendered groups by the selected bucket.
 *
 * `'all'` keeps every group (a copy, so callers cannot mutate the input), and a
 * specific key keeps only that group — an unknown/empty bucket yields `[]`, which
 * the caller renders as the "nothing in this filter" state.
 */
export function filterDiffGroups(groups: readonly DiffGroup[], filter: DiffFilter): DiffGroup[] {
  if (filter === 'all') return [...groups]
  return groups.filter((group) => group.key === filter)
}
