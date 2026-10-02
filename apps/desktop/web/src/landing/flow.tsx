import type { Cell, Character, ContextItem, Island as IslandModel, Portrait } from '@svall/protocol';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { crewGrid } from '../../../../../packages/svalld/src/layout.js';
import { coastPath } from '../map/coast.js';
import { Home } from '../map/HomeIsland.js';
import { Island } from '../map/Island.js';
import { cardScale, labelScale } from '../map/layout.js';
import { Seabed, Waterline } from '../map/Relief.js';
import { ISLET, placeIslet, type Placement } from '../map/resources.js';
import { Token } from '../map/Token.js';
import { theme } from '../theme.js';

// The landing page's ⌘G scene: mission control is asked for a review island, makes it, and its crew sets to work.

type Status = 'working' | 'idle' | 'blocked' | 'done';
type Member = { id: string; name: string; portrait: Portrait; status: Status; ctx: number; links: ContextItem[] };
type Scene = { keys: boolean; modal: boolean; typed: number; send: boolean; mc?: Member; island: boolean; crew: Member[]; shore: Member[]; picked?: string };

const PROMPT = 'Create an island to review the 3 open PRs in the storefront repo';
const link = (kind: 'pr' | 'issue', n: number): ContextItem =>
  ({ kind, ref: `https://github.com/linusroxbergh/storefront/${kind === 'pr' ? 'pull' : 'issues'}/${n}`, label: '', source: 'auto' });

const SHORE = { id: 'storefront', name: 'storefront', seed: 568461961 };
const REVIEWS = { id: 'reviews', name: 'storefront reviews', seed: 912345 };
const SG = crewGrid(2, SHORE.seed), RG = crewGrid(3, REVIEWS.seed);
const SHORE_AT: Cell = { x: 0, y: 0 }, REVIEWS_AT: Cell = { x: SG.size.w + 3, y: 0 };
const WORLD_W = (REVIEWS_AT.x + RG.size.w) * theme.cell;

// the scene is drawn at this size and scaled to its column; k is the map's zoom inside it
const SIZE = { w: 900, h: 600, k: 0.8, top: 74 };

const MC: Member = { id: 'mc', name: 'review open PRs', portrait: 'monkey', status: 'working', ctx: 4, links: [] };
const CREW: Member[] = [
  { id: '9', name: '#9 review cart persist', portrait: 'raccoon', status: 'idle', ctx: 0, links: [link('pr', 9)] },
  { id: '10', name: '#10 review search', portrait: 'rabbit', status: 'idle', ctx: 0, links: [link('pr', 10)] },
  { id: '11', name: '#11 review free ship', portrait: 'koala', status: 'idle', ctx: 0, links: [link('pr', 11)] },
];
const SHORE_CREW: Member[] = [
  { id: 'cr', name: 'checkout redesign', portrait: 'fox', status: 'working', ctx: 41, links: [link('issue', 6)] },
  { id: 'ct', name: 'fix cart total', portrait: 'deer', status: 'working', ctx: 57, links: [link('issue', 5)] },
];

const HOME: IslandModel = { id: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 4 }, seed: 7 };
const HOME_CONFIG = { cwd: '', command: '', actions: [{ label: 'update info', prompt: '' }, { label: 'status', prompt: '' }] };

const START: Scene = { keys: false, modal: false, typed: 0, send: false, island: false, crew: [], shore: SHORE_CREW };

const none = () => {};
const pointer = { onPointerDown: none };
const hold = { onPointerEnter: none, onPointerLeave: none };
const asyncNone = async () => {};

const islandModel = (i: typeof SHORE, at: Cell, size: IslandModel['size']): IslandModel =>
  ({ id: i.id, name: i.name, description: '', instructions: '', context: [], position: at, size, seed: i.seed });

const character = (m: Member, islandId: string, cell: Cell = { x: 0, y: 0 }): Character => ({
  id: m.id, islandId, cell, name: m.name, note: '', portrait: m.portrait, instructions: '', cwd: '~',
  context: m.links, shell: { lastOutputAt: 0 }, unread: m.status === 'done',
  agent: { kind: 'claude', sessionId: '', status: m.status, contextPct: m.ctx, lastActivityAt: 0 },
});

const grow = (crew: Member[], beat: number) =>
  crew.map((m, i) => (m.status === 'working' ? { ...m, ctx: Math.min(90, m.ctx + [5, 7, 4, 6][(beat + i) % 4]) } : m));

