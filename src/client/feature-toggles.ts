/**
 * The plugin's interface switches, read live from the settings form.
 *
 * The values live in the host `Config` as `.volatile()` booleans and are edited
 * on the Plugins page; this module is how the browser half hears about an edit.
 * It deliberately owns no React state: `watchFeatureFlags` is a subscription,
 * and `index.tsx` turns each emission into slot registrations or their disposal.
 *
 * Two rules make the wiring upgrade-safe:
 *
 *  - **The settings service is optional.** A composition without
 *    `@deepseek-ai/dsh-client-ui-settings` (or a Host that serves no form for
 *    this entry) must keep the plugin working. Nothing here throws: an absent
 *    service, an unavailable namespace, or a malformed value all fall back to
 *    "show everything", which is what the plugin did before these switches
 *    existed.
 *  - **Only a `ready` snapshot is an answer.** A snapshot that has not arrived
 *    yet is not permission to hide a surface: the initial mount happens with
 *    the defaults, and a later answer with `false` disposes the surface then.
 *
 * ## v0.4 adds three fields
 *
 * `showPreview` and `showExplore` mount the two new right-Sidebar tabs and are
 * ordinary switches. `enableCommands` is different in one way: the `/viking`
 * command is registered by the HOST half, so the browser half cannot mount or
 * unmount it. The field is carried here (and rendered by the settings form) so
 * the switch set stays in one table and a save emits once; the host half watches
 * the same value and registers/unregisters its command (on the next plugin
 * apply, and live where the Loader emits `loader/volatile-update`). It is
 * deliberately not in `FEATURE_ORDER`: the browser half owns no mount for it.
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from './slot-service.ts'

/** Which surfaces the plugin currently draws. */
export interface FeatureFlags {
  /** The Studio entry in the left sidebar (and its main panel). */
  readonly sidebarEntry: boolean
  /** The per-session commit status pill under the composer. */
  readonly commitStatus: boolean
  /** The Memory recall tab in the right sidebar. */
  readonly recallPanel: boolean
  /** The per-turn memory-sources tail in the conversation. */
  readonly recallExplain: boolean
  /** The Memory health tab and the Plugins-page health summary. */
  readonly healthPanel: boolean
  /** The v0.4 `viking://` preview tab. */
  readonly previewPanel: boolean
  /** The v0.4 Explore tab (search, rules, skills, experience). */
  readonly explorePanel: boolean
  /** Host-side: the `/viking` command. Carried here; no browser mount owns it. */
  readonly commands: boolean
  /** v0.5: the Activity tab (task centre + metrics + capture state). */
  readonly activityPanel: boolean
  /** v0.5: the persistent scope chip in the composer dock. */
  readonly scopeBanner: boolean
  /**
   * v0.9: the scope menu/switcher (toolbar chip menu + Overview menu). Off hides
   * only the menu; the banner still shows the active scope (sign-off 6).
   */
  readonly scopeSwitcher: boolean
  /**
   * v0.5: `enableWrites`. Carried here for the action bars and buttons; the
   * host reads the same value live for every mutation, so the client switch can
   * never authorize a write the host refuses.
   */
  readonly writes: boolean
  /**
   * v0.7: native read cockpit vs the exact v0.6 Studio page. Not a mount of its
   * own — it switches the body of the already-mounted main panel — so it is
   * excluded from `MountedFeature` and honoured through the native store.
   */
  readonly nativeViews: boolean
  /** v0.7: the Plugins-page Setup card (the Overview card reads the same store). */
  readonly onboarding: boolean
  /**
   * v0.8: `enableOps` — the Operate group's controlled actions. Carried here for
   * the buttons/tabs; the host reads the same value live, so the client switch
   * can never authorize an action the host refuses. Reads stay available.
   */
  readonly ops: boolean
}

/**
 * The client-mounted surfaces.
 *
 * `commands` is host-owned; `writes`/`scopeBanner` gate buttons/content inside
 * mounts rather than mounting anything themselves (a hidden `scopeBanner` still
 * leaves the dialogs' scope block, by design).
 */
