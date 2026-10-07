import { useState } from 'react';
import { starredOf, type Character, type Island } from '@svall/protocol';
import { moveCharacterTo, newCharacterOn, newIsland, reorderIsland, saveCharacter, saveIsland, setStar, starCharacterAt, toggleIsland } from './actions.js';
import { app, deps } from './boot.js';
import type { DropTarget } from './drop.js';
import { useApp } from './hooks.js';
import { characterMenu, islandMenu } from './menus.js';
import { EyeGlyph, PrGlyph, reviewText } from './indicators.js';
import { boardIsland, boardViewed, charactersOf, inReview, isMonitoring, islandStatus, islandsSorted, isUnread, mainPr, STARRED, statusOf, wantsUser } from './selectors.js';

// what a folded island would hide: the characters that want the user
const attentionIn = (chars: Character[]): number => chars.filter(wantsUser).length;

const stop = (e: React.MouseEvent) => e.stopPropagation();

// a character dragged out of the list; the type alone is readable while the drag is in flight, the id only on the drop
const CHAR_DRAG = 'application/x-svall-character';
const ISLAND_DRAG = 'application/x-svall-island';
// a starred row dragged within its section; the islands below do not take it
const STAR_DRAG = 'application/x-svall-star';

const lowerHalf = (e: React.DragEvent) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY >= r.top + r.height / 2; };

const targetAt = (e: React.DragEvent, target: DropTarget): DropTarget =>
  target.kind === 'char' ? { ...target, after: lowerHalf(e) } : target;

// island rows accept a character; a character row inserts it before or after its midpoint
const dropZone = (target: DropTarget) => ({
  onDragOver: (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(CHAR_DRAG)) return;
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
    const id = e.dataTransfer.getData(CHAR_DRAG);
    if (!id) return;
    e.preventDefault();
    app.store.getState().setDropHover(undefined);
    moveCharacterTo(deps(), id, target, targetAt(e, target).after);
  },
});

