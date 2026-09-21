// The only file most dashboards need to edit. Name the product, the platform resources the pages
// read, how their columns map onto the normalised shapes in lib/types.ts, and the navigation.
// lib/data.ts and the components do the rest. Without DATUM_API_KEY the pages run on labelled sample data.

// `datum new dashboard` fills the {{placeholders}}. Until then the template runs as the reference
// dashboard under these fallbacks, so it can be opened and judged as is.
const ph = (v: string, fallback: string) => (v.startsWith('{{') && v.endsWith('}}') ? fallback : v);

export const config = {
  // 'draft' until `datum check <slug>` prints READY and the owner signs the brief; the page says so.
  status: 'live' as 'draft' | 'live',
  // Where this dashboard's numbers come from, so the frame's provenance copy tells the truth.
  //   'platform'  — datum-api, falling back to labelled sample data when no key is set. The default.
  //   'dashboard' — the dashboard's own loaders, for a product the platform does not carry yet.
  //                 Real numbers, so the frame must not call them sample, and the footer names the
  //                 entries in `sources` below instead of claiming datum-api.
  dataSource: 'dashboard' as 'platform' | 'dashboard',
  slug: ph('fluid-dashboard-next', 'reference-dashboard'),
  title: ph('Fluid Research Terminal', 'State of lending'),
  description: ph('Fluid lending and DEX liquidity, built by Datum Labs.', 'The reference dashboard for Datum Labs: the standard look and structure, running on labelled sample data until a platform key is set.'),
  // The question the overview answers. Pages lead with it.
  question: 'Is Fluid still the venue that makes each dollar work hardest?',
  // The product the markets belong to, as shown on the page and used for its logo.
  product: { slug: 'fluid', label: 'Fluid', defillamaSlug: 'fluid' },
  // Resources are product/name pairs from GET /api/v1/products on datum-api. `filters` must be
  // filters that resource declares (see /api/v1/products); anything else is ignored by the API.
  resources: {
    // One row per chain, market and UTC day. Latest day by default; `day=` or `since=` for history.
    markets: { product: 'morpho', name: 'markets', filters: { listed: 'true' } as Record<string, string> },
    // The positions sample (largest suppliers and borrowers per market, twice a day) and its health bands.
    // When the platform does not serve them yet, the market page hides those two cards.
    positions: { product: 'morpho', name: 'positions' },
    health: { product: 'morpho', name: 'health' },
    // DefiLlama's own figure for the same protocol, stored beside ours for the reconciliation note.
    comparison: { product: 'defillama', name: 'tvl', filters: { slug: 'morpho-blue' } as Record<string, string> },
  },
  // Column names in the markets resource for each normalised field (lib/types.ts Market), and
  // which of them the resource stores as fractions (0.86) rather than percent (86).
  fields: {
    id: 'market_id', chain: 'chain_id', collateral: 'collateral_symbol', loan: 'loan_symbol',
    supplied: 'supply_assets_usd', borrowed: 'borrow_assets_usd', utilization: 'utilization', supply_apy: 'supply_apy', borrow_apy: 'borrow_apy', lltv: 'lltv', day: 'day',
    // extra columns shown on the market page when present
    liquidity: 'liquidity_assets_usd', collateralValue: 'collateral_assets_usd', badDebt: 'bad_debt_usd', fee: 'fee_pct', address: 'market_id',
  },
  fractions: ['lltv'] as string[],
  // How far back the overview trend goes, and how often it samples our own count (one API call
  // per point, so weekly points keep it to about a dozen calls).
  trend: { days: 90, stepDays: 7 },
  // The sign-in gate: the overview is open to everyone; every other page asks once for a name, an email
  // and an occupation (kept on that browser). Leads join the Datum Labs list through app/api/gate.
  gate: { enabled: true, free: ['/'] as string[] },
  nav: [
    { href: '/', label: 'Overview' },
    { href: '/markets', label: 'Markets' },
    { href: '/lending', label: 'Lending' },
    { href: '/dex', label: 'Fluid DEX' },
    { href: '/token', label: '$FLUID' },
    { href: '/methodology', label: 'Methodology' },
  ],
  // Shown on the methodology page. Keep them honest: what is read, how often, what it excludes.
  // role: 'headline' is our own count; 'comparison' is stored beside it and never the headline.
  sources: [
    { name: 'DefiLlama', role: 'headline' as 'headline' | 'comparison', cadence: 'daily', detail: 'Per-chain deposits and borrows, the token mix, and the DEX pool book through the yields endpoints.' },
    { name: 'Fluid quarterly reports', role: 'comparison' as 'headline' | 'comparison', cadence: 'quarterly', detail: 'DEX volume here reconciles exactly to the figures Fluid publishes itself, which is why the series is not re-derived.' },
  ],
  definitions: [
    { term: 'Supplied', unit: 'USD', text: 'Gross deposits across every chain Fluid is live on, before netting borrowed balances.' },
    { term: 'Borrowed', unit: 'USD', text: 'Outstanding debt across the same set.' },
    { term: 'Asset', unit: 'symbol', text: 'Rows are assets, not pairs. Fluid exposes supplied and borrowed per token per chain rather than per market, so each row aggregates one asset across every chain.' },
    { term: 'Turnover', unit: 'ratio', text: 'DEX volume per dollar of liquidity. The measure Fluid is built to win on.' },
    { term: 'LLTV', unit: '%', text: 'Fluid LTVs are set per vault type, so an asset-level aggregate has no single value and reads n/a.' },
  ],
};
export type DatumConfig = typeof config;
