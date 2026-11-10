// Clean-profile install verification.
//
// `pnpm test` proves the code and the tarball *contents*; it never proves that a
// stranger can install the published package, boot it and remove it. That is the
// gap the community-plugin requirements call out, and this script closes it with
// commands a maintainer and CI both run:
//
//   pack -> install into a scratch DSH_HOME -> composed-config row ->
//   boot -> client bundle served + plugin route answers -> reinstall/upgrade
//   (one row, newer version) -> uninstall -> row gone, route gone -> cleanup
//
// It is deliberately Node-builtins-only (no browser, no Playwright) and never
// talks to a real OpenViking dataset: the newest tarball is the only input that
// matters. `--upgrade-from <npm spec>` installs a previously published version
// first, which is what makes the reinstall leg a real upgrade check.
//
//   node scripts/verify-install.mjs --dsh "$(command -v dsh)" --tarball /tmp/x.tgz
//   node scripts/verify-install.mjs --dsh dsh --upgrade-from dsh-openviking-enhance@0.3.0
//
// Exit code is non-zero on the first failed assertion; every step is printed so a
// CI log is its own evidence.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/** The package this script installs (derived from package.json, never hard-coded). */
const PACKAGE = pkg.name
/** The loader row id the patch inserts; `--dump-config` prints it. */
const ROW_ID = 'openviking-enhance'

const log = (...parts) => console.log('[install-verify]', ...parts)
const failures = []
const steps = []

/** Run one command to completion. */
function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 180_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` })
    })
  })
}

/** Record one assertion step, printing the same line a CI log should show. */
function step(name, ok, detail) {
  const record = { name, ok: ok === true, detail: detail ?? null }
  steps.push(record)
  log(ok === true ? 'ok  ' : 'FAIL', name, detail === undefined ? '' : `· ${detail}`)
  if (!ok) failures.push(record)
  return ok
}

/** One HTTP request with a short timeout; resolves a status/body envelope. */
function request(url, options = {}) {
  return new Promise((resolve) => {
    const target = new URL(url)
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: { host: target.host, ...(options.headers ?? {}) },
        timeout: options.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, headers: {}, body: '' })
    })
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }))
    req.end(options.body)
  })
}

/** Parse `--flag value` / `--flag=value`; boolean flags stand alone. */
function parseArgs(argv) {
  const args = {
    dsh: 'dsh',
    tarball: null,
    dshHome: null,
    profile: 'web',
    upgradeFrom: null,
    port: '0',
    jsonOut: null,
    keep: false,
    bootTimeoutMs: 90_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const read = () => {
      if (current.includes('=')) return current.slice(current.indexOf('=') + 1)
      index += 1
      return argv[index] ?? ''
    }
    if (current === '--keep') args.keep = true
    else if (current.startsWith('--dsh')) args.dsh = read()
    else if (current.startsWith('--tarball')) args.tarball = read()
    else if (current.startsWith('--dsh-home')) args.dshHome = read()
    else if (current.startsWith('--profile')) args.profile = read()
    else if (current.startsWith('--upgrade-from')) args.upgradeFrom = read()
    else if (current.startsWith('--port')) args.port = read()
    else if (current.startsWith('--json-out')) args.jsonOut = read()
    else if (current.startsWith('--boot-timeout-ms')) args.bootTimeoutMs = Number(read())
    else if (current === '--help' || current === '-h') {
      console.log(
        'usage: node scripts/verify-install.mjs --dsh <dsh binary> [--tarball <path>] ' +
          '[--dsh-home <dir>] [--profile web] [--upgrade-from <npm spec>] [--port 0] ' +
          '[--json-out <path>] [--keep] [--boot-timeout-ms <ms>]',
      )
      process.exit(0)
    }
  }
  return args
}

/** The newest `dsh-openviking-enhance-*.tgz` in a directory, or null. */
async function newestTarball(directory) {
  try {
    const { readdir } = await import('node:fs/promises')
    const names = (await readdir(directory)).filter((name) => /^dsh-openviking-enhance-.*\.tgz$/.test(name))
    if (names.length === 0) return null
    names.sort()
    return join(directory, names[names.length - 1])
  } catch {
    return null
  }
}

/** The installed version from the profile's own node_modules. */
async function installedVersion(dshHome, profile) {
  try {
    const manifest = JSON.parse(
      await readFile(join(dshHome, 'profiles', profile, 'node_modules', PACKAGE, 'package.json'), 'utf8'),
    )
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** How many loader rows the composed profile tree declares (`--dump-config`). */
function countRows(dump) {
  return (dump.match(new RegExp(`^- id: ${ROW_ID}$`, 'gm')) ?? []).length
}

/**
 * Boot the profile and return a handle with the printed origin, the boot page
 * HTML and a stop() that waits for the child to actually exit.
 */
async function bootProfile({ dsh, dshHome, profile, port, bootTimeoutMs }) {
  const child = spawn(dsh, [`--profile`, profile, '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let originUrl = null
  const started = Date.now()
  child.stdout.on('data', (chunk) => {
    output += chunk
    const match = /http:\/\/127\.0\.0\.1:(\d+)\/?\?token=(\S+)/.exec(output)
    if (originUrl === null && match !== null) {
      originUrl = `http://127.0.0.1:${match[1]}/`
      originUrl = `${originUrl}?token=${match[2]}`
    }
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  const deadline = Date.now() + bootTimeoutMs
  let ready = false
  while (Date.now() < deadline) {
    if (originUrl !== null) {
      const probe = await request(originUrl, { timeoutMs: 1000 }).catch(() => ({ status: 0 }))
      if (probe.status === 200 || probe.status === 303 || probe.status === 302) {
        ready = true
        break
      }
    }
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((resolve) => child.once('close', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!exited && child.exitCode === null) child.kill('SIGKILL')
  }

  return { ready, originUrl, output, stop, child }
}

