import { crewGrid, type Character, type ContextItem } from '@svall/protocol';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Island } from '../src/map/Island.js';
import { cardScale, labelScale } from '../src/map/layout.js';
import { theme } from '../src/theme.js';
import { hold, islandModel, none, pointer } from '../src/landing/demo.js';
import type { DisplayStatus } from '../src/selectors.js';
import { RobotToken, type Variant } from './RobotToken.js';
import { preloadRobots, ROBOTS } from './cast.js';
import '../src/tokens.css';
import '../src/fonts.css';
import '../src/map/map.css';
import './robots.css';

// every gauge reads as battery left, so it drains as context fills
const VARIANTS: { v: Variant; id: string; title: string; note: string }[] = [
  { v: 'stand', id: '4a', title: 'Standing', note: 'Name on top, the robot below it with a soft shadow at its feet. No context on the card.' },
  { v: 'cells', id: '4e', title: 'Battery cells', note: 'Five battery cells under the robot\'s feet.' },
  { v: 'wide', id: '4f', title: 'Full-width cells', note: 'Five short cells running the full width of the card, just above the footer.' },
  { v: 'band', id: '4g', title: 'Top band', note: 'The status band along the top of the card is the battery: thicker, in the status colour, and shorter as context fills.' },
  { v: 'footer', id: '4h', title: 'Footer battery', note: 'A small battery icon in the footer beside the terminal button, quiet ink; it turns red with a fifth left.' },
  { v: 'pole', id: '4i', title: 'Charging post', note: 'A slim upright battery of five cells beside the robot, draining from the top.' },
  { v: 'signal', id: '4j', title: 'Signal bars', note: 'Four rising bars in the top left, like a phone\'s signal, dropping as context fills.' },
  { v: 'pack', id: '4k', title: 'Standing on a battery', note: 'The robot stands on a long battery; its charge is the context left, red with a fifth left.' },
  { v: 'seam', id: '4l', title: 'Footer seam', note: 'The line between the card and its footer is the bar, edge to edge, in the status colour; the robot stands on it.' },
  { v: 'screen', id: '5a', title: 'Screen', note: 'A dark screen, robot glowing in its colour, five battery cells under it, name below.' },
  { v: 'lcd', id: '5c', title: 'LCD', note: 'A light screen, the robot printed dark, a three-segment battery in the screen corner.' },
];

// robot colours, each measured against the card's cream
const PALETTES: { id: string; title: string; note: string }[] = [
  { id: 'art', title: 'Original', note: 'The artwork in its own colours. The rest turn each robot into a one-colour silhouette.' },
  { id: 'muted', title: 'Muted', note: 'Each robot\'s palette tint darkened toward the land ink: 2.6–4.6:1 on the card, too close to the cream and to the status colours.' },
  { id: 'ink', title: 'Ink', note: 'Every robot in the land ink, 9:1. Robots are told apart by shape, and colour on the card means status only.' },
  { id: 'riso', title: 'Riso', note: 'Ink robots over an offset print in their pale tint: 9:1 for the line, and each robot keeps a colour of its own.' },
  { id: 'jewel', title: 'Deep jewel', note: 'Deep indigo, plum, wine, pine and petrol, 6–7:1, chosen away from the amber, red and teal the statuses use.' },
  { id: 'cool', title: 'Cool deeps', note: 'Navy, violet, petrol, pine and indigo, 6–9:1. All cool, so amber working and red blocked are the only warm colours on the map.' },
];

const link = (kind: 'pr' | 'issue', repo: string, n: number): ContextItem =>
  ({ kind, ref: `https://github.com/linusroxbergh/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`, label: '', source: 'auto' });

