import { useEffect, useRef, useState } from 'react';
import { app } from '../boot.js';
import { rectOf } from '../BrowserArea.js';
import { useApp } from '../hooks.js';
import { CharPanes } from '../CharPanes.js';
import { useHalfGrip } from '../halfGrip.js';
import { statusOf } from '../selectors.js';
import { theme } from '../theme.js';
import { cardRect } from './card.js';

type Props = { id: string; host: { w: number; h: number } };

export function TerminalCard({ id, host }: Props) {
  const c = useApp((s) => s.fleet.characters[id]);
  const size = useApp((s) => s.cardSize);
  const half = useApp((s) => s.halfCard);
  const opacity = useApp((s) => (size === 'full' ? s.settings.fullOpacity : s.settings.cardOpacity));
  const rect = cardRect({ size, win: host, half });
  const ref = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(true);
  const { resizing, grip } = useHalfGrip(() => app.store.getState().halfCard, (v, persist) => app.store.getState().setHalfCard(v, persist), () => host);

  // the card eases to a new size in CSS; the surface follows the body per frame until the transition ends
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSettled(false);
    const start = performance.now();
    let raf = 0;
    const step = () => {
      for (const body of el.querySelectorAll<HTMLElement>('[data-testid="surface"]')) {
        const key = body.dataset.term;
        if (!key || !app.store.getState().terminals[key]) continue;
        const r = body.getBoundingClientRect();
        app.manager().move(key, { x: r.left, y: r.top, width: r.width, height: r.height });
      }
      const web = el.querySelector<HTMLElement>('[data-testid="browser-surface"]');
      const tab = web?.dataset.tab;
      if (web && tab && app.store.getState().webviews[tab]) app.browser().move(tab, rectOf(web));
      if (performance.now() - start < theme.card.easeMs + 20) raf = requestAnimationFrame(step); else setSettled(true);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [id, rect.x, rect.y, rect.width, rect.height]);

  if (!c) return null;
  const status = statusOf(c);
  return (
    // a wheel and a double click inside the card are the card's: the map under it pans on one and makes an island on the other
    <div ref={ref} className="terminal-card panel" data-testid="terminal-card" data-char={id} data-size={size} data-settled={settled} data-resizing={resizing}
      onWheel={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <div className="card-body">
        <CharPanes key={id} id={id} opacity={opacity}
          lead={<span className="tname-row"><i className="sdot" data-status={status} /><span className="tname">{c.name}</span></span>}
          trail={
            <span className="tctl">
              <button className="ticon" data-testid="card-size" title={size === 'half' ? 'Fill the window' : 'Back to the card'}
                aria-label={size === 'half' ? 'Fill the window' : 'Back to the card'} onClick={() => app.store.getState().toggleCardSize()}>{size === 'half' ? '⤢' : '⤡'}</button>
              <button className="tx" data-testid="card-close" title="Close" aria-label="Close the card"
                onClick={() => app.store.getState().closeCard()}>✕</button>
            </span>
          } />
      </div>
      {size === 'half' && (
        // the native terminal fills the body and is drawn over the web page, so the grip needs a rail of its own
        <div className="card-foot">
          <i className="card-grip" data-testid="card-grip" title="Drag to resize" {...grip} />
        </div>
      )}
    </div>
  );
}
