/**
 * Fluid DEX research data layer. The DEX's defining trait is capital efficiency:
 * it routes huge volume through small liquidity (USDC-USDT does ~$590M/wk on
 * ~$32M TVL). We surface volume + TVL history, per-pair turnover (annualized
 * volume / TVL), fee yields, and the Liquidity-as-a-Service (sUSDai / RWA)
 * facilities.
 *
 * Sources: /summary/dexs/fluid (volume + per-chain breakdown), /protocol/
 * fluid-dex (TVL history), and the fluid-dex pools from the yield universe.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson as fetchResilient } from "./fetch-json"
import { getYieldUniverse, DEX_PEERS, type DexAgg } from "./yield-universe"
import { chainOrder } from "./chains"

const DEX_LABEL: Record<string, string> = {
  "fluid-dex": "Fluid DEX",
  "uniswap-v3": "Uniswap v3",
  "uniswap-v2": "Uniswap v2",
  "curve-dex": "Curve",
  "balancer-v2": "Balancer",
  "pancakeswap-amm-v3": "PancakeSwap v3",
}

export interface TurnoverPoint {
  project: string
  label: string
  /** Daily volume per $1 of liquidity (vol7d / 7 / TVL). */
  perDollar: number
  isFluid: boolean
}
export interface TurnoverScope {
  points: TurnoverPoint[]
  fluidPerDollar: number
  vsUniswap: number | null
  vsCurve: number | null
}
export interface DexTurnover {
  ethereum: TurnoverScope
  all: TurnoverScope
  fetchedAt: number
}

function scopeOf(agg: Record<string, DexAgg>): TurnoverScope {
  const points: TurnoverPoint[] = DEX_PEERS.map((proj) => {
    const a = agg[proj]
    const perDollar = a && a.tvl > 0 ? a.vol7d / 7 / a.tvl : 0
    return { project: proj, label: DEX_LABEL[proj] ?? proj, perDollar, isFluid: proj === "fluid-dex" }
  })
    .filter((p) => p.perDollar > 0)
    .sort((a, b) => b.perDollar - a.perDollar)
  const fluid = points.find((p) => p.isFluid)?.perDollar ?? 0
  const uni = points.find((p) => p.project === "uniswap-v3")?.perDollar ?? 0
  const cur = points.find((p) => p.project === "curve-dex")?.perDollar ?? 0
  return {
    points,
    fluidPerDollar: fluid,
    vsUniswap: uni > 0 ? fluid / uni : null,
    vsCurve: cur > 0 ? fluid / cur : null,
  }
}

export async function buildDexTurnover(): Promise<DexTurnover> {
  const u = await getYieldUniverse()
  return {
    ethereum: scopeOf(u.dexTurnover.ethereum),
    all: scopeOf(u.dexTurnover.all),
    fetchedAt: Math.floor(Date.now() / 1000),
  }
}

const LLAMA = "https://api.llama.fi"

export interface DayPoint { t: number; v: number }
export interface DexSnapshot {
  current: number
  change24h: number | null
  change30d: number | null
  change365d: number | null
  spark: Array<{ t: number; v: number }>
}

export interface DexPool {
  pair: string
  chain: string
  tvl: number
  volume7d: number
  volume1d: number
  feeApy: number | null
  /** Annualized volume / TVL — how hard each dollar of liquidity works. */
  turnover: number
  isLaaS: boolean
}

export interface DexAligned {
  chains: Array<{ key: string; label: string }>
  /** Weekly-aligned per-chain daily volume rows for the stacked area. */
  rows: Array<{ t: number; [chain: string]: number | null }>
}

export interface ClassSlice { name: string; volume7d: number; tvl: number }

export interface FluidDexData {
  tvlSnap: DexSnapshot
  volume24hSnap: DexSnapshot
  volume30d: number
  avgTurnover: number
  feeApy7dAvg: number
  pairCount: number
  byChainVolume: DexAligned
  /** Total daily DEX volume (for the quarterly view). */
  volumeDaily: DayPoint[]
  /** Daily fees + fee-rate (fees / volume, %) series. */
  feesDaily: DayPoint[]
  feeRateDaily: DayPoint[]
  /** Current volume + TVL by asset class (stablecoins / LSTs / BTC / RWA). */
  byAssetClass: ClassSlice[]
  pools: DexPool[]
  laas: DexPool[]
  fetchedAt: number
}

