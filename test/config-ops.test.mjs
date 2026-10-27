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

// The three interface switches are booleans the form stages as strings. They must
// reach the host as real booleans: `Boolean('false')` is `true`, so a coercion
// here would silently turn "hide this surface" into "show it".
const BOOLEAN_FIELDS = [
  { key: 'showSidebarEntry', boolean: true },
  { key: 'showCommitStatus', boolean: true },
  { key: 'showRecallPanel', boolean: true },
]

test('a boolean field is submitted as a real boolean, not its string', () => {
  const on = configOps(BOOLEAN_FIELDS, { showSidebarEntry: 'true' })
  assert.deepEqual(on, {
    ok: true,
    ops: [{ op: 'set', path: ['showSidebarEntry'], value: true }],
  })
  const off = configOps(BOOLEAN_FIELDS, { showCommitStatus: 'false' })
  assert.deepEqual(off, {
    ok: true,
    ops: [{ op: 'set', path: ['showCommitStatus'], value: false }],
  })
  // Both values must be booleans on the wire, not the strings that encoded them.
  assert.equal(typeof on.ops[0].value, 'boolean')
  assert.equal(typeof off.ops[0].value, 'boolean')
  // This is the trap the branch exists for: a naive Boolean() would send true.
  assert.notEqual(off.ops[0].value, 'false')
})

test('clearing a boolean field is an unset, restoring the schema default', () => {
  // The form's Default control stages the empty string for every kind of field;
  // for a boolean that is `unset` (the default, on), not a written `false`.
  for (const field of BOOLEAN_FIELDS) {
    assert.deepEqual(configOps(BOOLEAN_FIELDS, { [field.key]: '' }), {
      ok: true,
      ops: [{ op: 'unset', path: [field.key] }],
    })
  }
})

test('a boolean field with any other string is refused, and names the field', () => {
  for (const staged of ['yes', 'TRUE', '1', 'false ', 'on', 'undefined']) {
    const result = configOps(BOOLEAN_FIELDS, { showRecallPanel: staged })
    assert.equal(result.ok, false, `${JSON.stringify(staged)} must be refused`)
    assert.equal(result.field, 'showRecallPanel')
    assert.equal('ops' in result, false, 'nothing is submitted when a field is refused')
  }
})

test('booleans, text and numbers travel together as one atomic list', () => {
  const result = configOps([...FIELDS, ...BOOLEAN_FIELDS], {
    endpoint: 'http://127.0.0.1:1933',
    cacheTtlMs: '3000',
    showSidebarEntry: 'false',
    showRecallPanel: '',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ops, [
    { op: 'set', path: ['endpoint'], value: 'http://127.0.0.1:1933' },
    { op: 'set', path: ['cacheTtlMs'], value: 3000 },
    { op: 'set', path: ['showSidebarEntry'], value: false },
    { op: 'unset', path: ['showRecallPanel'] },
  ])
})

test('one unusable boolean refuses the whole list, not just its own edit', () => {
  // The form submits one atomic mutate: a refused field must keep the caller from
  // writing the other edits, whose revision fence belongs to the same request.
  const result = configOps([...FIELDS, ...BOOLEAN_FIELDS], {
    endpoint: 'http://127.0.0.1:1933',
    showCommitStatus: 'maybe',
  })
  assert.equal(result.ok, false)
  assert.equal(result.field, 'showCommitStatus')
})

test('a boolean field is not parsed as a number, and vice versa', () => {
  // The two kinds share the staged-string surface; each branch must claim only
  // its own fields. A boolean field is not numeric, so 'true' is not Number()d.
  assert.equal(configOps([{ key: 'flag', boolean: true }], { flag: 'true' }).ops[0].value, true)
  // A numeric field still parses even though the form's other fields are booleans.
  const numeric = configOps([{ key: 'ttl', numeric: true }, ...BOOLEAN_FIELDS], { ttl: '2500' })
  assert.deepEqual(numeric.ops, [{ op: 'set', path: ['ttl'], value: 2500 }])
})
