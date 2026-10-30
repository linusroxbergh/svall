import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { frame, paint, RES, type Glow } from './glow.js';

const CONTOURS: [number, string][] = [
  [1.2, 'var(--contour-2)'],
  [1.12, 'var(--contour-2)'],
  [1.055, 'var(--contour)'],
];

const around = (k: number, cx: number, cy: number) => `translate(${cx},${cy}) scale(${k}) translate(${-cx},${-cy})`;

type Drawn = Glow | null | undefined;
const glows = new Map<string, Drawn>();

// drawn once per coast into a bitmap: WebKit redoes a live SVG blur in software whenever anything restyles its path, a
// stalled frame for every island on the map; a canvas shadow blurs, because WebKit's canvas has no filter
function draw(key: string, sand: string, cx: number, cy: number): Drawn {
  let g: Glow | undefined;
  if (typeof Path2D !== 'undefined') {
    const f = frame(sand, cx, cy);
    const canvas = document.createElement('canvas');
    canvas.width = f.w; canvas.height = f.h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      paint(ctx, sand, cx, cy, f);
      // the canvas lives in WebKit's GPU process and reads back 'data:,' when that process is replaced for not answering
      // within 15 s: null is not kept, so the next call draws it again
      const href = canvas.toDataURL();
      if (href === 'data:,') return null;
      g = { href, x: f.x, y: f.y, w: f.w / RES, h: f.h / RES };
    }
  }
  keep(key, g);
  return g;
}

function keep(key: string, g: Drawn): void {
  if (glows.size >= 64) glows.delete(glows.keys().next().value!);
  glows.set(key, g);
}

// the same pixels drawn in workers, three so that a whole fleet's glows come back within a frame of their coasts; one that
// fails hands its coasts, and every later one, back to the main thread
let workers: Worker[] = [], broken = false, jobId = 0;
const jobs = new Map<number, { key: string; sand: string; cx: number; cy: number; done(g: Drawn): void }>();
function drawOff(key: string, sand: string, cx: number, cy: number): Promise<Drawn> | undefined {
  if (broken || typeof OffscreenCanvas === 'undefined') return undefined;
  if (!workers.length) {
    try {
      workers = Array.from({ length: 3 }, () => new Worker(new URL('./glow.worker.ts', import.meta.url), { type: 'module' }));
    } catch {
      broken = true;
      return undefined;
    }
    for (const w of workers) {
      w.onmessage = ({ data: { id, g } }: MessageEvent<{ id: number; g: Glow | null }>) => {
        const job = jobs.get(id);
        if (!job) return;
        jobs.delete(id);
        if (g) keep(job.key, g);
        job.done(g);
      };
      w.onerror = () => {
        broken = true;
        for (const other of workers) other.terminate();
        for (const job of jobs.values()) job.done(draw(job.key, job.sand, job.cx, job.cy));
        jobs.clear();
      };
    }
  }
  return new Promise((done) => {
    jobs.set(++jobId, { key, sand, cx, cy, done });
    workers[jobId % workers.length].postMessage({ id: jobId, sand, cx, cy });
  });
}

function glow(sand: string, cx: number, cy: number, off: boolean): Drawn | Promise<Drawn> {
  const key = `${cx},${cy},${sand}`;
  if (glows.has(key)) return glows.get(key);
  return (off && drawOff(key, sand, cx, cy)) || draw(key, sand, cx, cy);
}

export function Seabed({ sand, cx, cy, bank }: { sand: string; cx: number; cy: number; bank: string }) {
  const [tries, retry] = useReducer((n: number) => n + 1, 0);
  // the first glow is drawn in render, so the first paint has it; a later coast's is drawn off the main thread
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const next = useMemo(() => glow(sand, cx, cy, mounted.current), [sand, cx, cy, tries]);
  // a new coast keeps the last glow until its own has decoded: WebKit would paint a frame with none
  const [g, setG] = useState(() => (next instanceof Promise ? undefined : next));
  useEffect(() => {
    let live = true, t: ReturnType<typeof setTimeout> | undefined;
    const show = (n: Drawn) => {
      if (n === null) { t = setTimeout(retry, 1000); return; }
      if (!n || n === g) return;
      const im = new Image();
      im.src = n.href;
      im.decode().catch(() => {}).then(() => { if (live) setG(n); });
    };
    if (next instanceof Promise) void next.then((n) => { if (live) show(n); });
    else show(next);
    return () => { live = false; clearTimeout(t); };
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
