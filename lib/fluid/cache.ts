/**
 * Tiny TTL memo shared across the data layer. Wraps an async producer so all
 * pages/loaders reuse a recent (or in-flight) result instead of re-pulling the
 * multi-MB DefiLlama payloads on every navigation. Process-level, best-effort.
 */
export function ttlMemo<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cache: { at: number; val: T } | null = null
  let inflight: Promise<T> | null = null
  return () => {
    if (cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.val)
    if (inflight) return inflight
    inflight = fn()
      .then((val) => {
        cache = { at: Date.now(), val }
        inflight = null
        return val
      })
      .catch((err) => {
        inflight = null
        throw err
      })
    return inflight
  }
}

export const TTL_5MIN = 5 * 60_000
