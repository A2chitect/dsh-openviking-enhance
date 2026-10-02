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

// Record what the factory asks for: the bundle's real dependencies, as opposed to
// whatever package names its comments happen to mention.
const required = []
const exports =
  typeof handoff?.factory === 'function'
    ? handoff.factory((id) => {
        required.push(id)
        return require(id)
      })
    : {}
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

// Cordis refuses an UNDECLARED service property: reading one throws
// `cannot get property "x" without inject`. That is exactly how this half shipped
// broken — one `ctx.locale` read threw, and because it happened before the
// registrations, the sidebar row, the commit pill and the recall tab all vanished
// while the host half stayed green. A plain object cannot catch that: it answers
// `undefined` to anything. So the stand-in enforces the same rule, and only what
// the entry actually injects, the optional `get()` accessor and the context's own
// verbs are readable.
const declared = new Set(['slots', 'effect', 'inject', 'get', 'logger'])
const strictContext = new Proxy(context, {
  get(target, key) {
    if (typeof key === 'symbol') return Reflect.get(target, key)
    const value = Reflect.get(target, key)
    if (value === undefined && !declared.has(key)) {
      throw new Error(`cannot get property "${key}" without inject`)
    }
    return value
  },
})

let threw = null
try {
  exports.apply(strictContext)
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
check(injectedKeys.length === 5, `all five slots are injected (saw ${injectedKeys.join(', ')})`)

// The configuration form. DSH renders no form for a plugin's Config on its own:
// the Plugins page grows a Configure control only because this seat is taken, and
// it keys the seat by the manifest's package name — which the browser half cannot
// read, so it is written out and pinned here instead.
const configRow = registrations.find((entry) => entry.name === 'plugins.row.config')
check(configRow !== undefined, 'registers the row configuration form (plugins.row.config)')
check(
  configRow?.key === `${pkg.name}#openviking-enhance`,
  `the config seat is keyed by package name and row id (${configRow?.key})`,
)

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
// Both dictionaries must ship: the copy follows the app's language, and a build
// that dropped one would leave half the interface in the other. esbuild escapes
// non-ASCII by default (its `charset` is `ascii`), so the bundle is decoded before
// looking for the Chinese.
const decoded = code.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
check(
  decoded.includes('记忆召回') && decoded.includes('Memory recall'),
  'both languages ship in the bundle',
)
// The locale half is a manifest dependency, not a Cordis service this plugin
// waits for: a composition without it must still run the plugin (its copy then
// falls back to the browser language), so the dependency is declared here and
// read opportunistically at runtime.
check(
  (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-locale'),
  'the manifest depends on the locale package',
)
check(injectedCss?.includes('.ove-recall'), 'installs the recall panel stylesheet')

// The recall panel is styled from the shipped right-Sidebar tabs rather than from
// taste, and each check below pins one of those copied declarations. The source is
// named per check: .header/.body/.row are the files tab's rules in
// `@deepseek-ai/dsh-client-ui-sidebar-files`, the field is the primitives package's
// `Input.module.css`, and the group header is `SearchBlock.module.css`.
check(
  injectedCss.includes('height: 38px; padding: 0 6px 0 8px;'),
  'recall header uses the files tab header height (38px)',
)
check(
  injectedCss.includes('border-bottom: .5px solid var(--dsw-alias-border-l3)'),
  'recall header has the files tab hairline, not a card edge',
)
// The pane clips a tab body (`overflow:hidden` on .tabBody), so a body that does
// not scroll itself is a list the user cannot reach the end of.
check(
  injectedCss.includes('flex: auto; min-height: 0; overflow: auto; scrollbar-gutter: stable;'),
  'recall body is the scroller, like the files tab body',
)
check(
  injectedCss.includes('padding: 6px 10px;') && injectedCss.includes('border-radius: var(--dsw-radius-md)'),
  'recall rows sit inside a card at the shipped row metrics',
)
// Every entry is outlined, and its score is graded by colour.
check(
  injectedCss.includes('border: .5px solid var(--dsw-alias-border-l3)'),
  'each recall entry carries the shipped card border',
)
for (const [tone, token] of [
  ['high', '--dsw-alias-state-success-primary'],
  ['mid', '--dsw-alias-state-warn-primary'],
  ['low', '--dsw-alias-state-error-primary'],
]) {
  check(
    injectedCss.includes(`.ove-recall-score-${tone} { color: var(${token}`),
    `the ${tone} score band uses the app's own ${token.replace('--dsw-alias-', '')} state colour`,
  )
}
// A flex ROW here put the abstract and the tags on the title's own line, which
// pushed the score to the middle of a multi-line item. The row is a block whose
// first child is the flex line; pin both halves.
check(
  injectedCss.includes('display: block; width: 100%; min-width: 0;'),
  'recall row is a block, so its second line starts under the title',
)
check(
  injectedCss.includes('.ove-recall-line { display: flex; align-items: center; gap: 6px; min-width: 0; }'),
  'exactly one line of a row is a flex line (title, score, caret)',
)
check(
  injectedCss.includes('border: .5px solid var(--dsw-alias-border-l4)'),
  'the query field uses the shipped Input border token',
)
check(
  injectedCss.includes('border-color: var(--dsw-alias-state-business-primary)'),
  'the query field focuses like the shipped Input',
)
// An entry body sits on the app's text-block surface. bg-layer-1 is the page's own
// colour, so the block was invisible against it in the light theme.
check(
  injectedCss.includes('background: var(--dsw-alias-markdown-code-block)'),
  'an opened entry reads as a text block, not as page background',
)

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
// The mark must stay self-contained: the only thing the bundle may pull from the
// module table is React. Asserted on the require calls the factory actually makes
// rather than on the bundle's text, so a comment naming a package cannot trip it.
check(
  !required.some((id) => id.startsWith('@deepseek-ai/dsh-client-ui-')),
  `no cross-package icon dependency (required: ${required.join(', ') || 'nothing'})`,
)

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
