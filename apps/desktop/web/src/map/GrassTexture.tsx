import { useId, useMemo } from 'react';
import meadowUrl from '../assets/meadow.png';
import { theme } from '../theme.js';
import { seedNum } from './coast.js';

const GRASS = { deep: '#55704F', dry: 'rgba(212,206,156,.038)' };
// widths of the strokes stacked along the grass edge; each adds a little dry grass, so the rim fades inward
const RIM = [44, 38, 32, 26, 21, 16, 12, 8, 5];
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
  return { box, meadow };
}

// Ground inside the grass edge: soft meadow patches and a deeper middle under drier grass at the rim.
// Drawn over the grass and under the land's own grain, out of hit testing.
export function GrassTexture({ seed, shape, w, h }: { seed: string; shape: string; w: number; h: number }) {
  const { box, meadow } = useMemo(() => scatter(seed, w, h), [seed, w, h]);
  // per instance: an island drawn twice on one page would otherwise clip to the other copy's shape
  const id = useId();
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
      </defs>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#grass-meadow-${id})`} />
      <ellipse cx={pad + w / 2} cy={pad + h / 2} rx={box.w * 0.48} ry={box.h * 0.46} fill={`url(#grass-mid-${id})`} />
      {RIM.map((sw) => <path key={sw} d={shape} fill="none" stroke={GRASS.dry} strokeWidth={sw} />)}
    </g>
  );
}
