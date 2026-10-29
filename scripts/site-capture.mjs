// Takes the landing page's seven shots and makes the views with site-shots.mjs: the fleet's app window in five layouts that
// `svall app show` sets, then its phone page's fleet list and a robot's terminal in Playwright's iPhone WebKit.
// `pnpm site:capture [robot] [--profile demo] [--file src/App.tsx] [--phone-robot <robot>]`, with the robot's terminal,
// browser tab and repo as they should show. It brings the window to the front for about 15 s; hands off meanwhile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { profile: { type: 'string', default: 'demo' }, file: { type: 'string', default: 'src/App.tsx' }, 'phone-robot': { type: 'string' } },
});
const robot = positionals[0] ?? 'flaky e2e';
const svall = (...args) => execFileSync('svall', ['-p', o.profile, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the window's content size; site-shots.mjs scales every capture to 2400 px wide, so a larger window shows more, smaller
const SIZE = '1800,1119';
// for the panes to settle and the native terminal and browser to draw
const SETTLE_MS = 1500;
const BASE = ['--card', 'half', '--left', 'terminal', '--ratio', '0.5', '--sidebar', 'show', '--side-card', 'show', '--view', 'map', '--panel', 'none', '--size', SIZE];
const VIEWS = [
  ['browser', ['--right', 'browser']],
  ['files', ['--right', 'files', '--tree', 'show', '--file', o.file]],
  ['markdown', ['--right', 'files', '--tree', 'hide', '--file', 'README.md', '--preview']],
  ['board', ['--view', 'board', '--card', 'closed']],
  ['phone', ['--card', 'closed', '--panel', 'phone', '--redact', 'https://svall.dev']],
];

// the window's title shows only to a process with Screen Recording, which screencapture needs as well
function findWindow() {
  const title = ` · ${o.profile}`;
  const js = `ObjC.import('CoreGraphics'); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
    .filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowName?.endsWith(${JSON.stringify(title)})).map((w) => ({ id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID })))`;
  const found = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }));
  if (found.length !== 1) throw new Error(found.length ? `${found.length} windows end in${title}` : `no window ends in${title}: is Screen Recording on for this terminal?`);
  return found[0];
}

// each fleet's window is its own instance of the app, so it is brought forward by its process; an inactive one shows grey lights
const front = (pid) => execFileSync('osascript', ['-l', 'JavaScript', '-e',
  `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions($.NSApplicationActivateAllWindows)`]);

// a fleet's first questions open over the window until they are answered
const state = JSON.parse(svall('--json', 'status'));
const asks = [state.scribeAsk && 'the scribe', state.placingAsk && "the board's placing"].filter(Boolean);
if (asks.length) throw new Error(`answer the question about ${asks.join(' and ')} in the app first: it covers the window`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-capture-'));
const shots = [];

// the phone panel and the phone page both need the link on; the page pairs from the link's fragment, as a phone opening the QR does
const { pair } = JSON.parse(svall('--json', 'mobile', 'on'));
// opening the fleet brings its window to the front, and WebKit draws nothing in a window that is covered
svall();
await sleep(2000);
const { id, pid } = findWindow();
for (const [name, flags] of VIEWS) {
  svall('app', 'show', robot, ...BASE, ...flags);
  front(pid);
  await sleep(SETTLE_MS);
  const to = path.join(tmp, `${shots.length + 1}-${name}.png`);
  execFileSync('screencapture', ['-x', '-o', `-l${id}`, to]);
  shots.push(to);
}
svall('app', 'show', robot, '--panel', 'none');

const { webkit, devices } = createRequire(path.join(root, 'apps/desktop/web/package.json'))('@playwright/test');
const browser = await webkit.launch();
try {
  // the whole screen, as the phone on the page shows it, rather than what Safari's bars leave
  const page = await browser.newPage({ ...devices['iPhone 15'], viewport: { width: 393, height: 852 }, colorScheme: 'dark' });
  await page.goto(pair);
  const row = page.locator('.row-main', { hasText: o['phone-robot'] ?? robot });
  await row.waitFor();
  await sleep(SETTLE_MS);
  shots.push(path.join(tmp, '6-phone-list.png'));
  await page.screenshot({ path: shots.at(-1) });
  await row.click();
  await page.locator('.xterm').waitFor();
  await sleep(SETTLE_MS);
  shots.push(path.join(tmp, '7-phone-terminal.png'));
  await page.screenshot({ path: shots.at(-1) });
} finally {
  await browser.close();
}

execFileSync('node', [path.join(root, 'scripts/site-shots.mjs'), ...shots], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true });
