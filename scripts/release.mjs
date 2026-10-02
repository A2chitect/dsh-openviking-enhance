// Cut a release: promote the changelog, write the version, run the gate, tag.
//
//   pnpm run release patch          0.1.0 -> 0.1.1
//   pnpm run release minor          0.1.1 -> 0.2.0
//   pnpm run release major          0.2.0 -> 1.0.0
//   pnpm run release 0.2.0          an explicit version
//   pnpm run release minor --dry-run   check the preconditions, change nothing
//   pnpm run release minor --no-live   do not require a running OpenViking
//
// The process this enforces is written down in RELEASING.md; the short version is
// that the notes go under `## Unreleased` in CHANGELOG.md *first*, and this script
// does the mechanical rest:
//
//   1. refuse to start unless the working tree is clean and the next version is
//      greater than the current one and not already tagged;
//   2. refuse unless `## Unreleased` exists and has something under it — a release
//      with no notes is a release nobody can interpret later;
//   3. write the version into package.json and promote the changelog section;
//   4. run the full gate, `pnpm test`, with the live OpenViking smoke *required*
//      so it cannot silently skip (--no-live drops that requirement and the tag
//      message records the omission);
//   5. commit and create the annotated tag, whose message is the release notes.
//
// Steps 3-5 all happen after the version is written but before anything is
// committed, so a failure anywhere rolls package.json and CHANGELOG.md back to
// HEAD: a failed release leaves the tree exactly as it found it.
//
// This package is `private: true` and installed from a path or link, so a release
// is a git tag plus a documented changelog entry. There is no `npm publish` step.
//
// The pure helpers below are exported for `test/release-meta.test.mjs`, which also
// checks that the current version and the newest changelog section agree.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UNRELEASED_HEADING = '## Unreleased'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const changelogPath = join(repoRoot, 'CHANGELOG.md')
const packagePath = join(repoRoot, 'package.json')

const log = (...parts) => console.log('[release]', ...parts)
const fail = (message) => {
  console.error('[release] error:', message)
  process.exit(1)
}

/** Parse `1.2.3` / `1.2.3-rc.1` into its parts; null when it is not semver. */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

function formatVersion({ major, minor, patch, prerelease }) {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`
}

/** `patch` on a prerelease drops the prerelease instead of bumping: 1.0.0-rc.1 -> 1.0.0. */
export function bumpVersion(current, kind) {
  const parsed = parseVersion(current)
  if (!parsed) throw new Error(`not a semver version: ${current}`)
  if (kind === 'patch') {
    return parsed.prerelease
      ? formatVersion({ ...parsed, prerelease: '' })
      : formatVersion({ ...parsed, patch: parsed.patch + 1 })
  }
  if (kind === 'minor') {
    return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0, prerelease: '' })
  }
  if (kind === 'major') {
    return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0, prerelease: '' })
  }
  throw new Error(`unknown bump: ${kind} (expected patch, minor or major)`)
}

/**
 * Order two versions, -1 / 0 / 1. A prerelease sorts before its release, and two
 * prereleases compare as strings — good enough for `rc.2` vs `rc.10`-style tags
 * that this repository has never used.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`cannot compare non-semver versions: ${left}, ${right}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Turn `## Unreleased` into the released heading and put a fresh empty
 * `## Unreleased` back on top, so the next release always has its landing spot.
 * Returns the new file text and the notes that go into the tag message.
 */
export function promoteUnreleased(changelog, version, date) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === UNRELEASED_HEADING)
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section`)
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index
      break
    }
  }
  const notes = lines.slice(start + 1, end).join('\n').trim()
  if (!notes) {
    throw new Error(`"${UNRELEASED_HEADING}" is empty: write what changed before releasing`)
  }
  const promoted = [
    ...lines.slice(0, start),
    UNRELEASED_HEADING,
    '',
    `## ${version} — ${date}`,
    ...lines.slice(start + 1, end),
    ...lines.slice(end),
  ]
  return { text: promoted.join('\n'), notes }
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  }
  return result
}

function localDate() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function usage() {
  return [
    'usage: pnpm run release <patch|minor|major|x.y.z> [--dry-run] [--no-live]',
    '',
    '  --dry-run  check every precondition and print the plan, change nothing',
    '  --no-live  do not require a running OpenViking server for the smoke step',
    '',
    'Write the release notes under "## Unreleased" in CHANGELOG.md first.',
  ].join('\n')
}

