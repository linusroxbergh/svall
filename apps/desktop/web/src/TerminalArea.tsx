import { useEffect, useRef, useState } from 'react';
import { AGENT_LABEL, DORMANT_AFTER_HOURS, type FleetState } from '@svall/protocol';
import { openSecondTerminal, retryMove, reviveRobot, startFresh } from './actions.js';
import { app, deps } from './boot.js';
import { holdsTerminals, restingLine } from './handover.js';
import { useApp } from './hooks.js';
import { destinationName, unreachableOf } from './placement.js';
import { isVeiled, resumeErrorOf } from './selectors.js';
import { secondKey } from './terminals.js';

// the fleet only closes an agent left idle past its limit; one that ends sooner was ended by hand
const closedForIdleness = (f: FleetState, id: string): boolean => {
  const a = f.robots[id]?.agent;
  const hours = f.dormantAfterHours ?? DORMANT_AFTER_HOURS;
  return !!a && hours > 0 && Date.now() - a.lastActivityAt >= hours * 3_600_000;
};

export function TerminalArea({ id, opacity, second, aside }: { id: string; opacity?: number; second?: boolean; aside?: boolean }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const key = second ? secondKey(id) : id;
  const error = useApp((s) => s.terminalErrors[key]);
  const failed = useApp((s) => resumeErrorOf(s, second ? s.fleet.robots[id]?.second : s.fleet.robots[id]));
  const veiled = useApp(isVeiled);
  // the fleet is between machines: its terminals were rested at the source and reopen where it lands
  const resting = useApp((s) => holdsTerminals(s.handover));
  const restingSays = useApp((s) => (resting ? restingLine(s.handover) : ''));
  // a robot between machines, or on a worker the home cannot reach, has no terminal to show here
  const movingTo = useApp((s) => { const m = s.fleet.robots[id]?.moving; return m && destinationName(s.fleet, m.to); });
  const unreachable = useApp((s) => { const r = s.fleet.robots[id]; return r && unreachableOf(s.fleet, r); });
  const away = !!movingTo || !!unreachable;
  // read as the veil lifts, from the render that lifted it
  const keepPageFocus = useApp((s) => s.keepPageFocus);
  const ref = useRef<HTMLDivElement>(null);
  const dormant = second ? !c?.second?.tmux : !c?.tmux;
  const alpha = useRef(opacity);
  alpha.current = opacity;

  // opening a dormant robot wakes it once it has stayed in view a moment, so passing by wakes nothing.
  // One whose window is lost while open, bar a close for idleness, or that fails to wake or to resume after a
  // handover, waits for the button
  const [held, setHeld] = useState(false);
  const [asked, setAsked] = useState(false);
  const windowId = c?.tmux?.windowId;
  useEffect(() => {
    if (!windowId) return;
    setHeld(false);
    return () => { if (!closedForIdleness(app.store.getState().fleet, id)) setHeld(true); };
  }, [windowId]);
  const active = useApp((s) => s.active);
  useEffect(() => {
    if (second || !dormant || held || failed || resting || away || !active) return;
    const t = setTimeout(() => {
      const cur = app.store.getState().fleet.robots[id];
      if (cur && !cur.tmux) void reviveRobot(deps(), id).then((ok) => { if (!ok) setHeld(true); });
    }, 1000);
    return () => clearTimeout(t);
  }, [id, second, dormant, held, failed, resting, away, active]);

  useEffect(() => {
    if (resting || away || dormant || error || veiled) return;
    const el = ref.current;
    if (!el) return;
    const rect = () => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
    const m = app.manager();
    m.show(key, rect(), alpha.current, !keepPageFocus && !aside).catch(() => {});
    const ro = new ResizeObserver(() => m.move(key, rect()));
    ro.observe(el);
    return () => { ro.disconnect(); m.hide(key); };
  }, [key, resting, away, dormant, error, veiled]);

  // a changed opacity restates the surface where it is; re-running the attach effect would flicker it.
  // the settings sliders keep the keyboard, so the surface only takes focus while they are away
  useEffect(() => {
    const el = ref.current;
    const s = app.store.getState();
    if (!el || resting || away || veiled || !s.terminals[key]) return;
    const r = el.getBoundingClientRect();
    app.manager().show(key, { x: r.left, y: r.top, width: r.width, height: r.height }, opacity, !s.settingsOpen && !keepPageFocus && !aside).catch(() => {});
  }, [key, opacity, resting, away, veiled]);

  if (!c) return null;
  if (resting) {
    return <button type="button" className="revive held" data-testid="terminal-held" onClick={() => app.store.getState().toggleHandover(true)}>{restingSays}</button>;
  }
  if (movingTo) {
    return (
      <div className="revive" data-testid="terminal-moving">
        <span>moving to {movingTo}…</span>
        {c.moving?.error && <span data-testid="move-error">{c.moving.error}</span>}
        {c.moving?.error && <button data-testid="move-retry" onClick={() => void retryMove(deps(), c.moving!.id)}>Retry</button>}
      </div>
    );
  }
  if (unreachable) return <div className="revive" data-testid="terminal-unreachable">{unreachable} is not reachable</div>;
  if (error) {
    return (
      <div className="revive" data-testid="terminal-error">
        <span>{error}</span>
        <button data-testid="retry" onClick={() => app.store.getState().termRetry(key)}>Retry</button>
      </div>
    );
  }
  if (dormant) {
    // a second terminal with no record yet is still being opened; one with a record is dormant and waits for the button
    if (second && !c.second) return <div className="revive" data-testid="second-starting">Starting the terminal…</div>;
    if (second || held || failed) {
      const old = failed ? (second ? c.second : c)?.agent : undefined;
      return (
        <div className="revive">
          {failed && <span data-testid="resume-error">{failed}</span>}
          {old && asked ? (
            <>
              <span data-testid="fresh-ask">Start a new {AGENT_LABEL[old.kind]} session here from a summary of {old.sessionId}? The old session stays where it is.</span>
              <button data-testid="fresh-go" onClick={() => { setAsked(false); void startFresh(deps(), id, second); }}>Start fresh</button>
              <button data-testid="fresh-cancel" onClick={() => setAsked(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button data-testid="revive" onClick={() => (second ? openSecondTerminal(deps(), id) : void reviveRobot(deps(), id))}>Revive {c.name}</button>
              {old && <button data-testid="fresh" onClick={() => setAsked(true)}>Start fresh from summary</button>}
            </>
          )}
        </div>
      );
    }
    return <div className="revive" data-testid="resuming">{c.revive?.command ? 'Resuming the session…' : 'Starting the terminal…'}</div>;
  }
  return (
    <div ref={ref} className="surface" data-testid="surface" data-robot={id} data-term={key}>
      {!app.bridge.present && <span>terminal{second ? ' 2' : ''} · {c.name}</span>}
    </div>
  );
}
