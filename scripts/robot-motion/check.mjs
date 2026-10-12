// node scripts/robot-motion/check.mjs 01 [02 …] — checks each robot's motion in headless Chromium and WebKit:
// the still picture against the base branch's file, the format, every action starting and ending on the still pose,
// both engines placing moving parts alike; prints how many pixels each moment changes and writes frame sheets.
// BASE_REF picks the base (origin/main); SHOTS the sheet folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ROBOTS = path.join(ROOT, 'apps/desktop/web/public/robots');
const { chromium, webkit } = createRequire(path.join(ROOT, 'apps/desktop/web/package.json'))('@playwright/test');
const BASE_REF = process.env.BASE_REF || 'origin/main';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'robot-motion-shots');
const K = 8; // the still pose, then 7 moments from start to end
fs.mkdirSync(SHOTS, { recursive: true });

const original = (n) => execFileSync('git', ['-C', ROOT, 'show', `${BASE_REF}:apps/desktop/web/public/robots/robot-${n}.svg`], { encoding: 'utf8' });
const BLANK = `<!doctype html><body style="margin:0;background:#efe6d2">
<div id="row" style="display:flex;gap:10px;padding:10px;align-items:flex-end"></div>
<div id="small" style="display:flex;gap:10px;padding:10px;align-items:flex-end"></div></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/(robots|orig)\/(robot-\d+\.svg)$/.exec(url.pathname);
  if (url.pathname === '/blank.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(BLANK);
  try {
    const body = m[1] === 'orig' ? original(m[2].slice(6, -4)) : fs.readFileSync(path.join(ROBOTS, m[2]), 'utf8');
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const root = (s) => s.match(/<svg\b[^>]*>/)[0];
const attr = (tag, a) => (tag.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];

// the file's own rules; the app's test checks the same format
function formatProblems(n, src, orig) {
  const problems = [];
  for (const a of ['width', 'height', 'viewBox']) if (attr(root(src), a) !== attr(root(orig), a)) problems.push(`root ${a} changed`);
  if (!(attr(root(src), 'class') || '').split(' ').includes(`r${n}`)) problems.push(`root svg lacks class r${n}`);
  const styles = src.match(/<style>[\s\S]*?<\/style>/g) || [];
  if (styles.length !== 1) problems.push(`expected exactly one <style>, found ${styles.length}`);
  const css = (styles[0] || '').replace(/<\/?style>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const k of css.matchAll(/@keyframes\s+([\w-]+)/g)) if (!k[1].startsWith(`r${n}-`)) problems.push(`keyframes ${k[1]} not prefixed r${n}-`);
  const rules = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const r of rules.matchAll(/([^{}]+)\{[^{}]*\}/g))
    for (const sel of r[1].split(',')) if (!sel.trim().startsWith(`.r${n}[data-act`)) problems.push(`selector "${sel.trim()}" must start .r${n}[data-act`);
  for (const p of css.matchAll(/([a-z-]+)\s*:/g))
    if (!/^(animation(-[a-z-]+)?|transform(-origin|-box)?|fill)$/.test(p[1])) problems.push(`style sets ${p[1]}; only transform, fill and animation`);
  if (css.includes('infinite')) problems.push('an animation repeats forever');
  if (/<animate|<set\b|<script/.test(src)) problems.push('SMIL or script in the file');
  return [...new Set(problems)];
}

const inPage = {
  build: async ([n, K]) => {
    for (const id of ['row', 'small']) document.getElementById(id).replaceChildren();
    const text = await (await fetch(`robots/robot-${n}.svg`, { cache: 'no-store' })).text();
    const mk = () => document.importNode(new DOMParser().parseFromString(text, 'image/svg+xml').documentElement, true);
    for (const [id, h] of [['row', 300], ['small', 56]]) {
      const row = document.getElementById(id);
      for (let i = 0; i < K; i++) {
        const s = mk(); s.style.cssText = 'height:100%;width:100%;display:block;overflow:visible';
        const [, , vw, vh] = s.getAttribute('viewBox').split(/[\s,]+/).map(Number);
        const f = document.createElement('div'); f.className = 'f';
        f.style.cssText = `flex:none;height:${h}px;width:${Math.ceil((h * vw) / vh)}px`;
        f.append(s); row.append(f);
      }
    }
    const p = mk();
    return { idle: p.dataset.idle || '', work: p.dataset.work || '' };
  },
  pose: ([act, K]) => {
    const rows = ['row', 'small'].map((id) => [...document.querySelectorAll(`#${id} svg`)]);
    for (const svgs of rows) svgs.forEach((s, i) => { if (i > 0) s.dataset.act = act; else delete s.dataset.act; });
    let end = 0, inf = false;
    for (const svgs of rows) for (const s of svgs) for (const a of s.getAnimations({ subtree: true })) {
      const e = a.effect.getComputedTiming().endTime;
      if (!isFinite(e)) inf = true; else end = Math.max(end, e);
    }
    const count = new Set(rows[0][1].getAnimations({ subtree: true }).map((a) => a.effect.target)).size;
    for (const svgs of rows) svgs.forEach((s, i) => {
      if (i === 0) return;
      const t = Math.max(0, Math.min(end - 1, (end * (i - 1)) / (K - 2)));
      s.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
    });
    // animated parts at the first and last moment must match the still copy's computed transform and paint
    const [still, ...moving] = rows[0];
    const stillEls = [...still.querySelectorAll('*')];
    const nums = (v) => (v === 'none' ? [1, 0, 0, 1, 0, 0] : (v.match(/-?[\d.]+(e-?\d+)?/g) || []).map(Number));
    const near = (a, b, tol) => { const x = nums(a), y = nums(b); return x.length === y.length && x.every((v, k) => Math.abs(v - y[k]) <= tol); };
    const off = (s) => {
      const els = [...s.querySelectorAll('*')];
      const bad = new Set();
      for (const a of s.getAnimations({ subtree: true })) {
        const el = a.effect.target, r = getComputedStyle(stillEls[els.indexOf(el)]), c = getComputedStyle(el);
        const label = el.getAttribute('class') || el.tagName;
        if (!near(r.transform, c.transform, 0.02)) bad.add(`${label} transform ${c.transform}`);
        for (const p of ['fill', 'stroke']) if (!near(r[p], c[p], 4)) bad.add(`${label} ${p} ${c[p]} (still ${r[p]})`);
      }
      return [...bad];
    };
    const mid = moving[Math.floor(K / 2) - 1];
    const box = mid.getBoundingClientRect();
    const rects = mid.getAnimations({ subtree: true }).map((a) => {
      const r = a.effect.target.getBoundingClientRect();
      return [r.x - box.x, r.y - box.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    });
    return { end, inf, count, startOff: off(moving[0]), endOff: off(moving[K - 2]), rects };
  },
  diff: async ([a, b]) => {
    const load = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    if (A.width !== B.width || A.height !== B.height) return -1;
    const c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
    const x = c.getContext('2d');
    x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
    x.clearRect(0, 0, c.width, c.height); x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
    let d = 0;
    // premultiplied, so a near-transparent edge pixel can't count as a full-strength difference
    for (let k = 0; k < da.length; k += 4) {
      const pa = da[k + 3] / 255, pb = db[k + 3] / 255;
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(da[k + c] * pa - db[k + c] * pb)), Math.abs(da[k + 3] - db[k + 3])) > 40) d++;
    }
    return d;
  },
  still: async ([n, h]) => {
    const shot = async (u) => {
      const i = new Image(); i.src = u; await i.decode();
      const c = document.createElement('canvas'); c.height = h; c.width = Math.round((i.naturalWidth / i.naturalHeight) * h);
      c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); return c.toDataURL();
    };
    return [await shot(`orig/robot-${n}.svg`), await shot(`robots/robot-${n}.svg?${Date.now()}`)];
  },
};
const png = (buf) => 'data:image/png;base64,' + buf.toString('base64');

