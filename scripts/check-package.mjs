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

// ---- build output ----------------------------------------------------------
// The client half is a prebuilt bundle the shell serves as a file, so a package
// without it installs a plugin that cannot load.
for (const artefact of ['lib/index.js', 'lib/client.js']) {
  check(pkg.files?.includes(artefact) === true && existsSync(join(root, artefact)), `${artefact} is built and shipped`)
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
