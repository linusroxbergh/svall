import { describe, expect, it } from 'vitest';
import { parseHelper, parsePs, readProcs } from '../src/load/procs.js';

describe('parseHelper', () => {
  it('is undefined for output that is not the procs JSON', () => {
    expect(parseHelper('')).toBeUndefined();
    expect(parseHelper('nope')).toBeUndefined();
    expect(parseHelper('{"other":1}')).toBeUndefined();
  });

  it('maps cpu to cpuNs and keeps the marks', () => {
    const out = JSON.stringify({ procs: [{ pid: 5, ppid: 1, start: 7, cpu: 900, mem: 4096, resp: 2, path: '/bin/zsh', args: '-zsh', char: 'c_a', home: '/h' }] });
    expect(parseHelper(out)).toEqual([{ pid: 5, ppid: 1, start: 7, cpuNs: 900, mem: 4096, resp: 2, path: '/bin/zsh', args: '-zsh', char: 'c_a', home: '/h' }]);
  });
});

describe('parsePs', () => {
  it('reads a ps row', () => {
    expect(parsePs('  42     1 32:36.80  442544 /usr/bin/x -y\n')).toEqual([
      { pid: 42, ppid: 1, start: 0, cpuNs: 1956.8e9, mem: 442544 * 1024, path: '/usr/bin/x', args: '/usr/bin/x -y' },
    ]);
  });

  it('reads h:mm:ss times', () => {
    expect(parsePs('7 1 1:02:03.50 10 x')[0].cpuNs).toBe(3723.5e9);
  });
});

describe('readProcs', () => {
  it('falls back to ps when the helper is missing', async () => {
    const procs = await readProcs('/nonexistent');
    expect(procs.length).toBeGreaterThan(0);
    expect(procs.some((p) => p.pid === process.pid)).toBe(true);
  });
});
