import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// the landing page's demo map, built into site/map from the app's own islands and cards
export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: false,
  build: {
    outDir: '../../../site/map',
    emptyOutDir: true,
    rolldownOptions: {
      input: { map: 'src/landing/main.tsx' },
      // the protocol's schemas run nothing on import, so the map leaves them and zod out
      treeshake: { moduleSideEffects: (id) => !/packages\/protocol\/|node_modules\/zod\//.test(id) },
      output: { entryFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
});
