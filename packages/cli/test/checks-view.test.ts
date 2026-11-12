import { describe, expect, it } from 'vitest';
import { grouped, renderGroups } from '../src/checks-view.js';

describe('renderGroups', () => {
  it('draws one column of groups, names padded to the widest', () => {
    const out = renderGroups([
      { title: 'Tools', checks: [{ name: 'tmux', status: 'ok', detail: 'tmux 3.5a' }, { name: 'path', status: 'warn', detail: 'not on PATH' }] },
      { title: 'Agents', checks: [{ name: 'claude', status: 'skip', detail: 'not installed' }, { name: 'codex', status: 'ok', detail: '0.156.1, logged in' }] },
      { title: 'Empty', checks: [] },
    ], false);
    expect(out).toBe([
      '◇  Tools',
      '│  ✓ tmux    tmux 3.5a',
      '│  ! path    not on PATH',
      '│',
      '◇  Agents',
      '│  – claude  not installed',
      '│  ✓ codex   0.156.1, logged in',
    ].join('\n'));
  });
  it('gives a check its action after its state, and what a tool said under one that failed or warned', () => {
    const out = renderGroups([{ title: 'Fleet', checks: [
      { name: 'systemd', status: 'fail', detail: 'not running', raw: 'svall-svalld@private.service: loaded, inactive (dead), enabled' },
      { name: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'sudo loginctl enable-linger ada' },
      { name: 'config', status: 'ok', detail: 'defaults', raw: 'there is no fleet.json' },
    ] }], false);
    expect(out.split('\n')).toEqual([
      '◇  Fleet',
      '│  ✗ systemd  not running',
      '│     svall-svalld@private.service: loaded, inactive (dead), enabled',
      '│  ! linger   off: the fleet stops when you log out -> sudo loginctl enable-linger ada',
      '│  ✓ config   defaults',
    ]);
  });
  it('colours only the marks and the gutter', () => {
    const out = renderGroups([{ title: 'T', checks: [{ name: 'x', status: 'fail', detail: 'run svall setup' }] }], true);
    expect(out).toContain('run svall setup');
    expect(out).toMatch(/\u001b\[/);
  });
});

describe('grouped', () => {
  it('shows a check no group names under Other, rather than dropping it', () => {
    const groups = grouped([{ name: 'tmux', status: 'ok', detail: 'tmux 3.5a' }, { name: 'new check', status: 'warn', detail: 'added since' }]);
    expect(groups.find((g) => g.title === 'Tools')?.checks.map((c) => c.name)).toEqual(['tmux']);
    expect(groups.at(-1)).toEqual({ title: 'Other', checks: [{ name: 'new check', status: 'warn', detail: 'added since' }] });
  });
});
