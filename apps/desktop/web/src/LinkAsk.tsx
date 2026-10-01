import { useEffect, useRef } from 'react';
import type { ContextItem } from '@svall/protocol';
import { app } from './boot.js';
import { openItem, openUrl } from './bridge.js';
import { openBeside, opensInside } from './browser.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { theme } from './theme.js';

export function followLink(item: ContextItem, charId: string | undefined, at: { x: number; y: number }): void {
  if (!charId || !opensInside(item)) { openItem(app.bridge, item); return; }
  app.store.getState().askLink({ url: item.ref, charId, x: at.x, y: at.y });
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
  const here = () => { openBeside(app.store, app.browser(), ask.charId, ask.url); app.store.getState().closeLinkAsk(); giveBack(ask.surface); };
  const outside = () => { openUrl(app.bridge, ask.url); app.store.getState().closeLinkAsk(); giveBack(ask.surface); };

  return (
    <div className="linkask panel" ref={box} data-testid="link-ask" role="dialog" aria-label="Where should this link open"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: Math.min(ask.x, window.innerWidth - theme.linkAsk.width - theme.linkAsk.margin),
        top: Math.min(ask.y + theme.linkAsk.gap, window.innerHeight - theme.linkAsk.height - theme.linkAsk.margin),
        width: theme.linkAsk.width,
      }}>
      <div className="linkask-ref mono">{ask.url.replace(/^https?:\/\//, '')}</div>
      <button className="btn pri" data-testid="link-ask-here" onClick={here}>Open here</button>
      <button className="btn" data-testid="link-ask-outside" onClick={outside}>Open outside</button>
    </div>
  );
}
