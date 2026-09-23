/**
 * Signals feed — the machine-readable surface the datumlabs-alerts Worker
 * reads to detect publishable findings.
 *
 * Why this exists: the Worker can't import this repo's data layer, and we do
 * NOT want it re-deriving Fluid's numbers from DefiLlama independently. The
 * DEX volume figures here reconcile exactly to Fluid's own quarterly reports,
 * and that calibration is the whole reason the dashboard is credible. One
 * source of truth: the Worker reads what the dashboard renders.
 *
 * Every Datum Labs lending dashboard exposes this same shape at /api/signals
 * so the Worker has a single parser across Spark, Euler and Fluid.
 */

import { getMultiChain } from "./fluid/fluid-multichain"
import { getFluidDex } from "./fluid/fluid-dex"
import { buildAllRateComparisons } from "./fluid/comparison"

/** Public page a tweet should link to, not the raw deployment host. */
const PUBLIC_BASE = "https://www.datumlab.xyz/fluid-terminal"

/** Error messages without `any`: narrow the caught value before reading .message. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "failed"
}

/** The bits of MetricSnapshot this feed reads. Structural, so the data layer stays free to grow. */
interface SnapLike {
  current: number
  change24h?: number | null
  change30d?: number | null
}

/** The bits of MultiChainData the chain decomposition reads. */
interface MultiChainLike {
  chains: Array<{ chain: string; label?: string; daily: Array<{ deposits: number }> }>
}

export type SignalUnit = "usd" | "pct" | "ratio" | "count"

export interface SignalMetric {
  /** Stable id. Never rename: the Worker keys its D1 history on this. */
  key: string
  label: string
  value: number
  unit: SignalUnit
  /**
   * True when the series is monotonically non-decreasing (a running total).
   * Milestone-ETA forecasting only runs on cumulative metrics — extrapolating
   * a round-number crossing for a metric that can fall is meaningless.
   */
  cumulative?: boolean
  change24h?: number | null
  change30d?: number | null
  href?: string
  /** Window the decomposition below covers, in days. */
  windowDays?: number
  /** Value at the start of that window, so the Worker need not store history. */
  prior?: number
  /**
   * What moved the aggregate. Derived here rather than in the Worker because the history
   * lives here: this dashboard has years of daily series while the Worker's store starts
   * empty, so a composition alert can fire on its first run.
   */
  components?: SignalComponent[]
}

export interface SignalComponent {
  name: string
  value: number
  prior: number
  change: number
  changePct: number | null
  /** This component's share of the aggregate's total change, in percent. */
  contributionPct: number | null
  /** Constant-price change: growth from real deposits rather than from the assets repricing. */
  realChange?: number
  /** The remainder, attributable to repricing. */
  priceEffect?: number
}

export interface SignalsPayload {
  protocol: "fluid"
  fetchedAt: number
  dashboardUrl: string
  metrics: SignalMetric[]
  /** Populated when one or more sub-builders failed, so the Worker can tell
   *  "metric is absent" apart from "metric is genuinely zero". */
  degraded?: string[]
}

/**
 * Today's UTC day is still accumulating, so any FLOW series (revenue, fees,
 * volume) has a final point that is a partial day. Levels (TVL, deposits) are
 * forward-filled upstream and are fine as-is.
 *
 * This matters more than it looks: `snap.revenue` is the latest DAILY value,
 * so reading it directly returns 0 for most of every UTC day. A rule built on
 * that would fire "revenue collapsed" every morning. Flows here are therefore
 * always derived from completed days only.
 */
function completedDays<T extends { t: number }>(pts: T[] | undefined): T[] {
  const arr = pts ?? []
  if (!arr.length) return []
  const startOfTodayUtc = Math.floor(Date.now() / 86_400_000) * 86_400
  const last = arr[arr.length - 1]
  // Series timestamps are unix seconds; drop the tail if it lands on today.
  return last.t >= startOfTodayUtc ? arr.slice(0, -1) : arr
}

const sumV = (pts: Array<{ t: number; v: number }> | undefined) =>
  completedDays(pts).reduce((a, p) => a + (Number.isFinite(p.v) ? p.v : 0), 0)

const sumField = <K extends string>(pts: Array<{ t: number } & Record<K, number>> | undefined, k: K) =>
  completedDays(pts).reduce((a, p) => a + (Number.isFinite(p[k]) ? p[k] : 0), 0)


/**
 * Split the deposit base's move over `windowDays` into per-chain contributions.
 *
 * NO PRICE SPLIT HERE, deliberately. `perChain.netDeposits30d` is a constant-price flow
 * computed by perTokenFlow() over the NET series, while the change measured here differences
 * gross `deposits`. Subtracting one basis from the other is not a price effect: on Euler it
 * implied a 60% price collapse in 30 days, which did not happen. Spark's feed does carry the
 * split because it derives both sides from one series (tokensInUsd and tokens), and that
 * version reproduces Spark's own published figure. Restore it here only by computing both
 * sides from the same series.
 */
