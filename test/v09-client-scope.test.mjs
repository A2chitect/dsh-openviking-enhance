// v0.9 review round 1 (B1): the client switch chain, end to end through the real
// request layer.
//
// The host-side route tests call `app.mutate` directly and therefore never see
// `scopedFetch`. This suite imports the real client modules, installs a tiny fake
// host on `globalThis.fetch`, and proves the three things review B1 found broken:
//
//   1. `/scope` and `/scopes` stay readable with a stale key (discovery), so the
//      client can learn about a host-side switch;
//   2. an `allowScopeChange` mutation that replies with the new scope is adopted
//      instead of being thrown away as a stale response;
//   3. a profile switch (ConfigForm path) completes and the store publishes the
//      new identity/label, with a switch notice for the cockpit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  fetchBrowseRoots,
  fetchCommits,
} from '../src/client/host-api.ts'
import {
  ensureScope,
  getScopeState,
  registerProfileSwitcher,
  scopeKey,
  switchIdentity,
  switchProfile,
  __resetScopeForTests,
} from '../src/client/scope-store.ts'
import { __resetOpsPendingForTests } from '../src/client/ops-store.ts'
import { __setWriteStateForTests } from '../src/client/write-store.ts'

// host-api uses document-relative URLs: no leading slash (the shell's <base>).
const PREFIX = 'api/openviking-enhance'

function keyFor(seed) {
  return `sha256:${createHash('sha256').update(seed).digest('hex')}`
}

function scopePayload(seed, overrides = {}) {
  const key = keyFor(seed)
  return {
    identity: {
      profileId: 'alpha',
      profileLabel: 'Alpha dev',
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      account: overrides.account ?? 'default',
      user: overrides.user ?? 'alice',
      peer: overrides.peer ?? null,
      fingerprint: key,
    },
    activeProfileId: 'alpha',
    role: 'ROOT',
    version: '0.5.3',
    healthy: true,
    writes: { enabled: true, transport: true, reason: null },
    ops: { enabled: false, transport: true, reason: 'ops-disabled' },
    capabilities: {},
    warnings: [],
    observedAt: '2026-11-11T00:00:00.000Z',
  }
}

function scopesPayload(key, overrides = {}) {
  const active = scopePayload(`active-${key}`, overrides)
  active.identity.fingerprint = key
  return {
    scopes: [
      {
        id: 'alpha',
        label: 'Alpha dev',
        endpoint: 'http://127.0.0.1:1933',
        authMode: 'dev',
        account: active.identity.account,
        user: active.identity.user,
        peer: active.identity.peer,
        hasApiKey: false,
        health: { ok: true, version: '0.5.3', latencyMs: 4, error: null },
        capabilities: {},
        warnings: [],
        isActive: true,
        overrides: false,
      },
    ],
    active: {
      scopeKey: key,
      profileId: 'alpha',
      label: 'Alpha dev',
      endpoint: 'http://127.0.0.1:1933',
      authMode: 'dev',
      account: active.identity.account,
      user: active.identity.user,
      peer: active.identity.peer,
      overrides: false,
    },
    overrides: {
      account: null,
      user: null,
      peer: null,
      allowed: { account: true, user: true, peer: true, reason: null, authMode: 'dev' },
      overrides: false,
    },
    officialPlugin: null,
    warnings: [],
    observedAt: '2026-11-11T00:00:00.000Z',
  }
}

