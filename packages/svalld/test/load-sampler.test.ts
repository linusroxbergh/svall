import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadSampler } from '../src/load/sampler.js';
import type { LiveProc } from '../src/load/procs.js';
import type { Scope } from '../src/load/attribute.js';

const proc = (pid: number, ppid: number, cpuMs: number, over: Partial<LiveProc> = {}): LiveProc =>
  ({ pid, ppid, start: 1, cpuNs: cpuMs * 1e6, mem: 1000, path: '/bin/x', args: 'x', ...over });

const scope = (over: Partial<Scope> = {}): Scope => ({ home: '/h', panes: new Map([['c_a', [10]]]), own: [], ...over });

function sampler(reads: LiveProc[][], sc: Scope = scope()) {
  let n = 0;
  const read = vi.fn(async () => reads[Math.min(n++, reads.length - 1)]);
  return { read, load: new LoadSampler({ read, scope: async () => sc, sleepable: () => true }) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LoadSampler', () => {
  it('shows CPU at once by reading twice', async () => {
    const { read, load } = sampler([[proc(10, 1, 0)], [proc(10, 1, 250)]]);
    const p = load.get();
    await vi.advanceTimersByTimeAsync(500);
    const snap = await p;
    expect(read).toHaveBeenCalledTimes(2);
    expect(snap.chars.c_a.cpu).toBeCloseTo(50);
    load.stop();
  });

  it('samples every 4 s while asked and stops 10 s after the last ask', async () => {
    const { read, load } = sampler([[proc(10, 1, 0)]]);
    const first = load.get();
    await vi.advanceTimersByTimeAsync(500);
    await first;
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(3000); await load.get(); }
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(5);
    const asked = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(read.mock.calls.length).toBeGreaterThan(asked);
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(settled);
    load.stop();
  });

  it('counts a process seen first in this sample from zero', async () => {
    const { load } = sampler([[proc(10, 1, 0)], [proc(10, 1, 0), proc(11, 10, 100)]]);
    const p = load.get();
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).chars.c_a.cpu).toBeCloseTo(20);
    load.stop();
  });

  it('drops a process gone since the last sample', async () => {
    const { load } = sampler([[proc(10, 1, 0), proc(11, 10, 900)], [proc(10, 1, 100)]]);
    const p = load.get();
    await vi.advanceTimersByTimeAsync(500);
    const snap = await p;
    expect(snap.chars.c_a.cpu).toBeCloseTo(20);
    expect(snap.chars.c_a.procs).toBe(1);
    load.stop();
  });

  it('marks a robot running only its shells', async () => {
    const shell = sampler([[proc(10, 1, 0)]]);
    const a = shell.load.get();
    await vi.advanceTimersByTimeAsync(500);
    expect((await a).chars.c_a.shellOnly).toBe(true);
    shell.load.stop();
    const agent = sampler([[proc(10, 1, 0), proc(11, 10, 0)]]);
    const b = agent.load.get();
    await vi.advanceTimersByTimeAsync(500);
    expect((await b).chars.c_a.shellOnly).toBe(false);
    agent.load.stop();
  });

  it('adds up the total from the app, codex and every robot', async () => {
    const sc = scope({ panes: new Map([['c_a', [10]], ['c_b', [20]], ['c_c', []]]), appPid: 30, own: [] });
    const rows = [proc(10, 1, 0), proc(20, 1, 0), proc(30, 1, 0), proc(40, 1, 0, { args: 'codex app-server' })];
    const { load } = sampler([rows, rows.map((r) => ({ ...r, cpuNs: r.cpuNs + 100e6 }))], sc);
    const p = load.get();
    await vi.advanceTimersByTimeAsync(500);
    const s = await p;
    expect(Object.keys(s.chars).sort()).toEqual(['c_a', 'c_b']);
    expect(s.app.procs).toBe(1);
    const parts = [s.app, ...(s.codex ? [s.codex] : []), ...Object.values(s.chars)];
    expect(s.total.procs).toBe(parts.reduce((n, u) => n + u.procs, 0));
    expect(s.total.mem).toBe(parts.reduce((n, u) => n + u.mem, 0));
    expect(s.total.cpu).toBeCloseTo(parts.reduce((n, u) => n + u.cpu, 0));
    expect(s.total.procs).toBeGreaterThanOrEqual(3);
    expect(s.cores).toBeGreaterThan(0);
    load.stop();
  });

  it('matches a ps row, which has no start, to the helper row of the same pid', async () => {
    const { load } = sampler([[proc(10, 1, 900, { start: 0 })], [proc(10, 1, 1000, { start: 5 })]]);
    const p = load.get();
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).chars.c_a.cpu).toBeCloseTo(20);
    load.stop();
  });

  it('skips a tick while a reading is in flight', async () => {
    let n = 0;
    let release!: () => void;
    const read = vi.fn(async () => {
      if (++n === 3) await new Promise<void>((r) => { release = r; });
      return [proc(10, 1, 0)];
    });
    const load = new LoadSampler({ read, scope: async () => scope(), sleepable: () => true });
    const first = load.get();
    await vi.advanceTimersByTimeAsync(500);
    await first;
    for (let i = 0; i < 3; i++) { void load.get(); await vi.advanceTimersByTimeAsync(4000); }
    expect(read).toHaveBeenCalledTimes(3);
    release();
    void load.get();
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(4);
    load.stop();
  });

  it('tells the asker of a sample that failed, and keeps the reading for when one succeeds', async () => {
    let n = 0;
    const read = vi.fn(async () => { if (++n === 3) throw new Error('ps died'); return [proc(10, 1, n * 100)]; });
    const load = new LoadSampler({ read, scope: async () => scope(), sleepable: () => true });
    const first = load.get();
    await vi.advanceTimersByTimeAsync(500);
    await first;
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(3);
    await expect(load.get()).rejects.toThrow('ps died');
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(4);
    expect((await load.get()).chars.c_a.procs).toBe(1);
    load.stop();
  });

  it('starts afresh after a stop that landed while scope was pending', async () => {
    let release!: () => void;
    let slow = false;
    const read = vi.fn(async () => [proc(10, 1, 0)]);
    const load = new LoadSampler({
      read,
      scope: async () => { if (slow) await new Promise<void>((r) => { release = r; }); return scope(); },
      sleepable: () => true,
    });
    const first = load.get();
    await vi.advanceTimersByTimeAsync(500);
    await first;
    slow = true;
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10_000);
    slow = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    const before = read.mock.calls.length;
    const again = load.get();
    await vi.advanceTimersByTimeAsync(500);
    await again;
    expect(read.mock.calls.length - before).toBe(2);
    load.stop();
  });

  it('starts no timer when stopped during the first reading', async () => {
    let release!: () => void;
    let n = 0;
    const read = vi.fn(async () => {
      if (++n === 1) await new Promise<void>((r) => { release = r; });
      return [proc(10, 1, 0)];
    });
    const load = new LoadSampler({ read, scope: async () => scope(), sleepable: () => true });
    void load.get();
    load.stop();
    release();
    await vi.advanceTimersByTimeAsync(500);
    const seen = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(seen);
  });
});
