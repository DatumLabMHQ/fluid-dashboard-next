/**
 * $FLUID token + value-accrual data. Fluid treats the token as a product
 * vertical: all Ethereum revenue is directed to buybacks (per the Q4 2025
 * report), so this panel tracks price, market cap, the revenue that funds
 * buybacks, and where that revenue comes from.
 *
 * Sources: DefiLlama /protocol/fluid (mcap), coins.llama.fi (FLUID price
 * history), /summary/fees/fluid?dataType=dailyRevenue (revenue by chain +
 * product). The buyback figure is a PROXY: cumulative Ethereum revenue since
 * buybacks began (Oct 2025), clearly framed as such - we do not read the
 * buyback contract directly.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson as fetchResilient } from "./fetch-json"
import { chainColor, chainLabel } from "./chains"
import type { AssetHistory, AssetSeries, AreaRow } from "./fluid-asset-history"

// FLUID (ex-INST) on Ethereum. Verified live via coins.llama.fi (confidence 0.99).
const FLUID_ADDR = "0x6f40d4a6237c257fff2db00fa0510deeecd303eb"
const JUP_REVENUE = "https://api.llama.fi/summary/fees/jupiter-lend?dataType=dailyRevenue"
const JUP_FEES = "https://api.llama.fi/summary/fees/jupiter-lend?dataType=dailyFees"
const PROTOCOL = "https://api.llama.fi/protocol/fluid"
const COINS_CHART = `https://coins.llama.fi/chart/ethereum:${FLUID_ADDR}?period=1d&span=400`
const REVENUE = "https://api.llama.fi/summary/fees/fluid?dataType=dailyRevenue"
const FEES = "https://api.llama.fi/summary/fees/fluid?dataType=dailyFees"

// Buybacks began in Q4 2025; Oct 1 2025 is the conservative start of the window.
const BUYBACK_START = Math.floor(Date.UTC(2025, 9, 1) / 1000)

const PRODUCT_COLOR: Record<string, string> = {
  "Fluid DEX": "var(--chart-1)",
  "Fluid Lending": "var(--chart-2)",
  "Fluid Lite": "var(--chart-3)",
  "Fluid DEX Lite": "var(--chart-4)",
}

export interface TokenPoint {
  t: number
  v: number
}
export interface FluidToken {
  asOf: number
  price: number
  priceChange30dPct: number | null
  priceHistory: TokenPoint[]
  marketCap: number
  circulatingSupply: number
  revenue30d: number
  annualizedRevenue: number
  fees30d: number
  feesAllTime: number
  /** protocol revenue / gross fees, as a % (the DAO's take rate). */
  takeRatePct: number | null
  /** Aligned daily gross fees vs protocol revenue (last 365d). */
  feesVsRevenue: Array<{ t: number; fees: number; revenue: number }>
  /** mcap / annualized revenue (price-to-sales style). */
  psRatio: number | null
  /** Cumulative Ethereum revenue since buybacks began (proxy for buyback spend). */
  buybackCumulativeUsd: number
  buybackCumulative: TokenPoint[]
  revenueByChain: AssetHistory
  revenueByProduct: AssetHistory
  /** Revenue split by SOURCE: Fluid's own markets vs the Jupiter Lend white-label.
   *  DefiLlama files Jupiter Lend as its own protocol, so the `fluid` slug alone
   *  understates the ecosystem. This pairs them and exposes the take-rate gap. */
  revenueBySource: AssetHistory
  sourceSplit: {
    fluidRevenue30d: number
    jupRevenue30d: number
    fluidFees30d: number
    jupFees30d: number
    fluidTakeRatePct: number | null
    jupTakeRatePct: number | null
    blendedTakeRatePct: number | null
    jupRevenueSharePct: number | null
    jupFeeSharePct: number | null
  }
}

const fetchJson = fetchResilient

/** Revenue breakdown value per chain is either a number or {product: number}. */
function flat(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (v && typeof v === "object") return Object.values(v as Record<string, number>).reduce((s, n) => s + (typeof n === "number" ? n : 0), 0)
  return 0
}

