// v0.9 "Native II — multi-scope" host units.
//
// Every rule that makes a scope safe is pinned here against real stores in a
// temp DSH home and a fake probe: boot precedence, the 0600 state file, identity
// override validity per auth mode (dev/trusted/api_key/oidc/unreachable), profile
// switches resetting overrides, the switch guard, the bounded session-scope map,
// the read-only ACL classification and the advisory official-plugin projection.
//
// No network and no live OpenViking: the fake API surfaces are plain objects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProfileStore } from '../src/host/profiles.ts'
import { ScopeStateStore, parseScopeState } from '../src/host/scope-state.ts'
import { ScopeService, identityRules } from '../src/host/scope-service.ts'
import { SessionScopeMap, parseSessionScopeMap } from '../src/host/session-scope-map.ts'
import { AclService, classifyVisibility, isAclSupportedUri } from '../src/host/acl-service.ts'
import {
  compareOfficialPluginFacts,
  projectOfficialPluginFacts,
} from '../src/host/plugin-connection-facts.ts'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v09-${label}-`))

function makeProfile(overrides = {}) {
  return {
    id: 'alpha',
    label: 'Alpha dev',
    endpoint: 'http://127.0.0.1:1933',
    authMode: 'dev',
    apiKey: '',
    account: 'default',
    user: 'default',
    peerId: '',
    ...overrides,
  }
}

/** Seed a profiles.json exactly as the settings form would have left it. */
function seedProfiles(dir, profiles, activeProfileId = '') {
  writeFileSync(
    join(dir, 'profiles.json'),
    JSON.stringify({ version: 1, activeProfileId, profiles }),
    { mode: 0o600 },
  )
}

/** A ScopeService with controllable probe/health answers. */
function makeService(dir, options = {}) {
  const profileStore = new ProfileStore({ dir })
  const state = new ScopeStateStore({ dir })
  const probeCalls = []
  const service = new ScopeService({
    profiles: profileStore,
    state,
    configActiveProfile: options.configActiveProfile ?? (() => ''),
    configOverrides: options.configOverrides ?? (() => ({})),
    probedAuthMode: options.probedAuthMode ?? (() => 'dev'),
    healthy: options.healthy ?? (() => true),
    probe: async (profile) => {
      probeCalls.push(profile.id)
      return options.probe?.(profile) ?? { ok: true, version: '0.5.3', latencyMs: 12, error: null }
    },
    activeCapabilities: options.activeCapabilities ?? (() => ({ health: { available: true, detail: null } })),
    guard: options.guard ?? (() => ({ pending: 0, busy: false, lastSwitchAt: null })),
  })
  return { service, state, profileStore, probeCalls }
}

/* ---- scope-state.json -------------------------------------------------- */

test('scope-state.json is written 0600 and reads back the active profile + override', () => {
  const dir = tempDir('state')
  const store = new ScopeStateStore({ dir })
  assert.equal(store.read().available, false, 'missing is the normal fresh case')
  const written = store.write('alpha', { account: 'acme', user: 'alice', peer: 'peer-1' })
  assert.equal(written.ok, true)
  assert.equal(statSync(store.path).mode & 0o777, 0o600, 'the state file is private (0600)')
  const read = store.read()
  assert.equal(read.file.activeProfileId, 'alpha')
  assert.deepEqual(read.file.identity, { account: 'acme', user: 'alice', peer: 'peer-1' })
  // The file keeps no secret and no endpoint.
  const raw = readFileSync(store.path, 'utf8')
  assert.equal(raw.includes('apiKey'), false)
  assert.equal(raw.includes('http://'), false)
  // An all-null override writes as null (no misleading empty block).
  store.write('alpha', { account: null, user: null, peer: null })
  assert.equal(store.read().file.identity, null)
})

test('a corrupt scope-state.json falls back and is reported as config-source health', () => {
  const dir = tempDir('corrupt')
  writeFileSync(join(dir, 'scope-state.json'), '{not json', { mode: 0o600 })
  const store = new ScopeStateStore({ dir })
  const read = store.read()
  assert.equal(read.available, false)
  assert.equal(read.file.activeProfileId, '')
  assert.equal(read.error, 'malformed', 'plain-JSON corruption is reported, not guessed around')
  const health = store.sourceHealth()
  assert.equal(health.state, 'malformed')
  assert.equal(health.source, 'scope-state.json')
  // Wrong shapes are rejected leniently, never thrown.
  assert.equal(parseScopeState(null).ok, false)
  assert.equal(parseScopeState([]).ok, false)
  assert.equal(parseScopeState({ version: 99 }).ok, false)
  assert.equal(parseScopeState({ version: 1, activeProfileId: 'bad id!' }).ok, false)
})

/* ---- boot precedence --------------------------------------------------- */

test('boot precedence: Config activeProfile wins over scope state, file header and legacy', () => {
  const dir = tempDir('precedence')
  seedProfiles(dir, [makeProfile({ id: 'alpha', label: 'Alpha' }), makeProfile({ id: 'beta', label: 'Beta' })], 'beta')
  const state = new ScopeStateStore({ dir })
  state.write('beta', null)
  const { service } = makeService(dir, { configActiveProfile: () => 'alpha' })
  assert.equal(service.resolveActive().profileId, 'alpha')
  assert.equal(service.resolveActive().source, 'config')
})

test('boot precedence: scope state wins over the profiles.json header; header is the last fallback', () => {
  const dir = tempDir('precedence2')
  seedProfiles(dir, [makeProfile({ id: 'alpha', label: 'Alpha' }), makeProfile({ id: 'beta', label: 'Beta' })], 'alpha')
  const state = new ScopeStateStore({ dir })
  state.write('beta', null)
  const first = makeService(dir)
  assert.equal(first.service.resolveActive().profileId, 'beta')
  assert.equal(first.service.resolveActive().source, 'state')
  // Remove the state file: the profiles.json header is the fallback.
  writeFileSync(state.path, JSON.stringify({ version: 1, activeProfileId: '' }), { mode: 0o600 })
  const second = makeService(dir)
  assert.equal(second.service.resolveActive().profileId, 'alpha')
  assert.equal(second.service.resolveActive().source, 'profile-header')
})

test('boot precedence: no profile anywhere is the legacy scope, still listed as a scope', async () => {
  const dir = tempDir('legacy')
  const { service } = makeService(dir)
  const resolved = service.resolveActive()
  assert.equal(resolved.profileId, null)
  assert.equal(resolved.source, 'legacy')
  assert.equal(resolved.profile, null)
  const rows = await service.listScopes()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '__legacy__')
  assert.equal(rows[0].isActive, true)
})

test('a scope-state profile that no longer exists falls back with a warning (never silently)', () => {
  const dir = tempDir('missing')
  seedProfiles(dir, [makeProfile({ id: 'alpha' })])
  new ScopeStateStore({ dir }).write('deleted-profile', null)
  const { service } = makeService(dir)
  const resolved = service.resolveActive()
  assert.equal(resolved.profileId, null, 'falls back to legacy resolution')
  assert.equal(resolved.source, 'legacy')
  assert.equal(resolved.warnings.some((warning) => warning.code === 'scopeStateProfileMissing'), true)
})

/* ---- identity rules per auth mode -------------------------------------- */

test('identity rules follow the auth-mode table', () => {
  assert.deepEqual(identityRules('dev', true), { account: true, user: true, peer: true, reason: null, authMode: 'dev' })
  assert.deepEqual(identityRules('trusted', true), { account: true, user: true, peer: true, reason: null, authMode: 'trusted' })
  assert.equal(identityRules('api_key', true).account, false)
  assert.equal(identityRules('api_key', true).peer, true, 'peer is a read lens, even key-bound')
  assert.equal(identityRules('api_key', true).reason, 'identity-key-bound')
  assert.equal(identityRules('oidc', true).peer, false)
  assert.equal(identityRules('ldap', true).reason, 'identity-external-idp')
  assert.equal(identityRules(null, true).reason, 'identity-unknown')
  assert.equal(identityRules('dev', false).reason, 'profile-unhealthy')
  assert.equal(identityRules('dev', false).peer, false, 'an unreachable server disables switching')
})

test('identity overrides apply only in dev/trusted and only for the active profile', () => {
  const dir = tempDir('overrides')
  seedProfiles(
    dir,
    [makeProfile({ id: 'alpha', account: 'acct', user: 'usr', peerId: 'peer-a' })],
    'alpha',
  )
  new ScopeStateStore({ dir }).write('alpha', { account: 'acct2', user: 'usr2', peer: 'peer-b' })
  const dev = makeService(dir, { probedAuthMode: () => 'dev' })
  const resolved = dev.service.resolveActive()
  assert.equal(resolved.connection.account, 'acct2')
  assert.equal(resolved.connection.user, 'usr2')
  assert.equal(resolved.peerId, 'peer-b')
  assert.equal(resolved.overrides.active, true)
  // api_key: the key binds the identity; the stored override is retained but ignored.
  const keyBound = makeService(dir, { probedAuthMode: () => 'api_key' })
  const ignored = keyBound.service.resolveActive()
  assert.equal(ignored.connection.account, 'acct')
  assert.equal(ignored.connection.user, 'usr')
  // The peer read selector stays allowed under api_key, so the override block is
  // still "active" — but account/user never were applied.
  assert.equal(ignored.overrides.account, null)
  assert.equal(ignored.overrides.user, null)
  assert.equal(ignored.overrides.peer, 'peer-b')
  assert.equal(ignored.overrides.ignored.includes('identity-key-bound'), true)
  // Unreachable disables every field.
  const unhealthy = makeService(dir, { probedAuthMode: () => 'dev', healthy: () => false })
  const disabled = unhealthy.service.resolveActive()
  assert.equal(disabled.overrides.active, false)
  assert.equal(disabled.overrides.ignored.includes('profile-unhealthy'), true)
})

test('trusted needs both account and user; a partial override is ignored as a pair', () => {
  const dir = tempDir('trusted')
  seedProfiles(dir, [makeProfile({ id: 'alpha', account: 'acct', user: 'usr' })], 'alpha')
  new ScopeStateStore({ dir }).write('alpha', { account: 'acct2', user: null, peer: null })
  const { service } = makeService(dir, { probedAuthMode: () => 'trusted' })
  const resolved = service.resolveActive()
  assert.equal(resolved.connection.account, 'acct', 'a partial trusted pair is not half-applied')
  assert.equal(resolved.overrides.active, false)
  assert.equal(resolved.overrides.ignored.includes('identity-pair-required'), true)
})

test('a Config profile override does not inherit another profile’s identity overrides', () => {
  const dir = tempDir('mismatch')
  seedProfiles(dir, [makeProfile({ id: 'alpha', account: 'acct', user: 'usr' }), makeProfile({ id: 'beta', account: 'b', user: 'b' })], 'alpha')
  new ScopeStateStore({ dir }).write('beta', { account: 'other', user: 'other', peer: null })
  // Runtime Config keeps the previous profile pointer (alpha): the state's
  // overrides belong to beta and must not leak into alpha.
  const { service } = makeService(dir, { configActiveProfile: () => 'alpha' })
  const resolved = service.resolveActive()
  assert.equal(resolved.profileId, 'alpha')
  assert.equal(resolved.connection.account, 'acct')
  assert.equal(resolved.overrides.active, false)
})

/* ---- switching --------------------------------------------------------- */

test('switchIdentity writes the state file, validates rules and refuses while a mutation is pending', () => {
  const dir = tempDir('switch')
  seedProfiles(dir, [makeProfile({ id: 'alpha' })], 'alpha')
  const { service, state } = makeService(dir)
  const resolved = service.resolveActive()
  const ok = service.switchIdentity({ account: 'acme', user: 'alice', peer: 'p1' }, resolved)
  assert.equal(ok.ok, true)
  assert.equal(ok.changed, true)
  assert.deepEqual(state.read().file.identity, { account: 'acme', user: 'alice', peer: 'p1' })
  // Identity rules: api_key refuses account/user but allows peer.
  const keyBoundDir = tempDir('switch-key')
  seedProfiles(keyBoundDir, [makeProfile({ id: 'alpha' })], 'alpha')
  const keyBound = makeService(keyBoundDir, { probedAuthMode: () => 'api_key' })
  const keyResolved = keyBound.service.resolveActive()
  const refused = keyBound.service.switchIdentity({ account: 'x', user: 'y' }, keyResolved)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'identity-not-switchable')
  const peerOk = keyBound.service.switchIdentity({ peer: 'p2' }, keyResolved)
  assert.equal(peerOk.ok, true, 'the peer read selector stays available under api_key')
  // The shared guard refuses a switch while a confirmation/write is pending.
  const busyDir = tempDir('switch-busy')
  seedProfiles(busyDir, [makeProfile({ id: 'alpha' })], 'alpha')
  const busy = makeService(busyDir, { guard: () => ({ pending: 1, busy: false, lastSwitchAt: null }) })
  const busyResolved = busy.service.resolveActive()
  const blocked = busy.service.switchIdentity({ peer: 'p' }, busyResolved)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'scope-switch-blocked')
})

test('a profile change persists the new scope and resets the identity overrides', () => {
  const dir = tempDir('persist')
  seedProfiles(dir, [makeProfile({ id: 'alpha' }), makeProfile({ id: 'beta', label: 'Beta' })], '')
  const state = new ScopeStateStore({ dir })
  state.write('alpha', { account: 'acme', user: 'alice', peer: null })
  const { service } = makeService(dir, { configActiveProfile: () => 'alpha' })
  const resolved = service.resolveActive()
  assert.equal(resolved.overrides.active, true)
  assert.equal(service.persistProfile('beta').changed, true)
  assert.equal(state.read().file.activeProfileId, 'beta')
  assert.equal(state.read().file.identity, null, 'a profile switch resets the overrides')
})

test('the scope key changes with the identity override and never contains a secret', () => {
  const dir = tempDir('key')
  seedProfiles(dir, [makeProfile({ id: 'alpha', apiKey: 'super-secret-key' })], 'alpha')
  const state = new ScopeStateStore({ dir })
  const { service } = makeService(dir)
  const base = service.resolveActive()
  state.write('alpha', { account: 'acme', user: 'alice', peer: null })
  const overridden = service.resolveActive()
  assert.notEqual(base.scopeKey, overridden.scopeKey)
  assert.match(overridden.scopeKey, /^sha256:[0-9a-f]{64}$/)
  assert.equal(overridden.scopeKey.includes('super-secret-key'), false)
  assert.equal(JSON.stringify(service.scopeInfo(overridden)).includes('super-secret-key'), false)
})

test('listScopes sums per-server health/capabilities and marks only the active row', async () => {
  const dir = tempDir('list')
  seedProfiles(
    dir,
    [
      makeProfile({ id: 'alpha', label: 'Alpha' }),
      makeProfile({ id: 'beta', label: 'Beta', endpoint: 'http://192.0.2.7:1933', authMode: 'api_key' }),
    ],
    'alpha',
  )
  const { service, probeCalls } = makeService(dir, {
    probe: (profile) =>
      profile.id === 'alpha'
        ? { ok: true, version: '0.5.3', latencyMs: 5, error: null }
        : { ok: false, version: null, latencyMs: 4000, error: 'timeout' },
  })
  const rows = await service.listScopes()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].isActive, true)
  assert.equal(rows[0].health.ok, true)
  assert.deepEqual(rows[0].capabilities, { health: { available: true, detail: null } })
  assert.equal(rows[1].isActive, false)
  assert.equal(rows[1].health.ok, false)
  assert.equal(rows[1].warnings.includes('remote-endpoint'), true)
  assert.equal(rows[1].warnings.includes('unreachable'), true)
  assert.deepEqual(probeCalls.sort(), ['alpha', 'beta'])
})

/* ---- session-scope map ------------------------------------------------- */

test('the session-scope map persists one record per session and is bounded', () => {
  const dir = tempDir('sessions')
  const map = new SessionScopeMap({ dir, maxEntries: 3 })
  assert.equal(map.get('s1'), null)
  assert.equal(map.record({ sessionId: 's1', scopeKey: 'sha256:aa', profileId: 'alpha', label: 'Alpha', account: 'a', user: 'u', peer: null }), true)
  assert.equal(map.get('s1')?.scopeKey, 'sha256:aa')
  assert.equal(statSync(map.path).mode & 0o777, 0o600)
  // Same scope again: no rewrite, no error.
  assert.equal(map.record({ sessionId: 's1', scopeKey: 'sha256:aa', profileId: 'alpha', label: 'Alpha', account: 'a', user: 'u', peer: null }), false)
  for (const id of ['s2', 's3', 's4']) {
    map.record({ sessionId: id, scopeKey: `sha256:${id}`, profileId: 'alpha', label: 'Alpha', account: 'a', user: 'u', peer: null })
  }
  const parsed = parseSessionScopeMap(JSON.parse(readFileSync(map.path, 'utf8')))
  assert.equal(parsed.entries.size, 3, 'bounded to maxEntries')
  assert.equal(parsed.entries.has('s1'), false, 'the oldest entry was evicted')
  // A corrupt map is dropped entry-wise, never thrown.
  assert.equal(parseSessionScopeMap(null).ok, false)
  assert.equal(parseSessionScopeMap({ version: 1, entries: { bad: null } }).entries.size, 0)
})

/* ---- ACL read-only view ------------------------------------------------ */

function fakeAclApi(answers) {
  const calls = []
  return {
    calls,
    api: {
      async getAcl(uri) {
        calls.push(uri)
        const answer = answers[uri] ?? answers.default
        return answer
      },
    },
  }
}

test('visibility classification is URI-derived and never a server call', () => {
  assert.equal(classifyVisibility('viking://resources/reports/daily.md'), 'account-shared')
  assert.equal(classifyVisibility('viking://resources'), 'account-shared')
  assert.equal(classifyVisibility('viking://agent/skills/x'), 'account-shared')
  assert.equal(classifyVisibility('viking://user/alice/peers/p1/memories/x'), 'peer')
  assert.equal(classifyVisibility('viking://user/alice/sessions/s1'), 'session')
  assert.equal(classifyVisibility('viking://user/alice/memories/x'), 'private-user')
  assert.equal(classifyVisibility('viking://agent/workflows/x'), 'agent')
  assert.equal(classifyVisibility('file:///etc/passwd'), 'unknown')
  assert.equal(isAclSupportedUri('viking://resources/x'), true)
  assert.equal(isAclSupportedUri('viking://user/alice/x'), false)
})

test('ACL states: available / denied-no-manage / only-resources / unsupported, bounded tables', async () => {
  const answers = {
    'viking://resources/ok': {
      ok: true,
      status: 200,
      result: {
        uri: 'viking://resources/ok',
        acl_mode: 'restricted',
        direct_entries: [{ principal: 'user:alice', level: 'read' }],
        inherited_entries: [{ principal: 'group:g1', level: 'write' }],
        effective_entries: [
          { principal: 'user:alice', level: 'read' },
          { principal: '', level: 'read' },
          { principal: 'user:bob', level: '' },
        ],
      },
      error: null,
    },
    'viking://resources/denied': { ok: false, status: 403, result: null, error: 'manage permission required' },
    'viking://resources/absent': { ok: false, status: 404, result: null, error: 'not found' },
  }
  const { api, calls } = fakeAclApi(answers)
  const service = new AclService({ api, scopeKey: () => 'sha256:test', serverFacts: () => ({ version: '0.5.3', role: null }) })
  const available = await service.report('viking://resources/ok')
  assert.equal(available.state, 'available')
  assert.equal(available.aclMode, 'restricted')
  assert.equal(available.direct.length, 1)
  assert.equal(available.effective.length, 1, 'a malformed principal is dropped')
  assert.equal(available.effective[0].principal, 'user:alice')
  assert.equal(available.sharingAvailable, false)
  const denied = await service.report('viking://resources/denied')
  assert.equal(denied.state, 'denied-no-manage')
  assert.equal(denied.detail, 'acl-manage-required')
  const absent = await service.report('viking://resources/absent')
  assert.equal(absent.state, 'unsupported')
  const only = await service.report('viking://user/alice/memories/x')
  assert.equal(only.state, 'only-resources')
  assert.equal(only.visibility, 'private-user')
  assert.equal(calls.length, 3, 'a non-resource URI performs no network call')
  // Cached per scope: a second read is free, a scope switch misses.
  await service.report('viking://resources/ok')
  assert.equal(calls.filter((uri) => uri === 'viking://resources/ok').length, 1)
  assert.equal(available.version, '0.5.3')
})

/* ---- official-plugin facts projection --------------------------------- */

test('official-plugin facts are allowlisted, secret-free and never a false claim', () => {
  const runtime = {
    states: new Map([
      [
        's1',
        {
          ovSessionId: 'dsh-s1',
          config: {
            baseUrl: 'http://192.0.2.10:1999/',
            account: 'acct',
            user: 'usr',
            peerId: 'peer-1',
            authMode: 'dev',
            apiKey: 'must-never-leak',
            token: 'must-never-leak-either',
          },
        },
      ],
    ]),
  }
  const projection = projectOfficialPluginFacts(runtime)
  assert.equal(projection.endpointHost, '192.0.2.10:1999')
  assert.equal(projection.account, 'acct')
  assert.equal(projection.peer, 'peer-1')
  assert.equal(JSON.stringify(projection).includes('must-never-leak'), false)
  const mismatch = compareOfficialPluginFacts(projection, {
    endpoint: 'http://127.0.0.1:1933',
    account: 'acct',
    user: 'usr',
    peer: 'peer-1',
  })
  assert.equal(mismatch.facts.matches, false)
  assert.equal(mismatch.pipelineMismatch, true)
  const match = compareOfficialPluginFacts(projection, {
    endpoint: 'http://192.0.2.10:1999',
    account: 'acct',
    user: 'usr',
    peer: 'peer-1',
  })
  assert.equal(match.facts.matches, true)
  assert.equal(match.pipelineMismatch, false)
  // No runtime / no readable facts → unknown, and never a warning.
  assert.equal(compareOfficialPluginFacts(null, { endpoint: 'http://x', account: 'a', user: 'u', peer: null }).facts, null)
  const unknown = compareOfficialPluginFacts(projectOfficialPluginFacts({ states: new Map() }), {
    endpoint: 'http://x',
    account: 'a',
    user: 'u',
    peer: null,
  })
  assert.equal(unknown.facts, null)
  assert.equal(unknown.pipelineMismatch, false)
})
