// node scripts/robot-motion/shapes.mjs FILE              every shape: index, fill, each subpath's absolute bbox
// node scripts/robot-motion/shapes.mjs FILE I            shape I's subpaths, each as a standalone d
// node scripts/robot-motion/shapes.mjs FILE I 0,1 2 3-5  shape I as new <path>s, one per group of subpath indices,
//                                                       keeping its attributes (a hole stays with its outline)
import fs from 'node:fs';

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

// one [cmd, args] per command instance; arc flags read as single digits
function segments(d) {
  const out = [];
  let i = 0, cmd = null;
  const skip = () => { while (i < d.length && ' ,\t\r\n'.includes(d[i])) i++; };
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-z]/i.test(d[i])) {
      cmd = d[i++];
      if ('zZ'.includes(cmd)) { out.push([cmd, []]); continue; }
    } else if (!cmd || 'zZ'.includes(cmd)) throw new Error(`number without command at ${i}`);
    const args = [];
    for (let k = 0; k < ARGS[cmd.toLowerCase()]; k++) {
      skip();
      if ('aA'.includes(cmd) && (k === 3 || k === 4)) { args.push(d[i++]); continue; }
      NUM.lastIndex = i;
      const m = NUM.exec(d);
      if (!m) throw new Error(`bad number at ${i}: ${d.slice(i, i + 12)}`);
      args.push(m[0]); i = NUM.lastIndex;
    }
    out.push([cmd, args]);
    if (cmd === 'm') cmd = 'l';
    else if (cmd === 'M') cmd = 'L';
  }
  return out;
}

// per subpath: its absolute start, its segments after the moveto, and the points it passes
function subpaths(d) {
  let x = 0, y = 0, sx = 0, sy = 0;
  const subs = [];
  for (const [cmd, a] of segments(d)) {
    const c = cmd.toLowerCase(), rel = cmd === c;
    const f = a.map(Number);
    if (c === 'm') {
      [x, y] = rel ? [x + f[0], y + f[1]] : [f[0], f[1]];
      [sx, sy] = [x, y];
      subs.push({ start: [x, y], segs: [], pts: [[x, y]] });
      continue;
    }
    if (!subs.length) subs.push({ start: [x, y], segs: [], pts: [[x, y]] });
    const sub = subs[subs.length - 1];
    sub.segs.push([cmd, a]);
    if (c === 'z') { [x, y] = [sx, sy]; continue; }
    if (c === 'h') x = rel ? x + f[0] : f[0];
    else if (c === 'v') y = rel ? y + f[0] : f[0];
    else if (c === 'a') [x, y] = rel ? [x + f[5], y + f[6]] : [f[5], f[6]];
    else {
      for (let k = 0; k < f.length; k += 2) sub.pts.push(rel ? [x + f[k], y + f[k + 1]] : [f[k], f[k + 1]]);
      [x, y] = sub.pts[sub.pts.length - 1];
      continue;
    }
    sub.pts.push([x, y]);
  }
  return subs;
}

const fmt = (v) => String(Math.round(v * 1000) / 1000);
const standalone = (s) => `M${fmt(s.start[0])} ${fmt(s.start[1])}` + s.segs.map(([c, a]) => c + a.join(' ')).join('');
const box = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return `${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))}–${Math.round(Math.max(...xs))},${Math.round(Math.max(...ys))}`;
};

const [file, index, ...groups] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const shapes = src.match(/<(?:path|circle|ellipse|rect|polygon|polyline|line)\b[^>]*\/?>/g) ?? [];
const dOf = (el) => / d="([^"]*)"/.exec(el)?.[1];
if (index === undefined) {
  console.log(src.match(/<svg[^>]*>/)[0].slice(0, 200));
  shapes.forEach((el, i) => {
    const fill = /fill="([^"]*)"/.exec(el)?.[1] ?? '-';
    const d = el.startsWith('<path') && dOf(el);
    console.log(i, fill, d ? `${subpaths(d).length} sub: ${subpaths(d).map((s, k) => `${k}: ${box(s.pts)}`).join(' | ')}` : el.slice(0, 140));
  });
} else {
  const el = shapes[Number(index)];
  const subs = subpaths(dOf(el));
  if (!groups.length) subs.forEach((s, k) => console.log(k, box(s.pts), standalone(s)));
  for (const g of groups) {
    const ks = g.split(',').flatMap((part) => {
      const [lo, hi = lo] = part.split('-').map(Number);
      return Array.from({ length: hi - lo + 1 }, (_, j) => lo + j);
    });
    console.log(el.replace(/ d="[^"]*"/, ` d="${ks.map((k) => standalone(subs[k])).join('')}"`));
  }
}