/** Build a stacked-area history (top N + Other) from a per-day/key map. */
function toHistory(byDate: Map<number, Record<string, number>>, colorOf: (k: string, i: number) => string, labelOf: (k: string) => string, topN = 6): AssetHistory {
  const dates = [...byDate.keys()].sort((a, b) => a - b)
  if (dates.length === 0) return { series: [], rows: [] }
  const totals = new Map<string, number>()
  for (const row of byDate.values()) for (const [k, v] of Object.entries(row)) totals.set(k, (totals.get(k) ?? 0) + v)
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, topN).map(([k]) => k)
  const topSet = new Set(top)
  const hasOther = ranked.length > topN
  const series: AssetSeries[] = top.map((k, i) => ({ key: k, label: labelOf(k), color: colorOf(k, i) }))
  if (hasOther) series.push({ key: "Other", label: "Other", color: "var(--text-muted)" })
  const rows: AreaRow[] = dates.map((d) => {
    const src = byDate.get(d) ?? {}
    const row: AreaRow = { t: d }
    for (const k of top) row[k] = src[k] ?? 0
    if (hasOther) {
      let o = 0
      for (const [k, v] of Object.entries(src)) if (!topSet.has(k)) o += v
      row.Other = o
    }
    return row
  })
  return { series, rows }
}

