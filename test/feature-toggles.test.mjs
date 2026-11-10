// The interface switches' own contract, as tests.
//
// `feature-toggles.ts` is what decides whether a surface is drawn, so the two
// rules that keep it safe get pinned here without rendering anything:
//
//  - only a literal `false` hides a surface; a missing field, a malformed value,
//    an absent service or a not-yet-ready snapshot all mean "on", because hiding
//    the plugin's UI is the exceptional state and it hides the way back —
//  - the watcher speaks once per distinct answer: it emits immediately when a
//    ready snapshot is already held, never from a pending one, and not again for
//    an unchanged value.
//
// v0.4 adds `showPreview` / `showExplore` (client-mounted tabs) and
// `enableCommands` (host-side command registration, carried here so the switch
// table and the settings form share one source of truth).
//
// The live mount/unmount order those answers cause is checked against the built
// bundle in `scripts/smoke-client.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_CONFIG_FIELDS,
  FEATURE_ORDER,
  featureFlagsFrom,
  sameFeatureFlags,
  watchFeatureFlags,
} from '../src/client/feature-toggles.ts'

const ALL_ON = {
  sidebarEntry: true,
  commitStatus: true,
  recallPanel: true,
  recallExplain: true,
  healthPanel: true,
  previewPanel: true,
  explorePanel: true,
  commands: true,
  activityPanel: true,
  scopeBanner: true,
  // Writes are the one v0.5 switch whose absence means OFF (opt-in).
  writes: false,
}
const ALL_OFF = {
  sidebarEntry: false,
  commitStatus: false,
  recallPanel: false,
  recallExplain: false,
  healthPanel: false,
  previewPanel: false,
  explorePanel: false,
  commands: false,
  activityPanel: false,
  scopeBanner: false,
  writes: false,
}

/** The same states as the settings form carries them: Config field names. */
const FORM_ALL_ON = {
  showSidebarEntry: true,
  showCommitStatus: true,
  showRecallPanel: true,
  showRecallExplain: true,
  showHealthPanel: true,
  showPreview: true,
  showExplore: true,
  enableCommands: true,
  enableActivity: true,
  showScopeBanner: true,
  enableWrites: true,
}
const FORM_ALL_OFF = {
  showSidebarEntry: false,
  showCommitStatus: false,
  showRecallPanel: false,
  showRecallExplain: false,
  showHealthPanel: false,
  showPreview: false,
  showExplore: false,
  enableCommands: false,
  enableActivity: false,
  showScopeBanner: false,
  enableWrites: false,
}

test('the defaults are all on except the opt-in writes switch', () => {
  assert.deepEqual(DEFAULT_FEATURE_FLAGS, ALL_ON)
})

test('each surface names the Config field that carries it', () => {
  // The settings form renders the same table; a renamed Config field must fail
  // here instead of silently making a switch dead.
  assert.deepEqual(FEATURE_CONFIG_FIELDS, {
    sidebarEntry: 'showSidebarEntry',
    commitStatus: 'showCommitStatus',
    recallPanel: 'showRecallPanel',
    recallExplain: 'showRecallExplain',
    healthPanel: 'showHealthPanel',
    previewPanel: 'showPreview',
    explorePanel: 'showExplore',
    commands: 'enableCommands',
    activityPanel: 'enableActivity',
    scopeBanner: 'showScopeBanner',
    writes: 'enableWrites',
  })
  // Mount order: the two v0.4 tabs follow the v0.3 surfaces. `commands` is the
  // host-owned switch and deliberately has no browser mount, so it is absent.
  assert.deepEqual([...FEATURE_ORDER], [
    'sidebarEntry',
    'commitStatus',
    'recallPanel',
    'recallExplain',
    'healthPanel',
    'previewPanel',
    'explorePanel',
    'activityPanel',
    'scopeBanner',
  ])
  assert.equal(FEATURE_ORDER.includes('commands'), false, 'the command switch has no client mount')
  assert.equal(FEATURE_ORDER.includes('writes'), false, 'writes gate buttons, not a mount')
})

test('only a literal boolean false hides a surface', () => {
  assert.deepEqual(
    featureFlagsFrom({
      showSidebarEntry: false,
      showCommitStatus: true,
      showRecallPanel: false,
      showRecallExplain: false,
      showHealthPanel: false,
      showPreview: false,
      showExplore: false,
      enableCommands: false,
    }),
    {
      sidebarEntry: false,
      commitStatus: true,
      recallPanel: false,
      recallExplain: false,
      healthPanel: false,
      previewPanel: false,
      explorePanel: false,
      commands: false,
      activityPanel: true,
      scopeBanner: true,
      writes: false,
    },
  )
  // Truthy values are not `false`: a stale string, 0, null or an object must all
  // keep the surface visible rather than hide it.
  const malformed = featureFlagsFrom({
    showSidebarEntry: 'false',
    showCommitStatus: 0,
    showRecallPanel: null,
    showRecallExplain: 'no',
    showHealthPanel: {},
    showPreview: 'off',
    showExplore: 0,
    enableCommands: null,
    enableActivity: 'off',
    showScopeBanner: 0,
    enableWrites: 'true',
  })
  // `writes` is opt-in: only a literal `true` enables it, everything else off.
  assert.deepEqual(malformed, ALL_ON)
  assert.deepEqual(featureFlagsFrom({ enableWrites: true }), { ...ALL_ON, writes: true })
})

