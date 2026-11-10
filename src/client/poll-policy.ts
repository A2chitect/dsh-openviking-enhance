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

/** The timer/visibility surface the poll scheduler needs (injectable for tests). */
export interface PollScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  isHidden(): boolean
  /** Subscribe to visibility changes; returns an unsubscribe function. */
  onVisibilityChange(listener: () => void): () => void
}

/** The browser scheduler; null in a server render / older harness (no DOM). */
export function defaultPollScheduler(): PollScheduler | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      if (handle !== undefined && handle !== null) window.clearTimeout(handle as number)
    },
    isHidden: () => document.visibilityState === 'hidden',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * A visibility-gated, self-scheduling poll loop — the only polling primitive.
 *
 * Why a helper instead of an effect-local `setTimeout` chain: the review of this
 * release caught a zero-delay self-loop where `nextPollDelay()` returned 0
 * ("do not schedule") but the consumer scheduled anyway. Here that contract is
 * enforced in one place and can be tested with a fake clock:
 *
 *  - while the document is hidden the loop schedules **nothing** (no timer is
 *    created at all) and resumes with an immediate load on visibility;
 *  - `nextDelay() <= 0` stops the loop until an event resumes it;
 *  - a load that is still running is never overlapped (a visibility resume waits
 *    for it, then runs);
 *  - the delay is recomputed after every load from live facts (the caller's
 *    refs), so a task that starts/finishes mid-session changes the cadence.
 *
 * @param load the read to perform; awaited before the next delay is computed
 * @param nextDelay the policy delay for the current state (see `nextPollDelay`)
 * @param scheduler injectable timer/visibility surface (default: the browser)
 * @returns a disposer; safe to call more than once
 */
export function startScheduledPoll(
  load: () => Promise<void> | void,
  nextDelay: () => number,
  scheduler: PollScheduler | null = defaultPollScheduler(),
): () => void {
  if (scheduler === null) return () => {}
  let closed = false
  let timer: unknown = null
  let loading = false
  let resumeOnIdle = false

  const clear = (): void => {
    if (timer !== null) {
      scheduler.clearTimeout(timer)
      timer = null
    }
  }
  const schedule = (delay: number): void => {
    clear()
    // The documented contract: 0/negative means "wait for an event", and a
    // hidden document must not own a timer either.
    if (closed || delay <= 0 || scheduler.isHidden()) return
    timer = scheduler.setTimeout(() => {
      timer = null
      void tick()
    }, delay)
  }
  const tick = async (): Promise<void> => {
    if (closed || loading) return
    if (scheduler.isHidden()) return
    loading = true
    try {
      await load()
    } finally {
      loading = false
    }
    if (closed) return
    if (resumeOnIdle) {
      resumeOnIdle = false
      void tick()
      return
    }
    schedule(nextDelay())
  }
  const onVisibility = (): void => {
    if (closed) return
    if (scheduler.isHidden()) {
      clear()
      return
    }
    if (loading) {
      resumeOnIdle = true
      return
    }
    void tick()
  }
  const unsubscribe = scheduler.onVisibilityChange(onVisibility)
  // Initial scheduling respects the hidden state (no timer), so mounting a
  // hidden tab never starts a loop.
  schedule(nextDelay())
  return () => {
    if (closed) return
    closed = true
    clear()
    unsubscribe()
  }
}
