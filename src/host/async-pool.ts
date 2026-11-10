/**
 * A small bounded worker pool for read fan-out.
 *
 * The catalogue (and only the catalogue, for now) reads many small files from
 * one server: a rules listing used to be one serial request per scenario and per
 * rule, which turns a slow-but-healthy server into a spinner. This helper gives
 * that fan-out a concurrency bound and a total deadline without a dependency:
 *
 *  - at most `limit` workers run at once, so the server sees a bounded burst;
 *  - no new item is started once `deadline` (an epoch-ms instant) has passed or
 *    the caller's signal aborts; in-flight requests still finish (they have
 *    their own per-request timeouts), so a caller can measure a duration close
 *    to the deadline instead of an unbounded one;
 *  - results keep their input order and unscheduled items are simply absent
 *    (`started` says how many ran), so a partial answer is built from what did
 *    arrive rather than failing whole.
 *
 * A worker that throws does not reject the whole map: the failure is recorded
 * per index (`errors`, `failures`) and the remaining items still run. The
 * catalogue turns that into a per-item warning, because "partial results beat
 * total failure" is this release's stance for a listing section. Callers that
 * want whole-map failure keep their own try/catch around `mapPool`.
 */
export interface MapPoolOptions {
  /** Caller cancellation; aborting stops scheduling new items. */
  signal?: AbortSignal | undefined
  /** Epoch-ms instant after which no new item is started. */
  deadline?: number | undefined
  /** The clock, for tests. */
  now?: (() => number) | undefined
}

export interface MapPoolOutcome<T> {
  /** Worker results by input index; `undefined` for items that never started. */
  results: Array<T | undefined>
  /** Worker rejections by input index; `undefined` when the item did not throw. */
  errors: Array<unknown>
  /** How many items a worker actually started. */
  started: number
  /** How many started items threw. */
  failures: number
  /** True when the deadline stopped scheduling before every item ran. */
  deadlineHit: boolean
  /** True when the caller's signal aborted the map. */
  aborted: boolean
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * `limit` is clamped to at least one: a zero/negative concurrency would hang the
 * caller, and the caller only uses this for bounded reads.
 */
export async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
  options: MapPoolOptions = {},
): Promise<MapPoolOutcome<Result>> {
  const now = options.now ?? Date.now
  const bound = Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1))
  const results: Array<Result | undefined> = new Array(items.length).fill(undefined)
  const errors: unknown[] = new Array(items.length).fill(undefined)
  let cursor = 0
  let started = 0
  let failures = 0
  let deadlineHit = false
  let aborted = false

  const claim = (): number | null => {
    if (cursor >= items.length) return null
    if (options.signal?.aborted === true) {
      aborted = true
      return null
    }
    if (options.deadline !== undefined && now() >= options.deadline) {
      deadlineHit = true
      return null
    }
    const index = cursor
    cursor += 1
    started += 1
    return index
  }

  const workers: Array<Promise<void>> = []
  for (let slot = 0; slot < Math.min(bound, items.length); slot += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = claim()
          if (index === null) return
          try {
            results[index] = await worker(items[index] as Item, index)
          } catch (error) {
            // Per-item isolation: record it, keep the pool running. The caller
            // decides whether an error becomes a warning or a section failure.
            errors[index] = error
            failures += 1
          }
        }
      })(),
    )
  }
  await Promise.all(workers)
  // A worker may have observed neither stop reason because it finished exactly
  // as the deadline passed; report the deadline only if something was skipped.
  const skipped = started < items.length
  return {
    results,
    errors,
    started,
    failures,
    deadlineHit: deadlineHit && skipped,
    aborted,
  }
}