// each beat of the scene, at its time from the start
function script(): [number, (s: Scene) => Scene][] {
  const ev: [number, (s: Scene) => Scene][] = [];
  const at = (t: number, f: (s: Scene) => Partial<Scene>) => ev.push([t, (s) => ({ ...s, ...f(s) })]);
  at(1800, () => ({ keys: true }));
  at(2400, () => ({ modal: true }));
  at(2700, () => ({ keys: false }));
  const typing = 3200, per = 36;
  for (let i = 1; i <= PROMPT.length; i++) at(typing + i * per, () => ({ typed: i }));
  const sent = typing + PROMPT.length * per + 1200;
  at(sent, () => ({ send: true }));
  at(sent + 250, () => ({ modal: false, send: false, mc: MC }));
  at(sent + 2600, () => ({ island: true }));
  CREW.forEach((m, i) => {
    at(sent + 4000 + i * 1100, (s) => ({ crew: [...s.crew, m] }));
    at(sent + 4900 + i * 1100, (s) => ({ crew: s.crew.map((c) => (c.id === m.id ? { ...c, status: 'working', ctx: 3 } : c)) }));
  });
  const live = sent + 8200;
  at(live, (s) => ({ mc: { ...s.mc!, status: 'done' } }));
  for (let b = 0; b < 10; b++) at(live + 300 + b * 1100, (s) => ({ crew: grow(s.crew, b), shore: grow(s.shore, b + 1) }));
  at(live + 7000, (s) => ({ crew: s.crew.map((c) => (c.id === '10' ? { ...c, status: 'done' } : c)) }));
  at(live + 9000, () => ({ picked: '10' }));
  return ev;
}

const EVENTS = script();
const FINAL = EVENTS.reduce((s, [, f]) => f(s), START);
// a run holds its last beat this long, then fades out and starts again
const HOLD = 4000, FADE = 500;
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

const host = document.querySelector<HTMLElement>('.scene')!;

// loops while the scene is mostly in view; a run that ends out of view waits for the scene to come back
function useScene(): Scene {
  const [s, set] = useState<Scene>(still ? FINAL : START);
  useEffect(() => {
    if (still) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let visible = false, running = false;
    const play = () => {
      timers.forEach(clearTimeout);
      running = true;
      map.classList.remove('out');
      set(START);
      timers = EVENTS.map(([t, f]) => setTimeout(() => set(f), t));
      timers.push(setTimeout(() => {
        if (!visible) { running = false; return; }
        map.classList.add('out');
        timers.push(setTimeout(play, FADE));
      }, EVENTS[EVENTS.length - 1][0] + HOLD));
    };
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !running) play();
    }, { threshold: 0.45 });
    seen.observe(host);
    return () => { timers.forEach(clearTimeout); seen.disconnect(); };
  }, []);
  return s;
}

function Islet({ place, count }: { place: Placement; count: number }) {
  const { pad } = theme;
  const bw = ISLET.w + pad * 2, bh = ISLET.h + pad * 2;
  const rock = useMemo(() => coastPath(ISLET.w, ISLET.h, 'resources', 0), []);
  const face = useMemo(() => coastPath(ISLET.w, ISLET.h, 'resourcesc', -16), []);
  return (
    <div className="res-islet" style={{ left: place.cx - ISLET.w / 2, width: ISLET.w, transform: `scale(${place.scale})`, '--foot': `${ISLET.foot}px` } as React.CSSProperties}>
      <div className="island" style={{ left: -pad, bottom: -(bh - pad - ISLET.visible), width: bw, height: bh }}>
        <svg width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}>
          <defs>
            <linearGradient id="s-res" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#C7BFAF" /><stop offset="1" stopColor="#9A9282" /></linearGradient>
            <clipPath id="c-res"><path d={rock} /></clipPath>
          </defs>
          <Seabed id="res" sand={rock} cx={bw / 2} cy={bh / 2} bank="#7C7463" />
          <path className="land" d={rock} fill="url(#s-res)" stroke="rgba(80,72,58,.34)" strokeWidth="1" />
          <g clipPath="url(#c-res)">
            <path d={rock} fill="none" stroke="rgba(58,52,42,.13)" strokeWidth="14" />
            <path d={face} fill="rgba(255,250,236,.2)" transform="translate(0,-3)" />
            <g className="res-plinth" transform={`translate(${bw / 2},${pad + ISLET.visible - ISLET.foot})`}>
              <ellipse className="res-plinth-side" fill="#A79E8C" stroke="rgba(58,52,42,.16)" />
              <ellipse className="res-plinth-top" fill="#C6BDAA" />
            </g>
          </g>
          <Waterline sand={rock} />
        </svg>
      </div>
      <div className="res-tower">
        <span className="res-tower-pill">resources<i>{count}</i></span>
        <span className="res-tower-glow" />
        <span className="res-tower-shadow" />
        <img src="lighthouse.svg" alt="" draggable={false} />
      </div>
    </div>
  );
}

