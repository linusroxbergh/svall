// Turns six window screenshots into the landing page's views, in order: map, terminal, browser, files, markdown,
// phone; then two phone screenshots, the fleet list and a terminal, for the phone standing over the last view.
// `pnpm site:shots [eight .png files]`; with none, the eight PNGs in site/shots-in, oldest first. Needs ImageMagick.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const inbox = path.join(root, 'site/shots-in');
const out = path.join(root, 'site/shots');
const VIEWS = ['map', 'terminal', 'browser', 'files', 'markdown', 'phone'];
const SCREENS = ['phone-list', 'phone-terminal'];
// twice the widest the page shows a view or a phone screen, so it stays sharp on a retina screen
const WIDTH = 2400, SCREEN_WIDTH = 600;

let files = process.argv.slice(2);
if (files.length === 0 && fs.existsSync(inbox)) {
  files = fs.readdirSync(inbox).filter((f) => /\.png$/i.test(f)).map((f) => path.join(inbox, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}
const NAMES = [...VIEWS, ...SCREENS];
if (files.length !== NAMES.length) {
  console.error(`site:shots needs ${NAMES.length} screenshots (${NAMES.join(', ')}), found ${files.length}`);
  process.exit(1);
}
const screens = files.splice(VIEWS.length);

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
const avif = (name, from, src, width) => {
  const { w: sw, h: sh } = size(from);
  const w = even(Math.min(width, sw)), h = even((w * sh) / sw);
  const to = path.join(out, `${name}.avif`);
  execFileSync('sips', ['-s', 'format', 'avif', '-s', 'formatOptions', '80', '-z', String(h), String(w), from, '--out', to], { stdio: 'ignore' });
  console.log(`${name.padEnd(14)} ${path.basename(src)} -> site/shots/${name}.avif (${Math.round(fs.statSync(to).size / 1024)} KB)`);
};

fs.mkdirSync(out, { recursive: true });
VIEWS.forEach((view, i) => avif(view, windows[i], files[i], WIDTH));
SCREENS.forEach((screen, i) => avif(screen, screens[i], screens[i], SCREEN_WIDTH));
fs.rmSync(tmp, { recursive: true });

// a shot keeps its name, so the page asks for it by its content's hash and no cache serves the old one
const page = path.join(root, 'site/index.html');
let html = fs.readFileSync(page, 'utf8');
for (const name of NAMES) {
  const v = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, `${name}.avif`))).digest('hex').slice(0, 8);
  html = html.replace(new RegExp(`shots/${name}\\.avif(\\?v=\\w+)?"`), `shots/${name}.avif?v=${v}"`);
}
fs.writeFileSync(page, html);
