/**
 * Asset-issuer partner franchise: for each issuer the Q4 report names (USD.AI,
 * Aave/GHO, Ethena, Maple, Resolv), how much of their token is deposited on
 * Fluid and Fluid's share of that token's DEX volume. This is the "Fluid is the
 * liquidity home for issuers" story, quantified per partner - honestly, so the
 * dominant franchises (sUSDai, GHO) and the emerging ones both show through.
 *
 * Deposits: gross from /protocol/fluid-lending (net supply + borrowed per token,
 * EVM chains). DEX: /pools spot-venue volume for pairs containing an issuer
 * token. Fluid DEX TVL = liquidity Fluid deploys for the issuer (LaaS).
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson as fetchResilient } from "./fetch-json"
import { getRawPools } from "./llama-pools"

const PROTOCOL = "https://api.llama.fi/protocol/fluid-lending"

const SPOT_DEX_RE = /(dex|curve|uniswap|balancer|pancake|sushi|aerodrome|velodrome|maverick|ramses|camelot|orca)/i
/** Only count DEX-share for markets with real depth; below this it is noise. */
const MIN_DEX_MARKET = 1_000_000

interface Issuer {
  name: string
  /** short token label shown on charts. */
  token: string
  /** matches a cleaned (alnum-upper) token symbol. */
  re: RegExp
}
const ISSUERS: Issuer[] = [
  { name: "USD.AI", token: "sUSDai", re: /^(SUSDAI|USDAI)$/ },
  { name: "Aave", token: "GHO", re: /^GHO$/ },
  { name: "Ethena", token: "USDe", re: /^(USDE|SUSDE)$/ },
  { name: "Maple", token: "syrupUSD", re: /^(SYRUPUSDC|SYRUPUSDT|SYRUPUSD|SYRUPUSDTB)$/ },
  { name: "Resolv", token: "USR", re: /^(USR|WSTUSR|RLP)$/ },
]

const clean = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
const pairToks = (s: string) => (s || "").toUpperCase().split(/[-/]/).map(clean).filter(Boolean)

export interface Ranked {
  label: string
  value: number
  isFluid: boolean
}
export interface IssuerRow {
  name: string
  token: string
  depositsUsd: number
  fluidDexVol7d: number
  dexMarket7d: number
  dexSharePct: number | null
  fluidDexTvl: number
}
export interface IssuerFranchise {
  asOf: number
  rows: IssuerRow[]
  /** Deposits per issuer (ranked bar). */
  deposits: Ranked[]
  /** Fluid DEX-volume share per issuer, markets over $1M only (ranked bar). */
  dexShare: Ranked[]
  totalDepositsUsd: number
}

interface TokenPoint { date: number; tokens: Record<string, number> }
interface ChainEntry { tokensInUsd?: TokenPoint[] }
interface RawPool { project: string; chain: string; symbol: string; volumeUsd7d?: number | null; tvlUsd?: number | null }

/** Drop wash-trading pools (weekly volume > 30x TVL) from DEX-share math. */
const WASH_TURNOVER_CAP = 30
function passesWashFilter(p: RawPool): boolean {
  const v = p.volumeUsd7d ?? 0
  const t = p.tvlUsd ?? 0
  if (v <= 0) return false
  if (t > 0 && v / t > WASH_TURNOVER_CAP) return false
  return true
}

const fetchJson = fetchResilient

async function build(): Promise<IssuerFranchise> {
  const [proto, poolsRaw] = await Promise.all([
    fetchJson<{ chainTvls?: Record<string, ChainEntry> }>(PROTOCOL),
    getRawPools(),
  ])
  const ct = proto?.chainTvls ?? {}
  const pools = poolsRaw as unknown as RawPool[]

  // Gross deposits per token = latest net (chain keys) + latest borrowed
  // (`-borrowed` keys), skipping the chainless `borrowed` aggregate.
  const gross = new Map<string, number>()
  for (const k of Object.keys(ct)) {
    if (k === "borrowed") continue
    const pts = ct[k].tokensInUsd ?? []
    const last = pts[pts.length - 1]
    if (!last) continue
    for (const [tok, v] of Object.entries(last.tokens ?? {})) {
      if (typeof v === "number" && v > 0) gross.set(clean(tok), (gross.get(clean(tok)) ?? 0) + v)
    }
  }

  const rows: IssuerRow[] = ISSUERS.map((iss) => {
    let depositsUsd = 0
    for (const [tok, v] of gross) if (iss.re.test(tok)) depositsUsd += v
    let fluidVol = 0
    let mktVol = 0
    let fluidTvl = 0
    for (const p of pools) {
      if (!SPOT_DEX_RE.test(p.project)) continue
      if (!pairToks(p.symbol).some((t) => iss.re.test(t))) continue
      if (p.project === "fluid-dex") fluidTvl += p.tvlUsd ?? 0
      if (!passesWashFilter(p)) continue
      const v = p.volumeUsd7d ?? 0
      mktVol += v
      if (p.project === "fluid-dex") fluidVol += v
    }
    return {
      name: iss.name,
      token: iss.token,
      depositsUsd,
      fluidDexVol7d: fluidVol,
      dexMarket7d: mktVol,
      dexSharePct: mktVol > 0 ? (fluidVol / mktVol) * 100 : null,
      fluidDexTvl: fluidTvl,
    }
  })

  const deposits: Ranked[] = rows
    .map((r) => ({ label: r.token, value: r.depositsUsd, isFluid: true }))
    .sort((a, b) => b.value - a.value)

  const dexShare: Ranked[] = rows
    .filter((r) => r.dexMarket7d >= MIN_DEX_MARKET && r.dexSharePct != null)
    .map((r) => ({ label: r.token, value: r.dexSharePct as number, isFluid: (r.dexSharePct ?? 0) >= 50 }))
    .sort((a, b) => b.value - a.value)

  return {
    asOf: Math.floor(Date.now() / 1000),
    rows,
    deposits,
    dexShare,
    totalDepositsUsd: rows.reduce((s, r) => s + r.depositsUsd, 0),
  }
}

export const getIssuerFranchise = ttlMemo(build, TTL_5MIN)
