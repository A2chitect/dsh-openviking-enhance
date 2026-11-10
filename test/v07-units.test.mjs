// Unit tests for the v0.7 "Native I" shared contract.
//
// Pure modules only: the `viking://` path classifier/allowlist, the browse row
// normalizers, the Studio frameability classifier, the onboarding state
// validation, and the limits the READMEs document. These are the layers both
// halves depend on, so a drift here would be silent in the UI.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BROWSE_URI_MAX_CHARS,
  browseEntryKind,
  classifyVikingUri,
  dshSessionIdOf,
  isAllowedBrowseUri,
  isVikingUri,
  normalizeVikingUri,
  ovSessionIdOf,
  sessionKindOf,
  tailOf,
} from '../src/shared/viking-tree.ts'
import {
  normalizeBrowseEntry,
  normalizeSubtreeEntry,
} from '../src/host/browse-service.ts'
import {
  classifyStudioProbe,
  parseCspFrameAncestors,
} from '../src/host/studio-status.ts'
import {
  computeOnboardingChecks,
  freshOnboardingState,
  normalizeOnboardingState,
  parseOnboardingUpdate,
} from '../src/host/onboarding.ts'
import * as limits from '../src/shared/limits.ts'
import {
  getNativeState,
  navigate,
  back,
  forward,
  resetNative,
  setNativeSwitches,
  __setNativeStateForTests,
  __setNativeLayoutForTests,
  canSelectPanel,
  openNative,
} from '../src/client/native-store.ts'

/* ========================================================================
 * viking:// classification
 * ===================================================================== */

test('classifyVikingUri maps each viking:// family to a kind, scope and root', () => {
  const cases = [
    ['viking://user/default/memories', 'memory', 'user', 'memories'],
    ['viking://user/default/memories/preferences/tools.md', 'memory', 'user', 'memories'],
    ['viking://user/default/memories/rules/always-test.md', 'rule', 'user', 'rules'],
    ['viking://user/default/memories/rules', 'rule', 'user', 'rules'],
    ['viking://user/default/resources', 'resource', 'user', 'myResources'],
    ['viking://user/default/skills/notes', 'skill', 'user', 'skills'],
    ['viking://resources/team/shared.md', 'resource', 'account', 'resources'],
    ['viking://resources', 'resource', 'account', 'resources'],
    ['viking://agent/skills/pdf/SKILL.md', 'skill', 'agent', 'agentSkills'],
    ['viking://user/default/peers/peer-1/memories/x.md', 'memory', 'peer', 'peers'],
    ['viking://user/default/sessions/dsh-s1', 'session', 'session', 'sessions'],
    ['viking://user/default/sessions/dsh-s1/history', 'file', 'session', 'sessions'],
    ['viking://user/default/sessions/dsh-s1/history/archive_001', 'archive', 'session', 'sessions'],
    ['viking://user/default/sessions/dsh-s1/messages.jsonl', 'file', 'session', 'sessions'],
    ['viking://user/default/unknown-thing', 'file', 'user', null],
  ]
  for (const [uri, kind, scope, rootId] of cases) {
    const facts = classifyVikingUri(uri)
    assert.equal(facts.kind, kind, `${uri}: kind`)
    assert.equal(facts.scope, scope, `${uri}: scope`)
    assert.equal(facts.rootId, rootId, `${uri}: rootId`)
  }
  assert.equal(classifyVikingUri('not-a-uri').kind, 'unknown', 'malformed uris classify as unknown')
  assert.equal(classifyVikingUri('viking://queue/job-1').scope, 'unknown', 'the internal queue scope is never user scope')
})

test('normalizeVikingUri collapses duplicate/trailing slashes and preserves the root', () => {
  assert.equal(normalizeVikingUri(' viking://user/default/memories/ '), 'viking://user/default/memories')
  assert.equal(normalizeVikingUri('viking://user//default///memories'), 'viking://user/default/memories')
  assert.equal(normalizeVikingUri('viking://'), 'viking://')
  assert.equal(normalizeVikingUri('https://example.com/x'), 'https://example.com/x')
  assert.equal(tailOf('viking://user/default/memories/preferences/tools.md'), 'tools.md')
  assert.equal(tailOf('viking://'), '')
  assert.equal(isVikingUri('viking://resources'), true)
  assert.equal(isVikingUri('viking:/resources'), false)
})