// Enter or a click away hands back a changed name, Escape nothing
function NameField({ name, testid, onDone }: { name: string; testid: string; onDone(name?: string): void }) {
  return (
    <input
      autoFocus defaultValue={name} aria-label={`Rename ${name}`} data-testid={testid} onClick={stop}
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

// the board shows the terminal it selects; on the map that takes a card, so a click reads and a click on the
// row already selected opens — as does any click once a card is open, which the selection then moves to
const pick = (id: string) => { const s = app.store.getState(); if (s.view === 'board' || s.card || s.selectedId === id) s.focus(id); else s.select(id); };

export function StarIcon({ on }: { on: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M6 1.4 7.18 4.78l3.58.08-2.86 2.16 1.04 3.43L6 8.4l-2.94 2.05 1.04-3.43-2.86-2.16 3.58-.08z" />
    </svg>
  );
}

function StarButton({ c, testid }: { c: Character; testid: string }) {
  const on = c.star !== undefined;
  return (
    <button className="sb-star" data-testid={testid} aria-pressed={on} aria-label={`Star ${c.name}`} title={on ? 'Unstar' : 'Star'}
      onClick={(e) => { stop(e); setStar(deps(), c.id, !on); }}><StarIcon on={on} /></button>
  );
}

function IslandRow({ i, chars, editing, setEditing, dragging, setDragging }: {
  i: Island; chars: Character[]; editing: boolean; setEditing(id?: string): void; dragging: boolean; setDragging(id?: string): void;
}) {
  const fleet = useApp((s) => s.fleet);
  const onBoard = useApp((s) => s.view === 'board');
  const selected = useApp((s) => (s.view === 'board' ? boardIsland(s)?.id === i.id : s.selectedIslandId === i.id));
  const hover = useApp((s) => s.dropHover?.kind === 'island' && s.dropHover.id === i.id);
  const open = !i.collapsed;
  const status = islandStatus(fleet, i.id);
  const attention = attentionIn(chars);
  // on the board an island is a place to work, so it opens a character; on the map it is a thing to read
  const select = () => {
    const s = app.store.getState();
    if (!open) toggleIsland(deps(), i.id);
    if (onBoard && chars[0]) s.focus(chars[0].id); else s.selectIsland(i.id);
  };
  // the rename field keeps the text menu
  const menu = i.kind === 'home' || editing ? undefined : (e: React.MouseEvent) => islandMenu(e, i.id, chars.length === 0, () => setEditing(i.id));
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
      <span className="sb-ct tnum">{chars.length || '—'}</span>
      <i className="sdot" data-status={status} data-empty={chars.length === 0} />
      {chars.length > 0 && <button className="sb-char-add" data-testid={`sb-island-new-${i.id}`}
        title={`New character on ${i.name}`} aria-label={`New character on ${i.name}`}
        onClick={(e) => { stop(e); void newCharacterOn(deps(), i.id); }} onDoubleClick={stop}>+</button>}
    </div>
  );
}

// a PR in review and a running monitor, marked without words; the title spells them out
function Marks({ c }: { c: Character }) {
  const pr = inReview(c) ? mainPr(c) : undefined;
  const monitor = isMonitoring(c);
  if (!pr && !monitor) return null;
  const title = [pr && reviewText(pr), monitor && 'Monitoring'].filter(Boolean).join(' · ');
  return <span className="sb-ind" title={title}>{pr && <i data-kind="review"><PrGlyph /></i>}{monitor && <i data-kind="monitor"><EyeGlyph /></i>}</span>;
}

function CharacterRow({ c, editing, setEditing }: { c: Character; editing: boolean; setEditing(id?: string): void }) {
  const selected = useApp((s) => (s.view === 'board' ? boardViewed(s) === c.id : s.selectedId === c.id));
  const hover = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === c.id);
  const reorderHover = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === c.id && s.dropHover.after !== undefined);
  const hoverAfter = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === c.id && s.dropHover.after);
  const [dragging, setDragging] = useState(false);
  const status = statusOf(c);
  return (
    <div
      className="sb-row sb-child" data-testid={`sb-char-${c.id}`} data-status={status} data-unread={isUnread(c)}
      data-attention={wantsUser(c)} data-selected={selected}
      data-drop={`char:${c.id}`} data-drop-hover={hover} data-drop-reorder={reorderHover} data-drop-after={hoverAfter} {...dropZone({ kind: 'char', id: c.id })}
      draggable={!editing} data-dragging={dragging}
      onDragStart={(e) => { e.dataTransfer.setData(CHAR_DRAG, c.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => { setDragging(false); app.store.getState().setDropHover(undefined); }}
      onClick={() => pick(c.id)}
      onContextMenu={editing ? undefined : (e) => characterMenu(e, c.id, () => setEditing(c.id))}
    >
      <i className="sdot" data-status={status} />
      {editing ? (
        <NameField name={c.name} testid="char-name-input" onDone={(name) => {
          setEditing(undefined);
          if (name) saveCharacter(deps(), c.id, { name });
        }} />
      ) : (
        <span className="sb-name">{c.name}</span>
      )}
      {!editing && <Marks c={c} />}
      {!editing && <StarButton c={c} testid={`sb-char-star-${c.id}`} />}
    </div>
  );
}

// a row in Starred drops before or after its midpoint; the header, or a folded section, takes it first
type StarHover = { id?: string; after: boolean };

function StarredRow({ c, hover, zone }: { c: Character; hover?: StarHover; zone: ReturnType<typeof starZone> }) {
  const selected = useApp((s) => (s.view === 'board' ? boardViewed(s) === c.id : s.selectedId === c.id));
  const island = useApp((s) => s.fleet.islands[c.islandId]?.name);
  // a Finder file over this character; a reorder over its tree row carries `after` and leaves this row be
  const fileHover = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === c.id && s.dropHover.after === undefined);
  const [dragging, setDragging] = useState(false);
  const status = statusOf(c);
  return (
    <div className="sb-row sb-child sb-starred-row" data-testid={`sb-star-${c.id}`} data-status={status} data-unread={isUnread(c)}
      data-attention={wantsUser(c)} data-selected={selected} data-drop={`char:${c.id}`} data-drop-hover={fileHover}
      data-drop-reorder={hover?.id === c.id} data-drop-after={hover?.id === c.id && hover.after}
      draggable data-dragging={dragging} {...zone}
      onDragStart={(e) => { e.dataTransfer.setData(STAR_DRAG, c.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      onClick={() => pick(c.id)} onContextMenu={(e) => characterMenu(e, c.id)}>
      <i className="sdot" data-status={status} />
      <span className="sb-name">{c.name}</span>
      <Marks c={c} />
      <span className="sb-where">{island}</span>
      <StarButton c={c} testid={`sb-star-toggle-${c.id}`} />
    </div>
  );
}

const draggedStar = (e: React.DragEvent) => e.dataTransfer.types.includes(STAR_DRAG) || e.dataTransfer.types.includes(CHAR_DRAG);

// a starred row or a tree character dropped here is starred at that spot
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
      const moving = e.dataTransfer.getData(STAR_DRAG) || e.dataTransfer.getData(CHAR_DRAG);
      if (!moving) return;
      e.preventDefault();
      setHover(() => undefined);
      starCharacterAt(deps(), moving, id, id !== undefined && lowerHalf(e));
    },
  };
}

