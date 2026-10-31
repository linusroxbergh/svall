import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const web = path.join(__dirname, '..');
let out: string;

beforeAll(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-mobile-'));
  await build({ root: web, configFile: path.join(web, 'vite.mobile.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
}, 30_000);
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

// svalld serves the phone bundle's index.html, and a bundler that drops it does so without an error
it('builds the phone page as index.html', () => {
  expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<script type="module"');
  expect(fs.existsSync(path.join(out, 'mobile.html'))).toBe(false);
});

it('hands the service worker every file the page opens with, and never the manifest that carries the pass', () => {
  const line = /^const BUILD = (.*);$/m.exec(fs.readFileSync(path.join(out, 'sw.js'), 'utf8'));
  const kept = JSON.parse(line![1]) as { version: string; files: string[] };
  const assets = fs.readdirSync(path.join(out, 'assets')).map((f) => `/assets/${f}`);
  expect(assets.length).toBeGreaterThan(1);
  expect(kept.files).toEqual(expect.arrayContaining(['/', ...assets, '/fonts/JetBrainsMono-Regular.woff2', '/icons/icon-192.png']));
  expect(kept.files.filter((f) => f.startsWith('/robots/'))).toHaveLength(fs.readdirSync(path.join(out, 'robots')).length);
  for (const never of ['/manifest.webmanifest', '/sw.js', '/index.html']) expect(kept.files).not.toContain(never);
  expect(kept.version).toMatch(/^[0-9a-f]{16}$/);
});
