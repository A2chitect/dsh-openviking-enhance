/**
 * Styles for both mounts.
 *
 * Injected as a single idempotent `<style>` element from inside the module
 * factory (the lazy-CJS contract runs module side effects at materialization,
 * not at script parse). Colours are inherited from the shell wherever possible
 * — `currentColor` plus `color-mix()` — so the panel follows the active theme
 * without binding to theme-token names that differ between DSH generations.
 */
export const STYLE_ELEMENT_ID = 'dsh-openviking-enhance-styles'

const CSS = `
.ove-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ove-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  font-size: 12px; flex: none;
}
.ove-toolbar .ove-title { font-weight: 600; }
.ove-toolbar .ove-spacer { flex: 1; }
.ove-toolbar button, .ove-pill {
  font: inherit; color: inherit; cursor: pointer;
  background: color-mix(in srgb, currentColor 8%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 6px; padding: 3px 8px;
}
.ove-toolbar button:hover, .ove-pill:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.ove-iframe { flex: 1; width: 100%; border: 0; background: transparent; min-height: 0; }
.ove-notice { padding: 16px; font-size: 13px; line-height: 1.6; }
.ove-notice code { font-size: 12px; }
.ove-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.ove-dot-ok { background: #3fb950; }
.ove-dot-bad { background: #d29922; }

.ove-pill-wrap { position: relative; display: inline-flex; align-items: center; }
.ove-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1.4; padding: 2px 8px; }
.ove-pill-phase-extracting { border-color: color-mix(in srgb, #58a6ff 60%, transparent); }
.ove-bar { width: 34px; height: 4px; border-radius: 2px; background: color-mix(in srgb, currentColor 20%, transparent); overflow: hidden; }
.ove-bar > i { display: block; height: 100%; background: currentColor; opacity: .7; }

.ove-pop {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40;
  width: min(560px, 80vw); max-height: 60vh; overflow: auto;
  background: var(--dsh-surface, #1c1c1c); color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.35);
  padding: 10px 12px; font-size: 12px; text-align: left;
}
.ove-pop h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.ove-pop .ove-meta { opacity: .65; margin-bottom: 8px; }
.ove-pop ul { list-style: none; margin: 0; padding: 0; }
.ove-pop li { margin: 0 0 4px; }
.ove-pop .ove-archive { width: 100%; text-align: left; justify-content: space-between; display: flex; }
.ove-group { margin: 8px 0 0; }
.ove-group > summary { cursor: pointer; font-weight: 600; }
.ove-entry { padding: 4px 0 4px 10px; border-left: 2px solid color-mix(in srgb, currentColor 18%, transparent); margin: 4px 0; }
.ove-entry .ove-uri { word-break: break-all; opacity: .85; }
.ove-entry .ove-type { opacity: .55; font-size: 11px; }
.ove-empty { opacity: .6; }
`

/** Install the stylesheet once per document. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ELEMENT_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = CSS
  document.head.append(style)
}