test('the browse URI allowlist refuses internal scopes and unsafe paths', () => {
  for (const uri of [
    'viking://user/default/memories',
    'viking://resources',
    'viking://agent/skills',
    'viking://user/default/sessions/dsh-s1',
  ]) {
    assert.equal(isAllowedBrowseUri(uri), true, `${uri} is readable`)
  }
  for (const uri of [
    'viking://queue/thing',
    'viking://temp/x',
    'viking://system/x',
    'viking://upload/x',
    'viking://session/dsh-s1',
    'viking://sessions/dsh-s1',
    'viking://user/default/memories?x=1',
    'viking://user/default/memories#frag',
    'viking://user/default/../queue/x',
    'viking://user/default/memories/./x',
    'viking://user/default/a b',
    'http://127.0.0.1:1933/api/v1/fs/ls',
    '',
    `viking://user/default/${'x'.repeat(BROWSE_URI_MAX_CHARS)}`,
  ]) {
    assert.equal(isAllowedBrowseUri(uri), false, `${JSON.stringify(uri.slice(0, 60))} is refused`)
  }
})

test('directories keep their meaning only where the tree model has one', () => {
  const session = 'viking://user/default/sessions/dsh-s1'
  assert.equal(browseEntryKind(session, true), 'session')
  assert.equal(browseEntryKind(`${session}/history`, true), 'directory')
  assert.equal(browseEntryKind(`${session}/history/archive_001`, true), 'archive')
  assert.equal(browseEntryKind('viking://user/default/peers/peer-1', true), 'agent')
  assert.equal(browseEntryKind('viking://user/default/memories/preferences', true), 'directory')
  assert.equal(browseEntryKind('viking://user/default/memories/preferences/tools.md', false), 'memory')
})

test('session harness classification and the DSH addressability rule', () => {
  assert.equal(sessionKindOf('dsh-session-abc'), 'dsh')
  assert.equal(sessionKindOf('dsh-abc'), 'dsh')
  assert.equal(sessionKindOf('local-runner-1'), 'local')
  assert.equal(sessionKindOf('something-else'), 'other')
  assert.equal(dshSessionIdOf('dsh-abc'), 'abc')
  assert.equal(dshSessionIdOf('local-x'), null, 'another harness is not addressable by this plugin')
  assert.equal(dshSessionIdOf('dsh-'), null, 'an empty id is not an id')
  assert.equal(ovSessionIdOf('abc'), 'dsh-abc')
  assert.equal(ovSessionIdOf('dsh-abc'), 'dsh-abc')
})

/* ========================================================================
 * Browse normalization
 * ===================================================================== */

const LONG_ABSTRACT = 'x'.repeat(400)

test('a directory page row is normalized and its abstract is capped', () => {
  const row = normalizeBrowseEntry({
    uri: 'viking://user/default/memories/preferences/tools.md',
    isDir: false,
    size: 42,
    modTime: '2026-11-10T00:00:00Z',
    abstract: LONG_ABSTRACT,
    tags: ['env=prod', '', 7, 'team=a', 'b', 'c', 'd'],
  })
  assert.ok(row)
  assert.equal(row.uri, 'viking://user/default/memories/preferences/tools.md')
  assert.equal(row.name, 'tools.md')
  assert.equal(row.kind, 'memory')
  assert.equal(row.isDir, false)
  assert.equal(row.size, 42)
  assert.equal(row.abstract.length, limits.BROWSE_ABSTRACT_MAX_CHARS)
  assert.deepEqual(row.tags, ['env=prod', 'team=a', 'b', 'c', 'd'], 'invalid/blank tags are dropped and the list is bounded')
  assert.equal(normalizeBrowseEntry({ uri: 'viking://queue/x', isDir: false }), null, 'internal scopes are refused host-side too')
  assert.equal(normalizeBrowseEntry(null), null)
})

