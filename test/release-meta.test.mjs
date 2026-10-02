// The release contract, as tests.
//
// Two things are worth guarding automatically, because both fail silently:
//
//   * `package.json` and `CHANGELOG.md` disagreeing — a version that ships with no
//     notes, or notes for a version that was never released;
//   * the version arithmetic and changelog promotion in `scripts/release.mjs`,
//     which run once per release and would otherwise only be exercised in
//     production.
//
// The rest of the release process (`pnpm test`, the commit, the tag) is the
// script's job; see RELEASING.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  UNRELEASED_HEADING,
  bumpVersion,
  compareVersions,
  parseArgs,
  parseVersion,
  promoteUnreleased,
} from '../scripts/release.mjs'

const repoRoot = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'))
const changelog = readFileSync(new URL('CHANGELOG.md', repoRoot), 'utf8')

test('package.json version is semver', () => {
  assert.notEqual(parseVersion(pkg.version), null, `not a semver version: ${pkg.version}`)
})

test('CHANGELOG.md documents the current version', () => {
  assert.match(
    changelog,
    new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}( |$)`, 'm'),
    `CHANGELOG.md has no "## ${pkg.version}" section`,
  )
})

test('the newest released section is the current version', () => {
  const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+[^\s]*)/gm)].map((match) => match[1])
  assert.notEqual(released.length, 0, 'CHANGELOG.md has no released section')
  assert.equal(
    released[0],
    pkg.version,
    `the newest section is ${released[0]} but package.json says ${pkg.version}`,
  )
})

test('CHANGELOG.md keeps the Unreleased landing spot on top', () => {
  const heading = changelog.indexOf(UNRELEASED_HEADING)
  assert.notEqual(heading, -1, `CHANGELOG.md has no "${UNRELEASED_HEADING}" section`)
  const firstRelease = changelog.search(/^## \d+\.\d+\.\d+/m)
  assert.ok(
    heading < firstRelease,
    `"${UNRELEASED_HEADING}" must come before the released sections`,
  )
})

test('bumpVersion walks patch, minor and major', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1')
  assert.equal(bumpVersion('0.1.0', 'minor'), '0.2.0')
  assert.equal(bumpVersion('0.2.3', 'major'), '1.0.0')
})

test('bumpVersion releases a prerelease instead of stepping past it', () => {
  assert.equal(bumpVersion('1.0.0-rc.1', 'patch'), '1.0.0')
  assert.equal(bumpVersion('1.0.0-rc.1', 'minor'), '1.1.0')
})

test('bumpVersion refuses what it cannot parse', () => {
  assert.throws(() => bumpVersion('v0.1.0', 'patch'), /not a semver version/)
  assert.throws(() => bumpVersion('0.1.0', 'tiny'), /unknown bump/)
})

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0'), -1)
  assert.throws(() => compareVersions('0.1', '0.1.0'), /cannot compare/)
})

test('promoteUnreleased promotes the notes and restores the landing spot', () => {
  const source = ['## Unreleased', '', '- added a thing', '', '## 0.1.0 — 2026-01-01', '', '- first', ''].join('\n')
  const { text, notes } = promoteUnreleased(source, '0.2.0', '2026-02-02')
  assert.equal(notes, '- added a thing')
  assert.equal(
    text,
    [
      '## Unreleased',
      '',
      '## 0.2.0 — 2026-02-02',
      '',
      '- added a thing',
      '',
      '## 0.1.0 — 2026-01-01',
      '',
      '- first',
      '',
    ].join('\n'),
  )
  // The promoted file must itself be promotable again: that is the whole point of
  // putting `## Unreleased` back.
  assert.ok(text.startsWith(`${UNRELEASED_HEADING}\n`), 'the landing spot came back')
  const filled = text.replace(`${UNRELEASED_HEADING}\n`, `${UNRELEASED_HEADING}\n\n- another thing\n`)
  assert.equal(promoteUnreleased(filled, '0.2.1', '2026-02-03').notes, '- another thing')
})

test('promoteUnreleased refuses an empty or missing section', () => {
  const empty = ['## Unreleased', '', '## 0.1.0 — 2026-01-01', '', '- first', ''].join('\n')
  assert.throws(() => promoteUnreleased(empty, '0.2.0', '2026-02-02'), /is empty/)
  assert.throws(() => promoteUnreleased('# Changelog\n', '0.2.0', '2026-02-02'), /has no/)
})

// pnpm forwards the `--` separator verbatim while npm strips it, so the same
// command has two spellings depending on the runner. This used to reject `--`
// with "unknown option", which made the command documented in RELEASING.md fail.
test('parseArgs accepts both the bare and the `--` spelling', () => {
  const expected = { target: 'patch', dryRun: false, live: true }
  assert.deepEqual(parseArgs(['patch']), expected)
  assert.deepEqual(parseArgs(['--', 'patch']), expected)
  assert.deepEqual(parseArgs(['patch', '--dry-run']), { target: 'patch', dryRun: true, live: true })
  assert.deepEqual(parseArgs(['--', 'patch', '--dry-run']), { target: 'patch', dryRun: true, live: true })
  assert.deepEqual(parseArgs(['0.2.0', '--no-live']), { target: '0.2.0', dryRun: false, live: false })
  assert.deepEqual(parseArgs(['--help']), { help: true })
})

test('parseArgs refuses what it cannot act on', () => {
  assert.throws(() => parseArgs([]), /exactly one version argument/)
  assert.throws(() => parseArgs(['patch', 'minor']), /exactly one version argument/)
  assert.throws(() => parseArgs(['patch', '--wat']), /unknown option/)
})