const browsers = await Promise.all([chromium, webkit].map((e) => e.launch({ headless: true })));
let failed = false;
for (const n of process.argv.slice(2)) {
  const src = fs.readFileSync(path.join(ROBOTS, `robot-${n}.svg`), 'utf8');
  const orig = original(n);
  const problems = formatProblems(n, src, orig);
  const out = [`== robot-${n}`];
  const mids = {};
  for (const browser of browsers) {
    const name = browser.browserType().name();
    const page = await browser.newPage({ viewport: { width: K * 310 + 20, height: 420 } });
    await page.goto(`${BASE}blank.html`);
    const diff = (a, b) => page.evaluate(inPage.diff, [a, b]);
    // the edited file as a still image against the original, both at 2× their size
    const h = Math.round(2 * parseFloat(attr(root(orig), 'height')));
    const [a, b] = await page.evaluate(inPage.still, [n, h]);
    const restPx = await diff(a, b);
    if (restPx !== 0) problems.push(`${name}: still image differs from ${BASE_REF} by ${restPx} px`);

    const lists = await page.evaluate(inPage.build, [n, K]);
    const acts = [...new Set(`${lists.idle} ${lists.work}`.split(' ').filter(Boolean))];
    if (!acts.length) problems.push('no actions in data-idle or data-work');
    if (name === 'chromium') out.push(`idle: ${lists.idle || '(none)'}\nwork: ${lists.work || '(none)'}`);
    for (const act of acts) {
      const { end, inf, count, startOff, endOff, rects } = await page.evaluate(inPage.pose, [act, K]);
      if (inf) problems.push(`${act}: an animation never ends`);
      if (!count) problems.push(`${act}: no element animates`);
      if (startOff.length) problems.push(`${name} ${act}: does not start at the still pose: ${startOff.join('; ')}`);
      if (endOff.length) problems.push(`${name} ${act}: does not end at the still pose: ${endOff.join('; ')}`);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const B = await Promise.all((await page.locator('#row .f').all()).map((l) => l.screenshot()));
      const S = await Promise.all((await page.locator('#small .f').all()).map((l) => l.screenshot()));
      await page.locator('#row').screenshot({ path: path.join(SHOTS, `r${n}-${act}-${name}.png`) });
      const dB = [], dS = [];
      for (let i = 1; i < K; i++) { dB.push(await diff(png(B[0]), png(B[i]))); dS.push(await diff(png(S[0]), png(S[i]))); }
      if (name === 'chromium')
        out.push(`${act}: ${(end / 1000).toFixed(2)}s, ${count} animated element(s); card-size peak ${Math.max(...dS)} px (per moment ${dS.slice(1, -1).join(' ')}); at 300px ${dB.slice(1, -1).join(' ')}`);
      // the same moment in both engines: animated parts' boxes must agree (pivots, transform-box)
      if (mids[act]) {
        const worst = Math.max(0, ...rects.flatMap((r, k) => r.map((v, j) => Math.abs(v - (mids[act][k]?.[j] ?? Infinity)))));
        if (worst > 1.5) problems.push(`${act}: WebKit places a moving part ${worst.toFixed(1)}px away from Chromium mid-action`);
      } else mids[act] = rects;
    }
    await page.close();
  }
  out.push(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'OK');
  out.push(`sheets: ${SHOTS}/r${n}-<action>-chromium.png (the still pose, then start → end)`);
  console.log(out.join('\n'));
  failed ||= problems.length > 0;
}
await Promise.all(browsers.map((b) => b.close()));
server.close();
process.exitCode = failed ? 1 : 0;
