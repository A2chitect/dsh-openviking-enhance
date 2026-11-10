// Unit tests for the v0.8 "Operate" building blocks.
//
// These exercise the modules the route tests cannot reach cheaply: the extracted
// confirmation store (shared by the v0.5 writes and the v0.8 ops), the scope
// allowlists that keep a directory restore inside safe subtrees, the pack
// download broker's filename/signature rules, the observability normaliser and
// the OpsService gates themselves. A temp `DSH_HOME` keeps every audit file out
// of the real state directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ConfirmationStore,
  MutationGate,
  SlidingWindowRate,
  mintToken,
} from '../src/host/confirmation-store.ts'
import {
  classifyPreviewContent,
  classifySnapshotPaths,
  classifySnapshotScope,
  leafName,
  snapshotFailureNote,
} from '../src/host/snapshot-service.ts'
import { fileNameFromDisposition, sanitizePackFileName } from '../src/host/pack-service.ts'
import { seriesFromConsole } from '../src/host/observability-service.ts'
import { OpsService } from '../src/host/ops-service.ts'
import { AuditLog } from '../src/host/audit.ts'

const tempDir = (label) => mkdtempSync(join(tmpdir(), `ove-v08-unit-${label}-`))

const IDENTITY = {
  profileId: null,
  profileLabel: null,
  endpoint: 'http://127.0.0.1:1933',
  authMode: 'dev',
  account: 'default',
  user: 'default',
  peer: null,
  fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
}

/* ========================================================================
 * confirmation-store: the shared token/rate/gate machinery
 * ===================================================================== */

test('the mutation gate is a single shared in-flight lock', () => {
  const gate = new MutationGate()
  assert.equal(gate.busy, false)
  assert.equal(gate.enter('write'), true)
  assert.equal(gate.busy, true)
  assert.equal(gate.currentOwner, 'write')
  assert.equal(gate.enter('ops'), false, 'only one mutation may be in flight')
  gate.leave()
  assert.equal(gate.busy, false)
  assert.equal(gate.enter('ops'), true, 'the path is reusable after release')
  gate.leave()
})

test('the sliding-window quota only spends real events and rolls over', () => {
  const clock = { now: 1000 }
  const rate = new SlidingWindowRate(2, 60_000, () => clock.now)
  assert.equal(rate.check().ok, true)
  rate.record()
  assert.equal(rate.check().ok, true)
  rate.record()
  const blocked = rate.check()
  assert.equal(blocked.ok, false)
  assert.equal(blocked.limit, 2)
  assert.equal(blocked.retryAfterMs, 60_000)
  clock.now += 60_001
  assert.equal(rate.check().ok, true, 'the window rolls over')
})

test('the confirmation store bounds pending tokens, purges expired ones and retains settled ones', () => {
  const clock = { now: 1000 }
  const store = new ConfirmationStore({ maxPending: 2, settledRetentionMs: 120_500, now: () => clock.now })
  const record = (token, status = 'pending') => ({
    token,
    status,
    createdAt: clock.now,
    expiresAt: clock.now + 120_000,
    settledAt: status === 'pending' ? null : clock.now,
  })
  store.set(record('a'))
  assert.equal(store.pending().length, 1)
  store.set(record('b'))
  assert.equal(store.atPendingCap(), true)
  store.set(record('c', 'done'))
  assert.equal(store.hasExecuting(), false)
  assert.equal(store.atPendingCap(), true, 'only pending records count against the cap')
  // Expired pending tokens are purged immediately; a settled record is kept
  // only for its (short) retention window so a double cancel stays idempotent.
  clock.now += 600
  store.purge()
  assert.equal(store.size, 3, 'nothing has expired yet')
  clock.now += 119_500
  store.purge()
  assert.equal(store.size, 1, 'the two pending records expired; the settled one is still retained')
  clock.now += 600
  store.purge()
  assert.equal(store.size, 0)
  assert.match(mintToken(), /^[0-9a-f]{64}$/)
})

/* ========================================================================
 * snapshot scope allowlists (restore/create safety)
 * ===================================================================== */

