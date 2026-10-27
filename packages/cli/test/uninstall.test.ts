import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unitDirOf } from '@svall/svalld/linux/setup';
import { machineId } from '@svall/svalld/machine';
import { bundleRuntime, releaseRuntime } from '@svall/svalld/runtime';
import { runUninstall } from '@svall/svalld/uninstall';
import { keptLine, uninstall, uninstallCommand, type UninstallDeps } from '../src/commands/uninstall.js';

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

  it('says how to delete what it kept with a command that is still there', () => {
    expect(keptLine(['/u/.svall', '/u/.svall-work'], releaseRuntime('/u/.local/share/svall/current')))
      .toBe("kept /u/.svall, /u/.svall-work; rm -rf '/u/.svall' '/u/.svall-work' deletes them");
    expect(keptLine(['/u/.svall'], bundleRuntime('/Applications/Svall.app')))
      .toBe("kept /u/.svall; '/Applications/Svall.app/Contents/Helpers/node' '/Applications/Svall.app/Contents/Resources/runtime/svall.mjs' uninstall --purge deletes them");
  });
});

describe('svall uninstall', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

  it('uninstalls where a fleet.json names a gateway, with no --force', async () => {
    // this test's own HOME, as a Linux companion's: a fleet it runs for its gateway, and the gateway's unit
    const home = path.join(os.homedir(), '.svall');
    const fleet = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleet, gatewayMachineId: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' }));
    fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: fleet, generation: 3, ownerMachineId: machineId() }));
    const unitDir = unitDirOf(os.homedir());
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'svall-gateway.service'), '[Service]\n');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const linux = uninstallCommand(() => false, (o) => runUninstall({ ...o, platform: 'linux', run: async () => ({ stdout: '', stderr: '' }) }));
    await linux.parseAsync(['--no-launchctl'], { from: 'user' });
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.existsSync(path.join(unitDir, 'svall-gateway.service'))).toBe(false);
  });

  it('fails as the uninstall it runs does', async () => {
    const broken = uninstallCommand(() => false, async () => { throw new Error('this terminal runs inside the tmux server of /u/.svall'); });
    await expect(broken.parseAsync(['--no-launchctl'], { from: 'user' })).rejects.toThrow(/tmux server/);
  });
});
