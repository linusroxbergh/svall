// Makes site/og.jpg, the picture a link to svall.dev shows in Slack, X or Hacker News: the page's own logo, headline
// and demo map in its og layout, the rest of the hero hidden. `pnpm site:og` after `pnpm site:build`, again whenever the
// headline or the demo map changes.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = path.join(root, 'site');
if (!fs.existsSync(path.join(site, 'map/map.js'))) throw new Error('no site/map/map.js: run pnpm site:build first');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(site, new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 404 : 200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);

// the size link previews draw at, taken at twice it for retina screens
const W = 1200, H = 630, PAD = 56;
const { chromium } = createRequire(path.join(root, 'apps/desktop/web/package.json'))('@playwright/test');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await page.goto(`http://localhost:${server.address().port}/#og`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: 'header > a:last-child, .hero > :not(h1), .features { visibility: hidden }' });
  // the headline stays where the page puts it; the islands, laid out to leave it room, fill the frame
  await page.evaluate(({ W, H, PAD }) => {
    const world = document.querySelector('.stage .world');
    const rs = [...world.querySelectorAll('.ilabel, .land')].map((e) => e.getBoundingClientRect());
    const box = { l: Math.min(...rs.map((b) => b.left)), t: Math.min(...rs.map((b) => b.top)), r: Math.max(...rs.map((b) => b.right)), b: Math.max(...rs.map((b) => b.bottom)) };
    const s = Math.min((W - PAD) / (box.r - box.l), (H - PAD) / (box.b - box.t));
    // the world scales from its top left corner, which the added scale moves too
    const o = world.getBoundingClientRect();
    const x = (W - (box.r - box.l) * s) / 2 - box.l * s + (s - 1) * o.left;
    const y = (H - (box.b - box.t) * s) / 2 - box.t * s + (s - 1) * o.top;
    world.style.transform = `translate(${x}px, ${y}px) scale(${s}) ${world.style.transform}`;
  }, { W, H, PAD });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(site, 'og.jpg'), type: 'jpeg', quality: 85 });
} finally {
  await browser.close();
  server.close();
}
console.log(`site/og.jpg (${Math.round(fs.statSync(path.join(site, 'og.jpg')).size / 1024)} KB)`);
