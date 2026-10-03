import { useRef, useState, type PointerEvent, type JSX } from 'react';
import type { Character, Island } from '@svall/protocol';
import { createCharacter } from '../actions.js';
import { useApp } from '../hooks.js';
import { portraitTint, portraitUrl } from '../portraits.js';
import { islandCwd, startOf, statusOf, wantsUser } from '../selectors.js';
import { phone } from './boot.js';
import { CloseCharacter } from './CloseCharacter.js';
import { sections, statusLabel, subtitle, waiting } from './list.js';
import { dragOffset, isSwipe, REVEAL, settle } from './swipe.js';
import { IslandSheet } from './IslandSheet.js';
import { NewCharacter } from './NewCharacter.js';
import { NewIsland } from './NewIsland.js';
import { Settings } from './Settings.js';

type RowProps = { c: Character; revealed: boolean; onOpen(id: string): void; onReveal(id?: string): void; onClose(id: string): void };

function Row({ c, revealed, onOpen, onReveal, onClose }: RowProps): JSX.Element {
  const status = statusOf(c);
  const sub = subtitle(c);
  const [drag, setDrag] = useState<number>();
  const touch = useRef<{ x: number; y: number; from: number; swiping: boolean }>(undefined);
  // the click that ends a swipe must not open the character
  const swiped = useRef(false);
  const offset = drag ?? (revealed ? -REVEAL : 0);

  const down = (e: PointerEvent) => {
    swiped.current = false;
    touch.current = { x: e.clientX, y: e.clientY, from: revealed ? -REVEAL : 0, swiping: false };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t) return;
    const dx = e.clientX - t.x;
    if (!t.swiping) {
      if (!isSwipe(dx, e.clientY - t.y)) return;
      t.swiping = true;
      swiped.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setDrag(dragOffset(t.from, dx));
  };
  const up = () => {
    if (touch.current?.swiping) onReveal(settle(drag ?? 0) < 0 ? c.id : undefined);
    touch.current = undefined;
    setDrag(undefined);
  };
  const tap = () => {
    if (swiped.current) return;
    if (revealed) onReveal(undefined);
    else onOpen(c.id);
  };

  return (
    <div className="row" data-status={status}>
      <div className="row-slide" data-dragging={drag !== undefined || undefined} style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <button type="button" className="row-main" onClick={tap}>
          <span className={`face tint-${portraitTint(c.portrait)}`}>
            <img src={portraitUrl(c.portrait)} alt="" />
          </span>
          <span className="row-text">
            <span className="row-name">{c.name}{wantsUser(c) && <i className="pip" />}</span>
            {sub && <span className="row-sub">{sub}</span>}
          </span>
        </button>
        {c.unread
          ? <button type="button" className="row-read" aria-label={`Mark ${c.name} read`} onClick={() => phone.api().fire('char.seen', { id: c.id })}>✓</button>
          : <span className="row-status">{statusLabel(status)}</span>}
      </div>
      <button type="button" className="row-close" style={{ width: REVEAL }} aria-label={`Close ${c.name}`} tabIndex={revealed ? 0 : -1} aria-hidden={!revealed}
        onClick={() => onClose(c.id)}>close</button>
    </div>
  );
}

type Open = { kind: 'island' } | { kind: 'char'; islandId: string } | { kind: 'islandMenu'; islandId: string } | { kind: 'settings' } | { kind: 'close'; id: string };

export function Fleet({ onOpen }: { onOpen(id: string): void }): JSX.Element {
  const fleet = useApp((s) => s.fleet);
  const loaded = useApp((s) => s.loaded);
  const status = useApp((s) => s.status);
  const [sheet, setSheet] = useState<Open>();
  const groups = sections(fleet);
  const need = waiting(fleet);
  const close = () => setSheet(undefined);

  const [failed, setFailed] = useState<{ islandId: string; message: string }>();
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<string>();

  const add = async (islandId: string) => {
    if (adding) return;
    setAdding(true);
    setFailed(undefined);
    try {
      const c = await createCharacter(phone.api(), { islandId, cwd: islandCwd(fleet, islandId), ...startOf(fleet, islandId) }, fleet.defaultCwd);
      onOpen(c.id);
    } catch (e) {
      setFailed({ islandId, message: (e as Error).message });
      setAdding(false);
    }
  };

  const fold = (island: Island) => {
    setRevealed(undefined);
    setFailed(undefined);
    phone.api().call('island.update', { id: island.id, collapsed: !island.collapsed })
      .catch((e: Error) => setFailed({ islandId: island.id, message: e.message }));
  };

  return (
    <div className="fleet">
      <header className="top">
        <h1>{document.title}</h1>
        <button type="button" className="icon" aria-label="New island" onClick={() => setSheet({ kind: 'island' })}>+</button>
        <button type="button" className="icon" aria-label="Settings" onClick={() => setSheet({ kind: 'settings' })}>⚙</button>
        <span className="conn" data-status={status}>
          {status === 'online' ? (need ? `${need} waiting` : 'all quiet') : status}
        </span>
      </header>
      {status === 'refused' && <p className="empty">This tailnet login can't open this fleet. On the Mac, add it to mobile.logins in the fleet's config.json, then quit and reopen Svall.</p>}
      {loaded && groups.length === 0 && <p className="empty">No islands yet. Tap + to make one.</p>}
      {groups.map(({ island, characters }) => (
        <section key={island.id}>
          <h2>
            <button type="button" className="fold" aria-expanded={!island.collapsed} onClick={() => fold(island)}>
              <i className="chev" />
              <span>{island.name}</span>
              {island.collapsed && characters.length > 0 && (
                <small>{characters.length}{characters.some(wantsUser) && <i className="pip" />}</small>
              )}
            </button>
            <button type="button" className="icon" aria-label={`${island.name} options`} onClick={() => setSheet({ kind: 'islandMenu', islandId: island.id })}>…</button>
            <button type="button" className="icon add" aria-label={`New character on ${island.name}`} disabled={adding} onClick={() => void add(island.id)}>+</button>
          </h2>
          {failed?.islandId === island.id && <p className="sheet-error">{failed.message}</p>}
          {!island.collapsed && characters.map((c) => (
            <Row key={c.id} c={c} revealed={revealed === c.id} onOpen={onOpen} onReveal={setRevealed}
              onClose={(id) => { setRevealed(undefined); setSheet({ kind: 'close', id }); }} />
          ))}
        </section>
      ))}
      {sheet?.kind === 'island' && <NewIsland onClose={close} />}
      {sheet?.kind === 'char' && <NewCharacter islandId={sheet.islandId} onClose={close} onCreated={(id) => { close(); onOpen(id); }} />}
      {sheet?.kind === 'islandMenu' && <IslandSheet islandId={sheet.islandId} onClose={close} onNewCharacter={() => setSheet({ kind: 'char', islandId: sheet.islandId })} />}
      {sheet?.kind === 'settings' && <Settings onClose={close} />}
      {sheet?.kind === 'close' && <CloseCharacter id={sheet.id} onClose={close} />}
    </div>
  );
}