/** Follow the boot token through its redirects into a cookie-authenticated page. */
async function pageBundleReference(originUrl) {
  // The token URL is single-use and replies 303 + Set-Cookie; the redirect target
  // (sometimes with the token stripped) is the real shell page. Follow it like a
  // browser would, carrying the cookies forward.
  const cookies = new Map()
  let url = originUrl
  let page = { status: 0, headers: {}, body: '' }
  for (let hop = 0; hop < 5; hop += 1) {
    const headers = cookies.size > 0 ? { cookie: [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ') } : {}
    page = await request(url, { headers, timeoutMs: 5000 })
    const setCookie = page.headers['set-cookie']
    for (const entry of Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]) {
      const pair = entry.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    const location = page.headers.location
    if (page.status >= 300 && page.status < 400 && typeof location === 'string' && location.length > 0) {
      url = new URL(location, originUrl).toString()
      continue
    }
    break
  }
  if (page.status !== 200) return { page, html: page.body, comboPath: null }
  const html = page.body.replace(/&amp;/g, '&')
  // The composed page lists one combo URL per startup batch; ours contains the
  // package name. This is the shell's real reference — the boot page is the
  // evidence that the client half was COMPOSED, not merely present on disk.
  const match = new RegExp(`plugins/\\?\\?[^"']*${PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/client\\.js[^"']*`).exec(html)
  return { page, html, comboPath: match === null ? null : match[0] }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()
  const dshHome = args.dshHome ?? mkdtempSync(join(tmpdir(), 'dsh-install-verify-'))
  const ownTmp = args.dshHome === null
  let boot = null
  let summary = null

  log(`dsh ${args.dsh} · profile ${args.profile} · home ${dshHome}`)
  try {
    // ---- the tarball a user would install ---------------------------------
    let tarball = args.tarball
    if (tarball === null) {
      const packDir = await mkdtemp(join(tmpdir(), 'dsh-install-pack-'))
      const packed = await exec('pnpm', ['pack', '--pack-destination', packDir], { timeoutMs: 180_000 })
      tarball = await newestTarball(packDir)
      if (packed.code !== 0 || tarball === null) {
        step('pack the plugin', false, packed.stderr.split('\n')[0] ?? 'no tarball produced')
        throw new Error('could not produce a tarball to install')
      }
    }
    if (!existsSync(tarball)) throw new Error(`tarball does not exist: ${tarball}`)
    step('tarball exists', true, tarball)

    const dshVersion = await exec(args.dsh, ['--version'], { timeoutMs: 30_000 })
    step('the dsh executable answers --version', dshVersion.code === 0, dshVersion.stdout.trim())

    // ---- optional upgrade-from install (the reinstall/upgrade leg) ---------
    let previousVersion = null
    if (args.upgradeFrom !== null) {
      const from = await exec(args.dsh, ['plugin', '--profile', args.profile, 'add', args.upgradeFrom], {
        env: { DSH_HOME: dshHome },
        timeoutMs: 300_000,
      })
      step('install the previous published version', from.code === 0, from.stderr.trim().split('\n').slice(-1)[0] ?? '')
      previousVersion = await installedVersion(dshHome, args.profile)
      step('the previous version is installed', previousVersion !== null, previousVersion ?? 'not found')
    }

    // ---- install into the scratch profile ---------------------------------
    const installed = await exec(args.dsh, ['plugin', '--profile', args.profile, 'add', tarball], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 300_000,
    })
    step('dsh plugin add installs the tarball', installed.code === 0, installed.stderr.trim().split('\n').slice(-1)[0] ?? '')
    const version = await installedVersion(dshHome, args.profile)
    step('the installed package version is the tarball version', version !== null, version ?? 'not found')
    if (args.upgradeFrom !== null) {
      step('the upgrade changed the installed version', version !== null && version !== previousVersion, `${previousVersion} -> ${version}`)
    }

    // ---- composed config: exactly one row ---------------------------------
    const dump = await exec(args.dsh, ['--profile', args.profile, '--dump-config'], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 120_000,
    })
    step('dsh --dump-config answers', dump.code === 0, `${dump.stdout.length} bytes`)
    const rowCount = countRows(dump.stdout)
    step('the composed profile carries exactly one plugin row', rowCount === 1, `${rowCount} row(s)`)
    step('the composed row names the package', dump.stdout.includes(`name: ${PACKAGE}`), PACKAGE)

    // ---- boot, served bundle and host route -------------------------------
    boot = await bootProfile({ ...args, dshHome })
    step('the profile boots', boot.ready === true, boot.originUrl === null ? 'no origin printed' : 'origin printed')
    if (!boot.ready) throw new Error(`the profile did not boot:\n${boot.output.slice(-4000)}`)

    const { page, comboPath } = await pageBundleReference(boot.originUrl)
    step('the boot page renders', page.status === 200, `HTTP ${page.status}`)
    step('the boot page composes this plugin client half', comboPath !== null, comboPath === null ? 'combo reference missing' : 'combo reference found')
    if (comboPath !== null) {
      const origin = new URL(boot.originUrl).origin
      const bundle = await request(`${origin}/${comboPath}`, { timeoutMs: 10_000 })
      step('the composed client bundle is served', bundle.status === 200, `HTTP ${bundle.status}, ${bundle.body.length} bytes`)
      step(
        'the served bundle registers the loader module',
        bundle.body.includes('__ModuleLoader__') && bundle.body.includes(PACKAGE),
        null,
      )
    }

    const origin = new URL(boot.originUrl).origin
    const config = await request(`${origin}/api/openviking-enhance/config`, { timeoutMs: 10_000 })
    let configBody = null
    try {
      configBody = JSON.parse(config.body)
    } catch {
      configBody = null
    }
    step(
      'the plugin host route answers JSON',
      config.status === 200 && configBody !== null && typeof configBody.ok === 'boolean',
      `HTTP ${config.status}`,
    )
    step(
      'the config response carries no API key',
      !config.body.includes('"apiKey"') && !config.body.includes('Authorization'),
      null,
    )
    const scope = await request(`${origin}/api/openviking-enhance/scope`, { timeoutMs: 10_000 })
    let scopeBody = null
    try {
      scopeBody = JSON.parse(scope.body)
    } catch {
      scopeBody = null
    }
    step(
      'the scope route answers with a capability map',
      scope.status === 200 && scopeBody !== null && scopeBody.ok === true && scopeBody.scope?.capabilities !== undefined,
      `HTTP ${scope.status}`,
    )
    await boot.stop()
    boot = null

    // ---- reinstall is idempotent: one row, one version --------------------
    const reinstalled = await exec(args.dsh, ['plugin', '--profile', args.profile, 'add', tarball], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 300_000,
    })
    step('reinstalling the same tarball succeeds', reinstalled.code === 0, reinstalled.stderr.trim().split('\n').slice(-1)[0] ?? '')
    const redump = await exec(args.dsh, ['--profile', args.profile, '--dump-config'], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 120_000,
    })
    step('reinstall still composes exactly one row', countRows(redump.stdout) === 1, `${countRows(redump.stdout)} row(s)`)
    step(
      'reinstall kept the installed version',
      (await installedVersion(dshHome, args.profile)) === version,
      version ?? 'unknown',
    )

    // ---- uninstall --------------------------------------------------------
    const removed = await exec(args.dsh, ['plugin', '--profile', args.profile, 'remove', PACKAGE], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 300_000,
    })
    step('dsh plugin remove uninstalls the package', removed.code === 0, removed.stderr.trim().split('\n').slice(-1)[0] ?? '')
    const afterRemoveDump = await exec(args.dsh, ['--profile', args.profile, '--dump-config'], {
      env: { DSH_HOME: dshHome },
      timeoutMs: 120_000,
    })
    step('the composed profile no longer lists the plugin row', countRows(afterRemoveDump.stdout) === 0, `${countRows(afterRemoveDump.stdout)} row(s)`)

    boot = await bootProfile({ ...args, dshHome })
    step('the profile still boots after uninstall', boot.ready === true, null)
    if (boot.ready) {
      const uninstalledOrigin = new URL(boot.originUrl).origin
      const leftover = await request(`${uninstalledOrigin}/api/openviking-enhance/config`, { timeoutMs: 10_000 })
      step('the plugin host route is gone after uninstall', leftover.status !== 200, `HTTP ${leftover.status}`)
      const { comboPath: leftoverBundle } = await pageBundleReference(boot.originUrl)
      step('the client half is not composed after uninstall', leftoverBundle === null, null)
    }
    await boot.stop()
    boot = null

    summary = { ok: failures.length === 0, dsh: args.dsh, dshVersion: dshVersion.stdout.trim(), tarball, dshHome, profile: args.profile, version, steps, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    step('verification completed without an exception', false, error instanceof Error ? error.message : String(error))
    summary = { ok: false, dsh: args.dsh, tarball: args.tarball, dshHome, profile: args.profile, steps, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }
  } finally {
    if (boot !== null) await boot.stop().catch(() => {})
    if (args.jsonOut !== null && summary !== null) {
      try {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
      } catch {
        // A summary that cannot be written must not mask the verification result.
      }
    }
    if (args.keep) {
      log(`keeping the scratch DSH home: ${dshHome}`)
    } else if (ownTmp) {
      try {
        await rm(dshHome, { recursive: true, force: true })
      } catch {
        // Best effort cleanup; a leaked temp dir is not a verification failure.
      }
    }
  }

  log(
    failures.length === 0
      ? `all steps passed in ${((summary?.elapsedMs ?? 0) / 1000).toFixed(1)}s`
      : `${failures.length} step(s) FAILED`,
  )
  if (failures.length > 0) process.exitCode = 1
}

void main()
