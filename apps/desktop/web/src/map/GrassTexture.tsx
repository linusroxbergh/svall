import { useMemo } from 'react';
import grainUrl from '../assets/grass-grain.png';
import meadowUrl from '../assets/meadow.png';
import { theme } from '../theme.js';
import { seedNum } from './coast.js';

const GRASS = { deep: '#55704F', dry: 'rgba(212,206,156,.038)', dot: 'rgba(44,60,40,.18)', fleck: 'rgba(228,232,196,.17)' };
// widths of the strokes stacked along the grass edge; each adds a little dry grass, so the rim fades inward
const RIM = [44, 38, 32, 26, 21, 16, 12, 8, 5];
const STIPPLE = 11;
// the meadow tile is a small blurred bitmap drawn large: soft patches cost one scaled image, not a gradient each
const MEADOW = 640;

// mulberry32, seeded from the island so its ground keeps its look across renders
function rng(seed: string) {
  let h = Math.floor(seedNum(seed) * 4294967296);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(seed: string, w: number, h: number) {
  // the coast's wobble can carry the grass this far past its footprint
  const m = 1.15 * theme.coast.wobble * Math.min(w, h) / 2;
  const box = { x: theme.pad - m, y: theme.pad - m, w: w + 2 * m, h: h + 2 * m };
  const r = rng(seed + 'grass');
  const meadow = `translate(${Math.round(r() * MEADOW)} ${Math.round(r() * MEADOW)})`;
  // each dot is a zero-length stroke with round caps, so the whole stipple is four paths
  const dots = { dark: ['', ''], light: ['', ''] };
  for (let y = box.y; y < box.y + box.h; y += STIPPLE) for (let x = box.x; x < box.x + box.w; x += STIPPLE) {
    if (r() < 0.42) continue;
    const set = r() < 0.7 ? dots.dark : dots.light;
    set[r() < 0.5 ? 0 : 1] += `M${(x + r() * STIPPLE).toFixed(1)} ${(y + r() * STIPPLE).toFixed(1)}h.01`;
  }
  return { box, meadow, dots };
}

// Ground inside the grass edge: soft meadow patches, a deeper middle under drier grass at the rim, the map's grain
// inked dark, and a faint stipple. Drawn over the grass and under the land's own grain, out of hit testing.
export function GrassTexture({ id, seed, shape, w, h }: { id: string; seed: string; shape: string; w: number; h: number }) {
  const { box, meadow, dots } = useMemo(() => scatter(seed, w, h), [seed, w, h]);
  const { pad } = theme;
  return (
    <g clipPath={`url(#grass-${id})`} pointerEvents="none">
      <defs>
        <clipPath id={`grass-${id}`}><path d={shape} /></clipPath>
        <pattern id={`grass-meadow-${id}`} patternUnits="userSpaceOnUse" width={MEADOW} height={MEADOW} patternTransform={meadow}>
          <image href={meadowUrl} width={MEADOW} height={MEADOW} preserveAspectRatio="none" />
        </pattern>
        <radialGradient id={`grass-mid-${id}`}>
          <stop offset="0" stopColor={GRASS.deep} stopOpacity=".22" />
          <stop offset=".5" stopColor={GRASS.deep} stopOpacity=".12" />
          <stop offset="1" stopColor={GRASS.deep} stopOpacity="0" />
        </radialGradient>
        <pattern id={`grass-ink-${id}`} patternUnits="userSpaceOnUse" width="128" height="128">
          <image href={grainUrl} width="128" height="128" />
        </pattern>
      </defs>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#grass-meadow-${id})`} />
      <ellipse cx={pad + w / 2} cy={pad + h / 2} rx={box.w * 0.48} ry={box.h * 0.46} fill={`url(#grass-mid-${id})`} />
      {RIM.map((sw) => <path key={sw} d={shape} fill="none" stroke={GRASS.dry} strokeWidth={sw} />)}
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#grass-ink-${id})`} />
      {dots.dark.map((d, i) => <path key={`d${i}`} d={d} stroke={GRASS.dot} strokeWidth={1.4 + i * 0.7} strokeLinecap="round" />)}
      {dots.light.map((d, i) => <path key={`l${i}`} d={d} stroke={GRASS.fleck} strokeWidth={1.4 + i * 0.7} strokeLinecap="round" />)}
    </g>
  );
}
