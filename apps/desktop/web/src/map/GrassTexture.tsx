import { useMemo } from 'react';
import meadowUrl from '../assets/meadow.png';
import { theme } from '../theme.js';
import { seedNum } from './coast.js';

const DEEP = '85 112 79';
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

function ground(seed: string, shape: string, w: number, h: number): React.CSSProperties {
  // the coast's wobble can carry the grass this far past its footprint
  const m = 1.15 * theme.coast.wobble * Math.min(w, h) / 2;
  const r = rng(seed + 'grass');
  const x = Math.round(r() * MEADOW), y = Math.round(r() * MEADOW);
  const mid = `radial-gradient(${(w + 2 * m) * 0.48}px ${(h + 2 * m) * 0.46}px at ${theme.pad + w / 2}px ${theme.pad + h / 2}px, `
    + `rgb(${DEEP} / .22), rgb(${DEEP} / .12) 50%, rgb(${DEEP} / 0))`;
  return {
    clipPath: `path("${shape}")`,
    backgroundImage: `${mid}, url(${meadowUrl})`,
    backgroundSize: `auto, ${MEADOW}px ${MEADOW}px`,
    backgroundPosition: `0 0, ${x}px ${y}px`,
    backgroundRepeat: 'no-repeat, repeat',
  };
}

// CSS backgrounds, not an SVG pattern: WebKit redraws a pattern's tile into a new buffer on every repaint and waits for it.
export function GrassTexture({ seed, shape, w, h }: { seed: string; shape: string; w: number; h: number }) {
  const style = useMemo(() => ground(seed, shape, w, h), [seed, shape, w, h]);
  return <div className="grass-texture" style={style} />;
}