export type MountedFeature = Exclude<
  keyof FeatureFlags,
  'commands' | 'writes' | 'nativeViews' | 'ops' | 'scopeSwitcher'
>

/** The state before any settings answer, and the fallback when there is none. */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  sidebarEntry: true,
  commitStatus: true,
  recallPanel: true,
  recallExplain: true,
  healthPanel: true,
  previewPanel: true,
  explorePanel: true,
  commands: true,
  activityPanel: true,
  scopeBanner: true,
  scopeSwitcher: true,
  // v0.5 writes are opt-in: before a settings answer arrives, every write
  // surface stays hidden (the host's default is the same `false`).
  writes: false,
  // v0.7 native views are the shipped default (the ROADMAP exit criterion: read
  // without the iframe); onboarding is shown until dismissed.
  nativeViews: true,
  onboarding: true,
  // v0.8 operational actions are opt-in: before a settings answer arrives every
  // Operate action button stays hidden (the host default is the same `false`).
  ops: false,
}

/**
 * The Config field behind each surface.
 *
 * One table, so the watcher and the settings form cannot drift: the form renders
 * the same keys, and a renamed field fails to compile here instead of silently
 * making a switch dead.
 */
export const FEATURE_CONFIG_FIELDS = {
  sidebarEntry: 'showSidebarEntry',
  commitStatus: 'showCommitStatus',
  recallPanel: 'showRecallPanel',
  recallExplain: 'showRecallExplain',
  healthPanel: 'showHealthPanel',
  previewPanel: 'showPreview',
  explorePanel: 'showExplore',
  commands: 'enableCommands',
  activityPanel: 'enableActivity',
  scopeBanner: 'showScopeBanner',
  scopeSwitcher: 'showScopeSwitcher',
  writes: 'enableWrites',
  nativeViews: 'showNativeViews',
  onboarding: 'showOnboarding',
  ops: 'enableOps',
} as const satisfies Record<keyof FeatureFlags, string>

/** The surfaces in the order they are mounted (and reverse order for disposal). */
export const FEATURE_ORDER: readonly MountedFeature[] = [
  'sidebarEntry',
  'commitStatus',
  'recallPanel',
  'recallExplain',
  'healthPanel',
  'previewPanel',
  'explorePanel',
  'activityPanel',
  'scopeBanner',
  'onboarding',
]

/**
 * One boolean, or the fallback when the field is missing or not a boolean.
 *
 * The fallback is per-field: a missing `enableWrites` must mean OFF (the schema
 * default and the safety rule), while a missing `show*` field means ON (the
 * pre-switch behaviour).
 */
function flagOf(config: Record<string, unknown>, field: string, fallback = true): boolean {
  const value = config[field]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read the switches out of a settings value.
 *
 * `undefined` (no value yet), a missing field, or a non-boolean all mean "on":
 * hiding a surface is the exceptional state, and it must come from a real
 * `false` the user saved.
 */
export function featureFlagsFrom(value: unknown): FeatureFlags {
  const config =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    sidebarEntry: flagOf(config, FEATURE_CONFIG_FIELDS.sidebarEntry),
    commitStatus: flagOf(config, FEATURE_CONFIG_FIELDS.commitStatus),
    recallPanel: flagOf(config, FEATURE_CONFIG_FIELDS.recallPanel),
    recallExplain: flagOf(config, FEATURE_CONFIG_FIELDS.recallExplain),
    healthPanel: flagOf(config, FEATURE_CONFIG_FIELDS.healthPanel),
    previewPanel: flagOf(config, FEATURE_CONFIG_FIELDS.previewPanel),
    explorePanel: flagOf(config, FEATURE_CONFIG_FIELDS.explorePanel),
    commands: flagOf(config, FEATURE_CONFIG_FIELDS.commands),
    activityPanel: flagOf(config, FEATURE_CONFIG_FIELDS.activityPanel),
    scopeBanner: flagOf(config, FEATURE_CONFIG_FIELDS.scopeBanner),
    scopeSwitcher: flagOf(config, FEATURE_CONFIG_FIELDS.scopeSwitcher),
    writes: flagOf(config, FEATURE_CONFIG_FIELDS.writes, false),
    nativeViews: flagOf(config, FEATURE_CONFIG_FIELDS.nativeViews),
    onboarding: flagOf(config, FEATURE_CONFIG_FIELDS.onboarding),
    ops: flagOf(config, FEATURE_CONFIG_FIELDS.ops, false),
  }
}

