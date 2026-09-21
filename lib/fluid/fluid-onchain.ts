/* eslint-disable @typescript-eslint/no-explicit-any -- vendored on-chain reader.
 * Copied from fluid-dashboard, where it decodes Fluid's VaultResolver structs. The `any` is in
 * the multicall result narrowing; retyping viem's decoded tuples by hand here would risk getting
 * a risk parameter wrong, which is the one thing this file must not do.
 * NEW code in this app must not use `any`.
 */
/**
 * Fluid VaultResolver on-chain reads (Ethereum, Phase 1).
 *
 * One call (`VaultResolver.getVaultsEntireData()`) returns every active vault
 * in one batch — configs, exchange rates, totals, limits. We decode the fields
 * the dashboard consumes and enrich them with token symbols / decimals / USD
 * from DefiLlama's Coins API.
 *
 * Ported from the Lending Intelligence Terminal's reader (the ABI field order
 * matches `Structs.VaultEntireData` in fluid-contracts-public) and extended to:
 *  - resolve token symbols + decimals and value totals in USD (plain vaults),
 *  - expose borrow/supply cap usage, and smart-collateral / smart-debt flags.
 *
 * USD note: for "smart" vaults the collateral and/or debt is a Fluid DEX LP
 * position, so the raw totals are not plain token amounts. We therefore leave
 * USD null for the smart side and rely on the risk parameters + badges. Plain
 * (T1) vaults get exact USD. This is intentionally conservative — Phase 2 adds
 * proper LP valuation for the smart-collateral / smart-debt panels.
 */
import { type Address } from "viem"
import { readResilient } from "./rpc"
import { RESOLVERS } from "./reference"
import { fetchTokenInfoBatch, priceKeyFor, type TokenInfo } from "./prices"
import { fromUnits } from "./format"

// ─────────────────────────────────────────────────────────────────────────
// ABI for `getVaultsEntireData()` — field order MUST match the resolver struct.
// ─────────────────────────────────────────────────────────────────────────

const TOKENS_TUPLE = {
  type: "tuple",
  components: [
    { name: "token0", type: "address" },
    { name: "token1", type: "address" },
  ],
} as const

const CONSTANT_VIEWS_TUPLE = {
  type: "tuple",
  components: [
    { name: "liquidity", type: "address" },
    { name: "factory", type: "address" },
    { name: "operateImplementation", type: "address" },
    { name: "adminImplementation", type: "address" },
    { name: "secondaryImplementation", type: "address" },
    { name: "deployer", type: "address" },
    { name: "supply", type: "address" },
    { name: "borrow", type: "address" },
    { ...TOKENS_TUPLE, name: "supplyToken" },
    { ...TOKENS_TUPLE, name: "borrowToken" },
    { name: "vaultId", type: "uint256" },
    { name: "vaultType", type: "uint256" },
    { name: "supplyExchangePriceSlot", type: "bytes32" },
    { name: "borrowExchangePriceSlot", type: "bytes32" },
    { name: "userSupplySlot", type: "bytes32" },
    { name: "userBorrowSlot", type: "bytes32" },
  ],
} as const

const CONFIGS_TUPLE = {
  type: "tuple",
  components: [
    { name: "supplyRateMagnifier", type: "uint16" },
    { name: "borrowRateMagnifier", type: "uint16" },
    { name: "collateralFactor", type: "uint16" },
    { name: "liquidationThreshold", type: "uint16" },
    { name: "liquidationMaxLimit", type: "uint16" },
    { name: "withdrawalGap", type: "uint16" },
    { name: "liquidationPenalty", type: "uint16" },
    { name: "borrowFee", type: "uint16" },
    { name: "oracle", type: "address" },
    { name: "oraclePriceOperate", type: "uint256" },
    { name: "oraclePriceLiquidate", type: "uint256" },
    { name: "rebalancer", type: "address" },
    { name: "lastUpdateTimestamp", type: "uint256" },
  ],
} as const