test('snapshot restore/create scopes allow directories and refuse sessions, system and peers', () => {
  const user = 'alice'
  assert.equal(classifySnapshotScope('viking://user/alice/memories/entities/x', 'restore', user).ok, true)
  assert.equal(classifySnapshotScope('viking://resources/project', 'restore', user).ok, true)
  assert.equal(classifySnapshotScope('viking://agent/skills/reviewer', 'restore', user).ok, true)
  assert.equal(classifySnapshotScope('viking://', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/alice/sessions/dsh-1', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/bob/memories', 'restore', user).ok, false, 'another user scope is refused')
  assert.equal(classifySnapshotScope('viking://user/alice/resources/_system/x', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://agent/other', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('https://example.com/x', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://resources/../secret', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://resources/a?x=1', 'restore', user).ok, false)

  const commit = classifySnapshotScope('viking://agent/anything', 'commit', user)
  assert.equal(commit.ok, true, 'agent scope is readable/committable')

  const pack = classifySnapshotScope('viking://user/alice/sessions/dsh-1', 'pack', user)
  assert.equal(pack.ok, true, 'sessions inside user are technically exportable')
  assert.equal(classifySnapshotScope('viking://agent/skills', 'pack', user).ok, false)
})

test('path lists are bounded and normalized; the typed word is the leaf name', () => {
  const user = 'alice'
  const ok = classifySnapshotPaths(['viking://resources/a/', 'viking://resources/a'], 'commit', user)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.paths, ['viking://resources/a'], 'duplicates are dropped and trailing slashes stripped')
  assert.equal(classifySnapshotPaths([], 'commit', user).ok, false)
  assert.equal(classifySnapshotPaths(Array(17).fill('viking://resources/x'), 'commit', user).ok, false)
  assert.equal(classifySnapshotPaths(['viking://user/bob/memories'], 'commit', user).ok, false)
  assert.equal(leafName('viking://user/alice/resources/out/'), 'out')
  assert.equal(classifyPreviewContent(new Uint8Array([0, 1, 2])), 'binary')
  assert.equal(classifyPreviewContent(new TextEncoder().encode('hello')), 'text')
})

test('snapshot failure notes classify a fresh account vs an absent route', () => {
  assert.deepEqual(snapshotFailureNote(404, 'NOT_FOUND', { type: 'git_ref' }), { note: 'no-snapshot-history', unavailable: false })
  assert.deepEqual(snapshotFailureNote(404, 'NOT_FOUND', { type: 'git_blob' }), { note: 'blob-not-found', unavailable: false })
  assert.deepEqual(snapshotFailureNote(404, 'NOT_FOUND', null), { note: 'snapshot-unavailable', unavailable: true })
  assert.deepEqual(snapshotFailureNote(403, 'FORBIDDEN', null), { note: 'forbidden', unavailable: false })
  assert.equal(snapshotFailureNote(400, 'FAILED_PRECONDITION', { code: 'NOT_COMPILE_MANAGED' }).note, 'not-compile-managed')
})

/* ========================================================================
 * pack filenames + observability normalisation
 * ===================================================================== */

test('pack file names are sanitized and never escape the download directory', () => {
  assert.equal(sanitizePackFileName('"../../etc/passwd.ovpack"', 'viking://resources/x'), 'passwd.ovpack')
  assert.equal(sanitizePackFileName(null, 'viking://resources/my pack'), 'my pack.ovpack')
  assert.equal(sanitizePackFileName('report', 'viking://resources/x'), 'report.ovpack')
  assert.equal(sanitizePackFileName('a/b/../../x.ovpack', 'viking://resources/x'), 'x.ovpack')
  assert.equal(fileNameFromDisposition('attachment; filename="out.ovpack"'), 'out.ovpack')
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve.ovpack"), 'naïve.ovpack')
  assert.equal(fileNameFromDisposition(null), null)
})

test('the console series normaliser degrades instead of throwing', () => {
  const disabled = seriesFromConsole({ enabled: false, message: 'disabled' })
  assert.equal(disabled.available, false)
  assert.equal(disabled.note, 'console-disabled')
  const buckets = seriesFromConsole({ buckets: [{ bucket: '2026-11-09', total: 5, other: 2 }] })
  assert.equal(buckets.available, true)
  assert.deepEqual(buckets.columns, ['bucket', 'total', 'other'])
  assert.deepEqual(buckets.rows, [['2026-11-09', '5', '2']])
  const empty = seriesFromConsole({})
  assert.equal(empty.available, false)
  const flat = seriesFromConsole({ count: 3 })
  assert.equal(flat.available, true)
  assert.deepEqual(flat.rows, [['3']])
})

/* ========================================================================
 * OpsService gates: fail closed before any mutation
 * ===================================================================== */

function opsRig(overrides = {}) {
  const dir = tempDir('ops')
  const audit = new AuditLog({ dir })
  const flags = { ops: overrides.opsEnabled ?? true, transport: overrides.transport ?? true }
  const calls = []
  const capability = {
    probe: async () => ({
      observedAt: Date.now(),
      health: { ok: true, version: '0.5.3', authMode: 'dev', role: 'user', accountId: 'default', userId: 'default', latencyMs: 1, error: null },
      snapshot: { available: true, detail: null, kind: 'history' },
      tasks: { available: true, detail: null },
      rules: { available: true, detail: null, kind: 'supported' },
      compile: { available: true, detail: null, configured: true, canCreate: true, reason: null, kind: 'capabilities' },
      versions: { available: true, detail: null },
      diffPaths: { available: true, detail: null },
    }),
    pack: async () => ({ available: true, detail: null }),
    invalidate: () => {},
    lastSnapshot: () => null,
    rules: async () => ({ available: true, detail: null, kind: 'supported' }),
  }
  const services = {
    snapshot: {
      commitSnapshot: async (message, paths) => {
        calls.push(['commitSnapshot', message, paths])
        return { ok: true, commit: 'commit-1', requestId: 'req-1' }
      },
      verifyCommit: async () => true,
      dryRunRestore: async () => ({ ok: true, head: 'head-1', toWrite: [], toDelete: [], unchanged: 0 }),
      applyRestore: async () => ({ ok: true, newCommit: 'commit-2', parentCommit: 'commit-1', written: 0, deleted: 0, unchanged: 0, writtenPaths: [], deletedPaths: [], taskId: null, requestId: 'req-2' }),
      versions: async () => ({ available: false, note: 'not-compile-managed' }),
      restoreFileVersion: async () => ({ ok: true, versionId: 'ver-3', versionNumber: 3, requestId: null, noop: false }),
    },
    compile: {
      targetConfig: async () => ({ available: true, target: { to: 'viking://resources/out', from: ['viking://resources/in'], skill: 's', instruction: null, autoUpdate: null, updateSchedule: null, status: 'active', compileType: 'compile', conflicts: 0 }, note: null }),
      trigger: async () => ({ ok: true, taskId: 'task-1', status: 'pending', task: null, requestId: 'req-3' }),
    },
    packs: { export: async () => ({ ok: true, downloadId: 'a'.repeat(64), fileName: 'x.ovpack', bytes: 10, expiresAt: Date.now() + 1000, requestId: null }) },
  }
  const scope = { ...IDENTITY, ...(overrides.identity ?? {}) }
  const service = new OpsService({
    capabilities: capability,
    snapshot: services.snapshot,
    compile: services.compile,
    packs: services.packs,
    audit,
    identity: () => scope,
    opsEnabled: () => flags.ops,
    transport: () => flags.transport,
    gate: new MutationGate(),
    activeUser: () => 'default',
    now: () => 1000,
  })
  return { service, audit, dir, calls, flags, scope }
}

test('ops prepare fails closed before any mutation when a gate is off', async () => {
  const disabled = opsRig({ opsEnabled: false })
  const off = await disabled.service.prepare({ action: 'snapshot-create', message: 'x', paths: ['viking://resources/x'] })
  assert.equal(off.ok, false)
  assert.equal(off.error.code, 'ops-disabled')
  assert.deepEqual(disabled.calls, [], 'a disabled op touches nothing')
  assert.equal(disabled.audit.recent(5).entries[0].kind, 'denied')

  const noTransport = opsRig({ transport: false })
  const refused = await noTransport.service.prepare({ action: 'snapshot-create', message: 'x', paths: ['viking://resources/x'] })
  assert.equal(refused.error.code, 'transport-unavailable')
})

test('ops prepare/execute audits the action and refuses unsafe scopes', async () => {
  const rig = opsRig()
  const unsafe = await rig.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://user/default/sessions/x', sourceCommit: 'c1' })
  assert.equal(unsafe.ok, false)
  assert.equal(unsafe.error.code, 'restore-scope-refused')

  const prepared = await rig.service.prepare({ action: 'snapshot-create', message: 'unit', paths: ['viking://resources/x'] })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.plan.notUndoable, true)
  const executed = await rig.service.execute({ token: prepared.token })
  assert.equal(executed.ok, true)
  assert.equal(executed.verified, true)
  assert.equal(executed.undoId, null)
  const entries = rig.audit.recent(5).entries
  assert.equal(entries[0].kind, 'snapshot')
  assert.equal(entries[0].action, 'snapshot-create')
  assert.equal(statSync(rig.audit.path).mode & 0o777, 0o600)
  assert.equal(readFileSync(rig.audit.path, 'utf8').includes('unit'), false, 'messages are not audited')
  // A typed confirmation is required by the destructive actions.
  const restore = await rig.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://resources/out', sourceCommit: 'c1' })
  assert.equal(restore.ok, true)
  const noTyped = await rig.service.execute({ token: restore.token })
  assert.equal(noTyped.ok, false)
  assert.equal(noTyped.error.code, 'typed-confirmation-required')
})

test('every scope capability id has an EN and ZH label', async () => {
  const { readFile } = await import('node:fs/promises')
  const capability = await readFile(new URL('../src/host/capability.ts', import.meta.url), 'utf8')
  const block = capability.slice(capability.indexOf('export function scopeCapabilities'))
  const ids = [...block.matchAll(/^    '?([a-z][a-z-]+)'?:/gm)].map((m) => m[1])
  assert.ok(ids.length >= 12, `expected the full capability id set, got ${ids.length}`)
  const locale = await readFile(new URL('../src/client/locale.ts', import.meta.url), 'utf8')
  const count = (key) => locale.split(key).length - 1
  for (const id of ids) {
    const key = `'native.overview.capability.${id}'`
    assert.equal(count(key), 2, `${id} must have an EN and a ZH label (${key})`)
  }
})
