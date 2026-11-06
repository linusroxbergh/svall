// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DROP_PART, type MachineId } from '@svall/protocol';
import { DROP_URL } from '../../src/bridge.js';
import { installDropHandlers } from '../../src/drop.js';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, shell, store } from './harness.js';

beforeEach(() => {
  freshStore();
  installDropHandlers({ bridge: bridge as never, store, api: () => ({ call }) as never });
});
afterEach(() => vi.unstubAllGlobals());

test('a file dropped into a terminal on another machine is read from the shell, sent, and its path there typed into that terminal', async () => {
  const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetch);
  call.mockImplementation(async (method: string) => (method === 'robot.drop' ? { path: '/tmp/svall-drop-1000/ab12/shot.png' } : {}));
  shell({ type: 'term.drop', id: 'c0', files: [{ token: 'tok', name: 'shot.png', bytes: 3, folder: false }] });
  await vi.waitFor(() => expect(sent).toContainEqual({ type: 'term.type', id: 'c0', paths: ['/tmp/svall-drop-1000/ab12/shot.png'] }));
  expect(fetch).toHaveBeenCalledWith(`${DROP_URL}tok?at=0&size=${DROP_PART}`);
  expect(call).toHaveBeenCalledWith('drop.part', expect.objectContaining({ index: 0, data: 'AQID' }));
  expect(call).toHaveBeenCalledWith('robot.drop', expect.objectContaining({ id: 'c0', name: 'shot.png' }));
});

test('a file the shell no longer serves is named on a toast, and nothing is sent or typed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
  shell({ type: 'term.drop', id: 'c0', files: [{ token: 'gone', name: 'shot.png', bytes: 3, folder: false }] });
  await vi.waitFor(() => expect(store.getState().toast?.text).toBe('shot.png could not be read'));
  expect(call).not.toHaveBeenCalled();
  expect(sent.some((m) => m.type === 'term.type')).toBe(false);
});

test('files dragged onto a far robot on the Mac\'s copy light nothing there and say why, and onto a robot on this Mac they go', () => {
  const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
  const f = fleet();
  f.robots.c1.machine = MAC;
  store.getState().setFleet(f);
  store.getState().setVia({ machine: MAC, home: 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId, name: 'linus-vault' });
  const row = document.body.appendChild(document.createElement('div'));
  document.elementFromPoint = () => row;
  const onto = (id: string) => {
    row.setAttribute('data-drop', `robot:${id}`);
    shell({ type: 'drag.over', x: 1, y: 1 });
    const lit = store.getState().dropHover;
    shell({ type: 'drag.drop', x: 1, y: 1, paths: ['/Users/ada/notes.md'] });
    return lit;
  };
  expect(onto('c0')).toBeUndefined();
  expect(store.getState().toast?.text).toBe('c0 runs on linus-vault, which is not reachable; you can change it once it answers.');
  expect(call).not.toHaveBeenCalled();
  expect(onto('c1')).toEqual({ kind: 'robot', id: 'c1' });
  expect(call).toHaveBeenCalledWith('robot.update', expect.objectContaining({ id: 'c1', context: expect.arrayContaining([expect.objectContaining({ ref: '/Users/ada/notes.md' })]) }));
});
