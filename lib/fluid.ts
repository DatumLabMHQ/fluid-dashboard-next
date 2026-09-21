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
import { chainLogo, protocolLogo } from './chains';
import type { Market, MarketDetail, Overview, Point, Share } from './types';

const risk = (u: number): Market['risk'] => (u > 85 ? 'high' : u > 70 ? 'moderate' : 'safe');
const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const pctChange = (now: number, then: number) => (then > 0 ? (now / then - 1) * 100 : 0);

/**
 * Fluid's book by ASSET, not by pair. The data layer exposes supplied and borrowed per token per
 * chain, not per market, so a row is one asset across every chain. The kit's table template is
 * built for pair markets and renders a second label as "<loan> loan"; for a single-asset row that
 * is still true (Fluid does lend that asset), and the table caption says the rows are assets.
 */
function assetRows(mix: Awaited<ReturnType<typeof getMultiChain>>['mix']): Market[] {
  const supplied = new Map<string, number>();
  const borrowed = new Map<string, number>();
  for (const chain of mix) {
    const snap = chain.periods.current;
    if (!snap) continue;
    for (const [token, v] of Object.entries(snap.supplied ?? {})) supplied.set(token, (supplied.get(token) ?? 0) + v);
    for (const [token, v] of Object.entries(snap.borrowed ?? {})) borrowed.set(token, (borrowed.get(token) ?? 0) + v);
  }
  const tokens = new Set([...supplied.keys(), ...borrowed.keys()]);
  return [...tokens]
    .map((token) => {
      const s = supplied.get(token) ?? 0;
      const b = borrowed.get(token) ?? 0;
      const util = s > 0 ? (b / s) * 100 : 0;
      return {
        id: token.toLowerCase(),
        protocol: 'Fluid',
        chain: 'All chains',
        collateral: token,
        loan: token,
        supplied: s,
        borrowed: b,
        utilization: util,
        supply_apy: 0,
        borrow_apy: 0,
        // Fluid's LTVs are per vault type and this aggregate has no single one, so it reads n/a
        // rather than a made-up number.
        lltv: undefined as unknown as number,
        risk: risk(util),
        logos: { protocol: protocolLogo('fluid'), chain: chainLogo('ethereum') },
      } satisfies Market;
    })
    .filter((m) => m.supplied > 0 || m.borrowed > 0)
    .sort((a, b) => b.supplied - a.supplied);
}

export const loadOverview = cache(async (): Promise<Overview> => {
  const [mc, dex] = await Promise.all([getMultiChain(), getFluidDex().catch(() => null)]);

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

  const markets = assetRows(mc.mix);
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
  const mc = await getMultiChain();
  const market = assetRows(mc.mix).find((m) => m.id === id);
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
      { label: 'Asset', value: market.collateral },
      { label: 'Supplied', value: `$${market.supplied.toLocaleString()}` },
      { label: 'Borrowed', value: `$${market.borrowed.toLocaleString()}` },
      { label: 'Scope', value: 'All chains', note: 'Fluid deposits are aggregated across every chain it is live on.' },
    ],
    suppliers: [],
    healthBands: [],
  };
});
