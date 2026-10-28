import { styleText } from 'node:util';
import type { SetupRow } from '@svall/protocol';

/**
 * One thing a doctor checked, and what it found; `run`: a next command toward the fix, for the user to run on that machine;
 * `action`, `forward`, `tick` and `gap`: a setup row's, as its step carries them.
 */
export type Check = {
  name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string; run?: string; action?: string; forward?: number; tick?: SetupRow['tick']; gap?: SetupRow['gap'];
};

export const tickMark = (tick?: SetupRow['tick']): string => (tick ? (tick.on ? '[x] ' : '[ ] ') : '');

export const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

const COLOR = { ok: 'green', warn: 'yellow', fail: 'red', skip: 'dim' } as const;

const GROUPS: [string, string[]][] = [
  ['Tools', ['tmux', 'node', 'path', 'gh']],
  ['Agents', ['claude', 'codex', 'codex sandbox', 'opencode', 'agents']],
  ['Fleet', ['config', 'svalld', 'hook receiver', 'launchd', 'systemd', 'linger', 'daemon node', 'daemon path', 'daemon env']],
  ['Setup', ['hooks', 'codex hooks', 'opencode plugin', 'shims', 'launchd plist']],
];

/** `checks` under the titles they show with, each group in the order its names come, and any check no group names last. */
export const grouped = (checks: Check[]): { title: string; checks: Check[] }[] => [
  ...GROUPS.map(([title, names]) => ({ title, checks: names.flatMap((n) => checks.filter((c) => c.name === n)) })),
  { title: 'Other', checks: checks.filter((c) => !GROUPS.some(([, names]) => names.includes(c.name))) },
];

// the installer reads this through a file, so it passes its own terminal's answer in FORCE_COLOR
export const useColor = (): boolean =>
  process.env.FORCE_COLOR !== undefined ? process.env.FORCE_COLOR !== '0' : !process.env.NO_COLOR && process.stdout.isTTY === true;

export function renderGroups(groups: { title: string; checks: Check[] }[], color: boolean): string {
  const paint = (style: Parameters<typeof styleText>[0], text: string) => (color ? styleText(style, text, { validateStream: false }) : text);
  const shown = groups.filter((g) => g.checks.length);
  const width = Math.max(0, ...shown.flatMap((g) => g.checks.map((c) => c.name.length)));
  const bar = paint('dim', '│');
  return shown.map((g) => [
    `${paint('cyan', '◇')}  ${g.title}`,
    ...g.checks.map((c) => `${bar}  ${paint(COLOR[c.status], MARK[c.status])} ${c.name.padEnd(width)}  ${c.detail}`),
  ].join('\n')).join(`\n${bar}\n`);
}
