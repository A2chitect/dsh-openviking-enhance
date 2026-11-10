// v1.0 unified degraded-state and error copy.
//
// The design's "polished degraded paths" deliverable is a single wording pattern
// for every failure mode: server unreachable, older server missing a route,
// partial data, unsupported capability, disabled switches, identity/scope
// problems. The copy layer is that pattern's carrier — a host code renders its
// localized `notice.<code>` / `wcode.<code>` text, never the raw code — so this
// suite audits the code→copy coverage mechanically instead of spot-checking a
// few states.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import {
  DICTS,
  attachLocale,
  noticeText,
  t,
  writeErrorText,
} from '../src/client/locale.ts'

const hostDir = new URL('../src/host/', import.meta.url)

/** Every `code: '…'` the host services can put on the wire. */
function hostCodes() {
  const codes = new Set()
  for (const name of readdirSync(hostDir)) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(new URL(name, hostDir), 'utf8')
    for (const match of text.matchAll(/code:\s*'([a-zA-Z0-9_-]+)'/g)) codes.add(match[1])
  }
  return [...codes].sort()
}

test('every host code has localized notice copy in both languages', () => {
  const codes = hostCodes()
  assert.ok(codes.length > 30, `the scan found the host code vocabulary (${codes.length})`)
  const missing = []
  for (const code of codes) {
    for (const [locale, dict] of Object.entries(DICTS)) {
      if (!(`notice.${code}` in dict)) missing.push(`${locale}:notice.${code}`)
    }
  }
  assert.deepEqual(missing, [], `missing degraded-state copy: ${missing.join(', ')}`)
})

test('a rendered host warning never shows the raw code instead of its copy', () => {
  attachLocale({ getSnapshot: () => ({ active: 'en' }) })
  for (const code of hostCodes()) {
    const rendered = noticeText({ code })
    assert.notEqual(rendered, `notice.${code}`, `${code} has English copy`)
    assert.notEqual(rendered, code, `${code} is not rendered as the bare code`)
  }
  attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
  for (const code of hostCodes()) {
    assert.notEqual(noticeText({ code }), `notice.${code}`, `${code} has Chinese copy`)
  }
  attachLocale(undefined)
})

test('write/ops error envelopes use localized copy when a code is known', () => {
  attachLocale({ getSnapshot: () => ({ active: 'en' }) })
  const known = [
    'invalid-scope',
    'scope-switch-blocked',
    'profile-missing',
    'identity-not-switchable',
    'pack-too-large',
    'rejected-by-server',
    'too-many-profiles',
    'method-not-allowed',
  ]
  for (const code of known) {
    const text = writeErrorText({ code, message: 'raw english server message' })
    assert.notEqual(text, 'raw english server message', `${code} has localized copy`)
    assert.notEqual(text, `wcode.${code}`, `${code} does not render its key`)
  }
  // Unknown codes keep the host's honest message (documented fallback order).
  assert.equal(writeErrorText({ code: 'some-new-code', message: 'Server said no.' }), 'Server said no.')
  attachLocale(undefined)
})

test('the degraded-state copy covers the documented failure matrix', () => {
  // One representative key per failure mode in the design's matrix; presence in
  // both dictionaries is the contract that every surface can name its state.
  const matrix = [
    'notice.unreachable', // server down
    'notice.sessionFailed', // server answered, session read failed
    'error.unsupported', // older server missing a route
    'notice.ruleListTruncated', // partial data (deadline)
    'notice.contextUnavailable', // capability degradation (legacy context face)
    'notice.pendingQueueUnavailable', // local state problem
    'notice.profileNotFound', // identity/profile problem
    'notice.scopeStateProfileMissing', // persisted scope problem
    'notice.officialPluginMismatch', // official-plugin/scope mismatch
    'notice.peerScopeDowngraded', // widened peer scope
    'write.actionsDisabled', // switch off (writes)
    'wcode.ops-disabled', // switch off (ops)
    'scope.unavailable', // scope probe failed
    'native.loading', // async state
    'error.queryRequired', // validation
  ]
  for (const key of matrix) {
    for (const [locale, dict] of Object.entries(DICTS)) {
      assert.ok(key in dict, `${locale} has degraded-state copy ${key}`)
    }
  }
})

test('recovery actions are localized buttons in both languages', () => {
  for (const key of ['native.retry', 'native.refresh', 'panel.reload']) {
    assert.ok(key in DICTS.en && key in DICTS.zh, `${key} exists in both languages`)
    attachLocale({ getSnapshot: () => ({ active: 'en' }) })
    assert.match(t(key), /[A-Za-z]/, `${key} renders English text`)
    attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
    assert.notEqual(t(key), DICTS.en[key], `${key} is actually translated`)
  }
  attachLocale(undefined)
})
