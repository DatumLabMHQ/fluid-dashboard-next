// What the kit's frame reads from this dashboard (lib/platform.ts FrameData), plus the loaders
// the pages use. The Fluid shapes and loaders live in lib/fluid.ts, which explains why this
// dashboard reads Fluid's own data layer rather than the platform.
import type { FrameData } from './platform';
import { loadOverview } from './fluid';
export { platformStatus, showKit } from './platform';
export { loadOverview, loadMarket } from './fluid';

/** Assets, for the cmd+k palette. */
export const searchItems: FrameData['searchItems'] = async () => {
  const o = await loadOverview();
  return o.markets.map((m) => ({ label: m.collateral, href: `/markets/${m.id}`, hint: m.chain }));
};

/** Counts next to the nav entries. */
export const navBadges: FrameData['navBadges'] = async () => {
  const o = await loadOverview();
  return { '/markets': o.markets.length };
};

/** Assets listed under Markets in the sidebar, largest first. */
export const navChildren: FrameData['navChildren'] = async () => {
  const o = await loadOverview();
  return { '/markets': o.markets.map((m) => ({ label: m.collateral, href: `/markets/${m.id}` })) };
};
