/**
 * Shared resilient JSON fetch for the DefiLlama data layer. DefiLlama's heavy
 * endpoints (/pools, /summary/fees) can be slow or transiently rate-limit a
 * burst of parallel calls; without a timeout a slow call hangs the render, and
 * without retry a transient failure returns null and poisons the 5-min cache.
 *
 * This adds an AbortController timeout + retry-with-backoff on 429/5xx/network.
 * Returns null only after all attempts fail (callers fail-soft / throw-not-cache).
 */
export async function fetchJson<T>(
  url: string,
  opts?: { timeoutMs?: number; retries?: number },
): Promise<T | null> {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const retries = opts?.retries ?? 2
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) return (await res.json()) as T
      // 4xx other than 429 is a hard failure - don't retry.
      if (res.status !== 429 && res.status < 500) return null
    } catch {
      clearTimeout(timer)
      // timeout / network hiccup: fall through to retry
    }
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
  }
  return null
}
