// node scripts/app-icon/gen.mjs: draws the app icon and writes the macOS .icns and the web/phone icons.
// Rasterising needs the web app's Playwright chromium; the .icns needs macOS iconutil.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const { chromium } = createRequire(join(root, 'apps/desktop/web/package.json'))('@playwright/test');

function seedNum(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// the map's coastPath (apps/desktop/web/src/map/coast.ts) with a rounder superellipse and more wobble
function coast(cx, cy, w, h, seed, grow, n = 2.3, wobble = 0.1, N = 144) {
  const a = w / 2, b = h / 2;
  const s1 = seedNum(seed), s2 = seedNum(seed + '~'), s3 = seedNum(seed + '~~');
  const amp = Math.min(a, b) * wobble;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const k = 1 / Math.pow(Math.pow(Math.abs(c / a), n) + Math.pow(Math.abs(s / b), n), 1 / n);
    const wob = Math.sin(3 * t + s1 * 6.28) * 0.55 + Math.sin(5 * t + s2 * 6.28) * 0.3 + Math.sin(7 * t + s3 * 6.28) * 0.2 + Math.sin(11 * t + s1 * 3.1) * 0.1;
    const r = k + wob * amp + grow;
    pts.push([cx + r * c, cy + r * s]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

// the island on the night sea (tokens --sea-0/--sea-1, --sand, --bank, --grass): bank, sand, grass inset by the rim
const shore = (grow) => coast(512, 500, 580, 530, 'round-2', grow);
const SEA = `<radialGradient id="sea" cx="46%" cy="36%" r="74%"><stop offset="0" stop-color="#314358"/><stop offset=".6" stop-color="#2A3A4C"/><stop offset="1" stop-color="#1E2A38"/></radialGradient>`;
const ISLAND = `<path d="${shore(0)}" fill="#A2905F" transform="translate(0,34)"/><path d="${shore(0)}" fill="#E6D8B8"/><path d="${shore(-40)}" fill="#7B9376"/>`;

// macOS: the 824 tile on the 1024 grid, corner radius 185.4, with its drop shadow
const TILE = 'M285.4,100H738.6A185.4,185.4 0 0 1 924,285.4V738.6A185.4,185.4 0 0 1 738.6,924H285.4A185.4,185.4 0 0 1 100,738.6V285.4A185.4,185.4 0 0 1 285.4,100Z';
const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>${SEA}<clipPath id="tile"><path d="${TILE}"/></clipPath>
<filter id="drop" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope=".32"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<g filter="url(#drop)"><path d="${TILE}" fill="url(#sea)"/></g>
<g clip-path="url(#tile)">${ISLAND}</g>
<path d="${TILE}" fill="none" stroke="rgba(240,230,206,.10)" stroke-width="3"/>
</svg>
`;

// web and phone: full bleed, since iOS and Android cut their own shape; the island keeps its share of the tile
const web = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>${SEA}</defs>
<rect width="1024" height="1024" fill="url(#sea)"/>
<g transform="translate(512,512) scale(${(1024 / 824).toFixed(4)}) translate(-512,-512)">${ISLAND}</g>
</svg>
`;

const icons = join(root, 'apps/desktop/web/public/icons');
writeFileSync(join(root, 'scripts/app-icon/app-icon.svg'), mac);
writeFileSync(join(icons, 'icon.svg'), web);

const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size, path) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path, omitBackground: true });
}
for (const size of [180, 192, 512]) await png(web, size, join(icons, `icon-${size}.png`));
const set = join(mkdtempSync(join(tmpdir(), 'svall-icon-')), 'Svall.iconset');
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  await png(mac, s, join(set, `icon_${s}x${s}.png`));
  await png(mac, s * 2, join(set, `icon_${s}x${s}@2x.png`));
}
await browser.close();
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'apps/desktop/mac/Svall.icns')]);
rmSync(join(set, '..'), { recursive: true });
