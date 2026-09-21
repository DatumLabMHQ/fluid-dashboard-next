/**
 * Formatting helpers shared across the Fluid terminal. Mirrors the Datum
 * dashboard-kit conventions (compact USD, tabular percents, fail-soft "—").
 */

/** Compact USD: $3.21B / $612.4M / $5.30K / $115.42 */
export function formatUSD(value: number, opts?: { maxDecimals?: number }): string {
  if (!Number.isFinite(value)) return "-"
  const sign = value < 0 ? "-" : ""
  const v = Math.abs(value)
  if (v >= 1_000_000_000) return `${sign}$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(2)}K`
  const dp = opts?.maxDecimals ?? 2
  return `${sign}$${v.toFixed(dp)}`
}

export function formatUSDFull(value: number): string {
  if (!Number.isFinite(value)) return "-"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

/** Compact token count: 4.87B / 5.30M / 12.4K / 842 */
export function formatCount(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "-"
  const v = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  if (v >= 1_000_000_000) return `${sign}${(v / 1_000_000_000).toFixed(decimals)}B`
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toFixed(decimals)}M`
  if (v >= 1_000) return `${sign}${(v / 1_000).toFixed(decimals)}K`
  return `${sign}${v.toLocaleString("en-US", { maximumFractionDigits: decimals })}`
}

export function formatPercent(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "-"
  return `${value.toFixed(decimals)}%`
}

/** APY/APR — same shape as percent; named for intent at call sites. */
export function formatApy(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return "-"
  return `${value.toFixed(decimals)}%`
}

/** Signed percent with explicit + sign for positive values. */
export function formatSignedPercent(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "-"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(decimals)}%`
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "-"
  if (value >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  if (value >= 1) return `$${value.toFixed(4)}`
  return `$${value.toPrecision(4)}`
}

export function formatDateFull(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** Month + year, e.g. "Jun 2026". */
export function formatMonthYear(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** Readable window range, e.g. "Jun 2025 to Jun 2026" (no dashes). */
export function formatWindow(endTs: number, days: number): string {
  return `${formatMonthYear(endTs - days * 86_400)} to ${formatMonthYear(endTs)}`
}

/** Relative age of a Unix-seconds timestamp, e.g. "3 min ago", "2 h ago". */
export function formatRelativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const delta = Math.max(0, now - ts)
  if (delta < 60) return "just now"
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`
  return `${Math.floor(delta / 86400)} d ago`
}

/** Absolute UTC stamp for hover titles, e.g. "2026-06-18 14:05Z". */
export function formatAbsoluteUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z"
}

/** ERC-20 raw bigint → human float given decimals. */
export function fromUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw)
  // Scale via string to avoid precision loss on very large balances.
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = abs % base
  const num = Number(whole) + Number(frac) / Number(base)
  return negative ? -num : num
}

/** Percent change between two values; null when the base is not usable. */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null
  }
  return ((current - previous) / previous) * 100
}
