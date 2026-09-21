/**
 * The DEX page's data, ported from fluid-dashboard/lib/pages.ts `loadDex()`.
 *
 * Shapes are reworked for the kit's chart components, which take `Row[]` plus a `Series[]`
 * rather than the bespoke chart props the source dashboard used. The numbers and their
 * definitions are unchanged: this reads the same vendored modules under lib/fluid/, whose DEX
 * volume reconciles exactly to Fluid's own quarterly reports.
 */

import { cache } from 'react';
import { getFluidDex, buildDexTurnover } from './fluid/fluid-dex';
import { getLendingResearch } from './fluid/fluid-lending-research';
import { getIssuerFranchise } from './fluid/fluid-issuers';
import type { Row } from '@/components/charts';

export interface Stat {
  label: string;
  value: number;
  unit: 'usd' | 'pct' | 'count' | 'ratio';
  caption: string;
  /** Percentage change over 30 days, when the source carries one. */
  change30d?: number | null;
}

export interface DexPage {
  asOf: string;
  stats: Stat[];
  /**
   * Daily volume per $1 of liquidity, per DEX.
   *
   * Split across two series rather than one, because the kit's BarChart colours per SERIES and has
   * no per-bar override. A row carries its value under `fluid` or `peer` and zero under the other,
   * so Fluid renders in the accent and the peers stay muted - the contrast the original relies on
   * - without needing a change to the chart component.
   */
  turnover: Array<Row & { name: string; fluid: number; peer: number }>;
  turnoverScope: 'ethereum';
  vsUniswap: number | null;
  vsCurve: number | null;
  /**
   * Where Fluid actually sits on capital efficiency, computed rather than asserted.
   *
   * The source dashboard's copy said "Fluid leads on Ethereum". That was true when written and is
   * not always true since: Uniswap v4 has been ahead on this window. A dashboard that keeps
   * claiming a lead it no longer holds is worth less than one that reports the rank, so the page
   * reads these instead of hardcoding the claim.
   */
  turnoverRank: { rank: number; of: number; leader: string; fluidPerDollar: number } | null;
  /** 7d Ethereum stable-pair volume by venue, split the same way. */
  stablecoinShare: Array<Row & { name: string; fluid: number; peer: number }>;
  fluidStablecoinPct: number;
  /** Completed quarters only. */
  volumeByQuarter: Array<Row & { name: string; volume: number }>;
  volumeQoQ: { latestLabel: string; latestVol: number; prevLabel: string; qoqPct: number | null };
  /** Top pairs by 7d volume, plus Other. */
  volumeByPair: Array<{ name: string; value: number }>;
  /** Volume and TVL per asset class. */
  byAssetClass: Array<Row & { name: string; volume: number; tvl: number }>;
  /** Stacked daily volume by chain. */
  byChain: { series: Array<{ key: string; label: string }>; rows: Row[] };
  feesDaily: Row[];
  feeRateDaily: Row[];
  /** Per-pool TVL against turnover, for the efficiency scatter. */
  poolEfficiency: Array<{ name: string; tvl: number; turnover: number; volume7d: number }>;
  feeYields: Array<Row & { name: string; feeApy: number }>;
  issuerDeposits: Array<Row & { name: string; value: number }>;
  issuerDexShare: Array<Row & { name: string; value: number }>;
  issuerTotalDepositsUsd: number;
}

