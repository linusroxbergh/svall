// Turns four window screenshots into the landing page's views, in order: map, terminal, browser, files.
// `pnpm site:shots [four .png files]`; with none, the four PNGs in site/shots-in, oldest first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const inbox = path.join(root, 'site/shots-in');
const out = path.join(root, 'site/shots');
const VIEWS = ['map', 'terminal', 'browser', 'files'];
// twice the widest the page shows a view, so it stays sharp on a retina screen
const WIDTH = 2400;

let files = process.argv.slice(2);
if (files.length === 0 && fs.existsSync(inbox)) {
  files = fs.readdirSync(inbox).filter((f) => /\.png$/i.test(f)).map((f) => path.join(inbox, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}
if (files.length !== VIEWS.length) {
  console.error(`site:shots needs ${VIEWS.length} screenshots (${VIEWS.join(', ')}), found ${files.length}`);
  process.exit(1);
}

const size = (f) => {
  const [w, h] = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' }).match(/\d+$/gm).map(Number);
  return { w, h };
};
const sizes = files.map(size);
// the page flips between the views in one frame, so they have to be shots of the same window
if (sizes.some((s) => s.w !== sizes[0].w || s.h !== sizes[0].h)) {
  console.error(`the screenshots differ in size:\n${files.map((f, i) => `  ${sizes[i].w}x${sizes[i].h} ${path.basename(f)}`).join('\n')}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
VIEWS.forEach((view, i) => {
  const to = path.join(out, `${view}.avif`);
  const resize = sizes[i].w > WIDTH ? ['--resampleWidth', String(WIDTH)] : [];
  execFileSync('sips', ['-s', 'format', 'avif', '-s', 'formatOptions', '80', ...resize, files[i], '--out', to], { stdio: 'ignore' });
  console.log(`${view.padEnd(8)} ${path.basename(files[i])} -> site/shots/${view}.avif (${Math.round(fs.statSync(to).size / 1024)} KB)`);
});
