import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// svalld serves this bundle at the root of the tailnet origin, so its page has to be index.html
const asIndex = (): Plugin => ({
  name: 'mobile-as-index',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['mobile.html'];
    if (page?.type !== 'asset') this.error('the phone bundle has no mobile.html to serve as index.html');
    delete bundle['mobile.html'];
    this.emitFile({ type: 'asset', fileName: 'index.html', source: page.source });
  },
});

const BUILD_LINE = /^const BUILD = .*;$/m;

// the service worker keeps every file of the build but itself and the manifest, which carries the pass; a hash of their
// contents names its cache, so a new build is a new worker
const precache = (): Plugin => ({
  name: 'mobile-precache',
  writeBundle({ dir }) {
    const out = dir!;
    const files = fs.readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(out, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
      .filter((f) => f !== 'sw.js' && f !== 'manifest.webmanifest')
      .sort();
    const hash = createHash('sha256');
    for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
    const sw = path.join(out, 'sw.js');
    const text = fs.readFileSync(sw, 'utf8');
    if (!BUILD_LINE.test(text)) this.error('sw.js has no BUILD line to fill');
    const build = { version: hash.digest('hex').slice(0, 16), files: files.map((f) => (f === 'index.html' ? '/' : `/${f}`)) };
    fs.writeFileSync(sw, text.replace(BUILD_LINE, `const BUILD = ${JSON.stringify(build)};`));
  },
});

export default defineConfig({
  plugins: [react(), asIndex(), precache()],
  build: { outDir: 'dist-mobile', rolldownOptions: { input: 'mobile.html' } },
});