type Member = { name: string; status: DisplayStatus; ctx: number; links: ContextItem[] };
const CAST: Member[] = [
  { name: 'checkout redesign', status: 'working', ctx: 46, links: [link('issue', 'storefront', 6)] },
  { name: 'fix cart total', status: 'working', ctx: 78, links: [] },
  { name: 'a11y audit', status: 'done', ctx: 64, links: [link('pr', 'storefront', 12)] },
  { name: 'refund webhooks', status: 'blocked', ctx: 31, links: [] },
  { name: 'flaky e2e', status: 'idle', ctx: 12, links: [] },
  { name: 'changelog', status: 'shell', ctx: 0, links: [] },
];

const character = (m: Member, islandId: string): Character => ({
  id: m.name, islandId, cell: { x: 0, y: 0 }, name: m.name, note: '', portrait: 'fox', instructions: '', cwd: '~',
  context: m.links, shell: { lastOutputAt: 0 }, unread: m.status === 'done',
  agent: m.status === 'shell' ? undefined : { kind: 'claude', sessionId: '', status: m.status, contextPct: m.ctx, lastActivityAt: 0 },
});

const GRID = crewGrid(CAST.length);
const AT = { x: 1, y: 1 };

function Scene({ v, scale, cast }: { v: Variant; scale: number; cast: number }) {
  const island = islandModel({ id: v, name: v, seed: 568461961 + cast }, AT, GRID.size);
  return (
    <div className="scene" style={{ width: (GRID.size.w + 2) * theme.cell * scale, height: (GRID.size.h + 2) * theme.cell * scale }}>
      <div className="map-world" style={{ '--cell': `${theme.cell}px`, '--ms': scale, '--k': cardScale(scale), '--lk': labelScale(scale) / scale } as React.CSSProperties}>
        <Island island={island} count={CAST.length} hot={false} selected={false} dragging={false} settling={false} hover={false}
          onNew={none} onToggle={none} onMenu={none} land={pointer} label={pointer} handle={pointer} hold={hold} />
        {CAST.map((m, k) => (
          <RobotToken key={m.name} c={character(m, v)} robot={ROBOTS[(cast * CAST.length + k) % ROBOTS.length]} variant={v}
            status={m.status} world={{ x: AT.x + GRID.cells[k].x, y: AT.y + GRID.cells[k].y }} />
        ))}
      </div>
    </div>
  );
}

const ZOOMS = [0.5, 0.87, 1, 1.5];

function Lab() {
  const q = new URLSearchParams(location.search);
  const [scale, setScale] = useState(Number(q.get('z') ?? 1));
  const [cast, setCast] = useState(Number(q.get('cast') ?? 0));
  const [pal, setPal] = useState(q.get('pal') ?? 'art');
  const only = q.get('v');
  return (
    <main data-pal={pal}>
      <header>
        <h1>Robot cards</h1>
        <div className="ctl">
          <span>Zoom</span>
          {ZOOMS.map((z) => <button key={z} type="button" aria-pressed={z === scale} onClick={() => setScale(z)}>{z}×</button>)}
          <span>Robots</span>
          {[0, 1, 2].map((n) => <button key={n} type="button" aria-pressed={n === cast} onClick={() => setCast(n)}>{n * 6 + 1}–{Math.min(n * 6 + 6, 16)}{n === 2 ? ' +1–2' : ''}</button>)}
        </div>
        <div className="ctl">
          <span>Colour</span>
          {PALETTES.map((p) => <button key={p.id} type="button" aria-pressed={p.id === pal} onClick={() => setPal(p.id)}>{p.title}</button>)}
        </div>
        <p className="pal-note">{PALETTES.find((p) => p.id === pal)?.note}</p>
      </header>
      <div className="grid">
        {VARIANTS.map(({ v, id, title, note }) => (!only || only === v) && (
          <section key={v} data-variant={v}>
            <h2><b>{id}</b> {title}</h2>
            <p>{note}</p>
            <Scene v={v} scale={scale} cast={cast} />
          </section>
        ))}
      </div>
    </main>
  );
}

await preloadRobots();
createRoot(document.getElementById('root')!).render(<Lab />);
