import { HOME_ISLAND } from '@svall/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { keyLabel } from './keys.js';
import { shortPath } from './paths.js';
import { clamp } from './settings.js';
import { scopedKey, SETTINGS_KEY, TOUR_KEY, type AppState } from './store/index.js';

const GAP = 14;
type Side = 'top' | 'bottom' | 'left' | 'right';
type Anchor = { id?: string; islandId?: string; cardOpen: boolean };
type Step = { at: (a: Anchor) => { sel: string; side: Side }; title: string; body: (k: (id: Parameters<typeof keyLabel>[0]) => string, cwd: string) => ReactNode };

const STEPS: Step[] = [
  {
    at: ({ id }) => ({ sel: id ? `[data-testid="token-${id}"]` : '[data-testid^="island-new-"]', side: 'bottom' }),
    title: 'Your first robot',
    body: (k, cwd) => <>A shell in <code>{cwd}</code>. Double-click it or press Enter, then type <code>claude</code>, <code>codex</code> or <code>opencode</code>. {k('newRobot')} makes another.</>,
  },
  {
    at: () => ({ sel: '[data-testid="side-card"]', side: 'left' }),
    title: 'What the robot knows',
    body: (k) => <>Everything here reaches the robot as context. Svall fills it in as the robot works, and you can add your own. {k('toggleSideCard')} shows or hides it.</>,
  },
  {
    // an open terminal card covers the lighthouse; the side card's Resources button opens the same shelf
    at: ({ cardOpen }) => (cardOpen ? { sel: '[data-testid="side-resources"]', side: 'left' }
      : { sel: '[data-testid="resources-lighthouse"], [data-testid="resources-pill"]', side: 'top' }),
    title: 'Resources',
    body: (k) => <>An overview of the instructions, skills and settings your robots get, globally and per island, repo and robot. Edit any of them here. {k('toggleResources')} opens it.</>,
  },
  {
    at: ({ islandId }) => ({ sel: `[data-testid="sb-folder-${islandId}"]`, side: 'right' }),
    title: 'Robots make robots',
    body: () => <>A robot can start other robots, send them messages and create islands.</>,
  },
  {
    // an open terminal card covers mission control's row on the map
    at: ({ cardOpen }) => (cardOpen ? { sel: `[data-testid="sb-folder-${HOME_ISLAND}"]`, side: 'right' } : { sel: '[data-testid="island-label-home"], [data-testid="home-arrange"], [data-testid^="home-action-"], [data-testid="home-new-island"], [data-testid="home-new"]', side: 'top' }),
    title: 'Mission control',
    body: (k) => <>Its robots look after the fleet, not your code. The buttons are quick actions, and {k('missionControl')} asks it anything. It asks once to trust its folder.</>,
  },
];

// a machine with settings of its own, under its fleet's key or the unscoped one, is past its first run, so
// the tour is only ever offered on the first; a store switched off offers it never
export const readStep = (): number => {
  try {
    const v = localStorage.getItem(TOUR_KEY);
    if (v === null) return localStorage.getItem(SETTINGS_KEY) === null && localStorage.getItem(scopedKey(SETTINGS_KEY, window.__svallHome)) === null ? 0 : STEPS.length;
    return v === 'done' ? STEPS.length : Number(v) || 0;
  } catch {
    return STEPS.length;
  }
};

// the oldest robot off mission control: the shell a new fleet starts with
const firstRobot = (s: AppState) => Object.values(s.fleet.robots).find((c) => s.fleet.islands[c.islandId]?.kind !== 'home');

// radius is the corner of the one element matched, so the ring keeps a pill round and a card's corners soft
type Box = { left: number; top: number; right: number; bottom: number; radius?: number };
const sameBox = (a?: Box, b?: Box) => a?.left === b?.left && a?.top === b?.top && a?.right === b?.right && a?.bottom === b?.bottom && a?.radius === b?.radius;

// every match of the selector, as one box
function boxOf(selector: string): Box | undefined {
  const els = [...document.querySelectorAll(selector)].filter((e) => e.getBoundingClientRect().width > 0);
  if (els.length === 0) return undefined;
  const rs = els.map((e) => e.getBoundingClientRect());
  const radius = els.length === 1 ? parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 0 : undefined;
  return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)), radius };
}

