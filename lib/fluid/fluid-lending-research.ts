/**
 * Research-grade lending metrics for Fluid: the stablecoin market position vs
 * peers, and the sUSDai / RWA franchise the ecosystem actually cares about
 * (Fluid is "the home for sUSDai" - dominant DEX venue + growing deposits).
 *
 * All from ONE cached /pools + /lendBorrow pull (DefiLlama yields). We keep the
 * per-pool `stablecoin` context ourselves via a symbol classifier so the
 * cross-protocol comparison is apples-to-apples on the same field
 * (/lendBorrow totalSupplyUsd = borrowable liquidity supplied).
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { getRawPools, getRawLendBorrow } from "./llama-pools"
import { LENDING_PEERS } from "./peers"


interface RawPool {
  pool: string
  project: string
  chain: string
  symbol: string
  tvlUsd?: number | null
  volumeUsd7d?: number | null
  stablecoin?: boolean
}
interface RawLendBorrow {
  pool: string
  totalSupplyUsd?: number | null
}


/** Broad stablecoin classifier (symbol-based) - catches the newer stables the
 *  DefiLlama `stablecoin` flag misses on Fluid's vault-structured pools
 *  (USDG, USDe, sUSDai, GHO, USDT0, ...). Matches the leading token symbol. */
const STABLE_RE =
  /^(USD|DAI|GHO|SUSD|USDE|USDT|USDC|USDS|USDG|USDAI|FRAX|LUSD|PYUSD|CRVUSD|USR|DEUSD|RLUSD|USDX|USD0|GYD|BOLD|USDL|EUR)/i
export function isStablecoin(symbol: string): boolean {
  return STABLE_RE.test((symbol || "").replace(/[^A-Z0-9]/gi, ""))
}

/** Spot-DEX venues for the sUSDai volume-share denominator. Pendle (yield
 *  tokenization) and lending pools are NOT spot DEXs, so they are excluded. */
const SPOT_DEX_RE = /(dex|curve|uniswap|balancer|pancake|sushi|aerodrome|velodrome)/i
const DEX_VENUE_LABEL: Record<string, string> = {
  "fluid-dex": "Fluid",
  "curve-dex": "Curve",
  "uniswap-v3": "Uniswap",
  "uniswap-v4": "Uniswap",
  "uniswap-v2": "Uniswap",
  "balancer-v3": "Balancer",
  "balancer-v2": "Balancer",
}
function venueLabel(project: string): string {
  return DEX_VENUE_LABEL[project] ?? project.replace(/-.*/, "").replace(/^\w/, (c) => c.toUpperCase())
}

export interface Ranked {
  label: string
  value: number
  isFluid: boolean
}

export interface LendingResearch {
  asOf: number
  /** Stablecoin lending supply per protocol (all chains), Fluid highlighted. */
  stablecoinShare: Ranked[]
  fluidStablecoinPct: number
  fluidStablecoinUsd: number
  /** Fluid's stablecoin deposits split by chain. */
  fluidStableByChain: Ranked[]
  /** sUSDai supplied on Fluid, by chain. */
  susdaiByChain: Ranked[]
  susdaiTotalUsd: number
  /** sUSDai spot-DEX 7d volume by venue, Fluid vs the rest. */
  susdaiDexShare: Ranked[]
  fluidSusdaiDexPct: number
  /** Stablecoin-pair (stable/stable) 7d DEX volume by venue across all indexed
   *  DEXs - the "Fluid is >50% of stablecoin DEX volume" claim. Top 6 + Other. */
  stablecoinDexShare: Ranked[]
  fluidStablecoinDexPct: number
}

/** Weekly volume above this multiple of a pool's TVL is a wash-trading
 *  signature (Fluid's real stable pools run ~14x; wash pools hit 35-60x on tiny
 *  TVL). Kept well above legitimate turnover so Fluid is never filtered. */
const WASH_TURNOVER_CAP = 30
function passesWashFilter(p: { volumeUsd7d?: number | null; tvlUsd?: number | null }): boolean {
  const v = p.volumeUsd7d ?? 0
  const t = p.tvlUsd ?? 0
  if (v <= 0) return false
  if (t > 0 && v / t > WASH_TURNOVER_CAP) return false
  return true
}

