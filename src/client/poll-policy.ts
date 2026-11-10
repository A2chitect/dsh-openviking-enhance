/**
 * When the commit pill should poll next.
 *
 * Polling is still the only path — OpenViking lives in another process and DSH
 * has no commit signal to subscribe to — but a fixed five-second timer spends
 * almost all of its requests on a state that has not changed. The intervals
 * below keep the pill responsive while something is actually happening and stop
 * paying for an idle session:
 *
 *   extraction in flight  5 s   the only window where seconds matter
 *   idle, visible         30 s  pending tokens and the commit count change slowly
 *   hidden tab            0     paused; a visibility change refreshes immediately
 *   request failed        5→60s exponential backoff, reset on success
 *
 * The function is pure so the schedule can be tested without timers or React.
 */
/** Poll interval while a commit is being extracted. */
export const POLL_ACTIVE_MS = 5_000
/** Poll interval when the pill is visible and settled. */
export const POLL_IDLE_MS = 30_000
/** First retry after a failed request; doubles up to `POLL_ERROR_MAX_MS`. */
export const POLL_ERROR_FIRST_MS = 5_000
/** Ceiling for the error backoff. */
export const POLL_ERROR_MAX_MS = 60_000

export interface PollDecision {
  /**
   * A `pending`/`running` task actually exists for this session. Fast polling is
   * gated on this rather than on the displayed phase alone: an archive can stay
   * marker-less after a crash, and a stuck "extracting…" pill must not turn back
   * into a five-second timer forever.
   */
  working: boolean
  /** Whether the document is hidden right now. */
  hidden: boolean
  /** Consecutive failed polls; 0 after the last success. */
  errorCount: number
}

/** Delay before the next poll. `0` means "do not schedule; wait for an event". */
export function nextPollDelay(input: PollDecision): number {
  if (input.hidden) return 0
  if (input.errorCount > 0) {
    const exponent = Math.min(input.errorCount - 1, 4)
    return Math.min(POLL_ERROR_FIRST_MS * 2 ** exponent, POLL_ERROR_MAX_MS)
  }
  return input.working ? POLL_ACTIVE_MS : POLL_IDLE_MS
}

/**
 * A visibility-gated interval: the only recurring-request timer the client uses.
 *
 * The timer does not exist while the document is hidden, and it refreshes once
 * immediately when the tab becomes visible again (the answer may be stale after
 * any amount of hidden time). Components therefore cannot accidentally keep
 * spending requests on a hidden panel by adding a bare `setInterval`.
 *
 * No-op in a server render / very old harness (no `document`/`window`); the
 * returned disposer can always be called.
 */
export function startVisibleInterval(callback: () => void, intervalMs: number): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  const start = (): void => {
    if (timer === null && document.visibilityState !== 'hidden') timer = setInterval(callback, intervalMs)
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      stop()
      return
    }
    callback()
    start()
  }
  start()
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
