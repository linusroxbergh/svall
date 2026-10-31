// the shoals lightening the sea and the cast shadow: the coast scaled k round the centre, moved, blurred by sd before the scale,
// in the colour of the token fill names
const GLOWS = [
  { k: 1.38, dx: 0, dy: 0, sd: 16, fill: '--shoal' },
  { k: 1.16, dx: 0, dy: 0, sd: 11, fill: '--shoal-2' },
  { k: 1, dx: 2, dy: 8, sd: 5, fill: '--shade-1' },
];

/** The glows' colours, read on the page: a worker has no stylesheet to read them from. */
export const glowFills = (read: (token: string) => string): string[] => GLOWS.map((o) => read(o.fill));

// bitmap px per world px: the narrowest blur is still 2.5 of them wide
export const RES = 0.5;

export type Glow = { href: string; x: number; y: number; w: number; h: number };
type Frame = { x: number; y: number; w: number; h: number };

/** Where a coast's glow sits, in world px, and the bitmap's size in its own px. */
export function frame(sand: string, cx: number, cy: number): Frame {
  const n = sand.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  const [lx, hx, ly, hy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const edge = (f: (o: typeof GLOWS[number]) => number, pick: (...v: number[]) => number) => pick(...GLOWS.map(f));
  const x = Math.floor(edge((o) => cx + o.k * (lx - cx) + o.dx - 3 * o.sd * o.k, Math.min));
  const y = Math.floor(edge((o) => cy + o.k * (ly - cy) + o.dy - 3 * o.sd * o.k, Math.min));
  const w = Math.ceil(RES * (edge((o) => cx + o.k * (hx - cx) + o.dx + 3 * o.sd * o.k, Math.max) - x));
  const h = Math.ceil(RES * (edge((o) => cy + o.k * (hy - cy) + o.dy + 3 * o.sd * o.k, Math.max) - y));
  return { x, y, w, h };
}

/** Draws the glow onto a canvas of the frame's size. */
export function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, sand: string, cx: number, cy: number, { x, y, w, h }: Frame, fills: string[]): void {
  // the coast itself is drawn off the canvas, so only its shadow lands on it
  const off = 4 * (w + h), path = new Path2D(sand);
  for (const [i, o] of GLOWS.entries()) {
    ctx.setTransform(RES * o.k, 0, 0, RES * o.k, RES * (cx - o.k * cx + o.dx - x) - off, RES * (cy - o.k * cy + o.dy - y));
    ctx.shadowColor = fills[i]; ctx.shadowBlur = 2 * RES * o.sd * o.k; ctx.shadowOffsetX = off;
    ctx.fill(path);
  }
}
