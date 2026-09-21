/**
 * The lending page's data, ported from fluid-dashboard/lib/pages.ts `loadLending()`.
 *
 * Same treatment as the DEX page: numbers and definitions unchanged, shapes reworked for the
 * kit's chart components. Peer comparisons are split into `fluid` and `peer` series because the
 * kit's BarChart colours per series with no per-bar override, which is how a single bar gets the
 * brand accent while the rest stay muted.
 */

import { cache } from 'react';
import { getLendingResearch } from './fluid/fluid-lending-research';
import { getFluidAssetHistory } from './fluid/fluid-asset-history';
import { getFluidLite } from './fluid/fluid-lite';
import { buildRateComparison, type RateComparison } from './fluid/comparison';
import type { Row } from '@/components/charts';

export interface Stat {
  label: string;
  value: number;
  unit: 'usd' | 'pct' | 'count' | 'ratio';
  caption: string;
}

/** A ranked peer comparison: one row per venue, value under `fluid` or `peer`. */
export type PeerRow = Row & { name: string; fluid: number; peer: number };

export interface RateBoard {
  asset: string;
  rows: PeerRow[];
  fluidRank: number | null;
  of: number;
}

export interface LendingPage {
  asOf: string;
  stats: Stat[];
  deposits: { series: Array<{ key: string; label: string }>; rows: Row[] };
  borrows: { series: Array<{ key: string; label: string }>; rows: Row[] };
  stablecoinShare: PeerRow[];
  fluidStablecoinPct: number;
  supplyRates: RateBoard[];
  borrowRates: RateBoard[];
  lite: {
    tvlUsd: number;
    drawdownUsdPct: number;
    drawdownUnitsPct: number;
    revenue30d: number;
  } | null;
}

const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Ranked peers as two series, so the Fluid bar takes the accent colour. */
function toPeerRows(points: Array<{ label: string; value: number; isFluid: boolean }>): PeerRow[] {
  return points.map((p) => ({
    name: p.label,
    fluid: p.isFluid ? p.value : 0,
    peer: p.isFluid ? 0 : p.value,
  }));
}

function toRateBoard(asset: string, c: RateComparison | null): RateBoard | null {
  if (!c || !c.points.length) return null;
  // Rank and cohort size live under `fluid`, not at the top level.
  return { asset, rows: toPeerRows(c.points), fluidRank: c.fluid.rank, of: c.fluid.of };
}

export const loadLending = cache(async (): Promise<LendingPage> => {
  const [research, history, lite, usdcSupply, usdtSupply, usdcBorrow, usdtBorrow] = await Promise.all([
    getLendingResearch().catch(() => null),
    getFluidAssetHistory().catch(() => null),
    getFluidLite().catch(() => null),
    buildRateComparison('USDC', 'supply').catch(() => null),
    buildRateComparison('USDT', 'supply').catch(() => null),
    buildRateComparison('USDC', 'borrow').catch(() => null),
    buildRateComparison('USDT', 'borrow').catch(() => null),
  ]);

  const asOf = isoDay(history?.asOf ?? Math.floor(Date.now() / 1000));

  const supplyRates = [toRateBoard('USDC', usdcSupply), toRateBoard('USDT', usdtSupply)].filter(
    (b): b is RateBoard => b !== null,
  );
  const borrowRates = [toRateBoard('USDC', usdcBorrow), toRateBoard('USDT', usdtBorrow)].filter(
    (b): b is RateBoard => b !== null,
  );

  const depositRows = (history?.deposits.rows ?? []) as Row[];
  const latest = depositRows[depositRows.length - 1];
  const depositTotal = latest
    ? Object.entries(latest)
        .filter(([k]) => k !== 't' && k !== 'day')
        .reduce((a, [, v]) => a + (Number(v) || 0), 0)
    : 0;

  return {
    asOf,
    stats: [
      { label: 'Deposits', value: depositTotal, unit: 'usd', caption: 'Across every asset in the book' },
      {
        label: 'Stablecoin lending share',
        value: research?.fluidStablecoinPct ?? 0,
        unit: 'pct',
        // All chains. The DEX page's stablecoin figure is Ethereum-only and measures volume.
        caption: 'Of stablecoin lending supply, all chains',
      },
      ...(lite
        ? ([
            { label: 'Fluid Lite TVL', value: lite.tvlUsd, unit: 'usd', caption: 'Managed stETH vault' },
            {
              label: 'Lite drawdown, in ETH',
              value: lite.drawdownUnitsPct,
              unit: 'pct',
              caption: 'From peak, price excluded',
            },
          ] as Stat[])
        : []),
    ],
    deposits: {
      series: (history?.deposits.series ?? []).map((s) => ({ key: s.key, label: s.label })),
      rows: depositRows.map((r) => ({ ...r, day: isoDay(Number(r.t)) })),
    },
    borrows: {
      series: (history?.borrows.series ?? []).map((s) => ({ key: s.key, label: s.label })),
      rows: ((history?.borrows.rows ?? []) as Row[]).map((r) => ({ ...r, day: isoDay(Number(r.t)) })),
    },
    stablecoinShare: toPeerRows(research?.stablecoinShare ?? []),
    fluidStablecoinPct: research?.fluidStablecoinPct ?? 0,
    supplyRates,
    borrowRates,
    lite: lite
      ? {
          tvlUsd: lite.tvlUsd,
          drawdownUsdPct: lite.drawdownUsdPct,
          drawdownUnitsPct: lite.drawdownUnitsPct,
          revenue30d: lite.revenue30d,
        }
      : null,
  };
});
