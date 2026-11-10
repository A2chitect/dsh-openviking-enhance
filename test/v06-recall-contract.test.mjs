// The context-face wire contract: quota apportionment, optional fields, timeout.
//
// The fixtures under `test/fixtures/recall-wire/` are hand-authored from the
// contract recorded in `src/host/recall-contract.ts` — invented inputs, no real
// server response, no private data. The literal expectations below are a second,
// independent derivation of the same contract: they were computed by hand from
// the weights and the unmet-proportional-demand rule, not read out of the code,
// so a change to the implementation has to disagree with two separate records to
// ship silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  RECALL_QUOTA_WEIGHTS,
  allocateRecallQuotas,
  buildRecallContextBody,
  recallContextTimeoutMs,
} from '../src/host/recall-contract.ts'

const recallServiceSource = readFileSync(new URL('../src/host/recall-service.ts', import.meta.url), 'utf8')
const contractSource = readFileSync(new URL('../src/host/recall-contract.ts', import.meta.url), 'utf8')

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/recall-wire/context-requests.json', import.meta.url), 'utf8'),
)

test('the fixture matrix is derived, not captured', () => {
  assert.equal(fixture.schema, 1)
  assert.match(fixture.derivation, /Hand-authored/)
  assert.equal(fixture.capturedFrom, undefined, 'a capture of a real server must never be committed')
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 20, `expected the ~18-case matrix, saw ${fixture.cases?.length}`)
})

test('the fixture category order is the contract order', () => {
  assert.deepEqual(fixture.categoryOrder, RECALL_QUOTA_WEIGHTS.map((entry) => entry.category))
})

test('every fixture case builds the documented body and timeout', () => {
  for (const item of fixture.cases) {
    const body = buildRecallContextBody({
      query: item.input.query,
      sessionId: item.input.sessionId,
      config: item.input.config,
    })
    assert.deepEqual(body, item.expected.body, `${item.id}: body`)
    const timeout = recallContextTimeoutMs(item.input.config, body)
    assert.equal(timeout ?? null, item.expected.timeoutMs, `${item.id}: timeout`)
  }
})

// Hand-derived allocation table. Derivation, for the record:
//   limit 6  -> base seats only (one per category)
//   limit 8  -> ideals 0.8/1.6/0.8/0.8/2.4/1.6; residual 2;
//               bids 2.4 (resources), 1.6 (entities then skills); resources+1,
//               entities+1 (tie at 1.6 broken by category order)
//   limit 12 -> ideals 1.2/2.4/1.2/1.2/3.6/2.4; residual 6;
//               resources +3, entities +2, skills +1
//   limit 25 -> ideals 2.5/5.0/2.5/2.5/7.5/5.0; residual 19;
//               final counts 3/5/3/2/7/5 (resources 6 residual + base,
//               entities and skills share the next tier by weight, earlier wins)
const HAND_DERIVED = {
  1: { events: 1, entities: 1, preferences: 1, experiences: 1, resources: 1, skills: 1 },
  6: { events: 1, entities: 1, preferences: 1, experiences: 1, resources: 1, skills: 1 },
  8: { events: 1, entities: 2, preferences: 1, experiences: 1, resources: 2, skills: 1 },
  12: { events: 1, entities: 3, preferences: 1, experiences: 1, resources: 4, skills: 2 },
  25: { events: 3, entities: 5, preferences: 3, experiences: 2, resources: 7, skills: 5 },
}

test('the allocation matches the hand-derived table', () => {
  for (const [limit, expected] of Object.entries(HAND_DERIVED)) {
    assert.deepEqual(allocateRecallQuotas(Number(limit)), expected, `limit ${limit}`)
  }
})

test('the allocation has the documented edge behaviour and totals', () => {
  for (let limit = 1; limit <= 64; limit += 1) {
    const quotas = allocateRecallQuotas(limit)
    const keys = Object.keys(quotas)
    assert.deepEqual(keys, RECALL_QUOTA_WEIGHTS.map((entry) => entry.category), 'stable category order')
    assert.equal(
      Object.values(quotas).reduce((sum, value) => sum + value, 0),
      Math.max(limit, keys.length),
      `limit ${limit}: total slots`,
    )
    for (const [category, value] of Object.entries(quotas)) {
      assert.ok(Number.isInteger(value) && value >= 1, `limit ${limit}: ${category} keeps a guaranteed seat`)
    }
  }
})