function Prompt({ typed, send }: { typed: number; send: boolean }) {
  return (
    <div className="modal-back">
      <div className="modal panel">
        <div className="kicker">Mission control</div>
        <div className="fld mission" data-empty={typed === 0}>{typed ? PROMPT.slice(0, typed) : 'what should the fleet do?'}<i className="caret" /></div>
        <div className="acts">
          <span className="btn pri" data-down={send}>Send</span>
          <span className="btn">Cancel</span>
        </div>
      </div>
    </div>
  );
}

function FlowScene() {
  const s = useScene();
  const k = SIZE.k;
  // mission control and the lighthouse stand in screen space at the foot, as in the app, at the cards' scale
  const place = placeIslet(SIZE.w, HOME.size.w * theme.cell, false, cardScale(k));
  const left = (SIZE.w - WORLD_W * k) / 2;
  const tok = (m: Member, islandId: string, at: Cell, cell: Cell) => (
    <Token c={character(m, islandId)} status={m.status} world={{ x: at.x + cell.x, y: at.y + cell.y }}
      selected={s.picked === m.id} dragging={false} hover={false} pointer={pointer}
      onHoverStart={none} onHoverEnd={none} onOpen={none} onLink={none} onMenu={none} />
  );
  return (
    <>
      <div className="world map-world" style={{ left, top: SIZE.top, width: WORLD_W, transform: `scale(${k})`, '--k': cardScale(k) / k, '--lk': Math.max(labelScale(k), 0.7) / k } as React.CSSProperties}>
        <Island island={islandModel(SHORE, SHORE_AT, SG.size)} count={2} hot={false} selected={false}
          dragging={false} settling={false} hover={false} onNew={none} onToggle={none} onMenu={none}
          land={pointer} label={pointer} handle={pointer} hold={hold} />
        {s.island && (
          <div className="rise">
            <Island island={islandModel(REVIEWS, REVIEWS_AT, RG.size)} count={s.crew.length} hot={false} selected={false}
              dragging={false} settling={false} hover={false} onNew={none} onToggle={none} onMenu={none}
              land={pointer} label={pointer} handle={pointer} hold={hold} />
          </div>
        )}
        {s.shore.map((m, i) => <Fragment key={m.id}>{tok(m, SHORE.id, SHORE_AT, SG.cells[i])}</Fragment>)}
        {s.crew.map((m, i) => <div key={m.id} className="pop">{tok(m, REVIEWS.id, REVIEWS_AT, RG.cells[i])}</div>)}
      </div>
      <Home island={HOME} crew={s.mc ? [character(s.mc, 'home', { x: 1, y: 1 })] : []} config={HOME_CONFIG} collapsed={false} selected={false}
        status={(c) => c.agent!.status} shift={place.homeShift} rowShift={place.homeShift} scale={place.homeScale}
        onToggle={none} onAction={asyncNone} onArrange={none} onNewIsland={none} onNew={none} label={pointer}
        tokenPointer={() => pointer} onHoverStart={none} onHoverEnd={none} onOpen={none} onLink={none} onMenu={none} />
      <Islet place={place} count={31} />
      {s.modal && <Prompt typed={s.typed} send={s.send} />}
      <div className="keycap" data-on={s.keys}><kbd>⌘</kbd><kbd>G</kbd></div>
    </>
  );
}

const map = host.querySelector<HTMLElement>('.scene-map')!;
// the scene shows at most at its drawn size and stays centred in its column
function fit() {
  const s = Math.min(1, host.clientWidth / SIZE.w);
  Object.assign(map.style, { width: `${SIZE.w}px`, height: `${SIZE.h}px`, transform: `scale(${s})`, left: `${(host.clientWidth - SIZE.w * s) / 2}px` });
  map.style.setProperty('--map-w', `${SIZE.w}px`);
  host.style.height = `${SIZE.h * s}px`;
}
fit();
addEventListener('resize', fit);
createRoot(map).render(<FlowScene />);
