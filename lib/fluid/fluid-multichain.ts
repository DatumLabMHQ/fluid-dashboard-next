/**
 * Fluid multi-chain protocol layer (the Overview's data spine). Combines Fluid
 * Lending across its EVM chains (Ethereum, Arbitrum, Base, Polygon, Plasma) with
 * Jupiter Lend on Solana (Fluid's Solana deployment, branded "JupLend").
 *
 * Per chain and in aggregate we expose daily series for the analyst metrics:
 *   deposits (total supplied), borrows (outstanding debt), tvl (net / available
 *   liquidity), utilization (borrows/deposits), and revenue. Plus current
 *   snapshots with 24h / 30d / 365d deltas and sparklines for the metric cards.
 *
 * Verified: each chain has full tvl + `<chain>-borrowed` history; revenue per
 * chain comes from the fees `totalDataChartBreakdown`.
 */
import { ttlMemo, TTL_5MIN } from "./cache"

const LLAMA = "https://api.llama.fi"

export type MetricKey = "deposits" | "borrows" | "tvl" | "utilization" | "revenue"

export interface DayMetrics {
  t: number
  deposits: number
  borrows: number
  tvl: number
  utilization: number | null
  revenue: number
  fees: number
}

export interface ChainSeries {
  chain: string
  label: string
  /** Native-resolution daily series. */
  daily: DayMetrics[]
}

/** Current per-chain snapshot for the stat cards. */
export interface ChainSnapshot {
  chain: string
  label: string
  deposits: number
  tvl: number
  borrows: number
  utilization: number
  ldr: number
  fees7d: number
  revenue30d: number
  /** Constant-price net change in the deposit base over 30d (price excluded). */
  netDeposits30d: number
}

export interface MetricSnapshot {
  current: number
  change24h: number | null
  change30d: number | null
  change365d: number | null
  /** Recent daily values for the sparkline. */
  spark: Array<{ t: number; v: number }>
}

export type Period = "current" | "week" | "month" | "quarter"

export interface MixSnapshot {
  /** Collateral/supply USD by token (gross supplied = net + borrowed). */
  supplied: Record<string, number>
  /** Borrowed USD by token. */
  borrowed: Record<string, number>
}
export interface ChainMix {
  chain: string
  label: string
  periods: Record<Period, MixSnapshot>
}

export type FlowWindow = "week" | "month" | "quarter"
export interface SankeyNode { name: string; kind: "in" | "chain" | "out" }
export interface SankeyLink { source: number; target: number; value: number }
export interface FlowData {
  nodes: SankeyNode[]
  links: SankeyLink[]
  netByChain: Record<string, number>
  totalIn: number
  totalOut: number
}

export interface MultiChainData {
  chains: ChainSeries[]
  aggregateDaily: DayMetrics[]
  /** Per-metric snapshot of the aggregate (for the metric cards). */
  snap: Record<MetricKey, MetricSnapshot> & { ldr: MetricSnapshot }
  /** Current per-chain snapshots for the stat cards. */
  perChain: ChainSnapshot[]
  /** Per-chain collateral / borrow token mix at each period. */
  mix: ChainMix[]
  /** Net supply-flow Sankey data per window (constant prices). */
  flows: Record<FlowWindow, FlowData>
  fetchedAt: number
}

const PERIOD_DAYS: Record<Period, number> = { current: 0, week: 7, month: 30, quarter: 90 }

// EVM chains live under fluid-lending; Solana under jupiter-lend (JupLend).
const FLUID_CHAINS: Array<{ key: string; label: string }> = [
  { key: "Ethereum", label: "Ethereum" },
  { key: "Arbitrum", label: "Arbitrum" },
  { key: "Base", label: "Base" },
  { key: "Polygon", label: "Polygon" },
  { key: "Plasma", label: "Plasma" },
]
const SOLANA = { key: "Solana", label: "Solana (JupLend)" }

