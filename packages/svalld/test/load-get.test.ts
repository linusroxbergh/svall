import { describe, expect, it } from 'vitest';
import type { LoadSnapshot, MachineId } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';

const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
const W1 = '22222222-2222-4222-8222-222222222222' as MachineId;
const W2 = '33333333-3333-4333-8333-333333333333' as MachineId;
const W3 = '44444444-4444-4444-8444-444444444444' as MachineId;
const W4 = '55555555-5555-4555-8555-555555555555' as MachineId;

const reading = (cores: number): LoadSnapshot => ({ at: 1, cores, total: { cpu: 0, mem: 0, procs: 0 }, app: { cpu: 0, mem: 0, procs: 0 }, robots: {} });
const here = async () => ({ machine: MAC, load: reading(8) });

// the home's context: the workers the fleet lists, and what each connected one answers
const home = (listed: MachineId[], answers: Partial<Record<MachineId, unknown>>): Ctx => ({
  load: here,
  store: { state: { machines: Object.fromEntries(listed.map((m) => [m, { name: m, reachable: true, since: 0 }])) } },
  links: {
    connectedWorkers: () => Object.keys(answers),
    call: async (m: MachineId) => { const a = answers[m]; if (a instanceof Error) throw a; return a; },
  },
}) as unknown as Ctx;

const machines = async (ctx: Ctx) => ((await dispatch({ id: 1, method: 'load.get', params: {} }, ctx)) as { result: { machines: unknown[] } }).result.machines;

describe('load.get', () => {
  it('answers the home\'s reading first, then each worker\'s own, a worker that gives none keeping its column', async () => {
    const ctx = home([W1, W2, W3], {
      [W1]: { machines: [{ machine: W1, load: reading(16) }] },
      [W2]: new Error('link lost'),
      // a worker speaks for itself alone
      [W4]: { machines: [{ machine: W3, load: reading(2) }] },
    });
    expect(await machines(ctx)).toEqual([
      { machine: MAC, load: reading(8) },
      { machine: W1, load: reading(16) },
      { machine: W2 },
      { machine: W3 },
      { machine: W4 },
    ]);
  });

  it('a worker whose answer is no load reading has its column, unread', async () => {
    expect(await machines(home([W1], { [W1]: reading(16) }))).toEqual([{ machine: MAC, load: reading(8) }, { machine: W1 }]);
  });

  it('a daemon with no workers answers its own reading alone', async () => {
    expect(await machines({ load: here } as unknown as Ctx)).toEqual([{ machine: MAC, load: reading(8) }]);
  });
});
