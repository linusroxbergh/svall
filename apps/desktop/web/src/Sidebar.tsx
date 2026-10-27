import { memo, useState } from 'react';
import { starredOf, type FleetState, type Robot, type Island } from '@svall/protocol';
import { moveRobotTo, newRobotOn, newIsland, reorderIsland, saveRobot, saveIsland, setStar, starRobotAt, toggleIsland } from './actions.js';
import { app, deps } from './boot.js';
import type { DropTarget } from './drop.js';
import { memoByValue, stop, useApp, usePanelWidth } from './hooks.js';
import { robotMenu, islandMenu } from './menus.js';
import { EyeGlyph, MachineGlyph, PrGlyph, reviewText } from './indicators.js';
import { isPlaced, machineName } from './placement.js';
import { robotsOf, inReview, isMonitoring, islandStatus, islandsSorted, isUnread, mainPr, resumeErrorOf, STARRED, statusOf, wantsUser } from './selectors.js';

// what a folded island would hide: the robots that want the user
const attentionIn = (robots: Robot[], f: Pick<FleetState, 'machines'>): number => robots.filter((c) => wantsUser(c, f)).length;

// a robot dragged out of the list; the type alone is readable while the drag is in flight, the id only on the drop
const ROBOT_DRAG = 'application/x-svall-robot';
const ISLAND_DRAG = 'application/x-svall-island';
// a starred row dragged within its section; the islands below do not take it
const STAR_DRAG = 'application/x-svall-star';

const lowerHalf = (e: React.DragEvent) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY >= r.top + r.height / 2; };

const targetAt = (e: React.DragEvent, target: DropTarget): DropTarget =>
  target.kind === 'robot' ? { ...target, after: lowerHalf(e) } : target;

// island rows accept a robot; a robot row inserts it before or after its midpoint
const dropZone = (target: DropTarget) => ({
  onDragOver: (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(ROBOT_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    app.store.getState().setDropHover(targetAt(e, target));
  },
  // the pointer crossing a child of the row is still on the row; only a leave for somewhere else gives up the outline
  onDragLeave: (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    const { dropHover, setDropHover } = app.store.getState();
    if (dropHover?.kind === target.kind && dropHover.id === target.id) setDropHover(undefined);
  },
  onDrop: (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(ROBOT_DRAG);
    if (!id) return;
    e.preventDefault();
    app.store.getState().setDropHover(undefined);
    moveRobotTo(deps(), id, target, targetAt(e, target).after);
  },
});

// Enter or a click away hands back a changed name, Escape nothing
function NameField({ name, testid, onDone }: { name: string; testid: string; onDone(name?: string): void }) {
  return (
    <input
      className="fld" autoFocus defaultValue={name} aria-label={`Rename ${name}`} data-testid={testid} onClick={stop}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}
      onBlur={(e) => { const next = e.currentTarget.value.trim(); onDone(next && next !== name ? next : undefined); }}
    />
  );
}

export function Caret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={open ? 'M2 3.6 5 6.6l3-3' : 'M3.6 2l3 3-3 3'} />
    </svg>
  );
}

// a click reads and a click on the row already selected opens the card — as does any click once a card is open,
// which the selection then moves to
const pick = (id: string, starred = false) => {
  const s = app.store.getState();
  if (s.card || s.selectedId === id) s.focus(id); else s.select(id);
  s.setStarredRow(starred ? id : undefined);
};

export function StarIcon({ on }: { on: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M6 1.4 7.18 4.78l3.58.08-2.86 2.16 1.04 3.43L6 8.4l-2.94 2.05 1.04-3.43-2.86-2.16 3.58-.08z" />
    </svg>
  );
}

function StarButton({ c, testid }: { c: Robot; testid: string }) {
  const on = c.star !== undefined;
  return (
    <button className="sb-star" data-testid={testid} aria-pressed={on} aria-label={`Star ${c.name}`} title={on ? 'Unstar' : 'Star'}
      onClick={(e) => { stop(e); setStar(deps(), c.id, !on); }}><StarIcon on={on} /></button>
  );
}