interface TvlPoint { date: number; totalLiquidityUSD: number }
interface TokenPoint { date: number; tokens: Record<string, number> }
interface ChainEntry { tvl?: TvlPoint[]; tokens?: TokenPoint[]; tokensInUsd?: TokenPoint[] }
interface ProtocolResp { chainTvls?: Record<string, ChainEntry> }
interface FeesResp {
  totalDataChartBreakdown?: Array<[number, Record<string, Record<string, number> | number>]>
}

async function fetchJson<T>(url: string): Promise<T | null> {
  // Retry a couple of times - a cold-start burst of parallel calls can hit a
  // transient DefiLlama rate-limit / hiccup, and we must not poison the cache.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" })
      if (res.ok) return (await res.json()) as T
      // 429 / 5xx: back off and retry.
      if (res.status !== 429 && res.status < 500) return null
    } catch {
      // network hiccup: retry
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return null
}

/** Extract per-chain daily revenue (USD) from a fees breakdown. */
function revenueByChain(fees: FeesResp | null): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>()
  for (const [ts, perChain] of fees?.totalDataChartBreakdown ?? []) {
    for (const [chain, v] of Object.entries(perChain)) {
      let usd = 0
      if (typeof v === "number") usd = v
      else for (const x of Object.values(v)) if (typeof x === "number") usd += x
      if (!out.has(chain)) out.set(chain, new Map())
      out.get(chain)!.set(ts, usd)
    }
  }
  return out
}

function buildChainDaily(
  net: TvlPoint[] | undefined,
  borrowed: TvlPoint[] | undefined,
  revByDay: Map<number, number> | undefined,
  feesByDay: Map<number, number> | undefined,
): DayMetrics[] {
  const borrowMap = new Map((borrowed ?? []).map((p) => [p.date, p.totalLiquidityUSD]))
  return (net ?? []).map((p) => {
    const tvl = p.totalLiquidityUSD
    const borrows = borrowMap.get(p.date) ?? 0
    const deposits = tvl + borrows
    return {
      t: p.date,
      deposits,
      borrows,
      tvl,
      utilization: deposits > 0 ? (borrows / deposits) * 100 : null,
      revenue: revByDay?.get(p.date) ?? 0,
      fees: feesByDay?.get(p.date) ?? 0,
    }
  })
}

/** Token USD map nearest to `daysAgo` before the latest sample. */
function tokensAt(entry: ChainEntry | undefined, daysAgo: number): Record<string, number> {
  const rows = entry?.tokensInUsd ?? []
  if (rows.length === 0) return {}
  const targetTs = rows[rows.length - 1].date - daysAgo * 86_400
  let best = rows[rows.length - 1]
  let diff = Infinity
  for (const r of rows) { const dd = Math.abs(r.date - targetTs); if (dd < diff) { diff = dd; best = r } }
  return diff <= 5 * 86_400 ? best.tokens : {}
}

function addInto(dst: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) if (v > 0) dst[k] = (dst[k] ?? 0) + v
}

/** Constant-price net change in a chain's deposit base over `windowDays`:
 *  sum over tokens of (units_now - units_then) * price_now (price moves excluded). */
function netDepositFlow(net: ChainEntry | undefined, windowDays: number): number {
  const units = net?.tokens ?? []
  const usd = net?.tokensInUsd ?? []
  if (units.length < 2 || usd.length < 2) return 0
  const usdByDate = new Map(usd.map((r) => [r.date, r.tokens]))
  const nowRow = units[units.length - 1]
  const nowUsd = usdByDate.get(nowRow.date) ?? {}
  const targetTs = nowRow.date - windowDays * 86_400
  let then = units[0]
  let diff = Infinity
  for (const r of units) { const dd = Math.abs(r.date - targetTs); if (dd < diff) { diff = dd; then = r } }
  if (diff > 4 * 86_400) return 0
  let flow = 0
  for (const tk of new Set([...Object.keys(nowRow.tokens), ...Object.keys(then.tokens)])) {
    const u1 = nowRow.tokens[tk] ?? 0
    const u0 = then.tokens[tk] ?? 0
    const unitsNow = nowRow.tokens[tk] ?? 0
    const priceNow = unitsNow ? (nowUsd[tk] ?? 0) / unitsNow : 0
    flow += (u1 - u0) * priceNow
  }
  return flow
}

