// The smoke harness's privacy default, as tests.
//
// `pnpm test` runs the host smoke on a machine whose OpenViking holds real
// memory. These tests pin the redaction rules (so a refactor cannot quietly reintroduce
// leaf names, session ids, query text, identities or home paths) and run the
// offline smoke path once as a subprocess to prove its terminal output carries
// no private-data markers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  createRedactor,
  redactEndpoint,
  redactPath,
  redactQuery,
  redactSessionId,
  redactUri,
  smokeVerbose,
} from '../scripts/smoke-redact.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('session ids become stable, non-reversible run-local handles', () => {
  const hashed = redactSessionId('dsh-0123456789abcdef')
  assert.match(hashed, /^sess-[0-9a-f]{8}$/)
  assert.equal(hashed, redactSessionId('dsh-0123456789abcdef'), 'stable for the same id')
  assert.notEqual(hashed, redactSessionId('dsh-fedcba9876543210'))
  assert.ok(!hashed.includes('0123456789abcdef'))
})

test('URIs keep the namespace and kind but never the leaf or a peer name', () => {
  assert.equal(
    redactUri('viking://user/default/memories/events/2026/11/01/release.md'),
    'viking://user/default/memories/<redacted>',
  )
  assert.equal(
    redactUri('viking://user/default/peers/github.com-a2chitect-project/memories/entities/x.md'),
    'viking://user/default/peers/<peer>/memories/<redacted>',
  )
  assert.equal(redactUri('viking://agent/skills/code-review/SKILL.md'), 'viking://agent/skills/<redacted>')
  assert.equal(redactUri('viking://unknown-shape'), 'viking://<redacted>/<redacted>')
  assert.equal(redactUri('not-a-uri'), 'not-a-uri', 'non-URI strings are left to other rules')
})

test('endpoints keep only the loopback server', () => {
  assert.equal(redactEndpoint('http://127.0.0.1:1933'), 'http://127.0.0.1:1933')
  assert.equal(redactEndpoint('http://localhost:1933'), 'http://localhost:1933')
  assert.equal(redactEndpoint('https://memory.example.com:8443'), '<endpoint>')
  assert.equal(redactEndpoint(''), '<endpoint>')
})

test('query text becomes a length fact', () => {
  assert.equal(redactQuery('0123456789'), '<10 chars>')
  assert.equal(redactQuery(''), '<no query>')
})

test('home paths are symbolised, unknown paths hidden', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/fixture-dsh-home'
  try {
    assert.equal(redactPath('/tmp/fixture-dsh-home/state/x/audit.jsonl'), '$DSH_HOME/state/x/audit.jsonl')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(redactPath('/etc/passwd'), '<path>')
})

test('summary scrubbing hides bodies, sessions, queries and identities in a whole payload', () => {
  const redactor = createRedactor({})
  const payload = {
    ok: true,
    status: {
      sessionId: 'dsh-abcdef0123456789',
      ovSessionId: 'dsh-abcdef0123456789',
      latest: { archiveUri: 'viking://user/default/sessions/dsh-abcdef0123456789/history/archive_001' },
    },
    diff: {
      adds: [
        {
          uri: 'viking://user/default/memories/events/2026/11/01/private.md',
          before: 'a private memory body',
          after: '# Summary of a private memory body',
        },
      ],
    },
    query: { text: 'a private prompt people typed' },
    endpoint: 'https://remote.example.com',
    account: 'alice',
    user: 'bob',
    plan: 'private query plan',
  }
  const summary = redactor.summarise(payload)
  for (const secret of [
    'dsh-abcdef0123456789',
    'private.md',
    'a private memory body',
    'a private prompt people typed',
    'remote.example.com',
    'alice',
    'bob',
    'private query plan',
  ]) {
    assert.ok(!summary.includes(secret), `the summary leaked ${JSON.stringify(secret)}: ${summary}`)
  }
  assert.ok(summary.includes('sess-'), 'the session id is replaced, not dropped')
  assert.ok(summary.includes('<redacted>'), 'the URI shape is kept')
  assert.ok(!summary.includes('archive_001'), 'archive names are never echoed')
  assert.ok(summary.includes('sessions/<redacted>'), 'the session URI shape is kept')
})

test('SMOKE_VERBOSE=1 is the only way to get the raw detail', () => {
  assert.equal(smokeVerbose({ SMOKE_VERBOSE: '1' }), true)
  assert.equal(smokeVerbose({}), false)
  assert.equal(smokeVerbose({ SMOKE_VERBOSE: 'yes' }), false)
  const raw = JSON.stringify(
    createRedactor({ SMOKE_VERBOSE: '1' }).summarise({
      sessionId: 'dsh-abcdef0123456789',
      note: 'visible when explicitly verbose',
    }),
  )
  assert.ok(raw.includes('dsh-abcdef0123456789'), 'verbose output is intentionally unredacted')
})

test('the offline smoke path prints no URI leaves, session ids or memory bodies', () => {
  // No server is reachable in CI; the smoke then exercises the degraded routes and
  // still prints their labels. Capture the real subprocess output and assert the
  // private-data markers are absent.
  const output = execFileSync(process.execPath, ['scripts/smoke-host.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, SMOKE_VERBOSE: '', SMOKE_REQUIRE_SERVER: '', SMOKE_ENDPOINT: 'http://127.0.0.1:9' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.ok(output.includes('[smoke]'), 'the smoke actually ran')
  assert.doesNotMatch(output, /viking:\/\/user\/[^\s"]+\/memories\/[^\s"/]+/, 'no memory URI leaf')
  assert.doesNotMatch(output, /\bdsh-[0-9a-f]{8,}\b/, 'no raw session id')
  assert.doesNotMatch(output, /"abstract":\s*"[^"]+"/, 'no memory abstract body')
  // The redaction note is printed so an operator knows why the output is terse.
  assert.match(output, /redacted/i)
})

test('the redactor itself never hashes with an unstable salt', () => {
  const expected = createHash('sha256').update('dsh-x').digest('hex').slice(0, 8)
  assert.equal(redactSessionId('dsh-x'), `sess-${expected}`)
})
