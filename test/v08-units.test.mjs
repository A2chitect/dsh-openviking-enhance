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
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
import { PackDownloadBroker } from '../src/host/pack-service.ts'
import { SnapshotService } from '../src/host/snapshot-service.ts'

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

  // B1: an ancestor of the pipeline-owned sessions tree is refused for every
  // mutating kind, not just the sessions directory itself.
  assert.equal(classifySnapshotScope('viking://user/alice', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/alice', 'commit', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/alice/sessions', 'restore', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/alice/sessions/dsh-1', 'commit', user).ok, false)
  // S2: pack requires the active user's own tree; bare viking://user and another
  // identity are refused.
  assert.equal(classifySnapshotScope('viking://user', 'pack', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/bob/resources/x', 'pack', user).ok, false)
  assert.equal(classifySnapshotScope('viking://user/alice/memories', 'pack', user).ok, true)
  assert.equal(classifySnapshotScope('viking://resources/x', 'pack', user).ok, true)
  const pack = classifySnapshotScope('viking://user/alice/sessions/dsh-1', 'pack', user)
  assert.equal(pack.ok, true, 'sessions inside the active user are technically exportable (documented: full session text)')
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

function healthyProbe() {
  return {
    observedAt: Date.now(),
    health: { ok: true, version: '0.5.3', authMode: 'dev', role: 'user', accountId: 'default', userId: 'default', latencyMs: 1, error: null },
    snapshot: { available: true, detail: null, kind: 'history' },
    tasks: { available: true, detail: null },
    rules: { available: true, detail: null, kind: 'supported' },
    compile: { available: true, detail: null, configured: true, canCreate: true, reason: null, kind: 'capabilities' },
    versions: { available: true, detail: null },
    diffPaths: { available: true, detail: null },
  }
}

function opsRig(overrides = {}) {
  const dir = tempDir('ops')
  const audit = new AuditLog({ dir })
  const flags = { ops: overrides.opsEnabled ?? true, transport: overrides.transport ?? true }
  const gate = overrides.gate ?? new MutationGate()
  const calls = []
  const capability = {
    probe: async () => (overrides.probe === undefined ? healthyProbe() : overrides.probe()),
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
      dryRunRestore: async (projectDir, sourceCommit) => ({ ok: true, head: 'head-1', toWrite: [], toDelete: [], unchanged: 0, projectDir, sourceCommit }),
      applyRestore: async () => ({ ok: true, newCommit: 'commit-2', parentCommit: 'commit-1', written: 0, deleted: 0, unchanged: 0, writtenPaths: [], deletedPaths: [], taskId: null, requestId: 'req-2' }),
      versions: async () => ({ available: false, note: 'not-compile-managed' }),
      restoreFileVersion: async () => ({ ok: true, versionId: 'ver-3', versionNumber: 3, requestId: null, noop: false }),
      ...(overrides.snapshot ?? {}),
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
    gate,
    activeUser: overrides.activeUser ?? (() => 'default'),
    now: overrides.now ?? (() => 1000),
  })
  return { service, audit, dir, calls, flags, scope, gate }
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

/* ========================================================================
 * PR #6 review round 1 — plan counts, undo normalization, pack deadlines,
 * execute gate re-check, verify retry, evidence deadline
 * ===================================================================== */

test('S3: the restore plan carries the real counts even when the rows are capped', async () => {
  const writes = Array.from({ length: 60 }, (_, index) => ({ path: `out/f${index}.md`, oid: null }))
  const deletes = Array.from({ length: 55 }, (_, index) => ({ path: `out/old${index}.md`, oid: null }))
  const rig = opsRig({
    snapshot: {
      dryRunRestore: async () => ({ ok: true, head: 'head-1', toWrite: writes, toDelete: deletes, unchanged: 3 }),
    },
  })
  const prepared = await rig.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://resources/out', sourceCommit: 'c1' })
  assert.equal(prepared.ok, true)
  const plan = prepared.plan
  assert.equal(plan.writeTotal, 60, 'the dialog can state the real write count')
  assert.equal(plan.deleteTotal, 55, 'the dialog can state the real delete count')
  assert.equal(plan.toWrite.length, 50, 'the write rows stay clamped')
  assert.equal(plan.toDelete.length, 50, 'the delete rows stay clamped')
  assert.equal(plan.truncated, true)
  const restoreSummary = prepared.summary.find((line) => line.includes('will be written'))
  assert.match(restoreSummary, /60 file\(s\) will be written, 55 deleted/)
})

test('S4: execute re-runs the action capability gate after the identity check', async () => {
  let probes = 0
  const rig = opsRig({
    probe: () => {
      probes += 1
      const snapshot = healthyProbe()
      if (probes > 2) {
        snapshot.snapshot = { available: false, detail: 'snapshot-unavailable', kind: 'route-absent' }
      }
      return snapshot
    },
  })
  const prepared = await rig.service.prepare({ action: 'snapshot-create', message: 'x', paths: ['viking://resources/x'] })
  assert.equal(prepared.ok, true)
  const refused = await rig.service.execute({ token: prepared.token })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'snapshot-unavailable', 'the capability is re-checked at execute')
  assert.equal(rig.calls.length, 0, 'no mutation ran')
})

test('S6: verifyCommit retries a lagging log a bounded number of times and passes the branch', async () => {
  const branches = []
  let calls = 0
  const responses = [[{ oid: 'c-old' }], [{ oid: 'c-old' }], [{ oid: 'c-new' }]]
  const api = {
    snapshotLog: async (options) => {
      branches.push(options.branch)
      const result = responses[Math.min(calls, 2)]
      calls += 1
      return { ok: true, status: 200, result, error: null, errorCode: null }
    },
  }
  const service = new SnapshotService({ api, user: () => 'default' })
  assert.equal(await service.verifyCommit('c-new', 'release'), true)
  assert.equal(calls, 3)
  assert.deepEqual(branches, ['release', 'release', 'release'])

  const staleApi = { snapshotLog: async () => ({ ok: true, status: 200, result: [{ oid: 'c-old' }], error: null, errorCode: null }) }
  const stale = new SnapshotService({ api: staleApi, user: () => 'default' })
  assert.equal(await stale.verifyCommit('c-new', 'main'), false, 'the retry budget is bounded')
})

test('S5: undo expected paths compare normalized full URIs, not basenames', async () => {
  // Prepare + execute use two dry runs; the undo plan is the third.
  let dryCalls = 0
  const rig = opsRig({
    snapshot: {
      dryRunRestore: async () => {
        dryCalls += 1
        if (dryCalls <= 2) return { ok: true, head: 'head-1', toWrite: [{ path: 'report.md', oid: null }], toDelete: [], unchanged: 0 }
        // Same basename, DIFFERENT directory: a basename comparison would call
        // this the action's own inverse; the normalized URI must not.
        return { ok: true, head: 'head-1', toWrite: [{ path: 'other/report.md', oid: null }], toDelete: [], unchanged: 0 }
      },
    },
  })
  const prepared = await rig.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://resources/out', sourceCommit: 'c1' })
  const executed = await rig.service.execute({ token: prepared.token, typed: 'out' })
  assert.equal(executed.ok, true)
  const plan = await rig.service.plan({ undoId: executed.undoId })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.extraChanges, true, 'other/report.md is outside the action inverse set, not "report.md"')
  const refused = await rig.service.undo({ undoId: executed.undoId })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'extra-changes')
  const applied = await rig.service.undo({ undoId: executed.undoId, confirmExtra: true })
  assert.equal(applied.ok, true)
})

test('undo stays available when enableOps is switched off after the action; identity switch still refuses', async () => {
  const preparedRig = () =>
    opsRig({
      snapshot: {
        dryRunRestore: async () => ({ ok: true, head: 'head-1', toWrite: [{ path: 'report.md', oid: null }], toDelete: [], unchanged: 0 }),
        applyRestore: async () => ({
          ok: true,
          newCommit: 'commit-2',
          parentCommit: 'commit-1',
          written: 1,
          deleted: 0,
          unchanged: 0,
          writtenPaths: ['report.md'],
          deletedPaths: [],
          taskId: null,
          requestId: 'req-2',
        }),
      },
    })
  const rig = preparedRig()
  const prepared = await rig.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://resources/out', sourceCommit: 'c1' })
  const executed = await rig.service.execute({ token: prepared.token, typed: 'out' })
  assert.equal(executed.ok, true)
  assert.equal(typeof executed.undoId, 'string')
  rig.flags.ops = false
  const undone = await rig.service.undo({ undoId: executed.undoId })
  assert.equal(undone.ok, true, 'turning the switch off must not trap the user')

  const rig2 = preparedRig()
  const prepared2 = await rig2.service.prepare({ action: 'snapshot-restore', projectDir: 'viking://resources/out', sourceCommit: 'c1' })
  const executed2 = await rig2.service.execute({ token: prepared2.token, typed: 'out' })
  assert.equal(executed2.ok, true)
  rig2.scope.fingerprint = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  const afterSwitch = await rig2.service.undo({ undoId: executed2.undoId })
  assert.equal(afterSwitch.ok, false)
  assert.equal(afterSwitch.error.code, 'identity-changed')
})

test('an identity switch between prepare and execute is refused at execute', async () => {
  const rig = opsRig()
  const prepared = await rig.service.prepare({ action: 'snapshot-create', message: 'x', paths: ['viking://resources/x'] })
  assert.equal(prepared.ok, true)
  rig.scope.fingerprint = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const refused = await rig.service.execute({ token: prepared.token })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'identity-changed')
})

