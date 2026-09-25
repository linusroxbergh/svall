import { useEffect, useRef } from 'react';
import { reviveCharacter } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { isVeiled } from './selectors.js';
import { secondKey } from './terminals.js';

export function TerminalArea({ id, opacity, second, aside }: { id: string; opacity?: number; second?: boolean; aside?: boolean }) {
  const c = useApp((s) => s.fleet.characters[id]);
  const key = second ? secondKey(id) : id;
  const error = useApp((s) => s.terminalErrors[key]);
  const veiled = useApp(isVeiled);
  // read as the veil lifts, from the render that lifted it
  const keepPageFocus = useApp((s) => s.keepPageFocus);
  const ref = useRef<HTMLDivElement>(null);
  const dormant = second ? !c?.second : !c?.tmux;
  const alpha = useRef(opacity);
  alpha.current = opacity;

  useEffect(() => {
    if (dormant || error || veiled) return;
    const el = ref.current;
    if (!el) return;
    const rect = () => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
    const m = app.manager();
    m.show(key, rect(), alpha.current, !keepPageFocus && !aside).catch(() => {});
    const ro = new ResizeObserver(() => m.move(key, rect()));
    ro.observe(el);
    return () => { ro.disconnect(); m.hide(key); };
  }, [key, dormant, error, veiled]);

  // a changed opacity restates the surface where it is; re-running the attach effect would flicker it.
  // the settings sliders keep the keyboard, so the surface only takes focus while they are away
  useEffect(() => {
    const el = ref.current;
    const s = app.store.getState();
    if (!el || veiled || !s.terminals[key]) return;
    const r = el.getBoundingClientRect();
    app.manager().show(key, { x: r.left, y: r.top, width: r.width, height: r.height }, opacity, !s.settingsOpen && !keepPageFocus && !aside).catch(() => {});
  }, [key, opacity, veiled]);

  if (!c) return null;
  if (error) {
    return (
      <div className="revive" data-testid="terminal-error">
        <span>{error}</span>
        <button data-testid="retry" onClick={() => app.store.getState().termRetry(key)}>Retry</button>
      </div>
    );
  }
  if (dormant) {
    return second
      ? <div className="revive" data-testid="second-starting">Starting the terminal…</div>
      : (
        <div className="revive">
          <button data-testid="revive" onClick={() => reviveCharacter(deps(), id)}>Revive {c.name}</button>
        </div>
      );
  }
  return (
    <div ref={ref} className="surface" data-testid="surface" data-char={id} data-term={key}>
      {!app.bridge.present && <span>terminal{second ? ' 2' : ''} · {c.name}</span>}
    </div>
  );
}
