// Build both faces of the bundle with esbuild.
//
// Host half  -> lib/index.js   ESM for Node; every @deepseek-ai/* import stays
//                               external because the profile provides it.
// Client half -> lib/client.js The DSH web shell serves exactly this file at
//                               /plugins/<id>/client.js and executes it as a
//                               lazy-CJS factory registration:
//
//                                 window.__ModuleLoader__.load({
//                                   id: "<package name>",
//                                   factory: (require) => { ... return module.exports }
//                                 })
//
//                               React and the other platform modules are NOT
//                               bundled: the shell seeds a frozen module table
//                               and the factory receives `require` from it.
//                               Bundling React would give the plugin a second
//                               copy of it and break hooks.
import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')

/** Modules the web shell seeds into its frozen table (see dsh-client-modules). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** The lazy-CJS registration wrapper every shipped client bundle uses. */
function loaderWrapper() {
  return {
    banner: {
      js: [
        'window.__ModuleLoader__.load({',
        `\tid: ${JSON.stringify(pkg.name)},`,
        '\tfactory: (require) => {',
        '\t\tvar module = { exports: {} };',
        '\t\tvar exports = module.exports;',
      ].join('\n'),
    },
    footer: { js: ['\t\treturn module.exports;', '\t}', '});'].join('\n') },
  }
}

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: [join(root, 'src/host/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // The profile owns these; bundling them would duplicate the loader's own
  // service classes and break `instanceof` checks across the plugin boundary.
  external: ['@deepseek-ai/*'],
}

/** @type {import('esbuild').BuildOptions} */
const client = {
  entryPoints: [join(root, 'src/client/index.tsx')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  external: PLATFORM_MODULES,
  ...loaderWrapper(),
}

if (watch) {
  const contexts = await Promise.all([context(host), context(client)])
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[build] watching src/host and src/client')
} else {
  await Promise.all([build(host), build(client)])
  console.log(`[build] lib/index.js + lib/client.js ready for ${pkg.name}`)
}
