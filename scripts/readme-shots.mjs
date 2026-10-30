// Makes the README's two images from the landing page's shots: the phone view with the phone's fleet list standing
// over it, and the browser view. site-shots.mjs runs it after it makes the shots. Needs ImageMagick.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shot = (name) => path.join(root, 'site/shots', `${name}.avif`);
const asset = (name) => path.join(root, 'assets', `${name}.jpg`);
const magick = (...args) => execFileSync('magick', args, { encoding: 'utf8' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'));
const at = (name) => path.join(tmp, `${name}.png`);

// the phone's screen width, bezel and outer corner radius, and its distance from the view's bottom right corner
const SCREEN = 460, BEZEL = 16, RADIUS = 64, RIGHT = 120, BOTTOM = 40;

magick(shot('phone-list'), '-resize', `${SCREEN}x`, at('screen'));
const [w, h] = magick(at('screen'), '-format', '%w %h', 'info:').split(' ').map(Number);
const W = w + 2 * BEZEL, H = h + 2 * BEZEL, r = RADIUS - BEZEL;
magick(at('screen'), '(', '-size', `${w}x${h}`, 'xc:none', '-fill', 'white', '-draw', `roundrectangle 0,0 ${w - 1},${h - 1} ${r},${r}`, ')',
  '-compose', 'DstIn', '-composite', at('screen'));
magick('-size', `${W}x${H}`, 'xc:none', '-fill', '#0b0b0d', '-stroke', '#3a3a40', '-strokewidth', '3',
  '-draw', `roundrectangle 1,1 ${W - 2},${H - 2} ${RADIUS},${RADIUS}`, at('screen'), '-geometry', `+${BEZEL}+${BEZEL}`, '-composite',
  '(', '+clone', '-background', 'black', '-shadow', '70x24+0+12', ')', '+swap', '-background', 'none', '-layers', 'merge', '+repage', at('phone'));

// the window's rounded corners are transparent, and the README has always shown them on black
const jpg = ['-background', 'black', '-alpha', 'remove', '-alpha', 'off', '-quality', '85'];
magick(shot('phone'), at('phone'), '-gravity', 'southeast', '-geometry', `+${RIGHT}+${BOTTOM}`, '-composite', ...jpg, asset('svall_overview'));
magick(shot('browser'), ...jpg, asset('svall_browser'));
fs.rmSync(tmp, { recursive: true });
for (const name of ['svall_overview', 'svall_browser']) {
  console.log(`${name.padEnd(14)} -> assets/${name}.jpg (${Math.round(fs.statSync(asset(name)).size / 1024)} KB)`);
}