test('a subtree row carries relPath and depth for the flattened list', () => {
  const entry = normalizeSubtreeEntry('viking://user/default/memories', {
    uri: 'viking://user/default/memories/preferences/tools.md',
    isDir: false,
    size: 10,
    modTime: '2026-11-10T00:00:00Z',
    rel_path: 'preferences/tools.md',
    level: 2,
  })
  assert.ok(entry)
  assert.equal(entry.relPath, 'preferences/tools.md')
  assert.equal(entry.depth, 2)
  assert.equal(entry.name, 'tools.md')
  assert.equal(entry.kind, 'memory')
})

/* ========================================================================
 * Studio frameability classification
 * ===================================================================== */

function headerMap(entries) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]))
  return { get: (name) => map.get(name.toLowerCase()) ?? null }
}

function probe(status, headers = {}, error = null) {
  return classifyStudioProbe({ status, headers: headerMap(headers), error })
}

test('X-Frame-Options blocks embedding and is classified honestly', () => {
  assert.deepEqual(probe(200, { 'x-frame-options': 'DENY' }), { frameable: 'no', reason: 'x-frame-options', detail: 'DENY' })
  // SAMEORIGIN blocks the GUI's different port too: a different origin.
  assert.deepEqual(probe(200, { 'x-frame-options': 'SAMEORIGIN' }), { frameable: 'no', reason: 'x-frame-options', detail: 'SAMEORIGIN' })
  const allowFrom = probe(200, { 'x-frame-options': 'ALLOW-FROM https://gui.example' })
  assert.equal(allowFrom.frameable, 'unknown', 'ALLOW-FROM is ignored by browsers; do not claim it works')
})

test('CSP frame-ancestors is parsed and classified', () => {
  assert.deepEqual(parseCspFrameAncestors("default-src 'self'; frame-ancestors 'self'"), ["'self'"])
  assert.equal(parseCspFrameAncestors('default-src self'), null)
  assert.deepEqual(probe(200, { 'content-security-policy': "frame-ancestors 'none'" }), {
    frameable: 'no',
    reason: 'csp-frame-ancestors',
    detail: 'frame-ancestors none',
  })
  assert.equal(probe(200, { 'content-security-policy': "frame-ancestors 'self'" }).frameable, 'no')
  assert.equal(
    probe(200, { 'content-security-policy': 'frame-ancestors *' }).frameable,
    'unknown',
    'a wildcard may work; the host cannot verify the GUI origin, so it says unknown',
  )
  assert.equal(
    probe(200, { 'content-security-policy': 'frame-ancestors https://gui.example' }).frameable,
    'unknown',
    'an explicit origin list cannot be compared to the unknown GUI origin',
  )
})

test('the remaining probe answers keep their documented classification', () => {
  assert.deepEqual(probe(200), { frameable: 'yes', reason: 'ok', detail: null })
  assert.deepEqual(probe(401), { frameable: 'unknown', reason: 'auth-required', detail: 'HTTP 401' })
  assert.deepEqual(probe(403), { frameable: 'unknown', reason: 'auth-required', detail: 'HTTP 403' })
  assert.deepEqual(probe(500), { frameable: 'unknown', reason: 'http-error', detail: 'HTTP 500' })
  assert.deepEqual(probe(0, {}, 'timeout'), { frameable: 'unknown', reason: 'probe-failed', detail: 'timeout' })
})

/* ========================================================================
 * Onboarding state + checks
 * ===================================================================== */

