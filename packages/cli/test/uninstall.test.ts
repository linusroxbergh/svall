import { afterEach, describe, expect, it, vi } from 'vitest';
import { UninstallRefused } from '@svall/svalld/uninstall';
import { uninstall, uninstallCommand, type UninstallDeps } from '../src/commands/uninstall.js';
import { REFUSED } from '../src/controller/host.js';

function fake(o: { answer?: string; isTTY?: boolean; data?: string[] } = {}) {
  const prompts: string[] = [];
  const purged: string[][] = [];
  const forced: boolean[] = [];
  const deps: UninstallDeps = {
    uninstall: async (u) => { forced.push(u.force); return ['removed /u/.local/bin/svall']; },
    data: () => o.data ?? ['/u/.svall', '/Applications/Svall.app'],
    purge: async (paths) => { purged.push(paths); return paths.map((p) => `deleted ${p}`); },
    prompt: async (q) => { prompts.push(q); return o.answer ?? ''; },
    isTTY: o.isTTY ?? true,
  };
  return { deps, prompts, purged, forced };
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

  it('uninstalls where that would strand a fleet only under --force', async () => {
    const f = fake({ data: [] });
    await uninstall({ purge: false }, f.deps);
    await uninstall({ purge: false, force: true }, f.deps);
    expect(f.forced).toEqual([false, true]);
  });

  it('does not ask when there is nothing left to delete', async () => {
    const f = fake({ data: [] });
    expect(await uninstall({ purge: false }, f.deps)).toEqual({ done: ['removed /u/.local/bin/svall'], kept: [] });
    expect(f.prompts).toEqual([]);
  });
});

describe('svall uninstall', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

  it('passes only the fleets named to force past, and exits with its own code on a refusal, saying why, so host remove tells it from any other failure', async () => {
    const said: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { said.push(String(chunk)); return true; });
    const asked: { force?: boolean; forceFleets?: string[] }[] = [];
    const why = 'uninstalling here would strand fleets: this machine is the gateway of 1 fleet, whose records are in /home/linus/.local/share/svall/gateway/fleets';
    const cmd = uninstallCommand(() => false, async (o) => { asked.push(o); throw new UninstallRefused(why); });
    await cmd.parseAsync(['--no-launchctl', '--force-fleet', '11111111-2222-3333-4444-555555555555', '--force-fleet', '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70'], { from: 'user' });
    expect(process.exitCode).toBe(REFUSED);
    expect(said.join('')).toBe(`svall: ${why}\n`);
    expect(asked).toMatchObject([{ force: false, forceFleets: ['11111111-2222-3333-4444-555555555555', '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70'] }]);

    const broken = uninstallCommand(() => false, async () => { throw new Error('this terminal runs inside the tmux server of /u/.svall'); });
    await expect(broken.parseAsync(['--no-launchctl'], { from: 'user' })).rejects.toThrow(/tmux server/);
  });
});
