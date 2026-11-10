/**
 * Keyboard / ARIA primitives for the plugin's custom widgets.
 *
 * DSH has no dialog primitive, so this plugin owns the semantics of its own
 * interactive surfaces: the native cockpit tabs, the Browse tree, the scope menu,
 * the write/ops dialogs and the outcome toast. v1.0 aligns them with WCAG 2.2 AA
 * expectations for keyboard and screen-reader users:
 *
 *  - **roving tabindex** for composite widgets (tree rows, tab strips): exactly
 *    one focusable item at a time, arrow keys move between items, Home/End jump;
 *  - **focus trap/restore** for modal dialogs: Tab cycles inside the dialog and
 *    closing returns focus to the control that opened it;
 *  - **live regions** for async outcomes, with a tone→role mapping.
 *
 * The *policy* lives here as pure functions (and one React hook) so the tests can
 * assert exact keyboard behaviour under Node, without a browser. Components own
 * the DOM effects; this module never touches the network or persistence.
 */
import { useCallback, useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'

/** Focusable descendants a modal dialog may cycle through. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Clamp an index into `[0, count)`; `-1` when the list is empty. */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return -1
  if (!Number.isFinite(index)) return 0
  return ((Math.trunc(index) % count) + count) % count
}

/**
 * The next focused item for a roving-focus widget.
 *
 * Vertical widgets (trees) move with Up/Down, horizontal ones (tabs) with
 * Left/Right; both support Home/End and wrap around. Unknown keys return `null`
 * so the component can leave the event alone (typing, shortcuts, Enter/Space).
 */
export function nextRovingIndex(
  current: number,
  count: number,
  key: string,
  orientation: 'vertical' | 'horizontal' = 'vertical',
): number | null {
  if (count <= 0) return null
  const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
  switch (key) {
    case nextKey:
      return clampIndex(current + 1, count)
    case previousKey:
      return clampIndex(current - 1, count)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Tab-strip keyboard movement (ARIA tabs are horizontal). */
export function nextTabIndex(current: number, count: number, key: string): number | null {
  return nextRovingIndex(current, count, key, 'horizontal')
}

/**
 * The next focus target for a trapped Tab press.
 *
 * `shift` moves backwards; both directions wrap. When the active element is not
 * inside the dialog (index `-1`), forward Tab goes to the first focusable and
 * Shift+Tab to the last — a dialog that opened before focus landed still traps.
 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return clampIndex(current + (shift ? -1 : 1), count)
}

/** The ARIA live-region attributes for one toast/status tone. */
export function liveRegionForTone(tone: 'success' | 'warning' | 'error' | 'info'): {
  role: 'status' | 'alert'
  'aria-live': 'polite' | 'assertive'
  'aria-atomic': 'true'
} {
  const assertive = tone === 'error'
  return {
    role: assertive ? 'alert' : 'status',
    'aria-live': assertive ? 'assertive' : 'polite',
    'aria-atomic': 'true',
  }
}

/**
 * A modal dialog's focus life-cycle.
 *
 * On mount it remembers the opener, and it listens for Tab at the dialog
 * container: focus wraps at both ends so Tab can never reach the page behind the
 * modal (WCAG 2.2 keyboard-trap requirement). On unmount the opener gets focus
 * back. Escape handling stays with the dialog's own close handler so the two
 * cannot fight.
 */
export function useModalFocus(dialogRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null || typeof document === 'undefined') return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const list = focusable()
      if (list.length === 0) {
        event.preventDefault()
        return
      }
      const index = list.indexOf(document.activeElement as HTMLElement)
      const target = nextFocusIndex(index, list.length, event.shiftKey)
      if (target < 0) return
      // Only intervene at the ends: inside the dialog the browser's own Tab order
      // (including form controls) is the most predictable behaviour.
      if (index === -1 || (event.shiftKey ? index === 0 : index === list.length - 1)) {
        event.preventDefault()
        list[target]?.focus()
      }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      opener?.focus?.()
    }
  }, [dialogRef])
}

/**
 * Tab-strip state helper: roving `tabIndex`, Arrow/Home/End selection, ids and
 * `aria-controls` wiring for the tab and its panel.
 *
 * The hook focuses the newly selected tab after React commits it (one
 * `requestAnimationFrame`), which is what makes arrow-key navigation usable from
 * a keyboard alone.
 */
export function useA11yTabs<Id extends string>(
  ids: readonly Id[],
  activeId: Id,
  onSelect: (id: Id) => void,
): {
  tabListProps: {
    role: 'tablist'
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  }
  tabProps: (id: Id) => {
    role: 'tab'
    id: string
    'aria-selected': boolean
    'aria-controls': string
    tabIndex: number
    onClick: () => void
    ref: (element: HTMLButtonElement | null) => void
  }
  panelProps: (id: Id) => { role: 'tabpanel'; id: string; 'aria-labelledby': string }
} {
  const refs = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({})
  const focusRequest = useRef<Id | null>(null)
  // A unique prefix per tab strip: two preview panes (Browse + Preview tab) can
  // be mounted at once, and duplicate DOM ids would break `aria-controls`.
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  useEffect(() => {
    const target = focusRequest.current
    if (target === null) return
    focusRequest.current = null
    refs.current[target]?.focus()
  })

  const activate = useCallback(
    (id: Id) => {
      focusRequest.current = id
      onSelect(id)
    },
    [onSelect],
  )

  return {
    tabListProps: {
      role: 'tablist',
      onKeyDown: (event) => {
        const index = ids.indexOf(activeId)
        const target = nextTabIndex(index, ids.length, event.key)
        if (target === null) return
        event.preventDefault()
        const next = ids[target]
        if (next !== undefined) activate(next)
      },
    },
    tabProps: (id) => ({
      role: 'tab',
      id: `ove-tab-${idPrefix}-${id}`,
      'aria-selected': activeId === id,
      'aria-controls': `ove-tabpanel-${idPrefix}-${id}`,
      tabIndex: activeId === id ? 0 : -1,
      onClick: () => activate(id),
      ref: (element) => {
        refs.current[id] = element
      },
    }),
    panelProps: (id) => ({
      role: 'tabpanel',
      id: `ove-tabpanel-${idPrefix}-${id}`,
      'aria-labelledby': `ove-tab-${idPrefix}-${id}`,
    }),
  }
}