/** Constant-price net flow per token for a chain over `windowDays`. */
function perTokenFlow(net: ChainEntry | undefined, windowDays: number): Record<string, number> {
  const units = net?.tokens ?? []
  const usd = net?.tokensInUsd ?? []
  if (units.length < 2 || usd.length < 2) return {}
  const usdByDate = new Map(usd.map((r) => [r.date, r.tokens]))
  const nowRow = units[units.length - 1]
  const nowUsd = usdByDate.get(nowRow.date) ?? {}
  const targetTs = nowRow.date - windowDays * 86_400
  let then = units[0]
  let diff = Infinity
  for (const r of units) { const dd = Math.abs(r.date - targetTs); if (dd < diff) { diff = dd; then = r } }
  if (diff > 5 * 86_400) return {}
  const out: Record<string, number> = {}
  for (const tk of new Set([...Object.keys(nowRow.tokens), ...Object.keys(then.tokens)])) {
    const unitsNow = nowRow.tokens[tk] ?? 0
    const priceNow = unitsNow ? (nowUsd[tk] ?? 0) / unitsNow : 0
    const flow = ((nowRow.tokens[tk] ?? 0) - (then.tokens[tk] ?? 0)) * priceNow
    if (Math.abs(flow) > 1) out[tk] = flow
  }
  return out
}

/** Build a net-supply-flow Sankey (asset inflows -> chains -> asset outflows). */
function buildFlows(
  chainsMeta: Array<{ chain: string; label: string }>,
  rawNet: Map<string, ChainEntry | undefined>,
  windowDays: number,
  topN = 12,
): FlowData {
  // Collect per (chain, token) flow.
  const triples: Array<{ chain: string; token: string; flow: number }> = []
  const inByAsset: Record<string, number> = {}
  const outByAsset: Record<string, number> = {}
  const netByChain: Record<string, number> = {}
  for (const cm of chainsMeta) {
    const flows = perTokenFlow(rawNet.get(cm.chain), windowDays)
    for (const [token, flow] of Object.entries(flows)) {
      triples.push({ chain: cm.chain, token: token.toUpperCase(), flow })
      netByChain[cm.chain] = (netByChain[cm.chain] ?? 0) + flow
      if (flow > 0) inByAsset[token.toUpperCase()] = (inByAsset[token.toUpperCase()] ?? 0) + flow
      else outByAsset[token.toUpperCase()] = (outByAsset[token.toUpperCase()] ?? 0) + -flow
    }
  }
  const topKeys = (m: Record<string, number>) =>
    new Set(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k))
  const inTop = topKeys(inByAsset)
  const outTop = topKeys(outByAsset)
  const inName = (t: string) => (inTop.has(t) ? t : "Other")
  const outName = (t: string) => (outTop.has(t) ? t : "Other")

  // Node indices: inflow assets, chains, outflow assets.
  const inNodes = [...new Set([...[...inTop], ...(Object.keys(inByAsset).some((k) => !inTop.has(k)) ? ["Other"] : [])])]
  const outNodes = [...new Set([...[...outTop], ...(Object.keys(outByAsset).some((k) => !outTop.has(k)) ? ["Other"] : [])])]
  const chainNodes = chainsMeta.filter((c) => (netByChain[c.chain] ?? 0) !== 0)

  const nodes: SankeyNode[] = [
    ...inNodes.map((n) => ({ name: n, kind: "in" as const })),
    ...chainNodes.map((c) => ({ name: c.label, kind: "chain" as const })),
    ...outNodes.map((n) => ({ name: n, kind: "out" as const })),
  ]
  const inIdx = new Map(inNodes.map((n, i) => [n, i]))
  const chainBase = inNodes.length
  const chainIdx = new Map(chainNodes.map((c, i) => [c.chain, chainBase + i]))
  const outBase = chainBase + chainNodes.length
  const outIdx = new Map(outNodes.map((n, i) => [n, outBase + i]))

  // Accumulate links (merge duplicates).
  const linkMap = new Map<string, number>()
  for (const { chain, token, flow } of triples) {
    const ci = chainIdx.get(chain)
    if (ci == null) continue
    if (flow > 0) {
      const si = inIdx.get(inName(token))!
      linkMap.set(`${si}>${ci}`, (linkMap.get(`${si}>${ci}`) ?? 0) + flow)
    } else {
      const ti = outIdx.get(outName(token))!
      linkMap.set(`${ci}>${ti}`, (linkMap.get(`${ci}>${ti}`) ?? 0) + -flow)
    }
  }
  const links: SankeyLink[] = [...linkMap.entries()].map(([k, value]) => {
    const [s, t] = k.split(">").map(Number)
    return { source: s, target: t, value }
  })

  const totalIn = Object.values(inByAsset).reduce((s, v) => s + v, 0)
  const totalOut = Object.values(outByAsset).reduce((s, v) => s + v, 0)
  return { nodes, links, netByChain, totalIn, totalOut }
}

