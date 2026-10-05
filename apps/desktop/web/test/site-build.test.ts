import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

const web = path.join(__dirname, '..');
const site = path.join(web, '../../../site');

// git holds only the page and its screenshots; the build lays out everything else it asks for beside it
it('builds every file the landing page loads', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-site-'));
  try {
    await build({ root: web, configFile: path.join(web, 'vite.site.config.ts'), logLevel: 'silent', build: { outDir: path.join(out, 'map'), emptyOutDir: true } });
    const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    const refs = [...page.matchAll(/(?:href|src)="([^"#:/][^"#:?]*)(?:\?[^"#:]*)?"|url\(([^)'"]+)\)/g)].map((m) => m[1] ?? m[2]);
    expect(refs).toEqual(expect.arrayContaining(['icon.svg', 'fonts/FunnelSans-Variable.woff2', 'lighthouse.svg', 'map/map.js', 'map/map-grain.png']));
    const missing = refs.filter((r) => !fs.existsSync(path.join(r.startsWith('shots/') ? site : out, r)));
    expect(missing).toEqual([]);
    // the cast's portraits load from beside the page, as the app's own load from beside index.html
    expect(fs.readdirSync(path.join(out, 'animals')).sort()).toEqual(fs.readdirSync(path.join(web, 'public/animals')).sort());
    expect(fs.readFileSync(path.join(out, 'map/map.css'), 'utf8')).toContain('JetBrainsMono-Medium.woff2');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 30_000);
