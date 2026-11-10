// v1.0 performance / request budgets, enforced rather than asserted in prose.
//
// The design's budgets (v1.0 design §2.3): one composed `/overview` request per
// initial paint with no polling, caches bounded by `limits.ts`, poll timers only
// while a surface is mounted and the document is visible, and fan-outs capped.
// No browser/benchmark dependency: the host composition is a pure service with
// injectable parts, and the poll schedule is a pure function, so the budgets are
// testable from Node exactly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OverviewService } from '../src/host/overview-service.ts'
import { OnboardingStore } from '../src/host/onboarding.ts'
import { nextPollDelay, POLL_ACTIVE_MS, POLL_IDLE_MS, POLL_ERROR_FIRST_MS, POLL_ERROR_MAX_MS } from '../src/client/poll-policy.ts'
import {
  OVERVIEW_CACHE_TTL_MS,
  BROWSE_PAGE_SIZE,
  RECENT_COMMITS_CONCURRENCY,
  RECENT_COMMITS_SESSION_CAP,
} from '../src/shared/limits.ts'
import { readFileSync, readdirSync } from 'node:fs'

const CONFIG = {
  ok: true,
  endpoint: 'http://127.0.0.1:1933',
  studioUrl: 'http://127.0.0.1:1933/studio/',
  version: '0.5.3',
  healthy: false,
  account: 'default',
  user: 'default',
  writesEnabled: false,
  activeProfileId: null,
  authMode: null,
  warnings: [{ code: 'unreachable', params: { endpoint: 'http://127.0.0.1:1933', error: 'down' } }],
}

const SCOPE = {
  identity: {
    profileId: null,
    profileLabel: null,
    endpoint: 'http://127.0.0.1:1933',
    authMode: null,
    account: 'default',
    user: 'default',
    peer: null,
    fingerprint: 'sha256:0000',
  },
  activeProfileId: null,
  role: null,
  version: null,
  healthy: false,
  writes: { enabled: false, transport: false, reason: 'writes-disabled' },
  ops: { enabled: false, transport: false, reason: 'ops-disabled' },
  capabilities: {},
  warnings: [],
  observedAt: '2026-11-10T00:00:00Z',
}

const STUDIO = { url: 'http://127.0.0.1:1933/studio/', frameable: 'unknown', reason: 'probe-failed', detail: null, observedAt: '2026-11-10T00:00:00Z' }

/** One counting fixture for the composed overview. */
function rig(overrides = {}) {
  const calls = { config: 0, scope: 0, metrics: 0, studio: 0 }
  let clock = 0
  const store = new OnboardingStore({ dir: mkdtempSync(join(tmpdir(), 'ove-v10-perf-')) })
  const service = new OverviewService({
    config: async () => {
      calls.config += 1
      return CONFIG
    },
    scope: async () => {
      calls.scope += 1
      return SCOPE
    },
    metrics: async () => {
      calls.metrics += 1
      return null
    },
    plugin: () => ({ mounted: false, version: null }),
    studio: async () => {
      calls.studio += 1
      return STUDIO
    },
    onboarding: store,
    onboardingEnabled: () => false,
    now: () => clock,
    ...overrides,
  })
  return { service, calls, advance: (ms) => (clock += ms) }
}

test('the composed Overview is one payload with a single call per part', async () => {
  const { service, calls } = rig()
  const payload = await service.overview()
  assert.equal(payload.parts.config.available, true)
  assert.equal(payload.parts.scope.available, true)
  assert.equal(payload.parts.metrics.available, true)
  assert.deepEqual(calls, { config: 1, scope: 1, metrics: 1, studio: 1 }, 'each part is gathered once')
  assert.equal(payload.warnings.length >= 1, true, 'degraded parts surface as warnings, not a blank page')
})

