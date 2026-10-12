import { crewGrid, type Cell, type ContextItem } from '@svall/protocol';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Island } from '../map/Island.js';
import { cardScale, labelScale } from '../map/layout.js';
import { Token } from '../map/Token.js';
import { theme } from '../theme.js';
import { character, hold, islandModel, none, pointer, type Member, type Status } from './demo.js';
import '../tokens.css';
import '../fonts.css';
import '../map/map.css';

// The landing page's demo map: the app's own islands and cards, holding a made-up crew whose statuses move on a beat.

// since is when, on the beat's clock, the member's status last changed
type Crew = Member & { since: number };

const pr = (repo: string, n: number): ContextItem => ({ kind: 'pr', ref: `https://github.com/linusroxbergh/${repo}/pull/${n}`, label: '', source: 'auto' });
const issue = (repo: string, n: number): ContextItem => ({ kind: 'issue', ref: `https://github.com/linusroxbergh/${repo}/issues/${n}`, label: '', source: 'auto' });
const linear = (n: number): ContextItem => ({ kind: 'linear', ref: `https://linear.app/acme/issue/SHOP-${n}`, label: `SHOP-${n}`, source: 'scribe' });

const CAST: Crew[] = ([
  { name: 'checkout redesign', portrait: 'fox', robot: 89, status: 'working', ctx: 46, links: [issue('storefront', 6)] },
  { name: 'fix cart total', portrait: 'deer', robot: 88, status: 'working', ctx: 58, links: [issue('storefront', 5), linear(150)] },
  { name: 'a11y audit', portrait: 'owl', robot: 62, status: 'done', ctx: 71, links: [linear(133)] },
  { name: 'flaky e2e', portrait: 'frog', robot: 83, status: 'idle', ctx: 12, links: [] },
  { name: 'refund webhooks', portrait: 'elephant', robot: 7, status: 'working', ctx: 33, links: [pr('payments-api', 1)] },
  { name: 'review #1', portrait: 'lemur', robot: 80, status: 'working', ctx: 62, links: [pr('payments-api', 1)] },
  { name: 'changelog', portrait: 'penguin', robot: 8, status: 'working', ctx: 27, links: [] },
] satisfies Omit<Member, 'id'>[]).map((m) => ({ ...m, id: m.name, since: 0 }));

const ISLANDS = [
  { id: 'storefront', name: 'storefront', seed: 568461961, crew: [0, 1, 2, 3] },
  { id: 'payments', name: 'payments api', seed: 1777050622, crew: [4, 5] },
  { id: 'docs', name: 'docs', seed: 171633796, crew: [6] },
];
// each island's footprint and where its crew stand, as svalld lays them out
const GRIDS = ISLANDS.map((i) => crewGrid(i.crew.length));

// wide: the text holds the left column and the islands cascade down the right; narrow: the same map under the text.
// w and h are the world's box in px, k the most it is zoomed to, at each island's position in cells
const LAYOUTS: Record<'wide' | 'narrow', { w: number; h: number; k: number; at: Cell[] }> = {
  wide: { w: 1720, h: 1000, k: 0.72, at: [{ x: 24, y: 13 }, { x: 20, y: 4 }, { x: 30, y: 5 }] },
  narrow: { w: 748, h: 866, k: 0.72, at: [{ x: 5, y: 10 }, { x: 0, y: 2 }, { x: 10, y: 3 }] },
};

const stage = document.querySelector<HTMLElement>('.stage')!;
const hero = document.querySelector<HTMLElement>('.stage .hero')!;
const features = document.querySelector<HTMLElement>('.features')!;
const map = document.querySelector<HTMLElement>('.map')!;
const world = document.querySelector<HTMLElement>('.world')!;

// the map only moves while it is on screen
let inView = false;
new IntersectionObserver(([e]) => { inView = e.isIntersecting; }).observe(world);

