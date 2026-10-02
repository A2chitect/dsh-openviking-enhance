// What the configuration form asks the host to do.
//
// The form stages edits locally and submits them as one atomic operation list;
// these tests pin the three rules that decide what lands in the profile patch —
// clearing is an `unset`, numbers are parsed, and an unusable value is refused
// before a request is made.
import test from 'node:test'
import assert from 'node:assert/strict'

import { configOps } from '../src/client/config-ops.ts'

const FIELDS = [
  { key: 'endpoint' },
  { key: 'studioPath' },
  { key: 'cacheTtlMs', numeric: true },
]

test('a typed value becomes a set at its own path', () => {
  assert.deepEqual(configOps(FIELDS, { endpoint: 'http://127.0.0.1:1933' }), {
    ok: true,
    ops: [{ op: 'set', path: ['endpoint'], value: 'http://127.0.0.1:1933' }],
  })
})

test('clearing a field is an unset, not an empty string', () => {
  // The difference matters: an empty string is a value the schema would accept
  // and the plugin would then read as "no endpoint override"; `unset` restores
  // the composition layer underneath, which is what the Default button means.
  assert.deepEqual(configOps(FIELDS, { endpoint: '' }), {
    ok: true,
    ops: [{ op: 'unset', path: ['endpoint'] }],
  })
})

test('a numeric field is submitted as a number', () => {
  assert.deepEqual(configOps(FIELDS, { cacheTtlMs: '2500' }), {
    ok: true,
    ops: [{ op: 'set', path: ['cacheTtlMs'], value: 2500 }],
  })
  // Whitespace-free parsing still accepts the forms a person types.
  assert.deepEqual(configOps(FIELDS, { cacheTtlMs: '15000' }).ops[0].value, 15000)
})

test('a numeric field that is not a number is refused, and says which', () => {
  const result = configOps(FIELDS, { endpoint: 'http://127.0.0.1:1933', cacheTtlMs: 'soon' })
  assert.equal(result.ok, false)
  assert.equal(result.field, 'cacheTtlMs')
})

test('several edits travel as one list, in staging order', () => {
  const result = configOps(FIELDS, { endpoint: 'http://127.0.0.1:1933', studioPath: '' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ops, [
    { op: 'set', path: ['endpoint'], value: 'http://127.0.0.1:1933' },
    { op: 'unset', path: ['studioPath'] },
  ])
})

test('nothing staged is an empty list, and unknown keys are ignored', () => {
  assert.deepEqual(configOps(FIELDS, {}), { ok: true, ops: [] })
  // A key no field declares is dropped rather than written: the field table is
  // the schema's shape, and guessing at a path could write something undeclared.
  assert.deepEqual(configOps(FIELDS, { nonsense: 'x' }), { ok: true, ops: [] })
})
