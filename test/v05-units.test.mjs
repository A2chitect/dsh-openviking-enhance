// v0.5 "Collaborate" host-side units.
//
// The write protocol is the riskiest code in this repository, so the tests below
// are deliberately adversarial: every fail-closed gate, every token rule, the
// identity binding, the undo filtering and the "no bodies in the audit file"
// promise are pinned against a **fake OpenViking API**. Nothing here talks to a
// real server; a test that wrote to a live memory store would be a defect.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyCuratableUri,
  isCuratableUri,
  normalizeVikingUri,
  peerOfMemoryUri,
  restoreScopeFor,
  snapshotPathsFor,
  validateTagInput,
} from '../src/shared/curation.ts'
import {
  ProfileStore,
  describeProfile,
  isProbeableEndpoint,
  parseProfileFile,
  sanitizeProfile,
} from '../src/host/profiles.ts'
import {
  identityFingerprint,
  resolveConnectionForProfile,
  resolveConnectionWithOrigins,
} from '../src/host/config.ts'
import { AuditLog, AUDIT_MAX_BYTES, auditEntryFrom } from '../src/host/audit.ts'
import { appendJsonl, pluginStateDir, readJsonlTail, writePrivateFile, modeOf } from '../src/host/plugin-state.ts'
import { CapabilityService } from '../src/host/capability.ts'
import { SessionControlService } from '../src/host/session-control.ts'
import {
  ActivityService,
  isCancellableTask,
  mapTask,
  safeTaskExport,
} from '../src/host/activity-service.ts'
import { WriteService, shortHash, validateTags } from '../src/host/write-service.ts'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v05-${label}-`))

const IDENTITY = {
  profileId: 'local-default',
  profileLabel: 'Local dev',
  endpoint: 'http://127.0.0.1:1933',
  authMode: 'dev',
  account: 'default',
  user: 'default',
  peer: null,
  fingerprint: `sha256:${'a'.repeat(64)}`,
}

const MEMORY = 'viking://user/default/memories/preferences/tools.md'

/* ========================================================================
 * The curatable allowlist (Lead decision D)
 * ===================================================================== */

test('the allowlist accepts exactly the three memory subtrees, user and peer', () => {
  for (const uri of [
    'viking://user/default/memories/entities/project/sidebar.md',
    'viking://user/default/memories/events/2026/11/09/trip.md',
    'viking://user/default/memories/preferences/tools.md',
    'viking://user/default/peers/repo-x/memories/entities/a.b/skill.md',
  ]) {
    const classified = classifyCuratableUri(uri)
    assert.equal(classified.ok, true, `${uri} must be curatable`)
    assert.ok(['entities', 'events', 'preferences'].includes(classified.target.memoryKind))
    assert.ok(classified.target.parentUri.startsWith('viking://'))
    assert.equal(isCuratableUri(uri), true)
  }
  const target = classifyCuratableUri(MEMORY)
  assert.equal(target.target.fileName, 'tools.md')
  assert.equal(target.target.parentUri, 'viking://user/default/memories/preferences')
})

test('the allowlist refuses every excluded tree, sidecar and unsafe path', () => {
  const refused = [
    // Decision D exclusions.
    ['viking://user/default/memories/rules/scenario/rule.md', 'memory-kind-not-curatable'],
    ['viking://user/default/memories/profile.md', 'memory-kind-not-curatable'],
    ['viking://user/default/sessions/s1/history/archive_001/x.md', 'not-a-memory-path'],
    ['viking://resources/wiki/project.md', 'unsafe-path'],
    ['viking://user/default/skills/demo/SKILL.md', 'not-a-memory-path'],
    // Generated sidecars and protected files.
    ['viking://user/default/memories/entities/.abstract.md', 'sidecar-or-protected-file'],
    ['viking://user/default/memories/entities/.overview.md', 'sidecar-or-protected-file'],
    ['viking://user/default/memories/preferences/identity.md', 'sidecar-or-protected-file'],
    ['viking://user/default/memories/preferences/soul.md', 'sidecar-or-protected-file'],
    // Files the write API cannot review as text.
    ['viking://user/default/memories/preferences/tools.bin', 'non-text-extension'],
    ['viking://user/default/memories/preferences', 'not-a-file'],
    // Path-shape attacks: a path the server could resolve differently.
    ['viking://user/default/memories/preferences/../entities/x.md', 'unsafe-path'],
    ['viking://user//memories/entities/x.md', 'unsafe-path'],
    ['viking://user/default/memories/entities/x.md?raw=1', 'unsafe-path'],
    ['not-a-uri', 'not-a-viking-path'],
  ]
  for (const [uri, reason] of refused) {
    const classified = classifyCuratableUri(uri)
    assert.equal(classified.ok, false, `${uri} must be refused`)
    assert.equal(classified.reason, reason, `${uri} explains itself`)
    assert.equal(isCuratableUri(uri), false)
  }
  assert.equal(normalizeVikingUri('  viking://user/default/memories/entities/x.md  '), 'viking://user/default/memories/entities/x.md')
  assert.equal(normalizeVikingUri('viking://user/default/'), null)
})

test('one snapshot/restore scope: the parent directory for every snapshot-backed action', () => {
  const target = classifyCuratableUri(MEMORY).target
  // Review S4: the delete used to snapshot by file but restore by directory.
  // One scope for both halves, and it is the only restore mode the tested builds
  // support (file-level restore is unverified).
  assert.deepEqual(snapshotPathsFor('delete-memory', target), ['viking://user/default/memories/preferences'])
  assert.deepEqual(snapshotPathsFor('edit-memory', target), ['viking://user/default/memories/preferences'])
  assert.deepEqual(snapshotPathsFor('set-tags', target), ['viking://user/default/memories/preferences'])
  assert.equal(restoreScopeFor(target), 'viking://user/default/memories/preferences')
  assert.equal(peerOfMemoryUri(MEMORY), null)
  assert.equal(
    peerOfMemoryUri('viking://user/default/peers/repo-x/memories/entities/a.b/skill.md'),
    'repo-x',
  )
})

/* ========================================================================
 * Profiles: the secret store of record
 * ===================================================================== */

test('a missing profile store degrades to legacy resolution', () => {
  const dir = tempDir('profiles-missing')
  const store = new ProfileStore({ dir })
  const read = store.read()
  assert.equal(read.available, false)
  assert.equal(read.error, null)
  assert.deepEqual(store.describe().profiles, [])
  assert.equal(store.find('x'), null)

  const legacy = resolveConnectionForProfile([], '', { endpoint: 'http://127.0.0.1:9' })
  assert.equal(legacy.profileId, null)
  assert.equal(legacy.connection.endpoint, 'http://127.0.0.1:9')
})

test('a saved profile is 0600, round-trips, and never exposes its key', () => {
  const dir = pluginStateDir({ dir: tempDir('profiles-save') })
  const store = new ProfileStore({ dir })
  const saved = store.save({
    id: 'local-default',
    label: 'Local dev',
    endpoint: 'http://127.0.0.1:1933/',
    authMode: 'dev',
    apiKey: 'secret-key-value',
    account: 'default',
    user: 'default',
    peerId: '',
  })
  assert.equal(saved.ok, true)
  const path = join(dir, 'profiles.json')
  assert.equal(modeOf(path), 0o600, 'the secret store is 0600')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.profiles[0].endpoint, 'http://127.0.0.1:1933', 'trailing slash normalized')
  const described = store.describe()
  assert.equal(described.profiles[0].hasApiKey, true)
  assert.equal('apiKey' in described.profiles[0], false, 'the key is never part of the route payload')
  assert.equal(JSON.stringify(described).includes('secret-key-value'), false)
  assert.equal(describeProfile(raw.profiles[0]).hasApiKey, true)
})

test('saving without a key keeps the stored secret; an empty key clears it', () => {
  const dir = tempDir('profiles-key')
  const store = new ProfileStore({ dir })
  const base = {
    id: 'p1',
    label: 'One',
    endpoint: 'http://127.0.0.1:1933',
    authMode: 'dev',
    account: 'default',
    user: 'default',
    peerId: '',
  }
  assert.equal(store.save({ ...base, apiKey: 'first' }).ok, true)
  assert.equal(store.find('p1').apiKey, 'first')
  // The form cannot re-send a secret it never sees: an absent field keeps it.
  assert.equal(store.save({ ...base, label: 'One renamed' }).ok, true)
  assert.equal(store.find('p1').apiKey, 'first')
  assert.equal(store.find('p1').label, 'One renamed')
  // An explicit empty value is the "clear" gesture.
  store.save({ ...base, apiKey: '' })
  assert.equal(store.find('p1').apiKey, '')
})

test('profile validation refuses bad ids, endpoints, scopes and peers', () => {
  const valid = {
    id: 'p1',
    label: 'One',
    endpoint: 'http://127.0.0.1:1933',
    authMode: 'dev',
    account: 'default',
    user: 'default',
    peerId: '',
  }
  assert.equal(sanitizeProfile(valid) !== null, true)
  assert.equal(sanitizeProfile({ ...valid, id: '' }), null)
  assert.equal(sanitizeProfile({ ...valid, id: '../escape' }), null)
  assert.equal(sanitizeProfile({ ...valid, label: '' }), null)
  assert.equal(sanitizeProfile({ ...valid, endpoint: 'ftp://127.0.0.1' }), null)
  assert.equal(sanitizeProfile({ ...valid, endpoint: 'not a url' }), null)
  assert.equal(sanitizeProfile({ ...valid, account: 'bad account' }), null)
  assert.equal(sanitizeProfile({ ...valid, peerId: 'has/slash' }), null)
  // Unknown fields are dropped, not carried into the file.
  const sanitized = sanitizeProfile({ ...valid, surprise: 'x' })
  assert.equal('surprise' in sanitized, false)
})

test('a corrupt profile file drops only the bad rows, and no store write is required', () => {
  const dir = tempDir('profiles-corrupt')
  const path = join(dir, 'profiles.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      activeProfileId: 'missing',
      profiles: [
        { id: 'good', label: 'Good', endpoint: 'http://127.0.0.1:1933', authMode: 'dev' },
        { id: 'bad id', label: 'Bad', endpoint: 'http://127.0.0.1:1933' },
        { id: 'dup', label: 'First', endpoint: 'http://127.0.0.1:1933' },
        { id: 'dup', label: 'Second', endpoint: 'http://127.0.0.1:1933' },
        { id: 'good', label: 'Duplicate id', endpoint: 'http://127.0.0.1:2' },
      ],
    }),
  )
  const store = new ProfileStore({ dir })
  const read = store.read()
  assert.equal(read.available, true)
  assert.deepEqual(read.file.profiles.map((profile) => profile.id), ['good', 'dup'])
  assert.equal(read.file.activeProfileId, '', 'an active id that does not exist is cleared')
  assert.match(read.error, /dropped/)
  // A hand-written profile still needs no write from the plugin to be usable.
  assert.equal(store.find('good')?.label, 'Good')
})

test('a profile wins over the legacy overrides, and delete removes it', () => {
  const dir = tempDir('profiles-precedence')
  const store = new ProfileStore({ dir })
  store.save({
    id: 'cloud',
    label: 'Cloud',
    endpoint: 'https://memory.example.com',
    authMode: 'api_key',
    apiKey: 'k',
    account: 'acct',
    user: 'alice',
    peerId: 'repo',
  })
  const profiles = store.read().file.profiles
  const resolved = resolveConnectionForProfile(
    profiles,
    'cloud',
    { endpoint: 'http://127.0.0.1:9', account: 'ignored', user: 'ignored' },
    {},
  )
  assert.equal(resolved.connection.endpoint, 'https://memory.example.com')
  assert.equal(resolved.connection.account, 'acct')
  assert.equal(resolved.connection.user, 'alice')
  assert.equal(resolved.connection.apiKey, 'k')
  assert.equal(resolved.peerId, 'repo')
  assert.deepEqual(
    resolved.origins.map((origin) => origin.source),
    ['profile', 'profile', 'profile', 'profile'],
  )

  assert.equal(store.delete('cloud').ok, true)
  assert.deepEqual(store.describe().profiles, [])
  assert.equal(store.delete('cloud').ok, false)
})

test('the identity fingerprint is stable, secret-free and changes with the identity', () => {
  const home = tempDir('fingerprint-home')
  const legacy = resolveConnectionWithOrigins({ endpoint: 'http://127.0.0.1:1933' }, { OPENVIKING_HOME: home })
  const first = resolveConnectionForProfile([], '')
  const second = resolveConnectionForProfile([], '')
  assert.equal(first.fingerprintInput, second.fingerprintInput)
  const fingerprint = identityFingerprint(first, 'dev', null)
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/)
  assert.equal(fingerprint.includes('apiKey'), false)
  assert.equal(identityFingerprint(first, 'api_key', null) !== fingerprint, true, 'a different auth mode is a different identity')
  assert.equal(legacy.connection.apiKey, '')
})

/* ========================================================================
 * The audit trail
 * ===================================================================== */

test('the audit file is 0600, append-only JSONL with no bodies or secrets', () => {
  const dir = tempDir('audit')
  const log = new AuditLog({ dir, now: () => 1000 })
  const written = log.append({
    kind: 'write',
    action: 'delete-memory',
    target: `${MEMORY}?token=should-vanish`,
    identity: { ...IDENTITY, peer: null, dshSessionId: 's1' },
    fingerprint: IDENTITY.fingerprint,
    confirmation: 'overlay',
    preCommit: 'pre',
    postCommit: 'post',
    requestId: 'req-1',
    result: 'ok',
    error: null,
  })
  assert.equal(written.ok, true)
  assert.equal(modeOf(log.path), 0o600)
  const entries = log.recent(10).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].target, MEMORY, 'a query string is dropped from the recorded target')
  assert.equal(entries[0].requestId, 'req-1')
  assert.equal(entries[0].result, 'ok')
  const raw = readFileSync(log.path, 'utf8')
  assert.equal(raw.includes('should-vanish'), false)
  assert.equal(raw.includes('Original body'), false)
  assert.equal(raw.includes('secret'), false)
  // The token can appear in the durable session log, never in the audit file.
  assert.equal(raw.includes('f'.repeat(64)), false)
})

test('audit entries report the result, redact a multi-line error and stay bounded', () => {
  const entry = auditEntryFrom(
    {
      kind: 'denied',
      action: 'delete-memory',
      target: MEMORY,
      identity: { ...IDENTITY, peer: null, dshSessionId: null },
      fingerprint: IDENTITY.fingerprint,
      confirmation: null,
      result: 'denied',
      error: 'request failed\nbody line that must not be stored',
    },
    5,
  )
  assert.equal(entry.error, 'request failed')
  assert.equal(entry.ts, new Date(5).toISOString())
  assert.match(entry.id, /^aud-/)
})

test('the audit file rotates at the size cap and keeps two old files', () => {
  const dir = tempDir('audit-rotate')
  const log = new AuditLog({ dir, now: () => 1, maxBytes: 120, keep: 2 })
  for (let index = 0; index < 20; index += 1) log.append({
    kind: 'write',
    action: 'edit-memory',
    target: MEMORY,
    identity: null,
    fingerprint: null,
    confirmation: 'overlay',
    result: 'ok',
    error: null,
  })
  for (const file of ['audit.jsonl', 'audit.1.jsonl']) {
    assert.equal(modeOf(join(dir, file)), 0o600, `${file} is 0600`)
  }
  assert.ok(statSync(join(dir, 'audit.1.jsonl')).size > 0)
})

test('the JSONL reader tolerates a hand-edited file', () => {
  const dir = tempDir('jsonl')
  const path = join(dir, 'audit.jsonl')
  appendJsonl(path, { a: 1 })
  appendJsonl(path, 'not-an-object')
  // Overwrite with a hand-edited file: the unreadable line is skipped, the
  // readable one survives, and the newest parsed line wins the tail window.
  writePrivateFile(path, 'not json at all\n{"a":2}\n')
  const tail = readJsonlTail(path, 10)
  assert.deepEqual(tail, [{ a: 2 }])
})

/* ========================================================================
 * Validation helpers
 * ===================================================================== */

test('tags must be key=value with no spaces, bounded in number', () => {
  assert.deepEqual(validateTags(['env=prod', 'team=search']).tags, ['env=prod', 'team=search'])
  assert.deepEqual(validateTags([]).tags, [])
  assert.equal(validateTags(undefined).tags.length, 0)
  for (const bad of [['env prod'], ['=x'], ['k='], [42], 'x=1']) {
    assert.equal('error' in validateTags(bad), true, `${JSON.stringify(bad)} is refused`)
  }
  assert.equal('error' in validateTags(new Array(33).fill('k=v')), true)
  assert.equal(validateTagInput('no-equals').ok, false)
  assert.equal(validateTagInput('k=v').ok, true)
})

test('shortHash keeps the algo prefix and truncates the digest', () => {
  assert.equal(shortHash(`sha256:${'a'.repeat(64)}`), `sha256:${'a'.repeat(12)}…`)
  assert.equal(shortHash('deadbeef'), 'sha256:deadbeef…')
})

/* ========================================================================
 * The fake API + write service
 * ===================================================================== */

/** The fake server: an in-memory memory tree, snapshot store and task table. */
class FakeOpenViking {
  constructor() {
    this.files = new Map()
    this.tags = new Map()
    this.commits = 0
    this.calls = []
    this.failSnapshot = false
    this.failWrite = false
    this.failDelete = false
    this.failCommit = null
    this.restoreDiff = null
    this.appliedRestores = []
    this.healthOk = true
    this.healthAuthMode = 'dev'
    this.snapshotStatus = 200
    this.tasksStatus = 200
    /** When set, fsStat answers this instead of the in-memory tree (S6 tests). */
    this.statFailure = null
    this.files.set(MEMORY, { content: 'Original body', modTime: '2026-11-09T00:00:00Z' })
    this.files.set('viking://user/default/memories/entities/project/sidebar.md', {
      content: 'Rows sort by order.',
      modTime: '2026-11-09T00:00:00Z',
    })
  }

  async health() {
    return {
      ok: this.healthOk,
      version: '0.5.3',
      authMode: this.healthAuthMode,
      role: 'USER',
      accountId: null,
      userId: null,
      error: this.healthOk ? null : 'down',
    }
  }

  async snapshotLog() {
    if (this.snapshotStatus === 404) {
      return { ok: false, status: 404, result: null, error: 'Git_ref not found: main', errorCode: 'NOT_FOUND', errorDetails: { type: 'git_ref' } }
    }
    return { ok: true, status: 200, result: [], requestId: 'req-log' }
  }

  async probeRuleSearchRoute() {
    return { ok: false, status: 422, result: null, error: 'validation', errorCode: null, errorDetails: null }
  }

  async listTasks(filters = {}) {
    if (this.tasksStatus === 404) return { ok: false, status: 404, result: null, error: 'Not Found' }
    return {
      ok: true,
      status: 200,
      result: { items: [{ task_id: 'task-1', task_type: 'session_commit', status: 'running' }], has_more: false, next_cursor: null },
      requestId: 'req-tasks',
    }
  }

  async readText(uri) {
    this.calls.push(['readText', uri])
    const file = this.files.get(uri)
    if (file === undefined) return { ok: false, status: 404, result: null, error: 'not found', errorCode: 'NOT_FOUND' }
    return { ok: true, status: 200, result: file.content, requestId: 'req-read' }
  }

  async fsStat(uri) {
    this.calls.push(['fsStat', uri])
    if (this.statFailure !== null) return this.statFailure
    const file = this.files.get(uri)
    if (file === undefined) return { ok: false, status: 404, result: null, error: 'not found', errorCode: 'NOT_FOUND' }
    return { ok: true, status: 200, result: { uri, size: Buffer.byteLength(file.content, 'utf8'), modTime: file.modTime } }
  }

  async fsAttrs(uri) {
    return { ok: true, status: 200, result: { uri, attrs: { tags: [...(this.tags.get(uri) ?? [])] } } }
  }

  async writeContent(uri, content) {
    this.calls.push(['writeContent', uri, content])
    if (this.failWrite) return { ok: false, status: 400, result: null, error: 'namespace is read-only' }
    this.files.set(uri, { content, modTime: '2026-11-09T01:00:00Z' })
    return { ok: true, status: 200, result: { uri, written_bytes: Buffer.byteLength(content, 'utf8') }, requestId: 'req-write' }
  }

  async deletePath(uri) {
    this.calls.push(['deletePath', uri])
    if (this.failDelete) return { ok: false, status: 400, result: null, error: 'protected' }
    this.files.delete(uri)
    return { ok: true, status: 200, result: { uri }, requestId: 'req-delete' }
  }

  async setTags(uri, tags, mode) {
    this.calls.push(['setTags', uri, tags, mode])
    const current = this.tags.get(uri) ?? []
    const next = mode === 'clear' ? [] : mode === 'append' ? [...new Set([...current, ...tags])] : [...tags]
    this.tags.set(uri, next)
    return { ok: true, status: 200, result: { uri, tags: next, mode, tags_updated: true }, requestId: 'req-tags' }
  }

  async snapshotCommit(message, paths) {
    this.calls.push(['snapshotCommit', message, paths])
    if (this.failSnapshot) return { ok: false, status: 500, result: null, error: 'snapshot store down' }
    this.commits += 1
    return { ok: true, status: 200, result: { result: 'created', commit_oid: `commit-${this.commits}` }, requestId: 'req-commit' }
  }

  async snapshotRestore(projectDir, sourceCommit, options = {}) {
    this.calls.push(['snapshotRestore', projectDir, sourceCommit, options.dryRun === true])
    if (options.dryRun === true) {
      const diff = this.restoreDiff ?? {
        to_write: [{ path: 'tools.md', oid: sourceCommit }],
        to_delete: [],
        unchanged: [],
      }
      return { ok: true, status: 200, result: { result: 'dry_run', diff }, requestId: 'req-plan' }
    }
    this.appliedRestores.push({ projectDir, sourceCommit })
    return {
      ok: true,
      status: 200,
      result: { result: 'applied', new_commit_oid: `undo-${this.appliedRestores.length}`, task_id: 'task-reindex' },
      requestId: 'req-undo',
    }
  }

  async commitSession(ovSessionId, body, options = {}) {
    this.calls.push(['commitSession', ovSessionId, body, options])
    if (this.failCommit !== null) return this.failCommit
    return {
      ok: true,
      status: 200,
      result: { session_id: ovSessionId, status: 'accepted', task_id: 'task-commit', archive_uri: 'viking://user/default/sessions/dsh-s1/history/archive_001', archived: true },
      requestId: 'req-commit-session',
    }
  }

  async getTask(taskId) {
    return {
      ok: true,
      status: 200,
      result: {
        task_id: taskId,
        task_type: 'session_commit',
        status: 'running',
        created_at: 1000,
        updated_at: 1001,
        resource_id: 'dsh-s1',
        result: { session_id: 'dsh-s1' },
      },
    }
  }

  async getSession(ovSessionId) {
    return {
      ok: true,
      status: 200,
      result: { session_id: ovSessionId, message_count: 9, commit_count: 3, pending_tokens: 123, last_commit_at: null },
    }
  }

  async dashboardSummary() {
    return {
      ok: true,
      status: 200,
      result: {
        context_counts: { files: 4, skills: 1, memories: 9, total: 14 },
        today_tokens: { total: 1234 },
        today_retrievals: { total: 5 },
      },
    }
  }

  async observerQueue() {
    return { ok: true, status: 200, result: { status: { queues: [{ queue: 'semantic', pending: 2, in_progress: 1, errors: 0, processed: 7 }] } } }
  }

  async memoryStats() {
    return {
      ok: true,
      status: 200,
      result: { total_memories: 9, by_category: { events: 3, entities: 6 }, hotness_distribution: { hot: 1 }, staleness: { not_accessed_7d: 2, not_accessed_30d: 1, oldest_memory_age_days: 40 } },
    }
  }

  async sessionStats() {
    return { ok: true, status: 200, result: { session_id: 'dsh-s1', total_turns: 7, memories_extracted: 3 } }
  }

  async cancelTask(taskId) {
    return { ok: true, status: 200, result: { task_id: taskId, task_type: 'session_commit', status: 'cancelling' } }
  }
}

/** A commit-service stand-in with the read methods the write path uses. */
function fakeCommit(_fake) {
  const commit = {
    ovSessionId: () => 'dsh-s1',
    actorPeer: () => 'peer-repo',
    pluginConfig: () => ({
      enabled: true,
      autoCapture: false,
      captureAssistantTurns: true,
      captureToolResults: false,
      commitTokenThreshold: 20000,
    }),
    pluginMounted: () => true,
    status: async (sessionId) => ({
      sessionId,
      ovSessionId: 'dsh-s1',
      pendingTokens: 123,
      threshold: 20000,
      ratio: 0.01,
      commitCount: 3,
      lastCommitAt: null,
      phase: 'idle',
      latest: null,
      archives: [],
    }),
    commits: async (sessionId) => ({ status: await commit.status(sessionId), tasks: [], summaries: [] }),
  }
  return commit
}

/** One write service over the fake server, with a controllable clock. */
function writeRig(overrides = {}) {
  const fake = new FakeOpenViking()
  const dir = tempDir('write')
  const audit = new AuditLog({ dir })
  const clock = { now: 1000 }
  const identity = { current: { ...IDENTITY } }
  const flags = { writes: overrides.writesEnabled ?? true, transport: overrides.transport ?? true }
  const commit = overrides.commit ?? fakeCommit(fake)
  const capabilities = new CapabilityService({ api: fake, transport: () => flags.transport })
  const sessions = new SessionControlService({ api: fake, commit })
  const service = new WriteService({
    api: fake,
    capabilities,
    sessions,
    audit,
    identity: () => identity.current,
    writesEnabled: () => flags.writes,
    transport: () => flags.transport,
    actorPeer: (sessionId) => (sessionId === undefined ? undefined : commit.actorPeer?.()),
    now: () => clock.now,
    tokenTtlMs: overrides.tokenTtlMs ?? 120_000,
    maxPending: overrides.maxPending ?? 8,
    rateLimit: overrides.rateLimit ?? 3,
    ...(overrides.prepareRateLimit === undefined ? {} : { prepareRateLimit: overrides.prepareRateLimit }),
    ...(overrides.prepareRateWindowMs === undefined ? {} : { prepareRateWindowMs: overrides.prepareRateWindowMs }),
    ...(overrides.options ?? {}),
  })
  return { fake, audit, dir, clock, identity, flags, capabilities, sessions, service, commit }
}


/* ========================================================================
 * The write protocol against the fake server
 * ===================================================================== */

test('prepare fails closed before any mutation when a gate is off', async () => {
  const disabled = writeRig({ writesEnabled: false })
  const off = await disabled.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(off.ok, false)
  assert.equal(off.error.code, 'writes-disabled')
  assert.equal(
    disabled.fake.calls.some((call) => call[0] === 'snapshotCommit' || call[0] === 'deletePath'),
    false,
    'a disabled write touches nothing',
  )

  const noTransport = writeRig({ transport: false })
  const transport = await noTransport.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(transport.ok, false)
  assert.equal(transport.error.code, 'transport-unavailable')

  const healthy = writeRig()
  const badTarget = await healthy.service.prepare({ action: 'delete-memory', target: 'viking://user/default/memories/rules/x.md' })
  assert.equal(badTarget.ok, false)
  assert.equal(badTarget.error.code, 'target-not-curatable')
  assert.equal(badTarget.error.details.reason, 'memory-kind-not-curatable')

  healthy.fake.healthOk = false
  healthy.capabilities.invalidate()
  const unhealthy = await healthy.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(unhealthy.ok, false)
  assert.equal(unhealthy.error.code, 'profile-unhealthy')
})

test('prepare takes the pre-write snapshot and returns a typed confirmation', async () => {
  const { service, fake } = writeRig()
  const prepared = await service.prepare({ action: 'delete-memory', target: MEMORY, sessionId: 's1' })
  assert.equal(prepared.ok, true)
  assert.match(prepared.token, /^[0-9a-f]{64}$/)
  assert.equal(prepared.action, 'delete-memory')
  assert.equal(prepared.target, MEMORY)
  assert.equal(prepared.confirmWord, 'tools.md')
  assert.match(prepared.revision.sha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(prepared.preCommit, 'commit-1')
  assert.equal(prepared.scope.fingerprint, IDENTITY.fingerprint)
  assert.equal(prepared.expiresAt, 1000 + 120_000)
  assert.equal(prepared.content, null, 'a delete never carries the body')
  assert.equal(prepared.summary.length >= 2, true)
  const snapshotCall = fake.calls.find((call) => call[0] === 'snapshotCommit')
  assert.deepEqual(snapshotCall[2], ['viking://user/default/memories/preferences'], 'the delete snapshots the same directory it will restore')
  assert.equal(snapshotCall[1].includes('pre-write'), true)
  assert.equal(fake.calls.some((call) => call[0] === 'deletePath'), false, 'prepare does not delete')
})

test('execute needs the typed file name and deletes only after it matches', async () => {
  const { service, fake } = writeRig()
  const prepared = await service.prepare({ action: 'delete-memory', target: MEMORY, sessionId: 's1' })
  assert.equal(prepared.ok, true)

  const missing = await service.execute({ token: prepared.token })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'typed-confirmation-required')
  const wrong = await service.execute({ token: prepared.token, typed: 'other.md' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'typed-confirmation-mismatch')
  assert.equal(fake.files.has(MEMORY), true, 'the file survives a refused confirmation')
  assert.equal(fake.calls.some((call) => call[0] === 'deletePath'), false)

  const done = await service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(done.ok, true)
  assert.equal(done.action, 'delete-memory')
  assert.equal(done.verified, true)
  assert.equal(done.undoId !== null, true)
  assert.match(done.auditId, /^aud-/)
  assert.equal(fake.files.has(MEMORY), false)
  const post = fake.calls.filter((call) => call[0] === 'snapshotCommit').map((call) => call[1])
  assert.equal(post.some((message) => message.startsWith('post-write')), true, 'a post-write snapshot is taken')
})

test('a written delete is audited without the body, and undo restores from the snapshot', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY, sessionId: 's1' })
  const done = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(done.ok, true)

  const entries = rig.audit.recent(10).entries
  assert.equal(entries[0].kind, 'write')
  assert.equal(entries[0].action, 'delete-memory')
  assert.equal(entries[0].target, MEMORY)
  assert.equal(entries[0].result, 'ok')
  assert.equal(entries[0].identity.dshSessionId, 's1')
  const rawAudit = readFileSync(rig.audit.path, 'utf8')
  assert.equal(rawAudit.includes('Original body'), false, 'the audit file never stores a body')

  const plan = await rig.service.plan({ undoId: done.undoId })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.tagsOnly, false)
  assert.equal(plan.plan.extraChanges, false)
  assert.deepEqual(plan.plan.toWrite.map((entry) => entry.path), ['tools.md'])
  assert.equal(plan.plan.toWrite[0].expected, true)
  assert.equal(rig.fake.appliedRestores.length, 0, 'the plan did not apply anything')

  const undone = await rig.service.undo({ undoId: done.undoId })
  assert.equal(undone.ok, true)
  assert.equal(undone.outcome, 'restored')
  assert.equal(undone.newCommit, 'undo-1')
  assert.equal(undone.taskId, 'task-reindex')
  assert.equal(rig.fake.appliedRestores.length, 1)
  assert.equal(rig.audit.recent(5).entries[0].kind, 'undo')
  assert.equal(rig.audit.recent(5).entries[0].result, 'undone')

  const again = await rig.service.undo({ undoId: done.undoId })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'token-used')
})

test('an identity switch invalidates pending tokens and live undo handles', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY, sessionId: 's1' })
  assert.equal(prepared.ok, true)
  rig.identity.current = { ...IDENTITY, fingerprint: `sha256:${'b'.repeat(64)}` }
  const switched = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(switched.ok, false)
  assert.equal(switched.error.code, 'identity-changed')
  assert.equal(rig.fake.files.has(MEMORY), true, 'nothing is written under a different identity')

  // The same rule protects undo: prepare and execute, then switch.
  rig.identity.current = { ...IDENTITY }
  const second = await rig.service.prepare({ action: 'delete-memory', target: MEMORY, sessionId: 's1' })
  const done = await rig.service.execute({ token: second.token, typed: 'tools.md' })
  assert.equal(done.ok, true)
  rig.identity.current = { ...IDENTITY, fingerprint: `sha256:${'c'.repeat(64)}` }
  const refused = await rig.service.undo({ undoId: done.undoId })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'identity-changed')
  assert.equal(rig.fake.appliedRestores.length, 0)
  assert.equal(rig.audit.recent(20).entries.some((entry) => entry.kind === 'denied' && entry.action === 'undo'), true)
})

test('tokens are single-use and expire after the TTL', async () => {
  const rig = writeRig({ tokenTtlMs: 1000 })
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(prepared.ok, true)
  rig.clock.now += 1001
  const expired = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(expired.ok, false)
  assert.equal(expired.error.code, 'token-expired')
  assert.equal(rig.fake.files.has(MEMORY), true)

  rig.clock.now += 10_000
  const second = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  const done = await rig.service.execute({ token: second.token, typed: 'tools.md' })
  assert.equal(done.ok, true)
  const used = await rig.service.execute({ token: second.token, typed: 'tools.md' })
  assert.equal(used.ok, false)
  assert.equal(used.error.code, 'token-used')
})

test('a revision changed after prepare is a conflict, not a lost update', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.content, 'Original body')
  rig.fake.files.set(MEMORY, { content: 'Changed by a concurrent writer', modTime: null })
  const conflict = await rig.service.execute({ token: prepared.token, content: 'my new body' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'revision-mismatch')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'writeContent'), false, 'no write after a mismatch')
})

test('the edit happy path writes, verifies the read-back, post-commits and audits', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY, sessionId: 's1' })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.beforeChars, 'Original body'.length)
  const done = await rig.service.execute({ token: prepared.token, content: 'A better body' })
  assert.equal(done.ok, true)
  assert.equal(done.verified, true)
  assert.equal(done.revision.size, 'A better body'.length)
  assert.equal(rig.fake.files.get(MEMORY).content, 'A better body')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'writeContent'), true)
  const snapshots = rig.fake.calls.filter((call) => call[0] === 'snapshotCommit').map((call) => call[1])
  assert.equal(snapshots.some((message) => message.startsWith('pre-write')), true)
  assert.equal(snapshots.some((message) => message.startsWith('post-write')), true)
  assert.equal(rig.audit.recent(5).entries[0].requestId, 'req-write', 'the server request id is recorded')
})

test('a failing snapshot aborts the edit before the write (fail closed)', async () => {
  const rig = writeRig()
  rig.fake.failSnapshot = true
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.error.code, 'snapshot-unavailable')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'writeContent'), false)
})

test('the server refusing the write is surfaced, audited and leaves the undo handle out', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  rig.fake.failWrite = true
  const failed = await rig.service.execute({ token: prepared.token, content: 'nope' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'rejected-by-server')
  const audit = rig.audit.recent(5).entries[0]
  assert.equal(audit.result, 'failed')
  assert.match(audit.error, /rejected-by-server/)
})

test('the write rate limit is enforced at execution time (review N1)', async () => {
  const rig = writeRig({ rateLimit: 1 })
  // A conflict must not consume the budget (only successful executions count).
  const conflictPrep = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  rig.fake.files.set(MEMORY, { content: 'concurrently changed', modTime: null })
  const conflict = await rig.service.execute({ token: conflictPrep.token, content: 'attempt' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'revision-mismatch')

  // Two prepared tokens: the first executes, the second is refused by the limit
  // even though it was prepared before the limit was reached.
  const first = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  const second = await rig.service.prepare({
    action: 'edit-memory',
    target: 'viking://user/default/memories/entities/project/sidebar.md',
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  const executed = await rig.service.execute({ token: first.token, content: 'written once' })
  assert.equal(executed.ok, true)
  const limited = await rig.service.execute({ token: second.token, content: 'written twice' })
  assert.equal(limited.ok, false)
  assert.equal(limited.error.code, 'rate-limited')
  assert.equal(limited.error.details.kind, 'execute')
  assert.equal(typeof limited.error.details.retryAfterMs, 'number')
  assert.equal(rig.service.pendingAction(second.token), 'edit-memory', 'a rate rejection keeps the token usable')
  assert.equal(
    rig.fake.files.get('viking://user/default/memories/entities/project/sidebar.md').content,
    'Rows sort by order.',
    'the refused execution wrote nothing',
  )

  // Retrying after the window works without re-preparing.
  rig.clock.now += 60_001
  const retried = await rig.service.execute({ token: second.token, content: 'written twice' })
  assert.equal(retried.ok, true)
  assert.equal(
    rig.fake.files.get('viking://user/default/memories/entities/project/sidebar.md').content,
    'written twice',
  )
  // The limit is a policy denial, so it is audited.
  assert.equal(
    rig.audit.recent(20).entries.some((entry) => entry.kind === 'denied' && /rate-limited/.test(entry.error ?? '')),
    true,
  )
})

test('prepares have a separate snapshot-protecting quota (review N2)', async () => {
  const rig = writeRig({ prepareRateLimit: 2, rateLimit: 10 })
  const first = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(first.ok, true)
  // Cancelling does not refund the quota: the snapshot was already taken.
  assert.equal(rig.service.cancel(first.token).status, 'cancelled')
  const second = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(second.ok, true)
  assert.equal(rig.service.cancel(second.token).status, 'cancelled')
  const third = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(third.ok, false)
  assert.equal(third.error.code, 'rate-limited')
  assert.equal(third.error.details.kind, 'prepare')
  assert.equal(rig.fake.calls.filter((call) => call[0] === 'snapshotCommit').length, 2, 'only two snapshots were committed')
  assert.equal(
    rig.audit.recent(20).entries.some((entry) => entry.kind === 'denied' && /confirmations per minute/.test(entry.error ?? '')),
    true,
  )
  // The quota window rolls over.
  rig.clock.now += 60_001
  const afterWindow = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(afterWindow.ok, true)
})

test('the pending cap and the single-write guard fail closed', async () => {
  const capped = writeRig({ rateLimit: 10, maxPending: 1 })
  const first = await capped.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(first.ok, true)
  const second = await capped.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'too-many-pending')

  const inFlight = writeRig()
  const pending = await inFlight.service.prepare({ action: 'delete-memory', target: MEMORY, origin: 'command' })
  const executing = inFlight.service.execute({ token: pending.token })
  const concurrent = await inFlight.service.prepare({ action: 'delete-memory', target: MEMORY })
  // With the settling flag set synchronously, the concurrent prepare is refused
  // with the write-in-flight reason rather than a neighbouring code (review S5).
  assert.equal(concurrent.ok, false)
  assert.equal(concurrent.error.code, 'write-in-flight')
  await executing
})

test('cancel frees a pending slot and an executed token cannot be cancelled', async () => {
  const rig = writeRig({ rateLimit: 10, maxPending: 1 })
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(prepared.ok, true)
  assert.equal(await rig.service.prepare({ action: 'delete-memory', target: MEMORY }).then((answer) => answer.ok), false)
  const cancelled = rig.service.cancel(prepared.token)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.action, 'delete-memory')
  assert.equal(rig.audit.recent(5).entries[0].kind, 'cancel')
  assert.equal(rig.audit.recent(5).entries[0].result, 'ok')
  // The slot is free again, and the cancelled token is dead.
  const replacement = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(replacement.ok, true)
  const refused = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'token-used')
  assert.equal(rig.fake.files.has(MEMORY), true, 'a cancelled token never writes')

  // After a successful execution, cancel is an idempotent no-op (no second row).
  const cancelRowsBefore = rig.audit.recent(20).entries.filter((entry) => entry.kind === 'cancel').length
  const done = await rig.service.execute({ token: replacement.token, typed: 'tools.md' })
  assert.equal(done.ok, true)
  const after = rig.service.cancel(replacement.token)
  assert.equal(after.ok, true)
  assert.equal(after.status, 'settled')
  assert.equal(rig.audit.recent(20).entries.filter((entry) => entry.kind === 'cancel').length, cancelRowsBefore)
  assert.equal(rig.service.cancel('f'.repeat(64)).status, 'expired')
})

test('a token crossed with the wrong verb aborts before executing (review B1)', async () => {
  const rig = writeRig()
  rig.fake.tags.set(MEMORY, ['env=prod'])
  const tagsPrep = await rig.service.prepare({ action: 'set-tags', target: MEMORY, tags: ['env=staging'] })
  assert.equal(tagsPrep.ok, true)

  const actions = ['edit-memory', 'delete-memory', 'force-commit']
  for (const expectAction of actions) {
    const crossed = await rig.service.execute({
      token: tagsPrep.token,
      expectAction,
      ...(expectAction === 'edit-memory' ? { content: 'crossed' } : {}),
      ...(expectAction === 'delete-memory' ? { typed: 'tools.md' } : {}),
    })
    assert.equal(crossed.ok, false, `${expectAction} must be refused`)
    assert.equal(crossed.error.code, 'invalid-request')
    assert.equal(crossed.error.details.actual, 'set-tags')
  }
  // Nothing happened: no tag write, no file write, no delete, no commit.
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=prod'])
  assert.equal(rig.fake.files.has(MEMORY), true)
  assert.equal(rig.fake.calls.some((call) => call[0] === 'setTags' || call[0] === 'writeContent' || call[0] === 'deletePath' || call[0] === 'commitSession'), false)
  assert.equal(rig.service.pendingAction(tagsPrep.token), 'set-tags', 'the token is still usable for its own action')

  // The correct action still executes afterwards.
  const done = await rig.service.execute({ token: tagsPrep.token, expectAction: 'set-tags' })
  assert.equal(done.ok, true)
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=staging'])
  assert.equal(rig.service.pendingAction(tagsPrep.token), null, 'a settled token has no pending action')
})

test('a delete only counts as verified when the read says 404', async () => {
  for (const status of [500, 403, 0]) {
    const rig = writeRig()
    const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
    assert.equal(prepared.ok, true)
    // The delete succeeds, but the verification read fails for a non-404 reason.
    rig.fake.statFailure = { ok: false, status, result: null, error: status === 0 ? 'timeout' : `HTTP ${status}` }
    const done = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
    assert.equal(done.ok, true, `delete still succeeds (${status})`)
    assert.equal(done.verified, false, `a ${status} stat is not proof of absence`)
    assert.deepEqual(done.warnings, [{ code: 'verificationPending' }])
  }
  const cleanRig = writeRig()
  const clean = await cleanRig.service.prepare({ action: 'delete-memory', target: MEMORY })
  const cleanDone = await cleanRig.service.execute({ token: clean.token, typed: 'tools.md' })
  assert.equal(cleanDone.verified, true, 'a 404 stat verifies the delete')
})

test('a clean edit undo applies without the extra confirmation (regression)', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  assert.equal(prepared.ok, true)
  const done = await rig.service.execute({ token: prepared.token, content: 'curated body' })
  assert.equal(done.ok, true)
  const plan = await rig.service.plan({ undoId: done.undoId })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.extraChanges, false, 'an untouched target is a clean undo (writtenSha256 matches)')
  const undone = await rig.service.undo({ undoId: done.undoId })
  assert.equal(undone.ok, true)
  assert.equal(undone.outcome, 'restored')
  assert.equal(rig.fake.appliedRestores.length, 1)
})

test('undo requires the second confirmation when a same-named file was rewritten (review S1)', async () => {
  // Edit rewritten after the action.
  const edited = writeRig()
  const editPrep = await edited.service.prepare({ action: 'edit-memory', target: MEMORY })
  const written = await edited.service.execute({ token: editPrep.token, content: 'curated body' })
  assert.equal(written.ok, true)
  edited.fake.files.set(MEMORY, { content: 'someone else rewrote this', modTime: null })
  const editPlan = await edited.service.plan({ undoId: written.undoId })
  assert.equal(editPlan.ok, true)
  assert.equal(editPlan.plan.extraChanges, true, 'a rewritten target is not a clean undo')
  const refused = await edited.service.undo({ undoId: written.undoId })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'extra-changes')
  assert.equal(edited.fake.appliedRestores.length, 0, 'no silent rollback')
  const confirmed = await edited.service.undo({ undoId: written.undoId, confirmExtra: true })
  assert.equal(confirmed.ok, true)
  assert.equal(edited.fake.appliedRestores.length, 1)

  // Deleted path recreated after the action.
  const deleted = writeRig()
  const deletePrep = await deleted.service.prepare({ action: 'delete-memory', target: MEMORY })
  const removed = await deleted.service.execute({ token: deletePrep.token, typed: 'tools.md' })
  deleted.fake.files.set(MEMORY, { content: 'recreated by another writer', modTime: null })
  const deletePlan = await deleted.service.plan({ undoId: removed.undoId })
  assert.equal(deletePlan.ok, true)
  assert.equal(deletePlan.plan.extraChanges, true)
  assert.equal((await deleted.service.undo({ undoId: removed.undoId })).error.code, 'extra-changes')

  // Tags retagged after the action.
  const tagged = writeRig()
  tagged.fake.tags.set(MEMORY, ['env=prod'])
  const tagPrep = await tagged.service.prepare({ action: 'set-tags', target: MEMORY, tags: ['env=staging'] })
  const tagDone = await tagged.service.execute({ token: tagPrep.token })
  tagged.fake.tags.set(MEMORY, ['env=other'])
  const tagPlan = await tagged.service.plan({ undoId: tagDone.undoId })
  assert.equal(tagPlan.ok, true)
  assert.equal(tagPlan.plan.tagsOnly, true)
  assert.equal(tagPlan.plan.extraChanges, true)
  const tagRefused = await tagged.service.undo({ undoId: tagDone.undoId })
  assert.equal(tagRefused.ok, false)
  assert.equal(tagRefused.error.code, 'extra-changes')
  assert.deepEqual(tagged.fake.tags.get(MEMORY), ['env=other'], 'no silent overwrite')
  const tagConfirmed = await tagged.service.undo({ undoId: tagDone.undoId, confirmExtra: true })
  assert.equal(tagConfirmed.ok, true)
  assert.deepEqual(tagged.fake.tags.get(MEMORY), ['env=prod'])
})

test('two undo paths (or undo vs execute) cannot run concurrently (review S5)', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  const done = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  assert.equal(done.ok, true)

  // Slow the forward restore so the second call definitely overlaps.
  const originalRestore = rig.fake.snapshotRestore.bind(rig.fake)
  rig.fake.snapshotRestore = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    return originalRestore(...args)
  }
  const [first, second] = await Promise.all([
    rig.service.undo({ undoId: done.undoId }),
    rig.service.undo({ undoId: done.undoId }),
  ])
  assert.equal(first.ok, true, 'the first undo runs')
  assert.equal(second.ok, false, 'the overlapping undo is refused')
  assert.ok(['write-in-flight', 'token-used'].includes(second.error.code), second.error.code)
  assert.equal(rig.fake.appliedRestores.length, 1, 'the restore is applied exactly once')
})

test('undo and execute are mutually exclusive', async () => {
  const rig = writeRig()
  const first = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  const done = await rig.service.execute({ token: first.token, typed: 'tools.md' })
  assert.equal(done.ok, true)
  const second = await rig.service.prepare({ action: 'edit-memory', target: 'viking://user/default/memories/entities/project/sidebar.md' })
  assert.equal(second.ok, true)

  const originalRestore = rig.fake.snapshotRestore.bind(rig.fake)
  rig.fake.snapshotRestore = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    return originalRestore(...args)
  }
  const undoPromise = rig.service.undo({ undoId: done.undoId })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const during = await rig.service.execute({ token: second.token, expectAction: 'edit-memory', content: 'overlap' })
  const undone = await undoPromise
  assert.equal(undone.ok, true)
  assert.equal(during.ok, false)
  assert.equal(during.error.code, 'write-in-flight')
  assert.equal(rig.fake.appliedRestores.length, 1)
})

test('a peer-scoped target must match the session actor peer', async () => {
  const rig = writeRig() // fakeCommit.actorPeer() === 'peer-repo'
  const mismatch = await rig.service.prepare({
    action: 'edit-memory',
    target: 'viking://user/default/peers/repo-x/memories/entities/a.b/skill.md',
    sessionId: 's1',
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.error.code, 'invalid-request')
  assert.equal(mismatch.error.details.reason, 'peer-mismatch')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'snapshotCommit'), false)

  rig.fake.files.set('viking://user/default/peers/peer-repo/memories/entities/a.b/skill.md', {
    content: 'peer memory',
    modTime: null,
  })
  const match = await rig.service.prepare({
    action: 'edit-memory',
    target: 'viking://user/default/peers/peer-repo/memories/entities/a.b/skill.md',
    sessionId: 's1',
  })
  assert.equal(match.ok, true)
})

test('the test-connection endpoint is not a general URL prober (review S9)', () => {
  for (const allowed of [
    'http://127.0.0.1:1933',
    'http://localhost:1933',
    'https://memory.example.com',
    'http://192.168.1.5:1933',
    'http://[::1]:1933',
    'https://[2001:db8::1]',
  ]) {
    assert.equal(isProbeableEndpoint(allowed), true, `${allowed} may be probed`)
  }
  for (const refused of [
    'ftp://127.0.0.1:1933',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal',
    'http://0.0.0.0:1933',
    'http://255.255.255.255',
    'http://224.0.0.1:1933',
    'http://[::]',
    'http://[fd00:ec2::254]',
    // Review N3: WHATWG normalizes IPv4-mapped IPv6 to hex, and IPv6 link-local
    // is fe80::/10.
    'http://[::ffff:169.254.169.254]',
    'http://[::ffff:a9fe:a9fe]',
    'http://[fe80::1]',
    'http://[febf::1]',
    'http://[::a9fe:a9fe]',
  ]) {
    assert.equal(isProbeableEndpoint(refused), false, `${refused} must be refused`)
  }
})

test('too-large edits are refused at prepare', async () => {
  const rig = writeRig()
  rig.fake.files.set(MEMORY, { content: 'x'.repeat(65_537), modTime: null })
  const prepared = await rig.service.prepare({ action: 'edit-memory', target: MEMORY })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.error.code, 'content-too-large')
})

test('tags prepare reads the old list; execute replaces it; undo re-applies the old list', async () => {
  const rig = writeRig()
  rig.fake.tags.set(MEMORY, ['env=prod', 'team=memory'])
  const prepared = await rig.service.prepare({ action: 'set-tags', target: MEMORY, tags: ['env=staging'] })
  assert.equal(prepared.ok, true)
  assert.deepEqual(prepared.tagsBefore, ['env=prod', 'team=memory'])
  assert.deepEqual(prepared.tagsAfter, ['env=staging'])
  const done = await rig.service.execute({ token: prepared.token })
  assert.equal(done.ok, true)
  assert.deepEqual(done.tags, ['env=staging'])
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=staging'])
  assert.equal(done.undoId !== null, true)

  const plan = await rig.service.plan({ undoId: done.undoId })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.tagsOnly, true)
  const undone = await rig.service.undo({ undoId: done.undoId })
  assert.equal(undone.ok, true)
  assert.equal(undone.outcome, 'tags-restored')
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=prod', 'team=memory'])
})

test('invalid tags are refused before any server call', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'set-tags', target: MEMORY, tags: ['not a tag'] })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.error.code, 'invalid-tags')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'setTags'), false)

  const clean = await rig.service.prepare({ action: 'set-tags', target: MEMORY })
  const executed = await rig.service.execute({ token: clean.token, tags: ['=bad'] })
  assert.equal(executed.ok, false)
  assert.equal(executed.error.code, 'invalid-tags')
})

test('an undo plan that touches extra files needs a second explicit confirmation', async () => {
  const rig = writeRig()
  rig.fake.restoreDiff = {
    to_write: [
      { path: 'tools.md', oid: 'x' },
      { path: 'someone-elses.md', oid: 'y' },
    ],
    to_delete: [],
    unchanged: 1,
  }
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  const done = await rig.service.execute({ token: prepared.token, typed: 'tools.md' })
  const plan = await rig.service.plan({ undoId: done.undoId })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.extraChanges, true)
  assert.deepEqual(plan.plan.toWrite.map((entry) => [entry.path, entry.expected]), [
    ['tools.md', true],
    ['someone-elses.md', false],
  ])
  const refused = await rig.service.undo({ undoId: done.undoId })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'extra-changes')
  assert.equal(refused.error.details.extraChanges, true)
  assert.equal(rig.fake.appliedRestores.length, 0)

  const applied = await rig.service.undo({ undoId: done.undoId, confirmExtra: true })
  assert.equal(applied.ok, true)
  assert.equal(rig.fake.appliedRestores.length, 1)
})

test('force commit reads the session first, commits once with the actor peer, and audits the task', async () => {
  const rig = writeRig()
  const prepared = await rig.service.prepare({ action: 'force-commit', target: 's1', sessionId: 's1' })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.session.pendingTokens, 123)
  assert.equal(prepared.session.messageCount, 9)
  assert.equal(prepared.preCommit, null, 'a force commit does not take a file snapshot')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'commitSession'), false, 'prepare does not commit')

  const done = await rig.service.execute({ token: prepared.token })
  assert.equal(done.ok, true)
  assert.equal(done.taskId, 'task-commit')
  assert.equal(done.undoId, null, 'force commit is not undoable')
  assert.equal(done.task.status, 'running')
  const commitCall = rig.fake.calls.find((call) => call[0] === 'commitSession')
  assert.deepEqual(commitCall[2], { keep_recent_count: 0 })
  assert.equal(commitCall[3].actorPeerId, 'peer-repo')
  const audit = rig.audit.recent(5).entries[0]
  assert.equal(audit.kind, 'commit')
  assert.equal(audit.action, 'force-commit')
  assert.equal(audit.result, 'ok')
})

test('force commit maps skipped and failed-precondition answers honestly', async () => {
  const skippedRig = writeRig()
  skippedRig.fake.failCommit = {
    ok: true,
    status: 200,
    result: { session_id: 'dsh-s1', status: 'skipped', task_id: null, archive_uri: null, archived: false, reason: 'no_messages' },
  }
  const skippedPrep = await skippedRig.service.prepare({ action: 'force-commit', target: 's1', sessionId: 's1' })
  const skipped = await skippedRig.service.execute({ token: skippedPrep.token })
  assert.equal(skipped.ok, true)
  assert.equal(skipped.taskId, null)
  assert.deepEqual(skipped.warnings, [{ code: 'commitSkipped', params: { reason: 'no_messages' } }])

  const failedRig = writeRig()
  failedRig.fake.failCommit = {
    ok: false,
    status: 412,
    result: null,
    error: 'A previous archive failed; later commits fail until it is resolved',
    errorCode: 'FAILED_PRECONDITION',
  }
  const failedPrep = await failedRig.service.prepare({ action: 'force-commit', target: 's1', sessionId: 's1' })
  const failed = await failedRig.service.execute({ token: failedPrep.token })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'rejected-by-server')
  assert.equal(failed.error.details.reason, 'failed-precondition')
  assert.equal(failedRig.audit.recent(5).entries[0].result, 'failed')
})

/* ========================================================================
 * F10 capture state + F11 activity
 * ===================================================================== */

test('session control displays the resolved capture flags and refuses to pretend it can pause', async () => {
  const rig = writeRig()
  const control = new SessionControlService({ api: rig.fake, commit: rig.commit })
  const capture = control.captureState('s1')
  assert.equal(capture.mounted, true)
  assert.equal(capture.enabled, true)
  assert.equal(capture.autoCapture, false)
  assert.equal(capture.captureAssistantTurns, true)
  assert.equal(capture.captureToolResults, false)
  assert.equal(capture.commitTokenThreshold, 20000)
  assert.equal(capture.canPause, false, 'no upstream API exists; the UI must not offer one')

  const read = await control.read('s1')
  assert.equal(read.capture.mounted, true)
  assert.equal(read.session.pendingTokens, 123)
  assert.equal(read.failedArchive, null)
  assert.equal(read.ovSessionId, 'dsh-s1')
})

test('activity maps task rows and refuses to export private fields', async () => {
  const fake = new FakeOpenViking()
  const activity = new ActivityService({ api: fake })
  const list = await activity.tasks({ status: 'running' })
  assert.equal(list.available, true)
  assert.equal(list.tasks[0].taskId, 'task-1')
  assert.equal(list.tasks[0].taskType, 'session_commit')
  assert.equal(list.tasks[0].status, 'running')

  fake.tasksStatus = 404
  const unavailable = await new ActivityService({ api: fake }).tasks()
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.note, 'tasks-unavailable')

  const detail = await activity.task('task-1', { events: true })
  assert.equal(detail.ok, true)
  assert.equal(detail.task.taskId, 'task-1')
  assert.equal(detail.task.events, null)
  const exported = await activity.exportTask('task-1')
  assert.equal(exported.ok, true)
  assert.equal(exported.task.meta, undefined, 'meta is never exported')
  assert.equal(exported.fileName.startsWith('openviking-task-'), true)

  const mapped = mapTask({
    task_id: 't',
    task_type: 'session_commit',
    status: 'completed',
    created_at: 1,
    updated_at: 2,
    resource_id: 'dsh-s1',
    result: {
      session_id: 'dsh-s1',
      archive_uri: 'viking://x',
      memories_extracted: { total: 3, memory_write: 2, memory_edit: 1 },
      token_usage: { total: { total: 55 } },
      memory_diff_uri: 'viking://x/memory_diff.json',
    },
  })
  assert.equal(mapped.resultSummary.memoriesExtracted.total, 3)
  assert.equal(mapped.resultSummary.totalTokens, 55)

  const truncated = mapTask({
    task_id: 't',
    task_type: 'session_commit',
    status: 'failed',
    error: 'first line of the error\nsecond line must not survive with the rest of a very long body ' + 'x'.repeat(500),
  })
  assert.equal(truncated.error.startsWith('first line of the error'), true)
  assert.equal(truncated.error.includes('\n'), false, 'Activity errors are single-line like the audit file')
  assert.ok(truncated.error.length <= 300)

  const safe = safeTaskExport({
    task_id: 't',
    task_type: 'session_commit',
    meta: { private_blob: 'must not be exported' },
    result: { session_id: 'dsh-s1', private_blob: 'body', memory_diff_uri: 'viking://x' },
  })
  assert.equal(safe.meta, undefined)
  assert.equal(safe.result.private_blob, undefined)
  assert.equal(safe.result.memory_diff_uri, 'viking://x')

  assert.equal(
    isCancellableTask({ taskId: 't', taskType: 'session_commit', status: 'running', stage: null, error: null, createdAt: null, updatedAt: null, processingSeconds: null, resourceId: null, resultSummary: null }),
    true,
  )
  assert.equal(
    isCancellableTask({ taskId: 't', taskType: 'session_commit', status: 'completed', stage: null, error: null, createdAt: null, updatedAt: null, processingSeconds: null, resourceId: null, resultSummary: null }),
    false,
  )
  assert.equal(
    isCancellableTask({ taskId: 't', taskType: 'unknown_kind', status: 'running', stage: null, error: null, createdAt: null, updatedAt: null, processingSeconds: null, resourceId: null, resultSummary: null }),
    false,
  )
})

test('metrics map the four cheap sources and degrade per card', async () => {
  const fake = new FakeOpenViking()
  fake.observerQueue = async () => ({ ok: false, status: 404, result: null, error: 'not found' })
  const activity = new ActivityService({ api: fake })
  const metrics = await activity.metrics({ sessionId: 's1', ovSessionId: 'dsh-s1' })
  assert.equal(metrics.dashboard.available, true)
  assert.equal(metrics.dashboard.memories, 9)
  assert.equal(metrics.dashboard.todayTokens, 1234)
  assert.equal(metrics.queue.available, false)
  assert.deepEqual(metrics.queue.queues, [])
  assert.equal(metrics.memories.total, 9)
  assert.equal(metrics.memories.byCategory.entities, 6)
  assert.equal(metrics.session.totalTurns, 7)
  assert.equal(metrics.prometheus, false, 'Prometheus /metrics is never called by default')

  // Cache: a second read within the TTL does not re-ask the server.
  let calls = 0
  const counting = new FakeOpenViking()
  const base = counting.dashboardSummary.bind(counting)
  counting.dashboardSummary = async () => {
    calls += 1
    return base()
  }
  const cached = new ActivityService({ api: counting })
  await cached.metrics({ sessionId: 's1', ovSessionId: 'dsh-s1' })
  await cached.metrics({ sessionId: 's1', ovSessionId: 'dsh-s1' })
  assert.equal(calls, 1)
  await cached.metrics({ sessionId: 's1', ovSessionId: 'dsh-s1', fresh: true })
  assert.equal(calls, 2)
})

test('the capability probe distinguishes snapshot history, no history and an absent route', async () => {
  const fake = new FakeOpenViking()
  const service = new CapabilityService({ api: fake, transport: () => true })
  const present = await service.probe(true)
  assert.equal(present.snapshot.available, true)
  assert.equal(present.snapshot.kind, 'history')
  assert.equal(present.tasks.available, true)

  fake.snapshotStatus = 404
  const fresh = new CapabilityService({ api: fake, transport: () => true })
  const noHistory = await fresh.probe(true)
  assert.equal(noHistory.snapshot.available, true)
  assert.equal(noHistory.snapshot.kind, 'no-history')

  const absent = new CapabilityService({
    api: {
      health: () => fake.health(),
      listTasks: () => fake.listTasks(),
      probeRuleSearchRoute: () => fake.probeRuleSearchRoute(),
      snapshotLog: async () => ({ ok: false, status: 404, result: null, error: 'Not Found', errorCode: null, errorDetails: null }),
    },
    transport: () => true,
  })
  const missing = await absent.probe(true)
  assert.equal(missing.snapshot.available, false)
  assert.equal(missing.snapshot.kind, 'route-absent')
  assert.equal(missing.snapshot.detail, 'snapshot-unavailable')
})

test('/viking tag --append prepares an append update', async () => {
  const rig = writeRig()
  rig.fake.tags.set(MEMORY, ['env=prod'])
  const command = commandFor(rig)
  const prepared = await command.run('tag viking://user/default/memories/preferences/tools.md --append team=memory', 's1')
  assert.equal(prepared.kind, 'success')
  const envelope = envelopeOf(prepared)
  assert.equal(envelope.prepare.tagMode, 'append')
  assert.deepEqual(envelope.prepare.tagsAfter, ['env=prod', 'team=memory'])
})

/* ========================================================================
 * Auth-mode header policy (docs/api-v05.md §5.1)
 * ===================================================================== */

import http from 'node:http'
import { OpenVikingApi } from '../src/host/openviking-api.ts'

test('identity headers are sent in dev mode and omitted for api_key credentials', async () => {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push({ account: request.headers['x-openviking-account'], user: request.headers['x-openviking-user'], auth: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  try {
    await new OpenVikingApi({ endpoint, apiKey: 'k', account: 'acct', user: 'alice', authMode: 'dev' }).health()
    assert.deepEqual(seen.at(-1), { account: 'acct', user: 'alice', auth: 'Bearer k' })

    await new OpenVikingApi({ endpoint, apiKey: 'k', account: 'acct', user: 'alice', authMode: 'api_key' }).health()
    assert.deepEqual(seen.at(-1), { account: undefined, user: undefined, auth: 'Bearer k' }, 'key-bound identity ignores the headers')

    await new OpenVikingApi({ endpoint, apiKey: 'k', account: 'acct', user: 'alice', authMode: null }).health()
    assert.deepEqual(seen.at(-1), { account: 'acct', user: 'alice', auth: 'Bearer k' }, 'an unprobed mode keeps the v0.4 behaviour')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a profile carries its auth-mode hint into the resolved connection', () => {
  const dir = tempDir('profiles-authmode')
  const store = new ProfileStore({ dir })
  store.save({
    id: 'cloud',
    label: 'Cloud',
    endpoint: 'https://memory.example.com',
    authMode: 'api_key',
    apiKey: 'k',
    account: 'acct',
    user: 'alice',
    peerId: '',
  })
  const resolved = resolveConnectionForProfile(store.read().file.profiles, 'cloud')
  assert.equal(resolved.connection.authMode, 'api_key')
  assert.equal(resolved.authModeHint, 'api_key')
  const unknown = resolveConnectionForProfile([], '')
  assert.equal(unknown.connection.authMode, undefined)
})

/* ========================================================================
 * F6: the /viking write verbs over the same protocol (review B1 ordering)
 * ===================================================================== */

import { VikingCommand } from '../src/host/viking-command.ts'

/** One command runner sharing the rig's write service and fake server. */
function commandFor(rig) {
  return new VikingCommand({
    api: rig.fake,
    connection: { endpoint: 'http://127.0.0.1:1933', apiKey: '', account: 'default', user: 'default' },
    commit: rig.commit,
    recall: {},
    doctor: {},
    preview: {},
    writes: rig.service,
    writesEnabled: () => rig.flags.writes,
    identity: () => rig.identity.current,
    audit: rig.audit,
  })
}

/** The last JSON envelope line of a successful command result. */
function envelopeOf(result) {
  const lines = (result.text ?? '').split('\n').filter((line) => line.startsWith('{'))
  return JSON.parse(lines.at(-1))
}

test('/viking forget prepares, then --confirm executes; neither needs the card', async () => {
  const rig = writeRig()
  const command = commandFor(rig)
  const prepared = await command.run('forget viking://user/default/memories/preferences/tools.md', 's1')
  assert.equal(prepared.kind, 'success')
  const envelope = envelopeOf(prepared)
  assert.equal(envelope.ov, '1')
  assert.equal(envelope.kind, 'confirm')
  assert.equal(envelope.prepare.action, 'delete-memory')
  assert.equal(envelope.prepare.confirmWord, 'tools.md')
  assert.equal(envelope.prepare.content, null, 'no body travels in a command envelope')
  assert.match(prepared.text, /--confirm/)
  assert.equal(rig.fake.files.has(MEMORY), true, 'preparing the command writes nothing')
  assert.equal(rig.service.pendingAction(envelope.prepare.token), 'delete-memory')

  const confirmed = await command.run(`forget --confirm ${envelope.prepare.token}`, 's1')
  assert.equal(confirmed.kind, 'success')
  assert.match(confirmed.text, /Undo handle:/)
  assert.equal(rig.fake.files.has(MEMORY), false)
  assert.equal(rig.audit.recent(5).entries[0].confirmation, 'command')
})

test('/viking edit only opens the editor; uncuratable targets are refused', async () => {
  const rig = writeRig()
  const command = commandFor(rig)
  const edit = await command.run('edit viking://user/default/memories/entities/project/sidebar.md', 's1')
  assert.equal(edit.kind, 'success')
  const envelope = envelopeOf(edit)
  assert.equal(envelope.kind, 'open-editor')
  assert.equal(envelope.uri, 'viking://user/default/memories/entities/project/sidebar.md')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'snapshotCommit'), false, 'edit prepares nothing')

  const rules = await command.run('edit viking://user/default/memories/rules/x.md', 's1')
  assert.equal(rules.kind, 'error')
  assert.match(rules.text, /Not curatable/)
})

test('/viking tag --clear prepares an empty tag list and --confirm clears it', async () => {
  const rig = writeRig()
  rig.fake.tags.set(MEMORY, ['env=prod'])
  const command = commandFor(rig)
  const prepared = await command.run('tag viking://user/default/memories/preferences/tools.md --clear', 's1')
  assert.equal(prepared.kind, 'success')
  const envelope = envelopeOf(prepared)
  assert.equal(envelope.prepare.action, 'set-tags')
  assert.deepEqual(envelope.prepare.tagsAfter, [])
  const confirmed = await command.run(`tag --confirm ${envelope.prepare.token}`, 's1')
  assert.equal(confirmed.kind, 'success')
  assert.deepEqual(rig.fake.tags.get(MEMORY), [])
})

test('/viking commit always requires the confirmation round trip', async () => {
  const rig = writeRig()
  const command = commandFor(rig)
  const prepared = await command.run('commit', 's1')
  assert.equal(prepared.kind, 'success')
  const envelope = envelopeOf(prepared)
  assert.equal(envelope.prepare.action, 'force-commit')
  assert.match(prepared.text, /Confirmation is always required|Confirm in the card/)
  assert.equal(rig.fake.calls.some((call) => call[0] === 'commitSession'), false)

  const confirmed = await command.run(`commit --confirm ${envelope.prepare.token}`, 's1')
  assert.equal(confirmed.kind, 'success')
  assert.match(confirmed.text, /task-commit/)
  assert.equal(rig.fake.calls.some((call) => call[0] === 'commitSession'), true)
})

test('/viking undo applies a handle from a previous result, and /viking audit lists the trail', async () => {
  const rig = writeRig()
  const command = commandFor(rig)
  const prepared = await command.run('forget viking://user/default/memories/preferences/tools.md', 's1')
  const token = envelopeOf(prepared).prepare.token
  const confirmed = await command.run(`forget --confirm ${token}`, 's1')
  const undoId = /Undo handle: ([0-9a-f]{32})/.exec(confirmed.text)?.[1]
  assert.ok(undoId, `the result names the undo handle (${confirmed.text})`)
  const undone = await command.run(`undo ${undoId}`, 's1')
  assert.equal(undone.kind, 'success')
  assert.equal(rig.fake.appliedRestores.length, 1)

  const audit = await command.run('audit 5', 's1')
  assert.equal(audit.kind, 'success')
  assert.match(audit.text, /write\/delete-memory/)
  assert.match(audit.text, /undo\/delete-memory/)
  assert.equal(audit.text.includes('Original body'), false)
})

test('a crossed token cannot execute its prepared action from a different verb (review B1)', async () => {
  // A tag token confirmed as `forget`: the bug performed the tag write first.
  const tagsRig = writeRig()
  tagsRig.fake.tags.set(MEMORY, ['env=prod'])
  const tagsCommand = commandFor(tagsRig)
  const tagPrep = await tagsCommand.run('tag viking://user/default/memories/preferences/tools.md env=staging', 's1')
  const tagToken = envelopeOf(tagPrep).prepare.token
  const crossedForget = await tagsCommand.run(`forget --confirm ${tagToken}`, 's1')
  assert.equal(crossedForget.kind, 'error')
  assert.match(crossedForget.text, /invalid-request/)
  assert.match(crossedForget.text, /set-tags/)
  assert.deepEqual(tagsRig.fake.tags.get(MEMORY), ['env=prod'], 'nothing was written')
  assert.equal(tagsRig.fake.files.has(MEMORY), true)
  assert.equal(tagsRig.fake.calls.some((call) => call[0] === 'setTags' || call[0] === 'deletePath'), false)
  assert.equal(tagsRig.service.pendingAction(tagToken), 'set-tags', 'the token is still usable for its own verb')
  const correct = await tagsCommand.run(`tag --confirm ${tagToken}`, 's1')
  assert.equal(correct.kind, 'success')
  assert.deepEqual(tagsRig.fake.tags.get(MEMORY), ['env=staging'])

  // A delete token confirmed as `tag`: no tags write, no delete.
  const deleteRig = writeRig()
  const deleteCommand = commandFor(deleteRig)
  const deletePrep = await deleteCommand.run('forget viking://user/default/memories/preferences/tools.md', 's1')
  const deleteToken = envelopeOf(deletePrep).prepare.token
  const crossedTag = await deleteCommand.run(`tag --confirm ${deleteToken}`, 's1')
  assert.equal(crossedTag.kind, 'error')
  assert.match(crossedTag.text, /invalid-request/)
  assert.equal(deleteRig.fake.calls.some((call) => call[0] === 'setTags' || call[0] === 'deletePath'), false)
  assert.equal(deleteRig.fake.files.has(MEMORY), true)

  // A commit token confirmed as `forget`: no commit, no delete.
  const commitRig = writeRig()
  const commitCommand = commandFor(commitRig)
  const commitPrep = await commitCommand.run('commit', 's1')
  const commitToken = envelopeOf(commitPrep).prepare.token
  const crossedCommit = await commitCommand.run(`forget --confirm ${commitToken}`, 's1')
  assert.equal(crossedCommit.kind, 'error')
  assert.match(crossedCommit.text, /invalid-request/)
  assert.equal(commitRig.fake.calls.some((call) => call[0] === 'commitSession' || call[0] === 'deletePath'), false)

  // A settled/unknown token is reported as expired rather than executed.
  const unknown = await commitCommand.run(`commit --confirm ${'f'.repeat(64)}`, 's1')
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /token-expired/)
  assert.equal(commitRig.fake.calls.some((call) => call[0] === 'commitSession'), false)
})

test('with writes off the write verbs refuse and the help omits them', async () => {
  const rig = writeRig({ writesEnabled: false })
  const command = commandFor(rig)
  const forget = await command.run('forget viking://user/default/memories/preferences/tools.md', 's1')
  assert.equal(forget.kind, 'error')
  assert.match(forget.text, /Write commands are disabled/)
  const help = await command.run('help', 's1')
  assert.equal(help.kind, 'success')
  assert.match(help.text, /Writes are off/)
  assert.equal(help.text.includes('/viking forget'), false)
  assert.equal(rig.fake.calls.some((call) => call[0] === 'snapshotCommit'), false)
})

/* ========================================================================
 * Tag modes and the identity gate (restored after review edits)
 * ===================================================================== */

test('append tags add to the existing list and undo restores it; a clear empties it', async () => {
  const rig = writeRig()
  rig.fake.tags.set(MEMORY, ['env=prod'])
  const prepared = await rig.service.prepare({ action: 'set-tags', target: MEMORY, tags: ['team=memory'], tagMode: 'append' })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.tagMode, 'append')
  assert.deepEqual(prepared.tagsAfter, ['env=prod', 'team=memory'])
  const done = await rig.service.execute({ token: prepared.token })
  assert.equal(done.ok, true)
  const set = rig.fake.calls.filter((call) => call[0] === 'setTags').at(-1)
  assert.equal(set[3], 'append')
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=prod', 'team=memory'])
  const undone = await rig.service.undo({ undoId: done.undoId })
  assert.equal(undone.ok, true)
  assert.deepEqual(rig.fake.tags.get(MEMORY), ['env=prod'])

  const clear = await rig.service.prepare({ action: 'set-tags', target: MEMORY, tags: [], tagMode: 'clear' })
  assert.equal(clear.ok, true)
  assert.equal(clear.tagMode, 'clear')
  const cleared = await rig.service.execute({ token: clear.token })
  assert.equal(cleared.ok, true)
  assert.deepEqual(rig.fake.tags.get(MEMORY), [])
})

test('a server that reports no auth mode makes the identity ambiguous and refuses writes', async () => {
  const rig = writeRig()
  rig.fake.healthAuthMode = null
  rig.capabilities.invalidate()
  const prepared = await rig.service.prepare({ action: 'delete-memory', target: MEMORY })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.error.code, 'identity-ambiguous')
  assert.equal(rig.fake.calls.some((call) => call[0] === 'snapshotCommit'), false)
})

test('every crossed token/verb pairing is refused before any write (review B1 matrix)', async () => {
  const WRITE_ACTIONS = ['edit-memory', 'delete-memory', 'set-tags', 'force-commit']
  const MUTATING_CALLS = new Set(['writeContent', 'deletePath', 'setTags', 'commitSession', 'snapshotRestore'])
  const setup = async (action) => {
    const rig = writeRig()
    rig.fake.tags.set(MEMORY, ['env=prod'])
    const request = {
      action,
      target: action === 'force-commit' ? 's1' : MEMORY,
      ...(action === 'force-commit' ? { sessionId: 's1' } : {}),
      ...(action === 'set-tags' ? { tags: ['env=staging'] } : {}),
    }
    const prepared = await rig.service.prepare(request)
    assert.equal(prepared.ok, true, `prepare ${action}`)
    return { rig, token: prepared.token }
  }
  for (const action of WRITE_ACTIONS) {
    for (const expectAction of WRITE_ACTIONS) {
      if (expectAction === action) continue
      const { rig, token } = await setup(action)
      const before = rig.fake.calls.length
      const crossed = await rig.service.execute({
        token,
        expectAction,
        ...(expectAction === 'edit-memory' ? { content: 'crossed' } : {}),
        ...(expectAction === 'delete-memory' ? { typed: 'tools.md' } : {}),
      })
      assert.equal(crossed.ok, false, `${action} token as ${expectAction}`)
      assert.equal(crossed.error.code, 'invalid-request', `${action} token as ${expectAction}`)
      const newCalls = rig.fake.calls.slice(before).filter((call) => MUTATING_CALLS.has(call[0]))
      assert.deepEqual(newCalls, [], `${action} token as ${expectAction} makes no mutation call`)
      assert.equal(rig.service.pendingAction(token), action, 'the token survives the mismatch')
      // ...and the right verb still works.
      const correct = await rig.service.execute({
        token,
        expectAction: action,
        ...(action === 'edit-memory' ? { content: 'correct' } : {}),
        ...(action === 'delete-memory' ? { typed: 'tools.md' } : {}),
      })
      assert.equal(correct.ok, true, `${action} token still executes correctly`)
      assert.equal(correct.action, action)
    }
  }
})

test('/viking undo explains an extra-changes plan, including same-named staleness (review N4)', async () => {
  const rig = writeRig()
  const command = commandFor(rig)
  const prepared = await command.run('forget viking://user/default/memories/preferences/tools.md', 's1')
  const token = envelopeOf(prepared).prepare.token
  const confirmed = await command.run(`forget --confirm ${token}`, 's1')
  const undoId = /Undo handle: ([0-9a-f]{32})/.exec(confirmed.text)?.[1]
  assert.ok(undoId)
  // Recreate the same-named file after the delete: undo is stale and needs the dialog.
  rig.fake.files.set(MEMORY, { content: 'recreated elsewhere', modTime: null })
  const undone = await command.run(`undo ${undoId}`, 's1')
  assert.equal(undone.kind, 'error')
  assert.match(undone.text, /rewritten after the action/)
  assert.match(undone.text, /undo dialog/)
  assert.equal(rig.fake.appliedRestores.length, 0, 'the command path does not apply an extra-changes plan')
})
