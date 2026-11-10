// The documented host contract, pinned to the code it describes.
//
// Two READMEs, one contract chapter each. A test is the only thing that keeps
// them from drifting: the limits table is parsed out of the fenced
// `<!-- contract:limits -->` block and compared value-by-value with
// `src/shared/limits.ts`; the version ranges, install commands, cost/privacy
// wording and the explicit N/A matrix are asserted to exist in both languages.
// `VERIFICATION.md` has to stay a usable release record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as limits from '../src/shared/limits.ts'
import { PLUGIN_DSH_RANGE, TESTED_OV_RANGE } from '../src/host/doctor-service.ts'

const root = new URL('..', import.meta.url)
const readmeEn = readFileSync(new URL('README.md', root), 'utf8')
const readmeZh = readFileSync(new URL('README.zh.md', root), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const verification = readFileSync(new URL('VERIFICATION.md', root), 'utf8')

/** The machine-readable limits table, parsed out of one README. */
function parsedLimits(markdown) {
  const block = /<!-- contract:limits -->([\s\S]*?)<!-- \/contract:limits -->/.exec(markdown)
  assert.notEqual(block, null, 'README is missing the contract:limits block')
  const rows = new Map()
  for (const line of block[1].split('\n')) {
    const match = /^\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*(-?\d+)\s*\|$/.exec(line.trim())
    if (match !== null) rows.set(match[1], Number(match[2]))
  }
  return rows
}

/** The constants the documented table must cover. */
const DOCUMENTED_LIMITS = [
  'DEFAULT_REQUEST_TIMEOUT_MS',
  'HEALTH_TIMEOUT_MS',
  'STATUS_TIMEOUT_MS',
  'FS_TIMEOUT_MS',
  'LIST_SEARCH_TIMEOUT_MS',
  'CONTEXT_SEARCH_TIMEOUT_MS',
  'RECALL_CONTENT_TIMEOUT_MS',
  'WRITE_TIMEOUT_MS',
  'SET_TAGS_TIMEOUT_MS',
  'SNAPSHOT_TIMEOUT_MS',
  'WRITE_TOKEN_TTL_MS',
  'WRITE_BODY_MAX_BYTES',
  'RULE_LIST_DEADLINE_MS',
  'RULE_LIST_CONCURRENCY',
  'PREVIEW_BODY_MAX_LINES',
  'PREVIEW_BODY_MAX_LINES_RESPONSE',
  'PREVIEW_MAX_CHARS',
  'AUDIT_MAX_BYTES',
  'AUDIT_KEEP_ROTATIONS',
  'ACTIVITY_TASKS_MAX_LIMIT',
]

test('both READMEs document every user-visible limit with the code value', () => {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    const rows = parsedLimits(markdown)
    for (const name of DOCUMENTED_LIMITS) {
      assert.equal(typeof limits[name], 'number', `${name} exists in src/shared/limits.ts`)
      assert.equal(rows.get(name), limits[name], `${language} README: ${name} must equal the code value`)
    }
    assert.equal(rows.size, DOCUMENTED_LIMITS.length, `${language} README documents exactly the contract table`)
  }
})

test('the declared DSH range is upper-bounded below the next major', () => {
  assert.equal(pkg.engines?.dsh, PLUGIN_DSH_RANGE, 'the Doctor constant is the manifest range')
  assert.equal(pkg.dsh?.engines?.dsh, PLUGIN_DSH_RANGE)
  assert.match(PLUGIN_DSH_RANGE, /^>=0\.2\.0-rc\.2 <1\.0\.0-0$/, 'a future 1.x is not accepted')
  assert.ok(!PLUGIN_DSH_RANGE.includes('||'), 'the old logically-unbounded disjunction is gone')
  // The peer range is the same policy split per DSH prerelease line: npm-style
  // semver drops 0.2.x pre-releases from a single comparator set that anchors at
  // 0.2.0-rc.2, and DSH's runtime check includes them. Every line stays bounded.
  const peer = pkg.peerDependencies?.['@deepseek-ai/dsh']
  assert.equal(typeof peer, 'string')
  assert.ok(peer.split('||').every((alternative) => /<\d+\.\d+\.\d+-0/.test(alternative)), 'every peer line is upper-bounded')
  assert.ok(peer.includes('>=0.2.2-rc.1'), 'the write-floor generation is admitted')
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    assert.ok(markdown.includes(PLUGIN_DSH_RANGE), `${language} README states the DSH range verbatim`)
    assert.ok(markdown.includes(TESTED_OV_RANGE), `${language} README states the tested OpenViking range verbatim`)
  }
})

test('both READMEs document the tested OpenViking generations and the write floor', () => {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    assert.match(markdown, /0\.5\.1\.1/, `${language}: tested floor`)
    assert.match(markdown, /0\.5\.3/, `${language}: tested head`)
    assert.match(markdown, /0\.5\.2/, `${language}: the unverified generation is called out`)
    assert.ok(markdown.includes('0.2.2-rc.1'), `${language}: the write-floor DSH generation is stated`)
  }
})

test('both READMEs use the web-profile install commands, not the reserved desktop profile', () => {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    assert.ok(markdown.includes('dsh plugin --profile web add dsh-openviking-enhance'), `${language}: web add command`)
    assert.ok(markdown.includes('dsh plugin --profile web remove dsh-openviking-enhance'), `${language}: web remove command`)
    assert.ok(!markdown.includes('--profile desktop add'), `${language}: must not tell CLI users to use the reserved desktop profile`)
    assert.ok(!markdown.includes('--profile desktop remove'), `${language}: same for remove`)
    assert.match(markdown, /Plugins page|Plugins 页/, `${language}: the Desktop install path is described`)
  }
})

test('both READMEs carry the cost and privacy wording', () => {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    assert.match(markdown, /include rules|包含规则/i, `${language}: the rules opt-in and its cost are documented`)
    assert.match(markdown, /SMOKE_VERBOSE=1/, `${language}: the redacted-by-default smoke escape hatch is documented`)
    assert.match(markdown, /loopback/, `${language}: the loopback boundary is documented honestly`)
    assert.match(markdown, /profiles\.json/, `${language}: the secret store of record is named`)
    assert.match(markdown, /0600/, `${language}: the secret file mode is stated`)
  }
})

test('both READMEs carry the explicit not-applicable matrix', () => {
  for (const [language, markdown] of [
    ['en', readmeEn],
    ['zh', readmeZh],
  ]) {
    assert.match(markdown, /Not applicable|不适用/i, `${language}: N/A section`)
    for (const duty of ['MCP', 'URI guard', 'hook']) {
      assert.ok(markdown.includes(duty) || (language === 'zh' && duty === 'hook' && markdown.includes('生命周期')), `${language}: ${duty} is named as the official plugin's job`)
    }
  }
})

test('VERIFICATION.md stays a usable release record', () => {
  assert.match(verification, /^# Verification/m)
  assert.match(verification, /pnpm run verify:install/, 'the repeatable command is documented')
  assert.match(verification, /\| Version \| Date \|/, 'the verified matrix schema is present')
  assert.match(verification, /Update rule/, 'the append-only rule is stated')
  assert.match(verification, /Not covered here/, 'the CI limits are stated')
})
