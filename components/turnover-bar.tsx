'use client';

/**
 * Turnover bars with an "x" suffix.
 *
 * The kit's charts are client components, so a `format` function cannot be passed to them from a
 * server page: React cannot serialise a function across that boundary. Any chart needing a custom
 * formatter therefore needs a thin client wrapper like this one, which owns the function locally.
 *
 * Two series rather than one because BarChart colours per series, so this is how a single bar gets
 * the brand accent while its peers stay muted.
 */

import { BarChart } from '@/components/charts';
import type { Row } from '@/components/charts';

const SERIES = [
  { key: 'fluid', label: 'Fluid', color: 'var(--brand-blue)' },
  { key: 'peer', label: 'Peers', color: 'var(--neutral-400)' },
];

export function TurnoverBar({ data, height = 300 }: { data: Row[]; height?: number }) {
  return (
    <BarChart
      data={data}
      x="name"
      series={SERIES}
      stacked
      horizontal
      unit="count"
      height={height}
      format={(v) => `${Number(v).toFixed(2)}x`}
    />
  );
}
