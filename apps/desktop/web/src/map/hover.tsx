import { useEffect, useRef, useState } from 'react';
import type { Robot, Island } from '@svall/protocol';
import { isPlaced } from '../placement.js';
import { theme, tokenPx } from '../theme.js';
import { homeBox, homeCellToScreen } from './home.js';
import { HoverCard } from './HoverCard.js';
import { cellSize, sharedCardScale, worldCell, worldToScreen, type Layout } from './layout.js';
import type { Placement } from './resources.js';

// how far a hovered card rises, matching `.tok:hover .card` in map.css
const HOVER_LIFT = 6;

/** The robot whose hover card shows, after a moment over its token, and the island hot under the pointer. */
export function useHover() {
  const [hover, setHover] = useState<string>();
  const [hotIsland, setHotIsland] = useState<string>();
  const hotRef = useRef<string>(undefined);
  hotRef.current = hotIsland;
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hotTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // an island is hot under the pointer (footprint plus its coast) and stays hot for a grace period, so the pointer can cross water to its label or grip
  const holdIsland = (id: string) => { clearTimeout(hotTimer.current); setHotIsland(id); };
  const releaseIsland = (id: string) => {
    clearTimeout(hotTimer.current);
    hotTimer.current = setTimeout(() => setHotIsland((h) => (h === id ? undefined : h)), theme.islandHotGraceMs);
  };
  useEffect(() => () => { clearTimeout(hotTimer.current); clearTimeout(hoverTimer.current); }, []);

  const start = (id: string) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(id), theme.hoverDelayMs);
  };
  const end = () => { clearTimeout(hoverTimer.current); setHover(undefined); };
  return { hover, hotIsland, hotRef, holdIsland, releaseIsland, start, end };
}

export function HoverLayer({ c, island, layout, place, host }: { c: Robot; island: Island; layout: Layout; place: Placement; host: { w: number; h: number } }) {
  if (island.collapsed) return null;
  const onHome = island.kind === 'home';
  const box = onHome ? homeBox(island, host, place.homeShift, place.homeScale) : undefined;
  const size = box ? box.cell : cellSize(layout);
  const p = box ? homeCellToScreen(box, c.cell) : worldToScreen(layout, worldCell(island.position, c.cell));
  const w = theme.hoverCardWidth;
  const cx = p.x + size / 2;
  // a token is drawn at the cards' scale, hover lift and all
  const k = sharedCardScale(layout.scale, place.homeScale);
  // the token's top edge on screen, over the band a robot on a worker wears above its card
  const band = isPlaced(c) ? theme.token.band * theme.token.unit : 0;
  const top = p.y + size / 2 - (tokenPx.h * 0.48 + band + HOVER_LIFT) * k;
  const bottom = p.y + size / 2 + (tokenPx.h * 0.52 - HOVER_LIFT) * k;
  const flip = top < 12 + theme.hoverCardMaxH;
  return (
    <HoverCard c={c} flip={flip}
      x={Math.max(14, Math.min(host.w - w - 14, cx - w / 2))}
      y={flip ? bottom + 12 : top - 12} />
  );
}
