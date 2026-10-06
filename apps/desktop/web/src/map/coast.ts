import { theme } from '../theme.js';

// FNV-1a over the string, normalised to [0, 1)
export function seedNum(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// A seeded squircle (superellipse, shape.n) sampled at 96 points, perturbed by four sine
// harmonics and joined with Catmull-Rom cubics. Points sit in a box padded by theme.pad;
// grow offsets the radius in world px, so 0 draws the sand rim and -4 the grass inset.
export function coastPath(w: number, h: number, seed: string, grow: number, shape = theme.coast): string {
  const a = w / 2, b = h / 2, n = shape.n, N = 96;
  const pad = theme.pad;
  const s1 = seedNum(seed), s2 = seedNum(seed + '~'), s3 = seedNum(seed + '~~');
  const amp = Math.min(a, b) * shape.wobble;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const k = 1 / Math.pow(Math.pow(Math.abs(c / a), n) + Math.pow(Math.abs(s / b), n), 1 / n);
    const wob =
      Math.sin(3 * t + s1 * 6.28) * 0.55 +
      Math.sin(5 * t + s2 * 6.28) * 0.3 +
      Math.sin(7 * t + s3 * 6.28) * 0.2 +
      Math.sin(11 * t + s1 * 3.1) * 0.1;
    const r = k + wob * amp + grow;
    pts.push([a + pad + r * c, b + pad + r * s]);
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d + 'Z';
}
