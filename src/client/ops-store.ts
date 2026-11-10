/**
 * v0.9: the client-side "is an Operate confirmation open?" flag.
 *
 * v0.8's OpsDialog owns its prepare/execute state inside the component (it is
 * rendered inside the cockpit / a command card), so nothing global knew whether a
 * v0.8 confirmation was pending. The v0.9 switch guard must refuse a scope switch
 * while one is: a switch would silently discard a prepared token (or, worse, let
 * it execute under a different identity). This module is the missing global bit:
 * the dialog marks itself pending on mount and releases on unmount, and the scope
 * store's guard reads it.
 *
 * Deliberately tiny and React-free: it is a flag, not a store, because no surface
 * renders it (the dialog renders itself).
 */

let pendingOps = 0

/** The OpsDialog calls this on mount/unmount (nested dialogs stay counted). */
export function setOpsPending(pending: boolean): void {
  pendingOps = Math.max(0, pendingOps + (pending ? 1 : -1))
}

/** Whether any Operate confirmation is open (loading/confirm/executing/result). */
export function hasPendingOps(): boolean {
  return pendingOps > 0
}

/** Test seam: reset the counter between tests. */
export function __resetOpsPendingForTests(): void {
  pendingOps = 0
}
