import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

const web = path.join(__dirname, '..');

// svalld serves the phone bundle's index.html, and a bundler that drops it does so without an error
it('builds the phone page as index.html', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-mobile-'));
  try {
    await build({ root: web, configFile: path.join(web, 'vite.mobile.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<script type="module"');
    expect(fs.existsSync(path.join(out, 'mobile.html'))).toBe(false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 30_000);
