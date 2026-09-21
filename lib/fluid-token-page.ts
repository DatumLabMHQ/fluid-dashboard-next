/**
 * The $FLUID page's data, ported from fluid-dashboard/lib/pages.ts `loadToken()`.
 *
 * Same treatment as the other ported pages: numbers unchanged, shapes reworked for the kit's
 * charts. Series arrive from the source as `{ t, ...keys }` rows; the kit's AreaChart keys its
 * x axis on a date string, so timestamps are converted to ISO days here rather than in the page.
 */

import { cache } from 'react';
import { getFluidToken } from './fluid/fluid-token';
import type { Row } from '@/components/charts';

export interface Stat {
  label: string;
  value: number | null;
  unit: 'usd' | 'pct' | 'count' | 'ratio' | 'price';
  caption: string;
}

export interface TokenPage {
  asOf: string;
  stats: Stat[];
  priceHistory: Row[];
  feesVsRevenue: Row[];
  buybackCumulative: Row[];
  revenueByChain: { series: Array<{ key: string; label: string }>; rows: Row[] };
  revenueBySource: { series: Array<{ key: string; label: string }>; rows: Row[] };
  takeRatePct: number | null;
  psRatio: number | null;
  sourceSplit: { fluidRevenue30d: number; jupRevenue30d: number; fluidFees30d: number; jupFees30d: number } | null;
}

const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** `{ t, ...keys }` rows keyed on a date string, which is what the kit's charts expect. */
const toRows = (rows: Array<Record<string, unknown>> | undefined): Row[] =>
  (rows ?? []).map((r) => ({ ...(r as Row), day: isoDay(Number(r.t)) }));

export const loadToken = cache(async (): Promise<TokenPage> => {
  const t = await getFluidToken();

  return {
    asOf: isoDay(t.asOf || Math.floor(Date.now() / 1000)),
    stats: [
      { label: 'Price', value: t.price, unit: 'price', caption: 'FLUID' },
      { label: 'Market cap', value: t.marketCap, unit: 'usd', caption: 'Circulating' },
      { label: 'Revenue, 30d', value: t.revenue30d, unit: 'usd', caption: 'Protocol take, trailing thirty days' },
      {
        label: 'Take rate',
        // Null rather than zero when unknown: a 0% take rate is a different claim from "not known".
        value: t.takeRatePct,
        unit: 'pct',
        caption: 'Protocol revenue over gross fees',
      },
    ],
    priceHistory: (t.priceHistory ?? []).map((p) => ({ day: isoDay(p.t), price: p.v })),
    feesVsRevenue: (t.feesVsRevenue ?? []).map((p) => ({ day: isoDay(p.t), fees: p.fees, revenue: p.revenue })),
    buybackCumulative: (t.buybackCumulative ?? []).map((p) => ({ day: isoDay(p.t), cumulative: p.v })),
    revenueByChain: {
      series: (t.revenueByChain?.series ?? []).map((s) => ({ key: s.key, label: s.label })),
      rows: toRows(t.revenueByChain?.rows as Array<Record<string, unknown>> | undefined),
    },
    revenueBySource: {
      series: (t.revenueBySource?.series ?? []).map((s) => ({ key: s.key, label: s.label })),
      rows: toRows(t.revenueBySource?.rows as Array<Record<string, unknown>> | undefined),
    },
    takeRatePct: t.takeRatePct,
    psRatio: t.psRatio,
    sourceSplit: t.sourceSplit ?? null,
  };
});
