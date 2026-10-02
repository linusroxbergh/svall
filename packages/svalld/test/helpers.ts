import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MobileStatus, UsageSnapshot } from '@svall/protocol';
import type { Fleet } from '../src/fleet.js';
import type { Fleets } from '../src/fleets.js';
import type { Mobile } from '../src/mobile.js';

// the root config's test/isolate.ts moves HOME; a run without it would reach the real HOME and the live fleet
if (!process.env.HOME?.startsWith('/tmp/svall-home-')) throw new Error('run these tests through the root vitest config (pnpm test)');

const homes: string[] = [];

export function makeHome(): string {
  const dir = fs.mkdtempSync('/tmp/svall-t-');
  homes.push(dir);
  return dir;
}

export function cleanHomes(): void {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
}

export function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// where Ghostty keeps the terminfo it ships: the vendored build the app bundles, then an installed Ghostty
const GHOSTTY_TERMINFO = [
  path.join(import.meta.dirname, '../../../vendor/ghostty-kit/share/terminfo'),
  '/Applications/Ghostty.app/Contents/Resources/terminfo',
];

// the environment a desktop client attaches with. tmux refuses a TERM it cannot look up, and
// xterm-ghostty ships with Ghostty rather than with ncurses; undefined when the machine has neither.
export function ghosttyTermEnv(): Record<string, string> | undefined {
  const term = { TERM: 'xterm-ghostty' };
  try { execFileSync('infocmp', ['xterm-ghostty'], { stdio: 'ignore' }); return term; } catch { /* not on the terminfo path */ }
  const dir = GHOSTTY_TERMINFO.find((d) => fs.existsSync(`${d}/78/xterm-ghostty`));
  return dir ? { ...term, TERMINFO_DIRS: `${dir}:` } : undefined;
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor: timed out');
}

// counts only polls begun after the call: a slow listing lets polls overlap, so an earlier one can end later
export async function waitForPolls(fleet: Fleet, n: number): Promise<void> {
  const tick = fleet['tick'];
  let done = 0;
  fleet['tick'] = async () => { await tick.call(fleet); done++; };
  try { await waitFor(() => done >= n); } finally { fleet['tick'] = tick; }
}

// startApi needs a reading of the plan's limits; tests that are not about usage take this one
export const stubUsage = (): Promise<UsageSnapshot> =>
  Promise.resolve({ available: false, windows: [] });

// and a phone link it can report; tests that are not about serving take this one
const OFF: MobileStatus = { serving: false, url: '', port: 443, logins: [], phones: [], error: 'no tailscale in tests' };
export const stubMobile: Mobile = { get: () => Promise.resolve(OFF), set: () => Promise.resolve(OFF) };

// and the fleets beside it, which tests not about them never start
export const stubFleets: Fleets = {
  list: () => Promise.resolve([]),
  create: () => Promise.reject(new Error('no fleets in tests')),
  start: () => Promise.reject(new Error('no fleets in tests')),
};
