/**
 * Static reference facts for the Fluid terminal — protocol metadata, external
 * links, DefiLlama slugs, on-chain resolver addresses, and label maps. Keeping
 * these in one place makes the data libs config-driven (spec: "adding a chain
 * is a config change, not code").
 */

export const SITE = {
  url: "https://fluid-dashboard.vercel.app",
  handle: "@datumlabss",
  credit: "Datum Labs",
} as const

export const PROTOCOL = {
  name: "Fluid",
  by: "Instadapp",
  app: "https://fluid.io",
  docs: "https://docs.fluid.io",
  defillama: "https://defillama.com/protocol/fluid",
} as const

/**
 * DefiLlama slugs. The umbrella `fluid` protocol rolls up the child products
 * below; fees/revenue and DEX volume are queried against the umbrella slug,
 * which DefiLlama aggregates across all children and chains.
 */
export const LLAMA_SLUGS = {
  protocol: "fluid",
  /** Yields-API `project` names that belong to Fluid (lending fTokens + vaults). */
  yieldProjects: ["fluid-lending", "fluid", "fluid-lite"],
} as const

/**
 * Fluid VaultResolver — `getVaultsEntireData()` returns every active vault on
 * the chain in one batched call. Ethereum is wired for Phase 1; add more chains
 * here to extend on-chain coverage (the rest comes from DefiLlama already).
 */
export const RESOLVERS: Record<string, { vaultResolver: `0x${string}` }> = {
  ethereum: {
    vaultResolver: "0xA5C3E16523eeeDDcC34706b0E6bE88b4c6EA95cC",
  },
}

/** Fluid vault types -> human label for the vaults table. */
export function vaultTypeLabel(vaultType: number): string {
  // Fluid encodes the vault flavour in `vaultType`. The exact numeric mapping
  // has shifted across deployments, so we lean on the resolver's smart-col /
  // smart-debt booleans for the badges and use this only as a coarse hint.
  switch (vaultType) {
    case 10000:
      return "T1"
    case 20000:
      return "T2 (smart col)"
    case 30000:
      return "T3 (smart debt)"
    case 40000:
      return "T4 (smart col + debt)"
    default:
      return `T${vaultType}`
  }
}
