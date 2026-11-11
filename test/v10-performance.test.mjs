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
import {
  nextPollDelay,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  POLL_ERROR_FIRST_MS,
  POLL_ERROR_MAX_MS,
  startScheduledPoll,
} from '../src/client/poll-policy.ts'
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

/**
 * A fake scheduler: records timers, runs them on demand, and lets the test flip
 * the document between visible/hidden. This is the "fake clock" the review asked
 * for: the hidden-tab zero-schedule property is asserted behaviourally, not by a
 * regex over the source.
 */
function fakeScheduler(options = {}) {
  const state = { hidden: options.hidden === true, timers: [], nextId: 1 }
  const listeners = new Set()
  const scheduler = {
    setTimeout: (callback, delayMs) => {
      const handle = { id: state.nextId++, callback, delayMs }
      state.timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      const index = state.timers.indexOf(handle)
      if (index >= 0) state.timers.splice(index, 1)
    },
    isHidden: () => state.hidden,
    onVisibilityChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    scheduler,
    state,
    /** Number of timers created so far (including already-fired/cleared ones). */
    created: () => state.nextId - 1,
    pending: () => state.timers.length,
    advance(ms) {
      const due = state.timers.filter((timer) => timer.delayMs <= ms)
      state.timers = state.timers.filter((timer) => timer.delayMs > ms)
      for (const timer of due) timer.callback()
    },
    setHidden(hidden) {
      state.hidden = hidden
      for (const listener of listeners) listener()
    },
  }
}

test('the scheduler creates no timer at all while the tab is hidden (review N1)', async () => {
  const clock = fakeScheduler({ hidden: true })
  let loads = 0
  const dispose = startScheduledPoll(() => {
    loads += 1
  }, () => POLL_ACTIVE_MS, clock.scheduler)
  assert.equal(clock.created(), 0, 'hidden mount schedules nothing (0 is "do not schedule")')
  assert.equal(loads, 0)
  // Becoming visible resumes with an immediate load and then the active cadence.
  clock.setHidden(false)
  await Promise.resolve()
  assert.equal(loads, 1, 'visibility resume loads immediately')
  assert.equal(clock.created(), 1)
  assert.equal(clock.pending(), 1)
  assert.equal(clock.state.timers[0].delayMs, POLL_ACTIVE_MS)
  // Hiding again clears the pending timer; no self-loop can survive.
  clock.setHidden(true)
  assert.equal(clock.pending(), 0, 'hiding the tab clears the timer')
  assert.equal(clock.created(), 1, 'no new timer was created while hidden')
  dispose()
})

test('a zero policy delay stops the loop instead of becoming setTimeout(0) (review N1)', async () => {
  const clock = fakeScheduler()
  let loads = 0
  let delay = 0
  const dispose = startScheduledPoll(() => {
    loads += 1
  }, () => delay, clock.scheduler)
  assert.equal(clock.created(), 0, 'delay 0 means "do not schedule"')
  assert.equal(loads, 0)
  delay = 5000
  clock.setHidden(true)
  clock.setHidden(false)
  await Promise.resolve()
  assert.equal(clock.created(), 1, 'an event can resume a stopped loop')
  dispose()
})

test('the loop recomputes the delay after every load, so a running task switches to the 5 s cadence (review S2)', async () => {
  const clock = fakeScheduler()
  const facts = { working: false, errorCount: 0 }
  const delivered = []
  const dispose = startScheduledPoll(
    () => {
      delivered.push(clock.pending())
      // The activity panel writes the fresh "working" fact here (a ref), and the
      // scheduler reads it only after the load resolves.
      if (delivered.length === 1) facts.working = true
    },
    () => nextPollDelay({ working: facts.working, hidden: false, errorCount: facts.errorCount }),
    clock.scheduler,
  )
  assert.equal(clock.state.timers.length, 1)
  assert.equal(clock.state.timers[0].delayMs, POLL_IDLE_MS, 'first schedule has no tasks yet')
  clock.advance(POLL_IDLE_MS)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clock.state.timers.length, 1)
  assert.equal(clock.state.timers[0].delayMs, POLL_ACTIVE_MS, 'a running task switches the next delay to 5 s')
  dispose()
})

test('immediate start loads before scheduling, so the first cadence uses fresh facts (review round 2)', async () => {
  const clock = fakeScheduler()
  const facts = { working: false }
  let loads = 0
  const dispose = startScheduledPoll(
    () => {
      loads += 1
      facts.working = true
    },
    () => nextPollDelay({ working: facts.working, hidden: false, errorCount: 0 }),
    clock.scheduler,
    { immediate: true },
  )
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(loads, 1, 'the first load runs immediately')
  assert.equal(clock.pending(), 1)
  assert.equal(clock.state.timers[0].delayMs, POLL_ACTIVE_MS, 'the first schedule already uses the running-task cadence')
  // Hidden mount: immediate must not bypass the no-timer/no-load guarantee.
  const hiddenClock = fakeScheduler({ hidden: true })
  let hiddenLoads = 0
  const hiddenDispose = startScheduledPoll(() => {
    hiddenLoads += 1
  }, () => POLL_ACTIVE_MS, hiddenClock.scheduler, { immediate: true })
  await Promise.resolve()
  assert.equal(hiddenLoads, 0)
  assert.equal(hiddenClock.created(), 0)
  hiddenDispose()
  dispose()
})

test('only poll-policy may own a recurring timer, and the polling consumers use the scheduler', () => {
  // Structural guard for review S5: the old regex only saw setInterval, so a
  // recursive setTimeout loop (N1) slipped through. Non-polling timers are
  // allow-listed explicitly with their reason; the two polling consumers must
  // not own timers and must import the scheduler.
  const dir = new URL('../src/client/', import.meta.url)
  const NON_POLLING_TIMERS = {
    'host-api.ts': 'one-shot URL.revokeObjectURL cleanup',
    'index.tsx': 'bounded deep-link retry (3 attempts)',
    'native-sessions.tsx': 'one-shot "copied" feedback',
    'scope-chip.tsx': 'one-shot notice countdown re-render',
    'commit-status.tsx': 'one-shot URL.revokeObjectURL cleanup (the poll loop uses the scheduler)',
  }
  const timerPattern = /(?:window\.)?(?:setTimeout|setInterval)\s*\(/
  const offenders = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    if (name === 'poll-policy.ts') continue
    const source = readFileSync(new URL(name, dir), 'utf8')
    if (timerPattern.test(source) && NON_POLLING_TIMERS[name] === undefined) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `unreviewed timer ownership: ${offenders.join(', ')}`)
  for (const consumer of ['activity-panel.tsx', 'commit-status.tsx']) {
    const source = readFileSync(new URL(consumer, dir), 'utf8')
    assert.match(source, /startScheduledPoll/, `${consumer} uses the shared scheduler`)
    // The reviewed failure pattern: a poll loop that schedules its own timer
    // (N1's `setTimeout(() => void load(), nextPollDelay(...))`).
    assert.doesNotMatch(source, /setTimeout\(\s*\(\)\s*=>\s*void\s+(load|run)\(/, `${consumer} owns no polling timer`)
    assert.match(source, /nextPollDelay\(/, `${consumer} feeds the shared policy through the scheduler`)
  }
  const policy = readFileSync(new URL('poll-policy.ts', dir), 'utf8')
  assert.match(policy, /export function startScheduledPoll/)
  assert.match(policy, /export function startVisibleInterval/)
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
