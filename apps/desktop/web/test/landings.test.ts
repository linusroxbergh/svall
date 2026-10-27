import { describe, expect, it, vi } from 'vitest';
import type { FleetState, MachineId, SetupRow } from '@svall/protocol';
import { followLandings } from '../src/landings.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const linear: SetupRow = { key: 'claude:mcp:linear', status: 'warn', detail: 'd', action: "copy linear's keys to vault", gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' } };
const notion: SetupRow = { key: 'oauth:claude:mcp:notion', status: 'warn', detail: 'd', run: 'claude', gap: { name: 'notion', what: 'not logged in' } };

describe('a robot landing on a worker', () => {
  const at = (edit: (f: FleetState) => void): FleetState => {
    const f = fleet();
    f.machines = { [VAULT]: { name: 'vault', reachable: true, since: 0 } };
    edit(f);
    return f;
  };
  const moving = at((f) => { f.robots.c1.moving = { id: 'mv_0123456789', to: VAULT, phase: 'activate' }; });
  const landed = at((f) => { f.robots.c1.machine = VAULT; });
  const setup = (rows: SetupRow[]) => {
    const store = createAppStore();
    const call = vi.fn((_method: string, _params: unknown) => Promise.resolve({ rows }));
    followLandings({ store, api: () => ({ call }) as never });
    store.getState().setFleet(moving);
    return { store, call };
  };

  it('says how many parts of its agent setup will not work there, and Show opens its card', async () => {
    const { store, call } = setup([linear, notion, { key: 'var:X', status: 'ok', detail: 'X is set on vault' }]);
    store.getState().setFleet(landed);
    await vi.waitFor(() => expect(store.getState().toast).toBeDefined());
    expect(call).toHaveBeenCalledWith('machines.setup', { machine: VAULT, robot: 'c1' });
    expect(store.getState().toast).toMatchObject({ text: 'c1 is on vault. 2 parts of its agent setup will not work there.', tone: 'ok', action: { label: 'Show' } });
    store.getState().toast!.action!.run();
    expect([store.getState().selectedId, store.getState().sideCardOpen]).toEqual(['c1', true]);
  });

  it('says nothing for one whose agent setup all works there, for a move back to this Mac, or for a robot that did not move', async () => {
    const quiet = setup([{ key: 'var:X', status: 'ok', detail: 'X is set on vault' }]);
    quiet.store.getState().setFleet(landed);
    await vi.waitFor(() => expect(quiet.call).toHaveBeenCalledTimes(1));
    expect(quiet.store.getState().toast).toBeUndefined();

    const back = setup([linear]);
    back.store.getState().setFleet(at((f) => { f.robots.c1.machine = VAULT; f.robots.c1.moving = { id: 'mv_0123456789', to: 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId, phase: 'activate' }; }));
    back.store.getState().setFleet(fleet());
    back.store.getState().setFleet(landed);
    expect(back.call).not.toHaveBeenCalled();
  });
});
