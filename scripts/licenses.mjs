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
// the vendor folders of the node, tmux and Sparkle this build ships, which app-build.sh names
const [nodeDir, tmux, sparkleDir] = process.argv.slice(2);
if (!sparkleDir) throw new Error('usage: licenses.mjs <node dir> <tmux dir> <sparkle dir>');
// the MIT text, for a package that names the licence but ships no copy of it
const mit = (dir) => {
  const author = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).author;
  const name = typeof author === 'string' ? author.replace(/\s*[<(].*$/, '') : author?.name;
  return `MIT License

Copyright (c) ${name}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const copies = {
  'node.txt': one(nodeDir, /^LICENSE$/),
  'tmux.txt': one(tmux, /^LICENSE\.tmux$/),
  'libevent.txt': one(tmux, /^LICENSE\.libevent$/),
  'utf8proc.txt': one(tmux, /^LICENSE\.utf8proc$/),
  'ghostty.txt': path.join(root, 'apps/desktop/mac/LICENSE.ghostty'),
  'sparkle.txt': one(sparkleDir, /^LICENSE$/),
};
for (const [name, from] of Object.entries(copies)) fs.copyFileSync(from, path.join(out, name));

// every npm package bundled into svalld.mjs, svall.mjs and the web pages, with its licence text
const list = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--filter', '@svall/svalld', '--filter', '@svall/cli', '--filter', '@svall/desktop-web'], { cwd: root, encoding: 'utf8' }));
const sections = Object.values(list).flat().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
  const dir = p.paths[0];
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : p.license === 'MIT' ? mit(dir) : 'no licence file shipped';
  return `## ${p.name} ${p.versions.join(', ')} (${p.license})\n\n${text}\n`;
});
fs.writeFileSync(path.join(out, 'npm.txt'), sections.join('\n'));
console.log(out);
