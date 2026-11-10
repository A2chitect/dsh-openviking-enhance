// The packed-tarball reader behind the install verification's trust claim.
//
// `verify-install` must compare what it installed against what the tarball
// declares (review B1). That comparison only means something if the reader
// actually reads the archive a user downloads: these tests build synthetic
// `.tgz` files (a gzip stream over ustar blocks, exactly npm's layout) and pin
// the parser's behaviour, then assert the verification script still wires the
// comparison in rather than regressing to "a version was installed".
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { readTarballEntry, readTarballManifest, readTarballVersion } from '../scripts/tarball-meta.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ove-tarball-meta-'))

/**
 * One ustar header block.
 *
 * `base256` encodes the size with GNU's base-256 extension (high bit of the
 * first byte is the marker) so the parser's large-entry branch is exercised.
 */
function tarHeader(name, size, { base256 = false } = {}) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  if (base256) {
    const field = Buffer.alloc(12)
    field[0] = 0x80
    let remaining = size
    for (let index = 11; index >= 1; index -= 1) {
      field[index] = remaining % 256
      remaining = Math.floor(remaining / 256)
    }
    field.copy(block, 124)
  } else {
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  }
  block.write('00000000000\0', 136)
  block.write('        ', 148) // checksum placeholder, spaces while summing
  block.write('0', 156) // regular file
  block.write('ustar\0', 257)
  block.write('00', 263)
  let checksum = 0
  for (const byte of block) checksum += byte
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

/** A tiny npm-shaped tarball: `name -> utf8 content` (or `{content, base256}`). */
function makeTarball(entries, { gzip = true } = {}) {
  const chunks = []
  for (const [name, spec] of Object.entries(entries)) {
    const content = typeof spec === 'string' ? spec : spec.content
    const base256 = typeof spec === 'object' && spec !== null && spec.base256 === true
    const data = Buffer.from(content, 'utf8')
    chunks.push(tarHeader(name, data.length, { base256 }), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024)) // archive terminator
  const tar = Buffer.concat(chunks)
  return gzip ? gzipSync(tar) : tar
}

function writeTarball(name, entries, options) {
  const path = join(dir, name)
  writeFileSync(path, makeTarball(entries, options))
  return path
}

test('the packed version is read from package/package.json, not guessed', () => {
  const tarball = writeTarball('versioned.tgz', {
    'package/package.json': JSON.stringify({ name: 'dsh-openviking-enhance', version: '1.2.3' }),
    'package/lib/index.js': 'export {}\n',
    'package/README.md': '# fixture\n',
  })
  assert.deepEqual(readTarballManifest(tarball), { name: 'dsh-openviking-enhance', version: '1.2.3' })
  assert.equal(readTarballVersion(tarball), '1.2.3')
  assert.equal(readTarballEntry(tarball, 'package/lib/index.js'), 'export {}\n')
})

test('a GNU base-256 size field is decoded without the marker bit', () => {
  // If the marker byte were folded into the value the parser would compute a
  // gigantic size and fail the archive-end check; a correct read proves the math.
  const tarball = writeTarball('base256.tgz', {
    'package/package.json': {
      content: JSON.stringify({ name: 'dsh-openviking-enhance', version: '2.0.0' }),
      base256: true,
    },
    'package/lib/index.js': 'export {}\n',
  })
  assert.deepEqual(readTarballManifest(tarball), { name: 'dsh-openviking-enhance', version: '2.0.0' })
  assert.equal(readTarballVersion(tarball), '2.0.0')
})

test('an uncompressed tar and a gzip tar produce the same answer', () => {
  const entries = { 'package/package.json': JSON.stringify({ name: 'x', version: '0.0.1' }) }
  assert.equal(readTarballVersion(writeTarball('plain.tar', entries, { gzip: false })), '0.0.1')
  assert.equal(readTarballVersion(writeTarball('packed.tgz', entries)), '0.0.1')
})

test('a tarball without package/package.json yields null, never a guess', () => {
  const tarball = writeTarball('missing-manifest.tgz', { 'package/lib/index.js': 'export {}\n' })
  assert.equal(readTarballManifest(tarball), null)
  assert.equal(readTarballVersion(tarball), null)
})

test('a malformed or non-object manifest yields null', () => {
  assert.equal(
    readTarballVersion(writeTarball('broken-json.tgz', { 'package/package.json': '{ not json' })),
    null,
  )
  assert.equal(
    readTarballVersion(writeTarball('array-json.tgz', { 'package/package.json': '[]' })),
    null,
  )
  assert.equal(
    readTarballVersion(writeTarball('no-version.tgz', { 'package/package.json': '{"name":"x"}' })),
    null,
  )
})

test('a corrupt gzip archive throws instead of reporting a version', () => {
  const path = join(dir, 'corrupt.tgz')
  writeFileSync(path, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from('garbage')]))
  assert.throws(() => readTarballVersion(path))
})

test('verify-install compares the installed version against the packed one (B1)', () => {
  // Guard the regression the review found: the step used to assert only that a
  // version was installed. The script must read the packed manifest and compare.
  const source = readFileSync(new URL('../scripts/verify-install.mjs', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/tarball-meta\.mjs'/, 'the verification script uses the tarball reader')
  assert.match(source, /readTarballManifest\(tarball\)/, 'it reads the manifest out of the packed tarball')
  assert.match(source, /version === packedVersion/, 'it compares the installed version against the packed version')
  assert.match(source, /reinstalledVersion === packedVersion/, 'the reinstall leg compares against the packed version too')
  assert.match(source, /tarballVersion: packedVersion/, 'the machine-readable summary records both versions')
  assert.doesNotMatch(
    source,
    /step\('the installed package version is the tarball version', version !== null/,
    'the old non-null-only assertion is gone',
  )
})
