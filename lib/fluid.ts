// Fills the kit's normalised shapes (lib/types.ts) from Fluid's own data layer.
//
// Same reason as euler-dashboard-next: there is no `fluid` product on the Datum platform
// (datum-models carries aave, centrifuge, morpho, ref, rwa and sui), so there is nothing for the
// kit's platform loader to read. These modules are copied under lib/fluid/ and are the same ones
// the existing Fluid terminal renders, which matters because its DEX volume reconciles exactly to
// Fluid's own quarterly reports. Re-deriving here would drift from a number that has been checked
// against the protocol's published figures.
//
// datum.config.ts sets `dataSource: 'dashboard'` so the frame says so rather than claiming datum-api.
// When a Fluid product lands on the platform, this is the only file that changes.

import { cache } from 'react';
import { getMultiChain } from './fluid/fluid-multichain';
import { getFluidDex } from './fluid/fluid-dex';
import { loadFluidVaults, type FluidVault } from './fluid/fluid-onchain';
import { chainLogo, protocolLogo } from './chains';
import type { Market, MarketDetail, Overview, Point, Share } from './types';

const risk = (u: number): Market['risk'] => (u > 85 ? 'high' : u > 70 ? 'moderate' : 'safe');
const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const pctChange = (now: number, then: number) => (then > 0 ? (now / then - 1) * 100 : 0);

/**
 * A Fluid vault as the kit's Market.
 *
 * Vaults, not assets. An earlier version aggregated the token mix into one row per asset, which
 * fought the table template (built for collateral/loan pairs) and could not show a liquidation
 * threshold, because Fluid sets those per vault rather than per token. Reading the vaults on
 * chain through Fluid's VaultResolver gives the real pair AND the real risk parameters.
 *
 * `liquidationThreshold` and `collateralFactor` arrive as 0-1 fractions decoded from Fluid's
 * 1e4 bps, so both are scaled to percent here.
 */
function toMarket(v: FluidVault): Market {
  const supplied = v.suppliedUsd ?? 0;
  const borrowed = v.borrowedUsd ?? 0;
  const util = supplied > 0 ? (borrowed / supplied) * 100 : 0;
  const lt = v.liquidationThreshold * 100;
  return {
    id: v.address.toLowerCase(),
    protocol: 'Fluid',
    chain: 'Ethereum',
    collateral: v.collateralSymbol,
    loan: v.loanSymbol,
    supplied,
    borrowed,
    utilization: util,
    // Fluid's VaultResolver DOES return supplyRateVault / borrowRateVault, and the ABI here
    // decodes them, but nothing in the source dashboard ever rendered them, so their scaling is
    // unverified. Publishing a rate on a guessed scale is exactly the mistake that produced a
    // $97,878B headline earlier in this build. n/a until checked against a known vault.
    supply_apy: undefined as unknown as number,
    borrow_apy: undefined as unknown as number,
    // Real, read on chain. Smart vaults hold an LP position rather than a plain token, so a
    // threshold of zero there means "not expressed this way", not "liquidates at zero".
    lltv: lt > 0 ? lt : (undefined as unknown as number),
    risk: risk(util),
    address: v.address,
    logos: { protocol: protocolLogo('fluid'), chain: chainLogo('ethereum') },
  };
}

export const loadOverview = cache(async (): Promise<Overview> => {
  const [mc, dex, vaults] = await Promise.all([
    getMultiChain(),
    getFluidDex().catch(() => null),
    // On-chain vault read. Falls back to an empty table rather than taking the page down: the
    // headline figures come from the multichain series and stay correct either way.
    loadFluidVaults('ethereum').catch(() => null),
  ]);

  const daily = mc.aggregateDaily;
  const last = daily[daily.length - 1];
  const asOf = last ? isoDay(last.t) : new Date().toISOString().slice(0, 10);
  const weekAgo = daily[daily.length - 8] ?? daily[0];

  const history: Point[] = daily.slice(-365).map((d) => ({ day: isoDay(d.t), supply: d.deposits, borrow: d.borrows }));
  const rates: Point[] = daily.slice(-365).map((d) => ({ day: isoDay(d.t), utilization: d.utilization ?? 0 }));

  const byChain: Share[] = mc.perChain
    .map((c) => ({ name: c.label, value: c.deposits }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  // Fluid is one protocol, so the second breakdown is the DEX book by asset class, which is the
  // cut that distinguishes it from a plain money market.
  const byProtocol: Share[] = (dex?.byAssetClass ?? [])
    .map((c) => ({ name: c.name, value: c.volume7d }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  const markets = (vaults?.vaults ?? [])
    .map(toMarket)
    .filter((m) => m.supplied > 0 || m.borrowed > 0)
    .sort((a, b) => b.supplied - a.supplied);
  const supplied = mc.snap.deposits.current;
  const borrowed = mc.snap.borrows.current;
  const theirs = mc.snap.tvl.current;

  return {
    asOf,
    sample: false,
    kpis: {
      supplied,
      borrowed,
      suppliedChange7d: pctChange(supplied, weekAgo?.deposits ?? 0),
      borrowedChange7d: pctChange(borrowed, weekAgo?.borrows ?? 0),
      markets: markets.length,
      utilization: supplied > 0 ? (borrowed / supplied) * 100 : 0,
      // Fluid's aggregate supply APY is not in this data layer. Passed undefined so the card reads
      // n/a; a literal 0 would render "0.00%" under "What suppliers earn today", which is a false
      // statement about a protocol paying real yield.
      supplyApy: undefined as unknown as number,
    },
    history,
    historyGrain: 'daily',
    rates,
    byChain,
    byProtocol,
    markets,
    reconciliation: theirs
      ? {
          ours: supplied,
          theirs,
          theirsSource: 'DefiLlama',
          note: 'Ours is gross deposits across every chain Fluid is live on; DefiLlama reports net TVL, so the two differ by the borrowed balance rather than disagreeing.',
        }
      : null,
  };
});

export const loadMarket = cache(async (id: string): Promise<MarketDetail | null> => {
  const [mc, vaults] = await Promise.all([getMultiChain(), loadFluidVaults('ethereum').catch(() => null)]);
  const market = (vaults?.vaults ?? []).map(toMarket).find((m) => m.id === id);
  if (!market) return null;
  const daily = mc.aggregateDaily;
  const last = daily[daily.length - 1];

  return {
    asOf: last ? isoDay(last.t) : new Date().toISOString().slice(0, 10),
    sample: false,
    market,
    // Per-asset history is not in this data layer yet. Showing the protocol aggregate under one
    // asset's name would be wrong, so the charts stay empty until the series exists.
    history: [],
    rates: [],
    facts: [
      { label: 'Pair', value: `${market.collateral} / ${market.loan}` },
      { label: 'Supplied', value: `$${market.supplied.toLocaleString()}` },
      { label: 'Borrowed', value: `$${market.borrowed.toLocaleString()}` },
      { label: 'Vault', value: market.address ?? 'n/a' },
    ],
    suppliers: [],
    healthBands: [],
  };
});