function valueAt(daily: DayMetrics[], key: Exclude<MetricKey, "utilization">, daysAgo: number): number | null {
  if (daily.length === 0) return null
  const targetTs = daily[daily.length - 1].t - daysAgo * 86_400
  let best: DayMetrics | null = null
  let diff = Infinity
  for (const d of daily) {
    const dd = Math.abs(d.t - targetTs)
    if (dd < diff) { diff = dd; best = d }
  }
  if (!best || diff > 3 * 86_400) return null
  return best[key]
}

function snapOf(daily: DayMetrics[], key: Exclude<MetricKey, "utilization">): MetricSnapshot {
  const current = daily.at(-1)?.[key] ?? 0
  const d = (n: number) => {
    const past = valueAt(daily, key, n)
    return past == null ? null : current - past
  }
  return {
    current,
    change24h: d(1),
    change30d: d(30),
    change365d: d(365),
    spark: daily.slice(-30).map((x) => ({ t: x.t, v: x[key] })),
  }
}

/** Ratio snapshot (utilization / LDR) — deltas are in percentage points. */
function ratioSnap(daily: DayMetrics[]): MetricSnapshot {
  const ratioAt = (d: DayMetrics) => (d.deposits > 0 ? (d.borrows / d.deposits) * 100 : 0)
  const current = daily.length ? ratioAt(daily[daily.length - 1]) : 0
  const at = (n: number): number | null => {
    if (daily.length === 0) return null
    const targetTs = daily[daily.length - 1].t - n * 86_400
    let best: DayMetrics | null = null
    let diff = Infinity
    for (const x of daily) { const dd = Math.abs(x.t - targetTs); if (dd < diff) { diff = dd; best = x } }
    return best && diff <= 3 * 86_400 ? ratioAt(best) : null
  }
  const d = (n: number) => { const p = at(n); return p == null ? null : current - p }
  return {
    current,
    change24h: d(1),
    change30d: d(30),
    change365d: d(365),
    spark: daily.slice(-30).map((x) => ({ t: x.t, v: ratioAt(x) })),
  }
}

