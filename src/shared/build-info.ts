/**
 * The running bundle's own identity.
 *
 * `PLUGIN_VERSION` is injected by `build.mjs` with esbuild's `define`: the same
 * package version the manifest declares, embedded at build time so the host half
 * can report it without reading `package.json` at runtime (a published bundle may
 * sit in a profile whose node_modules layout this plugin does not control).
 *
 * When the identifier is NOT replaced — direct `tsc`, a test importing the source,
 * an unusual bundler — `typeof` sees an undeclared identifier and the constant is
 * `'unknown'` rather than a crash. That distinction is deliberate and the Doctor
 * reports it as a warning: "unknown" means this bundle was not built by the
 * release pipeline, which is worth knowing when diagnosing a request.
 */
declare const __DSH_OPENVIKING_ENHANCE_VERSION__: string | undefined

/** The plugin version baked into this bundle, or `'unknown'` outside the build. */
export const PLUGIN_VERSION: string =
  typeof __DSH_OPENVIKING_ENHANCE_VERSION__ === 'string' && __DSH_OPENVIKING_ENHANCE_VERSION__.length > 0
    ? __DSH_OPENVIKING_ENHANCE_VERSION__
    : 'unknown'

/**
 * The outbound `User-Agent` this plugin sends to OpenViking.
 *
 * Format: `dsh-openviking-enhance/<plugin> dsh/<dsh|unknown> node/<node> platform/<os>`.
 * It exists so a server log can correlate a request with the client that made it;
 * it contains version facts only — never a key, an account, a user or a path.
 */
export function buildUserAgent(dshVersion: string | null): string {
  const dsh = dshVersion !== null && dshVersion.length > 0 ? dshVersion : 'unknown'
  const node = typeof process !== 'undefined' && typeof process.version === 'string' ? process.version : 'unknown'
  const platform = typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : 'unknown'
  return `dsh-openviking-enhance/${PLUGIN_VERSION} dsh/${dsh} node/${node} platform/${platform}`
}
