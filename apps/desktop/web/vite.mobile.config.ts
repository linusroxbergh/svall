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

// the phone bundle, beside but separate from the packaged app's
export default defineConfig({
  plugins: [react(), asIndex()],
  build: { outDir: 'dist-mobile', rolldownOptions: { input: 'mobile.html' } },
});
