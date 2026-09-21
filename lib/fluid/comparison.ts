/**
 * Cross-protocol comparison engine. Turns the yield universe into normalized,
 * ranked, Fluid-flagged points that chart primitives can render directly.
 *
 * Normalization rules (verified in Step 1):
 *  - ETH == WETH (collapsed in `canonicalAsset`).
 *  - Rates compared on Ethereum (the shared, deepest venue) for fairness.
 *  - Supply APY: the protocol's largest pool for the asset that carries a rate.
 *  - Borrow APY: size-weighted by borrowed USD across the protocol's pools for
 *    the asset (handles Morpho's many isolated markets; single-pool peers just
 *    return that pool's rate).
 *  - Supply share: summed across all chains (the "share of all DeFi lending").
 */
import { getYieldUniverse, type LendingPoolRow } from "./yield-universe"
import {
  LENDING_PEERS,
  ASSETS,
  assetLabel,
  peerLabel,
  type CanonicalAsset,
} from "./peers"

export interface RankedPoint {
  project: string
  label: string
  value: number
  isFluid: boolean
}

export interface RateComparison {
  asset: string
  assetLabel: string
  metric: "supply" | "borrow"
  /** Points sorted best-first (supply: high->low, borrow: low->high). */
  points: RankedPoint[]
  fluid: { value: number | null; rank: number | null; of: number }
}

const FLUID_PROJECT = "fluid-lending"

function pickSupply(rows: LendingPoolRow[]): number | null {
  let best: LendingPoolRow | null = null
  for (const r of rows) {
    if (r.supplyApy == null) continue
    if (!best || r.tvlUsd > best.tvlUsd) best = r
  }
  return best?.supplyApy ?? null
}

function weightedBorrow(rows: LendingPoolRow[]): number | null {
  let num = 0
  let den = 0
  let fallback: { apy: number; tvl: number } | null = null
  for (const r of rows) {
    if (r.borrowApy == null) continue
    const w = r.totalBorrowUsd ?? 0
    if (w > 0) {
      num += r.borrowApy * w
      den += w
    }
    if (!fallback || r.tvlUsd > fallback.tvl) fallback = { apy: r.borrowApy, tvl: r.tvlUsd }
  }
  if (den > 0) return num / den
  return fallback?.apy ?? null
}

async function rowsByProtocolForAsset(
  asset: CanonicalAsset,
  opts: { ethereumOnly: boolean },
): Promise<Map<string, LendingPoolRow[]>> {
  const { lending } = await getYieldUniverse()
  const byProject = new Map<string, LendingPoolRow[]>()
  for (const r of lending) {
    if (r.asset !== asset.key) continue
    if (opts.ethereumOnly && r.chain !== "Ethereum") continue
    const arr = byProject.get(r.project) ?? []
    arr.push(r)
    byProject.set(r.project, arr)
  }
  return byProject
}