test('a missing/corrupt onboarding state is a clean first run, never an error', () => {
  assert.deepEqual(normalizeOnboardingState(null), freshOnboardingState())
  assert.deepEqual(normalizeOnboardingState('nope'), freshOnboardingState())
  assert.deepEqual(normalizeOnboardingState({ version: 99 }), freshOnboardingState())
  const valid = {
    version: 1,
    dismissedAt: '2026-11-10T00:00:00.000Z',
    completedStepIds: ['health', 'not-a-step', 'health'],
    lastOpenedAt: '2026-11-10T00:01:00.000Z',
    lastFullCheck: { at: '2026-11-10T00:02:00.000Z', ok: 9, warn: 2, error: 1 },
  }
  assert.deepEqual(normalizeOnboardingState(valid), {
    version: 1,
    dismissedAt: '2026-11-10T00:00:00.000Z',
    completedStepIds: ['health'],
    lastOpenedAt: '2026-11-10T00:01:00.000Z',
    lastFullCheck: { at: '2026-11-10T00:02:00.000Z', ok: 9, warn: 2, error: 1 },
  })
  const oversized = normalizeOnboardingState({ ...valid, lastFullCheck: { at: 'x', ok: -1, warn: 2, error: 1 } })
  assert.equal(oversized.lastFullCheck, null, 'an invalid full-check record is dropped, not coerced')
})

test('the onboarding POST validator accepts exactly the documented actions', () => {
  assert.deepEqual(parseOnboardingUpdate({ action: 'dismiss' }), { ok: true, update: { action: 'dismiss' } })
  assert.deepEqual(parseOnboardingUpdate({ action: 'reset' }), { ok: true, update: { action: 'reset' } })
  assert.deepEqual(parseOnboardingUpdate({ action: 'complete-step', stepId: 'health' }), {
    ok: true,
    update: { action: 'complete-step', stepId: 'health' },
  })
  assert.equal(parseOnboardingUpdate({ action: 'complete-step', stepId: 'nope' }).ok, false)
  assert.equal(parseOnboardingUpdate({ action: 'dismiss-all' }).ok, false)
  assert.deepEqual(parseOnboardingUpdate({ action: 'full-check', ok: 1, warn: 2, error: 3 }), {
    ok: true,
    update: { action: 'full-check', ok: 1, warn: 2, error: 3 },
  })
  assert.equal(parseOnboardingUpdate({ action: 'full-check', ok: -1, warn: 2, error: 3 }).ok, false)
  assert.equal(parseOnboardingUpdate({ action: 'full-check', ok: '1', warn: 2, error: 3 }).ok, false)
  assert.equal(parseOnboardingUpdate({ action: 'full-check', ok: 1, warn: 2, error: 1e9 }).ok, false)
})

test('the cheap checks derive every step from the composed overview parts', () => {
  const config = {
    ok: true,
    endpoint: 'http://127.0.0.1:1933',
    studioUrl: 'http://127.0.0.1:1933/studio/',
    version: '0.5.3',
    healthy: true,
    account: 'default',
    user: 'default',
    warnings: [],
  }
  const scope = {
    identity: {
      profileId: null,
      profileLabel: null,
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      account: 'default',
      user: 'default',
      peer: null,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    },
    activeProfileId: null,
    role: 'ROOT',
    version: '0.5.3',
    healthy: true,
    writes: { enabled: false, transport: false, reason: 'writes-disabled' },
    capabilities: {
      health: { available: true, detail: null },
      identity: { available: true, detail: null },
      tasks: { available: true, detail: null },
      rules: { available: true, detail: null },
    },
    warnings: [],
    observedAt: '2026-11-10T00:00:00Z',
  }
  const metrics = {
    sessionId: null,
    dashboard: { available: true, error: null, files: 1, skills: 1, memories: 2, total: 4, todayTokens: 5, todayRetrievals: 6 },
    queue: { available: true, error: null, queues: [] },
    memories: { available: true, error: null, total: 2, byCategory: {}, hotness: {}, stale7d: null, stale30d: null, oldestDays: null },
    session: { available: false, error: 'no-session', sessionId: null, totalTurns: null, memoriesExtracted: null },
    prometheus: false,
    warnings: [],
    observedAt: '2026-11-10T00:00:00Z',
  }
  const healthy = computeOnboardingChecks({
    config,
    scope,
    metrics,
    plugin: { mounted: true, version: '0.3.1', peer: null, peerSource: null },
    studio: { url: 'http://127.0.0.1:1933/studio/', frameable: 'yes', reason: 'ok', detail: null, observedAt: 'x' },
  })
  assert.deepEqual(
    healthy.map((check) => [check.id, check.status]),
    [
      ['endpoint', 'ok'],
      ['health', 'ok'],
      ['identity', 'ok'],
      ['memoryPlugin', 'ok'],
      ['capabilities', 'ok'],
      ['firstStep', 'ok'],
    ],
  )
  assert.equal(healthy[0].hintKey, null)
  assert.deepEqual(healthy[5].hintKey, 'onboarding.firstStep.browse')

  const unreachable = computeOnboardingChecks({
    config: { ...config, healthy: false, version: null, warnings: [{ code: 'unreachable', params: { endpoint: 'x', error: 'ECONNREFUSED' } }] },
    scope: null,
    metrics: null,
    plugin: { mounted: false, version: null, peer: null, peerSource: null },
    studio: null,
  })
  assert.deepEqual(
    unreachable.map((check) => [check.id, check.status]),
    [
      ['endpoint', 'error'],
      ['health', 'error'],
      ['identity', 'unknown'],
      ['memoryPlugin', 'warn'],
      ['capabilities', 'unknown'],
      ['firstStep', 'ok'],
    ],
  )
  assert.equal(unreachable[5].hintKey, 'onboarding.firstStep.studio', 'no fs and no metrics falls back to Studio')
})