/* ---- pack broker: deadlines, caps, signature, expiry, identity, eviction -- */

function packBrokerRig({ bodyFactory, maxBytes = 1024, inactivityMs = 60, totalMs = 500 } = {}) {
  const dir = tempDir('pack-b')
  const audit = new AuditLog({ dir })
  const clock = { now: 1000 }
  const identity = { current: { ...IDENTITY } }
  const api = {
    streamPackExport: async () => ({
      ok: true,
      status: 200,
      response: new Response(bodyFactory()),
      error: null,
      errorCode: null,
      requestId: 'req-pack',
    }),
  }
  const broker = new PackDownloadBroker({
    api,
    audit,
    identity: () => identity.current,
    dir,
    maxBytes,
    inactivityMs,
    totalMs,
    now: () => clock.now,
  })
  return { broker, audit, dir, clock, identity, downloadsDir: join(dir, 'downloads') }
}

const zipBody = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      controller.enqueue(new TextEncoder().encode('zip payload'))
      controller.close()
    },
  })

const stalledBody = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      // Never closed and never sends another chunk: a stalled server body.
    },
  })

test('S1: a stalled pack body is aborted by the inactivity deadline and leaves no file', async () => {
  const rig = packBrokerRig({ bodyFactory: stalledBody, inactivityMs: 30 })
  const startedAt = Date.now()
  const outcome = await rig.broker.export('viking://resources/x', false)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'pack-failed')
  assert.match(outcome.message, /stalled/i)
  assert.ok(Date.now() - startedAt < 2_000, 'the refusal did not wait for a transport timeout')
  assert.equal(readdirSync(rig.downloadsDir).length, 0, 'the partial temp file is deleted')
})

