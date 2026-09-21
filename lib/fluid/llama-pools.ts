/**
 * Shared, deduplicated access to DefiLlama's heavy yields endpoints. /pools is
 * ~11MB and takes ~45s; several modules (yield-universe, lending-research,
 * issuers) all need it. Fetching it once through a shared ttlMemo means those
 * modules share a single in-flight request instead of each pulling 11MB - a big
 * cut to page-load time and rate-limit pressure.
 *
 * Returns are broadly typed; each caller reads the fields it needs.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson } from "./fetch-json"

const YIELDS = "https://yields.llama.fi"
const POOLS_TIMEOUT = 90_000

export type RawPoolAny = Record<string, unknown> & {
  pool: string
  project: string
  chain: string
  symbol: string
}
export type RawLendBorrowAny = Record<string, unknown> & { pool: string }

export const getRawPools = ttlMemo(async (): Promise<RawPoolAny[]> => {
  const res = await fetchJson<{ data: RawPoolAny[] }>(`${YIELDS}/pools`, { timeoutMs: POOLS_TIMEOUT })
  if (!res) throw new Error("DefiLlama /pools unavailable")
  return res.data ?? []
}, TTL_5MIN)

export const getRawLendBorrow = ttlMemo(async (): Promise<RawLendBorrowAny[]> => {
  const res = await fetchJson<RawLendBorrowAny[]>(`${YIELDS}/lendBorrow`, { timeoutMs: POOLS_TIMEOUT })
  return res ?? []
}, TTL_5MIN)
