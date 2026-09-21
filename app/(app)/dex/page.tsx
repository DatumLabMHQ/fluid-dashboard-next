// Fluid DEX. Ported from fluid-dashboard/app/dex, rebuilt on the kit's chart components.
//
// Behind the sign-in gate (datum.config.ts `gate.free` lists only '/'), so this is where the
// detail lives. The overview stays open and deliberately thin.
import type { Metadata } from 'next';
import { AreaChart, BarChart, DonutChart } from '@/components/charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { TurnoverBar } from '@/components/turnover-bar';
import { loadDex } from '@/lib/fluid-dex-page';
import { count, pct, usd } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fluid DEX',
  description:
    'Capital efficiency against peer DEXs, stablecoin volume share, fees, and the asset-issuer franchise.',
};

const FLUID_SERIES = [
  { key: 'fluid', label: 'Fluid', color: 'var(--brand-blue)' },
  { key: 'peer', label: 'Peers', color: 'var(--neutral-400)' },
];

/** A chart in a card, matching the kit's panel anatomy: title and caption in the header. */
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

function Stats({ stats }: { stats: Awaited<ReturnType<typeof loadDex>>['stats'] }) {
  const show = (v: number, unit: string) =>
    unit === 'usd' ? usd(v) : unit === 'pct' ? pct(v, 1) : unit === 'count' ? count(v) : `${v.toFixed(1)}x`;
  return (
    <div className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:grid-cols-4 lg:px-6">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardHeader>
            <CardDescription>{s.label}</CardDescription>
            <CardTitle className="font-heading text-2xl font-medium tabular-nums">{show(s.value, s.unit)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{s.caption}</CardContent>
        </Card>
      ))}
    </div>
  );
}

