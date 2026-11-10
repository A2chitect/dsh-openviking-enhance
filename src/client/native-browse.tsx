/**
 * The native Browse view: a lazy `viking://` tree plus a read-only preview pane.
 *
 * Data rules (Lead sign-off §4 — cost budgets):
 *  - the host resolves the roots from the identity; the client never hardcodes
 *    `viking://user/<user>/…`;
 *  - expanding a directory is ONE host request for its first 50 rows; "Load more"
 *    pages with the server cursor; nothing is auto-expanded recursively; every
 *    in-flight read is aborted on refresh, view change and unmount;
 *  - "Show subtree" is the single bounded `fs/tree` action (≤2 levels, ≤100
 *    nodes) and is labelled with its cost;
 *  - the preview pane is the shared `PreviewBody` in read-only mode: no write
 *    path can be reached from the cockpit; curation stays in the Preview tab,
 *    which the pane links to.
 *
 * Deep links (`{view:'browse', browse:{uri}}`) expand the ancestor path one level
 * at a time so the requested node is visible and selected.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowseEntry,
  BrowseRoot,
  BrowseSubtreePayload,
  PluginNotice,
} from '../shared/protocol.ts'
import { fetchBrowsePage, fetchBrowseRoots, fetchBrowseSubtree } from './host-api.ts'
import { t, writeErrorText } from './locale.ts'
import { navigate, useNative } from './native-store.ts'
import { formatBytes, PreviewBody } from './preview-body.tsx'
import { openPreview } from './preview-store.ts'
import { openRightTab } from './tab-store.ts'
import { NativeWarnings } from './native-warnings.tsx'

interface NodeState {
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  entries: BrowseEntry[]
  hasMore: boolean
  nextOffset: number | null
}

const EMPTY_NODE: NodeState = {
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null,
  entries: [],
  hasMore: false,
  nextOffset: null,
}

interface SubtreeState {
  uri: string
  loading: boolean
  error: string | null
  payload: BrowseSubtreePayload | null
}

export interface NativeBrowseProps {
  refreshKey: number
}

/** Width under which the tree and preview stack into one column. */
const WIDE_BREAKPOINT = 720

/** Append host warnings without duplicating an identical code+params pair. */
function mergeWarnings(current: readonly PluginNotice[], next: readonly PluginNotice[]): PluginNotice[] {
  const seen = new Set(current.map((warning) => `${warning.code}:${JSON.stringify(warning.params ?? {})}`))
  const merged = [...current]
  for (const warning of next) {
    const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(warning)
  }
  return merged
}

function ScopeBadge({ root }: { root: BrowseRoot }) {
  if (root.scope === 'user') return null
  return <span className="ove-browse-scope">{t(`browse.scope.${root.scope}`)}</span>
}

function ReadOnlyBadge({ root }: { root: BrowseRoot }) {
  if (root.scope === 'user') return null
  return <span className="ove-browse-readonly">{t('browse.readOnly')}</span>
}

/** The read-only directory tools: child count and the bounded subtree action. */
function DirectoryTools(props: {
  uri: string
  entryCount: number | null
  /** The loaded page says more entries exist: the count is a lower bound. */
  more: boolean
  subtree: SubtreeState | null
  onSubtree: () => void
}) {
  const { subtree } = props
  return (
    <div className="ove-browse-dir-tools">
      <div className="ove-browse-dir-line">
        {props.entryCount !== null && (
          <span className="ove-nat-muted">
            {props.more ? t('browse.entryCountMore', { count: props.entryCount }) : t('browse.entryCount', { count: props.entryCount })}
          </span>
        )}
        <button type="button" className="ove-preview-button" disabled={subtree?.loading === true} onClick={props.onSubtree}>
          {subtree?.loading === true ? t('native.loading') : t('browse.showSubtree')}
        </button>
        <span className="ove-preview-hint">{t('browse.subtreeCost')}</span>
      </div>
      {subtree !== null && subtree.error !== null && <p className="ove-preview-error">{subtree.error}</p>}
      {subtree !== null && subtree.payload !== null && (
        <div className="ove-browse-subtree">
          {subtree.payload.entries.length === 0 ? (
            <p className="ove-preview-hint">{t('browse.emptyDirectory')}</p>
          ) : (
            <ul className="ove-browse-subtree-list">
              {subtree.payload.entries.map((entry) => (
                <li key={entry.uri} style={{ paddingLeft: entry.depth * 14 }}>
                  <span className="ove-browse-subtree-name" title={entry.uri}>
                    {entry.isDir ? '▸ ' : ''}
                    {entry.relPath}
                  </span>
                  <span className="ove-browse-kind">{t(`browse.kind.${entry.kind}`)}</span>
                </li>
              ))}
            </ul>
          )}
          {subtree.payload.truncated && <p className="ove-preview-hint">{t('browse.subtreeTruncated')}</p>}
        </div>
      )}
    </div>
  )
}

