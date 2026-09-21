// Fluid lending. Ported from fluid-dashboard/app/lending, rebuilt on the kit's charts.
// Behind the sign-in gate, like every page but the overview.
import type { Metadata } from 'next';
import { AreaChart, BarChart } from '@/components/charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { loadLending } from '@/lib/fluid-lending-page';
import { pct, usd } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Lending',
  description: "Fluid's lending book by asset, its stablecoin market position, and how its rates compare.",
};

const PEER_SERIES = [
  { key: 'fluid', label: 'Fluid', color: 'var(--brand-blue)' },
  { key: 'peer', label: 'Peers', color: 'var(--neutral-400)' },
];

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

/** "2nd of 6" reads better than a bare number, and says nothing when the rank is unknown. */
function rankPhrase(rank: number | null, of: number): string | null {
  if (!rank || !of) return null;
  const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
  return `${rank}${suffix} of ${of}`;
}

export default async function LendingPage() {
  const d = await loadLending();
  const usdcSupply = d.supplyRates.find((r) => r.asset === 'USDC');
  const usdcRank = usdcSupply ? rankPhrase(usdcSupply.fluidRank, usdcSupply.of) : null;

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        question="Is Fluid paying enough to keep deposits?"
        answer={
          <>
            Fluid holds {pct(d.fluidStablecoinPct, 1)} of the stablecoin lending market across chains
            {usdcRank ? <>, and its USDC supply rate ranks {usdcRank} against its peers</> : null}, as of {d.asOf}.
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:grid-cols-4 lg:px-6">
        {d.stats.map((s) => (
          <Card key={s.label}>
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="font-heading text-2xl font-medium tabular-nums">
                {s.unit === 'usd' ? usd(s.value) : pct(s.value, 1)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.caption}</CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Deposits by asset"
          caption="The book by asset over time. What Fluid holds tells you who it is: a stablecoin venue, a staked-ETH venue, or something else."
        >
          <AreaChart data={d.deposits.rows} x="day" series={d.deposits.series} stacked unit="usd" height={300} legend />
        </Panel>

        <Panel
          title="Borrows by asset"
          caption="The other side of the same book. The gap against deposits is the idle liquidity that sets rates."
        >
          <AreaChart data={d.borrows.rows} x="day" series={d.borrows.series} stacked unit="usd" height={300} legend />
        </Panel>
      </div>

      <div className="px-4 lg:px-6">
        <Panel
          title="Stablecoin lending market share"
          caption="Stablecoin supply by venue across every chain these protocols run on. This is the market Fluid competes hardest for, because stablecoin deposits move to whoever pays most. Note the scope: the stablecoin chart on the DEX page is Ethereum-only and measures trading volume, not lending supply."
          footnote={`Fluid holds ${pct(d.fluidStablecoinPct, 1)} of stablecoin lending supply across chains.`}
        >
          <BarChart data={d.stablecoinShare} x="name" series={PEER_SERIES} stacked horizontal unit="usd" height={280} />
        </Panel>
      </div>

      {d.supplyRates.length ? (
        <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
          {d.supplyRates.map((b) => (
            <Panel
              key={`supply-${b.asset}`}
              title={`${b.asset} supply APY by venue`}
              caption="Base rate a depositor earns, rewards excluded, sorted best first. This is the competitive proof behind the rate story: depositors move to the yield."
              footnote={rankPhrase(b.fluidRank, b.of) ? `Fluid ranks ${rankPhrase(b.fluidRank, b.of)} on ${b.asset} supply.` : undefined}
            >
              <BarChart data={b.rows} x="name" series={PEER_SERIES} stacked horizontal unit="pct" height={240} />
            </Panel>
          ))}
        </div>
      ) : null}

      {d.borrowRates.length ? (
        <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
          {d.borrowRates.map((b) => (
            <Panel
              key={`borrow-${b.asset}`}
              title={`${b.asset} borrow APY by venue`}
              caption="Base rate a borrower pays, sorted cheapest first, which is the opposite of the supply chart. Cheap borrow alongside high supply is an efficient spread, not a subsidy."
              footnote={rankPhrase(b.fluidRank, b.of) ? `Fluid ranks ${rankPhrase(b.fluidRank, b.of)} on ${b.asset} borrow cost.` : undefined}
            >
              <BarChart data={b.rows} x="name" series={PEER_SERIES} stacked horizontal unit="pct" height={240} />
            </Panel>
          ))}
        </div>
      ) : null}

      {d.lite ? (
        <div className="px-4 lg:px-6">
          <Panel
            title="Fluid Lite"
            caption="The managed stETH vault, measured two ways. The dollar drawdown flatters or punishes depending on where ETH is; the unit drawdown strips price out and says whether capital actually left."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">TVL</p>
                <p className="font-heading text-xl font-medium tabular-nums">{usd(d.lite.tvlUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Drawdown in dollars</p>
                <p className="font-heading text-xl font-medium tabular-nums">{pct(d.lite.drawdownUsdPct, 1)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Drawdown in ETH</p>
                <p className="font-heading text-xl font-medium tabular-nums">{pct(d.lite.drawdownUnitsPct, 1)}</p>
              </div>
            </div>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
