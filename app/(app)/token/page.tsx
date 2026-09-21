// $FLUID. Ported from fluid-dashboard/app/token, rebuilt on the kit's charts.
// Behind the sign-in gate, like every page but the overview.
import type { Metadata } from 'next';
import { AreaChart, LineChart } from '@/components/charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { loadToken } from '@/lib/fluid-token-page';
import { pct, price, usd } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '$FLUID',
  description: "What the token earns: protocol revenue, the take rate against gross fees, and the buyback.",
};

function Panel({
  title,
  caption,
  children,
  footnote,
}: {
  title: string;
  caption: React.ReactNode;
  children: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{caption}</CardDescription>
      </CardHeader>
      <CardContent>
        {children}
        {footnote ? <p className="mt-3 text-xs text-muted-foreground">{footnote}</p> : null}
      </CardContent>
    </Card>
  );
}

export default async function TokenPage() {
  const d = await loadToken();
  const show = (v: number | null, unit: string) =>
    v === null ? 'n/a' : unit === 'usd' ? usd(v) : unit === 'price' ? price(v, 4) : pct(v, 1);

  return (
    <>
      <PageHeader
        eyebrow="$FLUID"
        question="What does the token actually earn?"
        answer={
          <>
            {d.takeRatePct !== null ? (
              <>The protocol keeps {pct(d.takeRatePct, 1)} of gross fees as revenue</>
            ) : (
              <>Protocol revenue against gross fees</>
            )}
            {d.psRatio ? <>, and trades at {d.psRatio.toFixed(1)}x annualised revenue</> : null}, as of {d.asOf}.
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:grid-cols-4 lg:px-6">
        {d.stats.map((s) => (
          <Card key={s.label}>
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="font-heading text-2xl font-medium tabular-nums">{show(s.value, s.unit)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.caption}</CardContent>
          </Card>
        ))}
      </div>

      <div className="px-4 lg:px-6">
        <Panel
          title="Gross fees against protocol revenue"
          caption="What users pay, and what the protocol keeps. The gap is what goes to liquidity providers, so the two lines together are the take rate over time."
          footnote={d.takeRatePct !== null ? `Current take rate ${pct(d.takeRatePct, 1)} of gross fees.` : undefined}
        >
          <AreaChart
            data={d.feesVsRevenue}
            x="day"
            series={[
              { key: 'fees', label: 'Gross fees' },
              { key: 'revenue', label: 'Protocol revenue' },
            ]}
            unit="usd"
            height={300}
            legend
          />
        </Panel>
      </div>

      {d.revenueBySource.series.length ? (
        <div className="px-4 lg:px-6">
          <Panel
            title="Revenue by source"
            caption="Fluid's own markets against the Jupiter Lend white-label. DefiLlama files Jupiter Lend as a separate protocol, so reading the fluid slug alone understates the ecosystem and hides the take-rate difference between the two."
          >
            <AreaChart data={d.revenueBySource.rows} x="day" series={d.revenueBySource.series} stacked unit="usd" height={280} legend />
          </Panel>
        </div>
      ) : null}

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Revenue by chain"
          caption="Where the revenue is earned. Concentration here is the counterweight to a multichain deposit base: deposits can spread while earnings do not."
        >
          <AreaChart data={d.revenueByChain.rows} x="day" series={d.revenueByChain.series} stacked unit="usd" height={260} legend />
        </Panel>

        <Panel
          title="Cumulative buyback spend"
          caption="Ethereum revenue accumulated since buybacks began, as a proxy for spend. A running total, so it only goes up; the slope is what matters."
        >
          <AreaChart data={d.buybackCumulative} x="day" series={[{ key: 'cumulative', label: 'Cumulative' }]} unit="usd" height={260} />
        </Panel>
      </div>

      <div className="px-4 lg:px-6">
        <Panel
          title="FLUID price"
          caption="Price alone says little about a protocol, which is why it sits last here rather than first. Read it against the revenue above."
        >
          <LineChart data={d.priceHistory} x="day" series={[{ key: 'price', label: 'Price' }]} unit="usd" height={260} zero={false} />
        </Panel>
      </div>
    </>
  );
}