export default async function DexPage() {
  const d = await loadDex();
  // Stated from the data, not asserted. Fluid does not always lead this measure.
  const r = d.turnoverRank;
  const lead = r
    ? r.rank === 1
      ? `Fluid recycles $${r.fluidPerDollar.toFixed(2)} of volume per $1 of liquidity a day, the highest of the ${r.of} venues on Ethereum.`
      : `Fluid recycles $${r.fluidPerDollar.toFixed(2)} of volume per $1 of liquidity a day, ${r.rank}${r.rank === 2 ? 'nd' : r.rank === 3 ? 'rd' : 'th'} of ${r.of} venues on Ethereum, behind ${r.leader}.`
    : 'Fluid routes large stablecoin volume through comparatively small liquidity.';

  return (
    <>
      <PageHeader
        eyebrow="Fluid DEX"
        question="Does Fluid make each dollar of liquidity work harder?"
        answer={
          <>
            {lead} It handles {pct(d.fluidStablecoinPct, 0)} of Ethereum stable-pair DEX volume, as of {d.asOf}.
          </>
        }
      />

      <Stats stats={d.stats} />

      <div className="px-4 lg:px-6">
        <Panel
          title="Capital efficiency: daily volume per $1 of liquidity"
          caption={
            <>
              <b className="font-medium text-foreground">The measure Fluid is built to win.</b> Seven-day volume
              divided by seven, over TVL: how many times a venue recycles its liquidity each day. Ethereum only,
              so the comparison is like for like.
            </>
          }
          footnote={
            d.vsUniswap
              ? `Window- and scope-sensitive: this is a 7d window on Ethereum. Fluid sits at ${d.vsUniswap.toFixed(2)}x Uniswap v3${d.vsCurve ? ` and ${d.vsCurve.toFixed(2)}x Curve` : ''} on this measure.`
              : 'Window- and scope-sensitive: this is a 7d window on Ethereum.'
          }
        >
          <TurnoverBar data={d.turnover} height={300} />
        </Panel>
      </div>

      <div className="px-4 lg:px-6">
        <Panel
          title="Stablecoin-pair DEX volume by venue, Ethereum"
          caption={
            <>
              Seven-day volume on stable/stable pairs by venue, top venues plus Other. Pools turning over more
              than 30x their liquidity in a week are excluded as a wash-trading signature; Fluid&rsquo;s real pools
              run around 14x, so it is never filtered.
            </>
          }
          footnote={`Fluid handles ${pct(d.fluidStablecoinPct, 0)} of Ethereum stablecoin-pair DEX volume. Seven-day window, so week-to-week variation is expected.`}
        >
          <BarChart data={d.stablecoinShare} x="name" series={FLUID_SERIES} stacked horizontal unit="usd" height={300} />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="DEX volume by quarter"
          caption="Total volume per completed calendar quarter, the framing Fluid's own reports use. The quarter in progress is excluded so the bars compare."
          footnote={
            d.volumeQoQ.qoqPct != null
              ? `${d.volumeQoQ.latestLabel} volume ${usd(d.volumeQoQ.latestVol)}, ${d.volumeQoQ.qoqPct >= 0 ? '+' : ''}${d.volumeQoQ.qoqPct.toFixed(0)}% against ${d.volumeQoQ.prevLabel}.`
              : 'Completed quarters only.'
          }
        >
          <BarChart data={d.volumeByQuarter} x="name" series={[{ key: 'volume', label: 'Volume' }]} unit="usd" height={260} />
        </Panel>

        <Panel
          title="Volume by pair"
          caption="Seven-day volume by trading pair, largest eight plus Other. Concentration here is the flip side of capital efficiency: a few pairs carry most of the flow."
        >
          <DonutChart items={d.volumeByPair} unit="usd" height={240} centerLabel="7d volume" />
        </Panel>
      </div>

      <div className="px-4 lg:px-6">
        <Panel
          title="DEX volume by chain"
          caption="Daily volume split by chain. Fluid's DEX started on Ethereum; the mix shows how much has moved elsewhere."
        >
          <AreaChart data={d.byChain.rows} x="day" series={d.byChain.series} stacked unit="usd" height={300} legend />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="DEX fees over time"
          caption="Daily fees earned by liquidity providers. Fees follow volume, so this is the revenue side of the efficiency story."
        >
          <AreaChart data={d.feesDaily} x="day" series={[{ key: 'fees', label: 'Fees' }]} unit="usd" height={260} />
        </Panel>

        <Panel
          title="Fee rate, fees over volume"
          caption="What each dollar of volume earns. A falling rate with rising volume means competition on price; a rising rate means pricing power."
        >
          <AreaChart data={d.feeRateDaily} x="day" series={[{ key: 'rate', label: 'Fee rate' }]} unit="pct" height={260} />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Fee yield by pool"
          caption="Annualised fee APY for the twelve best-earning pools, before rewards. What a liquidity provider actually takes home."
        >
          <BarChart data={d.feeYields} x="name" series={[{ key: 'feeApy', label: 'Fee APY' }]} horizontal unit="pct" height={320} categoryWidth={120} />
        </Panel>

        <Panel
          title="Volume and liquidity by asset class"
          caption="Where the flow sits. Stablecoins dominate volume while holding comparatively little liquidity, which is the efficiency claim in one chart."
        >
          <BarChart
            data={d.byAssetClass}
            x="name"
            series={[
              { key: 'volume', label: '7d volume' },
              { key: 'tvl', label: 'TVL' },
            ]}
            unit="usd"
            height={280}
            legend
          />
        </Panel>
      </div>

      {d.issuerDeposits.length ? (
        <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
          <Panel
            title="Asset-issuer deposits on Fluid"
            caption={`Issuers who use Fluid as their liquidity home, by deposits. ${usd(d.issuerTotalDepositsUsd)} in total.`}
          >
            <BarChart data={d.issuerDeposits} x="name" series={[{ key: 'value', label: 'Deposits' }]} horizontal unit="usd" height={280} categoryWidth={120} />
          </Panel>

          <Panel
            title="Fluid's share of each issuer's DEX volume"
            caption="How much of an issuer's on-chain trading runs through Fluid. High shares are the franchise: the issuer's liquidity lives here."
          >
            <BarChart data={d.issuerDexShare} x="name" series={[{ key: 'value', label: 'Fluid share' }]} horizontal unit="pct" height={280} categoryWidth={120} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}
