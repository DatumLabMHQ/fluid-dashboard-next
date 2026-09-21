/**
 * Shared viem PublicClients for the on-chain Fluid VaultResolver reads.
 *
 * `getVaultsEntireData()` returns a LARGE array-of-structs (every active vault
 * in one call). Two consequences shaped this module:
 *
 *  1. Multicall is disabled — the response doesn't fit cleanly inside
 *     Multicall3's wrapper on most public RPCs.
 *  2. Some public RPCs reject the oversized `eth_call` with a JSON-RPC
 *     "Internal error". viem wraps that as an execution *revert*, which its
 *     `fallback()` transport treats as deterministic and will NOT roll past.
 *     So instead of relying on `fallback`, callers iterate `getEthRpcUrls()`
 *     and retry on the next provider themselves (see `readResilient`).
 *
 * Set `ETHEREUM_RPC_URL` to a private endpoint to put a reliable provider
 * first and skip the public quirks entirely.
 */
import { createPublicClient, http, type PublicClient } from "viem"
import { mainnet } from "viem/chains"

// Ordered for handling large eth_call responses. drpc / publicnode / merkle
// tolerate big payloads better than cloudflare (which errors above a size cap).
const ETH_PUBLIC_RPCS = [
  "https://eth.drpc.org",
  "https://ethereum-rpc.publicnode.com",
  "https://eth.merkle.io",
  "https://eth.llamarpc.com",
  "https://rpc.ankr.com/eth",
  "https://1rpc.io/eth",
]

export function getEthRpcUrls(): string[] {
  const custom = process.env.ETHEREUM_RPC_URL?.trim() || process.env.ETH_RPC_URL?.trim()
  return custom ? [custom, ...ETH_PUBLIC_RPCS] : ETH_PUBLIC_RPCS
}

const clientCache = new Map<string, PublicClient>()

/** A single-transport client for one RPC URL (cached). */
export function clientForUrl(url: string): PublicClient {
  const hit = clientCache.get(url)
  if (hit) return hit
  const client = createPublicClient({
    chain: mainnet,
    transport: http(url, { timeout: 30_000, retryCount: 1, retryDelay: 250 }),
  }) as PublicClient
  clientCache.set(url, client)
  return client
}

/**
 * Run `fn` against each Ethereum RPC in turn, returning the first success.
 * Used for oversized reads where viem's `fallback` won't roll over because it
 * misclassifies the RPC's "Internal error" as a deterministic revert.
 */
export async function readResilient<T>(
  fn: (client: PublicClient) => Promise<T>,
): Promise<T> {
  const urls = getEthRpcUrls()
  let lastErr: unknown
  for (const url of urls) {
    try {
      return await fn(clientForUrl(url))
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error("All Ethereum RPCs failed")
}
