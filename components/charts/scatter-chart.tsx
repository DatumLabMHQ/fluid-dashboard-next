'use client';
/* ScatterChart: relate two measures across many items, to find the outliers.
   USE FOR   size against efficiency (pool TVL vs turnover), risk against return, supply against
             utilisation; `xLog` when the x values span orders of magnitude, which is usual for
             anything measured in dollars; `highlight` to mark our own points among peers.
   NOT FOR   one value per category (use BarChart); anything over time (use AreaChart or
             LineChart); fewer than about eight points, where a table reads better.
   SHAPE     points: [{ name, x, y, z? }]. `z` sizes the dot when present. */
import * as React from 'react';
import * as R from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { Unit } from '@/lib/format';
import { byUnit } from '@/lib/format';

export type ScatterPoint = { name: string; x: number; y: number; z?: number };

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  xUnit = 'usd',
  yUnit = 'count',
  xLog = false,
  height = 280,
  highlight,
  xFormat,
  yFormat,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xUnit?: Unit;
  yUnit?: Unit;
  /** Log x axis. Dollar spreads are usually orders of magnitude, so a linear axis hides the tail. */
  xLog?: boolean;
  height?: number;
  /** Names drawn in the brand colour; everything else is muted. */
  highlight?: string[];
  xFormat?: (v: unknown) => string;
  yFormat?: (v: unknown) => string;
}) {
  const fx = xFormat ?? byUnit[xUnit];
  const fy = yFormat ?? byUnit[yUnit];
  const marked = new Set(highlight ?? []);
  const config: ChartConfig = { x: { label: xLabel }, y: { label: yLabel } };

  // A log axis cannot plot zero, and Recharts needs an explicit domain for one.
  const xs = points.map((p) => p.x).filter((v) => v > 0);
  const domain: [number | string, number | string] = xLog
    ? [Math.max(1, Math.min(...xs) * 0.8), Math.max(...xs) * 1.2]
    : ['auto', 'auto'];
  const plotted = xLog ? points.filter((p) => p.x > 0) : points;

  const zs = plotted.map((p) => p.z ?? 0);
  const zMax = Math.max(1, ...zs);

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <R.ScatterChart margin={{ left: 4, right: 16, top: 12, bottom: 20 }} accessibilityLayer>
        <R.CartesianGrid />
        <R.XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          scale={xLog ? 'log' : 'linear'}
          domain={domain}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickCount={5}
          tickFormatter={(v: number) => fx(v)}
          label={{ value: xLabel, position: 'insideBottom', offset: -12, fontSize: 11, className: 'fill-muted-foreground' }}
        />
        <R.YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickCount={4}
          width={56}
          tickFormatter={(v: number) => fy(v)}
        />
        {plotted.some((p) => p.z !== undefined) ? <R.ZAxis type="number" dataKey="z" range={[40, 400]} domain={[0, zMax]} /> : null}
        <ChartTooltip
          cursor={{ strokeDasharray: '3 3' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as ScatterPoint;
            return (
              <div className="border-border/50 bg-background grid min-w-[10rem] gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
                <div className="font-medium">{p.name}</div>
                <div className="flex justify-between gap-4 text-muted-foreground">
                  <span>{xLabel}</span>
                  <span className="text-foreground font-mono tabular-nums">{fx(p.x)}</span>
                </div>
                <div className="flex justify-between gap-4 text-muted-foreground">
                  <span>{yLabel}</span>
                  <span className="text-foreground font-mono tabular-nums">{fy(p.y)}</span>
                </div>
              </div>
            );
          }}
        />
        <R.Scatter data={plotted} isAnimationActive={false}>
          {plotted.map((p) => (
            <R.Cell
              key={p.name}
              fill={marked.has(p.name) ? 'var(--brand-blue)' : 'var(--chart-8)'}
              fillOpacity={marked.has(p.name) ? 0.95 : 0.55}
            />
          ))}
        </R.Scatter>
      </R.ScatterChart>
    </ChartContainer>
  );
}