// one beat every 2.4 s: working cards fill their context, one agent at a time blocks and is answered
// a few beats later, the rest finish or start again
function useBeat(): Crew[] {
  const [crew, setCrew] = useState(CAST);
  useEffect(() => {
    const cast = CAST.map((m) => ({ ...m }));
    const asks = [5, 1, 6, 4, 0];
    let clock = 0, resolvedAt = -1e9, next = 0, asking: Crew | undefined;
    const set = (m: Crew, status: Status) => { m.status = status; m.since = clock; };
    const pick = (fn: (m: Crew) => boolean) => cast.filter(fn).sort(() => Math.random() - 0.5)[0];
    const step = () => {
      if (asking && clock - asking.since >= 7200) { set(asking, 'working'); asking = undefined; resolvedAt = clock; return; }
      if (!asking && clock - resolvedAt > 4800) {
        for (let k = 0; k < asks.length; k++) {
          const m = cast[asks[(next + k) % asks.length]];
          if (m.status === 'working') { next = (next + k + 1) % asks.length; set(m, 'blocked'); asking = m; break; }
        }
        return;
      }
      const done = pick((m) => m.status === 'working' && m.ctx > 80);
      if (done) return set(done, 'done');
      const again = pick((m) => (m.status === 'done' && clock - m.since > 9600) || (m.status === 'idle' && clock - m.since > 12000));
      if (again) { again.ctx = 5; set(again, 'working'); }
    };
    const beat = () => {
      if (document.hidden || !inView) return;
      clock += 2400;
      for (const m of cast) if (m.status === 'working') m.ctx = Math.min(94, m.ctx + 1.5 + Math.random() * 2.5);
      step();
      setCrew(cast.map((m) => ({ ...m })));
    };
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { beat(); every = setInterval(beat, 2400); }, 900);
    return () => { clearTimeout(first); clearInterval(every); };
  }, []);
  return crew;
}

function DemoMap({ at }: { at: Cell[] }) {
  const crew = useBeat();
  return (
    <>
      {ISLANDS.map((isl, i) => (
        <Island key={isl.id} island={islandModel(isl, at[i], GRIDS[i].size)} count={isl.crew.length} hot={false} selected={false}
          dragging={false} settling={false} hover={false} onNew={none} onToggle={none} onMenu={none}
          land={pointer} label={pointer} handle={pointer} hold={hold} />
      ))}
      {ISLANDS.flatMap((isl, i) => isl.crew.map((ci, k) => (
        <Token key={ci} c={character(crew[ci], isl.id)} status={crew[ci].status} robots
          world={{ x: at[i].x + GRIDS[i].cells[k].x, y: at[i].y + GRIDS[i].cells[k].y }}
          selected={false} dragging={false} hover={false} pointer={pointer}
          onHoverStart={none} onHoverEnd={none} onOpen={none} onLink={none} onMenu={none} />
      )))}
    </>
  );
}

// the islands' left edge and width in world px
const x0 = Math.min(...LAYOUTS.wide.at.map((c) => c.x)) * theme.cell;
const spanW = Math.max(...LAYOUTS.wide.at.map((c, i) => c.x + GRIDS[i].size.w)) * theme.cell - x0;

const root = createRoot(world);
const wideMQ = matchMedia('(min-width: 960px)');
function place() {
  const wide = wideMQ.matches, L = wide ? LAYOUTS.wide : LAYOUTS.narrow;
  stage.classList.toggle('narrow', !wide);
  const pad = parseFloat(getComputedStyle(stage).paddingLeft);
  let k: number, left: string;
  if (wide) {
    // the islands fit right of the text and centre in that room, with the right gutter as sea
    const from = hero.offsetLeft + hero.offsetWidth + 48;
    k = Math.min(L.k, (stage.clientWidth - pad - from) / spanW);
    left = `${from + (stage.clientWidth - from - spanW * k) / 2 - x0 * k}px`;
  } else {
    // the same map under the text, across the screen with a little sea either side
    k = Math.min(L.k, (stage.clientWidth - 28) / L.w);
    left = `calc(50% - ${(L.w * k) / 2}px)`;
  }
  Object.assign(world.style, { width: `${L.w}px`, height: `${L.h}px`, transform: `scale(${k})`, left });
  // cards scale as they do in the app at this zoom; island names stay legible however far the map zooms out
  world.style.setProperty('--k', String(cardScale(k) / k));
  world.style.setProperty('--lk', String(Math.max(labelScale(k), 0.7) / k));
  map.style.height = wide ? '' : `${L.h * k}px`;
  flushSync(() => root.render(<DemoMap at={L.at} />));
  world.style.top = '';
  stage.style.minHeight = '';
  if (!wide) return;
  // the islands, name pills included, share a vertical centre with the text from the title to the last bullet
  const box = (els: Iterable<Element>) => {
    const rs = [...els].map((e) => e.getBoundingClientRect());
    return { top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) };
  };
  const text = box([hero.querySelector('h1')!, features]), isles = box(world.querySelectorAll('.ilabel, .land'));
  const shift = (text.top + text.bottom - isles.top - isles.bottom) / 2;
  world.style.top = `${shift}px`;
  stage.style.minHeight = `${isles.bottom + shift - stage.getBoundingClientRect().top}px`;
}
place();
addEventListener('resize', place);
document.fonts.ready.then(place);
