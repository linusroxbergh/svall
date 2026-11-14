import { describe, expect, it } from 'vitest';
import { emptyState, type FleetState, type MachineId, type Robot } from '@svall/protocol';
import { homeRelative, homesOf, memberStarts } from '../src/workspace/island-folder.js';

const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
const robot = (id: string, o: Partial<Robot>): Robot => ({ id, islandId: 'i1', ...o }) as Robot;

describe('an island folder, spelled from the home it lies under', () => {
  it.each([
    ['/Users/a/code/x/', '~/code/x'],
    ['/Users/a', '~'],
    ['/home/a/code//x', '~/code/x'],
    ['/srv/x', '/srv/x'],
    ['~/code/../x', '~/x'],
    ['/Users/ab/x', '/Users/ab/x'],
  ])('%s is %s', (p, want) => {
    expect(homeRelative(p, ['/home/a', '/Users/a'])).toBe(want);
  });

  it('knows this machine\'s home and each machine\'s', () => {
    const f: FleetState = { ...emptyState(), machines: { [MAC]: { name: 'mac', reachable: true, since: 0, home: '/Users/a' } } };
    expect(homesOf(f, '/home/a')).toEqual(['/home/a', '/Users/a']);
  });
});

describe('the folders an island\'s robots start from', () => {
  it('spells each by its own machine\'s home, the main checkout for a worktree, the most robots first', () => {
    const f: FleetState = {
      ...emptyState(),
      machines: { [MAC]: { name: 'mac', reachable: true, since: 0, home: '/Users/a' } },
      robots: Object.fromEntries([
        robot('c1', { cwd: '/home/a/notes' }),
        robot('c2', { cwd: '/Users/a/app/.claude/worktrees/t', machine: MAC, repo: { root: '/Users/a/app/.claude/worktrees/t', mainRoot: '/Users/a/app', branch: 't', isWorktree: true } }),
        robot('c3', { cwd: '/Users/a/app', machine: MAC }),
        robot('c4', { cwd: '/home/a/elsewhere', islandId: 'i2' }),
      ].map((c) => [c.id, c])),
    };
    expect(memberStarts(f, 'i1', '/home/a')).toEqual(['~/app', '~/notes']);
  });
});