const EXCHANGE_PRICES_AND_RATES_TUPLE = {
  type: "tuple",
  components: [
    { name: "lastStoredLiquiditySupplyExchangePrice", type: "uint256" },
    { name: "lastStoredLiquidityBorrowExchangePrice", type: "uint256" },
    { name: "lastStoredVaultSupplyExchangePrice", type: "uint256" },
    { name: "lastStoredVaultBorrowExchangePrice", type: "uint256" },
    { name: "liquiditySupplyExchangePrice", type: "uint256" },
    { name: "liquidityBorrowExchangePrice", type: "uint256" },
    { name: "vaultSupplyExchangePrice", type: "uint256" },
    { name: "vaultBorrowExchangePrice", type: "uint256" },
    { name: "supplyRateLiquidity", type: "uint256" },
    { name: "borrowRateLiquidity", type: "uint256" },
    { name: "supplyRateVault", type: "int256" },
    { name: "borrowRateVault", type: "int256" },
    { name: "rewardsOrFeeRateSupply", type: "int256" },
    { name: "rewardsOrFeeRateBorrow", type: "int256" },
  ],
} as const

const TOTAL_SUPPLY_AND_BORROW_TUPLE = {
  type: "tuple",
  components: [
    { name: "totalSupplyVault", type: "uint256" },
    { name: "totalBorrowVault", type: "uint256" },
    { name: "totalSupplyLiquidityOrDex", type: "uint256" },
    { name: "totalBorrowLiquidityOrDex", type: "uint256" },
    { name: "absorbedSupply", type: "uint256" },
    { name: "absorbedBorrow", type: "uint256" },
  ],
} as const

const LIMITS_TUPLE = {
  type: "tuple",
  components: [
    { name: "withdrawLimit", type: "uint256" },
    { name: "withdrawableUntilLimit", type: "uint256" },
    { name: "withdrawable", type: "uint256" },
    { name: "borrowLimit", type: "uint256" },
    { name: "borrowableUntilLimit", type: "uint256" },
    { name: "borrowable", type: "uint256" },
    { name: "borrowLimitUtilization", type: "uint256" },
    { name: "minimumBorrowing", type: "uint256" },
  ],
} as const

const CURRENT_BRANCH_TUPLE = {
  type: "tuple",
  components: [
    { name: "status", type: "uint256" },
    { name: "minimaTick", type: "int256" },
    { name: "debtFactor", type: "uint256" },
    { name: "partials", type: "uint256" },
    { name: "debtLiquidity", type: "uint256" },
    { name: "baseBranchId", type: "uint256" },
    { name: "baseBranchMinima", type: "int256" },
  ],
} as const

const VAULT_STATE_TUPLE = {
  type: "tuple",
  components: [
    { name: "totalPositions", type: "uint256" },
    { name: "topTick", type: "int256" },
    { name: "currentBranch", type: "uint256" },
    { name: "totalBranch", type: "uint256" },
    { name: "totalBorrow", type: "uint256" },
    { name: "totalSupply", type: "uint256" },
    { ...CURRENT_BRANCH_TUPLE, name: "currentBranchState" },
  ],
} as const

const USER_SUPPLY_DATA_TUPLE = {
  type: "tuple",
  components: [
    { name: "modeWithInterest", type: "bool" },
    { name: "supply", type: "uint256" },
    { name: "withdrawalLimit", type: "uint256" },
    { name: "lastUpdateTimestamp", type: "uint256" },
    { name: "expandPercent", type: "uint256" },
    { name: "expandDuration", type: "uint256" },
    { name: "baseWithdrawalLimit", type: "uint256" },
    { name: "withdrawableUntilLimit", type: "uint256" },
    { name: "withdrawable", type: "uint256" },
    { name: "decayEndTimestamp", type: "uint256" },
    { name: "decayAmount", type: "uint256" },
  ],
} as const

const USER_BORROW_DATA_TUPLE = {
  type: "tuple",
  components: [
    { name: "modeWithInterest", type: "bool" },
    { name: "borrow", type: "uint256" },
    { name: "borrowLimit", type: "uint256" },
    { name: "lastUpdateTimestamp", type: "uint256" },
    { name: "expandPercent", type: "uint256" },
    { name: "expandDuration", type: "uint256" },
    { name: "baseBorrowLimit", type: "uint256" },
    { name: "maxBorrowLimit", type: "uint256" },
    { name: "borrowableUntilLimit", type: "uint256" },
    { name: "borrowable", type: "uint256" },
    { name: "borrowLimitUtilization", type: "uint256" },
  ],
} as const

