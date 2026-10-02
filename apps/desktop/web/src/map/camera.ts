import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { app } from '../boot.js';
import { useApp } from '../hooks.js';
import { homeIsland, mapIslands } from '../selectors.js';
import { theme } from '../theme.js';
import { fitWithHome, homeBlocks, homeReserve } from './home.js';
import { DBL_CLICK_MS } from './interactions.js';
import { cellSize, clampPan, crewOf, landSpan, limitAt, worldBounds, type Below, type Layout } from './layout.js';
import { placeIslet } from './resources.js';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// where a released grip was, on screen and in the world, for the refit to keep it still
export type Anchor = { screen: { x: number; y: number }; world: { x: number; y: number } };

export type Camera = ReturnType<typeof useCamera>;

/** The map's view of the world: the fitted layout eased towards each new fit, the pan, and the hold a drag keeps it still with. */
export function useCamera(host: RefObject<HTMLDivElement | null>, lastPressAt: RefObject<number>) {
  const sideCardOpen = useApp((s) => s.sideCardOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const hasHome = useApp((s) => Boolean(homeIsland(s.fleet)));
  const [layout, setLayout] = useState<Layout>({ scale: 1, tile: theme.cell, ox: 0, oy: 0 });
  const hold = useRef(false);
  const pan = useRef({ x: 0, y: 0 });
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  // mission control's row wraps to as many lines as it needs; the shelf's bottom edge follows its real height
  const [rowH, setRowH] = useState(theme.home.row);
  const row = useRef({ w: 0, h: theme.home.row });
  // the cap mission control is drawn at, eased with the layout towards the one its fit reserved room for
  const homeMost = useRef(1);
  const hostSizeRef = useRef(hostSize);
  hostSizeRef.current = hostSize;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const target = useRef<Layout & { most: number }>(undefined);
  const anim = useRef<number>(undefined);
  const holdUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refits = useRef(0);
  useEffect(() => () => { cancelAnimationFrame(anim.current ?? 0); clearTimeout(holdTimer.current); }, []);

  // the map under the room kept over mission control, and what mission control stands in it with
  const belowOf = (el: HTMLElement): Below | undefined => {
    const hi = homeIsland(app.store.getState().fleet);
    const host = { w: el.clientWidth, h: el.clientHeight };
    return hi && { h: host.h, blocks: homeBlocks(hi, host, row.current, homeMost.current), row: hi.position.y };
  };
  // the map height mission control keeps at its full size on a map this wide, its row as tall as it has wrapped to:
  // arrange shapes the fleet for it, and the fit shares out whatever a smaller home leaves
  const reserveAt = (w: number): number => {
    const hi = homeIsland(app.store.getState().fleet);
    return homeReserve(Boolean(hi?.collapsed), row.current.h, hi ? placeIslet(w, hi.size.w * theme.cell, Boolean(hi.collapsed)).homeScale : 1);
  };
  const refit = (immediate?: boolean, anchor?: Anchor) => {
    if (hold.current && !immediate) return;
    const el = host.current;
    if (!el) return;
    // the world stands still under an open click sequence: every caller waits out the hold, then refits once
    const wait = holdUntil.current - performance.now();
    if (wait > 0) { clearTimeout(holdTimer.current); holdTimer.current = setTimeout(() => refit(immediate), wait); return; }
    const f = app.store.getState().fleet;
    const islands = mapIslands(f), crew = crewOf(f);
    const { fit, win, room, most } = fitWithHome(islands, crew, { w: el.clientWidth, h: el.clientHeight }, homeIsland(f), row.current);
    let next: Layout;
    if (anchor) {
      // Keep the released grip still while zooming, as far as the fitted world can remain in view.
      const b = worldBounds(islands, crew, fit.scale), s = fit.scale;
      const axis = (wanted: number, start: number, length: number, size: number, near: number, far: number, fallback: number) => {
        const lo = size - far - (start + length) * s, hi = near - start * s;
        if (lo <= hi) return Math.max(lo, Math.min(hi, wanted));
        // At the minimum zoom a large fleet may still exceed the room; retain the release anchor
        // while keeping at least the map's normal panning margin in reach.
        const panLo = size - theme.panMargin - (start + length) * s;
        const panHi = theme.panMargin - start * s;
        return panLo <= panHi ? Math.max(panLo, Math.min(panHi, wanted)) : fallback;
      };
      // a world resting on mission control is held down by it, so only the room over it leaves the anchor a say in y
      next = { ...fit,
        ox: axis(anchor.screen.x - anchor.world.x * fit.scale, b.x * theme.cell, b.w * theme.cell, win.w, theme.fit.x, theme.fit.x, fit.ox),
        oy: room.h === win.h ? axis(anchor.screen.y - anchor.world.y * fit.scale, b.y * theme.cell, b.h * theme.cell, win.h, theme.fit.top, theme.fit.bottom, fit.oy) : fit.oy };
      pan.current = { x: next.ox - fit.ox, y: next.oy - fit.oy };
    } else {
      pan.current = clampPan(islands, fit, room, pan.current, crew);
      next = { ...fit, ox: fit.ox + pan.current.x, oy: fit.oy + pan.current.y };
    }
    const cur = layoutRef.current;
    if (target.current && target.current.scale === next.scale && target.current.ox === next.ox && target.current.oy === next.oy && target.current.most === most) return;
    target.current = { ...next, most };
    refits.current += 1;
    cancelAnimationFrame(anim.current ?? 0);
    // the side card and a pan resize the map instantly; jump the layout with them rather than easing across a moving target
    if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { homeMost.current = most; setLayout(next); return; }
    const from = { ...cur }, fromMost = homeMost.current, start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / theme.fitEaseMs);
      const e = 1 - (1 - t) * (1 - t);
      homeMost.current = t >= 1 ? most : lerp(fromMost, most, e);
      setLayout(t >= 1 ? next : { tile: next.tile, scale: lerp(from.scale, next.scale, e), ox: lerp(from.ox, next.ox, e), oy: lerp(from.oy, next.oy, e) });
      if (t < 1) anim.current = requestAnimationFrame(step);
      else anim.current = undefined;
    };
    step();
  };
  // A second gesture may start while the last fit is still moving. Freeze the camera at the press.
  const freeze = () => {
    cancelAnimationFrame(anim.current ?? 0); anim.current = undefined; target.current = undefined;
    hold.current = true;
  };
  const islandInView = (id: string): boolean => {
    const island = app.store.getState().fleet.islands[id], el = host.current;
    if (!island || !el) return false;
    const l = layoutRef.current, s = cellSize(l);
    const x = l.ox + island.position.x * s, y = l.oy + island.position.y * s;
    const below = belowOf(el);
    const h = below ? limitAt(below, ...landSpan(island, l)) : el.clientHeight - homeReserve(false);
    // A release only moves the camera when the land or label would be clipped. The larger fit
    // bounds include spare card room; using them here needlessly recentres ordinary moves.
    return x >= 8 && x + island.size.w * s <= el.clientWidth - 8 &&
      y - theme.bounds.top * s >= 8 && y + island.size.h * s <= h - 8;
  };

  const panTo = (p: { x: number; y: number }) => { holdUntil.current = 0; pan.current = p; refit(true); };
  const onWheel = (e: React.WheelEvent) => panTo({ x: pan.current.x - e.deltaX, y: pan.current.y - e.deltaY });
  // measured before any fit that could read it, and fitted again whenever the row changes size
  useLayoutEffect(() => {
    const el = host.current?.querySelector<HTMLElement>('.hrow');
    if (!el) return;
    // the row wraps to the map's width, so a size read before the map has one means nothing
    const read = () => {
      if (!hostSizeRef.current.w) return false;
      setRowH(el.offsetHeight);
      if (el.offsetWidth === row.current.w && el.offsetHeight === row.current.h) return false;
      row.current = { w: el.offsetWidth, h: el.offsetHeight };
      return true;
    };
    if (read()) refit();
    const ro = new ResizeObserver(() => { if (read()) refit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasHome]);

  // the side panels change the map's width immediately; refit before paint so no stale layout is ever visible,
  // holding the refit until an open click sequence ends
  useLayoutEffect(() => {
    const open = performance.now() - lastPressAt.current < DBL_CLICK_MS;
    holdUntil.current = open ? lastPressAt.current + DBL_CLICK_MS : 0;
    refit(true);
  }, [sideCardOpen, sidebarOpen, settingsOpen]);

  // before paint, so the row wraps to the map's real width from the first frame
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setHostSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => { setHostSize({ w: el.clientWidth, h: el.clientHeight }); refit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { layout, layoutRef, hold, pan, rowH, homeMost, hostSize, hostSizeRef, refits, refit, freeze, panTo, onWheel, belowOf, reserveAt, islandInView };
}
