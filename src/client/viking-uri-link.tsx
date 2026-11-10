/**
 * F5: one link component for every `viking://` path the plugin renders.
 *
 * Deep links exist so a URI a person can read is a URI they can open: clicking
 * one switches the right Sidebar to the preview tab and selects that entry. The
 * component deliberately renders a real `<button>` (not an `<a href="#">`):
 * there is no URL to navigate to — the preview tab is the destination — and a
 * button gets keyboard activation and focus semantics for free.
 *
 * It is only mounted inside non-interactive containers (detail blocks, list
 * rows), never nested inside another button: the recall and explanation rows are
 * whole-card buttons, so their URIs become links in the expanded detail block
 * instead, which also keeps the collapsed row's click-to-expand behaviour.
 */
import type { ReactNode } from 'react'
import { openPreview } from './preview-store.ts'

export interface VikingUriLinkProps {
  /** The `viking://…` path this link opens. Rendered as the title tooltip. */
  uri: string
  /** What to show instead of the full URI (optional). */
  label?: string | null
  /** Extra class for placement-specific styling. */
  className?: string
  /** Fully custom content; falls back to the label or the URI. */
  children?: ReactNode
}

/**
 * The plugin-wide `viking://` deep link.
 *
 * `stopPropagation` keeps a click from also toggling a surrounding summary
 * row when one is present; every caller today is already in a plain container,
 * so this is defensive rather than load-bearing.
 */
export function VikingUriLink({ uri, label, className, children }: VikingUriLinkProps) {
  const classes = className === undefined ? 'ove-uri-link' : `ove-uri-link ${className}`
  return (
    <button
      type="button"
      className={classes}
      title={uri}
      onClick={(event) => {
        event.stopPropagation()
        openPreview(uri, label ?? null)
      }}
    >
      {children ?? label ?? uri}
    </button>
  )
}