/** Whether two flag sets describe the same surfaces. */
export function sameFeatureFlags(left: FeatureFlags, right: FeatureFlags): boolean {
  return (
    left.sidebarEntry === right.sidebarEntry &&
    left.commitStatus === right.commitStatus &&
    left.recallPanel === right.recallPanel &&
    left.recallExplain === right.recallExplain &&
    left.healthPanel === right.healthPanel &&
    left.previewPanel === right.previewPanel &&
    left.explorePanel === right.explorePanel &&
    left.commands === right.commands &&
    left.activityPanel === right.activityPanel &&
    left.scopeBanner === right.scopeBanner &&
    left.scopeSwitcher === right.scopeSwitcher &&
    left.writes === right.writes &&
    left.nativeViews === right.nativeViews &&
    left.onboarding === right.onboarding &&
    left.ops === right.ops
  )
}

/** The slice of the settings domain service this module consumes. */
interface ConfigFormsService {
  get<T>(entryId: string): ConfigForm<T>
}

/**
 * Observe the switches for as long as the plugin lives.
 *
 * `namespace` is the Loader row id (`openviking-enhance`), which is what DSH
 * serves a row's form under (`plugins.row.config` is keyed by
 * `<package>#<row id>`, and the page hands the row id to `configForms.get`).
 *
 * The callback runs once per distinct state: immediately when a ready snapshot
 * is already held, then after every edit that changes a value. The returned
 * disposer removes the listener and the optional service injection.
 */
export function watchFeatureFlags(
  context: ClientContext,
  namespace: string,
  onChange: (flags: FeatureFlags, configValue: Record<string, unknown>) => void,
): () => void {
  let unsubscribe: (() => void) | undefined
  let last: FeatureFlags | undefined
  let lastProfile: string | undefined

  const publish = (form: ConfigForm<Record<string, unknown>>): void => {
    const snapshot = form.getSnapshot()
    // A pending or unavailable form is not an answer: keep whatever the caller
    // already drew rather than resetting a hidden surface to visible.
    if (snapshot.status !== 'ready') return
    const next = featureFlagsFrom(snapshot.value)
    // The raw value travels too: `activeProfile` is a string the panels need in
    // order to know when to re-read the scope, and it is not a surface flag.
    const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
    const profile = typeof value.activeProfile === 'string' ? value.activeProfile : ''
    const flagsChanged = last === undefined || !sameFeatureFlags(last, next)
    const profileChanged = lastProfile !== undefined && lastProfile !== profile
    if (!flagsChanged && !profileChanged) return
    last = next
    lastProfile = profile
    onChange(next, value)
  }

  const handle = context.inject(['configForms'], (scope) => {
    const forms = scope.get('configForms') as ConfigFormsService | undefined
    if (forms === undefined) return

    let form: ConfigForm<Record<string, unknown>>
    try {
      form = forms.get<Record<string, unknown>>(namespace)
    } catch (error) {
      const logger = context.logger
      const detail = error instanceof Error ? error.message : String(error)
      if (typeof logger?.warn === 'function') {
        logger.warn(`[openviking-enhance] settings form unavailable: ${detail}`, error)
      }
      return
    }

    // An earlier callback (the service was replaced) must not leave a listener
    // behind; the framework disposes the previous returned effect, but being
    // explicit here keeps a double emission impossible.
    unsubscribe?.()
    unsubscribe = form.subscribe(() => publish(form))
    publish(form)

    return () => {
      unsubscribe?.()
      unsubscribe = undefined
    }
  })

  return () => {
    try {
      handle.dispose()
    } catch {
      // Disposal is best effort: an unload must not throw.
    }
  }
}