const VAULT_RESOLVER_ABI = [
  {
    type: "function",
    name: "getVaultsEntireData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "vaultsData",
        type: "tuple[]",
        components: [
          { name: "vault", type: "address" },
          { name: "isSmartCol", type: "bool" },
          { name: "isSmartDebt", type: "bool" },
          { ...CONSTANT_VIEWS_TUPLE, name: "constantVariables" },
          { ...CONFIGS_TUPLE, name: "configs" },
          { ...EXCHANGE_PRICES_AND_RATES_TUPLE, name: "exchangePricesAndRates" },
          { ...TOTAL_SUPPLY_AND_BORROW_TUPLE, name: "totalSupplyAndBorrow" },
          { ...LIMITS_TUPLE, name: "limitsAndAvailability" },
          { ...VAULT_STATE_TUPLE, name: "vaultState" },
          { ...USER_SUPPLY_DATA_TUPLE, name: "liquidityUserSupplyData" },
          { ...USER_BORROW_DATA_TUPLE, name: "liquidityUserBorrowData" },
        ],
      },
    ],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────
// Decoded + enriched types.
// ─────────────────────────────────────────────────────────────────────────

export interface FluidVault {
  address: string
  vaultId: number
  vaultType: number
  isSmartCol: boolean
  isSmartDebt: boolean
  isSmart: boolean

  collateralAsset: string
  loanAsset: string
  collateralSymbol: string
  loanSymbol: string

  // Risk parameters — exact, 0-1 fractions decoded from Fluid's 1e4 bps.
  collateralFactor: number // max LTV
  liquidationThreshold: number
  liquidationPenalty: number
  borrowFee: number

  // USD sizes. Null on the smart side (LP position, not a plain token amount).
  suppliedUsd: number | null
  borrowedUsd: number | null

  /** open positions in the vault (from vaultState.totalPositions). */
  positions: number

  /** borrow / borrowLimit, as a percentage in [0,100]. Null when the vault is
   *  uncapped, has smart (DEX-unit) debt, or the cap is zero. */
  borrowCapUsedPct: number | null
  /** True when the vault has no borrow cap (uncapped sentinel). */
  borrowUncapped: boolean
  loanDecimals: number | null
  totalPositionsKnown: boolean
}

export interface FluidVaultsSnapshot {
  vaults: FluidVault[]
  /** Sum of plain-vault supplied USD (on-chain) — a coarse cross-check figure. */
  onchainPlainSuppliedUsd: number
  totalCount: number
  smartCount: number
  fetchedAt: number
}

const ETH_SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
])

function bps(n: number): number {
  return n / 10_000
}