test('the allocation is deterministic and frozen', () => {
  assert.deepEqual(allocateRecallQuotas(12), allocateRecallQuotas(12))
  assert.equal(Object.isFrozen(allocateRecallQuotas(12)), true, 'callers cannot mutate the shared contract')
  assert.equal(Object.isFrozen(RECALL_QUOTA_WEIGHTS), true)
})

test('a non-finite or fractional limit cannot hang the allocation', () => {
  assert.deepEqual(allocateRecallQuotas(Number.NaN), HAND_DERIVED[1])
  assert.deepEqual(allocateRecallQuotas(Number.POSITIVE_INFINITY), HAND_DERIVED[1])
  assert.deepEqual(allocateRecallQuotas(8.9), HAND_DERIVED[8], 'fractions are floored like every numeric knob')
})

test('the timeout matrix covers none, expansion, rewrite and the explicit override', () => {
  const expansion = { query: 'why', mode: 'context', session_id: 'dsh-s1' }
  const noStages = { ...expansion, session_id: undefined }
  assert.equal(recallContextTimeoutMs(null, expansion), 15_000, 'expansion floor')
  assert.equal(recallContextTimeoutMs(null, { ...expansion, rewrite: true }), 45_000, 'rewrite floor')
  assert.equal(recallContextTimeoutMs(null, { ...expansion, rewrite: 'auto' }), 45_000)
  assert.equal(recallContextTimeoutMs({ timeoutMs: 30_000 }, expansion), 30_000, 'configured timeout raises the floor')
  assert.equal(recallContextTimeoutMs(null, { ...noStages, query_expansion: 'off' }), undefined, 'no stage, no special deadline')
  assert.equal(recallContextTimeoutMs({ recallContextTimeoutMs: 60_000 }, expansion), 60_000)
  assert.equal(recallContextTimeoutMs({ recallContextTimeoutMs: 10 }, expansion), 1000, 'the explicit override has a 1 s floor')
})

test('configured lists are filtered and capped at the documented 200 URIs', () => {
  const excludes = Array.from({ length: 250 }, (_, index) => `viking://fixture/excluded/${index}.md`)
  const body = buildRecallContextBody({
    query: 'why',
    sessionId: 'dsh-s1',
    config: { recallExcludeUris: [...excludes, 42, '', 'viking://fixture/valid'] },
  })
  assert.equal(body.exclude_uris.length, 200)
  assert.equal(body.exclude_uris[0], 'viking://fixture/excluded/0.md')
  assert.equal(body.exclude_uris[199], 'viking://fixture/excluded/199.md')
})

test('rewrite bullets are sent only with a rewrite request', () => {
  const withoutRewrite = buildRecallContextBody({
    query: 'why',
    sessionId: 'dsh-s1',
    config: { recallCompressMaxBullets: 4, recallCompressMaxBulletsConfigured: true },
  })
  assert.equal(withoutRewrite.rewrite, undefined)
  assert.equal(withoutRewrite.rewrite_max_bullets, undefined)
})

test('the mirrored implementation and its provenance wording are gone from the host', () => {
  // The rewrite's observable acceptance: recall-service delegates instead of
  // carrying the old expression, and neither file contains the wording the
  // independence gate bans (the gate itself is scripts/check-independence.mjs).
  assert.ok(!recallServiceSource.includes('codingQuotas'), 'the old mirrored quota helper is gone')
  assert.ok(!/copied from|mirrored exactly/i.test(recallServiceSource), 'no copied/mirrored provenance wording')
  assert.ok(
    recallServiceSource.includes("from './recall-contract.ts'"),
    'the service delegates to the contract module',
  )
  assert.ok(!/copied from|mirrored exactly|buildContextSearchBody/i.test(contractSource), 'the contract module is clean')
  assert.ok(contractSource.includes('Provenance'), 'the contract module states its provenance')
})
