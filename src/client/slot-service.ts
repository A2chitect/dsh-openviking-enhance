/**
 * The client slot registry, typed against the framework's real `SlotMap`.
 *
 * This used to hand-declare a structural shape, which left our slot names, their
 * kinds, and the props each occupant receives unchecked — three things that break
 * silently on a DSH upgrade (a renamed slot stops rendering, or a `list` entry
 * given `key` instead of `id` becomes a dead sidebar row that throws when
 * clicked).
 *
 * The owner imports below are type-only and exist for their side effect: each
 * slot owner merges its entries into `SlotMap` from a `declare module` block, and
 * TypeScript only applies an augmentation when the declaring file is part of the
 * program — importing the `./client` subpath is what pulls those in.
 *
 * Now checked at compile time:
 *   - a registered `name` is a real slot key;
 *   - kind-specific options match the slot (`id`/`order`/`label` for list slots,
 *     `key` for keyed ones);
 *   - a root slot cannot declare an `inject` factory, a session slot must, and the
 *     factory receives `sessionId`;
 *   - the component's props accept what the slot actually hands it.
 *
 * `./type-assertions.ts` pins each rule with `@ts-expect-error`, so an upgrade that
 * loosens them fails the build instead of the GUI.
 */
import type { ReactNode } from 'react'
import type { EntryKeyOf, KindOptions, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only imports for their SlotMap augmentations (see the note above).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Pulls in the right Sidebar's own augmentation: the two `sidebar.right.pane.tab*`
// seats used by the recall tab. `SidebarRightTabDefinition` is the registry's real
// definition type, so a tab type is checked against the framework, not our guess.
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Every slot key the framework currently declares. */
export type SlotName = keyof SlotMap & string

/** The business face an entry's `inject` factory returns. */
export type SlotFace = Record<string, unknown>

/** Slot keys that carry no session, so an `inject` factory there would be inert. */
export type RootSlotName = { [K in SlotName]: SlotMap[K]['scope'] extends 'root' ? K : never }[SlotName]

/** Slot keys whose occupant is rendered for a session and needs its id. */
export type SessionSlotName = Exclude<SlotName, RootSlotName>

/**
 * Registration options, narrowed by the slot's kind.
 *
 * `sessionId` is written out as `string` rather than derived from
 * `InjectParams<K, undefined>`: the standard-kit interfaces this package ships are
 * empty by design (the runtime package merges `sessionId` into them), so the
 * derived form adds nothing.
 *
 * The required/forbidden `inject` split lives in the two `register` overloads
 * below rather than in a conditional type here — TypeScript cannot infer a type
 * parameter out of a conditional type's branches, which would leave `Face`
 * unresolved and force explicit type arguments on every session-slot call.
 */
export type SlotRegisterOptions<
  K extends SlotName,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
  Face extends SlotFace = SlotFace,
> = { name: K; registrant?: string } & KindOptions<K, EntryKey> & { inject?: (sessionId: string) => Face }

/** What a registration may supply: the slot's runtime props plus the inject face. */
export type SlotComponent<
  K extends SlotName,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
  Face extends SlotFace = SlotFace,
> = (props: PropsRuntime<K, EntryKey> & Face) => ReactNode

/**
 * The slice of the client slot registry this plugin uses.
 *
 *     register(options, Component) -> disposer   (list: id/order/label | keyed: key)
 *     inject(slotKey, callback)    -> disposer   (waits for the slot declaration; the
 *                                                 callback's disposers die with the fiber)
 */
export interface SlotService {
  /** A root slot: no session, so declaring an `inject` factory is an error. */
  register<K extends RootSlotName, EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>>(
    options: { name: K; registrant?: string } & KindOptions<K, EntryKey> & { inject?: never },
    component: SlotComponent<K, EntryKey>,
  ): () => void

  /** A session slot: the factory is required, and its return type is the component's face. */
  register<
    K extends SessionSlotName,
    EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    Face extends SlotFace = SlotFace,
  >(
    options: { name: K; registrant?: string } & KindOptions<K, EntryKey> & { inject: (sessionId: string) => Face },
    component: SlotComponent<K, EntryKey, Face>,
  ): () => void

  inject(key: SlotName, callback: () => (() => void) | Iterable<() => void>): () => void
}

/** The client-side service surface this plugin consumes. */
export interface ClientContext {
  slots: SlotService
  effect(callback: () => (() => void) | void, label?: string): () => void
  /**
   * Run a callback once a service exists (and again if it is replaced).
   *
   * Required rather than optional because of the order the right Sidebar boots
   * in: its seat declares `sidebar.right.pane.tab` *before* it provides
   * `sidebarRightTabs`, so a plugin that registers on the slot declaration reads
   * the registry as absent and never gets another chance.
   */
  inject(deps: readonly string[], callback: (scope: ClientScope) => (() => void) | void): { dispose(): void }
  /** Read a service without waiting for it. */
  get(key: string): unknown
  logger?: { warn(message: string, error?: unknown): void; info(message: string): void }
}

/** What `inject`'s callback is handed: the same lookup, scoped to the services asked for. */
export interface ClientScope {
  get(key: string): unknown
}

/** `ctx.sidebarRightTabs`, narrowed to the one call this plugin makes. */
export interface SidebarRightTabRegistry {
  register(definition: SidebarRightTabDefinition): () => void
}

/** `ctx.sidebarRight`, narrowed to the way in: opening a page by kind. */
export interface SidebarRightNavigation {
  openTab(kind: string, options?: { params?: unknown }): void
}
