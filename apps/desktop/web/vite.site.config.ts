import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// the page's fonts and art are the app's own, copied beside it on every build
const ASSETS: Record<string, string> = {
  fonts: 'public/fonts',
  animals: 'public/animals',
  'icon.svg': 'public/icons/icon.svg',
  'icon-180.png': 'public/icons/icon-180.png',
  'lighthouse.svg': 'public/resources/lighthouse2.svg',
};
const appAssets = (): Plugin => ({
  name: 'site-assets',
  writeBundle({ dir }) {
    for (const [to, from] of Object.entries(ASSETS)) fs.cpSync(path.resolve(import.meta.dirname, from), path.join(dir!, '..', to), { recursive: true });
  },
});

// the landing page's demo map, built into site/map from the app's own islands and cards
export default defineConfig({
  plugins: [react(), appAssets()],
  base: './',
  publicDir: false,
  build: {
    outDir: '../../../site/map',
    emptyOutDir: true,
    rolldownOptions: {
      input: { map: 'src/landing/main.tsx', flow: 'src/landing/flow.tsx' },
      // the protocol's schemas run nothing on import, so the map leaves them and zod out
      treeshake: { moduleSideEffects: (id) => !/packages\/protocol\/|node_modules\/zod\//.test(id) },
      output: { entryFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
});
