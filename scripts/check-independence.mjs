// The independence gate.
//
// This repository is MIT and depends on the documented behaviour of two
// projects whose own licences differ. The ROADMAP invariant is "No AGPL code":
// behaviour is treated as an interface fact and re-implemented independently,
// never transcribed. A comment that says "copied from upstream", or a stray
// import of an upstream package, is exactly the review signal that invariant
// exists to catch — so it is a build failure, not a code-review hope.
//
// What this gate checks:
//   1. no banned provenance marker in `src/` (copied-from wording, an upstream
//      builder name, AGPL text). Contributors who cannot name the behaviour
//      contract must not code it; see PROVENANCE.md.
//   2. no import/require of `@openviking/*` or the upstream shared example path
//      in `src/`.
//   3. the built bundles carry none of the same markers (esbuild strips
//      comments, but a leaked string would still ship).
//   4. no committed test fixture claims to be a real-server capture
//      ("capturedFrom"); fixtures must be hand-authored or mock-derived.
//   5. `THIRD_PARTY_NOTICES` exists, is listed in `package.json.files`, and
//      names both bundled dependencies; `PROVENANCE.md` exists and its audit
//      table is maintained (its row count is printed).
//
//   node scripts/check-independence.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (ok, message) => {
  console.log(`[independence] ${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}

/** Every file under `dir`, recursively, without following symlinks. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * The provenance markers that must never appear in shipped source.
 *
 * The licence strings are matched as words with boundaries on purpose: a plain
 * substring search for "agpl" matches innocent identifiers such as
 * `tagPlaceholder` ("t-agpl-aceholder"), which would make the gate cry wolf.
 */
const BANNED_MARKERS = [
  'copied from',
  'mirrored exactly',
  'generated from examples/memory-plugin-shared',
  'buildcontextsearchbody',
]
const BANNED_PATTERNS = [
  { pattern: /\bagpl\b|\bagpl-3\.0\b/i, label: 'AGPL licence text' },
  { pattern: /gnu affero/i, label: 'GNU AFFERO licence text' },
]

/** True when `text` contains a banned marker, returning the marker for the log. */
function findBannedMarker(text) {
  const lowered = text.toLowerCase()
  const marker = BANNED_MARKERS.find((candidate) => lowered.includes(candidate))
  if (marker !== null && marker !== undefined) return marker
  return BANNED_PATTERNS.find((entry) => entry.pattern.test(text))?.label ?? null
}

// ---- 1. source tree -------------------------------------------------------
const srcFiles = walk(join(root, 'src'))
check(srcFiles.length > 20, `scanned the source tree (${srcFiles.length} files)`)
let markerHits = 0
for (const file of srcFiles) {
  const hit = findBannedMarker(readFileSync(file, 'utf8'))
  if (hit !== null) {
    markerHits += 1
    console.log(`[independence]      ${relative(root, file)} contains "${hit}"`)
  }
}
check(markerHits === 0, 'no upstream-provenance marker or AGPL text in src/')

// ---- 2. imports -----------------------------------------------------------
const forbiddenImport = /(?:import|require)\s*(?:\(|\s)[^'"\n]*['"][^'"]*(?:@openviking\/|examples\/memory-plugin-shared)/
let importHits = 0
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8')
  if (forbiddenImport.test(text) || text.includes('examples/memory-plugin-shared')) {
    importHits += 1
    console.log(`[independence]      ${relative(root, file)} imports/cites an upstream implementation path`)
  }
}
check(importHits === 0, 'no import from @openviking/* or the upstream shared example in src/')

// ---- 3. built bundles -----------------------------------------------------
for (const artefact of ['lib/index.js', 'lib/client.js']) {
  const path = join(root, artefact)
  if (!existsSync(path)) {
    console.log(`[independence] note ${artefact} does not exist yet; run pnpm run build to scan it`)
    continue
  }
  const hit = findBannedMarker(readFileSync(path, 'utf8'))
  check(hit === null, hit === null ? `${artefact} carries no upstream marker` : `${artefact} contains "${hit}"`)
}

// ---- 4. committed fixtures ------------------------------------------------
const fixtureDir = join(root, 'test', 'fixtures')
if (existsSync(fixtureDir)) {
  const fixtures = walk(fixtureDir)
  let captured = 0
  for (const file of fixtures) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('"capturedFrom"') || text.includes('"captured_at"')) {
      captured += 1
      console.log(`[independence]      ${relative(root, file)} claims to be a real-server capture`)
    }
  }
  check(captured === 0, `no fixture is a real-server capture (${fixtures.length} fixture files)`)
} else {
  check(false, 'test/fixtures exists (the recall contract matrix lives there)')
}

// ---- 5. provenance record and notices ------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const provenancePath = join(root, 'PROVENANCE.md')
check(existsSync(provenancePath), 'PROVENANCE.md exists')
if (existsSync(provenancePath)) {
  const provenance = readFileSync(provenancePath, 'utf8')
  const rows = provenance.split('\n').filter((line) => /^\|/.test(line))
  // Header + separator are not rows.
  const auditRows = Math.max(0, rows.length - 2)
  check(auditRows >= 8, `PROVENANCE.md records ${auditRows} upstream-coupled behaviours (maintained audit)`)
}

const noticesPath = join(root, 'THIRD_PARTY_NOTICES')
check(existsSync(noticesPath), 'THIRD_PARTY_NOTICES exists')
if (existsSync(noticesPath)) {
  const notices = readFileSync(noticesPath, 'utf8')
  check(
    Array.isArray(pkg.files) && pkg.files.includes('THIRD_PARTY_NOTICES'),
    'THIRD_PARTY_NOTICES is listed in package.json.files, so the tarball carries it',
  )
  check(notices.includes('@deepseek-ai/schemastery'), 'THIRD_PARTY_NOTICES names the bundled @deepseek-ai/schemastery')
  check(notices.includes('@deepseek-ai/cosmokit'), 'THIRD_PARTY_NOTICES names the bundled @deepseek-ai/cosmokit')
  check(notices.includes('MIT License'), 'THIRD_PARTY_NOTICES reproduces the MIT permission notice')
}

console.log(
  failures.length === 0
    ? '[independence] all checks passed'
    : `[independence] ${failures.length} check(s) failed`,
)
if (failures.length > 0) process.exitCode = 1