function decomposeByChain(mc: MultiChainLike, windowDays: number): { value: number; prior: number; components: SignalComponent[] } | null {
  const chains = Array.isArray(mc?.chains) ? mc.chains : []
  if (!chains.length) return null

  const rows: SignalComponent[] = []
  let value = 0
  let prior = 0

  for (const c of chains) {
    const daily = Array.isArray(c.daily) ? c.daily : []
    if (daily.length < windowDays + 1) continue
    const now = daily[daily.length - 1]
    const then = daily[daily.length - 1 - windowDays]
    if (!now || !then) continue

    const nowV = Number(now.deposits) || 0
    const thenV = Number(then.deposits) || 0
    if (nowV === 0 && thenV === 0) continue
    value += nowV
    prior += thenV

    const change = nowV - thenV

    rows.push({
      name: c.label ?? c.chain,
      value: nowV,
      prior: thenV,
      change,
      changePct: thenV > 0 ? (change / thenV) * 100 : null,
      contributionPct: null,
    })
  }

  if (!rows.length) return null
  const totalChange = value - prior
  for (const r of rows) r.contributionPct = totalChange !== 0 ? (r.change / totalChange) * 100 : null
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
  return { value, prior, components: rows }
}

export async function buildSignals(): Promise<SignalsPayload> {
  const degraded: string[] = []
  const metrics: SignalMetric[] = []

  // ── Lending book ──────────────────────────────────────────────────────────
  try {
    const mc = await getMultiChain()
    const s = mc.snap
    const push = (key: string, label: string, m: SnapLike | undefined, unit: SignalUnit = "usd", href?: string) => {
      if (!m || !Number.isFinite(m.current)) return
      metrics.push({
        key,
        label,
        value: m.current,
        unit,
        change24h: m.change24h ?? null,
        change30d: m.change30d ?? null,
        href,
      })
    }
    push("fluid.lending.tvl", "Fluid TVL", s.tvl, "usd", `${PUBLIC_BASE}`)
    push("fluid.lending.deposits", "Fluid deposits", s.deposits, "usd", `${PUBLIC_BASE}/lending`)
    push("fluid.lending.borrows", "Fluid borrows", s.borrows, "usd", `${PUBLIC_BASE}/lending`)
    push("fluid.lending.ldr", "Fluid loan-to-deposit ratio", s.ldr, "ratio", `${PUBLIC_BASE}/lending`)

    // Deposit base decomposed by chain, over two windows.
    for (const windowDays of [30, 90]) {
      const d = decomposeByChain(mc, windowDays)
      if (!d) continue
      metrics.push({
        key: "fluid.lending.deposits_by_chain_" + windowDays + "d",
        label: "Fluid deposits by chain",
        value: d.value,
        unit: "usd",
        windowDays,
        prior: d.prior,
        components: d.components,
        href: PUBLIC_BASE,
      })
    }

    // Revenue as a trailing 30d flow and an all-time running total. NOT
    // snap.revenue, which is a single partial day (see completedDays above).
    const rev30d = sumField(mc.aggregateDaily.slice(-31), "revenue")
    if (rev30d > 0) {
      metrics.push({
        key: "fluid.lending.revenue_30d",
        label: "Fluid revenue, trailing 30d",
        value: rev30d,
        unit: "usd",
        href: PUBLIC_BASE,
      })
    }
    const revCum = sumField(mc.aggregateDaily, "revenue")
    if (revCum > 0) {
      metrics.push({
        key: "fluid.lending.revenue_cumulative",
        label: "Fluid cumulative revenue",
        value: revCum,
        unit: "usd",
        cumulative: true,
        href: PUBLIC_BASE,
      })
    }
  } catch (e: unknown) {
    degraded.push(`multichain: ${errMessage(e)}`)
  }

  // ── DEX ───────────────────────────────────────────────────────────────────
  // The cumulative series are the milestone candidates: they are the direct
  // analogue of the "$4B PYUSD/USDS" style announcement a protocol makes about
  // itself, which means we can forecast the crossing before it happens.
  try {
    const dex = await getFluidDex()

    const cumVolume = sumV(dex.volumeDaily)
    if (cumVolume > 0) {
      metrics.push({
        key: "fluid.dex.volume_cumulative",
        label: "Fluid DEX cumulative volume",
        value: cumVolume,
        unit: "usd",
        cumulative: true,
        href: `${PUBLIC_BASE}/dex`,
      })
    }

    const cumFees = sumV(dex.feesDaily)
    if (cumFees > 0) {
      metrics.push({
        key: "fluid.dex.fees_cumulative",
        label: "Fluid DEX cumulative fees",
        value: cumFees,
        unit: "usd",
        cumulative: true,
        href: `${PUBLIC_BASE}/dex`,
      })
    }

    if (dex.volume24hSnap && Number.isFinite(dex.volume24hSnap.current)) {
      metrics.push({
        key: "fluid.dex.volume_24h",
        label: "Fluid DEX 24h volume",
        value: dex.volume24hSnap.current,
        unit: "usd",
        change24h: dex.volume24hSnap.change24h ?? null,
        change30d: dex.volume24hSnap.change30d ?? null,
        href: `${PUBLIC_BASE}/dex`,
      })
    }
    if (dex.tvlSnap && Number.isFinite(dex.tvlSnap.current)) {
      metrics.push({
        key: "fluid.dex.tvl",
        label: "Fluid DEX TVL",
        value: dex.tvlSnap.current,
        unit: "usd",
        change24h: dex.tvlSnap.change24h ?? null,
        change30d: dex.tvlSnap.change30d ?? null,
        href: `${PUBLIC_BASE}/dex`,
      })
    }
    if (Number.isFinite(dex.avgTurnover)) {
      metrics.push({
        key: "fluid.dex.turnover",
        label: "Fluid DEX capital turnover",
        value: dex.avgTurnover,
        unit: "ratio",
        href: `${PUBLIC_BASE}/dex`,
      })
    }
  } catch (e: unknown) {
    degraded.push(`dex: ${errMessage(e)}`)
  }

  // ── The cross-venue rate layer ────────────────────────────────────────────
  // Emitted from this feed, under the NEUTRAL `market.*` namespace, because the
  // normalisation engine lives here (lib/fluid/comparison.ts) and duplicating it in the
  // Spark and Euler repos would give three feeds three slightly different answers for the
  // same rate. One engine, one answer, and the Worker joins across assets.
  //
  // The normalisation is the hard part and is already settled: Ethereum only so the venues
  // are comparable, ETH collapsed into WETH, supply APY from the venue's deepest pool for
  // the asset, borrow APY size-weighted by borrowed USD so Morpho's many isolated markets
  // do not each count as a venue.
  //
  // This is the one part of the desk that can say something on an ordinary day. A book
  // moves a percent and there is nothing to write; the cheapest place to borrow USDC
  // changes hands and there is.
  try {
    const [borrow, supply] = await Promise.all([
      buildAllRateComparisons("borrow"),
      buildAllRateComparisons("supply"),
    ])
    for (const c of [...borrow, ...supply]) {
      // One venue is not a comparison. Skip rather than emit a spread of zero, which a
      // rule would read as "every venue agrees" when the truth is "nobody else lists it".
      if (c.points.length < 2) continue
      // Venues within a basis point of each other are not a comparison. In practice this
      // is the collateral-only assets, where nobody borrows so every supply APY rounds to
      // zero (cbBTC reads a 0.001pp spread, weETH 0.00002pp), and emitting a row of zeroes
      // is noise the ranking layer then has to wade through. Not tested against exactly
      // zero, because these are floats and never quite are. If they ever diverge the
      // comparison starts being emitted then.
      const spreadValues = c.points.map((point) => point.value)
      if (Math.max(...spreadValues) - Math.min(...spreadValues) < 0.01) continue
      const asset = c.asset.toLowerCase()
      const side = c.metric === "borrow" ? "borrow_apy" : "supply_apy"

      for (const point of c.points) {
        metrics.push({
          key: `market.${side}.${asset}.${point.project.replace(/-/g, "_")}`,
          label: `${point.label} ${c.assetLabel} ${c.metric} APY`,
          value: point.value,
          unit: "pct",
          href: `${PUBLIC_BASE}/lending`,
        })
      }

      // The spread between the best and worst venue. Widening means the venues disagree
      // about the price of the same risk, which is the part worth writing about.
      const values = c.points.map((point) => point.value)
      const spread = Math.max(...values) - Math.min(...values)
      metrics.push({
        key: `market.${side}_spread.${asset}`,
        label: `${c.assetLabel} ${c.metric} APY spread across venues`,
        value: spread,
        unit: "pct",
        href: `${PUBLIC_BASE}/lending`,
      })
    }
  } catch (e: unknown) {
    degraded.push(`rate comparison: ${errMessage(e)}`)
  }

  return {
    protocol: "fluid",
    fetchedAt: Math.floor(Date.now() / 1000),
    dashboardUrl: PUBLIC_BASE,
    metrics,
    ...(degraded.length ? { degraded } : {}),
  }
}
