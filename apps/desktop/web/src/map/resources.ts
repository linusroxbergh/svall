import { theme } from '../theme.js';

// the islet's land: five cells by two and a half, 80px of it above the bottom edge, the tower's footing 36px up that,
// a cell of water from home, a margin from the map's side
export const ISLET = { w: 5 * theme.cell, h: 2.5 * theme.cell, visible: 80, foot: 36, gap: theme.cell, margin: 26 };

// what a map too narrow for the pair gives up first: the water between the two, then the side margins
const TIGHT = { gap: 6, margin: 8 };
// then the islet itself, down to this much of its size; under that the lighthouse reads too small
const MIN_SCALE = 0.65;
// and last mission control, down to this much of its size
const MIN_HOME_SCALE = 0.5;

export type Placement = { mode: 'pair' | 'pill'; homeShift: number; cx: number; scale: number; homeScale: number };

/** Home and the islet are centred as one group; a map too narrow for both squeezes the water between them,
 *  then the islet, then home, which shrinks towards its bottom centre, so the lighthouse keeps its place beside
 *  mission control. Folded, home has no land to stand it beside, so the islet is only its pill. `most` caps home at
 *  the scale the map draws island cards at, and the islet shrinks with it. */
export function placeIslet(hostW: number, homeW: number, collapsed: boolean, most = 1): Placement {
  if (collapsed) return { mode: 'pill', homeShift: 0, cx: hostW / 2, scale: 1, homeScale: 1 };
  const spare = (gap: number, margin: number) => hostW - 2 * margin - homeW - gap;
  let { gap, margin } = ISLET, scale = 1, homeScale = 1;
  if (spare(gap, margin) < ISLET.w) {
    ({ gap, margin } = TIGHT);
    scale = Math.max(MIN_SCALE, Math.min(1, spare(gap, margin) / ISLET.w));
    homeScale = Math.max(MIN_HOME_SCALE, Math.min(1, (hostW - 2 * margin - gap - MIN_SCALE * ISLET.w) / homeW));
  }
  homeScale = Math.min(homeScale, most);
  scale = Math.max(MIN_SCALE, Math.min(scale, homeScale));
  const hw = homeW * homeScale, w = ISLET.w * scale;
  const right = Math.min((hostW + hw + gap + w) / 2, hostW - margin);
  // a map narrower than home at its smallest has no room to give: home holds its place and the islet stands at the edge
  const homeShift = hw + gap + w > hostW ? 0 : right - w - gap - hw / 2 - hostW / 2;
  return { mode: 'pair', homeShift, cx: right - w / 2, scale, homeScale };
}