function symbolFor(
  address: string,
  info: TokenInfo | undefined,
  chain: string,
): string {
  const lower = address.toLowerCase()
  if (ETH_SENTINELS.has(lower)) return "ETH"
  if (info?.symbol) return info.symbol.toUpperCase()
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// Single-flight cache — Fluid vault state moves slowly; 5-minute TTL is fine.
const CACHE_TTL_MS = 5 * 60_000
let cache: { at: number; snap: FluidVaultsSnapshot } | null = null

export async function loadFluidVaults(chain = "ethereum"): Promise<FluidVaultsSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snap

  const resolver = RESOLVERS[chain]?.vaultResolver
  if (!resolver) {
    const empty: FluidVaultsSnapshot = {
      vaults: [],
      onchainPlainSuppliedUsd: 0,
      totalCount: 0,
      smartCount: 0,
      fetchedAt: Math.floor(Date.now() / 1000),
    }
    return empty
  }

  const raw = (await readResilient((client) =>
    client.readContract({
      address: resolver as Address,
      abi: VAULT_RESOLVER_ABI,
      functionName: "getVaultsEntireData",
    }),
  )) as unknown as Array<Record<string, any>>

  // Collect the unique token addresses to price in one batch.
  const refs: Array<{ chain: string; address: string }> = []
  const seen = new Set<string>()
  for (const v of raw) {
    for (const addr of [
      v.constantVariables.supplyToken.token0 as string,
      v.constantVariables.borrowToken.token0 as string,
    ]) {
      const k = priceKeyFor(chain, addr)
      if (!seen.has(k)) {
        seen.add(k)
        refs.push({ chain, address: addr })
      }
    }
  }
  const priceMap = await fetchTokenInfoBatch(refs)
  const infoFor = (addr: string) => priceMap.get(priceKeyFor(chain, addr))

  let onchainPlainSuppliedUsd = 0
  let smartCount = 0

  const vaults: FluidVault[] = raw.map((v) => {
    const cv = v.constantVariables
    const cf = v.configs
    const lim = v.limitsAndAvailability
    const sb = v.totalSupplyAndBorrow
    const st = v.vaultState

    const collateralAsset = cv.supplyToken.token0 as string
    const loanAsset = cv.borrowToken.token0 as string
    const colInfo = infoFor(collateralAsset)
    const loanInfo = infoFor(loanAsset)

    const isSmartCol = Boolean(v.isSmartCol)
    const isSmartDebt = Boolean(v.isSmartDebt)
    const isSmart = isSmartCol || isSmartDebt
    if (isSmart) smartCount++

    // USD only for the plain side(s). Smart side -> null (LP position).
    let suppliedUsd: number | null = null
    if (!isSmartCol && colInfo) {
      suppliedUsd = fromUnits(sb.totalSupplyVault as bigint, colInfo.decimals) * colInfo.priceUsd
      if (Number.isFinite(suppliedUsd)) onchainPlainSuppliedUsd += suppliedUsd
    }
    let borrowedUsd: number | null = null
    if (!isSmartDebt && loanInfo) {
      borrowedUsd = fromUnits(sb.totalBorrowVault as bigint, loanInfo.decimals) * loanInfo.priceUsd
    }

    // Borrow-cap utilization = current borrow / the vault's operating borrow
    // limit. Both are the loan token's raw units, so the ratio is decimals-
    // independent. Guards:
    //  - smart-debt vaults: totalBorrowVault is in DEX-share units, not token
    //    units, so the ratio is meaningless -> null.
    //  - borrowLimit == 0 -> uncapped, null.
    //  - ratios far above 100% come from Fluid's packed BigNumber limit
    //    encoding on special / dust vaults -> reject (N/A), don't clamp.
    const borrowLimit = lim.borrowLimit as bigint
    const totalBorrow = sb.totalBorrowVault as bigint
    const borrowUncapped = borrowLimit <= 0n
    let borrowCapUsedPct: number | null = null
    if (!isSmartDebt && !borrowUncapped) {
      const pct = Number((totalBorrow * 1_000_000n) / borrowLimit) / 10_000
      if (Number.isFinite(pct) && pct <= 101) borrowCapUsedPct = Math.min(100, Math.max(0, pct))
    }

    return {
      address: v.vault as string,
      vaultId: Number(cv.vaultId),
      vaultType: Number(cv.vaultType),
      isSmartCol,
      isSmartDebt,
      isSmart,
      collateralAsset,
      loanAsset,
      collateralSymbol: symbolFor(collateralAsset, colInfo, chain),
      loanSymbol: symbolFor(loanAsset, loanInfo, chain),
      collateralFactor: bps(Number(cf.collateralFactor)),
      liquidationThreshold: bps(Number(cf.liquidationThreshold)),
      liquidationPenalty: bps(Number(cf.liquidationPenalty)),
      borrowFee: bps(Number(cf.borrowFee)),
      suppliedUsd,
      borrowedUsd,
      positions: Number(st.totalPositions),
      borrowCapUsedPct,
      borrowUncapped,
      loanDecimals: isSmartDebt ? null : loanInfo?.decimals ?? null,
      totalPositionsKnown: true,
    }
  })

  // Largest first by known supplied USD, then by positions (smart vaults).
  vaults.sort((a, b) => {
    const av = a.suppliedUsd ?? 0
    const bv = b.suppliedUsd ?? 0
    if (bv !== av) return bv - av
    return b.positions - a.positions
  })

  const snap: FluidVaultsSnapshot = {
    vaults,
    onchainPlainSuppliedUsd,
    totalCount: vaults.length,
    smartCount,
    fetchedAt: Math.floor(Date.now() / 1000),
  }
  cache = { at: Date.now(), snap }
  return snap
}
