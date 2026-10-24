import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Column, FleetState, Robot } from '@svall/protocol';
import { addColumn, newRobotOn, newRobotTarget, placeRobot, renameColumn, reorderColumn } from './actions.js';
import { app, deps } from './boot.js';
import { BoardCard } from './BoardCard.js';
import { stop, useApp } from './hooks.js';
import { keyTip } from './keys.js';
import { cardRect } from './map/card.js';
import { useHover } from './map/hover.js';
import { HoverCard } from './map/HoverCard.js';
import { TerminalCard } from './map/TerminalCard.js';
import { boardRobotMenu, columnMenu } from './menus.js';
import { boardColumns, islandsSorted, placesOf, robotsOf, wantsUser, type BoardColumn } from './selectors.js';
import { theme } from './theme.js';
import { Toast, toastCorner } from './Toast.js';

type Filter = { island?: string; needsYou: boolean };
// the card a drag carries, where the pointer holds it, and the column under the pointer
type Lift = { id: string; from: string; x: number; y: number; dx: number; dy: number; w: number; h: number; over?: string };
// the column a grip drag carries, and the side of the column under the pointer it would land on
type Shift = { id: string; over?: { id: string; after: boolean } };

// a collapsed column is the page's to remember, not the fleet's
const shutKey = (id: string) => `board.column.${id}`;

const columnAt = (x: number, y: number): Element | undefined => document.elementFromPoint(x, y)?.closest('[data-col]') ?? undefined;

// a press that travels theme.board.dragPx is a drag, which `move` follows and `end` closes, dropped or called off by Escape;
// a shorter one stays a click
function track(e: React.PointerEvent, move: (m: PointerEvent) => void, end: (dropped: boolean) => void): void {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let dragging = false;
  const onMove = (m: PointerEvent) => {
    if (!dragging && Math.hypot(m.clientX - x0, m.clientY - y0) < theme.board.dragPx) return;
    dragging = true;
    move(m);
  };
  const finish = (dropped: boolean) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (!dragging) return;
    // the click a drag ends on is not a click on what it ends over
    const swallow = (c: MouseEvent) => c.stopPropagation();
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    end(dropped);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (k: KeyboardEvent) => { if (dragging && k.key === 'Escape') { k.stopPropagation(); finish(false); } };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

// when each robot arrived in the column it sits in, for those that moved or joined the fleet while the board was up
function useArrivals(f: FleetState): ReadonlyMap<string, number> {
  const places = useRef<Map<string, string>>(undefined);
  const at = useRef(new Map<string, number>());
  return useMemo(() => {
    const now = placesOf(f);
    if (places.current) for (const [id, k] of now) if (places.current.get(id) !== k) at.current.set(id, Date.now());
    places.current = now;
    return new Map(at.current);
  }, [f]);
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
}

// a robot the board has just dropped somewhere sits there before the fleet says so
const placed = (f: FleetState, p: { id: string; column: string } | undefined): FleetState =>
  (p && f.robots[p.id] ? { ...f, robots: { ...f.robots, [p.id]: { ...f.robots[p.id], column: p.column } } } : f);

function GripGlyph() {
  return (
    <svg viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="2.5" r="1.3" /><circle cx="7" cy="2.5" r="1.3" /><circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" /><circle cx="3" cy="11.5" r="1.3" /><circle cx="7" cy="11.5" r="1.3" />
    </svg>
  );
}

// Return or a click away saves a changed name, Escape keeps the old one
function ColumnName({ column, onDone }: { column: Column; onDone(): void }) {
  return (
    <input className="kb-ren" autoFocus defaultValue={column.name} aria-label={`Rename ${column.name}`} data-testid="col-name-input"
      onFocus={(e) => e.currentTarget.select()} onClick={stop} onDoubleClick={stop} onPointerDown={stop}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        if (name && name !== column.name) renameColumn(deps(), column.id, name);
        onDone();
      }} />
  );
}

