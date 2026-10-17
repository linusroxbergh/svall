import { describe, expect, it } from 'vitest';
import { endProcs } from '../src/load/end.js';
import type { LiveProc } from '../src/load/procs.js';

const proc = (pid: number, start = 100): LiveProc => ({ pid, ppid: 1, start, cpuNs: 0, mem: 0, path: '/bin/x', args: 'x' });
const setup = (after: LiveProc[]) => {
  const calls: [number, string][] = [];
  const kill = (pid: number, sig: NodeJS.Signals) => { calls.push([pid, sig]); };
  return { calls, kill, read: async () => after, wait: async () => {} };
};

describe('endProcs', () => {
  it('terms every victim, then kills the ones still there', async () => {
    const s = setup([proc(2)]);
    await endProcs([proc(1), proc(2)], s.read, { kill: s.kill, wait: s.wait });
    expect(s.calls).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM'], [2, 'SIGKILL']]);
  });

  it('spares a reused pid', async () => {
    const s = setup([proc(2, 999)]);
    await endProcs([proc(1), proc(2)], s.read, { kill: s.kill, wait: s.wait });
    expect(s.calls).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM']]);
  });

  it('ignores a victim already gone', async () => {
    const calls: [number, string][] = [];
    const kill = (pid: number, sig: NodeJS.Signals) => {
      calls.push([pid, sig]);
      if (pid === 1) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    await endProcs([proc(1), proc(2)], async () => [proc(1), proc(2)], { kill, wait: async () => {} });
    expect(calls).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM'], [1, 'SIGKILL'], [2, 'SIGKILL']]);
  });

  it('neither waits nor reads again when every victim is already gone', async () => {
    const calls: [number, string][] = [];
    const kill = (pid: number, sig: NodeJS.Signals) => {
      calls.push([pid, sig]);
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    let waited = false;
    await endProcs([proc(1), proc(2)], async () => { throw new Error('read'); }, { kill, wait: async () => { waited = true; } });
    expect(waited).toBe(false);
    expect(calls).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM']]);
  });

  it('kills a victim whose re-read row has no start time', async () => {
    const s = setup([proc(2, 0)]);
    await endProcs([proc(2, 100)], s.read, { kill: s.kill, wait: s.wait });
    expect(s.calls).toEqual([[2, 'SIGTERM'], [2, 'SIGKILL']]);
  });

  it('waits the grace period between TERM and KILL', async () => {
    const s = setup([proc(1)]);
    const log: string[] = [];
    await endProcs([proc(1)], s.read, { kill: (_pid, sig) => { log.push(sig); }, wait: async (ms) => { log.push(`wait ${ms}`); } });
    expect(log).toEqual(['SIGTERM', 'wait 3000', 'SIGKILL']);
  });

  it('does nothing without victims', async () => {
    const s = setup([]);
    let waited = false;
    await endProcs([], async () => { throw new Error('read'); }, { kill: s.kill, wait: async () => { waited = true; } });
    expect(waited).toBe(false);
    expect(s.calls).toEqual([]);
  });
});