/** True when a DEX pool symbol is a stable/stable pair (both legs stable). */
function isStablePair(symbol: string): boolean {
  const toks = (symbol || "")
    .toUpperCase()
    .split(/[-/]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return toks.length === 2 && toks.every(isStablecoin)
}

async function build(): Promise<LendingResearch> {
  const [poolsRaw, lbRaw] = await Promise.all([getRawPools(), getRawLendBorrow()])
  const pools = poolsRaw as unknown as RawPool[]
  const lb = lbRaw as unknown as RawLendBorrow[]
  const supplyOf = new Map(lb.map((r) => [r.pool, r.totalSupplyUsd ?? 0]))
  const peerSet = new Map(LENDING_PEERS.map((p) => [p.project, p]))

  // Stablecoin lending supply per protocol.
  const byProj = new Map<string, number>()
  const fluidByChain = new Map<string, number>()
  for (const p of pools) {
    const peer = peerSet.get(p.project)
    if (!peer) continue
    if (!isStablecoin(p.symbol)) continue
    const sup = supplyOf.get(p.pool) ?? 0
    byProj.set(p.project, (byProj.get(p.project) ?? 0) + sup)
    if (peer.isFluid) fluidByChain.set(p.chain, (fluidByChain.get(p.chain) ?? 0) + sup)
  }
  const stablecoinShare: Ranked[] = [...byProj.entries()]
    .map(([proj, v]) => ({ label: peerSet.get(proj)!.label, value: v, isFluid: !!peerSet.get(proj)!.isFluid }))
    .sort((a, b) => b.value - a.value)
  const totalStable = stablecoinShare.reduce((s, d) => s + d.value, 0)
  const fluidStablecoinUsd = stablecoinShare.find((d) => d.isFluid)?.value ?? 0

  const fluidStableByChain: Ranked[] = [...fluidByChain.entries()]
    .map(([chain, v]) => ({ label: chain, value: v, isFluid: true }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)

  // sUSDai franchise: deposits on Fluid by chain + spot-DEX volume share.
  const susdaiChain = new Map<string, number>()
  for (const p of pools) {
    if (p.project !== "fluid-lending") continue
    if (!/SUSDAI/i.test(p.symbol)) continue
    susdaiChain.set(p.chain, (susdaiChain.get(p.chain) ?? 0) + (supplyOf.get(p.pool) ?? 0))
  }
  const susdaiByChain: Ranked[] = [...susdaiChain.entries()]
    .map(([chain, v]) => ({ label: chain, value: v, isFluid: true }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
  const susdaiTotalUsd = susdaiByChain.reduce((s, d) => s + d.value, 0)

  const dexByVenue = new Map<string, number>()
  for (const p of pools) {
    if (!/SUSDAI/i.test(p.symbol)) continue
    if (!SPOT_DEX_RE.test(p.project)) continue
    if (!passesWashFilter(p)) continue
    const label = venueLabel(p.project)
    dexByVenue.set(label, (dexByVenue.get(label) ?? 0) + (p.volumeUsd7d ?? 0))
  }
  const susdaiDexShare: Ranked[] = [...dexByVenue.entries()]
    .map(([label, v]) => ({ label, value: v, isFluid: label === "Fluid" }))
    .sort((a, b) => b.value - a.value)
  const totalDexVol = susdaiDexShare.reduce((s, d) => s + d.value, 0)

  // Stablecoin-pair DEX volume share on ETHEREUM (the report's "most volume on
  // Ethereum" claim) with wash-trading pools filtered out. Ethereum + wash filter
  // makes this robust to the anomaly-prone all-chain 7d snapshot.
  const stableDexByVenue = new Map<string, number>()
  for (const p of pools) {
    if (p.chain !== "Ethereum") continue
    if (!SPOT_DEX_RE.test(p.project)) continue
    if (!isStablePair(p.symbol)) continue
    if (!passesWashFilter(p)) continue
    const label = venueLabel(p.project)
    stableDexByVenue.set(label, (stableDexByVenue.get(label) ?? 0) + (p.volumeUsd7d ?? 0))
  }
  const stableDexSorted: Ranked[] = [...stableDexByVenue.entries()]
    .map(([label, v]) => ({ label, value: v, isFluid: label === "Fluid" }))
    .sort((a, b) => b.value - a.value)
  const totalStableDex = stableDexSorted.reduce((s, d) => s + d.value, 0)
  const topStableDex = stableDexSorted.slice(0, 6)
  const otherStableDex = stableDexSorted.slice(6).reduce((s, d) => s + d.value, 0)
  const stablecoinDexShare: Ranked[] =
    otherStableDex > 0 ? [...topStableDex, { label: "Other", value: otherStableDex, isFluid: false }] : topStableDex

  return {
    asOf: Math.floor(Date.now() / 1000),
    stablecoinShare,
    fluidStablecoinPct: totalStable > 0 ? (fluidStablecoinUsd / totalStable) * 100 : 0,
    fluidStablecoinUsd,
    fluidStableByChain,
    susdaiByChain,
    susdaiTotalUsd,
    susdaiDexShare,
    fluidSusdaiDexPct: totalDexVol > 0 ? ((dexByVenue.get("Fluid") ?? 0) / totalDexVol) * 100 : 0,
    stablecoinDexShare,
    fluidStablecoinDexPct: totalStableDex > 0 ? ((stableDexByVenue.get("Fluid") ?? 0) / totalStableDex) * 100 : 0,
  }
}

export const getLendingResearch = ttlMemo(build, TTL_5MIN)
