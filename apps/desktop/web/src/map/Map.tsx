import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HOME_ISLAND, MIN_SIZE, type Cell } from '@svall/protocol';
import { arrangeIslands, moveCharacterToCell, moveIsland, newCharacterOn, newIsland, newIslandAround, resizeIsland, startHomeAction, toggleIsland } from '../actions.js';
import { app, deps } from '../boot.js';
import { commitFocused } from '../Field.js';
import { followLink } from '../LinkAsk.js';
import { useApp } from '../hooks.js';
import { characterMenu, islandMenu } from '../menus.js';
import { ResourcesLayer } from '../resources/Shelf.js';
import { charactersOf, homeIsland, mapIslandsSorted, statusOf } from '../selectors.js';
import { theme, tokenPx } from '../theme.js';
import { Toast } from '../Toast.js';
import { cardRect } from './card.js';
import { Wordmark } from './Furniture.js';
import { fitWithHome, homeBlocks, homeBox, homeCellToScreen, homeCrew, homeFull, homeReserve, homeSlotAt, inHomeBox } from './home.js';
import { Home } from './HomeIsland.js';
import { HoverCard } from './HoverCard.js';
import { DBL_CLICK_MS, createInteractions, type Intent } from './interactions.js';
import { Island } from './Island.js';
import { cardScale, cellSize, clampPan, crewOf, islandNear, labelScale, landSpan, limitAt, mapIslands, onBlocks, screenToCell, worldBounds, worldCell, worldToScreen, type Below, type Layout } from './layout.js';
import { ISLET, homeRoom, placeIslet } from './resources.js';
import { ResourcesIsland, ResourcesPill } from './ResourcesIsland.js';
import { TerminalCard } from './TerminalCard.js';
import { Token } from './Token.js';
import type { Drag, MapDump, PointerEv, Target } from './types.js';

declare global { interface Window { __map?: { layout(): Layout; screenOf(cell: Cell): { x: number; y: number }; dump(): MapDump } } }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type IslandDrag = Extract<Drag, { kind: 'island' | 'resize' }>;
type PendingIsland = IslandDrag & { from: Cell; anchor: { screen: { x: number; y: number }; world: { x: number; y: number } } };
// how far a hovered card rises, matching `.tok:hover .card` in styles.css
const HOVER_LIFT = 6;
// A map squeezed between the side panels is too narrow to choose a lasting fleet arrangement.
const MIN_ARRANGE_ASPECT = 0.5;
const CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
export type Corner = (typeof CORNERS)[number];
// the toast takes the first corner the open card leaves free
function toastCorner(card: { x: number; y: number; width: number; height: number } | undefined, host: { w: number; h: number }): Corner {
  if (!card) return 'bottom-left';
  const m = theme.card.margin;
  const free = (c: Corner) => {
    const x = c.endsWith('left') ? m : host.w - m;
    const y = c.startsWith('top') ? m : host.h - m;
    return x < card.x || x > card.x + card.width || y < card.y || y > card.y + card.height;
  };
  return CORNERS.find(free) ?? 'bottom-left';
}

