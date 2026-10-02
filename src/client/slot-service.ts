/**
 * Structural view of the client slot registry.
 *
 * The real service is `ctx.slots` (`SlotRegistry`), whose generics are keyed by
 * the `SlotMap` augmented by every slot-owner package. Declaring the verified
 * shape here instead of importing those generics keeps this half readable and
 * decouples it from a type parameterization that changes between DSH
 * generations; the runtime contract below is copied from
 * `@deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2`:
 *
 *   register(options, Component) -> disposer        (list id/order/label | keyed key)
 *   inject(slotKey, callback)    -> disposer        (waits for the slot declaration;
 *                                                    the callback's own disposers die
 *                                                    with the calling fiber)
 */
import type { ReactNode } from 'react'

export interface SlotRegisterOptions {
  /** Target slot key: the entry contributes INTO this slot. */
  name: string
  /** `list` slots address an entry by id. */
  id?: string
  /** `keyed` slots address an entry by key (the `main` panel dispatch). */
  key?: string
  /** Ascending row order within a list slot; ties keep registration order. */
  order?: number
  /** Row title / accessible name; a thunk re-resolves per read for locale changes. */
  label?: string | (() => string)
  /** Registrant business face; a session-scoped slot receives `sessionId`. */
  inject?: (...args: never[]) => Record<string, unknown>
  /** Child-slot declaration; declaring a child slot is what authorizes rendering it. */
  children?: Record<string, unknown>
  /** Diagnostics label. */
  registrant?: string
}

export interface SlotService {
  register(options: SlotRegisterOptions, component: (props: never) => ReactNode): () => void
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
}

/** The client-side service surface this plugin consumes. */
export interface ClientContext {
  slots: SlotService
  effect(callback: () => (() => void) | void, label?: string): () => void
  logger?: { warn(message: string, error?: unknown): void; info(message: string): void }
}