export function parseArgs(argv) {
  // pnpm forwards the `--` separator to the script (`pnpm run release -- patch`
  // arrives as `-- patch`), npm strips it. Accept both spellings rather than
  // documenting which runner does what.
  const parts = argv.filter((part) => part !== '--')
  const flags = new Set(parts.filter((part) => part.startsWith('-')))
  const positional = parts.filter((part) => !part.startsWith('-'))
  if (flags.has('-h') || flags.has('--help')) return { help: true }
  const unknown = [...flags].filter((flag) => !['-h', '--help', '--dry-run', '--no-live'].includes(flag))
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(', ')}`)
  if (positional.length !== 1) throw new Error('expected exactly one version argument')
  return {
    target: positional[0],
    dryRun: flags.has('--dry-run'),
    live: !flags.has('--no-live'),
  }
}

function resolveNextVersion(current, target) {
  if (['patch', 'minor', 'major'].includes(target)) return bumpVersion(current, target)
  if (!parseVersion(target)) throw new Error(`not a bump or a version: ${target}`)
  return target
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    fail(`${error.message}\n\n${usage()}`)
  }
  if (options.help) {
    console.log(usage())
    return
  }

  // Preconditions, cheapest and most actionable first: a dirty tree is the
  // commonest blocker and a bad argument the next, and both are better reported
  // before the "did you write the notes" check.
  const dirty = git(['status', '--porcelain']).stdout.trim()
  if (dirty) {
    fail(`working tree is not clean — commit or stash first:\n${dirty}`)
  }

  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const current = pkg.version
  const date = localDate()
  let next
  let promotion
  try {
    next = resolveNextVersion(current, options.target)
    if (compareVersions(next, current) <= 0) {
      throw new Error(`next version ${next} is not greater than the current ${current}`)
    }
    if (git(['rev-parse', '--verify', '--quiet', `refs/tags/v${next}`], { allowFailure: true }).status === 0) {
      throw new Error(`tag v${next} already exists`)
    }
    promotion = promoteUnreleased(readFileSync(changelogPath, 'utf8'), next, date)
  } catch (error) {
    fail(error.message)
  }

  log(`${current} -> ${next}${options.dryRun ? '  (dry run)' : ''}`)
  log(`notes       ${promotion.notes.split('\n').length} line(s) from "${UNRELEASED_HEADING}"`)
  log(`gate        pnpm test${options.live ? ' with SMOKE_REQUIRE_SERVER=1' : ' (live OpenViking not required)'}`)
  if (options.dryRun) {
    log('dry run: nothing written, nothing committed, no tag created')
    return
  }

  // Everything below is rolled back together if the gate or the commit fails.
  const versionLine = /^(\s*"version":\s*")[^"]+(")/m
  if (!versionLine.test(readFileSync(packagePath, 'utf8'))) {
    fail('package.json has no top-level "version" field to rewrite')
  }

  let committed = false
  const rollback = () => {
    git(['checkout', '--', 'package.json', 'CHANGELOG.md'])
    log('rolled back package.json and CHANGELOG.md')
  }

  try {
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8').replace(versionLine, `$1${next}$2`))
    writeFileSync(changelogPath, promotion.text)
    log(`changelog   "${UNRELEASED_HEADING}" promoted to "## ${next} — ${date}"`)

    const env = { ...process.env }
    if (options.live) env.SMOKE_REQUIRE_SERVER = '1'
    const gate = spawnSync('pnpm', ['run', 'test'], { cwd: repoRoot, stdio: 'inherit', env })
    if (gate.error) throw gate.error
    if (gate.status !== 0) throw new Error(`the gate failed (exit ${gate.status})`)

    git(['add', 'package.json', 'CHANGELOG.md'])
    git(['commit', '-m', `release ${next}`])
    committed = true

    const tagMessage = [
      `${next} — ${date}`,
      '',
      promotion.notes,
      ...(options.live ? [] : ['', 'Released without live OpenViking verification (--no-live).']),
    ].join('\n')
    git(['tag', '-a', `v${next}`, '-m', tagMessage])
  } catch (error) {
    if (!committed) rollback()
    fail(error.message)
  }

  const commit = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
  log(`commit      ${commit} release ${next}`)
  log(`tag         v${next}`)
  const remote = git(['remote'], { allowFailure: true }).stdout.trim()
  log(remote ? `push        git push --follow-tags ${remote.split('\n')[0]}` : 'push        no remote configured')
  log('next        reload the window (client half); restart the DSH app (host half)')
  log('            then walk the acceptance list in RELEASING.md')
}

// Only run when invoked as a command: the test harness imports the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
