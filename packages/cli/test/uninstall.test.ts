import { describe, expect, it } from 'vitest';
import { uninstall, type UninstallDeps } from '../src/commands/uninstall.js';

function fake(o: { answer?: string; isTTY?: boolean; data?: string[] } = {}) {
  const prompts: string[] = [];
  const purged: string[][] = [];
  const deps: UninstallDeps = {
    uninstall: async () => ['removed /u/.local/bin/svall'],
    data: () => o.data ?? ['/u/.svall', '/Applications/Svall.app'],
    purge: async (paths) => { purged.push(paths); return paths.map((p) => `deleted ${p}`); },
    prompt: async (q) => { prompts.push(q); return o.answer ?? ''; },
    isTTY: o.isTTY ?? true,
  };
  return { deps, prompts, purged };
}

describe('uninstall', () => {
  it('asks before deleting the fleets, and keeps them unless the answer is yes', async () => {
    const no = fake({ answer: 'n' });
    expect(await uninstall({ purge: false }, no.deps)).toEqual({ done: ['removed /u/.local/bin/svall'], kept: ['/u/.svall', '/Applications/Svall.app'] });
    expect(no.prompts[0]).toMatch(/\/u\/\.svall[\s\S]*Svall\.app[\s\S]*\[y\/N\]/);
    expect(no.purged).toEqual([]);

    const yes = fake({ answer: 'yes' });
    expect((await uninstall({ purge: false }, yes.deps)).kept).toEqual([]);
    expect(yes.purged).toEqual([['/u/.svall', '/Applications/Svall.app']]);
  });

  it('deletes without asking under --purge, and keeps without asking when no one can answer', async () => {
    const purge = fake({ isTTY: false });
    expect((await uninstall({ purge: true }, purge.deps)).done).toContain('deleted /u/.svall');
    expect(purge.prompts).toEqual([]);

    const script = fake({ isTTY: false, answer: 'y' });
    expect((await uninstall({ purge: false }, script.deps)).kept).toHaveLength(2);
    expect(script.prompts).toEqual([]);
    expect(script.purged).toEqual([]);
  });

  it('does not ask when there is nothing left to delete', async () => {
    const f = fake({ data: [] });
    expect(await uninstall({ purge: false }, f.deps)).toEqual({ done: ['removed /u/.local/bin/svall'], kept: [] });
    expect(f.prompts).toEqual([]);
  });
});
