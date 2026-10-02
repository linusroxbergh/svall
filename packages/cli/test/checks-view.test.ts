import { describe, expect, it } from 'vitest';
import { grouped, renderGroups } from '../src/checks-view.js';

describe('renderGroups', () => {
  it('draws one column of groups, names padded to the widest', () => {
    const out = renderGroups([
      { title: 'Tools', checks: [{ name: 'tmux', status: 'ok', detail: 'tmux 3.5a' }, { name: 'path', status: 'warn', detail: 'not on PATH' }] },
      { title: 'Agents', checks: [{ name: 'claude', status: 'skip', detail: 'not installed' }, { name: 'codex', status: 'ok', detail: 'codex-cli 0.156.1, signed in' }] },
      { title: 'Empty', checks: [] },
    ], false);
    expect(out).toBe([
      '◇  Tools',
      '│  ✓ tmux    tmux 3.5a',
      '│  ! path    not on PATH',
      '│',
      '◇  Agents',
      '│  – claude  not installed',
      '│  ✓ codex   codex-cli 0.156.1, signed in',
    ].join('\n'));
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