const IslandRow = memoByValue(function IslandRow({ i, robots, editing, setEditing, dragging, setDragging }: {
  i: Island; robots: Robot[]; editing: boolean; setEditing(id?: string): void; dragging: boolean; setDragging(id?: string): void;
}) {
  const status = useApp((s) => islandStatus(s.fleet, i.id));
  const selected = useApp((s) => s.selectedIslandId === i.id);
  const hover = useApp((s) => s.dropHover?.kind === 'island' && s.dropHover.id === i.id);
  const open = !i.collapsed;
  const attention = useApp((s) => attentionIn(robots, s.fleet));
  const select = () => {
    if (!open) toggleIsland(deps(), i.id);
    app.store.getState().selectIsland(i.id);
  };
  // the rename field keeps the text menu
  const menu = i.kind === 'home' || editing ? undefined : (e: React.MouseEvent) => islandMenu(e, i.id, robots.length === 0, () => setEditing(i.id));
  return (
    <div className="sb-row sb-isle" data-testid={`sb-island-${i.id}`} data-selected={selected} data-open={open}
      data-drop={`island:${i.id}`} data-drop-hover={hover} {...dropZone({ kind: 'island', id: i.id })}
      draggable={i.kind !== 'home' && !editing} data-dragging={dragging}
      onDragStart={(e) => { e.dataTransfer.setData(ISLAND_DRAG, i.id); e.dataTransfer.effectAllowed = 'move'; setDragging(i.id); }}
      onDragEnd={() => setDragging(undefined)}
      onClick={select} onDoubleClick={() => setEditing(i.id)} onContextMenu={menu}>
      <button className="sb-caret" data-testid={`sb-island-toggle-${i.id}`} aria-expanded={open}
        aria-label={open ? `Collapse ${i.name}` : `Expand ${i.name}`}
        onClick={(e) => { stop(e); toggleIsland(deps(), i.id); }} onDoubleClick={stop}><Caret open={open} /></button>
      {editing ? (
        <NameField name={i.name} testid="island-name-input" onDone={(name) => {
          setEditing(undefined);
          if (name) saveIsland(deps(), i.id, { name });
        }} />
      ) : (
        <span className="sb-name" data-testid="island-name">{i.name}</span>
      )}
      {!open && attention > 0 && <span className="sb-attn" data-testid={`sb-island-attention-${i.id}`}>{attention}</span>}
      <span className="sb-ct tnum">{robots.length || '—'}</span>
      <i className="sdot" data-status={status} data-empty={robots.length === 0} />
      {robots.length > 0 && <button className="sb-robot-add" data-testid={`sb-island-new-${i.id}`}
        title={`New robot on ${i.name}`} aria-label={`New robot on ${i.name}`}
        onClick={(e) => { stop(e); void newRobotOn(deps(), i.id); }} onDoubleClick={stop}>+</button>}
    </div>
  );
});

// a PR in review and a running monitor, marked without words; the title spells them out
function Marks({ c }: { c: Robot }) {
  const pr = inReview(c) ? mainPr(c) : undefined;
  const monitor = isMonitoring(c);
  if (!pr && !monitor) return null;
  const title = [pr && reviewText(pr), monitor && 'Monitoring'].filter(Boolean).join(' · ');
  return <span className="sb-ind" title={title}>{pr && <i data-kind="review"><PrGlyph /></i>}{monitor && <i data-kind="monitor"><EyeGlyph /></i>}</span>;
}

// a robot on a worker names the machine on a line under its name
function RobotName({ c, title }: { c: Robot; title?: string }) {
  const on = useApp((s) => (isPlaced(c) ? machineName(s.fleet, c.machine) : undefined));
  const name = <span className="sb-name" title={title}>{c.name}</span>;
  return on ? <span className="sb-names">{name}<span className="sb-on" data-testid={`sb-machine-${c.id}`}><MachineGlyph /><span>on {on}</span></span></span> : name;
}