export function NativeBrowse(props: NativeBrowseProps) {
  const native = useNative()
  const [roots, setRoots] = useState<BrowseRoot[]>([])
  const [rootsLoading, setRootsLoading] = useState(true)
  const [rootsError, setRootsError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [subtree, setSubtree] = useState<SubtreeState | null>(null)
  const [warnings, setWarnings] = useState<PluginNotice[]>([])
  const [wide, setWide] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)
  const deepLinkHandled = useRef<string>('')
  /**
   * One request cycle per mount/refresh. Collapsing a node, switching views,
   * refreshing or unmounting aborts every read started in the current cycle, so
   * the host's upstream `fs/ls` read stops too (the route cancels on response
   * close). The signal travels into every `fetchBrowse*` call below.
   */
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    return () => {
      controller.abort()
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [props.refreshKey])

  const requestSignal = useCallback((): AbortSignal | undefined => abortRef.current?.signal, [])

  const loadRoots = useCallback(
    async (fresh: boolean): Promise<BrowseRoot[]> => {
      // Snapshot the signal this request belongs to: a Refresh/unmount aborts it
      // and swaps the ref, so re-reading the ref afterwards would misread the
      // aborted answer as a host failure (or set state on a dead component).
      const signal = requestSignal()
      setRootsLoading(true)
      const answer = await fetchBrowseRoots(fresh, signal)
      if (signal?.aborted === true) return []
      if (!answer.ok) {
        setRootsError(writeErrorText(answer.error))
        setRootsLoading(false)
        return []
      }
      setRoots(answer.roots)
      setRootsError(null)
      setWarnings((current) => mergeWarnings(current, answer.warnings))
      setRootsLoading(false)
      return answer.roots
    },
    [requestSignal],
  )

  const loadNode = useCallback(
    async (uri: string, options: { offset?: number; append?: boolean; fresh?: boolean } = {}): Promise<void> => {
      const signal = requestSignal()
      setNodes((current) => ({
        ...current,
        [uri]: { ...(current[uri] ?? EMPTY_NODE), loading: options.append !== true, loadingMore: options.append === true, error: null },
      }))
      const answer = await fetchBrowsePage(uri, {
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        fresh: options.fresh === true,
        signal,
      })
      if (signal?.aborted === true) return
      if (!answer.ok) {
        setNodes((current) => ({
          ...current,
          [uri]: { ...(current[uri] ?? EMPTY_NODE), loading: false, loadingMore: false, error: writeErrorText(answer.error) },
        }))
        return
      }
      const page = answer.page
      setWarnings((current) => mergeWarnings(current, page.warnings))
      setNodes((current) => {
        const previous = current[uri] ?? EMPTY_NODE
        return {
          ...current,
          [uri]: {
            loaded: true,
            loading: false,
            loadingMore: false,
            error: null,
            entries: options.append === true ? [...previous.entries, ...page.entries] : page.entries,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
          },
        }
      })
    },
    [requestSignal],
  )

  // Roots on first entry and on an explicit Refresh.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await loadRoots(props.refreshKey > 0)
      if (cancelled) return
      if (props.refreshKey > 0) {
        setNodes({})
        setExpanded({})
        setSubtree(null)
        setWarnings([])
        if (list.length > 0) setSelected((current) => (current !== null && list.some((root) => current.startsWith(root.uri)) ? current : null))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.refreshKey, loadRoots])

  // Responsive two-pane layout; the CSS classes do the rest. ResizeObserver is
  // absent in server renders and very old harnesses — wide is the safe default.
  useEffect(() => {
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? 0
      if (width > 0) setWide(width >= WIDE_BREAKPOINT)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toggleNode = useCallback(
    (uri: string): void => {
      setExpanded((current) => {
        if (current[uri] === true) {
          const next = { ...current }
          delete next[uri]
          return next
        }
        if (nodes[uri]?.loaded !== true) void loadNode(uri)
        return { ...current, [uri]: true }
      })
    },
    [nodes, loadNode],
  )

  const select = useCallback(
    (uri: string): void => {
      setSelected(uri)
      setSubtree(null)
    },
    [],
  )

  // Deep link: expand the ancestor path one level at a time, then select.
  useEffect(() => {
    if (native.view !== 'browse') return
    const uri = native.target.browse?.uri
    if (uri === undefined) return
    const key = `${native.target.view}:${uri}`
    if (deepLinkHandled.current === key) return
    deepLinkHandled.current = key
    let cancelled = false
    void (async () => {
      let list = roots
      if (list.length === 0) list = await loadRoots(false)
      if (cancelled || list.length === 0) return
      const root = list
        .filter((candidate) => candidate.shortcut !== true && (uri === candidate.uri || uri.startsWith(`${candidate.uri}/`)))
        .sort((left, right) => right.uri.length - left.uri.length)[0]
      if (root === undefined) {
        setSelected(uri)
        return
      }
      const segments = uri.slice(root.uri.length).split('/').filter((segment) => segment.length > 0)
      let current = root.uri
      await loadNode(current)
      if (cancelled) return
      setExpanded((state) => ({ ...state, [current]: true }))
      for (const segment of segments.slice(0, -1)) {
        current = `${current}/${segment}`
        await loadNode(current)
        if (cancelled) return
        setExpanded((state) => ({ ...state, [current]: true }))
      }
      setSelected(uri)
    })()
    return () => {
      cancelled = true
    }
  }, [native.view, native.target, roots, loadRoots, loadNode])

  const loadSubtree = useCallback(
    async (uri: string): Promise<void> => {
      setSubtree({ uri, loading: true, error: null, payload: null })
      // Capture THIS request's signal (same reason as loadRoots/loadNode).
      const signal = requestSignal()
      const answer = await fetchBrowseSubtree(uri, { signal })
      if (signal?.aborted === true) return
      if (!answer.ok) {
        setSubtree({ uri, loading: false, error: writeErrorText(answer.error), payload: null })
        return
      }
      setWarnings((current) => mergeWarnings(current, answer.subtree.warnings))
      setSubtree({ uri, loading: false, error: null, payload: answer.subtree })
    },
    [requestSignal],
  )

  const renderEntry = (entry: BrowseEntry, depth: number) => {
    const node = nodes[entry.uri]
    const isExpanded = expanded[entry.uri] === true
    return (
      <div key={entry.uri}>
        <div
          className={`ove-browse-row${selected === entry.uri ? ' ove-browse-row-active' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          role="treeitem"
          aria-expanded={entry.isDir ? isExpanded : undefined}
          onClick={() => select(entry.uri)}
        >
          {entry.isDir ? (
            <button
              type="button"
              className="ove-browse-twisty"
              title={isExpanded ? t('browse.collapse') : t('browse.expand')}
              onClick={(event) => {
                event.stopPropagation()
                toggleNode(entry.uri)
              }}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="ove-browse-twisty" aria-hidden="true" />
          )}
          <span className="ove-browse-name" title={entry.uri}>
            {entry.name}
          </span>
          <span className="ove-browse-kind">{t(`browse.kind.${entry.kind}`)}</span>
          {entry.tags.slice(0, 3).map((tag) => (
            <span className="ove-browse-tag" key={tag}>
              {tag}
            </span>
          ))}
          {entry.modifiedAt !== null && <span className="ove-browse-size">{entry.modifiedAt.slice(0, 10)}</span>}
          {!entry.isDir && entry.size !== null && <span className="ove-browse-size">{formatBytes(entry.size)}</span>}
        </div>
        {entry.abstract !== null && !entry.isDir && (
          <div className="ove-browse-abstract" style={{ paddingLeft: 24 + depth * 14 }}>
            {entry.abstract}
          </div>
        )}
        {entry.isDir && isExpanded && (
          <div role="group">
            {node === undefined || (!node.loaded && node.loading) ? (
              <p className="ove-preview-hint" style={{ paddingLeft: 24 + depth * 14 }}>
                {t('native.loading')}
              </p>
            ) : node.error !== null ? (
              <p className="ove-preview-error" style={{ paddingLeft: 24 + depth * 14 }}>
                {node.error}{' '}
                <button type="button" className="ove-preview-button" onClick={() => void loadNode(entry.uri)}>
                  {t('native.retry')}
                </button>
              </p>
            ) : node.entries.length === 0 ? (
              <p className="ove-preview-hint" style={{ paddingLeft: 24 + depth * 14 }}>
                {t('browse.emptyDirectory')}
              </p>
            ) : (
              <>
                {node.entries.map((child) => renderEntry(child, depth + 1))}
                {node.hasMore && (
                  <button
                    type="button"
                    className="ove-preview-button"
                    style={{ marginLeft: 24 + depth * 14 }}
                    disabled={node.loadingMore}
                    onClick={() => {
                      if (node.nextOffset === null) return
                      void loadNode(entry.uri, { offset: node.nextOffset, append: true })
                    }}
                  >
                    {node.loadingMore ? t('native.loading') : t('browse.loadMore')}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderRoot = (root: BrowseRoot) => {
    if (root.shortcut === true) {
      return (
        <div key={root.id} className="ove-browse-row ove-browse-shortcut">
          <button
            type="button"
            className="ove-browse-shortcut-button"
            onClick={() => {
              if (root.id === 'sessions') navigate({ view: 'sessions' })
              else openRightTab('openviking-explore')
            }}
          >
            {t(root.labelKey)} →
          </button>
        </div>
      )
    }
    const node = nodes[root.uri]
    const isExpanded = expanded[root.uri] === true
    return (
      <div key={root.id}>
        <div
          className={`ove-browse-row ove-browse-root${selected === root.uri ? ' ove-browse-row-active' : ''}`}
          role="treeitem"
          aria-expanded={isExpanded}
          onClick={() => select(root.uri)}
        >
          <button
            type="button"
            className="ove-browse-twisty"
            onClick={(event) => {
              event.stopPropagation()
              toggleNode(root.uri)
            }}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
          <span className="ove-browse-name">{t(root.labelKey)}</span>
          <ScopeBadge root={root} />
          <ReadOnlyBadge root={root} />
        </div>
        {isExpanded && (
          <div role="group">
            {node === undefined || (!node.loaded && node.loading) ? (
              <p className="ove-preview-hint" style={{ paddingLeft: 24 }}>
                {t('native.loading')}
              </p>
            ) : node.error !== null ? (
              <p className="ove-preview-error" style={{ paddingLeft: 24 }}>
                {node.error}{' '}
                <button type="button" className="ove-preview-button" onClick={() => void loadNode(root.uri)}>
                  {t('native.retry')}
                </button>
              </p>
            ) : node.entries.length === 0 ? (
              <p className="ove-preview-hint" style={{ paddingLeft: 24 }}>
                {t(`browse.empty.${root.id}`)} — {t('browse.emptyDirectoryHint')}
              </p>
            ) : (
              <>
                {node.entries.map((child) => renderEntry(child, 1))}
                {node.hasMore && (
                  <button
                    type="button"
                    className="ove-preview-button"
                    style={{ marginLeft: 24 }}
                    disabled={node.loadingMore}
                    onClick={() => {
                      if (node.nextOffset === null) return
                      void loadNode(root.uri, { offset: node.nextOffset, append: true })
                    }}
                  >
                    {node.loadingMore ? t('native.loading') : t('browse.loadMore')}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  const selectedEntry = selected === null ? null : findEntry(nodes, selected)
  const selectedNode = selected === null ? undefined : nodes[selected]
  const childCount = selected === null ? null : (selectedNode?.entries.length ?? null)
  const childHasMore = selectedNode?.hasMore === true
  const showDirectoryTools = selected !== null && selectedEntry?.isDir === true

  return (
    <div ref={rootRef} className={`ove-browse${wide ? ' ove-browse-wide' : ' ove-browse-narrow'}`}>
      <div className="ove-browse-tree-pane">
        <div className="ove-browse-toolbar">
          <span className="ove-nat-section-title">{t('native.view.browse')}</span>
          <span className="ove-nat-spacer" />
          <button type="button" className="ove-preview-button" onClick={() => void loadRoots(true)}>
            {t('native.refresh')}
          </button>
        </div>
        <NativeWarnings warnings={warnings} />
        {rootsLoading && roots.length === 0 ? (
          <p className="ove-preview-status">{t('native.loading')}</p>
        ) : rootsError !== null ? (
          <div>
            <p className="ove-preview-error">{rootsError}</p>
            <button type="button" className="ove-preview-button" onClick={() => void loadRoots(true)}>
              {t('native.retry')}
            </button>
          </div>
        ) : (
          <div role="tree" className="ove-browse-tree">
            {roots.map(renderRoot)}
          </div>
        )}
      </div>
      <div className="ove-browse-preview-pane">
        {selected === null ? (
          <p className="ove-preview-hint">{t('browse.selectHint')}</p>
        ) : (
          <>
            <div className="ove-browse-breadcrumb" title={selected}>
              {selected}
            </div>
            {showDirectoryTools && (
              <DirectoryTools
                uri={selected}
                entryCount={childCount}
                more={childHasMore}
                subtree={subtree}
                onSubtree={() => void loadSubtree(selected)}
              />
            )}
            <PreviewBody
              uri={selected}
              readOnly
              refreshKey={props.refreshKey}
              onOpenInActions={(uri) => openPreview(uri)}
              className="ove-native-preview-body"
            />
          </>
        )}
      </div>
    </div>
  )
}

/** Find one entry anywhere in the loaded node map (for the selected row's kind). */
function findEntry(nodes: Record<string, NodeState>, uri: string): BrowseEntry | null {
  for (const node of Object.values(nodes)) {
    for (const entry of node.entries) {
      if (entry.uri === uri) return entry
    }
  }
  return null
}
