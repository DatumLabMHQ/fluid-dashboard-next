/**
 * Per-asset history for Fluid lending, the Blockworks way: deposits-by-asset and
 * loans-by-asset as full time series, ready for stacked-area charts.
 *
 * DefiLlama /protocol/fluid-lending carries per-token USD history for BOTH the
 * supply side (chain keys) and the borrow side (`<chain>-borrowed` keys), 300-888
 * daily points each. Note the supply side is NET (supplied - borrowed), so gross
 * deposits by asset = net + borrowed per token. We aggregate across chains per
 * day, collapse token aliases, and keep the top assets + Other.
 *
 * EVM chains only - the fluid-lending feed does not carry Solana / JupLend, so
 * JLP / jupSOL do not appear here.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson as fetchResilient } from "./fetch-json"

const PROTOCOL = "https://api.llama.fi/protocol/fluid-lending"

interface TokenPoint {
  date: number
  tokens: Record<string, number>
}
interface ChainEntry {
  tokensInUsd?: TokenPoint[]
}
interface ProtocolResp {
  chainTvls?: Record<string, ChainEntry>
}

export interface AssetSeries {
  key: string
  label: string
  color: string
}
export interface AreaRow {
  t: number
  [key: string]: number
}
export interface AssetHistory {
  series: AssetSeries[]
  rows: AreaRow[]
}
export interface FluidAssetHistory {
  asOf: number
  deposits: AssetHistory
  borrows: AssetHistory
}

/** Distinct categorical palette for asset stacks (Other is muted grey). */
const PALETTE = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)",
  "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--accent-secondary)",
]
const OTHER_COLOR = "var(--text-muted)"
const TOP_N = 8

/** Collapse token symbol variants to one clean, chartable key. */
const ALIAS: Record<string, string> = { WETH: "ETH", USDT0: "USDT", WSTETHV2: "WSTETH" }
function normToken(raw: string): string {
  const s = (raw || "").toUpperCase().replace(/₮/g, "T").replace(/[^A-Z0-9]/g, "")
  return ALIAS[s] ?? s
}

/** Nice display label for the common tokens; else the raw uppercase symbol. */
const LABEL: Record<string, string> = {
  WSTETH: "wstETH", WEETH: "weETH", CBBTC: "cbBTC", SUSDAI: "sUSDai", USDAI: "USDai",
}
function tokenLabel(key: string): string {
  return LABEL[key] ?? key
}

function isBorrowKey(k: string): boolean {
  return /-borrowed$/.test(k)
}

type DateMap = Map<number, Record<string, number>>

/** Accumulate per-day, per-token USD across the matching chain keys. */
function accumulate(chainTvls: Record<string, ChainEntry>, borrowSide: boolean): DateMap {
  const keys = Object.keys(chainTvls).filter((k) => {
    if (k === "borrowed") return false // chainless aggregate - would double-count
    return borrowSide ? isBorrowKey(k) : !isBorrowKey(k)
  })
  const byDate: DateMap = new Map()
  for (const k of keys) {
    for (const pt of chainTvls[k].tokensInUsd ?? []) {
      const day = Math.floor(pt.date / 86_400) * 86_400
      let row = byDate.get(day)
      if (!row) {
        row = {}
        byDate.set(day, row)
      }
      for (const [tok, usd] of Object.entries(pt.tokens ?? {})) {
        if (!Number.isFinite(usd) || usd <= 0) continue
        const a = normToken(tok)
        row[a] = (row[a] ?? 0) + usd
      }
    }
  }
  return byDate
}

/** Add two date maps per day/token (used to turn net supply into gross). */
function addDateMaps(a: DateMap, b: DateMap): DateMap {
  const out: DateMap = new Map()
  for (const [day, row] of a) out.set(day, { ...row })
  for (const [day, row] of b) {
    let dst = out.get(day)
    if (!dst) {
      dst = {}
      out.set(day, dst)
    }
    for (const [tok, usd] of Object.entries(row)) dst[tok] = (dst[tok] ?? 0) + usd
  }
  return out
}

/** Turn a per-day/token map into stacked-area series (top N + Other). */
function toHistory(byDate: DateMap): AssetHistory {
  const dates = [...byDate.keys()].sort((a, b) => a - b)
  if (dates.length === 0) return { series: [], rows: [] }

  const latest = byDate.get(dates[dates.length - 1]) ?? {}
  const ranked = Object.entries(latest)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, TOP_N).map(([a]) => a)
  const topSet = new Set(top)
  const hasOther = ranked.length > TOP_N

  const series: AssetSeries[] = top.map((a, i) => ({ key: a, label: tokenLabel(a), color: PALETTE[i % PALETTE.length] }))
  if (hasOther) series.push({ key: "Other", label: "Other", color: OTHER_COLOR })

  const rows: AreaRow[] = dates.map((d) => {
    const src = byDate.get(d) ?? {}
    const row: AreaRow = { t: d }
    for (const a of top) row[a] = src[a] ?? 0
    if (hasOther) {
      let other = 0
      for (const [a, v] of Object.entries(src)) if (!topSet.has(a)) other += v
      row.Other = other
    }
    return row
  })

  return { series, rows }
}

async function build(): Promise<FluidAssetHistory> {
  const data = await fetchResilient<ProtocolResp>(PROTOCOL)
  if (data === null) throw new Error(`DefiLlama fetch failed for ${PROTOCOL}`)
  const chainTvls = data.chainTvls ?? {}
  const supplyNet = accumulate(chainTvls, false)
  const borrowGross = accumulate(chainTvls, true)
  // Supply side is NET; gross deposits per token = net + borrowed.
  const depositsGross = addDateMaps(supplyNet, borrowGross)
  return {
    asOf: Math.floor(Date.now() / 1000),
    deposits: toHistory(depositsGross),
    borrows: toHistory(borrowGross),
  }
}

export const getFluidAssetHistory = ttlMemo(build, TTL_5MIN)