/** A tiny fake host: the only movable parts are the current key and payload. */
function installFakeHost() {
  const host = {
    key: keyFor('alpha'),
    scope: scopePayload('alpha'),
    scopes: null,
    calls: [],
    /** How many times the scope-changing mutation was called. */
    identitySwitches: 0,
  }
  host.scopes = scopesPayload(host.key)
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-dsh-openviking-scope': host.key },
    })
  const previous = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const headers = new Headers(init.headers ?? {})
    host.calls.push({ url, method: init.method ?? 'GET', scope: headers.get('x-dsh-openviking-scope') })
    const path = url.split('?')[0]
    if (path === `${PREFIX}/scope`) return json({ ok: true, scope: host.scope })
    if (path === `${PREFIX}/scopes`) return json({ ok: true, scopes: host.scopes })
    if (path === `${PREFIX}/scope/identity`) {
      host.identitySwitches += 1
      const body = JSON.parse(String(init.body ?? '{}'))
      const next = scopePayload('overridden', {
        account: body.account ?? 'default',
        user: body.user ?? 'alice',
        peer: body.peer ?? null,
      })
      host.key = next.identity.fingerprint
      host.scope = next
      host.scopes = scopesPayload(host.key, { peer: next.identity.peer })
      return json({
        ok: true,
        changed: true,
        from: keyFor('alpha'),
        to: host.key,
        scope: host.scope,
        scopes: host.scopes,
      })
    }
    if (path === `${PREFIX}/browse/roots`) return json({ ok: true, roots: [], warnings: [], observedAt: 'x' })
    if (path === `${PREFIX}/commits`) return json({ ok: true, status: null, tasks: [], summaries: [] })
    return json({ ok: true })
  }
  return {
    host,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

function resetClientState() {
  __resetScopeForTests()
  __resetOpsPendingForTests()
  __setWriteStateForTests({ confirm: null, plan: null, notice: null, busy: false })
}

test('the switch chain completes: identity reply is adopted and /scope reports the new key', async () => {
  resetClientState()
  const fake = installFakeHost()
  try {
    await ensureScope()
    assert.equal(getScopeState().status, 'ready')
    assert.equal(scopeKey(), fake.host.key)
    const oldKey = fake.host.key

    const result = await switchIdentity({ peer: 'peer-read' })
    assert.deepEqual(result, { ok: true, error: null })
    assert.notEqual(scopeKey(), oldKey, 'the new key is adopted from the mutation reply')
    assert.equal(scopeKey(), fake.host.key)
    assert.equal(getScopeState().scope?.identity.peer, 'peer-read')
    assert.equal(getScopeState().switchNotice?.toLabel, 'Alpha dev')
    assert.equal(fake.host.identitySwitches, 1)
    // The mutation carried the old key and the client did not need a stale-key
    // `/scope` request to recover.
    const post = fake.host.calls.find((call) => call.url.endsWith('/scope/identity'))
    assert.equal(post.scope, oldKey)
    const scopeReadsAfter = fake.host.calls.filter((call) => call.url.endsWith('/scope')).length
    assert.ok(scopeReadsAfter >= 1, 'the initial discovery read happened')
  } finally {
    fake.restore()
  }
})

test('a host-side switch is discovered through a tolerant /scope read (review B1)', async () => {
  resetClientState()
  const fake = installFakeHost()
  try {
    await ensureScope()
    const oldKey = scopeKey()
    // Another tab (or a profile save) moved the host to a new scope. The client
    // still holds the old key; a plain read would be refused 409, but discovery
    // must learn the new key.
    const next = scopePayload('moved', { account: 'acme', user: 'bob' })
    fake.host.key = next.identity.fingerprint
    fake.host.scope = next
    fake.host.scopes = scopesPayload(fake.host.key, { account: 'acme', user: 'bob' })

    const { refreshScope } = await import('../src/client/scope-store.ts')
    await refreshScope()
    assert.equal(getScopeState().status, 'ready')
    assert.equal(scopeKey(), next.identity.fingerprint)
    assert.notEqual(scopeKey(), oldKey)
    assert.equal(getScopeState().scope?.identity.user, 'bob')
    const scopeReads = fake.host.calls.filter((call) => /\/scope(\?|$)/.test(call.url))
    assert.equal(scopeReads.at(-1).scope, oldKey, 'the stale key was still sent')
  } finally {
    fake.restore()
  }
})

test('the profile switch (ConfigForm path) completes and publishes the new identity', async () => {
  resetClientState()
  const fake = installFakeHost()
  const previousSwitcher = registerProfileSwitcher(async (id) => {
    if (id !== 'beta') return false
    const next = scopePayload('beta-profile')
    next.identity.profileId = 'beta'
    next.identity.profileLabel = 'Beta dev'
    fake.host.key = next.identity.fingerprint
    fake.host.scope = next
    fake.host.scopes = scopesPayload(fake.host.key)
    return true
  })
  try {
    await ensureScope()
    const result = await switchProfile('beta')
    assert.deepEqual(result, { ok: true, error: null })
    assert.equal(getScopeState().scope?.identity.profileId, 'beta')
    assert.equal(getScopeState().switchNotice?.toLabel, 'Beta dev')
    assert.equal(scopeKey(), fake.host.key)
  } finally {
    registerProfileSwitcher(previousSwitcher ?? null)
    fake.restore()
  }
})

test('an in-flight read is aborted and dropped when a switch starts', async () => {
  resetClientState()
  const fake = installFakeHost()
  const previousFetch = globalThis.fetch
  // Slow browse: the switch below must abort it (ScopeChangedError → error).
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/commits')) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
      return new Response(JSON.stringify({ ok: true, status: null, tasks: [], summaries: [] }), {
        headers: { 'content-type': 'application/json', 'x-dsh-openviking-scope': fake.host.key },
      })
    }
    return previousFetch(input, init)
  }
  try {
    await ensureScope()
    const slow = fetchCommits('s1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await switchIdentity({ peer: 'peer-abort' })
    const answer = await slow
    assert.equal(answer.ok, false, 'the in-flight previous-scope read is dropped')
    assert.equal(answer.ok === false && answer.error, 'scope-changed')
    // The next read still works under the new key.
    const fresh = await fetchBrowseRoots()
    assert.equal(fresh.ok, true)
  } finally {
    fake.restore()
  }
})
