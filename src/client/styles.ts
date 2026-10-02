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
 * The pill simply follows the shell's own pills in that row, so the whole group
 * stays centred exactly as before. Three facts shape the rules below, all read
 * off the shipped CSS/source rather than guessed:
 *
 *  1. the slot outlet wrapper is `display:contents` (`dsh-client-ui-renderer`'s
 *     `ANCHOR_STYLE`), so a slot entry is a real flex item of the dock — which
 *     also rules out `position:absolute`, as it would escape to an unrelated
 *     ancestor;
 *  2. the dock is fit-content (its own parent is a
 *     `flex-direction:column; align-items:center` box), so it is only as wide as
 *     its content: there is no free space inside it at all;
 *  3. consequently `margin-left:auto` on an entry does nothing, and anything
 *     added to push the pill rightward — an auto margin, a balancing spacer, a
 *     widened dock — either has no effect or shoves the whole group off centre.
 *
 * `order: 1` is the only positioning left, and it is deliberate: it guarantees
 * the pill renders after the stats pills and the context meter regardless of
 * plugin load order.
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
.ove-dot-bad { background: var(--dsw-alias-state-warn-primary, #d29922); }

/* ---- Composer dock ------------------------------------------------------ */
/* Our pill is a plain flex item of the dock: it renders after the shell's pills
   and the context meter, and the dock's own centring carries the whole group.
   Nothing here may reserve width or absorb free space — see the position notes
   at the top of this file for why that only ever shifts the group. */

/* ---- Commit status pill (mirrors StatsPills.module.css) ------------------ */
.ove-dock {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  font-size: ${FONT_SIZE};
  line-height: ${LINE_HEIGHT};
  display: inline-flex; align-items: center;
  order: 1;                 /* render after the stats pills and the context meter */
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
/* A failed extraction is the one state the default pills have no equivalent for,
   and silence is what makes it expensive: the archive exists, the counter advanced,
   and the memories are simply missing. So the pill keeps its exact geometry and
   only takes the warning colour. */
.ove-pill-errored { color: var(--dsw-alias-state-warn-primary, #d29922); }
button.ove-pill-errored:hover, button.ove-pill-errored[aria-expanded="true"] {
  color: var(--dsw-alias-state-warn-primary, #d29922);
}
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
/* ---- Commit timeline ---------------------------------------------------- */
.ove-timeline { position: relative; margin-top: 2px; }
.ove-timeline::before {
  content: ''; position: absolute; left: 8.5px; top: 12px; bottom: 12px;
  border-left: .5px solid var(--dsw-alias-border-l2);
}
.ove-tl-row {
  position: relative; box-sizing: border-box; width: 100%; font: inherit; text-align: left;
  cursor: pointer; color: var(--dsw-alias-label-secondary); background: 0 0; border: none;
  border-radius: var(--dsw-radius-md); padding: 4px 8px 4px 20px;
  display: flex; align-items: center; gap: 8px;
}
.ove-tl-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-tl-dot {
  position: absolute; left: 6px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-label-caption);
}
.ove-tl-time { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-tl-counts { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-tl-open { flex: none; color: var(--dsw-alias-label-caption); }
.ove-tl-more { justify-content: space-between; }

.ove-empty { color: var(--dsw-alias-label-tertiary); }
.ove-error { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-failure {
  margin-top: 8px; padding: 6px 8px; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
}
.ove-failure-head {
  display: flex; justify-content: space-between; gap: 12px;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
}
.ove-failure-msg { margin-top: 4px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

/* ---- Recall panel (right Sidebar tab) ----------------------------------- */
/* Every value below is copied from the shipped right-Sidebar tabs, so the panel
   reads as one of them rather than as a plugin's own idea of a list:

     tab body        @deepseek-ai/dsh-client-ui-sidebar-right   .tabBody
     header + rows   @deepseek-ai/dsh-client-ui-sidebar-files   .header/.body/.row
     input + button  @deepseek-ai/dsh-client-ui-primitives      Input / Button.sm
     group header    @deepseek-ai/dsh-client-ui-primitives      SearchBlock .fileHeader

   Two structural facts, taken from those rules rather than guessed: the pane
   gives a tab body NO scrolling of its own (overflow:hidden on .tabBody), so
   the body owns it — without that a long result list is clipped instead of
   scrollable; and rows are borderless with a hover fill, not cards. */
.ove-recall {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  /* The shipped tabs inherit the pane's content size; naming it here keeps the
     12px captions below relative to something known instead of to whatever the
     pane happens to hand down. */
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5;
}

/* Shipped files-tab header: 38px, one hairline under it. */
.ove-recall-bar {
  box-sizing: border-box; flex: none; display: flex; align-items: center; gap: 4px;
  height: 38px; padding: 0 6px 0 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
}
/* Shipped Input.wrap, at the compact height the bar affords. */
.ove-recall-field {
  flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.ove-recall-field:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.ove-recall-field-icon {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary);
}
.ove-recall-input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary);
}
.ove-recall-input::placeholder { color: var(--dsw-alias-label-dimmed); }

/* Shipped Button.sm (outline) and the chrome icon button. */
.ove-recall-button {
  flex: none; box-sizing: border-box; height: 28px; padding: 0 10px;
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-recall-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-recall-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-recall-icon {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: 0 0; border: none;
  border-radius: var(--dsw-radius-sm);
}
.ove-recall-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-recall-icon:disabled { opacity: .4; cursor: not-allowed; }
.ove-recall-icon svg { width: 15px; height: 15px; }

/* Shipped files-tab body: it, not the pane, is the scroller. */
.ove-recall-body {
  flex: auto; min-height: 0; overflow: auto; scrollbar-gutter: stable;
  padding: 8px 0 10px 8px; margin-right: 2px;
}
.ove-recall-meta {
  display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 0 10px 6px;
  color: var(--dsw-alias-label-tertiary); font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* Shipped SearchBlock .fileHeader: a bold label and its count on one baseline. */
.ove-recall-group {
  display: flex; align-items: baseline; gap: 8px; min-height: 22px;
  padding: 8px 10px 2px; font-size: 12px;
}
.ove-recall-group-name { font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-recall-group-count { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }

/* One entry is one outlined card: the file's own edge, so a list of memories
   reads as a list of records rather than as loose text. The card owns the radius
   and clips the row's hover fill to it. */
.ove-recall-item {
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow: hidden;
  margin-bottom: 6px;
}
.ove-recall-item-open { border-color: var(--dsw-alias-border-l2); }
/* Shipped files-tab row inside that card: hover fill, no border of its own.
   The row is a BLOCK holding one flex line, not a flex row itself: as a flex row
   the abstract and the tags became siblings of the title and were laid out beside
   it, which pushed the score to the middle of a three-line item. */
.ove-recall-row {
  box-sizing: border-box; display: block; width: 100%; min-width: 0;
  padding: 6px 10px; font: inherit; text-align: left; color: inherit;
  background: 0 0; border: 0; cursor: pointer;
}
.ove-recall-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-recall-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ove-recall-title {
  flex: 1; min-width: 0; color: var(--dsw-alias-label-primary);
  white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
}
.ove-recall-score { flex: none; font-variant-numeric: tabular-nums; }
/* Bands: >=0.80 strong, >=0.70 medium, below that weak — see the scoreTone()
   helper for where those three numbers come from. */
.ove-recall-score-high { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-recall-score-mid { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-recall-score-low { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-recall-caret { flex: none; color: var(--dsw-alias-label-caption); }
.ove-recall-abstract {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; margin: 2px 0 0;
  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary);
  white-space: normal;
}
.ove-recall-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.ove-recall-tag {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  padding: 0 6px;
}
.ove-recall-detail { padding: 0 10px 8px; }
.ove-recall-uri {
  display: block; margin-bottom: 4px; font-size: 12px;
  color: var(--dsw-alias-label-caption); overflow-wrap: anywhere;
}
.ove-recall-detail pre {
  margin: 0; max-height: 320px; overflow: auto;
  padding: 8px 10px; border-radius: var(--dsw-radius-md);
  /* The app's text-block surface. bg-layer-1 is the page's own colour, so the
     block was invisible against it in the light theme. */
  background: var(--dsw-alias-markdown-code-block);
  font: inherit; font-size: 12px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
/* Shipped SearchBlock .expand. */
.ove-recall-more {
  display: block; width: 100%; margin-top: 2px; padding: 5px 10px; font: inherit; text-align: left;
  color: var(--dsw-alias-label-tertiary); background: 0 0; border: none;
  border-radius: var(--dsw-radius-md); cursor: pointer;
}
.ove-recall-more:hover:not(:disabled) {
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover);
}
.ove-recall-more:disabled { opacity: .4; cursor: not-allowed; }

/* Shipped files-tab .status / .statusLine for the states that have no rows. */
.ove-recall-status {
  margin: 0; padding: 12px 10px; color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.6;
}
.ove-recall-hint {
  margin: 0; padding: 4px 10px 8px; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere;
}
.ove-recall-error {
  margin: 0; padding: 12px 10px; color: var(--dsw-alias-state-error-primary, #f85149);
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.6;
  overflow-wrap: anywhere;
}
.ove-recall-plan, .ove-recall-targets {
  padding: 0 10px 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary);
}
.ove-recall-plan summary, .ove-recall-targets summary { cursor: pointer; }
/* The UA triangle has no margin of its own and ::marker cannot take one. */
.ove-recall-summary { margin-left: 4px; }
.ove-recall-plan pre {
  margin: 4px 0 0; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.ove-recall-targets ul { margin: 4px 0 0; padding-left: 16px; }
.ove-recall-targets li { overflow-wrap: anywhere; }

/* ---- Plugin configuration (Plugins -> this plugin -> Configure) ---------- */
/* A page, not a sidebar strip: full-width fields on the same control metrics the
   shipped Input/Button use (32px, border-l4, radius-md, primary fill). */
.ove-config { display: flex; flex-direction: column; gap: 14px; max-width: 560px; padding: 4px 0 8px; }
.ove-config-field { display: flex; flex-direction: column; gap: 4px; }
.ove-config-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.ove-config-badge {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  padding: 0 6px;
}
.ove-config-control { display: flex; align-items: center; gap: 6px; }
.ove-config-input {
  flex: 1; min-width: 0; box-sizing: border-box; height: 32px; padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); outline: none;
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
}
.ove-config-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.ove-config-input:disabled { opacity: .6; }
.ove-config-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ove-config-button {
  flex: none; box-sizing: border-box; height: 32px; padding: 0 12px; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: transparent; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.ove-config-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-config-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-config-primary {
  box-sizing: border-box; height: 32px; padding: 0 16px; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-fill); border: none;
  border-radius: var(--dsw-radius-md);
}
.ove-config-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ove-config-primary:disabled { opacity: .4; cursor: not-allowed; }
.ove-config-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-config-note { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ove-config-error { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-config-actions { display: flex; gap: 8px; align-items: center; }
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