async function build(): Promise<MultiChainData> {
  const [fluidLending, jupiter, fluidRev, jupRev, fluidFees, jupFees] = await Promise.all([
    fetchJson<ProtocolResp>(`${LLAMA}/protocol/fluid-lending`),
    fetchJson<ProtocolResp>(`${LLAMA}/protocol/jupiter-lend`),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/fluid?dataType=dailyRevenue`),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/jupiter-lend?dataType=dailyRevenue`),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/fluid?dataType=dailyFees`),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/jupiter-lend?dataType=dailyFees`),
  ])
  const fluidRevByChain = revenueByChain(fluidRev)
  const jupRevByChain = revenueByChain(jupRev)
  const fluidFeesByChain = revenueByChain(fluidFees)
  const jupFeesByChain = revenueByChain(jupFees)

  // Keep raw net + borrowed entries per chain for flow + mix computations.
  const rawNet = new Map<string, ChainEntry | undefined>()
  const rawBorrowed = new Map<string, ChainEntry | undefined>()
  const chains: ChainSeries[] = []
  for (const c of FLUID_CHAINS) {
    const ct = fluidLending?.chainTvls ?? {}
    const daily = buildChainDaily(ct[c.key]?.tvl, ct[`${c.key}-borrowed`]?.tvl, fluidRevByChain.get(c.key), fluidFeesByChain.get(c.key))
    if (daily.length) {
      chains.push({ chain: c.key, label: c.label, daily })
      rawNet.set(c.key, ct[c.key])
      rawBorrowed.set(c.key, ct[`${c.key}-borrowed`])
    }
  }
  // Solana via JupLend.
  const jct = jupiter?.chainTvls ?? {}
  const solDaily = buildChainDaily(jct["Solana"]?.tvl, jct["Solana-borrowed"]?.tvl, jupRevByChain.get("Solana"), jupFeesByChain.get("Solana"))
  if (solDaily.length) {
    chains.push({ chain: SOLANA.key, label: SOLANA.label, daily: solDaily })
    rawNet.set(SOLANA.key, jct["Solana"])
    rawBorrowed.set(SOLANA.key, jct["Solana-borrowed"])
  }

  // If the essential fetch failed, don't let ttlMemo cache an empty result -
  // throw so the loader's catch degrades gracefully and the next request retries.
  if (chains.length === 0) throw new Error("getMultiChain: no chain data (upstream fetch failed)")

  // Aggregate: union of all dates, sum per metric.
  const dates = new Set<number>()
  for (const c of chains) for (const d of c.daily) dates.add(d.t)
  const sortedDates = [...dates].sort((a, b) => a - b)
  // Per-chain lookup by date for fast aggregation (forward-filled so a chain
  // that hasn't reported on a given day keeps its last value).
  const lookups = chains.map((c) => {
    const m = new Map(c.daily.map((d) => [d.t, d]))
    return { c, m, sorted: c.daily }
  })
  const aggregateDaily: DayMetrics[] = sortedDates.map((t) => {
    let deposits = 0, borrows = 0, tvl = 0, revenue = 0, fees = 0
    for (const { sorted } of lookups) {
      // Levels (deposits/borrows/tvl) forward-fill; flows (revenue/fees) use the
      // exact-day value only (0 when a chain didn't report that day).
      let lo = 0, hi = sorted.length - 1, idx = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid].t <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1
      }
      if (idx < 0) continue
      const d = sorted[idx]
      deposits += d.deposits; borrows += d.borrows; tvl += d.tvl
      if (d.t === t) { revenue += d.revenue; fees += d.fees }
    }
    return { t, deposits, borrows, tvl, utilization: deposits > 0 ? (borrows / deposits) * 100 : null, revenue, fees }
  })

  const snap = {
    deposits: snapOf(aggregateDaily, "deposits"),
    borrows: snapOf(aggregateDaily, "borrows"),
    tvl: snapOf(aggregateDaily, "tvl"),
    revenue: snapOf(aggregateDaily, "revenue"),
    utilization: ratioSnap(aggregateDaily),
    ldr: ratioSnap(aggregateDaily),
  }

  const perChain: ChainSnapshot[] = chains
    .map((c) => {
      const last = c.daily.at(-1)!
      const fees7d = c.daily.slice(-7).reduce((s, d) => s + d.fees, 0)
      const revenue30d = c.daily.slice(-30).reduce((s, d) => s + d.revenue, 0)
      return {
        chain: c.chain,
        label: c.label,
        deposits: last.deposits,
        tvl: last.tvl,
        borrows: last.borrows,
        utilization: last.deposits > 0 ? (last.borrows / last.deposits) * 100 : 0,
        ldr: last.deposits > 0 ? (last.borrows / last.deposits) * 100 : 0,
        fees7d,
        revenue30d,
        netDeposits30d: netDepositFlow(rawNet.get(c.chain), 30),
      }
    })
    .sort((a, b) => b.deposits - a.deposits)

  // Per-chain collateral / borrow token mix at each period.
  const periods = Object.keys(PERIOD_DAYS) as Period[]
  const mix: ChainMix[] = chains.map((c) => {
    const net = rawNet.get(c.chain)
    const bor = rawBorrowed.get(c.chain)
    const byPeriod = {} as Record<Period, MixSnapshot>
    for (const p of periods) {
      const d = PERIOD_DAYS[p]
      const netUsd = tokensAt(net, d)
      const borrowedUsd = tokensAt(bor, d)
      // Gross supplied per token = net + borrowed; borrow side = borrowed.
      const supplied: Record<string, number> = {}
      addInto(supplied, netUsd)
      addInto(supplied, borrowedUsd)
      const borrowed: Record<string, number> = {}
      addInto(borrowed, borrowedUsd)
      byPeriod[p] = { supplied, borrowed }
    }
    return { chain: c.chain, label: c.label, periods: byPeriod }
  })

  const chainsMeta = chains.map((c) => ({ chain: c.chain, label: c.label }))
  const flows: Record<FlowWindow, FlowData> = {
    week: buildFlows(chainsMeta, rawNet, 7),
    month: buildFlows(chainsMeta, rawNet, 30),
    quarter: buildFlows(chainsMeta, rawNet, 90),
  }

  return { chains, aggregateDaily, snap, perChain, mix, flows, fetchedAt: Math.floor(Date.now() / 1000) }
}