/** The vendored DEX_LABEL map does not cover every venue, so unmapped slugs arrive raw. */
function prettyVenue(label: string): string {
  if (!/^[a-z0-9-]+$/.test(label)) return label;
  return label
    .split('-')
    .map((w) => (/^v\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Quarter bucket for a unix timestamp: start instant plus a "Q3 '25" label. */
function quarterOf(t: number): { start: number; label: string } {
  const d = new Date(t * 1000);
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = Date.UTC(d.getUTCFullYear(), q * 3, 1) / 1000;
  return { start, label: `Q${q + 1} '${String(d.getUTCFullYear()).slice(2)}` };
}

/** Total DEX volume per COMPLETED quarter. The in-progress quarter is dropped so bars compare. */
function quarterlyVolume(volumeDaily: Array<{ t: number; v: number }>) {
  const byQ = new Map<number, { label: string; vol: number }>();
  for (const p of volumeDaily) {
    const { start, label } = quarterOf(p.t);
    const e = byQ.get(start) ?? { label, vol: 0 };
    e.vol += p.v;
    byQ.set(start, e);
  }
  const current = quarterOf(Math.floor(Date.now() / 1000)).start;
  const rows = [...byQ.entries()]
    .filter(([start]) => start !== current)
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({ name: e.label, volume: e.vol }));

  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  return {
    volumeByQuarter: rows,
    volumeQoQ: {
      latestLabel: latest?.name ?? '',
      latestVol: latest?.volume ?? 0,
      prevLabel: prev?.name ?? '',
      qoqPct: latest && prev && prev.volume > 0 ? ((latest.volume - prev.volume) / prev.volume) * 100 : null,
    },
  };
}

export const loadDex = cache(async (): Promise<DexPage> => {
  const [dex, turnoverData, research, issuers] = await Promise.all([
    getFluidDex(),
    buildDexTurnover().catch(() => null),
    getLendingResearch().catch(() => null),
    getIssuerFranchise().catch(() => null),
  ]);

  const pools = dex.pools ?? [];
  const eth = turnoverData?.ethereum;

  const volSorted = [...pools].filter((p) => p.volume7d > 0).sort((a, b) => b.volume7d - a.volume7d);
  const topPairs = volSorted.slice(0, 8);
  const otherVol = volSorted.slice(8).reduce((s, p) => s + p.volume7d, 0);

  const { volumeByQuarter, volumeQoQ } = quarterlyVolume(dex.volumeDaily ?? []);

  return {
    asOf: isoDay(dex.fetchedAt ?? Math.floor(Date.now() / 1000)),
    stats: [
      { label: 'DEX TVL', value: dex.tvlSnap.current, unit: 'usd', caption: 'Pool liquidity', change30d: dex.tvlSnap.change30d },
      { label: 'Volume 24h', value: dex.volume24hSnap.current, unit: 'usd', caption: 'Trades in the last day', change30d: dex.volume24hSnap.change30d },
      { label: 'Volume 30d', value: dex.volume30d, unit: 'usd', caption: 'Trailing thirty days' },
      { label: 'Capital turnover', value: dex.avgTurnover, unit: 'ratio', caption: 'Annualised volume per $1 of liquidity' },
    ],
    turnover: (eth?.points ?? []).map((p) => ({
      name: prettyVenue(p.label),
      fluid: p.isFluid ? p.perDollar : 0,
      peer: p.isFluid ? 0 : p.perDollar,
    })),
    turnoverScope: 'ethereum',
    turnoverRank: (() => {
      const pts = [...(eth?.points ?? [])].sort((a, b) => b.perDollar - a.perDollar);
      const i = pts.findIndex((p) => p.isFluid);
      if (i < 0 || !pts.length) return null;
      return { rank: i + 1, of: pts.length, leader: prettyVenue(pts[0].label), fluidPerDollar: pts[i].perDollar };
    })(),
    vsUniswap: eth?.vsUniswap ?? null,
    vsCurve: eth?.vsCurve ?? null,
    stablecoinShare: (research?.stablecoinDexShare ?? []).map((r) => ({
      name: r.label,
      fluid: r.isFluid ? r.value : 0,
      peer: r.isFluid ? 0 : r.value,
    })),
    fluidStablecoinPct: research?.fluidStablecoinDexPct ?? 0,
    volumeByQuarter,
    volumeQoQ,
    volumeByPair: [
      ...topPairs.map((p) => ({ name: p.pair, value: p.volume7d })),
      ...(otherVol > 0 ? [{ name: 'Other', value: otherVol }] : []),
    ],
    byAssetClass: (dex.byAssetClass ?? []).map((c) => ({ name: c.name, volume: c.volume7d, tvl: c.tvl })),
    byChain: {
      series: (dex.byChainVolume?.chains ?? []).map((c) => ({ key: c.key, label: c.label })),
      rows: (dex.byChainVolume?.rows ?? []).map((r) => ({ ...r, day: isoDay(Number(r.t)) })) as Row[],
    },
    feesDaily: (dex.feesDaily ?? []).map((p) => ({ day: isoDay(p.t), fees: p.v })),
    feeRateDaily: (dex.feeRateDaily ?? []).map((p) => ({ day: isoDay(p.t), rate: p.v })),
    poolEfficiency: pools
      .filter((p) => p.tvl > 0 && p.volume7d > 0)
      .slice(0, 20)
      .map((p) => ({ name: p.pair, tvl: p.tvl, turnover: p.turnover, volume7d: p.volume7d })),
    feeYields: pools
      .filter((p) => (p.feeApy ?? 0) > 0)
      .sort((a, b) => (b.feeApy ?? 0) - (a.feeApy ?? 0))
      .slice(0, 12)
      .map((p) => ({ name: p.pair, feeApy: p.feeApy ?? 0 })),
    issuerDeposits: (issuers?.deposits ?? []).map((r) => ({ name: r.label, value: r.value })),
    issuerDexShare: (issuers?.dexShare ?? []).map((r) => ({ name: r.label, value: r.value })),
    issuerTotalDepositsUsd: issuers?.totalDepositsUsd ?? 0,
  };
});
