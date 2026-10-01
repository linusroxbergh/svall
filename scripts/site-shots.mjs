// Turns four window screenshots into the landing page's views, in order: map, terminal, browser, files.
// `pnpm site:shots [four .png files]`; with none, the four PNGs in site/shots-in, oldest first. Needs ImageMagick.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

// a window capture carries the window's shadow unless ⌥ was held; only the fully opaque window is kept
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-shots-'));
const windows = files.map((f, i) => {
  const box = execFileSync('magick', [f, '-alpha', 'extract', '-threshold', '99%', '-format', '%@', 'info:'], { encoding: 'utf8' });
  const to = path.join(tmp, `${i}.png`);
  execFileSync('magick', [f, '-crop', box, '+repage', to]);
  return to;
});

const size = (f) => {
  const [w, h] = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' }).match(/\d+$/gm).map(Number);
  return { w, h };
};
const sizes = windows.map(size);
// the page flips between the views in one frame, so they have to be shots of the same window
if (sizes.some((s) => s.w !== sizes[0].w || s.h !== sizes[0].h)) {
  console.error(`the windows differ in size:\n${files.map((f, i) => `  ${sizes[i].w}x${sizes[i].h} ${path.basename(f)}`).join('\n')}`);
  process.exit(1);
}

// Chrome draws nothing for an AVIF from sips with an odd width or height
const even = (n) => 2 * Math.round(n / 2);
const w = even(Math.min(WIDTH, sizes[0].w)), h = even((w * sizes[0].h) / sizes[0].w);

fs.mkdirSync(out, { recursive: true });
VIEWS.forEach((view, i) => {
  const to = path.join(out, `${view}.avif`);
  execFileSync('sips', ['-s', 'format', 'avif', '-s', 'formatOptions', '80', '-z', String(h), String(w), windows[i], '--out', to], { stdio: 'ignore' });
  console.log(`${view.padEnd(8)} ${path.basename(files[i])} -> site/shots/${view}.avif (${Math.round(fs.statSync(to).size / 1024)} KB)`);
});
fs.rmSync(tmp, { recursive: true });