/* ========================================================================
 * The native store: history bounds and the layout bridge
 * ===================================================================== */

test('navigation history is bounded, deduped and supports back/forward', () => {
  resetNative()
  assert.equal(getNativeState().view, 'overview')
  navigate({ view: 'sessions' })
  navigate({ view: 'commits' })
  navigate({ view: 'stats' })
  assert.equal(getNativeState().history.length, 4)
  assert.equal(back(), true)
  assert.equal(getNativeState().view, 'commits')
  assert.equal(forward(), true)
  assert.equal(getNativeState().view, 'stats')
  // A new navigation truncates the forward entries.
  navigate({ view: 'browse', browse: { uri: 'viking://user/default/memories' } })
  assert.equal(getNativeState().history.length, 5)
  assert.equal(getNativeState().view, 'browse')
  assert.equal(getNativeState().target.browse?.uri, 'viking://user/default/memories')
  // Deduping the exact same target does not grow the history.
  const before = getNativeState().history.length
  navigate({ view: 'browse', browse: { uri: 'viking://user/default/memories' } })
  assert.equal(getNativeState().history.length, before)
  // The history is capped at NATIVE_HISTORY_MAX.
  for (let index = 0; index < 40; index += 1) {
    navigate({ view: index % 2 === 0 ? 'sessions' : 'commits' })
  }
  assert.equal(getNativeState().history.length, limits.NATIVE_HISTORY_MAX)
  resetNative()
  assert.equal(getNativeState().view, 'overview')
})

test('the layout bridge is capability-detected and never auto-steals by itself', () => {
  __setNativeLayoutForTests(null)
  assert.equal(canSelectPanel(), false)
  assert.equal(openNative({ view: 'overview' }), 'preview', 'no layout action means the preview-tab fallback')
  const calls = []
  __setNativeLayoutForTests({ selectPanel: (id) => calls.push(id) })
  assert.equal(canSelectPanel(), true)
  assert.equal(openNative({ view: 'sessions' }), 'panel')
  assert.deepEqual(calls, ['openviking'])
  // A throwing shell must not take the click down.
  __setNativeLayoutForTests({ selectPanel: () => { throw new Error('no such panel') } })
  assert.equal(openNative({ view: 'overview' }), 'preview')
  __setNativeLayoutForTests(null)
})

test('the presentation switches are independent of the history', () => {
  resetNative()
  navigate({ view: 'stats' })
  setNativeSwitches({ nativeViews: false })
  assert.equal(getNativeState().switches.nativeViews, false)
  assert.equal(getNativeState().switches.onboarding, true, 'the other switch is untouched')
  assert.equal(getNativeState().view, 'stats', 'the last view survives the switch')
  setNativeSwitches({ nativeViews: true, onboarding: false })
  assert.equal(getNativeState().switches.nativeViews, true)
  assert.equal(getNativeState().switches.onboarding, false)
  resetNative()
  setNativeSwitches({ nativeViews: true, onboarding: true })
  __setNativeStateForTests({ view: 'overview' })
})