// beside the anchor on its side, kept in the window; the arrow follows the anchor's middle
function place(side: Side, b: Box, w: number, h: number): React.CSSProperties {
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  const left = clamp(side === 'left' ? b.left - GAP - w : side === 'right' ? b.right + GAP : cx - w / 2, GAP, innerWidth - w - GAP);
  const top = clamp(side === 'top' ? b.top - GAP - h : side === 'bottom' ? b.bottom + GAP : cy - h / 2, GAP, innerHeight - h - GAP);
  const arrow = side === 'top' || side === 'bottom' ? clamp(cx - left, 20, w - 20) : clamp(cy - top, 20, h - 20);
  return { left, top, '--arrow': `${arrow}px` } as React.CSSProperties;
}

export function Tour() {
  const [step, setStep] = useState(readStep);
  const ready = useApp((s) => s.loaded && s.view === 'map' && !s.settingsOpen && !s.fleet.scribeAsk && !s.namingRobot && !s.fleetPicker);
  const first = useApp((s) => firstRobot(s)?.id);
  const islandId = useApp((s) => firstRobot(s)?.islandId);
  const cwd = useApp((s) => shortPath(firstRobot(s)?.cwd ?? s.fleet.defaultCwd ?? '~'));
  const bindings = useApp((s) => s.settings.bindings);
  const [box, setBox] = useState<Box>();
  const [size, setSize] = useState({ w: 300, h: 0 });
  const bubble = useRef<HTMLDivElement>(null);
  const cardOpen = useApp((s) => s.card !== undefined);
  const cur = ready ? STEPS[step] : undefined;
  const at = cur?.at({ id: first, islandId, cardOpen });
  const selector = at?.sel;
  const go = (next: number) => {
    try { localStorage.setItem(TOUR_KEY, next >= STEPS.length ? 'done' : String(next)); } catch { /* remembered, not required */ }
    setStep(next);
  };

  // the map pans and the side card eases in, so the anchor is measured every frame
  useEffect(() => {
    if (!selector) return;
    let raf = 0;
    const tick = () => {
      const b = boxOf(selector);
      setBox((prev) => (sameBox(prev, b) ? prev : b));
      const el = bubble.current;
      if (el) setSize((prev) => (prev.w === el.offsetWidth && prev.h === el.offsetHeight ? prev : { w: el.offsetWidth, h: el.offsetHeight }));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [selector]);

  // the tour starts on the robot, selected so Enter opens it and with its side card open for the second step;
  // only once, so a robot picked since keeps the selection when a sheet or the settings close
  const started = useRef(false);
  useEffect(() => {
    if (!ready || !first || step > 0 || started.current) return;
    started.current = true;
    const s = app.store.getState();
    s.select(first);
    s.toggleSideCard(true);
  }, [ready, step, first]);

  const shown = Boolean(cur && box);
  useEffect(() => (shown && bubble.current ? holdCutout(app.bridge, bubble.current, true) : undefined), [shown, step]);

  if (!cur || !at || !box) return null;
  const k = (id: Parameters<typeof keyLabel>[0]) => keyLabel(id, bindings) ?? '';
  const last = step === STEPS.length - 1;
  const ring = { left: Math.max(box.left - 6, 3), top: Math.max(box.top - 6, 3), right: Math.min(box.right + 6, innerWidth - 3), bottom: Math.min(box.bottom + 6, innerHeight - 3) };
  const radius = clamp((box.radius ?? 12) + 6, 10, (ring.bottom - ring.top) / 2);
  return (
    <>
      <div className="tour-ring" style={{ left: ring.left, top: ring.top, width: ring.right - ring.left, height: ring.bottom - ring.top, borderRadius: radius }} />
      <div key={`tour-${step}`} ref={bubble} className="tour panel" data-testid="tour" data-side={at.side} style={place(at.side, box, size.w, size.h)} role="dialog" aria-label={cur.title}>
        <div className="kicker">{step + 1} of {STEPS.length}</div>
        <div className="tour-title">{cur.title}</div>
        <div className="tour-body">{cur.body(k, cwd)}</div>
        <div className="tour-acts">
          {!last && <button className="btn ghost" data-testid="tour-skip" onClick={() => go(STEPS.length)}>Skip tour</button>}
          <button className="btn pri" data-testid="tour-next" onClick={() => go(step + 1)}>{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </>
  );
}
