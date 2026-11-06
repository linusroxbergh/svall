// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { dropBuffers, getBuffer } from '../../src/ide/buffers.js';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => {
  const m = (await import('./harness.js')).bootModule();
  return { ...m, app: Object.assign(m.app, { repoWatch: () => ({ watch: () => () => {}, on: () => () => {} }) }) };
});
vi.mock('../../src/TerminalArea.js', () => ({ TerminalArea: () => null }));

const { RobotPanes } = await import('../../src/RobotPanes.js');
const { openFile } = await import('../../src/ide/files.js');
const { deps } = await import('../../src/boot.js');

const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
const VIA = { machine: MAC, home: 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId, name: 'linus-vault', online: true as const };
const HERE = '/Users/ada/app/.claude/worktrees/c0', FAR = '/home/ada/app';
const moved = (to?: MachineId) => act(async () => {
  store.getState().applyPatch(to ? [{ op: 'add', path: '/robots/c0/machine', value: to }] : [{ op: 'remove', path: '/robots/c0/machine' }]);
});
const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const save = () => {
  const mac = /Mac/.test(navigator.platform);
  return runScopeHandlers(view(), new KeyboardEvent('keydown', { key: 's', metaKey: mac, ctrlKey: !mac }), 'editor');
};
const typed = () => act(() => view().dispatch({ changes: { from: view().state.doc.length, insert: 'typed' } }));

beforeEach(() => {
  freshStore();
  call.mockImplementation(async (method) => {
    if (method === 'fs.read') return { text: 'hello\n', mtimeMs: 1, root: store.getState().fleet.robots.c0.machine === MAC ? HERE : FAR };
    if (method === 'fs.write') return { mtimeMs: 2 };
    return method === 'fs.list' ? { entries: [] } : {};
  });
  store.getState().setVia(VIA);
  store.getState().setPanes('c0', { left: 'files' });
});
afterEach(() => { dropBuffers('c0'); call.mockReset(); call.mockImplementation(() => Promise.resolve({})); });

test('a file opened while its robot is far takes edits once the robot moves here, under its open tab', async () => {
  render(<RobotPanes id="c0" />);
  await act(() => openFile(deps(), 'c0', 'README'));
  expect(screen.getByTestId('editor-read-only').textContent).toBe('read-only · on linus-vault');
  expect(view().state.readOnly).toBe(true);
  expect(save()).toBe(false);

  await moved(MAC);
  expect(screen.queryByTestId('editor-read-only')).toBeNull();
  expect(view().state.readOnly).toBe(false);
  expect(getBuffer('c0', 'README')!.on).toBeUndefined();
  expect(view().state.doc.toString()).toBe('hello\n');
  typed();
  expect(save()).toBe(true);
  await waitFor(() => expect(call).toHaveBeenCalledWith('fs.write', expect.objectContaining({ id: 'c0', path: 'README', text: 'hello\ntyped', root: HERE })));
});

test('a file opened with its robot here turns read-only once the robot moves far, keeping what was typed', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: MAC }]));
  render(<RobotPanes id="c0" />);
  await act(() => openFile(deps(), 'c0', 'README'));
  expect(screen.queryByTestId('editor-read-only')).toBeNull();
  expect(view().state.readOnly).toBe(false);
  typed();

  await moved();
  expect(screen.getByTestId('editor-read-only').textContent).toBe('read-only · on linus-vault');
  expect(view().state.readOnly).toBe(true);
  expect(getBuffer('c0', 'README')!.on).toBe('linus-vault');
  expect(getBuffer('c0', 'README')!.state.doc.toString()).toBe('hello\ntyped');
  expect(save()).toBe(false);
  expect(call).not.toHaveBeenCalledWith('fs.write', expect.anything());
});
