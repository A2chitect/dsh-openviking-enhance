// The commit-diff type filter is a pure selection over already-loaded groups.
//
// This file exists because the a11y refactor that turned the diff filter from a
// tablist into a filter group dropped its click handler: SSR cannot see handlers,
// so the only automated guard is (a) the pure selection math and (b) a source
// assertion that the rendered buttons are actually wired. Together they make the
// regression (buttons that look pressed but do nothing) fail loudly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { filterDiffGroups } from '../src/client/diff-filter.ts'

function group(key, entries) {
  return { key, title: `${key} title`, entries }
}

const GROUPS = [
  group('adds', [{ uri: 'viking://memories/a.md' }]),
  group('updates', [{ uri: 'viking://memories/b.md' }]),
  group('deletes', [{ uri: 'viking://memories/c.md' }]),
]

test('the "deletes" filter keeps only the delete group (B1 regression)', () => {
  const visible = filterDiffGroups(GROUPS, 'deletes')
  assert.equal(visible.length, 1)
  assert.equal(visible[0].key, 'deletes')
  assert.deepEqual(visible[0].entries.map((entry) => entry.uri), ['viking://memories/c.md'])
})

test('each specific filter selects exactly its own bucket', () => {
  for (const key of ['adds', 'updates', 'deletes']) {
    const visible = filterDiffGroups(GROUPS, key)
    assert.deepEqual(visible.map((entry) => entry.key), [key])
  }
})

test('"all" keeps every group, in order, without exposing the input array', () => {
  const visible = filterDiffGroups(GROUPS, 'all')
  assert.deepEqual(visible.map((entry) => entry.key), ['adds', 'updates', 'deletes'])
  assert.notEqual(visible, GROUPS, 'a copy is returned so callers cannot mutate the source')
  visible.pop()
  assert.equal(GROUPS.length, 3)
})

test('an empty bucket yields the empty state, not the full list', () => {
  const empty = [
    group('adds', []),
    group('updates', []),
    group('deletes', []),
  ]
  assert.deepEqual(filterDiffGroups(empty, 'updates').map((entry) => entry.entries.length), [0])
  assert.deepEqual(filterDiffGroups([], 'all'), [])
})

test('the diff-filter buttons are wired to the state setter (the handler cannot vanish again)', () => {
  // Redundant with the component by design: the regression was a swallowed
  // handler, which no SSR/unit test can observe. This guard pins the interaction.
  const source = readFileSync(new URL('../src/client/commit-status.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ filterDiffGroups, type DiffFilter, type DiffGroup \} from '\.\/diff-filter\.ts'/)
  assert.doesNotMatch(source, /filter === 'all' \? groups : groups\.filter/, 'the inline filtering moved to the pure helper')
  assert.equal((source.match(/onClick=\{\(\) => setFilter\(candidate\)\}/g) ?? []).length, 1, 'every filter button calls setFilter')
  assert.equal((source.match(/aria-pressed=\{filter === candidate\}/g) ?? []).length, 1)
})
