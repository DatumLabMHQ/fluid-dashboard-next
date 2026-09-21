/**
 * DefiLlama Coins API — instant USD price + decimals for any ERC-20 by
 * `chain:address`. Public, no key.
 *
 * Used to value the on-chain Fluid vault totals in USD (Fluid's per-vault
 * `oraclePriceOperate` needs careful per-vault-type interpretation, so we use
 * DefiLlama's index price instead — consistent with the live app's USD view).
 * Batched + memoised so the vaults table prices ~all tokens in one request.
 */

export interface TokenInfo {
  priceUsd: number
  decimals: number
  symbol: string
}

/** Native-ETH placeholders (Fluid uses ERC-7528 0xEEE…; zero-address elsewhere).
 *  Both route to WETH for pricing; decimals match (18). */
const ETH_SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
])
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"

const COINS_BASE = "https://coins.llama.fi"

// Process-level memo. Token prices/decimals move slowly relative to a page
// render; a 5-minute TTL keeps the Coins API calls minimal under traffic.
const CACHE_TTL_MS = 5 * 60_000
const memo = new Map<string, { at: number; info: TokenInfo | null }>()

function lookupKey(chain: string, address: string): string {
  const lower = address.toLowerCase()
  const addr = ETH_SENTINELS.has(lower) ? WETH_ADDRESS : lower
  return `${chain.toLowerCase()}:${addr}`
}

function parseEntry(entry: {
  price?: number
  decimals?: number
  symbol?: string
}): TokenInfo | null {
  const price = entry.price
  const decimals = entry.decimals
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof decimals !== "number" ||
    !Number.isFinite(decimals) ||
    decimals < 0
  ) {
    return null
  }
  return { priceUsd: price, decimals: Math.floor(decimals), symbol: entry.symbol ?? "" }
}

/**
 * Batch-price a set of `chain:address` tokens. Returns a Map keyed by the
 * SAME lookup key the request used (ETH sentinels collapsed to WETH), so
 * callers should look up via `priceKeyFor(chain, address)`.
 */
export async function fetchTokenInfoBatch(
  refs: Array<{ chain: string; address: string }>,
): Promise<Map<string, TokenInfo>> {
  const out = new Map<string, TokenInfo>()
  const now = Date.now()
  const toFetch = new Set<string>()

  for (const r of refs) {
    if (!r.address) continue
    const key = lookupKey(r.chain, r.address)
    const hit = memo.get(key)
    if (hit && now - hit.at < CACHE_TTL_MS) {
      if (hit.info) out.set(key, hit.info)
    } else {
      toFetch.add(key)
    }
  }

  if (toFetch.size === 0) return out

  try {
    const keys = Array.from(toFetch).join(",")
    const res = await fetch(`${COINS_BASE}/prices/current/${encodeURIComponent(keys)}`, {
      cache: "no-store",
    })
    if (res.ok) {
      const json = (await res.json()) as {
        coins?: Record<string, { price?: number; decimals?: number; symbol?: string }>
      }
      for (const key of toFetch) {
        const info = json.coins?.[key] ? parseEntry(json.coins[key]) : null
        memo.set(key, { at: now, info })
        if (info) out.set(key, info)
      }
    }
  } catch (err) {
    // Fail soft — callers render "—" for unpriced tokens.
    console.error("[prices] batch fetch failed:", (err as Error)?.message ?? err)
  }
  return out
}

/** Lookup key matching what `fetchTokenInfoBatch` stores results under. */
export function priceKeyFor(chain: string, address: string): string {
  return lookupKey(chain, address)
}

export async function fetchTokenInfo(
  chain: string,
  address: string,
): Promise<TokenInfo | null> {
  const map = await fetchTokenInfoBatch([{ chain, address }])
  return map.get(lookupKey(chain, address)) ?? null
}
