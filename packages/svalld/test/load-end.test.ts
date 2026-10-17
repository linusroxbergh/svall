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
    const kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
    await expect(endProcs([proc(1)], async () => [proc(1)], { kill, wait: async () => {} })).resolves.toBeUndefined();
  });
});