/** One visible row of a flattened tree, for keyboard navigation. */
export interface TreeRowFacts {
  uri: string
  /** Parent row's URI; null for a root row. */
  parentUri: string | null
  isDir: boolean
  expanded: boolean
}

/** What a tree keypress should do next. */
export interface TreeKeyAction {
  /** Row that should receive focus, when movement was requested. */
  focus: string | null
  /** Expand/collapse the current row (ArrowRight/ArrowLeft on a directory). */
  toggle: 'expand' | 'collapse' | null
  /** Activate (select/preview) the current row (Enter/Space). */
  select: boolean
}

/**
 * The tree keyboard model (ARIA tree pattern):
 *
 *  - Up/Down move between visible rows, Home/End to the ends;
 *  - Right expands a collapsed directory, otherwise moves into its first child;
 *  - Left collapses an expanded directory, otherwise moves to the parent row;
 *  - Enter/Space select (the caller opens the preview).
 *
 * `rows` must be the flattened list of *visible* rows in display order, which is
 * also how `aria-level`/roving tabindex are computed. Returning `null` means the
 * key is not a tree key and the caller should leave the event alone.
 */
export function treeKeyTarget(
  rows: readonly TreeRowFacts[],
  currentUri: string | null,
  key: string,
): TreeKeyAction | null {
  const index = currentUri === null ? -1 : rows.findIndex((row) => row.uri === currentUri)
  if (index === -1) {
    if (key === 'ArrowDown' || key === 'Home') return { focus: rows[0]?.uri ?? null, toggle: null, select: false }
    return null
  }
  const current = rows[index] as TreeRowFacts
  switch (key) {
    case 'ArrowDown':
      return { focus: rows[clampIndex(index + 1, rows.length)]?.uri ?? null, toggle: null, select: false }
    case 'ArrowUp':
      return { focus: rows[clampIndex(index - 1, rows.length)]?.uri ?? null, toggle: null, select: false }
    case 'Home':
      return { focus: rows[0]?.uri ?? null, toggle: null, select: false }
    case 'End':
      return { focus: rows[rows.length - 1]?.uri ?? null, toggle: null, select: false }
    case 'ArrowRight': {
      if (!current.isDir) return null
      if (!current.expanded) return { focus: current.uri, toggle: 'expand', select: false }
      const firstChild = rows[index + 1]
      if (firstChild === undefined || firstChild.parentUri !== current.uri) return null
      return { focus: firstChild.uri, toggle: null, select: false }
    }
    case 'ArrowLeft': {
      if (current.isDir && current.expanded) return { focus: current.uri, toggle: 'collapse', select: false }
      if (current.parentUri === null) return null
      return { focus: current.parentUri, toggle: null, select: false }
    }
    case 'Enter':
    case ' ':
      return { focus: current.uri, toggle: null, select: true }
    default:
      return null
  }
}

/** One tree node's child-list facts, enough to flatten the visible rows. */
export interface TreeChildFacts {
  uri: string
  isDir: boolean
}

/**
 * Flatten a tree's *visible* rows in display order.
 *
 * `childrenOf(uri)` returns the loaded children of a directory (undefined when
 * not loaded); only expanded directories contribute children, exactly as the
 * DOM renders them. The result drives roving focus, `aria-level` and the
 * keyboard model, so the flattening is one shared, testable step rather than
 * duplicated inline logic.
 */
export function flattenTreeRows(
  roots: ReadonlyArray<{ uri: string; shortcut?: boolean }>,
  childrenOf: (uri: string) => readonly TreeChildFacts[] | undefined,
  isExpanded: (uri: string) => boolean,
): Array<TreeRowFacts & { depth: number }> {
  const rows: Array<TreeRowFacts & { depth: number }> = []
  const walk = (parentUri: string, depth: number): void => {
    const children = childrenOf(parentUri) ?? []
    for (const child of children) {
      const expanded = isExpanded(child.uri)
      rows.push({ uri: child.uri, parentUri, isDir: child.isDir, expanded, depth })
      if (child.isDir && expanded) walk(child.uri, depth + 1)
    }
  }
  for (const root of roots) {
    if (root.shortcut === true) continue
    const expanded = isExpanded(root.uri)
    rows.push({ uri: root.uri, parentUri: null, isDir: true, expanded, depth: 0 })
    if (expanded) walk(root.uri, 1)
  }
  return rows
}

/**
 * Arrow navigation for a menu/`menuitem` list: Up/Down wrap, Home/End jump.
 * Unlike a roving *selection* model, a menu moves focus without changing the
 * current value, so it reuses the same index arithmetic but never activates.
 */
export function nextMenuIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return clampIndex(current + 1, count)
    case 'ArrowUp':
      return clampIndex(current - 1, count)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