test('two concurrent paints share one in-flight composition (no duplicate fan-out)', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service, calls } = rig({
    config: async () => {
      calls.config += 1
      await gate
      return CONFIG
    },
  })
  const first = service.overview()
  const second = service.overview()
  release()
  await Promise.all([first, second])
  assert.equal(calls.config, 1, 'the in-flight composition is shared')
  assert.equal(calls.scope, 1)
  assert.equal(calls.studio, 1)
})

test('paints are cached for the documented TTL and fresh=1 bypasses it', async () => {
  const { service, calls, advance } = rig()
  await service.overview()
  await service.overview()
  assert.equal(calls.config, 1, 'a repaint inside the TTL is free')
  advance(OVERVIEW_CACHE_TTL_MS - 1)
  await service.overview()
  assert.equal(calls.config, 1, 'still inside the TTL')
  advance(2)
  await service.overview()
  assert.equal(calls.config, 2, 'the TTL expires and the next paint recomposes')
  await service.overview(true)
  assert.equal(calls.config, 3, 'fresh=1 bypasses the cache')
  service.resetCaches()
  await service.overview()
  assert.equal(calls.config, 4, 'an identity switch drops the composition')
})

test('a failing part degrades that card only, never the composed answer', async () => {
  const { service } = rig({
    studio: async () => {
      throw new Error('studio probe exploded')
    },
  })
  const payload = await service.overview()
  assert.equal(payload.parts.studio.available, false)
  assert.match(String(payload.parts.studio.error), /studio probe exploded/)
  assert.equal(payload.parts.config.available, true, 'other parts still answered')
})

test('the poll schedule pauses when hidden and backs off after failures', () => {
  assert.equal(nextPollDelay({ working: true, hidden: true, errorCount: 0 }), 0, 'hidden document: no timer at all')
  assert.equal(nextPollDelay({ working: false, hidden: true, errorCount: 7 }), 0, 'hidden wins over every other state')
  assert.equal(nextPollDelay({ working: true, hidden: false, errorCount: 0 }), POLL_ACTIVE_MS)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 0 }), POLL_IDLE_MS)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 1 }), POLL_ERROR_FIRST_MS)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 2 }), POLL_ERROR_FIRST_MS * 2)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 99 }), POLL_ERROR_MAX_MS)
})

test('every recurring request goes through the visibility-gated interval', () => {
  // `poll-policy.ts` is the only module allowed to own an interval; components
  // use `startVisibleInterval`, whose timer does not exist while the document is
  // hidden. A bare `setInterval` in a component would spend requests on a
  // hidden panel — the budget forbids that.
  const dir = new URL('../src/client/', import.meta.url)
  const offenders = []
  for (const name of readdirSync(dir)) {
    if (name === 'poll-policy.ts') continue
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const source = readFileSync(new URL(name, dir), 'utf8')
    if (/\bsetInterval\s*\(/.test(source)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `intervals must come from startVisibleInterval: ${offenders.join(', ')}`)
  const policy = readFileSync(new URL('../src/client/poll-policy.ts', import.meta.url), 'utf8')
  assert.match(policy, /export function startVisibleInterval/)
  assert.match(policy, /visibilityState === 'hidden'/)
  assert.match(policy, /\n  start\(\)/)
})

test('the documented fan-out/cache budgets are the shipped constants', () => {
  assert.equal(BROWSE_PAGE_SIZE, 50, 'Browse pages are 50 rows')
  assert.equal(RECENT_COMMITS_SESSION_CAP, 8, 'recent-commits fan-out is capped at 8 sessions')
  assert.equal(RECENT_COMMITS_CONCURRENCY, 4, 'and at 4 in flight')
  assert.equal(OVERVIEW_CACHE_TTL_MS, 5_000, 'the composed overview cache is 5 s')
  // The client asks the host for the composed Overview with one call per paint.
  const overview = readFileSync(new URL('../src/client/native-overview.tsx', import.meta.url), 'utf8')
  assert.equal((overview.match(/fetchOverview\(/g) ?? []).length, 1, 'one fetchOverview call per refresh cycle')
})