const RobotRow = memo(function RobotRow({ c, editing, setEditing }: { c: Robot; editing: boolean; setEditing(id?: string): void }) {
  const selected = useApp((s) => s.selectedId === c.id);
  const hover = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === c.id);
  const reorderHover = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === c.id && s.dropHover.after !== undefined);
  const hoverAfter = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === c.id && s.dropHover.after);
  const failed = resumeErrorOf(c);
  const [dragging, setDragging] = useState(false);
  const status = useApp((s) => statusOf(c, s.fleet));
  const attention = useApp((s) => wantsUser(c, s.fleet));
  return (
    <div
      className="sb-row sb-child" data-testid={`sb-robot-${c.id}`} data-status={status} data-unread={isUnread(c)}
      data-attention={attention} data-selected={selected}
      data-drop={`robot:${c.id}`} data-drop-hover={hover} data-drop-reorder={reorderHover} data-drop-after={hoverAfter} {...dropZone({ kind: 'robot', id: c.id })}
      draggable={!editing} data-dragging={dragging}
      onDragStart={(e) => { e.dataTransfer.setData(ROBOT_DRAG, c.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => { setDragging(false); app.store.getState().setDropHover(undefined); }}
      onClick={() => pick(c.id)}
      onContextMenu={editing ? undefined : (e) => robotMenu(e, c.id, () => setEditing(c.id))}
    >
      <i className="sdot" data-status={status} />
      {editing ? (
        <NameField name={c.name} testid="robot-name-input" onDone={(name) => {
          setEditing(undefined);
          if (name) saveRobot(deps(), c.id, { name });
        }} />
      ) : (
        <>
          <RobotName c={c} />
          {failed && <span className="sb-sub mono" data-testid={`sb-resume-error-${c.id}`} title={failed}>resume failed</span>}
        </>
      )}
      {!editing && <Marks c={c} />}
      {!editing && <StarButton c={c} testid={`sb-robot-star-${c.id}`} />}
    </div>
  );
});

// a row in Starred drops before or after its midpoint; the header, or a folded section, takes it first
type StarHover = { id?: string; after: boolean };

function StarredRow({ c, hover, zone }: { c: Robot; hover?: StarHover; zone: ReturnType<typeof starZone> }) {
  const selected = useApp((s) => s.selectedId === c.id);
  const island = useApp((s) => s.fleet.islands[c.islandId]?.name);
  // a Finder file over this robot; a reorder over its tree row carries `after` and leaves this row be
  const fileHover = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === c.id && s.dropHover.after === undefined);
  const [dragging, setDragging] = useState(false);
  const status = useApp((s) => statusOf(c, s.fleet));
  const attention = useApp((s) => wantsUser(c, s.fleet));
  return (
    <div className="sb-row sb-child sb-starred-row" data-testid={`sb-star-${c.id}`} data-status={status} data-unread={isUnread(c)}
      data-attention={attention} data-selected={selected} data-drop={`robot:${c.id}`} data-drop-hover={fileHover}
      data-drop-reorder={hover?.id === c.id} data-drop-after={hover?.id === c.id && hover.after}
      draggable data-dragging={dragging} {...zone}
      onDragStart={(e) => { e.dataTransfer.setData(STAR_DRAG, c.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      onClick={() => pick(c.id, true)} onContextMenu={(e) => robotMenu(e, c.id)}>
      <i className="sdot" data-status={status} />
      <RobotName c={c} title={c.name} />
      <span className="sb-where"><span>{island}</span></span>
      <Marks c={c} />
      <StarButton c={c} testid={`sb-star-toggle-${c.id}`} />
    </div>
  );
}

const draggedStar = (e: React.DragEvent) => e.dataTransfer.types.includes(STAR_DRAG) || e.dataTransfer.types.includes(ROBOT_DRAG);

// a starred row or a tree robot dropped here is starred at that spot
function starZone(id: string | undefined, setHover: (f: (h?: StarHover) => StarHover | undefined) => void) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!draggedStar(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = id !== undefined && lowerHalf(e);
      setHover((h) => (h && h.id === id && h.after === after ? h : { id, after }));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setHover((h) => (h?.id === id ? undefined : h));
    },
    onDrop: (e: React.DragEvent) => {
      const moving = e.dataTransfer.getData(STAR_DRAG) || e.dataTransfer.getData(ROBOT_DRAG);
      if (!moving) return;
      e.preventDefault();
      setHover(() => undefined);
      starRobotAt(deps(), moving, id, id !== undefined && lowerHalf(e));
    },
  };
}