async function build(): Promise<FluidToken> {
  const [proto, coins, rev, feeResp, jupRev, jupFees] = await Promise.all([
    fetchJson<{ mcap?: number }>(PROTOCOL),
    fetchJson<{ coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }> }>(COINS_CHART),
    fetchJson<{ totalDataChartBreakdown?: Array<[number, Record<string, unknown>]>; totalDataChart?: Array<[number, number]>; total30d?: number }>(REVENUE),
    fetchJson<{ totalDataChart?: Array<[number, number]>; total30d?: number; totalAllTime?: number }>(FEES),
    fetchJson<{ totalDataChart?: Array<[number, number]>; total30d?: number }>(JUP_REVENUE).catch(() => null),
    fetchJson<{ totalDataChart?: Array<[number, number]>; total30d?: number }>(JUP_FEES).catch(() => null),
  ])

  // Don't cache a blank token page - if price + mcap both failed, throw so the
  // loader degrades and the next request retries (ttlMemo won't cache the throw).
  if (!coins?.coins?.[`ethereum:${FLUID_ADDR}`]?.prices?.length && !proto?.mcap) {
    throw new Error("fluid-token: price + mcap unavailable")
  }
  const prices = coins?.coins?.[`ethereum:${FLUID_ADDR}`]?.prices ?? []
  const priceHistory: TokenPoint[] = prices.map((p) => ({ t: p.timestamp, v: p.price }))
  const price = priceHistory.at(-1)?.v ?? 0
  const price30dAgo = priceHistory.length > 30 ? priceHistory[priceHistory.length - 31].v : null
  const priceChange30dPct = price30dAgo && price30dAgo > 0 ? ((price - price30dAgo) / price30dAgo) * 100 : null

  const marketCap = proto?.mcap ?? 0
  const circulatingSupply = price > 0 ? marketCap / price : 0

  const bd = rev?.totalDataChartBreakdown ?? []
  const byChain = new Map<number, Record<string, number>>()
  const byProduct = new Map<number, Record<string, number>>()
  const buybackCumulative: TokenPoint[] = []
  let buybackCumulativeUsd = 0
  for (const [ts, chains] of bd) {
    const day = Math.floor(ts / 86_400) * 86_400
    const chainRow: Record<string, number> = {}
    const prodRow: Record<string, number> = {}
    for (const [chain, val] of Object.entries(chains)) {
      chainRow[chain] = (chainRow[chain] ?? 0) + flat(val)
      if (val && typeof val === "object") {
        for (const [prod, n] of Object.entries(val as Record<string, number>)) {
          if (typeof n === "number" && Number.isFinite(n)) prodRow[prod] = (prodRow[prod] ?? 0) + n
        }
      }
    }
    byChain.set(day, chainRow)
    byProduct.set(day, prodRow)
    if (ts >= BUYBACK_START) {
      buybackCumulativeUsd += chainRow.Ethereum ?? 0
      buybackCumulative.push({ t: day, v: buybackCumulativeUsd })
    }
  }

  // ── Revenue by SOURCE (Fluid's own markets vs the Jupiter Lend white-label) ──
  // Fluid keeps a far smaller share of what Jupiter Lend's borrowers pay (a 50/50
  // split with Jupiter), so the white-label can carry nearly half the ecosystem's
  // fees while contributing about a quarter of the revenue. That gap is the point.
  const jupRevByDay = new Map<number, number>()
  for (const [ts, v] of jupRev?.totalDataChart ?? []) jupRevByDay.set(Math.floor(ts / 86_400) * 86_400, v)
  const fluidRevByDay = new Map<number, number>()
  for (const [ts, v] of rev?.totalDataChart ?? []) fluidRevByDay.set(Math.floor(ts / 86_400) * 86_400, v)
  const sourceDays = [...new Set([...fluidRevByDay.keys(), ...jupRevByDay.keys()])].sort((a, b) => a - b)
  const bySource = new Map<number, Record<string, number>>()
  for (const d of sourceDays) {
    bySource.set(d, {
      "Fluid (own markets)": fluidRevByDay.get(d) ?? 0,
      "Jupiter Lend (white-label)": jupRevByDay.get(d) ?? 0,
    })
  }
  const last30 = (chart?: Array<[number, number]>) => {
    const pts = chart ?? []
    return pts.slice(-30).reduce((s, [, v]) => s + v, 0)
  }
  const fluidRevenue30d = rev?.total30d ?? last30(rev?.totalDataChart)
  const jupRevenue30d = jupRev?.total30d ?? last30(jupRev?.totalDataChart)
  const fluidFees30d = feeResp?.total30d ?? last30(feeResp?.totalDataChart)
  const jupFees30d = jupFees?.total30d ?? last30(jupFees?.totalDataChart)
  const rate = (r: number, f: number) => (f > 0 ? (r / f) * 100 : null)
  const sourceSplit = {
    fluidRevenue30d, jupRevenue30d, fluidFees30d, jupFees30d,
    fluidTakeRatePct: rate(fluidRevenue30d, fluidFees30d),
    jupTakeRatePct: rate(jupRevenue30d, jupFees30d),
    blendedTakeRatePct: rate(fluidRevenue30d + jupRevenue30d, fluidFees30d + jupFees30d),
    jupRevenueSharePct: fluidRevenue30d + jupRevenue30d > 0
      ? (jupRevenue30d / (fluidRevenue30d + jupRevenue30d)) * 100 : null,
    jupFeeSharePct: fluidFees30d + jupFees30d > 0
      ? (jupFees30d / (fluidFees30d + jupFees30d)) * 100 : null,
  }

  const revenue30d = rev?.total30d ?? 0
  const annualizedRevenue = revenue30d * (365 / 30)
  const psRatio = annualizedRevenue > 0 ? marketCap / annualizedRevenue : null

  // Gross fees vs protocol revenue (the report leads its financials with both).
  const fees30d = feeResp?.total30d ?? 0
  const feesAllTime = feeResp?.totalAllTime ?? 0
  const takeRatePct = fees30d > 0 ? (revenue30d / fees30d) * 100 : null
  const revByDay = new Map((rev?.totalDataChart ?? []).map(([t, v]) => [Math.floor(t / 86_400) * 86_400, v]))
  const cutoff = Math.floor(Date.now() / 1000) - 365 * 86_400
  const feesVsRevenue = (feeResp?.totalDataChart ?? [])
    .filter(([t]) => t >= cutoff)
    .map(([t, fees]) => {
      const day = Math.floor(t / 86_400) * 86_400
      return { t: day, fees, revenue: revByDay.get(day) ?? 0 }
    })

  return {
    asOf: Math.floor(Date.now() / 1000),
    price,
    priceChange30dPct,
    priceHistory,
    marketCap,
    circulatingSupply,
    revenue30d,
    annualizedRevenue,
    fees30d,
    feesAllTime,
    takeRatePct,
    feesVsRevenue,
    psRatio,
    buybackCumulativeUsd,
    buybackCumulative,
    revenueByChain: toHistory(byChain, (k, i) => chainColor(k, i), (k) => chainLabel(k)),
    revenueByProduct: toHistory(byProduct, (k) => PRODUCT_COLOR[k] ?? "var(--chart-5)", (k) => k),
    revenueBySource: toHistory(
      bySource,
      (k) => (k.startsWith("Jupiter") ? "var(--accent-secondary)" : "var(--accent)"),
      (k) => k,
    ),
    sourceSplit,
  }
}

export const getFluidToken = ttlMemo(build, TTL_5MIN)
