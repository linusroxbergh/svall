import { useRef, useState, type PointerEvent, type JSX } from 'react';
import { starredOf, type Robot, type Island } from '@svall/protocol';
import { createRobot } from '../actions.js';
import { memoByValue, useApp } from '../hooks.js';
import { elsewhere, homeName, machineName } from '../placement.js';
import { figureOf, figureUrl } from '../portraits.js';
import { islandCwd, startOf, statusOf, wantsUser } from '../selectors.js';
import { phone } from './boot.js';
import { CloseRobot } from './CloseRobot.js';
import { sections, statusLabel, subtitle, waiting } from './list.js';
import { dragOffset, isSwipe, REVEAL, settle } from './swipe.js';
import { IslandSheet } from './IslandSheet.js';
import { NewRobot } from './NewRobot.js';
import { NewIsland } from './NewIsland.js';
import { Settings } from './Settings.js';

type RowProps = { c: Robot; revealed: boolean; onOpen(id: string): void; onReveal(id?: string): void; onClose(id: string): void };

const Row = memoByValue(function Row({ c, revealed, onOpen, onReveal, onClose }: RowProps): JSX.Element {
  const status = useApp((s) => statusOf(c, s.fleet, s.via));
  const asks = useApp((s) => wantsUser(c, s.fleet, s.via));
  // a worker closes and marks read only its own robots
  const here = useApp((s) => !elsewhere(c, s.via));
  const sub = subtitle(c);
  const [drag, setDrag] = useState<number>();
  const touch = useRef<{ x: number; y: number; from: number; swiping: boolean }>(undefined);
  // the click that ends a swipe must not open the robot
  const swiped = useRef(false);
  const offset = drag ?? (revealed ? -REVEAL : 0);

  const down = (e: PointerEvent) => {
    swiped.current = false;
    if (!here) return;
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
          <span className="face figure"><img src={figureUrl(figureOf(c))} alt="" /></span>
          <span className="row-text">
            <span className="row-name">{c.name}{asks && <i className="pip" />}</span>
            {sub && <span className="row-sub">{sub}</span>}
          </span>
        </button>
        {c.unread && here
          ? <button type="button" className="row-read" aria-label={`Mark ${c.name} read`} onClick={() => phone.api().fire('robot.seen', { id: c.id })}>✓</button>
          : <span className="row-status">{statusLabel(status)}</span>}
      </div>
      {here && (
        <button type="button" className="row-close" style={{ width: REVEAL }} aria-label={`Close ${c.name}`} tabIndex={revealed ? 0 : -1} aria-hidden={!revealed}
          onClick={() => onClose(c.id)}>close</button>
      )}
    </div>
  );
});

type Open = { kind: 'island' } | { kind: 'robot'; islandId: string } | { kind: 'islandMenu'; islandId: string } | { kind: 'settings' } | { kind: 'close'; id: string };

export function Fleet({ onOpen }: { onOpen(id: string): void }): JSX.Element {
  const fleet = useApp((s) => s.fleet);
  const loaded = useApp((s) => s.loaded);
  const status = useApp((s) => s.status);
  // through a worker the page offers only what it answers: robots started there, and its own robots' terminals
  const via = useApp((s) => s.via);
  // a worker answers no island change, so through one every island shows open and none is made, folded or edited
  const islandEdits = !via;
  const [sheet, setSheet] = useState<Open>();
  const groups = sections(fleet, via);
  const starred = starredOf(fleet);
  const need = waiting(fleet, via);
  const close = () => setSheet(undefined);

  const [failed, setFailed] = useState<{ islandId: string; message: string }>();
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<string>();

  const add = async (islandId: string) => {
    if (adding) return;
    setAdding(true);
    setFailed(undefined);
    try {
      const c = await createRobot(phone.api(), { islandId, cwd: islandCwd(fleet, islandId), ...startOf(fleet, islandId) }, fleet.defaultCwd);
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
        {islandEdits && <button type="button" className="icon" aria-label="New island" onClick={() => setSheet({ kind: 'island' })}>+</button>}
        {!via && <button type="button" className="icon" aria-label="Settings" onClick={() => setSheet({ kind: 'settings' })}>⚙</button>}
        <span className="conn" data-status={status}>
          {status !== 'online' ? status : via ? `on ${machineName(fleet, via.machine)} · ${homeName(fleet, via)} asleep` : need ? `${need} waiting` : 'all quiet'}
        </span>
      </header>
      {status === 'refused' && <p className="empty">This tailnet login can't open this fleet. On the Mac, add it to mobile.logins in fleet.json, then quit and reopen Svall.</p>}
      {status === 'unpaired' && <p className="empty">This phone isn't paired with the fleet. Open the link from the QR code in Svall's phone panel on the Mac; a Home Screen app has to be removed and added again from that link.</p>}
      {loaded && groups.length === 0 && <p className="empty">No islands yet. Tap + to make one.</p>}
      {starred.length > 0 && (
        <section aria-label="Starred">
          <h2><span className="starred">Starred</span></h2>
          {/* a starred row swipes on its own, not with its twin on the island */}
          {starred.map((c) => (
            <Row key={c.id} c={c} revealed={revealed === `star:${c.id}`} onOpen={onOpen} onReveal={(id) => setRevealed(id && `star:${id}`)}
              onClose={(id) => { setRevealed(undefined); setSheet({ kind: 'close', id }); }} />
          ))}
        </section>
      )}
      {groups.map(({ island, robots }) => {
        const folded = island.collapsed && islandEdits;
        return (
        <section key={island.id}>
          <h2>
            <button type="button" className="fold" aria-expanded={!folded} onClick={() => { if (islandEdits) fold(island); }}>
              <i className="chev" />
              <span>{island.name}</span>
              {folded && robots.length > 0 && (
                <small>{robots.length}{robots.some((c) => wantsUser(c, fleet, via)) && <i className="pip" />}</small>
              )}
            </button>
            {islandEdits && <button type="button" className="icon" aria-label={`${island.name} options`} onClick={() => setSheet({ kind: 'islandMenu', islandId: island.id })}>…</button>}
            {/* the island's own folder is the Mac's, so a worker asks which of its own to start in; it starts no mission control */}
            {!(via && island.kind === 'home') && (
              <button type="button" className="icon add" aria-label={`New robot on ${island.name}`} disabled={adding}
                onClick={() => (via ? setSheet({ kind: 'robot', islandId: island.id }) : void add(island.id))}>+</button>
            )}
          </h2>
          {failed?.islandId === island.id && <p className="sheet-error">{failed.message}</p>}
          {!folded && robots.map((c) => (
            <Row key={c.id} c={c} revealed={revealed === c.id} onOpen={onOpen} onReveal={setRevealed}
              onClose={(id) => { setRevealed(undefined); setSheet({ kind: 'close', id }); }} />
          ))}
        </section>
        );
      })}
      {sheet?.kind === 'island' && islandEdits && <NewIsland onClose={close} />}
      {/* the folders it offers are those of the machine the page reaches, so a switch starts it over */}
      {sheet?.kind === 'robot' && <NewRobot key={via?.machine} islandId={sheet.islandId} onClose={close} onCreated={(id) => { close(); onOpen(id); }} />}
      {sheet?.kind === 'islandMenu' && islandEdits && <IslandSheet islandId={sheet.islandId} onClose={close} onOpen={onOpen} onNewRobot={() => setSheet({ kind: 'robot', islandId: sheet.islandId })} />}
      {sheet?.kind === 'settings' && !via && <Settings onClose={close} />}
      {sheet?.kind === 'close' && <CloseRobot id={sheet.id} onClose={close} />}
    </div>
  );
}
