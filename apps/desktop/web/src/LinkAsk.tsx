import { useEffect } from 'react';
import type { ContextItem } from '@svall/protocol';
import { app } from './boot.js';
import { openItem, openUrl } from './bridge.js';
import { openBeside, opensInside } from './browser.js';
import { useApp } from './hooks.js';
import { theme } from './theme.js';

export function followLink(item: ContextItem, charId: string | undefined, at: { x: number; y: number }): void {
  if (!charId || !opensInside(item)) { openItem(app.bridge, item); return; }
  app.store.getState().askLink({ item, charId, x: at.x, y: at.y });
}

export function LinkAsk() {
  const ask = useApp((s) => s.linkAsk);

  useEffect(() => {
    if (!ask) return;
    const close = () => app.store.getState().closeLinkAsk();
    // the card and the map both read Escape, so this one is taken before they see it
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key, true); };
  }, [ask]);

  if (!ask) return null;
  const here = () => { openBeside(app.store, app.browser(), ask.charId, ask.item.ref); app.store.getState().closeLinkAsk(); };
  const outside = () => { openUrl(app.bridge, ask.item.ref); app.store.getState().closeLinkAsk(); };

  return (
    <div className="linkask panel" data-testid="link-ask" role="dialog" aria-label="Where should this link open"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: Math.min(ask.x, window.innerWidth - theme.linkAsk.width - theme.linkAsk.margin),
        top: Math.min(ask.y + theme.linkAsk.gap, window.innerHeight - theme.linkAsk.height - theme.linkAsk.margin),
        width: theme.linkAsk.width,
      }}>
      <div className="linkask-ref mono">{ask.item.ref.replace(/^https?:\/\//, '')}</div>
      <button className="btn pri" data-testid="link-ask-here" onClick={here}>Open here</button>
      <button className="btn" data-testid="link-ask-outside" onClick={outside}>Open outside</button>
    </div>
  );
}
