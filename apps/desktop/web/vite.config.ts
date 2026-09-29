import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // the packaged shell serves the bundle from svall://app/, so every asset URL must be relative to index.html
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
  // the component tests ask for jsdom in their own header; everything else runs headless
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'node', testTimeout: 20_000 },
});
