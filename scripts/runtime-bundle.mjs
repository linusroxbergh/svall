// Bundles svalld and the svall CLI, with the files they read, into apps/desktop/mac/build/runtime for Svall.app.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'apps/desktop/mac/build/runtime');
const mobile = path.join(root, 'apps/desktop/web/dist-mobile');
if (!fs.existsSync(mobile)) throw new Error('apps/desktop/web/dist-mobile is missing: pnpm --filter @svall/desktop-web build:mobile');

const plist = fs.readFileSync(path.join(root, 'apps/desktop/mac/Info.plist'), 'utf8');
const version = /<key>CFBundleShortVersionString<\/key><string>([^<]+)</.exec(plist)?.[1];
if (!version) throw new Error('Info.plist has no CFBundleShortVersionString');
const count = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();

fs.rmSync(out, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { svalld: 'packages/svalld/src/bin.ts', svall: 'packages/cli/src/main.ts' },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: { SVALL_BUNDLED: 'true', SVALL_VERSION: JSON.stringify(`${version} (${count})`) },
  // the CommonJS dependencies require node's own modules, and an ES module has no require of its own
  banner: { js: "import { createRequire as svallRequire } from 'node:module'; const require = svallRequire(import.meta.url);" },
  // ws loads these native speedups when they are installed and runs without them
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
for (const dir of ['hooks', 'home', 'agent-profiles']) {
  fs.cpSync(path.join(root, 'packages/svalld', dir), path.join(out, dir), { recursive: true });
}
fs.cpSync(mobile, path.join(out, 'mobile'), { recursive: true });
console.log(out);