/* ========================================================================
 * Limits contract
 * ===================================================================== */

test('the v0.7 budget constants exist with their documented values', () => {
  assert.equal(limits.BROWSE_PAGE_SIZE, 50)
  assert.equal(limits.BROWSE_ABSTRACT_MAX_CHARS, 160)
  assert.equal(limits.BROWSE_SUBTREE_MAX_LEVELS, 2)
  assert.equal(limits.BROWSE_SUBTREE_MAX_NODES, 100)
  assert.equal(limits.BROWSE_CACHE_TTL_MS, 15_000)
  assert.equal(limits.BROWSE_CACHE_MAX_DIRECTORIES, 100)
  assert.equal(limits.SESSIONS_PAGE_SIZE, 50)
  assert.equal(limits.SESSION_DETAIL_CACHE_TTL_MS, 15_000)
  assert.equal(limits.RECENT_COMMITS_SESSION_CAP, 8)
  assert.equal(limits.RECENT_COMMITS_CONCURRENCY, 4)
  assert.equal(limits.RECENT_COMMITS_DEADLINE_MS, 10_000)
  assert.equal(limits.RECENT_COMMITS_CACHE_TTL_MS, 30_000)
  assert.equal(limits.OVERVIEW_CACHE_TTL_MS, 5_000)
  assert.equal(limits.STUDIO_STATUS_TIMEOUT_MS, 4_000)
  assert.equal(limits.STUDIO_STATUS_TTL_MS, 60_000)
  assert.equal(limits.NATIVE_HISTORY_MAX, 20)
  assert.ok(limits.RECENT_COMMITS_CONCURRENCY < limits.RECENT_COMMITS_SESSION_CAP, 'the pool is narrower than the fan-out')
  assert.ok(limits.STUDIO_STATUS_TIMEOUT_MS < limits.STUDIO_STATUS_TTL_MS, 'the probe has a sane relationship to its cache')
})

/* ========================================================================
 * The bounded recent-commit fan-out service
 * ===================================================================== */

test('the recent-commit fan-out reports a deadline partial (pool 4, deadline hit)', async () => {
  const { RecentCommitsService } = await import('../src/host/commits-service.ts')
  let clock = 1_000_000
  const rows = Array.from({ length: 8 }, (_, index) => ({
    ovSessionId: `dsh-s${index}`,
    sessionId: `s${index}`,
    uri: `viking://user/default/sessions/dsh-s${index}`,
    modifiedAt: '2026-11-10T00:00:00Z',
    kind: 'dsh',
  }))
  const sessions = {
    list: async () => ({ items: rows, hasMore: false, nextOffset: null, warnings: [], observedAt: 'x' }),
  }
  const commit = {
    status: async (sessionId) => {
      clock += 3_000
      return {
        sessionId,
        ovSessionId: `dsh-${sessionId}`,
        pendingTokens: 0,
        threshold: null,
        ratio: 0,
        commitCount: 0,
        lastCommitAt: null,
        phase: 'idle',
        latest: null,
        archives: [],
      }
    },
    summaries: async () => [],
  }
  const service = new RecentCommitsService({ commit, sessions, now: () => clock })
  const payload = await service.recent({})
  assert.equal(payload.items.length, 4, 'the deadline stopped the pool after the first batch')
  assert.equal(payload.partial, true)
  assert.equal(payload.limitedBy, 'deadline')
  assert.equal(payload.progress.sessionsScanned, 4)
  assert.equal(payload.progress.deadlineMs, limits.RECENT_COMMITS_DEADLINE_MS)
  assert.ok(payload.progress.elapsedMs >= limits.RECENT_COMMITS_DEADLINE_MS, 'the reported elapsed time crosses the budget')
})