export async function buildRateComparison(
  assetKey: string,
  metric: "supply" | "borrow",
): Promise<RateComparison> {
  const asset = ASSETS.find((a) => a.key === assetKey)!
  const byProject = await rowsByProtocolForAsset(asset, { ethereumOnly: true })

  const points: RankedPoint[] = []
  for (const peer of LENDING_PEERS) {
    const rows = byProject.get(peer.project) ?? []
    if (rows.length === 0) continue
    const value = metric === "supply" ? pickSupply(rows) : weightedBorrow(rows)
    if (value == null || !Number.isFinite(value)) continue
    points.push({
      project: peer.project,
      label: peer.label,
      value,
      isFluid: Boolean(peer.isFluid),
    })
  }

  // Sort best-first: supply high->low, borrow low->high.
  points.sort((a, b) => (metric === "supply" ? b.value - a.value : a.value - b.value))

  const fluidIdx = points.findIndex((p) => p.project === FLUID_PROJECT)
  return {
    asset: asset.key,
    assetLabel: assetLabel(asset.key),
    metric,
    points,
    fluid: {
      value: fluidIdx >= 0 ? points[fluidIdx].value : null,
      rank: fluidIdx >= 0 ? fluidIdx + 1 : null,
      of: points.length,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Supply / collateral share across all lending (current snapshot).
// ─────────────────────────────────────────────────────────────────────────

export interface ShareComparison {
  asset: string
  assetLabel: string
  total: number
  points: Array<RankedPoint & { share: number }>
  fluid: { value: number; share: number; rank: number | null; of: number }
}

export async function buildCollateralShare(assetKey: string): Promise<ShareComparison> {
  const asset = ASSETS.find((a) => a.key === assetKey)!
  const byProject = await rowsByProtocolForAsset(asset, { ethereumOnly: false })

  const raw: RankedPoint[] = []
  for (const peer of LENDING_PEERS) {
    const rows = byProject.get(peer.project) ?? []
    const supplied = rows.reduce((s, r) => s + (r.totalSupplyUsd ?? r.tvlUsd ?? 0), 0)
    if (supplied <= 0) continue
    raw.push({ project: peer.project, label: peer.label, value: supplied, isFluid: Boolean(peer.isFluid) })
  }
  const total = raw.reduce((s, p) => s + p.value, 0)
  raw.sort((a, b) => b.value - a.value)
  const points = raw.map((p) => ({ ...p, share: total > 0 ? (p.value / total) * 100 : 0 }))
  const fluidIdx = points.findIndex((p) => p.project === FLUID_PROJECT)
  return {
    asset: asset.key,
    assetLabel: assetLabel(asset.key),
    total,
    points,
    fluid: {
      value: fluidIdx >= 0 ? points[fluidIdx].value : 0,
      share: fluidIdx >= 0 ? points[fluidIdx].share : 0,
      rank: fluidIdx >= 0 ? fluidIdx + 1 : null,
      of: points.length,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DEX pair-volume share (current snapshot) — Fluid DEX vs other DEXs per pair.
// ─────────────────────────────────────────────────────────────────────────

export interface DexPairShare {
  pair: string
  chain: string
  fluidVolume: number
  totalVolume: number
  share: number
  /** Per-DEX breakdown for that pair, sorted by volume desc. */
  competitors: Array<{ project: string; volume: number; isFluid: boolean }>
}

export async function buildDexPairShares(): Promise<DexPairShare[]> {
  const { dex } = await getYieldUniverse()
  // Group by chain + underlying-address set (stable across symbol/decimal
  // variants). Use 7-DAY volume so the share is not whipsawed by 1d spikes.
  const groups = new Map<string, typeof dex>()
  for (const d of dex) {
    const k = `${d.chain}::${d.addrKey}`
    const arr = groups.get(k) ?? []
    arr.push(d)
    groups.set(k, arr)
  }
  const out: DexPairShare[] = []
  for (const [, rows] of groups) {
    const fluidVolume = rows
      .filter((r) => r.project === "fluid-dex")
      .reduce((s, r) => s + r.volumeUsd7d, 0)
    if (fluidVolume <= 0) continue
    const totalVolume = rows.reduce((s, r) => s + r.volumeUsd7d, 0)
    const byProject = new Map<string, number>()
    for (const r of rows) byProject.set(r.project, (byProject.get(r.project) ?? 0) + r.volumeUsd7d)
    const competitors = Array.from(byProject.entries())
      .map(([project, volume]) => ({ project, volume, isFluid: project === "fluid-dex" }))
      .sort((a, b) => b.volume - a.volume)
    // Display label = the Fluid pool's symbol for this pair.
    const fluidRow = rows.find((r) => r.project === "fluid-dex")
    out.push({
      pair: fluidRow?.symbol ?? rows[0].symbol,
      chain: rows[0].chain,
      fluidVolume,
      totalVolume,
      share: totalVolume > 0 ? (fluidVolume / totalVolume) * 100 : 0,
      competitors,
    })
  }
  return out.sort((a, b) => b.fluidVolume - a.fluidVolume)
}

// ─────────────────────────────────────────────────────────────────────────
// Fluid DEX fee yield by pool (the yield smart collateral / debt earns).
// ─────────────────────────────────────────────────────────────────────────

export interface DexFeeYield {
  pair: string
  chain: string
  feeApy: number
  tvlUsd: number
}

export async function buildDexFeeYields(limit = 10): Promise<DexFeeYield[]> {
  const { dex } = await getYieldUniverse()
  // Dedup pools that share a pair (same chain + address set): keep the one with
  // the largest TVL so a pair appears once, no duplicate labels.
  const byPair = new Map<string, DexFeeYield>()
  for (const d of dex) {
    if (d.project !== "fluid-dex" || d.feeApy == null || d.feeApy <= 0) continue
    const k = `${d.chain}::${d.addrKey}`
    const cur = byPair.get(k)
    if (!cur || d.tvlUsd > cur.tvlUsd) {
      byPair.set(k, { pair: d.symbol, chain: d.chain, feeApy: d.feeApy, tvlUsd: d.tvlUsd })
    }
  }
  return Array.from(byPair.values())
    .sort((a, b) => b.feeApy - a.feeApy)
    .slice(0, limit)
}

// ─────────────────────────────────────────────────────────────────────────
// Protocol-level Loan-to-Deposit Ratio (capital efficiency), Ethereum.
// ─────────────────────────────────────────────────────────────────────────

export interface ProtocolEfficiency {
  project: string
  label: string
  isFluid: boolean
  supplied: number
  borrowed: number
  /** LDR = borrowed / supplied, as a percentage. */
  ldr: number
}

export async function buildProtocolLDR(): Promise<{ rows: ProtocolEfficiency[]; fluidRank: number | null; of: number }> {
  const { lending } = await getYieldUniverse()
  const agg = new Map<string, { sup: number; bor: number }>()
  for (const r of lending) {
    if (r.chain !== "Ethereum") continue
    const a = agg.get(r.project) ?? { sup: 0, bor: 0 }
    a.sup += r.totalSupplyUsd ?? 0
    a.bor += r.totalBorrowUsd ?? 0
    agg.set(r.project, a)
  }
  const rows: ProtocolEfficiency[] = []
  for (const peer of LENDING_PEERS) {
    const a = agg.get(peer.project)
    if (!a || a.sup <= 0) continue
    rows.push({
      project: peer.project,
      label: peer.label,
      isFluid: Boolean(peer.isFluid),
      supplied: a.sup,
      borrowed: a.bor,
      ldr: (a.bor / a.sup) * 100,
    })
  }
  rows.sort((a, b) => b.ldr - a.ldr)
  const idx = rows.findIndex((r) => r.project === FLUID_PROJECT)
  return { rows, fluidRank: idx >= 0 ? idx + 1 : null, of: rows.length }
}

// Convenience batch builders for whole-page consumption.
export async function buildAllRateComparisons(
  metric: "supply" | "borrow",
  assetKeys?: string[],
): Promise<RateComparison[]> {
  const keys = assetKeys ?? ASSETS.map((a) => a.key)
  return Promise.all(keys.map((k) => buildRateComparison(k, metric)))
}

export async function buildAllCollateralShares(assetKeys?: string[]): Promise<ShareComparison[]> {
  const keys = assetKeys ?? ["ETH", "WSTETH", "WBTC", "USDC", "USDT"]
  return Promise.all(keys.map((k) => buildCollateralShare(k)))
}

export { peerLabel }