function Starred() {
  const fleet = useApp((s) => s.fleet);
  const shut = useApp((s) => s.sections[STARRED]?.shut ?? false);
  const [hover, setHover] = useState<StarHover>();
  const robots = starredOf(fleet);
  if (robots.length === 0) return null;
  const attention = attentionIn(robots, fleet);
  const fold = () => app.store.getState().setSection(STARRED, { shut: !shut });
  return (
    <div className="sb-folder" data-testid="sb-starred">
      <div className="sb-row sb-isle" data-testid="sb-starred-head" data-open={!shut} data-drop-hover={hover !== undefined && hover.id === undefined}
        {...starZone(undefined, setHover)} onClick={fold}>
        <button className="sb-caret" data-testid="sb-starred-toggle" aria-expanded={!shut} aria-label={shut ? 'Expand starred' : 'Collapse starred'}
          onClick={(e) => { stop(e); fold(); }}><Caret open={!shut} /></button>
        <span className="sb-name">Starred</span>
        {shut && attention > 0 && <span className="sb-attn" data-testid="sb-starred-attention">{attention}</span>}
        <span className="sb-ct tnum">{robots.length}</span>
        <i className="sb-star-mark"><StarIcon on /></i>
      </div>
      {!shut && <div className="sb-kids">{robots.map((c) => <StarredRow key={c.id} c={c} hover={hover} zone={starZone(c.id, setHover)} />)}</div>}
    </div>
  );
}

// the press brings up Sparkle's window for the release update.available named
function UpdateRow() {
  const version = useApp((s) => s.update);
  if (!version) return null;
  return (
    <button className="sb-update" data-testid="sidebar-update" onClick={() => app.bridge.send({ type: 'update.install' })}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
      </svg>
      Update to {version}
    </button>
  );
}

export function Sidebar() {
  const fleet = useApp((s) => s.fleet);
  const active = useApp((s) => s.active);
  const width = usePanelWidth('sidebar');
  const [editing, setEditing] = useState<string>();
  const [dragIsland, setDragIsland] = useState<string>();
  const [islandHover, setIslandHover] = useState<{ id: string; after: boolean }>();
  // a dragged island lands before or after the folder it is dropped on; mission control stays last
  const reorderZone = (i: Island) => (!dragIsland || dragIsland === i.id || i.kind === 'home' ? {} : {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(ISLAND_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = lowerHalf(e);
      setIslandHover((h) => (h?.id === i.id && h.after === after ? h : { id: i.id, after }));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setIslandHover((h) => (h?.id === i.id ? undefined : h));
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(ISLAND_DRAG);
      if (!id) return;
      e.preventDefault();
      setIslandHover(undefined);
      reorderIsland(deps(), id, i.id, lowerHalf(e));
    },
  });
  const setDragging = (id?: string) => { setDragIsland(id); if (!id) setIslandHover(undefined); };

  return (
    <aside className="sb" style={width} data-testid="sidebar" data-paused={!active}>
      <div className="sb-head">
        islands
        <button className="sb-add" data-testid="sidebar-new-island" onClick={() => newIsland(deps())}>+ New island</button>
      </div>
      <button className="sb-collapse" data-testid="sidebar-hide" title="Hide the islands" aria-label="Hide the islands"
        onClick={() => app.store.getState().toggleSidebar(false)}>‹</button>
      <div className="sb-list">
        <Starred />
        {islandsSorted(fleet).map((i) => {
          const robots = robotsOf(fleet, i.id);
          return (
            <div key={i.id} className="sb-folder" data-testid={`sb-folder-${i.id}`} {...reorderZone(i)}
              data-drop-reorder={islandHover?.id === i.id} data-drop-after={islandHover?.id === i.id && islandHover.after}>
              <IslandRow i={i} robots={robots} editing={editing === i.id} setEditing={setEditing} dragging={dragIsland === i.id} setDragging={setDragging} />
              {!i.collapsed && robots.length === 0 && <div className="sb-kids"><button className="sb-row sb-robot-empty" data-testid={`sb-island-new-${i.id}`}
                aria-label={`New robot on ${i.name}`} onClick={() => void newRobotOn(deps(), i.id)}><i className="sb-plus" aria-hidden="true">+</i>New robot</button></div>}
              {!i.collapsed && robots.length > 0 && (
                <div className="sb-kids">{robots.map((c) => <RobotRow key={c.id} c={c} editing={editing === c.id} setEditing={setEditing} />)}</div>
              )}
            </div>
          );
        })}
      </div>
      <UpdateRow />
    </aside>
  );
}