test('a pack body over the host cap is refused as pack-too-large and cleaned up', async () => {
  const rig = packBrokerRig({
    maxBytes: 16,
    bodyFactory: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
          controller.enqueue(new Uint8Array(100))
          controller.close()
        },
      }),
  })
  const outcome = await rig.broker.export('viking://resources/x', false)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'pack-too-large')
  assert.equal(readdirSync(rig.downloadsDir).length, 0)
})

test('a non-zip body is refused before it is trusted', async () => {
  const rig = packBrokerRig({
    bodyFactory: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]))
          controller.close()
        },
      }),
  })
  const outcome = await rig.broker.export('viking://resources/x', false)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'pack-failed')
  assert.equal(readdirSync(rig.downloadsDir).length, 0)
})

test('download tokens are single-use, expire, are identity-bound and evict at the active cap', async () => {
  const single = packBrokerRig({ bodyFactory: zipBody })
  const first = await single.broker.export('viking://resources/x', false)
  assert.equal(first.ok, true)
  assert.equal(single.broker.consume(first.downloadId) === null, false)
  assert.equal(single.broker.consume(first.downloadId), null, 'single use')

  const expiring = packBrokerRig({ bodyFactory: zipBody })
  const exported = await expiring.broker.export('viking://resources/x', false)
  assert.equal(exported.ok, true)
  expiring.clock.now += 120_000 + 1
  assert.equal(expiring.broker.consume(exported.downloadId), null, 'expired token')

  const bound = packBrokerRig({ bodyFactory: zipBody })
  const boundExport = await bound.broker.export('viking://resources/x', false)
  assert.equal(boundExport.ok, true)
  bound.identity.current = { ...bound.identity.current, fingerprint: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }
  assert.equal(bound.broker.consume(boundExport.downloadId), null, 'identity-bound token')

  const evicting = packBrokerRig({ bodyFactory: zipBody })
  const a = await evicting.broker.export('viking://resources/a', false)
  const b = await evicting.broker.export('viking://resources/b', false)
  const c = await evicting.broker.export('viking://resources/c', false)
  assert.equal(a.ok && b.ok && c.ok, true)
  assert.equal(c.evicted, true, 'the export reports the eviction instead of dropping it silently')
  assert.equal(evicting.broker.consume(a.downloadId), null, 'the oldest token was evicted')
  assert.equal(evicting.broker.consume(b.downloadId) === null, false)
})

