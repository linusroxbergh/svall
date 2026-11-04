import { useEffect, useRef } from 'react';
import type { ContextItem, Robot } from '@svall/protocol';
import { app } from './boot.js';
import { openItem, openUrl } from './bridge.js';
import { openBeside, opensInside } from './browser.js';
import { CloseX } from './CloseX.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { terminalOn } from './MoveSheet.js';
import { cdLine } from './OnMachine.js';
import { homeName, machineName, myMachine, robotMachine } from './placement.js';
import { theme } from './theme.js';

// a path is on the machine of the robot that names it, or of the home for an island's; Finder cannot reach one elsewhere
function followPath(item: ContextItem, robotId: string | undefined): void {
  const s = app.store.getState();
  const c: Pick<Robot, 'machine'> = robotId !== undefined && Object.hasOwn(s.fleet.robots, robotId) ? s.fleet.robots[robotId] : {};
  const machine = robotMachine(c, s);
  if (machine === myMachine(s)) { openItem(app.bridge, item, machine); return; }
  const name = c.machine !== undefined && c.machine !== s.via?.home ? machineName(s.fleet, c.machine) : homeName(s.fleet, s.via!);
  const dir = item.kind === 'file' ? item.ref.slice(0, item.ref.lastIndexOf('/')) || '/' : item.ref;
  if (s.machines && !s.machines.find((m) => m.name === name)?.ssh) s.showToast(`${item.ref} is on ${name}; open it there`);
  else terminalOn(name, dir.startsWith('/') ? cdLine(dir) : undefined);
}

export function followLink(item: ContextItem, robotId: string | undefined, at: { x: number; y: number }): void {
  if (item.kind === 'file' || item.kind === 'folder') { followPath(item, robotId); return; }
  if (!robotId || !opensInside(item)) { openItem(app.bridge, item, undefined); return; }
  app.store.getState().askLink({ url: item.ref, robotId, x: at.x, y: at.y });
}

// a link from a terminal took its keys, and they go back once the link is answered
const giveBack = (surface?: string) => { if (surface) app.bridge.send({ type: 'term.focus', id: surface }); };

export function LinkAsk() {
  const ask = useApp((s) => s.linkAsk);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ask) return;
    const close = () => app.store.getState().closeLinkAsk();
    // the card and the map both read Escape, so this one is taken before they see it
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); giveBack(ask.surface); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    // a press on a terminal never reaches the page; the shell answers for those
    const off = app.bridge.onMessage((m) => { if (m.type === 'shell.pressedAway') close(); });
    // a terminal keeps the keys, where Escape would reach its agent instead of this
    if (ask.surface) app.bridge.send({ type: 'term.focus' });
    const release = box.current ? holdCutout(app.bridge, box.current) : undefined;
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key, true);
      off();
      release?.();
    };
  }, [ask]);

  if (!ask) return null;
  const here = () => { openBeside(app.store, app.browser(), ask.robotId, ask.url); app.store.getState().closeLinkAsk(); giveBack(ask.surface); };
  const outside = () => { openUrl(app.bridge, ask.url); app.store.getState().closeLinkAsk(); giveBack(ask.surface); };

  return (
    <div className="linkask panel" ref={box} data-testid="link-ask" role="dialog" aria-label="Where should this link open"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: Math.min(ask.x, window.innerWidth - theme.linkAsk.width - theme.linkAsk.margin),
        top: Math.min(ask.y + theme.linkAsk.gap, window.innerHeight - theme.linkAsk.height - theme.linkAsk.margin),
        width: theme.linkAsk.width,
      }}>
      <div className="linkask-head">
        <span className="linkask-ref mono">{ask.url.replace(/^https?:\/\//, '')}</span>
        <CloseX onClose={() => { app.store.getState().closeLinkAsk(); giveBack(ask.surface); }} testid="link-ask-close" />
      </div>
      <button className="btn sm pri" data-testid="link-ask-here" onClick={here}>Open here</button>
      <button className="btn sm" data-testid="link-ask-outside" onClick={outside}>Open outside</button>
    </div>
  );
}