test('the recent-commit fan-out reports a session-cap partial and keeps per-row errors', async () => {
  const { RecentCommitsService } = await import('../src/host/commits-service.ts')
  const rows = [
    { ovSessionId: 'dsh-s1', sessionId: 's1', uri: 'viking://user/default/sessions/dsh-s1', modifiedAt: null, kind: 'dsh' },
    { ovSessionId: 'local-runner', sessionId: null, uri: 'viking://user/default/sessions/local-runner', modifiedAt: null, kind: 'local' },
  ]
  const sessions = {
    list: async () => ({ items: rows, hasMore: true, nextOffset: 2, warnings: [], observedAt: 'x' }),
  }
  const commit = {
    status: async (sessionId) => ({
      sessionId,
      ovSessionId: `dsh-${sessionId}`,
      pendingTokens: 1,
      threshold: null,
      ratio: 0,
      commitCount: 1,
      lastCommitAt: null,
      phase: 'done',
      latest: null,
      archives: [],
    }),
    summaries: async () => [],
  }
  const service = new RecentCommitsService({ commit, sessions, now: () => 0 })
  const payload = await service.recent({})
  assert.equal(payload.partial, true)
  assert.equal(payload.limitedBy, 'session-cap')
  assert.equal(payload.progress.sessionCap, limits.RECENT_COMMITS_SESSION_CAP)
  assert.equal(payload.items.length, 2)
  assert.equal(payload.items[1].error, 'unsupported-session', 'another harness session is a row-level answer, not a refusal')
  assert.equal(payload.items[1].status, null)
})

/* ========================================================================
 * i18n parity for the new copy
 * ===================================================================== */

test('EN and ZH ship exactly the same v0.7 keys', async () => {
  const { DICTS } = await import('../src/client/locale.ts')
  const enKeys = Object.keys(DICTS.en).sort()
  const zhKeys = Object.keys(DICTS.zh).sort()
  assert.deepEqual(zhKeys, enKeys, 'both dictionaries carry the same key set')
  const groups = ['native.', 'onboarding.', 'browse.', 'config.showNativeViews', 'config.showOnboarding', 'native.preview.curate']
  for (const prefix of groups) {
    const hits = enKeys.filter((key) => key.startsWith(prefix))
    assert.ok(hits.length > 0, `the ${prefix} copy exists`)
    assert.equal(hits.length, zhKeys.filter((key) => key.startsWith(prefix)).length, `the ${prefix} copy is translated`)
  }
  // Every check the overview can produce has label + hint copy in both halves.
  for (const step of ['endpoint', 'health', 'identity', 'memoryPlugin', 'capabilities', 'firstStep']) {
    assert.ok(enKeys.includes(`onboarding.step.${step}`), `EN label for ${step}`)
    assert.ok(zhKeys.includes(`onboarding.step.${step}`), `ZH label for ${step}`)
  }
  for (const root of ['memories', 'peers', 'resources', 'myResources', 'skills', 'agentSkills', 'rules', 'sessions']) {
    assert.ok(enKeys.includes(`browse.root.${root}`), `EN root label for ${root}`)
  }
  for (const kind of ['directory', 'memory', 'resource', 'skill', 'rule', 'session', 'archive', 'agent', 'file', 'unknown']) {
    assert.ok(enKeys.includes(`browse.kind.${kind}`), `EN kind label for ${kind}`)
  }
  for (const state of ['no-messages', 'not-committed', 'extracting', 'failed', 'queued', 'committed', 'unknown']) {
    assert.ok(enKeys.includes(`native.sessions.state.${state}`), `EN session state for ${state}`)
  }
  for (const phase of ['idle', 'pending', 'extracting', 'done', 'failed', 'errored']) {
    assert.ok(enKeys.includes(`native.commits.phase.${phase}`), `EN commit phase for ${phase}`)
    assert.ok(zhKeys.includes(`native.commits.phase.${phase}`), `ZH commit phase for ${phase}`)
  }
  for (const frameable of ['yes', 'no', 'unknown']) {
    assert.ok(enKeys.includes(`native.studio.frameable.${frameable}`), `EN Studio frameability for ${frameable}`)
  }
})
