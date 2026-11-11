// The packaging contract, checked on every run.
//
// Everything here is a requirement someone else imposes on this repository: the
// plugin list's submission rules, an npm publish, and the DSH loader reading the
// bundle manifest. They are cheap to check and expensive to discover late — a
// missing `dsh.bundle` is the single most common reason a submission is rejected,
// and `private: true` fails an npm publish only at the last step.
//
//   node scripts/check-package.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []

const check = (ok, message) => {
  console.log(`[package] ${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}

// ---- what makes it installable at all --------------------------------------
// The list's CI reads this field from package.json; `dsh.client` alone is not
// installable, and a repo that declares only it is rejected.
const patchPath = pkg.dsh?.bundle?.patch
check(typeof patchPath === 'string' && patchPath.length > 0, 'dsh.bundle.patch is declared')
check(
  typeof patchPath === 'string' && existsSync(join(root, patchPath)),
  `the patch file exists (${patchPath})`,
)
if (typeof patchPath === 'string' && existsSync(join(root, patchPath))) {
  const patch = readFileSync(join(root, patchPath), 'utf8')
  check(/^-\s*insert:/m.test(patch), 'the patch inserts a row (the loader reads it at boot)')
  check(patch.includes(pkg.name), 'the patch names this package')
}
check(pkg.dsh?.client?.platform === 'web', 'dsh.client declares the web platform')
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client lists what it injects')

// ---- what makes it publishable ---------------------------------------------
check(pkg.private !== true, 'the package is not private (npm refuses to publish it)')
check(pkg.license === 'MIT', 'a licence is declared')
check(existsSync(join(root, 'LICENSE')), 'the licence file exists and ships')
check(pkg.files?.includes('LICENSE'), 'files includes LICENSE')
// The MIT build bundles two MIT libraries and matches DSH styling; their
// permission notices have to travel with the tarball.
check(existsSync(join(root, 'THIRD_PARTY_NOTICES')), 'THIRD_PARTY_NOTICES exists')
check(pkg.files?.includes('THIRD_PARTY_NOTICES'), 'files includes THIRD_PARTY_NOTICES')
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8')
check(notices.includes('@deepseek-ai/schemastery'), 'THIRD_PARTY_NOTICES names the bundled schemastery')
check(notices.includes('@deepseek-ai/cosmokit'), 'THIRD_PARTY_NOTICES names the bundled cosmokit')
// The provenance record is the audit trail behind the independence gate.
check(existsSync(join(root, 'PROVENANCE.md')), 'PROVENANCE.md exists')
check(pkg.files?.includes('PROVENANCE.md'), 'files includes PROVENANCE.md')
// The tracked contract excerpts behind the independent recall implementation
// must travel with the package the independence claim is made about.
check(existsSync(join(root, 'CONTRACT.md')), 'CONTRACT.md exists (tracked contract excerpts)')
check(pkg.files?.includes('CONTRACT.md'), 'files includes CONTRACT.md')
// The decisions record ships with the package it governs; the acceptance record
// is repository-only (it contains human sign-off, not package content).
check(existsSync(join(root, 'DECISIONS.md')), 'DECISIONS.md exists (licence/API-stability record)')
check(pkg.files?.includes('DECISIONS.md'), 'files includes DECISIONS.md')
check(existsSync(join(root, 'ACCEPTANCE.md')), 'ACCEPTANCE.md exists (release acceptance record)')
check(!pkg.files?.includes('ACCEPTANCE.md'), 'ACCEPTANCE.md is intentionally not shipped in the package')
check(typeof pkg.description === 'string' && pkg.description.length > 20, 'a one-line description is set')
check(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, 'keywords are set')
// The marketplace links an npm package to its repository through this field, and
// only through this field.
check(pkg.repository === undefined || typeof pkg.repository?.url === 'string', 'repository, when set, is a url')

// ---- what the loader needs at runtime --------------------------------------
// Official packages belong in peerDependencies: a dependency would install a
// second copy of the harness beside the one already running.
const officialDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
check(officialDeps.length === 0, `no official @deepseek-ai package is a runtime dependency (${officialDeps.join(', ') || 'none'})`)
check(
  Object.keys(pkg.peerDependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/')),
  'the harness is declared as a peer, which is what the version check reads',
)
check(typeof pkg.engines?.node === 'string', 'engines.node is declared')
check(typeof pkg.engines?.dsh === 'string', 'engines.dsh is declared')
check(pkg.dsh?.engines?.dsh === pkg.engines?.dsh, 'dsh.engines.dsh and engines.dsh agree')
// The old range was a logically unbounded disjunction (`>=0.2.0-rc.2 || …`), so a
// future 1.x would have been accepted silently. The upper bound is intentional,
// and it is stated per DSH pre-release line: npm-style semver does not admit
// 0.2.2-rc.1 to a single comparator set anchored at `0.2.0-rc.2`.
check(
  typeof pkg.engines?.dsh === 'string' &&
    pkg.engines.dsh.split('||').every((alternative) => /<\d+\.\d+\.\d+-0/.test(alternative)),
  'engines.dsh is upper-bounded below the next major on every pre-release line',
)
// `engines.dsh` is the authoritative DSH check. The peer range states the same
// policy split per DSH prerelease line, because npm-style semver excludes the
// 0.2.x pre-releases from a single `>=0.2.0-rc.2` comparator set (DSH's own check
// evaluates with `includePrerelease`); every alternative still has an upper bound.
const peerRange = pkg.peerDependencies?.['@deepseek-ai/dsh']
check(
  typeof peerRange === 'string' &&
    peerRange.split('||').every((alternative) => /<\d+\.\d+\.\d+-0/.test(alternative)),
  'the @deepseek-ai/dsh peer range is bounded below the next major on every line',
)
check(
  typeof peerRange === 'string' && peerRange.includes('>=0.2.2-rc.1'),
  'the peer range admits the authenticated-write DSH generation',
)
check(
  peerRange === pkg.engines?.dsh,
  'the @deepseek-ai/dsh peer range and engines.dsh state the same policy',
)

// ---- a stranger can install it --------------------------------------------
// pnpm refuses to install while any dependency build script is undecided, and its
// interactive approval writes the undecided ones back as prose ("set this to true
// or false") — a file that no longer installs, in a repository where nobody ran
// the installer again. This is that failure, one line of YAML.
const workspacePath = join(root, 'pnpm-workspace.yaml')
if (existsSync(workspacePath)) {
  const workspace = readFileSync(workspacePath, 'utf8')
  const lines = workspace.split('\n')
  const start = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line))
  const undecided = []
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break
      const match = /^\s+'?([^':]+)'?:\s*(\S.*)$/.exec(line)
      if (match === null) continue
      if (match[2] !== 'true' && match[2] !== 'false') undecided.push(match[1])
    }
  }
  check(undecided.length === 0, `every build script is decided in pnpm-workspace.yaml (${undecided.join(', ') || 'none undecided'})`)
  check(/esbuild:\s*true/.test(workspace), 'esbuild may run its install script, which the build needs')
}

// ---- the version the documentation claims --------------------------------
// The release script bumps `package.json`; the two READMEs carry a version line
// that nothing else reads. They drifted on the very first release — 0.2.0 shipped
// with both headers still saying 0.1.0 — so the claim is asserted here instead.
for (const readme of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(root, readme), 'utf8')
  check(text.includes(`**v${pkg.version}**`), `${readme} states the current version (v${pkg.version})`)
}

// ---- build output ----------------------------------------------------------
// The client half is a prebuilt bundle the shell serves as a file, so a package
// without it installs a plugin that cannot load.
for (const artefact of ['lib/index.js', 'lib/client.js']) {
  check(pkg.files?.includes(artefact) === true && existsSync(join(root, artefact)), `${artefact} is built and shipped`)
}
// The Doctor reports this range, and it is a second copy of the manifest string.
// Escaping the build output would let the two drift silently; assert the built
// host carries the exact range instead.
if (existsSync(join(root, 'lib/index.js')) && typeof pkg.engines?.dsh === 'string') {
  const built = readFileSync(join(root, 'lib/index.js'), 'utf8')
  const builtRange = /PLUGIN_DSH_RANGE\s*=\s*"([^"]+)"/.exec(built)?.[1] ?? null
  check(builtRange === pkg.engines.dsh, 'the built host carries the manifest DSH range verbatim')
}
// The plugin's own version is baked into the bundle at build time (`define` in
// build.mjs), which is what the outbound User-Agent and the Doctor report. A
// stale `lib/` from an older build would ship the previous version, so assert the
// replacement actually happened and carries the manifest version.
if (existsSync(join(root, 'lib/index.js'))) {
  const built = readFileSync(join(root, 'lib/index.js'), 'utf8')
  check(
    !built.includes('__DSH_OPENVIKING_ENHANCE_VERSION__'),
    'the built host carries the build-time plugin version (define applied)',
  )
  check(
    built.includes(JSON.stringify(pkg.version)),
    `the built host embeds package version ${pkg.version}`,
  )
}
check(
  typeof pkg.scripts?.prepack === 'string',
  'prepack builds the bundle, so a published tarball can never lack it',
)

console.log(
  failures.length === 0
    ? '[package] all checks passed'
    : `[package] ${failures.length} check(s) failed`,
)
if (failures.length > 0) process.exitCode = 1
