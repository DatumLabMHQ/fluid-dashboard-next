/**
 * Peer registry + canonical asset definitions for the cross-protocol layer.
 *
 * Verified against live DefiLlama (/pools): the lending project slugs are
 * `fluid-lending, aave-v3, morpho-blue, sparklend, euler-v2, compound-v3`.
 * `spark` does not exist (it is `sparklend`). Fluid is always flagged + later
 * highlighted in the accent colour; peers render muted grey.
 */

export interface Peer {
  /** DefiLlama project slug as it appears in /pools. */
  project: string
  /** Display label. */
  label: string
  isFluid?: boolean
}

/** Lending protocols compared on rates + supply share (yields /pools layer). */
export const LENDING_PEERS: Peer[] = [
  { project: "fluid-lending", label: "Fluid", isFluid: true },
  { project: "aave-v3", label: "Aave V3" },
  { project: "morpho-blue", label: "Morpho" },
  { project: "sparklend", label: "Spark" },
  { project: "euler-v2", label: "Euler V2" },
  { project: "compound-v3", label: "Compound V3" },
]

export const LENDING_PROJECTS = new Set(LENDING_PEERS.map((p) => p.project))

export function peerLabel(project: string): string {
  return LENDING_PEERS.find((p) => p.project === project)?.label ?? project
}

export function isFluidProject(project: string): boolean {
  return project === "fluid-lending" || project === "fluid" || project === "fluid-lite"
}

/**
 * Protocol-level TVL-history slugs (the /protocol/{slug} endpoint) for the
 * indexed-line + lending-share-over-time charts. Fluid uses its lending child
 * so the comparison is lending-vs-lending.
 */
export const TVL_HISTORY_PEERS: Peer[] = [
  { project: "fluid-lending", label: "Fluid", isFluid: true },
  { project: "aave-v3", label: "Aave V3" },
  { project: "morpho-blue", label: "Morpho" },
  { project: "sparklend", label: "Spark" },
  { project: "euler-v2", label: "Euler V2" },
  { project: "compound-v3", label: "Compound V3" },
]

/**
 * Canonical assets for per-asset comparisons. `aliases` collapses symbol
 * variants (notably ETH == WETH across protocols) to one canonical key.
 */
export interface CanonicalAsset {
  key: string
  label: string
  aliases: string[]
  /** Group for filtering (stables get their own chart per the plan). */
  kind: "eth" | "btc" | "stable"
}

export const ASSETS: CanonicalAsset[] = [
  { key: "ETH", label: "ETH", aliases: ["ETH", "WETH"], kind: "eth" },
  { key: "WSTETH", label: "wstETH", aliases: ["WSTETH"], kind: "eth" },
  { key: "WEETH", label: "weETH", aliases: ["WEETH"], kind: "eth" },
  { key: "WBTC", label: "WBTC", aliases: ["WBTC"], kind: "btc" },
  { key: "CBBTC", label: "cbBTC", aliases: ["CBBTC"], kind: "btc" },
  { key: "USDC", label: "USDC", aliases: ["USDC"], kind: "stable" },
  { key: "USDT", label: "USDT", aliases: ["USDT", "USDT0"], kind: "stable" },
  { key: "USDE", label: "USDe", aliases: ["USDE"], kind: "stable" },
  { key: "GHO", label: "GHO", aliases: ["GHO"], kind: "stable" },
]

const ALIAS_TO_KEY: Record<string, string> = {}
for (const a of ASSETS) for (const al of a.aliases) ALIAS_TO_KEY[al.toUpperCase()] = a.key

/** Map a raw pool symbol to a canonical asset key, or null if not tracked. */
export function canonicalAsset(symbol: string): string | null {
  return ALIAS_TO_KEY[(symbol || "").toUpperCase()] ?? null
}

export function assetLabel(key: string): string {
  return ASSETS.find((a) => a.key === key)?.label ?? key
}
