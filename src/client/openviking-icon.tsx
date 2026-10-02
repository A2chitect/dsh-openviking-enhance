/**
 * The plugin's glyph — one definition, used by both mounts.
 *
 * It appears in the left sidebar (the panel row draws only the glyph; the shell
 * owns the button, label and active highlight) and in the session commit pill, so
 * the two read as the same thing. Keeping it in one module is what makes that
 * true by construction rather than by two SVGs happening to match.
 *
 * A knowledge-graph mark — two linked nodes with an open ring each — rather than a
 * generic archive/database glyph, so the pill cannot be mistaken for a git commit
 * or a token counter. The pill's "OV" prefix carries the same disambiguation in
 * text, for the cases where a 14px glyph is not enough.
 *
 * Sizing: like the shell's own icons, this renders at whatever `size` it is given
 * and inherits `currentColor`. Stroke weight is a prop because the sidebar draws
 * it at 16–18px (1.3 reads correctly there) while the status row's pills all use
 * 1px strokes at 14px, and a 14px glyph at 1.3 looks visibly heavier than its
 * neighbours.
 */
export interface OpenVikingIconProps {
  /** Square edge in pixels. The shell passes the requested row size. */
  size?: number
  /** Stroke width; the status pill passes 1 to match the default pills. */
  strokeWidth?: number
  /** Panel-row selected state, supplied by the sidebar slot and not drawn here. */
  active?: boolean
  /** Any further attribute is forwarded to the `<svg>`. */
  [attribute: string]: unknown
}

export function OpenVikingIcon({ size = 16, strokeWidth = 1.3, active, ...rest }: OpenVikingIconProps) {
  void active
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="5" cy="5" r="2.1" />
      <circle cx="11" cy="11" r="2.1" />
      <path d="M6.5 6.5 9.5 9.5" />
      <path d="M11 3.2c1.2 0 2 .8 2 2" />
      <path d="M3 10.8c0 1.2.8 2 2 2" />
    </svg>
  )
}