export function Map() {
  const host = useRef<HTMLDivElement>(null);
  const fleet = useApp((s) => s.fleet);
  const selectedId = useApp((s) => s.selectedId);
  const selectedIslandId = useApp((s) => s.selectedIslandId);
  const card = useApp((s) => s.card);
  const cardSize = useApp((s) => s.cardSize);
  const sideCardOpen = useApp((s) => s.sideCardOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const halfCard = useApp((s) => s.halfCard);
  const autoArrange = useApp((s) => s.settings.autoArrange);
  const arrangeAsk = useApp((s) => s.arrangeAsk);
  const dropHover = useApp((s) => s.dropHover);
  const active = useApp((s) => s.active);
  const [layout, setLayout] = useState<Layout>({ scale: 1, tile: theme.cell, ox: 0, oy: 0 });
  const [drag, setDrag] = useState<Drag>();
  const [pendingIsland, setPendingIsland] = useState<PendingIsland>();
  const pendingRef = useRef<PendingIsland>(undefined);
  pendingRef.current = pendingIsland;
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragFrame = useRef<number>(undefined);
  const cameraHold = useRef(false);
  const pan = useRef({ x: 0, y: 0 });
  const panDrag = useRef<{ from: { x: number; y: number }; pan: { x: number; y: number }; moved: boolean }>(undefined);
  const [panning, setPanning] = useState(false);
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  // mission control's row wraps to as many lines as it needs; the shelf's bottom edge follows its real height
  const [rowH, setRowH] = useState(theme.home.row);
  const row = useRef({ w: 0, h: theme.home.row });
  // the cap mission control is drawn at, eased with the layout towards the one its fit reserved room for
  const homeMost = useRef(1);
  const hostSizeRef = useRef(hostSize);
  hostSizeRef.current = hostSize;
  const [hover, setHover] = useState<string>();
  const [hotIsland, setHotIsland] = useState<string>();
  const hotRef = useRef<string>(undefined);
  hotRef.current = hotIsland;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const interactions = useRef(createInteractions());
  const lastPressAt = useRef(-Infinity);
  // the host holds the capture, so a click lands on it whatever was pressed; the press remembers what that was
  const pressedKind = useRef<Target['kind']>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hotTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // an island is hot under the pointer (footprint plus its coast) and stays hot for a grace period, so the pointer can cross water to its label or grip
  const holdIsland = (id: string) => { clearTimeout(hotTimer.current); setHotIsland(id); };
  const releaseIsland = (id: string) => {
    clearTimeout(hotTimer.current);
    hotTimer.current = setTimeout(() => setHotIsland((h) => (h === id ? undefined : h)), theme.islandHotGraceMs);
  };
  useEffect(() => () => clearTimeout(hotTimer.current), []);

  // the drag is shown where it was dropped until the fleet answers; a refusal puts the island back
  const undoPending = (id: string) => () => {
    if (pendingRef.current?.id !== id) return;
    pendingRef.current = undefined;
    setPendingIsland(undefined);
    cameraHold.current = false;
  };

  const run = (intent: Intent | undefined) => {
    if (!intent) return;
    const s = app.store.getState();
    const d = deps();
    switch (intent.type) {
      // an open card is the terminal in view, so the selection moves it rather than leaving it on the character behind
      case 'select': if (s.card) s.focus(intent.id); else s.select(intent.id); return;
      case 'selectIsland': s.selectIsland(intent.id); return;
      case 'deselect': s.select(undefined); s.closeCard(); return;
      case 'open': s.focus(intent.id); return;
      // a double click asks for the island's card whatever the side card was left at
      case 'openIsland': s.selectIsland(intent.id); s.toggleSideCard(true); return;
      case 'move': moveCharacterToCell(d, intent.id, intent.islandId, intent.cell); return;
      case 'swap': {
        const other = s.fleet.characters[intent.otherId];
        if (other) moveCharacterToCell(d, intent.id, other.islandId, other.cell);
        return;
      }
      case 'newIsland': newIslandAround(d, intent.id, intent.cell); return;
      case 'moveIsland': moveIsland(d, intent.id, intent.position, undoPending(intent.id)); return;
      case 'resize': resizeIsland(d, intent.id, intent.size, undoPending(intent.id)); return;
    }
  };

  // one pipeline for every pointer source: screen → cell → intent
  const pointer = (ev: PointerEv) => {
    const l = layoutRef.current;
    const st = app.store.getState();
    const cell = screenToCell(l, ev.screen);
    const hi = homeIsland(st.fleet);
    const box = hi && !hi.collapsed ? homeBox(hi, hostSizeRef.current, placeRef.current.homeShift, placeRef.current.homeScale) : undefined;
    const dragged = interactions.current.drag();
    const joining = Boolean(hi && dragged?.kind === 'figure' && homeFull(st.fleet, hi, dragged.id));
    const home = hi && box && inHomeBox(box, ev.screen) ? homeSlotAt(hi, box, ev.screen, joining) : undefined;
    // the refit's hold is measured on performance.now(); an event's timeStamp need not share its clock
    if (ev.type === 'down' || ev.type === 'up') lastPressAt.current = performance.now();
    if (ev.type === 'down' && (ev.target?.kind === 'label' || ev.target?.kind === 'handle') &&
      st.fleet.islands[ev.target.islandId]?.kind !== 'home') {
      // A second gesture may start while the last fit is still moving. Freeze the camera at the press.
      cancelAnimationFrame(anim.current ?? 0); anim.current = undefined; target.current = undefined;
      cameraHold.current = true;
    }
    // a press on water that travels pans the map; a press that stays put is a click
    if (ev.type === 'down' && ev.target?.kind === 'water') panDrag.current = { from: ev.screen, pan: { ...pan.current }, moved: false };
    if (ev.type === 'move' && panDrag.current) {
      const p = panDrag.current, dx = ev.screen.x - p.from.x, dy = ev.screen.y - p.from.y;
      if (p.moved || Math.abs(dx) + Math.abs(dy) > 4) { p.moved = true; setPanning(true); interactions.current.cancel(); panTo({ x: p.pan.x + dx, y: p.pan.y + dy }); return; }
    }
    if ((ev.type === 'up' || ev.type === 'cancel') && panDrag.current) {
      const moved = panDrag.current.moved;
      panDrag.current = undefined;
      if (moved) { setPanning(false); return; }
    }
    if (ev.type === 'move' && !interactions.current.drag()) {
      const near = islandNear(st.fleet, cell);
      if (near) holdIsland(near); else if (hotRef.current) releaseIsland(hotRef.current);
    }
    const event = { type: ev.type, cell, home, target: ev.target, time: ev.time, screen: ev.screen, scale: l.scale };
    // A release may arrive without a final move event; use its exact pointer position for the grid target.
    if (ev.type === 'up' && interactions.current.drag()) interactions.current.handle({ ...event, type: 'move' }, st.fleet, st.selectedId);
    const before = ev.type === 'up' ? interactions.current.drag() : undefined;
    let intent = interactions.current.handle(event, st.fleet, st.selectedId);
    // mission control is drawn over the world, so land put down on it would vanish under it: the island goes back
    if (intent?.type === 'moveIsland' || intent?.type === 'resize') {
      const island = st.fleet.islands[intent.id], below = host.current && belowOf(host.current);
      const next = island && (intent.type === 'moveIsland' ? { ...island, position: intent.position } : { ...island, size: intent.size });
      if (next && below && onBlocks(next, l, below)) {
        st.showToast(`${island.name} would stand on mission control`);
        intent = undefined;
      }
    }
    if (ev.type === 'up' && before && before.kind !== 'figure' && intent && (intent.type === 'moveIsland' || intent.type === 'resize')) {
      const island = st.fleet.islands[before.id];
      if (island) {
        const snapped = before.kind === 'island'
          ? { x: (before.position.x - island.position.x) * theme.cell, y: (before.position.y - island.position.y) * theme.cell }
          : { x: (before.size.w - island.size.w) * theme.cell, y: (before.size.h - island.size.h) * theme.cell };
        const raw = before.offset ?? snapped;
        const next: PendingIsland = { ...before, from: island.position,
          anchor: { screen: ev.screen, world: { x: (ev.screen.x - l.ox) / l.scale + snapped.x - raw.x,
            y: (ev.screen.y - l.oy) / l.scale + snapped.y - raw.y } } };
        clearTimeout(settleTimer.current);
        settleTimer.current = undefined;
        pendingRef.current = next;
        setPendingIsland(next);
      }
    }
    run(intent);
    const current = interactions.current.drag();
    if (current?.kind === 'island' || current?.kind === 'resize') cameraHold.current = true;
    if (ev.type === 'cancel' || (ev.type === 'up' && !pendingRef.current)) {
      cameraHold.current = false;
      if (!before) requestAnimationFrame(() => refit());
    }
    if (ev.type === 'move') {
      if (dragFrame.current === undefined) dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = undefined;
        setDrag(interactions.current.drag());
      });
    } else {
      cancelAnimationFrame(dragFrame.current ?? 0);
      dragFrame.current = undefined;
      setDrag(current);
    }
    if (ev.type === 'down') { clearTimeout(hoverTimer.current); setHover(undefined); }
  };

  // every pointer source (sea, island, token) names its target; the host owns the capture, so a drag
  // survives its token being re-parented between the world and the home island
  const domPointer = (target: Target) => ({
    onPointerDown: (e: React.PointerEvent<Element>) => {
      // a right-click, or a control-click, only opens the menu: it selects and drags nothing
      if (e.button !== 0 || e.ctrlKey) { endHover(); return; }
      const el = host.current!;
      commitFocused();
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      pressedKind.current = target.kind;
      const r = el.getBoundingClientRect();
      pointer({ type: 'down', screen: { x: e.clientX - r.left, y: e.clientY - r.top }, target, time: e.timeStamp });
    },
  });

  // the rest of the sequence arrives on the host, which holds the capture from the press to the release;
  // a press no map target claims (a button, a chip) leaves no kind for a double click to read
  const hostPointer = {
    onPointerDownCapture: () => { pressedKind.current = undefined; },
    onPointerMove: (e: React.PointerEvent<Element>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const r = host.current!.getBoundingClientRect();
      pointer({ type: 'move', screen: { x: e.clientX - r.left, y: e.clientY - r.top }, time: e.timeStamp });
    },
    onPointerUp: (e: React.PointerEvent<Element>) => {
      const r = host.current!.getBoundingClientRect();
      pointer({ type: 'up', screen: { x: e.clientX - r.left, y: e.clientY - r.top }, time: e.timeStamp });
    },
    onPointerCancel: (e: React.PointerEvent<Element>) => {
      const r = host.current!.getBoundingClientRect();
      pointer({ type: 'cancel', screen: { x: e.clientX - r.left, y: e.clientY - r.top }, time: e.timeStamp });
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && interactions.current.drag()) {
      interactions.current.cancel(); cancelAnimationFrame(dragFrame.current ?? 0); dragFrame.current = undefined;
      cameraHold.current = false; setDrag(undefined); requestAnimationFrame(() => refit());
    } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const target = useRef<Layout & { most: number }>(undefined);
  const anim = useRef<number>(undefined);
  const holdUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { cancelAnimationFrame(anim.current ?? 0); cancelAnimationFrame(dragFrame.current ?? 0);
    clearTimeout(holdTimer.current); clearTimeout(hoverTimer.current); clearTimeout(settleTimer.current); }, []);
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
  const refit = (immediate?: boolean, anchor?: PendingIsland['anchor']) => {
    if (cameraHold.current && !immediate) return;
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
  useEffect(() => {
    const p = pendingRef.current;
    if (p) {
      const updated = fleet.islands[p.id];
      const arrived = p.kind === 'island'
        ? updated?.position.x === p.position.x && updated?.position.y === p.position.y
        : updated?.size.w === p.size.w && updated?.size.h === p.size.h;
      if (arrived && !settleTimer.current) {
        if (!islandInView(p.id)) { cameraHold.current = false; refit(false, p.anchor); }
        settleTimer.current = setTimeout(() => {
          settleTimer.current = undefined;
          if (pendingRef.current !== p) return;
          pendingRef.current = undefined; setPendingIsland(undefined);
          if (!interactions.current.drag()) cameraHold.current = false;
        }, theme.dragSettleMs);
      }
      return;
    }
    if (!cameraHold.current) refit();
  }, [fleet.islands]);
  const onSeaDoubleClick = (e: React.MouseEvent) => {
    if (pressedKind.current !== 'water') return;
    const r = host.current!.getBoundingClientRect();
    newIsland(deps(), screenToCell(layoutRef.current, { x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  // the shape the arranged fleet should fill: the map minus the fit insets and the ground mission control keeps
  const arrange = (automatic = false) => {
    const el = host.current;
    if (!el || (automatic && app.store.getState().status !== 'online')) return;
    const room = { w: el.clientWidth, h: el.clientHeight - reserveAt(el.clientWidth) };
    const w = room.w - 2 * theme.fit.x, h = room.h - theme.fit.top - theme.fit.bottom;
    if (w <= 0 || h <= 0) return;
    // the map's own shape says whether it is squeezed, whatever margins the fit keeps inside it
    if (automatic && room.w / room.h < MIN_ARRANGE_ASPECT) return;
    arrangeIslands(deps(), w / h, homeRoom(el.clientWidth));
  };
  const arrangeRef = useRef(() => arrange(true));
  arrangeRef.current = () => arrange(true);
  useEffect(() => {
    if (!arrangeAsk) return;
    app.store.getState().arranged();
    // behind a full card the card's closing arranges
    if (arrangeAsk === 'auto' && coveredRef.current) return;
    arrange(arrangeAsk === 'auto');
  }, [arrangeAsk]);

  // a hidden island comes back to the stale spot it left, so whichever client unfolded it, the fleet is arranged round it
  const folded = useRef<Set<string>>(undefined);
  useEffect(() => {
    const now = new Set(Object.values(fleet.islands).filter((i) => i.collapsed && i.kind !== 'home').map((i) => i.id));
    const back = [...(folded.current ?? [])].some((id) => fleet.islands[id] && !now.has(id));
    folded.current = now;
    if (back && app.store.getState().settings.autoArrange) app.store.getState().askArrange('auto');
  }, [fleet.islands]);

  // the fleet is arranged to the room the map finds each time its card shrinks from full or closes
  const covered = Boolean(card) && cardSize === 'full';
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const cover = card ? (covered ? 2 : 1) : 0;
  const lastCover = useRef(cover);
  // a click on the sea closes the card, so the fleet holds still until that click sequence is over
  const arrangeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arrangeAfterClicks = () => {
    const wait = lastPressAt.current + DBL_CLICK_MS - performance.now();
    clearTimeout(arrangeTimer.current);
    if (wait > 0) arrangeTimer.current = setTimeout(arrangeAfterClicks, wait); else arrangeRef.current();
  };
  useEffect(() => () => clearTimeout(arrangeTimer.current), []);
  useEffect(() => {
    const uncovered = cover < lastCover.current;
    lastCover.current = cover;
    if (uncovered && autoArrange) arrangeAfterClicks();
  }, [cover]);

  // a drag-resize arranges once, after the window stands still. a page zoom resizes the view without moving the
  // window, so the size is measured in pixels the zoom cannot change; behind a full card the uncovering arranges
  useEffect(() => {
    if (!autoArrange) return;
    const windowSize = () => {
      const zoom = app.store.getState().settings.zoom;
      return { w: window.innerWidth * zoom, h: window.innerHeight * zoom };
    };
    let timer: ReturnType<typeof setTimeout>;
    let last = windowSize();
    const onResize = () => {
      const now = windowSize();
      if (Math.abs(now.w - last.w) <= 2 && Math.abs(now.h - last.h) <= 2) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!coveredRef.current) arrangeRef.current(); }, theme.autoArrangeMs);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(timer); };
  }, [autoArrange]);

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
  }, [Boolean(homeIsland(fleet))]);

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


  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__map = {
      layout: () => layoutRef.current,
      screenOf: (c) => worldToScreen(layoutRef.current, c),
      dump: () => {
        const f = app.store.getState().fleet;
        return {
          scale: layoutRef.current.scale,
          islands: mapIslandsSorted(f).map((i) => ({ id: i.id, x: i.position.x, y: i.position.y, w: i.size.w, h: i.size.h })),
          tokens: mapIslandsSorted(f).flatMap((i) => charactersOf(f, i.id).map((c) => ({
            id: c.id,
            cell: worldCell(i.position, c.cell),
            status: statusOf(c) as string,
          }))),
        };
      },
    };
    return () => { delete window.__map; };
  }, []);

  const cs = cellSize(layout);
  const hovered = hover && !drag && !card ? fleet.characters[hover] : undefined;
  const cardBox = card ? cardRect({ size: cardSize, win: hostSize, half: halfCard }) : undefined;
  const sea = domPointer({ kind: 'water' });
  const startHover = (id: string) => {
    if (card || interactions.current.drag()) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(id), theme.hoverDelayMs);
  };
  const endHover = () => { clearTimeout(hoverTimer.current); setHover(undefined); };
  const hi = homeIsland(fleet);
  // where the resources islet stands, and how far home slides left to make room for it
  const place = placeIslet(hostSize.w, (hi?.size.w ?? 0) * theme.cell, Boolean(hi?.collapsed), homeMost.current);
  const placeRef = useRef(place);
  placeRef.current = place;
  const overHome = drag?.kind === 'figure' && drag.over?.islandId === HOME_ISLAND ? drag : undefined;
  const crew = homeCrew(fleet, drag);
  const previewFor = (id: string): IslandDrag | PendingIsland | undefined =>
    drag && drag.kind !== 'figure' && drag.id === id ? drag : pendingIsland?.id === id ? pendingIsland : undefined;
  const islandOffset = (i: typeof fleet.islands[string], p: IslandDrag | PendingIsland | undefined) => {
    if (!p || p.kind !== 'island') return undefined;
    if (p === pendingIsland) return { x: (p.position.x - pendingIsland.from.x) * theme.cell,
      y: (p.position.y - pendingIsland.from.y) * theme.cell };
    return p.offset ?? { x: (p.position.x - i.position.x) * theme.cell, y: (p.position.y - i.position.y) * theme.cell };
  };
  return (
    <div ref={host} className="map" data-testid="map" data-dragging={Boolean(drag) || panning} data-paused={!active || covered} onWheel={onWheel} onDoubleClick={onSeaDoubleClick} {...hostPointer}
      style={{ '--map-w': `${hostSize.w}px`, '--home-row-top': `${(hi?.collapsed ? theme.home.bar : theme.home.visible * place.homeScale + theme.home.rowGap) + rowH + 24}px` } as React.CSSProperties}>
      <div className="map-grain" />
      {/* the camera's values sit on the one element that reads them: set on the map, every frame of a zoom would restyle all of it */}
      <div className="map-grid" style={{ '--cell': `${cs}px`, '--gx': `${layout.ox % cs}px`, '--gy': `${layout.oy % cs}px` } as React.CSSProperties} />
      <div className="map-sea" {...sea} />
      <div className="map-world" style={{ transform: `translate(${Math.round(layout.ox)}px, ${Math.round(layout.oy)}px) scale(${layout.scale})`, '--cell': `${theme.cell}px`, '--k': cardScale(layout.scale) / layout.scale, '--lk': labelScale(layout.scale) / layout.scale } as React.CSSProperties}>
        {mapIslandsSorted(fleet).map((i) => {
          const preview = previewFor(i.id);
          const shown = preview?.kind === 'island' && preview === pendingIsland ? { ...i, position: pendingIsland.from }
            : preview?.kind === 'resize' ? { ...i, size: preview.size } : i;
          const gripOffset = preview?.kind === 'resize' && preview.offset && preview !== pendingIsland
            ? { x: Math.max((MIN_SIZE.w - i.size.w) * theme.cell, preview.offset.x) - (preview.size.w - i.size.w) * theme.cell,
              y: Math.max((MIN_SIZE.h - i.size.h) * theme.cell, preview.offset.y) - (preview.size.h - i.size.h) * theme.cell }
            : undefined;
          const hold = { onPointerEnter: () => holdIsland(i.id), onPointerLeave: () => releaseIsland(i.id) };
          const count = charactersOf(fleet, i.id).length;
          return (
            <Island key={i.id} island={shown} count={count} offset={islandOffset(i, preview)} gripOffset={gripOffset}
              hot={hotIsland === i.id || selectedIslandId === i.id} selected={selectedIslandId === i.id}
              dragging={Boolean(preview)} settling={Boolean(pendingIsland) && preview === pendingIsland}
              hover={dropHover?.kind === 'island' && dropHover.id === i.id}
              onNew={() => newCharacterOn(deps(), i.id)}
              onToggle={() => toggleIsland(deps(), i.id)}
              onMenu={(e) => islandMenu(e, i.id, count === 0)}
              land={domPointer({ kind: 'label', islandId: i.id })}
              label={domPointer({ kind: 'label', islandId: i.id })}
              handle={domPointer({ kind: 'handle', islandId: i.id })}
              hold={hold} />
          );
        })}
        {drag?.kind === 'island' && fleet.islands[drag.id] && (() => {
          const { size } = fleet.islands[drag.id];
          return <div className="island-landing" aria-hidden="true"
            style={{ left: drag.position.x * theme.cell, top: drag.position.y * theme.cell,
              width: size.w * theme.cell, height: size.h * theme.cell }} />;
        })()}
        {drag?.kind === 'figure' && drag.over && (() => {
          const i = fleet.islands[drag.over.islandId];
          if (!i || i.kind === 'home') return null;
          return <div className="drop-cell" data-testid="drop-cell" data-free={drag.over.free}
            style={{ left: (i.position.x + drag.over.local.x) * theme.cell, top: (i.position.y + drag.over.local.y) * theme.cell, width: theme.cell, height: theme.cell }} />;
        })()}
        {mapIslandsSorted(fleet).flatMap((i) => charactersOf(fleet, i.id).map((c) => {
          const dragging = drag?.kind === 'figure' && drag.id === c.id;
          if (dragging && overHome) return null;
          const preview = previewFor(i.id);
          const base = preview?.kind === 'island' && preview === pendingIsland ? pendingIsland.from : i.position;
          const world = dragging ? drag.cell : worldCell(base, c.cell);
          return (
            <Token key={c.id} c={c} status={statusOf(c)} world={world} selected={c.id === selectedId} dragging={dragging}
              offset={islandOffset(i, preview)} settling={Boolean(pendingIsland) && preview === pendingIsland}
              hover={dropHover?.kind === 'char' && dropHover.id === c.id}
              pointer={domPointer({ kind: 'figure', id: c.id })}
              onHoverStart={() => startHover(c.id)} onHoverEnd={endHover}
              onOpen={() => app.store.getState().focus(c.id)}
              onLink={followLink} onMenu={(e) => characterMenu(e, c.id)} />
          );
        }))}
        {drag?.kind === 'figure' && !overHome && fleet.characters[drag.id]?.islandId === HOME_ISLAND && (
          <Token key={drag.id} c={fleet.characters[drag.id]} status={statusOf(fleet.characters[drag.id])} world={drag.cell} selected={drag.id === selectedId} dragging
            pointer={domPointer({ kind: 'figure', id: drag.id })} hover={false} onHoverStart={() => {}} onHoverEnd={endHover}
            onOpen={() => app.store.getState().focus(drag.id)} onLink={followLink} onMenu={(e) => characterMenu(e, drag.id)} />
        )}
      </div>
      <div className="map-overlay">
        <Wordmark />
        {hi && (
          <Home island={hi} crew={crew} config={fleet.home} collapsed={Boolean(hi.collapsed)}
            selected={selectedIslandId === HOME_ISLAND} selectedId={selectedId} drag={drag} status={statusOf}
            shift={place.homeShift} rowShift={placeIslet(hostSize.w, hi.size.w * theme.cell, Boolean(hi.collapsed)).homeShift}
            scale={place.homeScale} extra={place.mode === 'pill' ? <ResourcesPill /> : undefined}
            onToggle={() => toggleIsland(deps(), HOME_ISLAND)}
            onArrange={() => arrange()}
            onNewIsland={() => newIsland(deps())}
            onAction={(a) => startHomeAction(deps(), a)}
            onNew={() => newCharacterOn(deps(), HOME_ISLAND)}
            label={domPointer({ kind: 'label', islandId: HOME_ISLAND })}
            tokenPointer={(id) => domPointer({ kind: 'figure', id })}
            onHoverStart={startHover} onHoverEnd={endHover}
            onOpen={(id) => app.store.getState().focus(id)}
            onLink={followLink}
            onMenu={(id, e) => characterMenu(e, id)}
            dropHover={dropHover} />
        )}
        {hi && place.mode !== 'pill' && <ResourcesIsland place={place} />}
        {hovered && (() => {
          const i = fleet.islands[hovered.islandId];
          if (!i) return null;
          const onHome = i.kind === 'home';
          if (i.collapsed) return null;
          const box = onHome ? homeBox(i, hostSize, place.homeShift, place.homeScale) : undefined;
          const size = box ? box.cell : cs;
          const p = box ? homeCellToScreen(box, hovered.cell) : worldToScreen(layout, worldCell(i.position, hovered.cell));
          const w = theme.hoverCardWidth;
          const cx = p.x + size / 2;
          // a token is drawn at its card scale, or at home's, hover lift and all
          const k = onHome ? place.homeScale : cardScale(layout.scale);
          const top = p.y + size / 2 - (tokenPx.h * 0.48 + HOVER_LIFT) * k;   // the token's top edge on screen
          const bottom = p.y + size / 2 + (tokenPx.h * 0.52 - HOVER_LIFT) * k;
          const flip = top < 12 + theme.hoverCardMaxH;
          return (
            <HoverCard c={hovered} flip={flip}
              x={Math.max(14, Math.min(hostSize.w - w - 14, cx - w / 2))}
              y={flip ? bottom + 12 : top - 12} />
          );
        })()}
        {card && fleet.characters[card] && <TerminalCard key={card} id={card} host={hostSize} />}
        <Toast corner={toastCorner(cardBox, hostSize)} />
        <ResourcesLayer tip={place.cx - ISLET.margin} />
      </div>
    </div>
  );
}