export const getMultiChain = ttlMemo(build, TTL_5MIN)

// ─────────────────────────────────────────────────────────────────────────
// Weekly-aligned per-chain series for the switchable stacked-area chart.
// ─────────────────────────────────────────────────────────────────────────

export interface ChainMeta { key: string; label: string }
export interface AlignedRow {
  t: number
  [chainKey: string]: number | null
}
export interface ByChainAligned {
  chains: ChainMeta[]
  /** One aligned weekly series per metric. */
  series: Record<MetricKey, AlignedRow[]>
}

/** Nearest sample at or before `t` (forward fill); null if chain has no data yet. */
function sampleLE(daily: DayMetrics[], t: number, key: MetricKey): number | null {
  let lo = 0, hi = daily.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (daily[mid].t <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (idx < 0) return null
  const d = daily[idx]
  return key === "utilization" ? d.utilization : d[key]
}

export function buildByChain(mc: MultiChainData, windowDays = 365): ByChainAligned {
  const now = mc.aggregateDaily.at(-1)?.t ?? Math.floor(Date.now() / 1000)
  const start = now - windowDays * 86_400
  const grid: number[] = []
  for (let t = start; t <= now; t += 7 * 86_400) grid.push(t)

  const metrics: MetricKey[] = ["deposits", "borrows", "tvl", "utilization", "revenue"]
  const series = {} as Record<MetricKey, AlignedRow[]>
  for (const m of metrics) {
    series[m] = grid.map((t) => {
      const row: AlignedRow = { t }
      for (const c of mc.chains) {
        const v = sampleLE(c.daily, t, m)
        // Stacked metrics use 0 before a chain exists; utilization stays null.
        row[c.chain] = v == null ? (m === "utilization" ? null : 0) : v
      }
      return row
    })
  }
  return { chains: mc.chains.map((c) => ({ key: c.chain, label: c.label })), series }
}