function Starred() {
  const fleet = useApp((s) => s.fleet);
  const shut = useApp((s) => s.sections[STARRED]?.shut ?? false);
  const [hover, setHover] = useState<StarHover>();
  const chars = starredOf(fleet);
  if (chars.length === 0) return null;
  const attention = attentionIn(chars);
  const fold = () => app.store.getState().setSection(STARRED, { shut: !shut });
  return (
    <div className="sb-folder" data-testid="sb-starred">
      <div className="sb-row sb-isle" data-testid="sb-starred-head" data-open={!shut} data-drop-hover={hover !== undefined && hover.id === undefined}
        {...starZone(undefined, setHover)} onClick={fold}>
        <button className="sb-caret" data-testid="sb-starred-toggle" aria-expanded={!shut} aria-label={shut ? 'Expand starred' : 'Collapse starred'}
          onClick={(e) => { stop(e); fold(); }}><Caret open={!shut} /></button>
        <span className="sb-name">Starred</span>
        {shut && attention > 0 && <span className="sb-attn" data-testid="sb-starred-attention">{attention}</span>}
        <span className="sb-ct tnum">{chars.length}</span>
        <i className="sb-star-mark"><StarIcon on /></i>
      </div>
      {!shut && <div className="sb-kids">{chars.map((c) => <StarredRow key={c.id} c={c} hover={hover} zone={starZone(c.id, setHover)} />)}</div>}
    </div>
  );
}

export function Sidebar() {
  const fleet = useApp((s) => s.fleet);
  const active = useApp((s) => s.active);
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
    <aside className="sb" data-testid="sidebar" data-paused={!active}>
      <div className="sb-head">
        islands
        <button className="sb-add" data-testid="sidebar-new-island" onClick={() => newIsland(deps())}>+ New island</button>
      </div>
      <button className="sb-collapse" data-testid="sidebar-hide" title="Hide the islands" aria-label="Hide the islands"
        onClick={() => app.store.getState().toggleSidebar(false)}>‹</button>
      <div className="sb-list">
        <Starred />
        {islandsSorted(fleet).map((i) => {
          const chars = charactersOf(fleet, i.id);
          return (
            <div key={i.id} className="sb-folder" data-testid={`sb-folder-${i.id}`} {...reorderZone(i)}
              data-drop-reorder={islandHover?.id === i.id} data-drop-after={islandHover?.id === i.id && islandHover.after}>
              <IslandRow i={i} chars={chars} editing={editing === i.id} setEditing={setEditing} dragging={dragIsland === i.id} setDragging={setDragging} />
              {!i.collapsed && chars.length === 0 && <div className="sb-kids"><button className="sb-row sb-char-empty" data-testid={`sb-island-new-${i.id}`}
                aria-label={`New character on ${i.name}`} onClick={() => void newCharacterOn(deps(), i.id)}><i className="sb-plus" aria-hidden="true">+</i>New character</button></div>}
              {!i.collapsed && chars.length > 0 && (
                <div className="sb-kids">{chars.map((c) => <CharacterRow key={c.id} c={c} editing={editing === c.id} setEditing={setEditing} />)}</div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
