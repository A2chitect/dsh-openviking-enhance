// Verify the built browser half without a browser.
//
// The shell loads `lib/client.js` as a lazy-CJS factory registration, so the
// contract this checks is exactly the shell's:
//   1. evaluating the file must call `window.__ModuleLoader__.load({id, factory})`;
//   2. the id must be the package name;
//   3. `factory(require)` must return `{ apply, inject }` with React coming from
//      the provided `require`, never from a bundled copy;
//   4. `apply(ctx)` must register the four slots and the right-Sidebar tab type,
//      and must not throw.
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
// Minimal document stub: enough for `installStyles()` to run and hand us the
// text it would inject, which is how the style-parity checks below are made.
let injectedCss = null
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: {
    append(node) {
      injectedCss = node.textContent
    },
  },
}
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => (handoff = value) } },
  console,
  document: fakeDocument,
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
/** Right-Sidebar tab types, as the registry's own `register` would receive them. */
const tabTypes = []
/** Services the plugin waited for, as `ctx.inject([...])` names them. */
const awaited = []
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
  inject(deps, callback) {
    awaited.push(deps.join(','))
    callback({
      get(name) {
        if (name !== 'sidebarRightTabs') return undefined
        return {
          register(definition) {
            tabTypes.push(definition)
            return () => {}
          },
        }
      },
    })
    return { dispose() {} }
  },
  get() {
    return undefined
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
// The sidebar sorts rows by `order` and breaks ties by registration order, which
// varies per boot — a shared order is what made this row drift between startups.
// Every row shipped today is <= 30.
check(
  (byName.get('sidebar.panellist')?.order ?? 0) > 100,
  `sidebar row sorts after every shipped row (order ${byName.get('sidebar.panellist')?.order})`,
)

// One dock entry. It renders two elements (an invisible mirror + the pill)
// whose auto margins and equal widths are what keep the default pills centred
// while the pill sits at the right edge — the CSS owns that, so here we only
// assert the single registration and its session inject face.
check(dock.length === 1, `registers one dock entry (saw ${dock.length})`)
const pill = dock[0]
check(pill?.id === 'openviking-commit', 'dock entry is the commit pill')
check(typeof pill?.inject === 'function', 'status pill declares a session inject face')
check(injectedKeys.length === 4, `all four slots are injected (saw ${injectedKeys.join(', ')})`)

// The right Sidebar tab. Registration is two-stage and the stages must agree: the
// registry keys the body seat by the type's `id`, so a body registered under
// anything else renders the framework's "nothing can view this" notice.
check(awaited.includes('sidebarRightTabs'), 'waits for the tab registry (a service), not the slot declaration')
check(tabTypes.length === 1, `registers one right-Sidebar tab type (saw ${tabTypes.length})`)
const tabType = tabTypes[0]
check(
  typeof tabType?.id === 'string' && tabType.id.includes(':'),
  `tab id is namespaced, since the registry's key domain is open (${tabType?.id})`,
)
check(tabType?.kind === 'openviking-recall', `tab kind is namespaced (${tabType?.kind})`)
check(typeof tabType?.title === 'function' && tabType.title('').length > 0, 'the tab type names its chip')
check(
  Array.isArray(tabType?.guide) && tabType.guide.length === 1,
  'the tab carries a guide entry, which is the only way a user can open it',
)
const tabBody = registrations.find((entry) => entry.name === 'sidebar.right.pane.tab')
check(tabBody?.key === tabType?.id, 'the tab body is keyed by the type id')
check(typeof tabBody?.inject === 'function', 'the tab body declares a session inject face')
check(tabBody?.inject('session-x')?.sessionId === 'session-x', 'the tab body receives the session it was opened in')
check(code.includes('/recall'), 'the panel requests the host recall route')
check(injectedCss?.includes('.ove-recall'), 'installs the recall panel stylesheet')

// Style parity with the shell's own stats pills is the whole point of the pill's
// CSS, and a template-literal slip silently ships invalid declarations, so assert
// the resolved text rather than trusting a visual check.
check(typeof injectedCss === 'string' && injectedCss.length > 500, 'installs its stylesheet')
check(!injectedCss.includes('${'), 'stylesheet has no unresolved template expression')
check(
  injectedCss.includes('font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)'),
  'pill font size matches StatsPills.module.css',
)
check(
  injectedCss.includes('line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))'),
  'pill line height matches StatsPills.module.css',
)
check(injectedCss.includes('color: var(--dsw-alias-label-tertiary)'), 'pill label colour matches')
check(
  injectedCss.includes('background: var(--dsw-alias-interactive-bg-hover)'),
  'pill hover background matches',
)
check(injectedCss.includes('border-radius: 999px'), 'pill capsule shape matches')
check(
  injectedCss.includes('.ove-pill svg { flex: none; width: 14px; height: 14px; }'),
  'pill icon box matches the default pills (14x14)',
)
check(
  injectedCss.includes("font-variant-numeric: tabular-nums"),
  'pill figures are tabular like the default pills',
)

// One glyph, two mounts: the sidebar row and the pill must not drift apart, and
// the mark must stay self-contained (no cross-package icon lookup).
check(
  code.split('M6.5 6.5 9.5 9.5').length - 1 === 1,
  'the OpenViking mark is defined once and shared by both mounts',
)
check(!code.includes('dsh-client-ui-primitives'), 'no cross-package icon dependency')

// The failed-extraction state is the one thing nothing else in the system shows.
check(
  injectedCss.includes('.ove-pill-errored { color: var(--dsw-alias-state-warn-primary'),
  'the pill has a warning state for a failed extraction',
)
check(injectedCss.includes('.ove-failure'), 'the popover has a failure block')
check(injectedCss.includes('.ove-timeline'), 'the commit records render as a timeline')

if (failures.length > 0) {
  console.error(`[client] ${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('[client] all checks passed')
}