test('a missing value, missing fields or a malformed container mean on', () => {
  for (const value of [undefined, null, {}, { endpoint: 'http://127.0.0.1:1933' }]) {
    assert.deepEqual(featureFlagsFrom(value), ALL_ON)
  }
  // A partially saved document only switches the fields it carries.
  assert.deepEqual(featureFlagsFrom({ showRecallPanel: false }), {
    sidebarEntry: true,
    commitStatus: true,
    recallPanel: false,
    recallExplain: true,
    healthPanel: true,
    previewPanel: true,
    explorePanel: true,
    commands: true,
    activityPanel: true,
    scopeBanner: true,
    writes: false,
  })
})

test('reading the flags never mutates the settings value', () => {
  const value = { showSidebarEntry: false, showCommitStatus: true }
  const before = JSON.stringify(value)
  const flags = featureFlagsFrom(value)
  assert.deepEqual(flags, { ...ALL_ON, sidebarEntry: false })
  assert.equal(JSON.stringify(value), before, 'the form\'s value is read, not written')
})

test('sameFeatureFlags compares surface by surface', () => {
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON }), true)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, recallPanel: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, recallExplain: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, healthPanel: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, previewPanel: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, explorePanel: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, commands: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, activityPanel: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, scopeBanner: false }), false)
  assert.equal(sameFeatureFlags(ALL_ON, { ...ALL_ON, writes: true }), false)
  assert.equal(sameFeatureFlags(ALL_OFF, ALL_OFF), true)
})

/** A fake settings service: one snapshot, replaced by the returned controller. */
function fakeShell({ status = 'ready', value = {} } = {}) {
  const state = {
    snapshot: status === 'ready' ? { status, value } : { status },
    listeners: new Set(),
    entryIds: [],
  }
  const form = {
    getSnapshot: () => state.snapshot,
    subscribe(listener) {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
  }
  const context = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['configForms'], 'the watcher waits on the settings service alone')
      const scope = {
        get(name) {
          if (name !== 'configForms') return undefined
          return {
            get(entryId) {
              state.entryIds.push(entryId)
              return form
            },
          }
        },
      }
      const teardown = callback(scope)
      return {
        dispose() {
          if (typeof teardown === 'function') teardown()
        },
      }
    },
    logger: { warn: () => {}, info: () => {} },
  }
  const controller = {
    setSnapshot(next) {
      state.snapshot = next
      for (const listener of [...state.listeners]) listener()
    },
    notify() {
      for (const listener of [...state.listeners]) listener()
    },
  }
  return { state, context, controller }
}

test('the watcher emits immediately from a ready snapshot and then on changes', () => {
  const shell = fakeShell({
    status: 'ready',
    value: {
      showSidebarEntry: false,
      showCommitStatus: true,
      showRecallPanel: true,
      showRecallExplain: true,
      showHealthPanel: true,
      showPreview: true,
      showExplore: true,
      enableCommands: true,
      enableActivity: true,
      showScopeBanner: true,
      enableWrites: true,
    },
  })
  const calls = []
  const dispose = watchFeatureFlags(shell.context, 'openviking-enhance', (flags) => calls.push(flags))

  assert.equal(shell.state.entryIds.length, 1, 'the form is read once at subscribe')
  assert.equal(shell.state.entryIds[0], 'openviking-enhance', 'under the namespace it was given')
  assert.deepEqual(calls, [{ ...ALL_ON, sidebarEntry: false, writes: true }])

  shell.controller.setSnapshot({
    status: 'ready',
    value: { ...FORM_ALL_ON, showCommitStatus: false },
  })
  assert.deepEqual(calls.at(-1), { ...ALL_ON, commitStatus: false, writes: true })
  assert.equal(calls.length, 2)

  dispose()
  shell.controller.setSnapshot({ status: 'ready', value: { ...FORM_ALL_OFF } })
  assert.equal(calls.length, 2, 'a disposed watcher stops speaking')
})

test('a not-ready snapshot is not an answer, and unchanged flags are not re-emitted', () => {
  const shell = fakeShell({ status: 'loading' })
  const calls = []
  const dispose = watchFeatureFlags(shell.context, 'openviking-enhance', (flags) => calls.push(flags))
  assert.deepEqual(calls, [], 'nothing is emitted before the form is ready')

  // The caller mounts the defaults in the meantime; a ready answer with all on is
  // still an answer (the caller dedupes its own mounts), but a repeated one is not.
  shell.controller.setSnapshot({ status: 'ready', value: { ...FORM_ALL_ON } })
  assert.equal(calls.length, 1)
  shell.controller.notify()
  assert.equal(calls.length, 1, 'the same snapshot is not re-emitted')
  shell.controller.setSnapshot({ status: 'unavailable' })
  assert.equal(calls.length, 1, 'a snapshot that stopped being ready is not an answer')
  shell.controller.setSnapshot({ status: 'ready', value: { ...FORM_ALL_ON } })
  assert.equal(calls.length, 1, 'the same ready value arriving again is not re-emitted')
  // A v0.4-only switch change is still a distinct answer.
  shell.controller.setSnapshot({ status: 'ready', value: { ...FORM_ALL_ON, showPreview: false } })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.at(-1), { ...ALL_ON, previewPanel: false, writes: true })

  shell.controller.setSnapshot({ status: 'ready', value: { ...FORM_ALL_OFF } })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.at(-1), ALL_OFF)
  dispose()
})
