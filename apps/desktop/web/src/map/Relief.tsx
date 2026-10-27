import { useEffect, useMemo, useState } from 'react';

const CONTOURS: [number, string][] = [
  [1.2, 'var(--contour-2)'],
  [1.12, 'var(--contour-2)'],
  [1.055, 'var(--contour)'],
];

// the shoals lightening the sea and the cast shadow: the coast scaled k round the centre, moved, blurred by sd before the scale
const GLOWS = [
  { k: 1.38, dx: 0, dy: 0, sd: 16, fill: 'rgba(140,190,215,.13)' },
  { k: 1.16, dx: 0, dy: 0, sd: 11, fill: 'rgba(205,225,230,.08)' },
  { k: 1, dx: 2, dy: 8, sd: 5, fill: 'rgba(8,14,22,.26)' },
];

const around = (k: number, cx: number, cy: number) => `translate(${cx},${cy}) scale(${k}) translate(${-cx},${-cy})`;

// bitmap px per world px: the narrowest blur is still 2.5 of them wide
const RES = 0.5;

type Glow = { href: string; x: number; y: number; w: number; h: number };
const glows = new Map<string, Glow | undefined>();

// drawn once per coast into a bitmap: WebKit redoes a live SVG blur in software whenever anything restyles its path, a
// stalled frame for every island on the map; a canvas shadow blurs, because WebKit's canvas has no filter
function glow(sand: string, cx: number, cy: number): Glow | null | undefined {
  const key = `${cx},${cy},${sand}`;
  if (glows.has(key)) return glows.get(key);
  let g: Glow | undefined;
  if (typeof Path2D !== 'undefined') {
    const n = sand.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
    const [lx, hx, ly, hy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const edge = (f: (o: typeof GLOWS[number]) => number, pick: (...v: number[]) => number) => pick(...GLOWS.map(f));
    const x = Math.floor(edge((o) => cx + o.k * (lx - cx) + o.dx - 3 * o.sd * o.k, Math.min));
    const y = Math.floor(edge((o) => cy + o.k * (ly - cy) + o.dy - 3 * o.sd * o.k, Math.min));
    const w = Math.ceil(RES * (edge((o) => cx + o.k * (hx - cx) + o.dx + 3 * o.sd * o.k, Math.max) - x));
    const h = Math.ceil(RES * (edge((o) => cy + o.k * (hy - cy) + o.dy + 3 * o.sd * o.k, Math.max) - y));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // the coast itself is drawn off the canvas, so only its shadow lands on it
      const off = 4 * (w + h), path = new Path2D(sand);
      for (const o of GLOWS) {
        ctx.setTransform(RES * o.k, 0, 0, RES * o.k, RES * (cx - o.k * cx + o.dx - x) - off, RES * (cy - o.k * cy + o.dy - y));
        ctx.shadowColor = o.fill; ctx.shadowBlur = 2 * RES * o.sd * o.k; ctx.shadowOffsetX = off;
        ctx.fill(path);
      }
      // the canvas lives in WebKit's GPU process and reads back 'data:,' when that process is replaced for not answering
      // within 15 s: null is drawn again each second rather than kept
      const href = canvas.toDataURL();
      if (href === 'data:,') return null;
      g = { href, x, y, w: w / RES, h: h / RES };
    }
  }
  if (glows.size >= 64) glows.delete(glows.keys().next().value!);
  glows.set(key, g);
  return g;
}

// everything drawn under the land: the shoals lightening the sea, the cast shadow, the wave-line contours and the sand bank
export function Seabed({ sand, cx, cy, bank }: { sand: string; cx: number; cy: number; bank: string }) {
  const [tries, setTries] = useState(0);
  const next = useMemo(() => glow(sand, cx, cy), [sand, cx, cy, tries]);
  // a new coast keeps the last glow until its own has decoded: WebKit would paint a frame with none
  const [g, setG] = useState(next);
  useEffect(() => {
    if (next === null) {
      const t = setTimeout(() => setTries((n) => n + 1), 1000);
      return () => clearTimeout(t);
    }
    if (!next || next === g) return;
    let live = true;
    const im = new Image();
    im.src = next.href;
    im.decode().catch(() => {}).then(() => { if (live) setG(next); });
    return () => { live = false; };
  }, [next, tries]);
  return (
    <>
      {g && <image href={g.href} x={g.x} y={g.y} width={g.w} height={g.h} />}
      {CONTOURS.map(([k, colour], i) => (
        <path key={i} d={sand} fill="none" stroke={colour} strokeWidth={(1 / k).toFixed(3)} strokeDasharray="7 9" strokeLinecap="round" transform={around(k, cx, cy)} />
      ))}
      <path d={sand} fill="rgba(70,58,34,.2)" transform="translate(0,7.5)" />
      <path d={sand} fill={bank} transform="translate(0,6.5)" />
    </>
  );
}

export function Waterline({ sand }: { sand: string }) {
  return <path d={sand} fill="none" stroke="rgba(252,246,230,.3)" strokeWidth="1.4" />;
}
