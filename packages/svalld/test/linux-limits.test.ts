import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { peekConfig, saveLimits } from '../src/config.js';
import { defaultLimits, limitsState, readLimits, setLimits, watchMemoryHits, withLimits, type LimitsTarget } from '../src/linux/limits.js';
import type { Run } from '../src/linux/service.js';
import { serveAsWorker, svalldUnit, unitDirOf, unitLimits, writeUnits } from '../src/linux/setup.js';
import { resolvePaths } from '../src/paths.js';
import { releaseRuntime } from '../src/runtime.js';
import { preferAsVictim } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.useRealTimers(); cleanHomes(); });

const MIB = 1024 * 1024;
const GROUP = '/user.slice/user-1000.slice/user@1000.service/app.slice/app-svall\\x2dsvalld.slice/svall-svalld@private.service';
const UNIT = 'svall-svalld@private.service';
const SIZE = { cores: 12, memoryMb: 96_000 };

/** A machine whose systemd puts the unit file's limits on the unit's cgroup at each daemon-reload, as long as it `applies`. */
function machine(o: { swap?: false; controllers?: string; anonMb?: number; active?: boolean; applies?: boolean; tmuxGroup?: string } = {}) {
  const root = makeHome();
  const homedir = path.join(root, 'home');
  const home = path.join(homedir, '.svall');
  const unitDir = unitDirOf(homedir);
  const kernel = { cgroup: path.join(root, 'cgroup'), proc: path.join(root, 'proc') };
  const dir = path.join(kernel.cgroup, GROUP);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(kernel.cgroup, 'user.slice/user-1000.slice/user@1000.service/cgroup.controllers'), `${o.controllers ?? 'cpu memory pids'}\n`);
  fs.writeFileSync(path.join(dir, 'memory.stat'), `anon ${(o.anonMb ?? 200) * MIB}\nfile 999\n`);
  fs.writeFileSync(path.join(dir, 'memory.max'), 'max\n');
  fs.writeFileSync(path.join(dir, 'cpu.max'), 'max 100000\n');
  fs.writeFileSync(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n');
  fs.mkdirSync(path.join(kernel.proc, '77'), { recursive: true });
  fs.writeFileSync(path.join(kernel.proc, '77', 'cgroup'), `0::${o.tmuxGroup ?? GROUP}\n`);
  fs.mkdirSync(path.join(kernel.proc, '5'), { recursive: true });
  fs.writeFileSync(path.join(kernel.proc, '5', 'cgroup'), `0::${GROUP}\n`);
  const unitOptions = { runtime: releaseRuntime(path.join(homedir, '.local/share/svall/current')), homedir, prefix: path.join(homedir, '.local/share/svall'), fleet: 'private', home, unitDir, env: {}, agentDirs: [] };
  writeUnits(unitOptions);
  const unitFile = path.join(unitDir, UNIT);
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('daemon-reload') && o.applies !== false) {
      const text = fs.readFileSync(unitFile, 'utf8');
      const quota = /^CPUQuota=(\d+)%$/m.exec(text)?.[1];
      const memory = /^MemoryMax=(\d+)M$/m.exec(text)?.[1];
      fs.writeFileSync(path.join(dir, 'cpu.max'), `${quota ? Number(quota) * 1000 : 'max'} 100000\n`);
      fs.writeFileSync(path.join(dir, 'memory.max'), `${memory ? Number(memory) * MIB : 'max'}\n`);
      if (o.swap !== false) fs.writeFileSync(path.join(dir, 'memory.swap.max'), `${/^MemorySwapMax=0$/m.test(text) ? '0' : 'max'}\n`);
    }
    if (args.includes('show')) return { stdout: `ControlGroup=${GROUP}\nActiveState=${o.active === false ? 'inactive' : 'active'}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const target: LimitsTarget = { fleet: 'private', home, unitDir, run, kernel, size: SIZE, tmuxPid: () => Promise.resolve(77) };
  return { target, unitFile, unitOptions, dir, kernel, calls, unit: () => fs.readFileSync(unitFile, 'utf8'), saved: () => peekConfig(resolvePaths(home)).limits };
}

describe('the default', () => {
  it('leaves the machine one core and 1 GiB, and a small machine half its memory and its one core', () => {
    expect(defaultLimits(SIZE)).toEqual({ cpus: 11, memoryMb: 94_976 });
    expect(defaultLimits({ cores: 1, memoryMb: 957 })).toEqual({ cpus: 1, memoryMb: 478 });
    expect(defaultLimits({ cores: 2, memoryMb: 2048 })).toEqual({ cpus: 1, memoryMb: 1024 });
  });
});

describe('the unit', () => {
  it('carries what node.json lets the fleet use, after OOMPolicy, and nothing without it', () => {
    const m = machine();
    expect(m.unit()).not.toMatch(/CPUQuota|MemoryMax/);
    saveLimits(resolvePaths(m.target.home), { cpus: 11, memoryMb: 94_976 });
    expect(svalldUnit(m.unitOptions).text).toContain('OOMPolicy=continue\nCPUQuota=1100%\nMemoryMax=94976M\nMemorySwapMax=0\nStandardOutput=');
    saveLimits(resolvePaths(m.target.home), { memoryMb: 2048 });
    expect(svalldUnit(m.unitOptions).text).toContain('OOMPolicy=continue\nMemoryMax=2048M\nMemorySwapMax=0\nStandardOutput=');
    expect(m.saved()).toEqual({ memoryMb: 2048 });
    saveLimits(resolvePaths(m.target.home), {});
    expect(svalldUnit(m.unitOptions).text).not.toMatch(/CPUQuota|MemoryMax/);
    expect(m.saved()).toBeUndefined();
  });

  it('is what setup renders once a limit is set as it runs, so the next setup rewrites and restarts nothing', async () => {
    const m = machine();
    await setLimits({ cpus: 4, memoryMb: 8192 }, m.target);
    expect(m.unit()).toBe(svalldUnit(m.unitOptions).text);
    expect(writeUnits(m.unitOptions)).toEqual([]);
    await setLimits({}, m.target);
    expect(m.unit()).toBe(svalldUnit(m.unitOptions).text);
    expect(m.unit()).not.toMatch(/CPUQuota|MemoryMax/);
  });

  it('keeps its limits when a re-enrol writes it again', async () => {
    const m = machine();
    await setLimits({ cpus: 4, memoryMb: 8192 }, m.target);
    fs.rmSync(m.unitFile);
    await serveAsWorker({ ...m.unitOptions, run: m.target.run });
    expect(m.unit()).toContain('CPUQuota=400%\nMemoryMax=8192M\nMemorySwapMax=0\n');
  });

  it('swaps only its limit lines', () => {
    const unit = 'a\nOOMPolicy=continue\nCPUQuota=200%\nMemoryMax=1024M\nMemorySwapMax=0\nStandardOutput=x\n';
    expect(withLimits(unit, { memoryMb: 512 })).toBe('a\nOOMPolicy=continue\nMemoryMax=512M\nMemorySwapMax=0\nStandardOutput=x\n');
    expect(withLimits(unit, { cpus: 1 })).toBe('a\nOOMPolicy=continue\nCPUQuota=100%\nStandardOutput=x\n');
    expect(withLimits(unit, {})).toBe('a\nOOMPolicy=continue\nStandardOutput=x\n');
    expect(unitLimits(undefined)).toBe('');
  });
});

describe('setting a limit', () => {
  it('saves it, reloads systemd without a restart and answers that the cgroup holds it', async () => {
    const m = machine();
    const r = await setLimits({ cpus: 11, memoryMb: 94_976 }, m.target);
    expect(r).toEqual({ size: SIZE, suggested: { cpus: 11, memoryMb: 94_976 }, limits: { cpus: 11, memoryMb: 94_976 }, state: 'applied', heldMb: 200 });
    expect(m.saved()).toEqual({ cpus: 11, memoryMb: 94_976 });
    expect(fs.readFileSync(path.join(m.dir, 'memory.max'), 'utf8')).toBe(`${94_976 * MIB}\n`);
    expect(m.calls.filter((c) => !c.includes(' show '))).toEqual(['systemctl --user daemon-reload']);
    expect(m.calls.join('\n')).not.toMatch(/restart|enable/);
  });

  it('refuses more than the machine has, and less memory than the fleet holds now, changing nothing', async () => {
    const m = machine({ anonMb: 6349 });
    await expect(setLimits({ cpus: 13 }, m.target)).rejects.toThrow('this machine has 12 cores');
    await expect(setLimits({ memoryMb: 96_001 }, m.target)).rejects.toThrow('this machine has 93.8 GB of memory');
    await expect(setLimits({ memoryMb: 4096 }, m.target)).rejects.toThrow('the fleet holds 6.2 GB here now; stop a robot or allow more');
    await expect(setLimits({ memoryMb: 100 }, m.target)).rejects.toThrow();
    expect(m.saved()).toBeUndefined();
    expect(m.calls.join('\n')).not.toContain('daemon-reload');
  });

  it('takes back a limit systemd did not put on the unit, to the one before', async () => {
    const m = machine();
    await setLimits({ memoryMb: 8192 }, m.target);
    const stuck = machine({ applies: false });
    await expect(setLimits({ memoryMb: 8192 }, stuck.target)).rejects.toThrow('the limit was not set: systemd did not put it on the fleet\'s unit');
    expect(stuck.saved()).toBeUndefined();
    expect(stuck.unit()).not.toMatch(/MemoryMax/);
  });

  it('refuses a limit on cores where the account is given no control of them, and offers memory alone', async () => {
    const m = machine({ controllers: 'memory pids' });
    expect((await readLimits(m.target)).suggested).toEqual({ memoryMb: 94_976 });
    await expect(setLimits({ cpus: 4 }, m.target)).rejects.toThrow(/no control of cores: as root, put Delegate=/);
    expect(m.saved()).toBeUndefined();
    expect((await setLimits({ memoryMb: 8192 }, m.target)).state).toBe('applied');
  });

  it('takes swap from a fleet with a memory limit, gives it back with the limit, and holds where the kernel counts no swap', async () => {
    const m = machine();
    const swap = () => fs.readFileSync(path.join(m.dir, 'memory.swap.max'), 'utf8');
    expect((await setLimits({ memoryMb: 8192 }, m.target)).state).toBe('applied');
    expect(swap()).toBe('0\n');
    fs.writeFileSync(path.join(m.dir, 'memory.swap.max'), 'max\n');
    expect((await readLimits(m.target)).state).toBe('unapplied');
    await setLimits({ cpus: 2 }, m.target);
    expect(swap()).toBe('max\n');
    expect((await setLimits({ memoryMb: 8192 }, machine({ swap: false }).target)).state).toBe('applied');
  });

  it('holds from the unit\'s start when it is not running', async () => {
    const m = machine({ active: false });
    expect(await setLimits({ memoryMb: 8192 }, m.target)).toMatchObject({ state: 'pending', limits: { memoryMb: 8192 } });
    expect(m.unit()).toContain('MemoryMax=8192M');
  });

  it('fails in words, and sets nothing, where systemd cannot be asked', async () => {
    const m = machine();
    const run: Run = () => Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'Failed to connect to bus: No medium found\n' }));
    await expect(setLimits({ memoryMb: 8192 }, { ...m.target, run })).rejects.toThrow('systemctl found no systemd user session');
    expect(m.saved()).toBeUndefined();
  });

  it('says so when the fleet\'s tmux runs outside the unit, where no limit reaches its robots', async () => {
    const m = machine({ tmuxGroup: '/user.slice/user-1000.slice/user@1000.service/tmux-spawn-1.scope' });
    expect((await setLimits({ memoryMb: 8192 }, m.target)).state).toBe('outside');
    expect((await limitsState({}, { run: m.target.run, unit: UNIT, kernel: m.kernel })).state).toBe('none');
  });
});

describe('at the memory limit', () => {
  it('counts each process the kernel stops in the daemon\'s cgroup from the daemon\'s start on', () => {
    vi.useFakeTimers();
    const m = machine();
    const events = path.join(m.dir, 'memory.events');
    fs.writeFileSync(events, 'oom 3\noom_kill 3\n');
    const said: number[] = [];
    const w = watchMemoryHits({ kernel: m.kernel, pid: 5, onHit: (n) => said.push(n), everyMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(w.hits()).toEqual({ hits: 0 });
    fs.writeFileSync(events, 'oom 5\noom_kill 5\n');
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(w.hits()).toMatchObject({ hits: 2, lastHit: expect.any(Number) });
    expect(said).toEqual([2]);
    w.stop();
  });

  it('marks a pane\'s process as the one to stop first', () => {
    const m = machine();
    preferAsVictim(77, m.kernel.proc);
    expect(fs.readFileSync(path.join(m.kernel.proc, '77', 'oom_score_adj'), 'utf8')).toBe('500');
    expect(() => preferAsVictim(4242, m.kernel.proc)).not.toThrow();
  });
});
