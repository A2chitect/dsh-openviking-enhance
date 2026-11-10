// v1.0 final documentation contract.
//
// The release's closing claim is that the docs are true to the shipped code:
// F1–F14 ledger complete and mirrored in both languages, the final compatibility
// matrix honest about U/D, the licence/API-stability decision tracked, the
// acceptance record complete with its human sign-off block, the 1.0.0 release
// path/rollback policy recorded, and the package-vs-repository file split
// enforced. This suite is the machine check for that claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const readmeEn = readFileSync(new URL('README.md', root), 'utf8')
const readmeZh = readFileSync(new URL('README.zh.md', root), 'utf8')
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
const verification = readFileSync(new URL('VERIFICATION.md', root), 'utf8')
const releasing = readFileSync(new URL('RELEASING.md', root), 'utf8')
const decisions = readFileSync(new URL('DECISIONS.md', root), 'utf8')
const acceptance = readFileSync(new URL('ACCEPTANCE.md', root), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
const checkPackage = readFileSync(new URL('scripts/check-package.mjs', root), 'utf8')

/** A markdown section body, by heading prefix. */
function section(markdown, heading) {
  const start = markdown.indexOf(heading)
  if (start === -1) return null
  const rest = markdown.slice(start + heading.length)
  const next = rest.search(/^## /m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** Count the F-ledger rows in one README. */
function ledgerRows(markdown) {
  return [...markdown.matchAll(/^\| F\d+ \|/gm)].length
}

test('both READMEs carry the complete F1–F14 ledger and the Studio-off walkthrough', () => {
  for (const [language, markdown, heading] of [
    ['en', readmeEn, '## Native completeness (v1.0)'],
    ['zh', readmeZh, '## 原生完整度（v1.0）'],
  ]) {
    const body = section(markdown, heading)
    assert.notEqual(body, null, `${language} README has the native-completeness chapter`)
    assert.equal(ledgerRows(body), 14, `${language} README lists all F1–F14 ledger rows`)
    for (const id of Array.from({ length: 14 }, (_, index) => `F${index + 1}`)) {
      assert.ok(body.includes(`| ${id} |`), `${language} README has ledger row ${id}`)
    }
    assert.match(body, /Studio-off|不打开 Studio/i, `${language} README documents the Studio-off walkthrough`)
    assert.match(body, /What remains Studio\/CLI-only|仍只在 Studio\/CLI/, `${language} README lists the Studio/CLI-only remainder`)
    assert.match(body, /Accessibility|可访问性/, `${language} README documents the accessibility scope`)
    assert.match(body, /Bilingual parity|双语一致性/, `${language} README documents bilingual parity`)
    assert.match(body, /Request and performance budgets|请求与性能预算/, `${language} README documents the budgets`)
    assert.match(body, /Degraded states|降级状态/, `${language} README documents the degraded-state contract`)
    assert.match(body, /Release path|发布路径/, `${language} README documents the 1.0.0 release path`)
    assert.match(body, /DECISIONS\.md/, `${language} README points at DECISIONS.md`)
    assert.match(body, /ACCEPTANCE\.md/, `${language} README points at ACCEPTANCE.md`)
  }
})

test('the final compatibility matrix is complete, mirrored, and honest about U/D', () => {
  const en = section(readmeEn, '### Final compatibility and evidence matrix')
  const zh = section(readmeZh, '### 最终兼容性与证据矩阵')
  assert.notEqual(en, null)
  assert.notEqual(zh, null)
  const rowCount = (body) => [...body.matchAll(/^\| .+ \|$/gm)].length
  assert.equal(rowCount(zh), rowCount(en), 'the matrix is mirrored row for row')
  for (const label of ['L', 'CI', 'M', 'D', 'U']) {
    assert.match(en, new RegExp(`\\*\\*${label}\\*\\*`), `legend defines ${label}`)
    assert.match(zh, new RegExp(`\\*\\*${label}\\*\\*`), `zh legend defines ${label}`)
  }
  for (const area of ['DSH reads', 'DSH writes', 'OpenViking', 'Desktop carrier', 'Official memory plugin', 'Runtime dependencies']) {
    assert.ok(en.includes(area), `matrix covers ${area}`)
  }
  assert.match(en, /Windows\s*U|Windows\s*\*\*U\*\*/, 'Windows is labelled U, not verified')
  assert.match(en, /desktop[- ]write[- ]parity\s*[^|]*\bU\b/i, 'desktop write parity is U')
})

test('DECISIONS.md records the MIT/independence and API-stability decisions', () => {
  for (const phrase of ['MIT', 'AGPL', 'independently implemented', 'API stability', 'semver', 'Escalation trigger', 'tested range']) {
    assert.ok(decisions.includes(phrase), `DECISIONS.md mentions ${phrase}`)
  }
  assert.match(decisions, /^# Decisions/m)
  assert.match(decisions, /D1 — Licence/)
  assert.match(decisions, /D2 — API stability/)
  assert.match(decisions, /D5 — Release path/)
})

test('ACCEPTANCE.md has the taxonomy, goal map, checklists, protocol and sign-off', () => {
  assert.match(acceptance, /^# Acceptance/m)
  for (const verdict of ['Verified', 'CI-verified', 'Design-verified', 'Fixture-only', 'Checklist-verified (frequency-unmeasured)', 'Externally-unverified', 'Not shipped / non-goal', 'Documented limitation']) {
    assert.ok(acceptance.includes(verdict), `taxonomy includes ${verdict}`)
  }
  assert.match(acceptance, /Roadmap goal/, 'maps the roadmap goal')
  assert.match(acceptance, /Version exit criteria/, 'maps the version exit criteria')
  assert.match(acceptance, /Roadmap invariants/, 'records the invariants')
  // 12-item daily checklist, explicitly frequency-unmeasured.
  const checklist = section(acceptance, '## 8. Daily-check checklist')
  assert.notEqual(checklist, null)
  assert.equal([...checklist.matchAll(/^\| \d+ \|/gm)].length, 12, 'the daily-check table has 12 items')
  assert.match(acceptance, /frequency-unmeasured|frequency remains unmeasured|unmeasured/, 'frequency is marked unmeasured')
  // 5-real-users protocol marked externally-unverified, with the 4/5 threshold.
  assert.match(acceptance, /5-real-users user-study protocol/)
  assert.match(acceptance, /Externally-unverified/)
  assert.match(acceptance, /≥4\/5|4\/5/, 'the study pass threshold is stated')
  // Human sign-off block.
  assert.match(acceptance, /Human sign-off block/)
  assert.match(acceptance, /Maintainer: _+ +Date:/)
  assert.match(acceptance, /ACCEPT \/ REJECT/)
  assert.match(acceptance, /tag is created by a\s+human after merge/i)
})

test('the 1.0.0 release path, upgrade pin and rollback policy are recorded', () => {
  assert.match(releasing, /1\.0\.0 发布/, 'RELEASING has the 1.0.0 section')
  assert.match(releasing, /回退路径|回滚/, 'the fallback/rollback path is named')
  assert.match(releasing, /--upgrade-from/, 'the upgrade pin is mentioned')
  assert.match(releasing, /绝不移动|never move|不重打/, 'no-retag rule is stated')
  assert.match(releasing, /1\.0\.1/, 'patch-release rollback is stated')
  assert.match(verification, /\| 1\.0\.0 \(PR #8/, 'VERIFICATION has the 1.0.0 row')
  assert.match(verification, /fallback|回退/, 'VERIFICATION names the release-path fallback')
  assert.match(verification, /v1\.0 acceptance checklist/i, 'VERIFICATION has the v1.0 manual checklist')
})

test('CHANGELOG has the final v1.0 section under Unreleased, above v0.9', () => {
  const v10 = changelog.indexOf('### v1.0 — Native complete')
  const v09 = changelog.indexOf('### v0.9 —')
  const unreleased = changelog.indexOf('## Unreleased')
  assert.notEqual(v10, -1, 'the v1.0 section exists')
  assert.ok(unreleased < v10 && v10 < v09, 'v1.0 is under Unreleased and above v0.9')
  const body = changelog.slice(v10, v09)
  for (const phrase of ['F1–F14', 'Accessibility', 'Bilingual', 'performance', 'degraded', 'DECISIONS.md', 'ACCEPTANCE.md', '1.0.0', 'externally-unverified', 'frequency']) {
    assert.ok(body.includes(phrase), `the v1.0 notes mention ${phrase}`)
  }
  assert.match(body, /27\/27/, 'install evidence count is recorded')
})

test('the package ships the decisions record and not the acceptance record', () => {
  assert.ok(pkg.files.includes('DECISIONS.md'), 'package files include DECISIONS.md')
  assert.ok(!pkg.files.includes('ACCEPTANCE.md'), 'the acceptance record is repository-only')
  assert.ok(ci.includes('package/DECISIONS.md'), 'CI tarball assertions include DECISIONS.md')
  assert.match(checkPackage, /DECISIONS\.md exists/, 'check-package asserts DECISIONS.md')
  assert.match(checkPackage, /ACCEPTANCE\.md is intentionally not shipped/, 'check-package asserts the spec split')
})

test('the command-output language limitation is documented in both READMEs', () => {
  assert.match(readmeEn, /\/viking\*?\*? command output is English|\/viking` command\s+output is English|command output is English/i)
  assert.match(readmeZh, /\/viking[^\n]*命令输出为英文|命令输出为英文/)
})
