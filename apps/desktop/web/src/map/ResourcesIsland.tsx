import { useMemo } from 'react';
import { app } from '../boot.js';
import { stop, useApp } from '../hooks.js';
import { countOf } from '../resources/model.js';
import { theme } from '../theme.js';
import { coastPath } from './coast.js';
import { Seabed, Waterline } from './Relief.js';
import { ISLET, type Placement } from './resources.js';

const SEED = 'resources';
const TOWER = './resources/lighthouse2.svg';

// the islet and compact pill are one door: they open on All or close the shelf, and stop a double-click, which on the map would make an island
const press = () => {
  const s = app.store.getState();
  if (s.resourcesOpen) s.toggleResources(false);
  else s.toggleResources(true, { what: 'all' });
};

export function ResourcesPill() {
  const open = useApp((s) => s.resourcesOpen);
  return (
    <button className="ilabel res-pill" data-testid="resources-pill" data-selected={open} aria-expanded={open}
      onPointerDown={stop} onDoubleClick={stop} onClick={press}><b>resources</b></button>
  );
}

// a smaller coastline moved so its centre sits at (cx + dx, cy + dy)
function facet(fw: number, fh: number, seed: string, cx: number, cy: number, dx: number, dy: number) {
  return { d: coastPath(fw, fh, seed, 0), t: `translate(${cx + dx - (fw / 2 + theme.pad)},${cy + dy - (fh / 2 + theme.pad)})` };
}

const ROCK = { crag: 'color-mix(in srgb, var(--rock-ink) 13%, transparent)', lichen: 'color-mix(in srgb, var(--cream) 20%, transparent)' };

export function ResourcesIsland({ place }: { place: Placement }) {
  const user = useApp((s) => s.resources[0]);
  const open = useApp((s) => s.resourcesOpen);
  const { pad } = theme;
  const bw = ISLET.w + pad * 2, bh = ISLET.h + pad * 2;
  const cx = bw / 2, cy = bh / 2;
  const rock = useMemo(() => coastPath(ISLET.w, ISLET.h, SEED, 0), []);
  const face = useMemo(() => coastPath(ISLET.w, ISLET.h, SEED + 'c', -16), []);
  const facets = useMemo(() => [
    facet(ISLET.w * 0.18, ISLET.h * 0.22, 'f1', cx, cy, -58, 12),
    facet(ISLET.w * 0.14, ISLET.h * 0.2, 'f2', cx, cy, 64, 2),
    facet(ISLET.w * 0.3, ISLET.h * 0.3, 'f3', cx, cy, -8, -22),
  ], [cx, cy]);
  return (
    <div className="res-islet" data-selected={open}
      style={{ left: place.cx - ISLET.w / 2, width: ISLET.w, transform: `scale(${place.scale})`, '--foot': `${ISLET.foot}px` } as React.CSSProperties}>
      <div className="island" style={{ left: -pad, bottom: -(bh - pad - ISLET.visible), width: bw, height: bh }}>
        {/* the wrapper has no height of its own, so the drawing is what a test can see */}
        <svg data-testid="resources-islet" width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}>
          <defs>
            <linearGradient id="s-res" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--rock-0)" /><stop offset="1" stopColor="var(--rock-1)" /></linearGradient>
            <clipPath id="c-res"><path d={rock} /></clipPath>
            <filter id="g-res" x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" />
              <feColorMatrix values="0 0 0 0 .12  0 0 0 0 .12  0 0 0 0 .11  0 0 0 1.6 -.5" />
            </filter>
          </defs>
          <Seabed sand={rock} cx={cx} cy={cy} bank="var(--rock-bank)" />
          <g style={{ pointerEvents: 'visiblePainted', cursor: 'pointer' }} onPointerDown={stop} onDoubleClick={stop} onClick={press}>
            <path className="land" d={rock} fill="url(#s-res)" stroke="color-mix(in srgb, var(--rock-ink) 28%, transparent)" strokeWidth="1" />
            <g clipPath="url(#c-res)">
              <path d={rock} fill="none" stroke={ROCK.crag} strokeWidth="14" />
              <path d={rock} fill="none" stroke={ROCK.crag} strokeWidth="6" />
              <path d={face} fill={ROCK.lichen} transform="translate(0,-3)" />
              <path d={facets[0].d} transform={facets[0].t} fill={ROCK.crag} />
              <path d={facets[1].d} transform={facets[1].t} fill={ROCK.crag} />
              <path d={facets[2].d} transform={facets[2].t} fill={ROCK.lichen} />
              {/* the footing the tower stands on, cut from the rock so the grain runs over it too */}
              <g className="res-plinth" transform={`translate(${cx},${pad + ISLET.visible - ISLET.foot})`}>
                <ellipse className="res-plinth-side" fill="var(--rock-plinth)" stroke="color-mix(in srgb, var(--rock-ink) 16%, transparent)" />
                <ellipse className="res-plinth-top" fill="var(--rock-0)" />
              </g>
              <rect width={bw} height={bh} filter="url(#g-res)" opacity=".28" />
            </g>
          </g>
          <Waterline sand={rock} />
        </svg>
      </div>
      <button className="res-tower" data-testid="resources-lighthouse" data-selected={open} aria-expanded={open}
        onPointerDown={stop} onDoubleClick={stop} onClick={press}>
        <span className="res-tower-pill" data-testid="resources-pill">resources<i>{countOf(user, 'all')}</i></span>
        <span className="res-tower-glow" />
        <span className="res-tower-shadow" />
        <img src={TOWER} alt="" draggable={false} />
        {/* the mask is inline so its public path resolves as the img's does */}
        <span className="res-tower-grain" style={{ maskImage: `url(${TOWER})` }} />
      </button>
    </div>
  );
}