// Asset-class buckets for pair classification.
const STABLE = new Set(["USDC", "USDT", "DAI", "USDE", "GHO", "USDS", "USD0", "USDT0", "USD₮0", "FRAX", "PYUSD", "RLUSD", "USDTB", "USDG", "AUSD", "REUSD", "SUSDE", "SUSDS", "SDAI", "FXUSD", "BUSD0", "JUPUSD", "IUSD", "USDAT", "SAVUSD", "SUSDAT"])
const ETHLST = new Set(["ETH", "WETH", "WSTETH", "WEETH", "CBETH", "RETH", "EZETH", "OSETH", "RSETH", "WEETHS", "METH", "SOL", "JUPSOL", "DFDVSOL", "FWDSOL", "WDSOL", "JLP", "BBSOL"])
const BTC = new Set(["WBTC", "CBBTC", "TBTC", "LBTC", "EBTC", "KBTC"])
const RWA = new Set(["SUSDAI", "USDAI", "MUBOND", "QQQX", "MSY", "SYRUPUSDC", "SYRUPUSDT", "PST"])

function classifyPair(symbol: string): string {
  const tokens = symbol.toUpperCase().split(/[-/]/).map((s) => s.trim())
  if (tokens.some((t) => RWA.has(t))) return "RWA"
  if (tokens.every((t) => STABLE.has(t))) return "Stablecoins"
  if (tokens.some((t) => BTC.has(t))) return "BTC"
  if (tokens.some((t) => ETHLST.has(t))) return "LSTs / ETH"
  return "Other"
}

interface FeesResp {
  total24h?: number
  total7d?: number
  total30d?: number
  totalDataChart?: Array<[number, number]>
  totalDataChartBreakdown?: Array<[number, Record<string, Record<string, number> | number>]>
}
interface ProtoResp { tvl?: Array<{ date: number; totalLiquidityUSD: number }> }

const fetchJson = fetchResilient

function snapOf(series: DayPoint[]): DexSnapshot {
  const current = series.at(-1)?.v ?? 0
  const at = (days: number): number | null => {
    if (series.length === 0) return null
    const target = series[series.length - 1].t - days * 86_400
    let best: DayPoint | null = null
    let diff = Infinity
    for (const p of series) { const d = Math.abs(p.t - target); if (d < diff) { diff = d; best = p } }
    return best && diff <= 3 * 86_400 ? best.v : null
  }
  const d = (n: number) => { const p = at(n); return p == null ? null : current - p }
  return { current, change24h: d(1), change30d: d(30), change365d: d(365), spark: series.slice(-30) }
}

const isLaaSPair = (sym: string) => /SUSDAI|USDAI/i.test(sym)

