// The independence gate's own negative controls (review S6).
//
// The gate exists because the release's heaviest compliance claim is "no AGPL
// code, behaviour re-implemented from the documented contract". A gate whose
// matcher always returned null would make that claim unfalsifiable, and a
// one-off terminal demo is not a test. These cases feed known-bad text through
// the exported matcher and assert it is caught, plus the false-positive case the
// gate already documents (`tagPlaceholder` contains the letters "agpl").
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkIndependence, findBannedMarker } from '../scripts/check-independence.mjs'

const gateScript = fileURLToPath(new URL('../scripts/check-independence.mjs', import.meta.url))

/** Run the gate exactly as the CLI does and return the child result. */
function runGate(argument) {
  return spawnSync(process.execPath, [argument], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
}

test('a copied/mirrored provenance phrase is caught', () => {
  assert.equal(findBannedMarker('// copied from the memory plugin codingQuotas'), 'copied from')
  assert.equal(findBannedMarker('The weights and loop are mirrored exactly.'), 'mirrored exactly')
  assert.equal(findBannedMarker('// GENERATED FROM examples/memory-plugin-shared/lib. DO NOT EDIT.'), 'generated from examples/memory-plugin-shared')
  assert.equal(findBannedMarker('see buildContextSearchBody for the shape'), 'buildcontextsearchbody')
})

test('AGPL licence text is caught as a word, not as a substring of innocent identifiers', () => {
  assert.equal(findBannedMarker('SPDX-License-Identifier: AGPL-3.0'), 'AGPL licence text')
  assert.equal(findBannedMarker('GNU AFFERO GENERAL PUBLIC LICENSE Version 3'), 'GNU AFFERO licence text')
  // The documented false-positive case: `tagPlaceholder` contains "agpl" as a
  // substring but is not a licence mention, so the matcher uses word boundaries.
  assert.equal(findBannedMarker("'write.tagPlaceholder': 'key=value'"), null)
})

test('clean provenance text is not flagged', () => {
  assert.equal(findBannedMarker('The behaviour is derived from the documented request schema.'), null)
  assert.equal(findBannedMarker('Every value below is matched to the shipped right-Sidebar tabs.'), null)
  assert.equal(findBannedMarker('MIT licensed; see THIRD_PARTY_NOTICES.'), null)
  assert.equal(findBannedMarker(''), null)
})

test('the full gate can run in-process and reports its findings as data', () => {
  // Importing the module must not execute the gate (the module is importable);
  // calling it explicitly returns the failure list, which is empty on this tree.
  const failures = checkIndependence()
  assert.deepEqual(failures, [], `the tree must be independent; failing checks: ${failures.join('; ')}`)
})

test('invoking the script really runs the gate (and does not fail open)', () => {
  const direct = runGate(gateScript)
  assert.equal(direct.status, 0, direct.stderr)
  assert.match(direct.stdout, /\[independence\]/, 'the gate prints its check lines')
  assert.match(direct.stdout, /all checks passed/)
})

test(
  'invoking the script through a symlink still runs the gate',
  { skip: process.platform === 'win32' ? 'symlink creation needs privileges on win32' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ove-gate-link-'))
    try {
      const link = join(dir, 'check-independence-link.mjs')
      symlinkSync(gateScript, link)
      const viaLink = runGate(link)
      assert.equal(viaLink.status, 0, viaLink.stderr)
      // The fail-open regression: resolve(argv[1]) != fileURLToPath(import.meta.url)
      // through a symlink made the script run nothing and exit 0.
      assert.match(viaLink.stdout, /\[independence\]/, 'the gate ran through the symlink')
      assert.match(viaLink.stdout, /all checks passed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
