// Collects the licences of everything Svall.app carries into apps/desktop/mac/build/licenses.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'apps/desktop/mac/build/licenses');
const one = (dir, pattern) => {
  const hit = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => pattern.test(f)) : undefined;
  if (!hit) throw new Error(`no licence matching ${pattern} in ${dir}: run pnpm app:build first`);
  return path.join(dir, hit);
};
const newest = (dir) => path.join(dir, fs.readdirSync(dir).sort().at(-1));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const tmux = newest(path.join(root, 'vendor/tmux'));
const copies = {
  'node.txt': one(newest(path.join(root, 'vendor/node')), /^LICENSE$/),
  'tmux.txt': one(tmux, /^LICENSE\.tmux$/),
  'libevent.txt': one(tmux, /^LICENSE\.libevent$/),
  'utf8proc.txt': one(tmux, /^LICENSE\.utf8proc$/),
  'ghostty.txt': path.join(root, 'apps/desktop/mac/LICENSE.ghostty'),
  'sparkle.txt': one(newest(path.join(root, 'vendor/sparkle')), /^LICENSE$/),
};
for (const [name, from] of Object.entries(copies)) fs.copyFileSync(from, path.join(out, name));

// every npm package bundled into svalld.mjs, svall.mjs and the web pages, with its licence text
const list = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--filter', '@svall/svalld', '--filter', '@svall/cli', '--filter', '@svall/desktop-web'], { cwd: root, encoding: 'utf8' }));
const sections = Object.values(list).flat().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
  const dir = p.paths[0];
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  return `## ${p.name} ${p.versions.join(', ')} (${p.license})\n\n${file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : 'no licence file shipped'}\n`;
});
fs.writeFileSync(path.join(out, 'npm.txt'), sections.join('\n'));
console.log(out);