async function build(): Promise<FluidDexData> {
  const [vol, proto, universe, fees] = await Promise.all([
    fetchJson<FeesResp>(`${LLAMA}/summary/dexs/fluid?dataType=dailyVolume`),
    fetchJson<ProtoResp>(`${LLAMA}/protocol/fluid-dex`),
    getYieldUniverse(),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/fluid-dex?dataType=dailyFees`),
  ])

  // Volume daily (total) + TVL daily.
  const volDaily: DayPoint[] = (vol?.totalDataChart ?? []).map(([t, v]) => ({ t, v }))
  const tvlDaily: DayPoint[] = (proto?.tvl ?? []).map((r) => ({ t: r.date, v: r.totalLiquidityUSD }))

  // Daily fees + fee rate (fees / volume, %).
  const feesDaily: DayPoint[] = (fees?.totalDataChart ?? []).map(([t, v]) => ({ t, v }))
  const volByDay = new Map(volDaily.map((p) => [p.t, p.v]))
  const feeRateDaily: DayPoint[] = feesDaily
    .map((f) => {
      const v = volByDay.get(f.t)
      return v && v > 0 ? { t: f.t, v: (f.v / v) * 100 } : null
    })
    .filter((x): x is DayPoint => x !== null)

  // Per-chain daily volume from the breakdown -> weekly-aligned for stacking.
  const chainVol = new Map<string, Map<number, number>>()
  for (const [ts, perChain] of vol?.totalDataChartBreakdown ?? []) {
    for (const [chain, v] of Object.entries(perChain)) {
      let usd = 0
      if (typeof v === "number") usd = v
      else for (const x of Object.values(v)) if (typeof x === "number") usd += x
      if (!chainVol.has(chain)) chainVol.set(chain, new Map())
      chainVol.get(chain)!.set(ts, usd)
    }
  }
  const chainKeys = [...chainVol.keys()].sort((a, b) => chainOrder(a) - chainOrder(b))
  const now = volDaily.at(-1)?.t ?? Math.floor(Date.now() / 1000)
  const start = now - 365 * 86_400
  const grid: number[] = []
  for (let t = start; t <= now; t += 7 * 86_400) grid.push(t)
  const sampleSum = (m: Map<number, number>, t: number) => {
    // sum the week's daily volumes ending at t (a weekly volume bucket).
    let s = 0
    for (let d = 0; d < 7; d++) s += m.get(t - d * 86_400) ?? 0
    return s
  }
  const rows = grid.map((t) => {
    const row: { t: number; [c: string]: number | null } = { t }
    for (const c of chainKeys) row[c] = sampleSum(chainVol.get(c)!, t)
    return row
  })

  // Per-pair pools.
  const pools: DexPool[] = universe.dex
    .filter((d) => d.project === "fluid-dex")
    .map((d) => {
      const turnover = d.tvlUsd > 0 ? ((d.volumeUsd7d / 7) * 365) / d.tvlUsd : 0
      return {
        pair: d.symbol,
        chain: d.chain,
        tvl: d.tvlUsd,
        volume7d: d.volumeUsd7d,
        volume1d: d.volumeUsd1d,
        feeApy: d.feeApy,
        turnover,
        isLaaS: isLaaSPair(d.symbol),
      }
    })
    .sort((a, b) => b.volume7d - a.volume7d)

  // Current volume + TVL by asset class.
  const classMap = new Map<string, ClassSlice>()
  for (const p of pools) {
    const cls = classifyPair(p.pair)
    const c = classMap.get(cls) ?? { name: cls, volume7d: 0, tvl: 0 }
    c.volume7d += p.volume7d
    c.tvl += p.tvl
    classMap.set(cls, c)
  }
  const byAssetClass = [...classMap.values()].sort((a, b) => b.volume7d - a.volume7d)

  const totalTvl = pools.reduce((s, p) => s + p.tvl, 0)
  const totalVol7d = pools.reduce((s, p) => s + p.volume7d, 0)
  const avgTurnover = totalTvl > 0 ? ((totalVol7d / 7) * 365) / totalTvl : 0
  const feeWeighted = pools.reduce((s, p) => s + (p.feeApy ?? 0) * p.tvl, 0)
  const feeApy7dAvg = totalTvl > 0 ? feeWeighted / totalTvl : 0

  return {
    tvlSnap: snapOf(tvlDaily),
    volume24hSnap: snapOf(volDaily),
    volume30d: vol?.total30d ?? volDaily.slice(-30).reduce((s, p) => s + p.v, 0),
    avgTurnover,
    feeApy7dAvg,
    pairCount: pools.filter((p) => p.volume7d > 0).length,
    byChainVolume: {
      chains: chainKeys.map((k) => ({ key: k, label: k })),
      rows,
    },
    volumeDaily: volDaily,
    feesDaily,
    feeRateDaily,
    byAssetClass,
    pools,
    laas: pools.filter((p) => p.isLaaS).sort((a, b) => b.tvl - a.tvl),
    fetchedAt: Math.floor(Date.now() / 1000),
  }
}

export const getFluidDex = ttlMemo(build, TTL_5MIN)
