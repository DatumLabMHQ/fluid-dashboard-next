/**
 * Chain display registry. The set of chains Fluid runs on is read DYNAMICALLY
 * from DefiLlama (spec: "don't hardcode the chain list") — this map only
 * supplies display order and a stable accent colour per known chain. Any chain
 * DefiLlama returns that is not listed here still renders, with a default
 * colour and order, so a new Fluid deployment shows up automatically.
 */

interface ChainMeta {
  label: string
  color: string
  /** Sort order in the by-chain table (lower = first). */
  order: number
}

const CHAIN_META: Record<string, ChainMeta> = {
  Ethereum: { label: "Ethereum", color: "var(--chart-1)", order: 1 },
  Base: { label: "Base", color: "var(--chart-2)", order: 2 },
  Arbitrum: { label: "Arbitrum", color: "var(--chart-3)", order: 3 },
  Polygon: { label: "Polygon", color: "var(--chart-4)", order: 4 },
  Plasma: { label: "Plasma", color: "var(--chart-5)", order: 5 },
  Solana: { label: "Solana (JupLend)", color: "var(--chart-6)", order: 6 },
}

export function chainLabel(key: string): string {
  return CHAIN_META[key]?.label ?? key
}

export function chainColor(key: string, fallbackIndex = 0): string {
  const palette = [
    "var(--chart-6)",
    "var(--chart-7)",
    "var(--chart-8)",
    "var(--accent-secondary)",
  ]
  return CHAIN_META[key]?.color ?? palette[fallbackIndex % palette.length]
}

export function chainOrder(key: string): number {
  return CHAIN_META[key]?.order ?? 100
}
