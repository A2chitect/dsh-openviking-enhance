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

/* ---- Commit status pill (matched to StatsPills.module.css) ------------- */
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

/* ---- Commit detail popover (matched to stat-dialog.module.css) --------- */
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
/* A failed extraction is a lost memory, not "no detail": the timeline row keeps
   the same geometry and only takes the error colour on its dot and counts. */
.ove-tl-row-failed .ove-tl-dot { background: var(--dsw-alias-state-error-primary, #f85149); }
.ove-tl-row-failed .ove-tl-counts { color: var(--dsw-alias-state-error-primary, #f85149); }
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
/* Every value below is matched to the shipped right-Sidebar tabs, so the panel
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
/* Interface switches: a separated group of rows, each label+hint on the left and
   the 16px checkbox with its small "default" button on the right. The group is
   split from the connection fields by the same hairline the page uses. */
.ove-config-group {
  display: flex; flex-direction: column; gap: 10px;
  border-top: .5px solid var(--dsw-alias-border-l3); padding-top: 14px;
}
.ove-config-group-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
.ove-config-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ove-config-toggle-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ove-config-toggle-control { display: flex; align-items: center; gap: 8px; flex: none; }
.ove-config-check {
  width: 16px; height: 16px; margin: 0; cursor: pointer;
  accent-color: var(--dsw-alias-state-business-primary);
}
.ove-config-check:disabled { opacity: .4; cursor: not-allowed; }

/* ---- Recall explanation (conversation turn tail) ------------------------ */
.ove-explain { display: block; margin: 2px 0 4px; font-size: 12px; line-height: 18px; }
.ove-explain-trigger {
  display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-tertiary);
  background: 0 0; border: 0; border-radius: 999px; cursor: pointer;
}
.ove-explain-trigger svg { flex: none; width: 12px; height: 12px; }
.ove-explain-trigger:hover, .ove-explain-trigger-open {
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover);
}
.ove-explain-trigger-count { font-variant-numeric: tabular-nums; }
.ove-explain-caret { color: var(--dsw-alias-label-caption); }
.ove-explain-card {
  box-sizing: border-box; width: 100%; max-width: 620px; margin-top: 6px; padding: 12px;
  max-height: min(70vh, 720px); overflow: auto;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg);
  text-align: left;
}
.ove-explain-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ove-explain-heading { color: var(--dsw-alias-label-primary); font-weight: 500; font-size: 13px; }
.ove-explain-head-actions { display: inline-flex; gap: 2px; }
.ove-explain-icon {
  width: 24px; height: 24px; padding: 0; font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: 0 0; border: 0;
  border-radius: var(--dsw-radius-sm);
}
.ove-explain-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explain-icon:disabled { opacity: .4; cursor: not-allowed; }
.ove-explain-note { margin: 4px 0 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.ove-explain-query {
  display: flex; gap: 8px; min-width: 0; padding: 6px 8px;
  background: var(--dsw-alias-markdown-code-block); border-radius: var(--dsw-radius-sm);
}
.ove-explain-query-label { flex: none; color: var(--dsw-alias-label-tertiary); }
.ove-explain-query-text {
  min-width: 0; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-explain-status { margin: 8px 0 0; color: var(--dsw-alias-label-tertiary); }
.ove-explain-error { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-explain-hint { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ove-explain-metrics { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 8px 0 2px; }
.ove-explain-metric { display: inline-flex; gap: 4px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-explain-metric-value { color: var(--dsw-alias-label-secondary); }
.ove-explain-group {
  display: flex; align-items: baseline; gap: 8px; padding: 8px 2px 2px;
  color: var(--dsw-alias-label-primary); font-weight: 600;
}
.ove-explain-group-count { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; font-weight: 400; }
.ove-explain-item {
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  overflow: hidden; margin-bottom: 4px;
}
.ove-explain-item-open { border-color: var(--dsw-alias-border-l2); }
.ove-explain-row {
  box-sizing: border-box; display: block; width: 100%; padding: 5px 8px;
  font: inherit; text-align: left; color: inherit; background: 0 0; border: 0; cursor: pointer;
}
.ove-explain-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explain-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ove-explain-title {
  flex: 1; min-width: 0; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-explain-score { flex: none; font-variant-numeric: tabular-nums; }
.ove-explain-uri-line {
  display: block; margin-top: 1px; color: var(--dsw-alias-label-caption); font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-explain-abstract {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5;
}
.ove-explain-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.ove-explain-tag {
  padding: 0 5px; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-explain-detail { padding: 0 8px 8px; }
.ove-explain-uri { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.ove-explain-detail pre, .ove-explain-details pre {
  margin: 0; max-height: 260px; overflow: auto; padding: 6px 8px;
  background: var(--dsw-alias-markdown-code-block); border-radius: var(--dsw-radius-sm);
  font: inherit; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.ove-explain-details { margin-top: 8px; color: var(--dsw-alias-label-tertiary); }
.ove-explain-details > summary { cursor: pointer; }
.ove-explain-stats { margin: 6px 0 0; display: grid; gap: 2px; }
.ove-explain-stat { display: flex; justify-content: space-between; gap: 12px; }
.ove-explain-stat dt { color: var(--dsw-alias-label-tertiary); }
.ove-explain-stat dd { margin: 0; color: var(--dsw-alias-label-secondary); text-align: right; font-variant-numeric: tabular-nums; }
.ove-explain-warnings { margin-top: 8px; color: var(--dsw-alias-label-tertiary); }
.ove-explain-link {
  margin-top: 8px; padding: 0; font: inherit; color: var(--dsw-alias-state-business-primary);
  background: 0 0; border: 0; cursor: pointer;
}
.ove-explain-link:hover { text-decoration: underline; }

/* ---- Commit diff browser ------------------------------------------------ */
.ove-diff-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.ove-diff-action {
  flex: none; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary);
  background: 0 0; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); padding: 0 6px; cursor: pointer;
}
.ove-diff-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-diff-archive { margin-top: 2px; overflow-wrap: anywhere; }
.ove-diff-filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 2px; }
.ove-diff-filter {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  font: inherit; font-size: 11px; color: var(--dsw-alias-label-tertiary);
  background: 0 0; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 999px; cursor: pointer;
}
.ove-diff-filter:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-diff-filter-active { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ove-diff-filter-count { font-variant-numeric: tabular-nums; }
.ove-diff-group { display: flex; align-items: baseline; gap: 8px; padding: 6px 0 2px; font-weight: 500; }
.ove-diff-entry { border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); margin-bottom: 4px; overflow: hidden; }
.ove-diff-entry-head { display: flex; align-items: center; gap: 4px; }
.ove-diff-row {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  font: inherit; text-align: left; color: inherit; background: 0 0; border: 0; cursor: pointer;
}
.ove-diff-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-diff-kind { flex: none; width: 14px; text-align: center; font-variant-numeric: tabular-nums; }
.ove-diff-kind[data-kind="adds"] { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-diff-kind[data-kind="deletes"] { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-diff-kind[data-kind="updates"] { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-diff-name { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-diff-type { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ove-diff-preview {
  flex: 2; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-diff-caret { flex: none; color: var(--dsw-alias-label-caption); }
.ove-diff-detail { padding: 0 8px 8px; }
.ove-diff-uri { margin-bottom: 4px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.ove-diff-body {
  max-height: 280px; overflow: auto; padding: 4px 0;
  background: var(--dsw-alias-markdown-code-block); border-radius: var(--dsw-radius-sm);
  font-size: 11px; line-height: 1.5;
}
.ove-diff-line { display: flex; gap: 6px; padding: 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ove-diff-line-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb950) 14%, transparent); }
.ove-diff-line-remove { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 14%, transparent); }
.ove-diff-sign { flex: none; width: 8px; color: var(--dsw-alias-label-tertiary); }
.ove-diff-line-add .ove-diff-sign { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-diff-line-remove .ove-diff-sign { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-diff-text { min-width: 0; }
.ove-failure-task { margin-top: 4px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-failure-task code { font-size: 11px; }
.ove-failure-actions { margin-top: 4px; }

/* ---- Memory health tab -------------------------------------------------- */
.ove-health {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5;
}
.ove-health-bar {
  box-sizing: border-box; flex: none; display: flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 10px 0 12px; border-bottom: .5px solid var(--dsw-alias-border-l3);
}
.ove-health-title { color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-health-spacer { flex: 1; }
.ove-health-button {
  flex: none; height: 26px; padding: 0 10px; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-health-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-health-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-health-body { flex: auto; min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 10px 12px 16px; }
.ove-health-banner {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px;
  padding: 6px 8px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
}
.ove-health-state { font-weight: 600; }
.ove-health-state-hint { flex-basis: 100%; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ove-health-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
.ove-health-state-good, .ove-health-state-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-health-dot.ove-health-state-good, .ove-health-dot.ove-health-state-ok { background: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-health-state-warn { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-health-dot.ove-health-state-warn { background: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-health-state-bad { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-health-dot.ove-health-state-bad { background: var(--dsw-alias-state-error-primary, #f85149); }
.ove-health-state-busy { color: var(--dsw-alias-state-business-primary); }
.ove-health-dot.ove-health-state-busy { background: var(--dsw-alias-state-business-primary); }
.ove-health-state-idle, .ove-health-state-unknown { color: var(--dsw-alias-label-tertiary); }
.ove-health-dot.ove-health-state-idle, .ove-health-dot.ove-health-state-unknown { background: var(--dsw-alias-label-tertiary); }
.ove-health-facts {
  display: grid; grid-template-columns: minmax(110px, auto) minmax(0, 1fr);
  gap: 4px 12px; margin: 10px 0 0; color: var(--dsw-alias-label-tertiary);
}
.ove-health-facts dt, .ove-health-facts dd { min-width: 0; margin: 0; }
.ove-health-facts dd { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ove-health-facts code { font-size: 11px; overflow-wrap: anywhere; }
.ove-health-fact-row { display: contents; }
.ove-health-rule { border-top: .5px solid var(--dsw-alias-border-l3); margin: 14px 0 10px; }
.ove-health-section { margin-top: 12px; }
.ove-health-section-title {
  display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.ove-health-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 8px; color: var(--dsw-alias-label-secondary); }
.ove-health-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow-wrap: anywhere; }
.ove-health-error { color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-health-link {
  padding: 0; font: inherit; color: var(--dsw-alias-state-business-primary);
  background: 0 0; border: 0; cursor: pointer;
}
.ove-health-link:hover { text-decoration: underline; }
.ove-health-timeline { position: relative; margin-left: 3px; padding-left: 10px; border-left: .5px solid var(--dsw-alias-border-l2); }
.ove-health-event { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; padding: 2px 0; }
.ove-health-event-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; margin-left: -14px; }
.ove-health-event-time { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-health-event-label { color: var(--dsw-alias-label-secondary); }
.ove-health-event-detail { color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-health-task { margin-top: 4px; padding: 4px 8px; background: var(--dsw-alias-interactive-bg-hover); border-radius: var(--dsw-radius-sm); }
.ove-health-task-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.ove-health-task-status { font-weight: 500; }
.ove-health-task-id { color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.ove-health-task-id code { font-size: 11px; }
.ove-health-check-block { padding: 2px 0; }
.ove-health-check { display: flex; align-items: baseline; gap: 6px; }
.ove-health-check-name { color: var(--dsw-alias-label-secondary); }
.ove-health-check-value { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ove-health-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ove-health-chip {
  display: inline-flex; align-items: baseline; gap: 4px; padding: 0 6px;
  font-size: 11px; line-height: 18px; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
}
.ove-health-chip-state { color: var(--dsw-alias-label-tertiary); }
.ove-plugin-health { margin-top: 12px; }
.ove-config-button-sm { height: 24px; padding: 0 8px; font-size: 12px; }

/* ---- v0.4: shared viking:// link --------------------------------------- */
/* One component for every URI the plugin renders. It is a button (the
   destination is the preview tab, not a URL) and inherits its placement's font
   and colour, with the one affordance a link needs: an underline on hover. */
.ove-uri-link {
  display: inline; min-width: 0; max-width: 100%; padding: 0; border: 0;
  background: 0 0; font: inherit; color: var(--dsw-alias-state-business-primary);
  text-align: left; cursor: pointer; overflow-wrap: anywhere;
}
.ove-uri-link:hover { text-decoration: underline; }
.ove-uri-link:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; border-radius: 2px; }

/* ---- v0.4: viking:// preview tab -------------------------------------- */
.ove-preview {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5;
}
/* The recall tab's shipped 38px search header, reused for placement parity. */
.ove-preview-bar {
  display: flex; align-items: center; gap: 6px; flex: none;
  padding: 6px 10px; border-bottom: .5px solid var(--dsw-alias-border-l3);
}
.ove-preview-field {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 30px;
  padding: 0 8px; background: var(--dsw-alias-bg-l1); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-tertiary);
}
.ove-preview-field:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.ove-preview-field-icon { display: flex; flex: none; }
.ove-preview-field-icon svg { width: 14px; height: 14px; }
.ove-preview-input {
  flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
}
.ove-preview-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ove-preview-button {
  flex: none; height: 26px; padding: 0 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: 0 0; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); cursor: pointer; white-space: nowrap;
}
.ove-preview-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-preview-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-preview-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; }
.ove-preview-uri-row { margin-bottom: 6px; }
.ove-preview-uri { display: block; color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.ove-preview-status { margin: 6px 0; color: var(--dsw-alias-label-tertiary); }
.ove-preview-hint { margin: 6px 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow-wrap: anywhere; }
.ove-preview-error { margin: 6px 0; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-preview-meta { margin: 6px 0 10px; }
.ove-preview-meta summary { color: var(--dsw-alias-label-secondary); font-weight: 500; cursor: pointer; }
.ove-preview-meta dl { margin: 6px 0 0; }
.ove-preview-meta-row {
  display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  gap: 4px 12px; padding: 1px 0;
}
.ove-preview-meta-row dt { margin: 0; color: var(--dsw-alias-label-tertiary); }
.ove-preview-meta-row dd { margin: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ove-preview-tiers {
  display: flex; gap: 4px; margin: 4px 0 8px; padding: 2px;
  background: var(--dsw-alias-bg-l1); border-radius: var(--dsw-radius-md);
}
.ove-preview-tier {
  flex: 1; min-width: 0; height: 24px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-sm);
  background: 0 0; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ove-preview-tier:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-preview-tier-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-preview-tier:disabled { opacity: .4; cursor: not-allowed; }
.ove-preview-text-wrap { margin-top: 2px; }
.ove-preview-more { display: flex; justify-content: flex-start; margin: 2px 0 6px; }
.ove-preview-text {
  margin: 0; padding: 8px; background: var(--dsw-alias-bg-l1); border-radius: var(--dsw-radius-sm);
  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 60vh; overflow-y: auto;
}
.ove-preview-warnings { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ove-preview-warnings > div { overflow-wrap: anywhere; }

/* ---- v0.4: Explore tab ------------------------------------------------- */
.ove-explore {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5;
}
.ove-explore-nav {
  display: flex; gap: 4px; flex: none; padding: 6px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
}
.ove-explore-seg {
  flex: 1; min-width: 0; height: 26px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-sm);
  background: 0 0; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ove-explore-seg:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-seg-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-explore-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; }
.ove-explore-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.ove-explore-options {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 6px;
}
.ove-explore-toggle {
  display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap;
}
.ove-explore-toggle input { margin: 0; }
.ove-explore-options .ove-explore-hint { margin: 0; flex: 1; min-width: 160px; }
.ove-explore-partial {
  display: flex; align-items: center; gap: 6px; justify-content: space-between;
  padding: 3px 6px; border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-l1); border: .5px solid var(--dsw-alias-border-l3);
}
.ove-explore-field {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 30px;
  padding: 0 8px; background: var(--dsw-alias-bg-l1); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-tertiary);
}
.ove-explore-field:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.ove-explore-field-icon { display: flex; flex: none; }
.ove-explore-field-icon svg { width: 14px; height: 14px; }
.ove-explore-input {
  flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
}
.ove-explore-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ove-explore-button {
  flex: none; height: 26px; padding: 0 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: 0 0; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); cursor: pointer; white-space: nowrap;
}
.ove-explore-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-explore-icon {
  flex: none; display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: 0 0;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.ove-explore-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-icon:disabled { opacity: .4; cursor: not-allowed; }
.ove-explore-icon svg { width: 15px; height: 15px; }
.ove-explore-type { display: flex; gap: 4px; margin: 6px 0; }
.ove-explore-type-btn {
  height: 22px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 999px; background: 0 0; font: inherit; font-size: 11px;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.ove-explore-type-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-type-active { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.ove-explore-type-btn:disabled { opacity: .4; cursor: not-allowed; }
.ove-explore-group {
  display: flex; align-items: baseline; gap: 8px; margin: 12px 0 4px;
}
.ove-explore-group-name { font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-explore-group-count { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-explore-meta {
  display: flex; flex-wrap: wrap; gap: 6px 10px; margin: 2px 0 4px;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
}
.ove-explore-hit { padding: 5px 8px; border-radius: var(--dsw-radius-sm); }
.ove-explore-hit:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-hit-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; min-width: 0; }
.ove-explore-hit-name { flex: 1 1 auto; min-width: 0; font-weight: 500; }
.ove-explore-score { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-explore-hit-abstract { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow-wrap: anywhere; }
.ove-explore-hit-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.ove-explore-tag {
  display: inline-flex; align-items: baseline; padding: 0 6px; font-size: 11px; line-height: 18px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
.ove-explore-status { margin: 6px 0; color: var(--dsw-alias-label-tertiary); }
.ove-explore-hint { margin: 4px 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow-wrap: anywhere; }
.ove-explore-error { margin: 6px 0; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-explore-tester { margin-bottom: 6px; }
.ove-explore-textarea {
  width: 100%; box-sizing: border-box; min-height: 60px; padding: 6px 8px; resize: vertical;
  font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-l1); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.ove-explore-textarea:focus { outline: 0; border-color: var(--dsw-alias-state-business-primary); }
.ove-explore-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.ove-explore-tester-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ove-explore-rule { margin: 8px 0; padding: 6px 8px; background: var(--dsw-alias-bg-l1); border-radius: var(--dsw-radius-sm); }
.ove-explore-facts { margin: 6px 0 0; }
.ove-explore-fact {
  display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  gap: 4px 12px; padding: 1px 0;
}
.ove-explore-fact dt { margin: 0; color: var(--dsw-alias-label-tertiary); }
.ove-explore-fact dd { margin: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; white-space: pre-wrap; }
.ove-explore-details { margin-top: 6px; }
.ove-explore-details summary { color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
.ove-explore-details pre {
  margin: 6px 0 0; padding: 8px; background: var(--dsw-alias-bg-l1); border-radius: var(--dsw-radius-sm);
  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 40vh; overflow-y: auto;
}
.ove-explore-picker { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; }
.ove-explore-pick {
  max-width: 100%; padding: 2px 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: 0 0;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: 999px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-explore-pick:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-explore-pick-active { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
/* ======================================================================
 * v0.5 "Collaborate" — scope chip, write dialogs/toast, Activity tab,
 * command card, profile editor.
 *
 * Same token vocabulary as the rest of the file: DSH alias variables for
 * colour/border/radius, the shell's secondary font size for chrome text.
 * The overlay layer is click-through; every entry here opts back in with
 * 'pointer-events: auto' on its visible surface.
 * ==================================================================== */

/* ---- the scope chip (F12) -------------------------------------------- */
.ove-scope { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.ove-scope-compact { flex: none; }
.ove-scope-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 1px 8px; font: inherit; font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary); background: 0 0; border: 0;
  border-radius: 999px; cursor: pointer;
}
.ove-scope-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.ove-scope-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-business-primary);
}
.ove-scope-label { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ove-scope-identity { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ove-scope-warn-glyph { color: var(--dsw-alias-state-warning-primary, #d29922); }
.ove-scope-loading,
.ove-scope-error { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-scope-detail {
  position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; width: 340px; max-width: 80vw;
  padding: 10px 12px; text-align: left;
  background: var(--dsw-alias-bg-l1, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
}
.ove-scope-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ove-scope-detail-title { font-size: 12px; font-weight: 600; }
.ove-scope-close {
  font: inherit; font-size: 14px; line-height: 1; color: var(--dsw-alias-label-tertiary);
  background: 0 0; border: 0; cursor: pointer; padding: 2px 4px;
}
.ove-scope-rows { margin: 8px 0; }
.ove-scope-row {
  display: grid; grid-template-columns: minmax(84px, auto) minmax(0, 1fr);
  gap: 2px 10px; padding: 1px 0; font-size: 12px;
}
.ove-scope-row dt { margin: 0; color: var(--dsw-alias-label-tertiary); }
.ove-scope-row dd { margin: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ove-scope-profiles { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.ove-scope-profiles-title { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ove-scope-profile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 4px 8px; font: inherit; font-size: 12px; text-align: left;
  color: var(--dsw-alias-label-secondary); background: 0 0; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-scope-profile:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-scope-profile:disabled { cursor: default; opacity: .65; }
.ove-scope-profile-active { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.ove-scope-profile-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.ove-scope-hint { margin: 6px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-scope-warn { font-size: 11px; color: var(--dsw-alias-state-warning-primary, #d29922); overflow-wrap: anywhere; }

/* ---- the write dialog (F9/F10) --------------------------------------- */
.ove-overlay { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
.ove-write-overlay { display: flex; align-items: center; justify-content: center; }
.ove-write-backdrop {
  position: absolute; inset: 0; pointer-events: auto;
  background: rgba(0, 0, 0, .42);
}
.ove-write-dialog {
  position: relative; pointer-events: auto; width: min(560px, calc(100vw - 32px));
  max-height: min(84vh, 720px); overflow-y: auto; padding: 14px 16px;
  background: var(--dsw-alias-bg-l1, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .36);
}
.ove-write-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.ove-write-title { font-size: 14px; font-weight: 600; flex: none; }
.ove-write-target {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ove-write-scope {
  display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0 0 10px; padding: 8px 10px;
  background: var(--dsw-alias-bg-base); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
}
.ove-write-scope > div { display: flex; flex-direction: column; min-width: 0; }
.ove-write-scope dt { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-write-scope dd { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ove-write-hint { margin: 4px 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-write-warning {
  margin: 6px 0; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base); border-left: 2px solid var(--dsw-alias-state-warning-primary, #d29922);
  border-radius: var(--dsw-radius-sm);
}
.ove-write-error { margin: 6px 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-write-diffbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-write-link { font: inherit; font-size: 12px; color: var(--dsw-alias-state-business-primary); background: 0 0; border: 0; cursor: pointer; padding: 0; }
.ove-write-editor {
  width: 100%; box-sizing: border-box; min-height: 220px; max-height: 40vh; resize: vertical;
  padding: 8px; font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
}
.ove-write-editor:focus, .ove-write-input:focus { outline: 0; border-color: var(--dsw-alias-state-business-primary); }
.ove-write-diff {
  max-height: 40vh; overflow: auto; padding: 6px 8px; font-family: var(--dsh-font-mono, ui-monospace, monospace);
  font-size: 11px; line-height: 1.5; background: var(--dsw-alias-bg-base);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-write-diff-row { display: flex; gap: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ove-write-diff-add { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-write-diff-remove { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-write-diff-mark { flex: none; width: 10px; color: var(--dsw-alias-label-dimmed); }
.ove-write-field { display: block; margin: 8px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ove-write-input {
  width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
}
.ove-write-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.ove-write-tag {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; font-size: 11px; line-height: 20px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
}
.ove-write-tag-remove {
  font: inherit; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-tertiary);
  background: 0 0; border: 0; cursor: pointer; padding: 0 1px;
}
.ove-write-append { display: flex; align-items: center; gap: 8px; }
.ove-write-append .ove-config-check { width: auto; }
.ove-write-tagbar { display: flex; align-items: center; gap: 6px; }
.ove-write-tagbar .ove-write-input { margin-top: 0; flex: 1; }
.ove-write-facts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 6px 0; }
.ove-write-facts dt { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-write-facts dd { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ove-write-footnote { margin: 8px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-write-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.ove-write-button {
  font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: 0 0;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
}
.ove-write-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-write-button:disabled { cursor: default; opacity: .5; }
.ove-write-primary { color: #fff; background: var(--dsw-alias-state-business-primary); border-color: transparent; }
.ove-write-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--dsw-alias-state-business-primary); }
.ove-write-danger { background: var(--dsw-alias-state-error-primary, #da3633); }
.ove-write-plan { margin: 6px 0; }
.ove-write-plan-title { display: block; font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 6px; }
.ove-write-plan pre {
  margin: 4px 0 0; padding: 6px 8px; background: var(--dsw-alias-bg-base);
  border-radius: var(--dsw-radius-sm); font-family: var(--dsh-font-mono, ui-monospace, monospace);
  font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto;
}

/* ---- the outcome toast ----------------------------------------------- */
.ove-toast-layer { display: flex; justify-content: center; align-items: flex-end; padding-bottom: 48px; }
.ove-toast {
  pointer-events: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  max-width: min(720px, calc(100vw - 32px)); padding: 8px 12px;
  font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-l1, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
}
.ove-toast-success { border-left: 2px solid var(--dsw-alias-state-success-primary, #3fb950); }
.ove-toast-warning { border-left: 2px solid var(--dsw-alias-state-warning-primary, #d29922); }
.ove-toast-error { border-left: 2px solid var(--dsw-alias-state-error-primary, #f85149); }
.ove-toast-text { overflow-wrap: anywhere; }
.ove-toast-scope { flex-basis: 100%; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-toast-action {
  font: inherit; font-size: 12px; color: var(--dsw-alias-state-business-primary);
  background: 0 0; border: 0; cursor: pointer; padding: 0 2px;
}
.ove-toast-action:disabled { opacity: .5; cursor: default; }
.ove-toast-details { color: var(--dsw-alias-label-tertiary); }
.ove-toast-dismiss {
  margin-left: auto; font: inherit; font-size: 14px; line-height: 1;
  color: var(--dsw-alias-label-tertiary); background: 0 0; border: 0; cursor: pointer; padding: 0 2px;
}
.ove-toast-error-line, .ove-toast-detail-line {
  flex-basis: 100%; margin: 2px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere;
}
.ove-toast-error-line { color: var(--dsw-alias-state-error-primary, #f85149); }

/* ---- the /viking command card ---------------------------------------- */
.ove-cmd {
  margin: 6px 0; padding: 8px 10px; background: var(--dsw-alias-bg-l1, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
}
.ove-cmd-plain {
  margin: 0; font-family: var(--dsh-font-mono, ui-monospace, monospace); font-size: 11px;
  line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
}
.ove-cmd-head { display: flex; align-items: baseline; gap: 8px; }
.ove-cmd-title { font-size: 12px; font-weight: 600; flex: none; }
.ove-cmd-target { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-cmd-scope { margin: 2px 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-cmd-hint { margin: 4px 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-cmd-error { margin: 4px 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-cmd-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.ove-cmd-tag {
  padding: 0 6px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-cmd-done { margin: 4px 0; font-size: 12px; color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-cmd-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }

/* ---- the Activity tab (F10/F11) -------------------------------------- */
.ove-act { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; }
.ove-act-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex: none;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
}
.ove-act-tabs { display: flex; align-items: center; gap: 4px; flex: 1; }
.ove-act-tab {
  font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer; color: var(--dsw-alias-label-tertiary);
  background: 0 0; border: 0; border-radius: 999px;
}
.ove-act-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-act-tab-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); font-weight: 500; }
.ove-act-section { padding: 8px 10px; overflow-y: auto; min-height: 0; }
.ove-act-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.ove-act-filters { display: flex; flex-wrap: wrap; gap: 4px; }
.ove-act-spacer { flex: 1; }
.ove-act-chip {
  font: inherit; font-size: 11px; line-height: 18px; padding: 0 8px; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); background: 0 0;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: 999px;
}
.ove-act-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-act-chip-active { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.ove-act-button {
  font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: 0 0;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
}
.ove-act-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-act-note { margin: 6px 0; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-act-error { margin: 6px 0; color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-act-error-inline { color: var(--dsw-alias-state-error-primary, #f85149); overflow-wrap: anywhere; }
.ove-act-task { border-bottom: .5px solid var(--dsw-alias-border-l3); padding: 2px 0; }
.ove-act-task-line { display: flex; align-items: center; gap: 6px; }
.ove-act-task-toggle {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 3px 2px;
  font: inherit; font-size: 12px; text-align: left; color: var(--dsw-alias-label-secondary);
  background: 0 0; border: 0; cursor: pointer;
}
.ove-act-caret { flex: none; color: var(--dsw-alias-label-tertiary); width: 10px; }
.ove-act-task-type { flex: none; color: var(--dsw-alias-label-primary); }
.ove-act-task-id { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-act-task-stage { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-act-task-error { color: var(--dsw-alias-state-error-primary, #f85149); font-weight: 600; }
.ove-act-task-age { margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-act-task-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.ove-act-link {
  font: inherit; font-size: 11px; color: var(--dsw-alias-state-business-primary);
  background: 0 0; border: 0; cursor: pointer; padding: 0; text-decoration: none;
}
.ove-act-danger { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-act-badge {
  flex: none; padding: 0 6px; font-size: 10px; line-height: 16px; border-radius: 999px;
  border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary);
}
.ove-act-badge-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-act-badge-bad { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-act-badge-busy { color: var(--dsw-alias-state-warning-primary, #d29922); }
.ove-act-detail { padding: 4px 0 8px 16px; }
.ove-act-facts { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: 4px 0; }
.ove-act-facts dt { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-act-facts dd { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ove-act-events { margin-top: 6px; }
.ove-act-subtitle { display: block; margin: 8px 0 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-act-event {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 1px 0;
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
}
.ove-act-event-seq { font-variant-numeric: tabular-nums; width: 18px; flex: none; }
.ove-act-event-kind { color: var(--dsw-alias-label-secondary); }
.ove-act-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.ove-act-card {
  padding: 8px 10px; background: var(--dsw-alias-bg-l1, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
}
.ove-act-card-title { display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-act-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.ove-act-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-tertiary); padding: 2px 4px; }
.ove-act-table td { color: var(--dsw-alias-label-secondary); padding: 2px 4px; font-variant-numeric: tabular-nums; }
.ove-act-diagnosis { margin-top: 6px; }
.ove-act-audit { margin: 4px 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.ove-act-audit li { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-act-audit-kind { color: var(--dsw-alias-label-secondary); }
.ove-act-audit-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
.ove-act-audit-time { margin-left: auto; flex: none; }

/* ---- preview action bar + settings profile editor -------------------- */
.ove-preview-actions { display: flex; align-items: center; gap: 6px; margin: 8px 0 4px; }
.ove-preview-actions-title { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ove-preview-danger { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-preview-spacer { flex: 1; }
.ove-config-profiles { display: flex; flex-direction: column; gap: 6px; }
.ove-config-profile-list { display: flex; flex-direction: column; gap: 4px; }
.ove-config-profile-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-config-profile-label { display: flex; flex-direction: column; min-width: 0; flex: 1; font-size: 12px; color: var(--dsw-alias-label-primary); }
.ove-config-profile-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ove-config-profile-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.ove-config-profile-form { display: flex; flex-direction: column; gap: 2px; }
.ove-pop-actions { display: flex; align-items: center; justify-content: flex-end; margin: 2px 0 6px; }
.ove-config-input[type='checkbox'] { width: auto; }
.ove-config-control select.ove-config-input { min-width: 0; }

/* ======================================================================
 * v0.7 native read cockpit
 *
 * One panel, internal views. The tree + preview split stacks under 720 px
 * (ResizeObserver toggles the wide/narrow classes); everything reuses the
 * preview/activity typography and the shell's alias variables, so the native
 * page reads as the same family as the right-Sidebar tabs.
 * ==================================================================== */
.ove-native { overflow: hidden; }
.ove-native-toolbar { flex: none; }
.ove-native-nav { display: flex; gap: 2px; }
.ove-native-nav button { min-width: 24px; padding: 1px 6px; }
.ove-native-tabs {
  flex: none; display: flex; gap: 2px; align-items: center; padding: 4px 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l3); overflow-x: auto;
}
.ove-native-tab {
  flex: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: var(--dsw-radius-sm); cursor: pointer;
}
.ove-native-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.ove-native-tab-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }
.ove-native-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.ove-native-toolbar-warnings { flex: none; padding: 2px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

.ove-nat-view { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.ove-nat-headline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ove-nat-headline-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-nat-muted { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ove-nat-spacer { flex: 1; }
.ove-nat-section { display: flex; flex-direction: column; gap: 6px; }
.ove-nat-section-title { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ove-nat-facts { display: flex; flex-wrap: wrap; gap: 6px 18px; }
.ove-nat-fact { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.ove-nat-fact-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ove-nat-fact code { color: var(--dsw-alias-label-secondary); }
.ove-nat-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px; }
.ove-nat-tile {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 10px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
}
.ove-nat-tile-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-nat-tile-value { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.ove-nat-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ove-nat-chip {
  display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
.ove-nat-chip-ok { color: var(--dsw-alias-state-success-primary, #3fb950); border-color: currentColor; }
.ove-nat-chip-bad { color: var(--dsw-alias-state-error-primary, #f85149); border-color: currentColor; }
.ove-nat-chip-muted { opacity: .8; }
.ove-nat-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ove-nat-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-nat-warnings { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-nat-part-error {
  display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; font-size: 12px;
  border: .5px solid var(--dsw-alias-border-l3); border-left: 2px solid var(--dsw-alias-state-warn-primary, #d29922);
  border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-secondary);
}
.ove-nat-part-error-label { font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.ove-nat-warnings-box {
  flex: none; margin: 4px 8px; padding: 4px 8px; font-size: 11px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
}
.ove-nat-warnings-box summary { cursor: pointer; color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-nat-warnings-box ul { margin: 4px 0 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
.ove-nat-partial {
  display: flex; gap: 8px; padding: 6px 10px; font-size: 12px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover);
}

/* ---- Studio view ------------------------------------------------------ */
.ove-nat-studio { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ove-nat-studio-note {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
  border-bottom: .5px solid var(--dsw-alias-border-l3);
}
.ove-nat-studio-blocked { border-left: 2px solid var(--dsw-alias-state-warn-primary, #d29922); }

/* ---- Browse: tree + preview ------------------------------------------ */
.ove-browse { flex: 1; min-height: 0; display: flex; }
.ove-browse-wide .ove-browse-tree-pane { width: 38%; min-width: 220px; }
.ove-browse-wide .ove-browse-preview-pane { flex: 1; border-left: .5px solid var(--dsw-alias-border-l3); }
.ove-browse-narrow { flex-direction: column; overflow-y: auto; }
.ove-browse-narrow .ove-browse-tree-pane { width: auto; max-height: 45%; }
.ove-browse-narrow .ove-browse-preview-pane { border-top: .5px solid var(--dsw-alias-border-l3); }
.ove-browse-tree-pane { display: flex; flex-direction: column; min-height: 0; }
.ove-browse-preview-pane { display: flex; flex-direction: column; min-height: 0; padding: 6px 10px 0; }
.ove-browse-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex: none; }
.ove-browse-tree { flex: 1; min-height: 0; overflow: auto; padding: 0 4px 12px; }
.ove-browse-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px; cursor: pointer;
  border-radius: var(--dsw-radius-sm); font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.ove-browse-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-browse-row-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ove-browse-root { font-weight: 500; color: var(--dsw-alias-label-primary); }
.ove-browse-twisty {
  flex: none; width: 16px; height: 16px; padding: 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 10px; line-height: 1;
}
.ove-browse-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-browse-kind { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); opacity: .8; }
.ove-browse-tag {
  flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; padding: 0 5px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-tertiary);
}
.ove-browse-size { flex: none; margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-browse-scope, .ove-browse-readonly { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); opacity: .8; }
.ove-browse-abstract { font-size: 11px; color: var(--dsw-alias-label-tertiary); padding-bottom: 2px; }
.ove-browse-shortcut { cursor: default; }
.ove-browse-shortcut-button {
  border: 0; background: transparent; color: var(--dsw-alias-state-business-primary); font: inherit; font-size: 12px;
  cursor: pointer; padding: 2px 4px; border-radius: var(--dsw-radius-sm);
}
.ove-browse-shortcut-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-browse-breadcrumb {
  flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; padding: 2px 0 6px;
}
.ove-browse-dir-tools { flex: none; display: flex; flex-direction: column; gap: 4px; padding-bottom: 6px; }
.ove-browse-dir-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ove-browse-subtree { max-height: 180px; overflow: auto; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); padding: 4px 6px; }
.ove-browse-subtree-list { margin: 0; padding: 0; list-style: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ove-browse-subtree-list li { display: flex; align-items: baseline; gap: 6px; padding: 1px 0; }
.ove-browse-subtree-name { overflow-wrap: anywhere; }
.ove-native-preview-body { padding-left: 0; padding-right: 0; }

/* ---- Sessions view ---------------------------------------------------- */
.ove-sess { flex: 1; min-height: 0; display: flex; }
.ove-sess-list-pane { display: flex; flex-direction: column; min-height: 0; width: 36%; min-width: 220px; }
.ove-sess-detail-pane { flex: 1; min-width: 0; overflow-y: auto; border-left: .5px solid var(--dsw-alias-border-l3); padding: 8px 12px 16px; }
.ove-sess-filters { display: flex; gap: 6px; align-items: center; padding: 0 8px 6px; flex: none; }
.ove-sess-filters .ove-config-input { font-size: 11px; padding: 2px 6px; min-width: 0; }
.ove-sess-filter { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-sess-list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 4px 8px; list-style: none; }
.ove-sess-row {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; border-radius: var(--dsw-radius-sm);
}
.ove-sess-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-sess-row-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ove-sess-id { font-size: 11px; overflow-wrap: anywhere; }
.ove-sess-time { margin-left: auto; flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ove-sess-more { flex: none; padding: 4px 8px 10px; }
.ove-sess-detail { display: flex; flex-direction: column; gap: 10px; }
.ove-sess-detail-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ove-sess-archives { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.ove-sess-archive-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.ove-sess-archive-id { font-weight: 500; color: var(--dsw-alias-label-primary); }
.ove-sess-diff { margin-top: 6px; padding: 6px 8px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }

/* ---- Commits view ----------------------------------------------------- */
.ove-commits-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.ove-commits-row { border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); padding: 6px 10px; }
.ove-commits-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }

/* ---- Preview body inline actions -------------------------------------- */
.ove-preview-inline-actions { display: inline-flex; gap: 4px; margin-left: 8px; vertical-align: middle; }

/* ---- Onboarding checklist --------------------------------------------- */
.ove-onb {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md, 8px);
}
.ove-onb-collapsed { flex-direction: row; align-items: center; }
.ove-onb-collapsed-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ove-onb-spacer { flex: 1; }
.ove-onb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ove-onb-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-onb-counts { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-onb-intro, .ove-onb-first-step, .ove-onb-privacy, .ove-onb-hint, .ove-onb-last-check {
  margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary);
}
.ove-onb-first-step { color: var(--dsw-alias-label-secondary); }
.ove-onb-error { margin: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-onb-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.ove-onb-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; }
.ove-onb-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.ove-onb-label { color: var(--dsw-alias-label-primary); }
.ove-onb-detail { margin-left: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-onb-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-onb-row-actions { flex: none; display: flex; align-items: center; }
.ove-onb-dot {
  flex: none; width: 16px; height: 16px; border-radius: 50%; font-size: 10px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; border: .5px solid currentColor;
}
.ove-onb-tone-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-onb-tone-warn { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-onb-tone-bad { color: var(--dsw-alias-state-error-primary, #f85149); }
.ove-onb-tone-unknown { color: var(--dsw-alias-label-tertiary); }
.ove-onb-badge { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.ove-onb-badge-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-onb-button {
  border: .5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: var(--dsw-radius-sm); cursor: pointer;
}
.ove-onb-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-onb-button:disabled { opacity: .4; cursor: not-allowed; }
.ove-onb-primary {
  border: 0; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-inverse, #fff);
  font: inherit; font-size: 11px; padding: 3px 10px; border-radius: var(--dsw-radius-sm); cursor: pointer;
}
.ove-onb-primary:disabled { opacity: .4; cursor: not-allowed; }
.ove-onb-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ove-onb-list-compact { margin-top: 2px; }


/* ---- v0.8 "Operate" ---------------------------------------------------- */
.ove-ops { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.ove-ops-tabs { display: flex; gap: 4px; border-bottom: .5px solid var(--dsw-alias-border-l3); padding-bottom: 4px; flex: none; }
.ove-ops-tab {
  border: .5px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; padding: 2px 10px; border-radius: var(--dsw-radius-sm); cursor: pointer;
}
.ove-ops-tab:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ove-ops-tab-active { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ove-ops-view { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; padding-bottom: 12px; }
.ove-ops-section { border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ove-ops-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ove-ops-section-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
.ove-ops-body { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow: auto; }
.ove-ops-toolbar { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.ove-ops-inline-field { flex-direction: row; align-items: center; gap: 6px; }
.ove-ops-inline-field .ove-write-input { min-width: 260px; }
.ove-ops-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ove-ops-mono { font-family: var(--dsw-font-mono, monospace); font-size: 11px; }
.ove-ops-extra { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-ops-table { border-collapse: collapse; width: 100%; font-size: 11px; }
.ove-ops-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-tertiary); padding: 3px 6px; vertical-align: top; width: 120px; }
.ove-ops-table td { padding: 3px 6px; color: var(--dsw-alias-label-secondary); vertical-align: top; word-break: break-word; }
.ove-ops-table-rows th { border-bottom: .5px solid var(--dsw-alias-border-l3); }
.ove-ops-table-rows td { border-bottom: .5px solid var(--dsw-alias-border-l3); }
.ove-ops-row { cursor: pointer; }
.ove-ops-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-ops-row-active { background: var(--dsw-alias-interactive-bg-hover); }
.ove-ops-pre {
  margin: 0; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--dsw-font-mono, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover); padding: 6px; border-radius: var(--dsw-radius-sm);
}
.ove-ops-preview { display: flex; flex-direction: column; gap: 4px; }
.ove-ops-banner { display: flex; flex-direction: column; gap: 2px; border-radius: var(--dsw-radius-sm); padding: 6px 8px; font-size: 11px; border: .5px solid var(--dsw-alias-border-l3); }
.ove-ops-banner-ok { border-color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-ops-banner-warn { border-color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-ops-done { color: var(--dsw-alias-state-success-primary, #3fb950); font-size: 12px; margin: 0; }
.ove-ops-partial { border: .5px solid var(--dsw-alias-state-warn-primary, #d29922); border-radius: var(--dsw-radius-sm); padding: 6px; }
.ove-ops-disabled-note { border: .5px dashed var(--dsw-alias-border-l3); padding: 6px; border-radius: var(--dsw-radius-sm); }
.ove-ops-inline-link { margin-left: 8px; }
.ove-stats-segments { display: flex; flex-direction: column; gap: 8px; }

/* ========================================================================
 * v0.9 "Native II — multi-scope": scope menu/banner/switch notice, session
 * mismatch banners and the Access (ACL) tab.
 * ===================================================================== */
.ove-scope-banner { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ove-scope-switch-notice {
  display: flex; align-items: center; gap: 8px; justify-content: space-between;
  font-size: 11px; padding: 4px 8px; border-radius: var(--dsw-radius-sm);
  border: .5px solid var(--dsw-alias-state-success-primary, #3fb950);
  color: var(--dsw-alias-label-secondary); margin: 0 8px;
}
.ove-scope-session-banner {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-size: 11px; padding: 4px 8px; border-radius: var(--dsw-radius-sm);
  border: .5px solid var(--dsw-alias-border-l3); margin: 4px 8px;
}
.ove-scope-session-mismatch { border-color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-scope-pipeline-mismatch { border-color: var(--dsw-alias-state-warn-primary, #d29922); border-style: dashed; }
.ove-scope-menu, .ove-scope-detail {
  position: absolute; z-index: 40; right: 0; top: calc(100% + 4px); min-width: 320px; max-width: 460px;
  max-height: 70vh; overflow: auto; display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-bg-elevated, #1f2428); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 6px); padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28);
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.ove-scope { position: relative; display: inline-flex; align-items: center; gap: 4px; }
.ove-scope-detail-head { display: flex; align-items: center; gap: 8px; }
.ove-scope-detail-title, .ove-scope-section-title { font-weight: 600; font-size: 12px; }
.ove-scope-close { background: none; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 15px; }
.ove-scope-rows { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.ove-scope-row { display: flex; gap: 8px; font-size: 11px; }
.ove-scope-row dt { width: 92px; flex: none; color: var(--dsw-alias-label-tertiary); }
.ove-scope-row dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-scope-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-scope-warn { margin: 0; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-scope-active-block { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; padding: 4px 0; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.ove-scope-groups { display: flex; flex-direction: column; gap: 6px; }
.ove-scope-group { display: flex; flex-direction: column; gap: 2px; }
.ove-scope-group-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); display: flex; gap: 4px; align-items: center; }
.ove-scope-profile {
  display: flex; align-items: center; gap: 6px; text-align: left; background: none;
  border: .5px solid transparent; border-radius: var(--dsw-radius-sm); padding: 4px 6px; cursor: pointer; color: inherit;
}
.ove-scope-profile:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ove-scope-profile:disabled { cursor: default; }
.ove-scope-profile-active { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); }
.ove-scope-row-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.ove-scope-row-label { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.ove-scope-row-meta { font-size: 10px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ove-scope-row-side { display: flex; gap: 4px; align-items: center; }
.ove-scope-active-pill, .ove-scope-override-pill, .ove-scope-key-pill {
  font-size: 9px; padding: 0 4px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase;
}
.ove-scope-override-pill { border-color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-scope-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); flex: none; }
.ove-scope-dot-ok { background: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-scope-dot-bad { background: var(--dsw-alias-state-error-primary, #f85149); }
.ove-scope-warn-glyph { color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-scope-identity { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ove-scope-field { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ove-scope-field input {
  background: var(--dsw-alias-bg-base, transparent); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-primary); padding: 3px 6px; font-size: 12px;
}
.ove-scope-field-disabled { opacity: .55; }
.ove-scope-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ove-scope-primary { border-color: var(--dsw-alias-border-l3); font-weight: 600; }
.ove-scope-menu-button { background: none; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 0; text-decoration: underline; }
.ove-scope-notices { display: flex; flex-direction: column; gap: 2px; }
.ove-browse-preview-tabs { display: flex; gap: 4px; padding: 4px 0; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.ove-browse-tab {
  background: none; border: .5px solid transparent; border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 2px 8px;
}
.ove-browse-tab-active { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.ove-acl-panel { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; }
.ove-acl-header { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ove-acl-state { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l3); }
.ove-acl-state-available { border-color: var(--dsw-alias-state-success-primary, #3fb950); }
.ove-acl-state-denied-no-manage { border-color: var(--dsw-alias-state-warn-primary, #d29922); }
.ove-acl-state-unsupported, .ove-acl-state-only-resources { border-color: var(--dsw-alias-border-l3); }
.ove-acl-table { display: flex; flex-direction: column; gap: 2px; }
.ove-acl-table-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.ove-acl { border-collapse: collapse; width: 100%; font-size: 11px; }
.ove-acl th { text-align: left; color: var(--dsw-alias-label-tertiary); font-weight: 600; padding: 2px 4px; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.ove-acl td { padding: 2px 4px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.ove-acl-sharing { margin: 0; font-size: 11px; border: .5px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); padding: 4px 6px; color: var(--dsw-alias-label-secondary); }
/* ======================================================================
 * v1.0 accessibility layer
 *
 * The plugin inherits the DSH shell's theme tokens; these rules make the
 * plugin's own widgets predictable for keyboard and low-vision users without
 * overriding the shell:
 *   - a visible focus ring on every plugin control (never removed);
 *   - reduced motion honoured globally for plugin transitions;
 *   - toolbars/dialogs survive 200% zoom (wrap / scroll instead of clipping);
 *   - status text keeps AA contrast against the shell tokens, with accessible
 *     fallbacks for both colour schemes when a token is absent.
 * ====================================================================== */

.ove-panel button:focus-visible,
.ove-panel a:focus-visible,
.ove-panel input:focus-visible,
.ove-panel select:focus-visible,
.ove-panel textarea:focus-visible,
.ove-panel summary:focus-visible,
.ove-panel [tabindex]:focus-visible,
.ove-overlay button:focus-visible,
.ove-overlay a:focus-visible,
.ove-overlay input:focus-visible,
.ove-overlay textarea:focus-visible,
.ove-overlay select:focus-visible,
.ove-scope button:focus-visible,
.ove-scope a:focus-visible,
.ove-pill button:focus-visible,
.ove-pill a:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4c8dff);
  outline-offset: 1px;
}

.ove-native-toolbar,
.ove-toolbar,
.ove-write-actions,
.ove-explore-bar,
.ove-browse-toolbar {
  flex-wrap: wrap;
  row-gap: 6px;
}

.ove-write-dialog {
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}

.ove-browse-tree {
  overflow-x: auto;
}

/* Status dots are decorative; the adjacent text/icon always carries the state. */
.ove-dot,
.ove-scope-dot,
.ove-health-dot,
.ove-tl-dot {
  flex: none;
}

@media (prefers-reduced-motion: reduce) {
  .ove-panel *,
  .ove-overlay * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}

/* Fallbacks only matter outside the DSH shell; keep them AA-readable per scheme. */
@media (prefers-color-scheme: light) {
  .ove-health-state-warn,
  .ove-pill-errored,
  .ove-recall-score-mid,
  .ove-diff-kind[data-kind="updates"] {
    color: var(--dsw-alias-state-warn-primary, #9a6700);
  }
  .ove-health-state-ok,
  .ove-health-state-good,
  .ove-recall-score-high,
  .ove-diff-kind[data-kind="adds"] {
    color: var(--dsw-alias-state-success-primary, #1a7f37);
  }
  .ove-health-state-bad,
  .ove-error,
  .ove-recall-score-low,
  .ove-diff-kind[data-kind="deletes"] {
    color: var(--dsw-alias-state-error-primary, #cf222e);
  }
}
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
