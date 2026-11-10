// Read what a packed npm tarball actually declares, without installing it.
//
// `verify-install` promises that the installed package is *the tarball being
// verified*. Asserting only "a version was installed" leaves a hole: a cached
// profile entry, a registry fallback or a stale local spec would still pass, and
// the release-gating claim in VERIFICATION.md would be unearned. This module
// reads `package/package.json` out of the `.tgz` the way npm lays it out (a gzip
// stream over a ustar archive) with Node builtins only, so the comparison has no
// dependency, no extraction to a temp directory and no way to follow a registry.
//
// The parser is deliberately small but not naive: it walks 512-byte headers,
// honours the octal size, skips `pax`/GNU extension entries, and joins the ustar
// `prefix` field for long names. A truncated or non-gzip file throws, which the
// caller turns into a failed step rather than a silent `null`.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const BLOCK = 512

/** One NUL-terminated string field from a header block. */
function headerField(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim()
}

/** Parse an octal (or base-256) size field. */
function headerSize(block) {
  const raw = block.subarray(124, 136)
  // GNU base-256 encoding for very large entries: high bit of the first byte set.
  if ((raw[0] & 0x80) !== 0) {
    let value = 0
    for (const byte of raw) value = value * 256 + byte
    return value
  }
  const text = headerField(block, 124, 11)
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** One entry name from a header block, joining the ustar prefix when present. */
function entryName(block, pendingLongName) {
  if (pendingLongName !== null) return pendingLongName
  const name = headerField(block, 0, 100)
  const prefix = headerField(block, 345, 155)
  if (prefix.length === 0) return name
  // POSIX ustar stores the prefix without its trailing slash.
  return `${prefix}/${name}`
}

/** Decompress (if needed) and walk a tar buffer into `name -> bytes`. */
function readTar(buffer) {
  let tar = buffer
  if (tar.length > 2 && tar[0] === 0x1f && tar[1] === 0x8b) tar = gunzipSync(tar)
  const entries = new Map()
  let offset = 0
  let pendingLongName = null
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    // An all-zero block is the archive terminator.
    if (block.every((byte) => byte === 0)) break
    const typeflag = String.fromCharCode(block[156] ?? 0)
    const size = headerSize(block)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('truncated tar entry: the archive ends inside a file body')
    if (typeflag === 'L') {
      // GNU long name: the next header's name.
      pendingLongName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '')
    } else if (typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'K') {
      entries.set(entryName(block, pendingLongName), tar.subarray(dataStart, dataEnd))
      pendingLongName = null
    } else {
      pendingLongName = null
    }
    offset = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK)
  }
  return entries
}

/** The whole archive as `name -> text`, or a Map when the file cannot be read. */
export function readTarballEntries(tarballPath) {
  return readTar(readFileSync(tarballPath))
}

/** One named entry's text, or null when the tarball does not carry it. */
export function readTarballEntry(tarballPath, name) {
  const entry = readTarballEntries(tarballPath).get(name)
  return entry === undefined ? null : entry.toString('utf8')
}

/**
 * The `package/package.json` manifest a packed tarball declares.
 *
 * @returns `{name, version}` when the entry parses as a package manifest, else
 * null. Throws only when the archive itself is unreadable.
 */
export function readTarballManifest(tarballPath, entryName = 'package/package.json') {
  const text = readTarballEntry(tarballPath, entryName)
  if (text === null) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
  }
}

/** The declared package version inside a packed tarball, or null. */
export function readTarballVersion(tarballPath) {
  return readTarballManifest(tarballPath)?.version ?? null
}
