// Verify the built browser half without a browser.
//
// The shell loads `lib/client.js` as a lazy-CJS factory registration, so the
// contract this checks is exactly the shell's:
//   1. evaluating the file must call `window.__ModuleLoader__.load({id, factory})`;
//   2. the id must be the package name;
//   3. `factory(require)` must return `{ apply, inject }` with React coming from
//      the provided `require`, never from a bundled copy;
//   4. `apply(ctx)` must register the three slots and must not throw.
//
// Rendering is not exercised here (that needs the real shell); registration is,
// which is where a wrong slot name or a broken wrapper shows up.
//
//   node scripts/smoke-client.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
const require = createRequire(import.meta.url)

let handoff = null
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => (handoff = value) } },
  console,
  // `installStyles()` must no-op outside a document; assert that it does.
  document: undefined,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'lib/client.js' })

const failures = []
const check = (condition, message) => {
  if (condition) console.log(`[client] ok   ${message}`)
  else {
    console.log(`[client] FAIL ${message}`)
    failures.push(message)
  }
}

check(handoff !== null, 'registers a handoff with window.__ModuleLoader__')
check(handoff?.id === pkg.name, `handoff id is the package name (${pkg.name})`)

const exports = typeof handoff?.factory === 'function' ? handoff.factory(require) : {}
check(typeof exports.apply === 'function', 'factory returns apply()')
check(Array.isArray(exports.inject), 'factory returns inject[]')
check(exports.inject?.includes('slots'), 'inject waits for the slots service')
check(!code.includes('react.development'), 'React is not bundled (external)')

// Simulate the shell: `inject(key, cb)` callbacks run once the slot owner
// declares the key, and each `register` records one contribution.
const registrations = []
const injectedKeys = []
const context = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key)
      callback()
      return () => {}
    },
    register(options) {
      registrations.push(options)
      return () => {}
    },
  },
  effect(callback) {
    callback()
    return () => {}
  },
  logger: { warn: console.warn, info: () => {} },
}

let threw = null
try {
  exports.apply(context)
} catch (error) {
  threw = error
}
check(threw === null, `apply() does not throw${threw ? `: ${threw.message}` : ''}`)

const byName = new Map(registrations.map((entry) => [entry.name, entry]))
const dock = registrations.filter((entry) => entry.name === 'conversation.composer.dock')
check(byName.has('sidebar.panellist'), 'registers the left-sidebar row (sidebar.panellist)')
check(byName.has('main'), 'registers the matching centre panel (main)')
check(byName.get('sidebar.panellist')?.id === byName.get('main')?.key, 'panel row id and main key agree')

// One dock entry. It renders two elements (an invisible mirror + the pill)
// whose auto margins and equal widths are what keep the default pills centred
// while the pill sits at the right edge — the CSS owns that, so here we only
// assert the single registration and its session inject face.
check(dock.length === 1, `registers one dock entry (saw ${dock.length})`)
const pill = dock[0]
check(pill?.id === 'openviking-commit', 'dock entry is the commit pill')
check(typeof pill?.inject === 'function', 'status pill declares a session inject face')
check(injectedKeys.length === 3, `all three slots are injected (saw ${injectedKeys.join(', ')})`)

if (failures.length > 0) {
  console.error(`[client] ${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('[client] all checks passed')
}