/* ---- evidence: one overall deadline for the request-log fan-out ---------- */

test('the task-evidence server-request fan-out stops at its overall deadline', async () => {
  const clock = { now: 0 }
  const { EvidenceService } = await import('../src/host/evidence-service.ts')
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: `aud-${index}`,
    ts: new Date().toISOString(),
    kind: 'compile',
    action: 'compile-run',
    target: 'viking://resources/x',
    identity: null,
    fingerprint: null,
    confirmation: 'overlay',
    preCommit: null,
    postCommit: null,
    requestId: `req-${index}`,
    result: 'ok',
    error: null,
    undo: null,
    taskId: 'task-1',
  }))
  const service = new EvidenceService({
    api: {
      consoleAudit: async (options) => {
        clock.now += 20_000
        return { ok: true, status: 200, result: { items: [{ request_id: options.requestId, method: 'POST', route: '/api/v1/compile' }] }, error: null, errorCode: null }
      },
    },
    audit: { recent: () => ({ entries, path: '', unavailable: false, warnings: [], observedAt: new Date().toISOString() }) },
    activity: { exportTask: async () => ({ ok: true, task: { task_id: 'task-1', task_type: 'compile' }, fileName: 'x.json' }) },
    identity: () => IDENTITY,
    build: () => ({ pluginVersion: '0.8.0', dshVersion: '0.2.2-rc.1', node: 'v22', platform: 'darwin' }),
    now: () => clock.now,
  })
  const evidence = await service.evidence('task-1')
  assert.equal(evidence.ok, true)
  assert.equal(evidence.evidence.correlation.serverRequests.length, 1, 'only the first lookup ran before the deadline')
  assert.equal(evidence.evidence.correlation.warnings.includes('server-request-log-deadline'), true)
})
