/**
 * Fluid Lite: the managed stETH vault (ETH-denominated yield strategy on
 * Ethereum). The Q4 report highlighted "USD TVL down but ETH-denominated at
 * ATH" - true at Q4, but live data shows stETH holdings peaked in Jan 2026 and
 * have since bled, so the drawdown is BOTH ETH price and real outflow. We show
 * USD TVL vs stETH held (indexed) so the split is visible, plus revenue.
 *
 * Sources: /protocol/fluid-lite (tokensInUsd = USD, tokens = stETH units) and
 * /summary/fees/fluid-lite (revenue).
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson as fetchResilient } from "./fetch-json"

const PROTOCOL = "https://api.llama.fi/protocol/fluid-lite"
const FEES = "https://api.llama.fi/summary/fees/fluid-lite?dataType=dailyRevenue"

interface TokenPoint { date: number; tokens: Record<string, number> }
interface ProtocolResp { chainTvls?: Record<string, { tokens?: TokenPoint[]; tokensInUsd?: TokenPoint[] }> }
interface FeesResp { totalDataChart?: Array<[number, number]>; total30d?: number; totalAllTime?: number }

export interface LitePoint { t: number; v: number }
export interface LiteIndexRow { t: number; usd: number; steth: number }
export interface FluidLite {
  asOf: number
  tvlUsd: number
  stEth: number
  peakUsd: number
  peakUnits: number
  peakDate: number
  drawdownUsdPct: number
  drawdownUnitsPct: number
  revenue30d: number
  revenueAllTime: number
  /** USD TVL + stETH held, each indexed to 100 at inception (divergence view). */
  indexed: LiteIndexRow[]
  revenueDaily: LitePoint[]
}

const fetchJson = fetchResilient

const TOKEN = "STETH"

async function build(): Promise<FluidLite> {
  const [proto, fees] = await Promise.all([
    fetchJson<ProtocolResp>(PROTOCOL),
    fetchJson<FeesResp>(FEES),
  ])
  const ct = proto?.chainTvls?.Ethereum ?? {}
  const unitsArr = ct.tokens ?? []
  const usdArr = ct.tokensInUsd ?? []

  const usdByDate = new Map(usdArr.map((r) => [r.date, r.tokens?.[TOKEN] ?? 0]))
  const rows: LiteIndexRow[] = []
  let firstUsd = 0
  let firstUnits = 0
  for (const r of unitsArr) {
    const units = r.tokens?.[TOKEN] ?? 0
    const usd = usdByDate.get(r.date) ?? 0
    if (units <= 0 || usd <= 0) continue
    if (firstUnits === 0) {
      firstUnits = units
      firstUsd = usd
    }
    rows.push({ t: r.date, usd: (usd / firstUsd) * 100, steth: (units / firstUnits) * 100 })
  }

  const curUnits = unitsArr.at(-1)?.tokens?.[TOKEN] ?? 0
  const curUsd = usdArr.at(-1)?.tokens?.[TOKEN] ?? 0
  let peakUnits = 0
  let peakUsd = 0
  let peakDate = 0
  for (const r of unitsArr) {
    const u = r.tokens?.[TOKEN] ?? 0
    if (u > peakUnits) {
      peakUnits = u
      peakDate = r.date
    }
  }
  for (const r of usdArr) peakUsd = Math.max(peakUsd, r.tokens?.[TOKEN] ?? 0)

  const revenueDaily: LitePoint[] = (fees?.totalDataChart ?? []).map(([t, v]) => ({ t, v }))

  return {
    asOf: Math.floor(Date.now() / 1000),
    tvlUsd: curUsd,
    stEth: curUnits,
    peakUsd,
    peakUnits,
    peakDate,
    drawdownUsdPct: peakUsd > 0 ? ((curUsd - peakUsd) / peakUsd) * 100 : 0,
    drawdownUnitsPct: peakUnits > 0 ? ((curUnits - peakUnits) / peakUnits) * 100 : 0,
    revenue30d: fees?.total30d ?? 0,
    revenueAllTime: fees?.totalAllTime ?? 0,
    indexed: rows,
    revenueDaily,
  }
}

export const getFluidLite = ttlMemo(build, TTL_5MIN)
