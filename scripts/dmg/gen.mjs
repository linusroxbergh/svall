// node scripts/dmg/gen.mjs: draws the disk image window's background at 1x and 2x, for scripts/dmg/build.sh.
// Rasterising needs the web app's Playwright chromium.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(join(root, 'apps/desktop/web/package.json'))('@playwright/test');
const sans = readFileSync(join(root, 'apps/desktop/web/public/fonts/FunnelSans-Variable.woff2')).toString('base64');

// build.sh shows 640x400 of it, 128px icons centred at (176,180) and (464,180); it runs 40 deeper for shorter title bars
// than macOS 26's, and stays near luminance .18 so Finder's black (light mode) and white (dark mode) labels both read
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 440" width="640" height="440">
<style>@font-face{font-family:Funnel Sans;src:url(data:font/woff2;base64,${sans}) format('woff2');font-weight:300 800}</style>
<defs><radialGradient id="g" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#5E7C95"/><stop offset="1" stop-color="#536D85"/></radialGradient></defs>
<rect width="640" height="440" fill="url(#g)"/>
<g fill="none" stroke="#F0E6CE" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M268 180H368"/><path d="M356 169L370 180L356 191"/></g>
<text x="320" y="338" text-anchor="middle" font-family="Funnel Sans" font-weight="500" font-size="16" letter-spacing=".2" fill="#F0E6CE" fill-opacity=".92">Drag Svall to Applications to install</text>
</svg>`;

const browser = await chromium.launch();
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const page = await browser.newPage({ viewport: { width: 640, height: 440 }, deviceScaleFactor: scale });
  await page.setContent(`<style>html,body{margin:0}</style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(root, 'scripts/dmg', name) });
  await page.close();
}
await browser.close();
