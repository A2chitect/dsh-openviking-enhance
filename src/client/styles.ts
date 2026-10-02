/**
 * Styles for both mounts.
 *
 * Injected as a single idempotent `<style>` element from inside the module
 * factory (the lazy-CJS contract runs module side effects at materialization,
 * not at script parse).
 *
 * ## The status pill is styled from the default pills' own CSS
 *
 * `conversation.composer.dock` already renders the shell's stats pills
 * (`StatsPills.module.css` in `@deepseek-ai/dsh-client-ui-chat`). Our pill copies
 * those declarations rather than inventing a look, so the row reads as one
 * family:
 *
 *   font-size    calc(var(--dsh-content-font-size-secondary, 13px) - 1px)
 *   line-height  calc(20px + var(--dsh-content-font-delta-secondary, 0px))
 *   colour       var(--dsw-alias-label-tertiary)
 *   hover/expand var(--dsw-alias-interactive-bg-hover) + label-secondary
 *   shape        transparent, borderless, radius 999px, padding 1px 8px, gap 6px
 *   icons        14x14, currentColor
 *   figures      font-variant-numeric: tabular-nums
 *
 * ## Position
 *
 * Three facts about that row decide the rules below, all read off the shipped
 * CSS/source rather than guessed:
 *
 *  1. the slot outlet wrapper is `display:contents` (`dsh-client-ui-renderer`'s
 *     `ANCHOR_STYLE`), so a slot entry is a real flex item of the dock — which
 *     also means `position:absolute` would escape to an unrelated ancestor;
 *  2. the dock is `justify-content:center` and, because its own parent is a
 *     `flex-direction:column; align-items:center` box, it is **fit-content**:
 *     there is no free space in it, so `margin-left:auto` alone does nothing;
 *  3. pinning the pill with `margin-left:auto` once the row *is* wide enough
 *     would otherwise shove the default pills to the far left, since the auto
 *     margin swallows all of it.
 *
 * So the entry renders two elements — an invisible, equal-width mirror of the
 * pill carrying `margin-right:auto`, and the pill carrying `margin-left:auto` —
 * and a `:has()` rule widens the dock to the composer card's width. The two auto
 * margins then split the free space evenly, which keeps the default pills
 * exactly centred while ours is pinned right, however wide the figures get.
 *
 * The mirror's `display` is driven by a custom property that only the widening
 * rule sets, so the two cannot diverge: if that selector ever stops matching
 * (a shell DOM change), the mirror stays hidden and the row falls back to the
 * plain centred cluster instead of sitting off-centre.
 */
export const STYLE_ELEMENT_ID = 'dsh-openviking-enhance-styles'

const FONT_SIZE = 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)'
const LINE_HEIGHT = 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))'

const CSS = `
/* ---- Studio panel ------------------------------------------------------- */
.ove-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ove-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  font-size: 12px; flex: none;
}
.ove-toolbar .ove-title { color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-toolbar .ove-spacer { flex: 1; }
.ove-toolbar button {
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer;
  background: 0 0; border: none; border-radius: 999px; padding: 2px 8px;
}
.ove-toolbar button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-iframe { flex: 1; width: 100%; border: 0; background: transparent; min-height: 0; }
.ove-notice { padding: 16px; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.ove-muted { color: var(--dsw-alias-label-tertiary); }
.ove-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
.ove-dot-ok { background: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-dot-bad { background: var(--dsw-alias-state-warning-primary, #d29922); }

/* ---- Composer dock: make room, then keep the default pills centred ------ */
/* The dock is fit-content, so it must be widened before any auto margin can do
   anything. The selector walks the DOM the renderer really produces — dock div >
   div[data-slot] (the display:contents outlet anchor) > our element — so it hits
   exactly that one row, and being element+attribute it also outranks the shell's
   own .class max-width. The custom property enables the mirror, so these two
   rules can never diverge. */
div:has(> [data-slot="conversation.composer.dock"] > .ove-dock) {
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%);
  box-sizing: border-box;
  padding-right: 8px;
  --ove-mirror-display: inline-flex;
}
/* Invisible mirror of the pill, same box, so the free space has an equal block
   to absorb on the left. No JS measurement and no reflow: it tracks the label
   as the figure changes. */
.ove-dock-spacer {
  display: var(--ove-mirror-display, none);
  align-items: center; flex: none;
  order: -1; margin-right: auto; visibility: hidden; pointer-events: none;
}
.ove-pill-mirror {
  box-sizing: border-box; corner-shape: round;
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
}
.ove-pill-mirror svg { flex: none; width: 14px; height: 14px; }

/* ---- Commit status pill (mirrors StatsPills.module.css) ------------------ */
.ove-dock {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  font-size: ${FONT_SIZE};
  line-height: ${LINE_HEIGHT};
  display: inline-flex; align-items: center;
  order: 1;                 /* render after the stats pills and the context meter */
  margin-left: auto;        /* pin to the right edge of the dock row */
  position: relative;       /* anchor for the popover (not for the pill itself) */
}
.ove-pill {
  box-sizing: border-box; corner-shape: round; max-width: 100%;
  color: var(--dsw-alias-label-tertiary);
  font: inherit; font-variant-numeric: tabular-nums; line-height: inherit;
  white-space: nowrap; background: 0 0; border: none; border-radius: 999px;
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
}
.ove-pill svg { flex: none; width: 14px; height: 14px; }
button.ove-pill { cursor: pointer; }
button.ove-pill:hover, button.ove-pill[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.ove-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }
.ove-sep { color: var(--dsw-alias-separator-primary); margin: 0 6px; }
.ove-pulse { animation: ove-pulse 1s ease-in-out infinite alternate; }
@keyframes ove-pulse { from { opacity: .45; } to { opacity: 1; } }

/* ---- Commit detail popover (mirrors stat-dialog.module.css) -------------- */
.ove-pop {
  z-index: 1100; box-sizing: border-box; position: absolute;
  bottom: calc(100% + 8px); right: 0;
  width: max-content; min-width: min(320px, 80vw); max-width: min(460px, 80vw);
  max-height: 60vh; overflow: auto;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); cursor: default; border: 0;
  padding: 16px; font-size: 12px; line-height: 18px; text-align: left;
}
.ove-pop-title {
  color: var(--dsw-alias-label-primary); justify-content: space-between;
  gap: 16px; margin-bottom: 8px; font-weight: 500; display: flex;
}
.ove-pop-title-label { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.ove-pop-title-label svg { flex: none; width: 14px; height: 14px; }
.ove-pop-rule { border-top: .5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }
.ove-facts {
  display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px; margin: 0; color: var(--dsw-alias-label-tertiary);
}
.ove-facts dt, .ove-facts dd { min-width: 0; margin: 0; }
.ove-facts dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.ove-facts dd code { font-size: 11px; overflow-wrap: anywhere; }
.ove-section { margin-top: 12px; }
.ove-section-title { color: var(--dsw-alias-label-primary); font-weight: 500; margin-bottom: 6px; }
.ove-row {
  box-sizing: border-box; width: 100%; font: inherit; text-align: left; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: 0 0; border: none;
  border-radius: var(--dsw-radius-md); padding: 4px 8px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.ove-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-row-count { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.ove-group { margin-top: 8px; }
.ove-group > summary { cursor: pointer; color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-entry { margin: 4px 0; padding: 2px 0 2px 10px; border-left: .5px solid var(--dsw-alias-border-l2); }
.ove-entry .ove-uri { color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-entry .ove-type { color: var(--dsw-alias-label-caption); font-size: 11px; }
.ove-empty { color: var(--dsw-alias-label-tertiary); }
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