/** A column's robots scroll under a fade that shows only while more of them lie below. */
function Body({ children, onScroll }: { children: React.ReactNode; onScroll(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const read = () => { const el = ref.current; if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1); };
  // a robot coming or going redraws the column; the window changing size does not
  useLayoutEffect(read);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(read);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="kb-col-body" data-more={more} onScroll={() => { read(); onScroll(); }}>{children}</div>;
}

export function Board() {
  const ground = useRef<HTMLDivElement>(null);
  const fleet = useApp((s) => s.fleet);
  const selectedId = useApp((s) => s.selectedId);
  const card = useApp((s) => s.card);
  const cardSize = useApp((s) => s.cardSize);
  const halfCard = useApp((s) => s.halfCard);
  const sections = useApp((s) => s.sections);
  const dropHover = useApp((s) => s.dropHover);
  const bindings = useApp((s) => s.settings.bindings);
  const [filter, setFilter] = useState<Filter>({ needsYou: false });
  const [renaming, setRenaming] = useState<string>();
  const [pending, setPending] = useState<{ id: string; column: string }>();
  const [lift, setLift] = useState<Lift>();
  // the cards keep the handlers of the render that drew them, so theirs read the drag here
  const lifting = useRef(false);
  lifting.current = Boolean(lift);
  const [shift, setShift] = useState<Shift>();
  const size = useSize(ground);
  const hov = useHover();
  const hoverRect = useRef<DOMRect>(undefined);

  const shown = useMemo(() => placed(fleet, pending), [fleet, pending]);
  const arrived = useArrivals(shown);
  const island = filter.island && fleet.islands[filter.island] ? filter.island : undefined;
  const inIsland = (c: Robot) => !island || c.islandId === island;
  const cols = boardColumns(shown, (c) => inIsland(c) && (!filter.needsYou || wantsUser(c)), arrived);
  const all = Object.values(fleet.robots);
  const needs = all.filter((c) => inIsland(c) && wantsUser(c)).length;
  const now = Date.now();

  const drop = (id: string, column: string) => {
    setPending({ id, column });
    void placeRobot(deps(), id, column).finally(() => setPending((p) => (p?.id === id ? undefined : p)));
  };
  const liftCard = (e: React.PointerEvent, c: Robot, from: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    const base = { id: c.id, from, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    let last: Lift | undefined;
    track(e, (m) => {
      hov.end();
      last = { ...base, x: m.clientX, y: m.clientY, over: columnAt(m.clientX, m.clientY)?.getAttribute('data-col') ?? undefined };
      setLift(last);
    }, (dropped) => {
      setLift(undefined);
      if (dropped && last?.over && last.over !== from) drop(c.id, last.over);
    });
  };
  const liftColumn = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    let last: Shift | undefined;
    track(e, (m) => {
      const el = columnAt(m.clientX, m.clientY);
      const over = el?.getAttribute('data-col');
      const r = el?.getBoundingClientRect();
      last = { id, over: over && over !== id && r ? { id: over, after: m.clientX > r.left + r.width / 2 } : undefined };
      setShift(last);
    }, (dropped) => {
      setShift(undefined);
      if (dropped && last?.over) reorderColumn(deps(), id, last.over.id, last.over.after);
    });
  };

  const pick = (id: string) => { const s = app.store.getState(); if (s.card) s.focus(id); else s.select(id); };
  // a press on the board's ground, away from every card and control, lets the selection and the card go, as the sea does
  const blank = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('.kc, .kb-col-h, .kb-strip, button, input')) return;
    const s = app.store.getState();
    s.select(undefined);
    s.closeCard();
  };
  const add = async (afterId?: string) => { const id = await addColumn(deps(), afterId); if (id) setRenaming(id); };
  const shut = (id: string) => Boolean(sections[shutKey(id)]?.shut);
  const fold = (id: string, to: boolean) => app.store.getState().setSection(shutKey(id), { shut: to });
  // a new robot lands in the first column, so one asked for elsewhere is placed there by hand
  const newIn = async (column: string) => {
    try {
      const id = await newRobotOn(deps(), island ?? (await newRobotTarget(deps())).islandId);
      if (id && column !== app.store.getState().fleet.columns[0]?.id) await placeRobot(deps(), id, column);
    } catch (e) {
      app.store.getState().showToast((e as Error).message);
    }
  };
  const menu = (e: React.MouseEvent, id: string) =>
    columnMenu(e, id, { rename: () => setRenaming(id), collapse: () => fold(id, true), addAfter: () => void add(id) });

  const hovered = hov.hover && !lift && !shift && !card ? fleet.robots[hov.hover] : undefined;
  const hoverAt = (() => {
    const r = hoverRect.current, g = ground.current?.getBoundingClientRect();
    if (!hovered || !r || !g) return undefined;
    const w = theme.hoverCardWidth, top = r.top - g.top, flip = top < 12 + theme.hoverCardMaxH;
    return { x: Math.max(14, Math.min(g.width - w - 14, r.left - g.left + r.width / 2 - w / 2)), y: flip ? r.bottom - g.top + 8 : top - 8, flip };
  })();
  const cardBox = card ? cardRect({ size: cardSize, win: size, half: halfCard }) : undefined;

  const lane = ({ column, robots }: BoardColumn, i: number) => {
    const id = column.id;
    const target = lift?.over === id && lift.from !== id ? lift : undefined;
    const reorder = shift?.over?.id === id ? (shift.over.after ? 'after' : 'before') : undefined;
    if (shut(id)) {
      return (
        <button key={id} className="kb-strip" data-col={id} data-testid={`col-strip-${id}`} data-target={Boolean(target)} data-reorder={reorder}
          aria-label={`${column.name}, collapsed`} title={`Open ${column.name}`} onClick={() => fold(id, false)}>
          <span className="kb-col-ct tnum">{robots.length}</span><span className="kb-strip-n">{column.name}</span>
        </button>
      );
    }
    const attention = robots.filter(wantsUser).length;
    return (
      <section key={id} className="kb-col" aria-label={column.name} data-col={id} data-testid={`col-${id}`} data-index={i}
        data-target={Boolean(target)} data-reorder={reorder} data-moving={shift?.id === id}>
        <header className="kb-col-h" onContextMenu={(e) => menu(e, id)}>
          <span className="kb-grip" data-testid={`col-grip-${id}`} title="Drag to reorder" onPointerDown={(e) => liftColumn(e, id)}><GripGlyph /></span>
          {renaming === id
            ? <ColumnName column={column} onDone={() => setRenaming(undefined)} />
            : <span className="kb-col-n" data-testid={`col-name-${id}`} onDoubleClick={() => setRenaming(id)}>{column.name}</span>}
          <span className="kb-col-ct tnum" data-testid={`col-count-${id}`}>{robots.length}</span>
          {attention > 0 && <span className="kb-red tnum" title={`${attention} want you`}>{attention}</span>}
          <span className="kb-col-act">
            <button type="button" data-testid={`col-new-${id}`} aria-label={`New robot in ${column.name}`} title="New robot here" onClick={() => void newIn(id)}>+</button>
            <button type="button" data-testid={`col-menu-${id}`} aria-label={`${column.name} column menu`} onClick={(e) => menu(e, id)}>⋯</button>
          </span>
        </header>
        <Body onScroll={hov.end}>
          {target && <div className="kb-slot" data-testid="kb-slot" style={{ height: target.h }} />}
          {robots.map((c) => (
            <BoardCard key={c.id} c={c} selected={c.id === selectedId} arrived={now - (arrived.get(c.id) ?? -Infinity) < theme.board.arriveMs}
              dragging={lift?.id === c.id} fileHover={dropHover?.kind === 'robot' && dropHover.id === c.id}
              on={{
                onPointerDown: (e) => liftCard(e, c, id),
                onClick: () => pick(c.id),
                onDoubleClick: () => app.store.getState().focus(c.id),
                onContextMenu: (e) => boardRobotMenu(e, c.id),
                onPointerEnter: (e) => { if (lifting.current || app.store.getState().card) return; hoverRect.current = e.currentTarget.getBoundingClientRect(); hov.start(c.id); },
                onPointerLeave: hov.end,
              }} />
          ))}
          {robots.length === 0 && !target && <div className="kb-empty" data-testid={`col-empty-${id}`}>Drop a robot here</div>}
        </Body>
      </section>
    );
  };

  const chip = (key: string, on: boolean, label: string, n: number, toggle: () => void) => (
    <button key={key} type="button" className="kb-chip" data-testid={`chip-${key}`} aria-pressed={on} onClick={toggle}>
      {label} <span className="kb-n tnum">{n}</span>
    </button>
  );
  const lifted = lift && fleet.robots[lift.id];

  return (
    <div className="board" data-testid="board">
      <div className="kb-bar">
        <div className="kb-seg" role="group" aria-label="View">
          <button type="button" data-testid="board-map" title={keyTip('Map', 'toggleView', bindings)} onClick={() => app.store.getState().setView('map')}>Map</button>
          <button type="button" aria-pressed="true">Board</button>
        </div>
        <span className="kb-sep" />
        <div className="kb-chips" role="group" aria-label="Islands">
          {chip('all', !island, 'All islands', all.length, () => setFilter((f) => ({ ...f, island: undefined })))}
          {islandsSorted(fleet).map((i) => chip(i.id, island === i.id, i.name, robotsOf(fleet, i.id).length,
            () => setFilter((f) => ({ ...f, island: f.island === i.id ? undefined : i.id }))))}
        </div>
        <span className="kb-gap" />
        <button type="button" className="kb-chip" data-testid="chip-needs" aria-pressed={filter.needsYou} onClick={() => setFilter((f) => ({ ...f, needsYou: !f.needsYou }))}>
          Needs you <span className={needs > 0 ? 'kb-red tnum' : 'kb-n tnum'}>{needs}</span>
        </button>
        <button type="button" className="kb-ghost" data-testid="board-add-column" onClick={() => void add()}>+ Column</button>
      </div>
      <div ref={ground} className="kb-ground">
        <div className="kb-cols" data-testid="board-cols" data-dragging={Boolean(lift || shift)} onClick={blank}>
          {cols.map(lane)}
          <button type="button" className="kb-add-col" data-testid="board-add-column-end" aria-label="Add a column" title="Add a column" onClick={() => void add()}>+</button>
        </div>
        <div className="kb-overlay">
          {hovered && hoverAt && <HoverCard c={hovered} x={hoverAt.x} y={hoverAt.y} flip={hoverAt.flip} />}
          {card && fleet.robots[card] && <TerminalCard key={card} id={card} host={size} />}
          <Toast corner={toastCorner(cardBox, size)} />
        </div>
        {lift && lifted && (
          <div className="kb-lift" style={{ left: lift.x - lift.dx, top: lift.y - lift.dy, width: lift.w }}>
            <BoardCard c={lifted} selected={false} arrived={false} lifted />
          </div>
        )}
      </div>
    </div>
  );
}
