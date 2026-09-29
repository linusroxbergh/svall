import { styleText } from 'node:util';
import { MARK, type Check } from './commands/doctor.js';

const COLOR = { ok: 'green', warn: 'yellow', fail: 'red', skip: 'dim' } as const;

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
