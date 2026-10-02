import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Cell, FleetState } from '@svall/protocol';
import { moveCharacterToCell, moveIsland, newIsland, newIslandAround, resizeIsland } from '../actions.js';
import { app, deps } from '../boot.js';
import { commitFocused } from '../Field.js';
import { homeIsland } from '../selectors.js';
import { theme } from '../theme.js';
import type { Anchor, Camera } from './camera.js';
import type { useHover } from './hover.js';
import { homeBox, homeFull, homeSlotAt, inHomeBox } from './home.js';
import { createInteractions, type Intent } from './interactions.js';
import { islandNear, onBlocks, screenToCell } from './layout.js';
import type { Placement } from './resources.js';
import type { Drag, PointerEv, Target } from './types.js';

export type IslandDrag = Extract<Drag, { kind: 'island' | 'resize' }>;
export type PendingIsland = IslandDrag & { from: Cell; anchor: Anchor };

type Opts = {
  host: RefObject<HTMLDivElement | null>;
  camera: Camera;
  hover: ReturnType<typeof useHover>;
  place: RefObject<Placement>;
  lastPressAt: RefObject<number>;
  islands: FleetState['islands'];
  crewCells: string;
};

/** Every press, drag and release on the map, turned into what it asks of the fleet. */
export function useMapPointer({ host, camera, hover, place, lastPressAt, islands, crewCells }: Opts) {
  const [drag, setDrag] = useState<Drag>();
  const [pendingIsland, setPendingIsland] = useState<PendingIsland>();
  const pendingRef = useRef<PendingIsland>(undefined);
  pendingRef.current = pendingIsland;
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragFrame = useRef<number>(undefined);
  const panDrag = useRef<{ from: { x: number; y: number }; pan: { x: number; y: number }; moved: boolean }>(undefined);
  const [panning, setPanning] = useState(false);
  const interactions = useRef(createInteractions());
  // the host holds the capture, so a click lands on it whatever was pressed; the press remembers what that was
  const pressedKind = useRef<Target['kind']>(undefined);

  // the drag is shown where it was dropped until the fleet answers; a refusal puts the island back
  const undoPending = (id: string) => () => {
    if (pendingRef.current?.id !== id) return;
    pendingRef.current = undefined;
    setPendingIsland(undefined);
    camera.hold.current = false;
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
    const l = camera.layoutRef.current;
    const st = app.store.getState();
    const cell = screenToCell(l, ev.screen);
    const hi = homeIsland(st.fleet);
    const box = hi && !hi.collapsed ? homeBox(hi, camera.hostSizeRef.current, place.current.homeShift, place.current.homeScale) : undefined;
    const dragged = interactions.current.drag();
    const joining = Boolean(hi && dragged?.kind === 'figure' && homeFull(st.fleet, hi, dragged.id));
    const home = hi && box && inHomeBox(box, ev.screen) ? homeSlotAt(hi, box, ev.screen, joining) : undefined;
    // the refit's hold is measured on performance.now(); an event's timeStamp need not share its clock
    if (ev.type === 'down' || ev.type === 'up') lastPressAt.current = performance.now();
    if (ev.type === 'down' && (ev.target?.kind === 'label' || ev.target?.kind === 'handle') &&
      st.fleet.islands[ev.target.islandId]?.kind !== 'home') camera.freeze();
    // a press on water that travels pans the map; a press that stays put is a click
    if (ev.type === 'down' && ev.target?.kind === 'water') panDrag.current = { from: ev.screen, pan: { ...camera.pan.current }, moved: false };
    if (ev.type === 'move' && panDrag.current) {
      const p = panDrag.current, dx = ev.screen.x - p.from.x, dy = ev.screen.y - p.from.y;
      if (p.moved || Math.abs(dx) + Math.abs(dy) > 4) { p.moved = true; setPanning(true); interactions.current.cancel(); camera.panTo({ x: p.pan.x + dx, y: p.pan.y + dy }); return; }
    }
    if ((ev.type === 'up' || ev.type === 'cancel') && panDrag.current) {
      const moved = panDrag.current.moved;
      panDrag.current = undefined;
      if (moved) { setPanning(false); return; }
    }
    if (ev.type === 'move' && !interactions.current.drag()) {
      const near = islandNear(st.fleet, cell);
      if (near) hover.holdIsland(near); else if (hover.hotRef.current) hover.releaseIsland(hover.hotRef.current);
    }
    const event = { type: ev.type, cell, home, target: ev.target, time: ev.time, screen: ev.screen, scale: l.scale };
    // A release may arrive without a final move event; use its exact pointer position for the grid target.
    if (ev.type === 'up' && interactions.current.drag()) interactions.current.handle({ ...event, type: 'move' }, st.fleet, st.selectedId);
    const before = ev.type === 'up' ? interactions.current.drag() : undefined;
    let intent = interactions.current.handle(event, st.fleet, st.selectedId);
    // mission control is drawn over the world, so land put down on it would vanish under it: the island goes back
    if (intent?.type === 'moveIsland' || intent?.type === 'resize') {
      const island = st.fleet.islands[intent.id], below = host.current && camera.belowOf(host.current);
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
    if (current?.kind === 'island' || current?.kind === 'resize') camera.hold.current = true;
    if (ev.type === 'cancel' || (ev.type === 'up' && !pendingRef.current)) {
      camera.hold.current = false;
      if (!before) requestAnimationFrame(() => camera.refit());
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
    if (ev.type === 'down') hover.end();
  };

  // every pointer source (sea, island, token) names its target; the host owns the capture, so a drag
  // survives its token being re-parented between the world and the home island
  const domPointer = (target: Target) => ({
    onPointerDown: (e: React.PointerEvent<Element>) => {
      // a right-click, or a control-click, only opens the menu: it selects and drags nothing
      if (e.button !== 0 || e.ctrlKey) { hover.end(); return; }
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
    // a release the map never hears, taken by a native menu or the system, still ends the drag or pan it began
    onLostPointerCapture: (e: React.PointerEvent<Element>) => {
      if (!interactions.current.drag() && !panDrag.current) return;
      const r = host.current!.getBoundingClientRect();
      pointer({ type: 'cancel', screen: { x: e.clientX - r.left, y: e.clientY - r.top }, time: e.timeStamp });
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && interactions.current.drag()) {
      interactions.current.cancel(); cancelAnimationFrame(dragFrame.current ?? 0); dragFrame.current = undefined;
      camera.hold.current = false; setDrag(undefined); requestAnimationFrame(() => camera.refit());
    } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => () => { cancelAnimationFrame(dragFrame.current ?? 0); clearTimeout(settleTimer.current); }, []);

  useEffect(() => {
    const p = pendingRef.current;
    if (p) {
      const updated = islands[p.id];
      const arrived = p.kind === 'island'
        ? updated?.position.x === p.position.x && updated?.position.y === p.position.y
        : updated?.size.w === p.size.w && updated?.size.h === p.size.h;
      if (arrived && !settleTimer.current) {
        if (!camera.islandInView(p.id)) { camera.hold.current = false; camera.refit(false, p.anchor); }
        settleTimer.current = setTimeout(() => {
          settleTimer.current = undefined;
          if (pendingRef.current !== p) return;
          pendingRef.current = undefined; setPendingIsland(undefined);
          if (!interactions.current.drag()) camera.hold.current = false;
        }, theme.dragSettleMs);
      }
      return;
    }
    if (!camera.hold.current) camera.refit();
  }, [islands, crewCells]);

  const onSeaDoubleClick = (e: React.MouseEvent) => {
    if (pressedKind.current !== 'water') return;
    const r = host.current!.getBoundingClientRect();
    newIsland(deps(), screenToCell(camera.layoutRef.current, { x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  return { drag, pendingIsland, panning, inDrag: () => Boolean(interactions.current.drag()), domPointer, hostPointer, onSeaDoubleClick };
}
