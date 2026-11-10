// The v0.7 host-contract and compatibility documentation, pinned to the code.
//
// The v0.6 contract test already pins the limits table (both languages) and the
// version ranges; this file pins what v0.7 ADDS to the contract: the native read
// cockpit, the new switches, the deep-link/Studio fallbacks, the local onboarding
// state file and the bounded read budgets described in prose. It also keeps the
// CHANGELOG and VERIFICATION records honest (version sections exist, evidence is
// planned rather than claimed).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const readmeEn = readFileSync(new URL('README.md', root), 'utf8')
const readmeZh = readFileSync(new URL('README.zh.md', root), 'utf8')
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
const verification = readFileSync(new URL('VERIFICATION.md', root), 'utf8')

/** Assert a phrase exists in both languages, naming the language on failure. */
function bothLanguages(assertions) {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    for (const phrase of assertions) {
      assert.ok(markdown.includes(phrase), `${language} README must document: ${phrase}`)
    }
  }
}

test('the README version note covers v0.7 in both languages (D1)', () => {
  assert.match(readmeEn, /> The v0\.4 Act, v0\.5 Collaborate[^>]*v0\.7 Native[^>]*>/)
  assert.match(readmeZh, /v0\.7 Native/)
})

test('both READMEs document the local onboarding write boundary honestly (S5/S7/S8)', () => {
  // S8: the trust invariant is about the POST that cannot reach OpenViking.
  assert.match(readmeEn, /no loopback POST path that reaches\s+OpenViking/i)
  assert.match(readmeZh, /能到达 OpenViking 的 loopback POST 路径/)
  // The local-state POST is clamped and audited, and the onboarding write is gated.
  assert.ok(readmeEn.includes('forget'), 'EN README names the forget action')
  assert.ok(readmeEn.includes('audit trail'), 'EN README says the action is audited')
  assert.ok(readmeZh.includes('forget'), 'ZH README names the forget action')
  assert.ok(readmeZh.includes('审计'), 'ZH README says the action is audited')
  assert.match(readmeEn, /lastOpenedAt[^.]*only while the `showOnboarding` switch is on/s)
  assert.match(readmeZh, /lastOpenedAt.*showOnboarding/)
  // S7: no documented constant without a consumer remains.
  for (const markdown of [readmeEn, readmeZh]) {
    assert.ok(!markdown.includes('SESSION_DETAIL_CACHE_TTL_MS'), 'the unused session-detail TTL is not documented')
  }
})

test('both READMEs document the native cockpit and its six views', () => {
  bothLanguages(['showNativeViews', 'showOnboarding', 'onboarding.json', '0600'])
  assert.match(readmeEn, /native read cockpit/i)
  assert.match(readmeZh, /原生阅读面板/)
  for (const view of ['Overview', 'Browse', 'Sessions', 'Commits', 'Stats', 'Studio']) {
    assert.ok(readmeEn.includes(view), `EN README names the ${view} view`)
  }
  for (const view of ['概览', '浏览', '会话', '提交', '统计', 'Studio']) {
    assert.ok(readmeZh.includes(view), `ZH README names the ${view} view`)
  }
})

test('both READMEs document the new routes and the local-state POST boundary', () => {
  for (const route of ['/overview', '/browse/roots', '/browse', '/browse/subtree', '/sessions', '/recent-commits', '/studio-status', '/onboarding/state']) {
    assert.ok(readmeEn.includes(route), `EN README names the ${route} route`)
  }
  // The local-state POST is not an OpenViking mutation and never takes the
  // authenticated write transport; that distinction is part of the contract.
  assert.match(readmeEn, /not an OpenViking mutation/i)
  assert.match(readmeZh, /不是 OpenViking 写入/)
  bothLanguages(['64 KiB'])
})

test('both READMEs document the deep-link and Studio fallbacks honestly', () => {
  bothLanguages(['selectPanel', 'X-Frame-Options', 'CSP'])
  assert.match(readmeEn, /older DSH/i)
  assert.match(readmeZh, /旧 DSH/)
  assert.match(readmeEn, /open in a new tab|open-in-a-new-tab|open-in-new-tab/i)
  assert.match(readmeZh, /新标签页/)
})

test('both READMEs state the bounded read budgets and the v0.7 limits table', () => {
  bothLanguages(['BROWSE_PAGE_SIZE', 'RECENT_COMMITS_SESSION_CAP', 'NATIVE_HISTORY_MAX'])
  for (const phrase of ['50 rows', '8 sessions']) {
    assert.ok(readmeEn.toLowerCase().includes(phrase.toLowerCase()), `EN README states the ${phrase} budget`)
  }
  assert.match(readmeEn, /no global commit history/i)
  assert.match(readmeZh, /没有全局提交历史/)
  assert.match(readmeEn, /never read|never reads|is never read/i)
  assert.match(readmeZh, /从不读取/)
})

test('the CHANGELOG carries the v0.7 section under Unreleased', () => {
  const unreleased = changelog.indexOf('## Unreleased')
  const v07 = changelog.indexOf('### v0.7 — Native I: no iframe for reading')
  const v06 = changelog.indexOf('### v0.6 — Trust and verify')
  assert.notEqual(unreleased, -1, 'Unreleased heading exists')
  assert.notEqual(v07, -1, 'the v0.7 section exists')
  assert.ok(unreleased < v07, 'v0.7 is under Unreleased')
  assert.ok(v07 < v06, 'the newest change section comes first')
  const section = changelog.slice(v07, v06)
  for (const phrase of ['onboarding.json', 'studio-status', '/overview', 'showNativeViews', 'showOnboarding']) {
    assert.ok(section.includes(phrase), `the v0.7 notes mention ${phrase}`)
  }
})

test('VERIFICATION plans the native-cockpit browser evidence instead of claiming it', () => {
  assert.match(verification, /v0\.7 native-cockpit scenario checklist/)
  assert.match(verification, /clean DSH\s+profile/i)
  assert.match(verification, /Studio fallback/i)
  assert.match(verification, /Read-only check/i)
  // No dated 0.7.0 pass may be claimed before the PR's evidence exists.
  assert.ok(!/\|\s*0\.7\.0[^\n]*\|\s*pass\s*\|/.test(verification), 'no premature 0.7 pass claim')
})
