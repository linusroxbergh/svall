import { describe, expect, it } from 'vitest';
import { emptyState, MachineId, relabelHome, type FleetState, type Robot } from '../src/index.js';

const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const STUDIO = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const robot = (id: string, machine?: MachineId, generation?: number): Robot => ({
  id, islandId: 'i_a', cell: { x: 0, y: 0 }, name: id, portrait: 'fox', note: '', instructions: '', cwd: '/x', context: [], shell: { lastOutputAt: 0 }, unread: false,
  ...(machine && { machine }), ...(generation !== undefined && { placement: { generation } }),
} as unknown as Robot);
const fleet = (): FleetState => ({
  ...emptyState(),
  robots: { here: robot('here'), placed: robot('placed', STUDIO, 3), moved: robot('moved', undefined, 2) },
  machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1, home: '/home/ada', replayed: { epoch: 'e', seq: 9 } } },
});
const out = { from: MAC, fromName: 'mac', fromHome: '/Users/ada', to: STUDIO, toName: 'studio', toHome: '/home/ada', at: 5 };

describe('relabelHome', () => {
  it("names the old home on what ran there, at its generation, and nothing on what ran on the new one", () => {
    const { robots } = relabelHome(fleet(), out);
    expect(robots.here).toMatchObject({ machine: MAC, placement: { generation: 0 } });
    expect(robots.moved).toMatchObject({ machine: MAC, placement: { generation: 2 } });
    expect(robots.placed.machine).toBeUndefined();
    expect(robots.placed.placement).toEqual({ generation: 3 });
  });

  it('takes the new home out of its own machines, and lists the old one as out of reach', () => {
    const { machines } = relabelHome(fleet(), out);
    expect(Object.keys(machines ?? {})).toEqual([MAC]);
    expect(machines?.[MAC]).toEqual({ name: 'mac', reachable: false, since: 5, home: '/Users/ada' });
  });

  it('stamps a snapshot only for the side that starts as a worker, the home named beside itself', () => {
    expect(Object.values(relabelHome(fleet(), out).machines ?? {}).some((m) => m.snapshot)).toBe(false);
    const { machines } = relabelHome(fleet(), { ...out, stamp: true });
    expect(machines?.[STUDIO]).toEqual({ name: 'studio', reachable: false, since: 5, home: '/home/ada', snapshot: { version: 0, at: 5 } });
    expect(machines?.[MAC]?.snapshot).toBeUndefined();
  });

  it('leaves its input as it was, and comes back whole the other way', () => {
    const before = fleet();
    const moved = relabelHome(before, out);
    expect(before).toEqual(fleet());
    const back = relabelHome(moved, { from: STUDIO, fromName: 'studio', fromHome: '/home/ada', to: MAC, toName: 'mac', toHome: '/Users/ada', at: 6 });
    expect(back.robots.here.machine).toBeUndefined();
    expect(back.robots.placed.machine).toBe(STUDIO);
  });

  it('run twice it mislabels, which is why a retry starts from the input', () => {
    const twice = relabelHome(relabelHome(fleet(), out), out);
    expect(twice.robots.placed.machine).toBe(MAC);
  });
});
