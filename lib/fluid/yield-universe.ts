/**
 * The "yield universe": one cached fetch of DefiLlama's /pools (+ /lendBorrow),
 * joined and normalized into lending rows (for the peer rate + share charts)
 * and DEX rows (for the pair-volume share chart). Built around the field names
 * verified live: /pools carries `apyBase` (supply), `volumeUsd1d`, `tvlUsd`;
 * /lendBorrow (joined by `pool`) carries `apyBaseBorrow, ltv, totalSupplyUsd,
 * totalBorrowUsd`. DefiLlama has NO liquidation penalty (that is Pass 3,
 * on-chain).
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { getRawPools, getRawLendBorrow } from "./llama-pools"
import { LENDING_PROJECTS, canonicalAsset } from "./peers"


export interface LendingPoolRow {
  pool: string
  project: string
  chain: string
  symbol: string
  /** canonical asset key (ETH==WETH collapsed), or null if untracked. */
  asset: string | null
  tvlUsd: number
  supplyApy: number | null
  rewardApy: number | null
  borrowApy: number | null
  totalSupplyUsd: number | null
  totalBorrowUsd: number | null
  ltv: number | null
}

export interface DexPoolRow {
  pool: string
  project: string
  chain: string
  symbol: string
  /** Sorted canonical-ish token symbols forming the pair key (display). */
  pairKey: string
  /** Sorted underlying-address set (stable matching key across protocols). */
  addrKey: string
  tokens: string[]
  volumeUsd1d: number
  volumeUsd7d: number
  tvlUsd: number
  feeApy: number | null
}

/** Aggregate volume + TVL per DEX project, for the turnover comparison. */
export interface DexAgg { vol7d: number; vol1d: number; tvl: number }

export interface YieldUniverse {
  lending: LendingPoolRow[]
  dex: DexPoolRow[]
  /** Per-DEX volume/TVL aggregates (Ethereum and all-chains) for turnover. */
  dexTurnover: { ethereum: Record<string, DexAgg>; all: Record<string, DexAgg> }
  fetchedAt: number
}

/** DEX projects compared on capital efficiency (turnover). */
// uniswap-v4 belongs here: on Ethereum it now turns over ~$0.50 per $1/day,
// ahead of Fluid. Omitting it would flatter Fluid in the capital-efficiency panel.
export const DEX_PEERS = ["fluid-dex", "uniswap-v4", "uniswap-v3", "uniswap-v2", "curve-dex", "balancer-v2", "pancakeswap-amm-v3"] as const

interface RawPool {
  pool: string
  project: string
  chain: string
  symbol: string
  tvlUsd?: number | null
  apyBase?: number | null
  apyReward?: number | null
  volumeUsd1d?: number | null
  volumeUsd7d?: number | null
  underlyingTokens?: string[] | null
}
interface RawLendBorrow {
  pool: string
  apyBaseBorrow?: number | null
  ltv?: number | null
  totalSupplyUsd?: number | null
  totalBorrowUsd?: number | null
}


/** Split a DEX pool symbol ("USDC-USDT", "WSTETH/ETH") into a stable pair key. */
function pairKeyOf(symbol: string): { key: string; tokens: string[] } {
  const tokens = (symbol || "")
    .toUpperCase()
    .split(/[-/]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const sorted = [...tokens].sort()
  return { key: sorted.join("-"), tokens }
}

async function build(): Promise<YieldUniverse> {
  const [poolsRaw, lendBorrow] = await Promise.all([getRawPools(), getRawLendBorrow()])
  const pools = poolsRaw as unknown as RawPool[]
  const lb = new Map((lendBorrow as unknown as RawLendBorrow[]).map((r) => [r.pool, r]))

  const addrKeyOf = (p: RawPool): string =>
    [...(p.underlyingTokens ?? [])].map((a) => a.toLowerCase()).sort().join("-")

  // Per-DEX turnover aggregates (all pools of each compared DEX, not just the
  // Fluid-matched pairs) for the capital-efficiency hero.
  const dexPeerSet = new Set<string>(DEX_PEERS)
  const dexTurnover = { ethereum: {} as Record<string, DexAgg>, all: {} as Record<string, DexAgg> }
  for (const p of pools) {
    if (!dexPeerSet.has(p.project)) continue
    const v7 = p.volumeUsd7d ?? 0
    const tvl = p.tvlUsd ?? 0
    if (v7 <= 0 || tvl <= 0) continue
    const v1 = p.volumeUsd1d ?? 0
    const addAgg = (bucket: Record<string, DexAgg>) => {
      const a = bucket[p.project] ?? { vol7d: 0, vol1d: 0, tvl: 0 }
      a.vol7d += v7
      a.vol1d += v1
      a.tvl += tvl
      bucket[p.project] = a
    }
    addAgg(dexTurnover.all)
    if (p.chain === "Ethereum") addAgg(dexTurnover.ethereum)
  }

  const lending: LendingPoolRow[] = []
  // Collect the address-keys (per chain) Fluid's DEX runs, so we keep only the
  // matching competitor pools. Address matching is stable across symbol/decimal
  // variants (e.g. USDT vs USD₮0).
  const fluidPairChainKeys = new Set<string>()
  for (const p of pools) {
    if (p.project === "fluid-dex") {
      const ak = addrKeyOf(p)
      if (ak) fluidPairChainKeys.add(`${p.chain}::${ak}`)
    }
  }

  const dex: DexPoolRow[] = []
  for (const p of pools) {
    if (LENDING_PROJECTS.has(p.project)) {
      const r = lb.get(p.pool)
      lending.push({
        pool: p.pool,
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        asset: canonicalAsset(p.symbol),
        tvlUsd: p.tvlUsd ?? 0,
        supplyApy: p.apyBase ?? null,
        rewardApy: p.apyReward ?? null,
        borrowApy: r?.apyBaseBorrow ?? null,
        totalSupplyUsd: r?.totalSupplyUsd ?? null,
        totalBorrowUsd: r?.totalBorrowUsd ?? null,
        ltv: r?.ltv ?? null,
      })
      continue
    }
    const isFluidDex = p.project === "fluid-dex"
    const { key, tokens } = pairKeyOf(p.symbol)
    const ak = addrKeyOf(p)
    if (tokens.length !== 2 && !ak) continue
    // Keep fluid-dex pools always; keep peer pools only for pairs Fluid runs.
    if (!isFluidDex && !(ak && fluidPairChainKeys.has(`${p.chain}::${ak}`))) continue
    dex.push({
      pool: p.pool,
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      pairKey: key,
      addrKey: ak || key,
      tokens,
      volumeUsd1d: p.volumeUsd1d ?? 0,
      volumeUsd7d: p.volumeUsd7d ?? 0,
      tvlUsd: p.tvlUsd ?? 0,
      feeApy: p.apyBase ?? null,
    })
  }

  return { lending, dex, dexTurnover, fetchedAt: Math.floor(Date.now() / 1000) }
}

export const getYieldUniverse = ttlMemo(build, TTL_5MIN)
