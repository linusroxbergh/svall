// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { dropBuffers } from '../../src/ide/buffers.js';
import { bridge, call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => {
  const m = (await import('./harness.js')).bootModule();
  return { ...m, app: Object.assign(m.app, { repoWatch: () => ({ watch: () => () => {}, on: () => () => {} }) }) };
});

const { FilesArea } = await import('../../src/ide/FilesArea.js');
const { ContextMenu } = await import('../../src/ContextMenu.js');
const { openFile } = await import('../../src/ide/files.js');
const { deps } = await import('../../src/boot.js');

const VIA = { machine: 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId, home: 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId, name: 'linus-vault', online: true as const };
const entry = () => screen.getByTestId('menu-show in finder');
const reveals = () => sent.filter((m) => m.type === 'reveal');

beforeEach(() => {
  bridge.present = true;
  freshStore();
  call.mockImplementation(async (method) => {
    if (method === 'fs.list') return { entries: [{ name: 'docs', kind: 'dir' }, { name: 'README', kind: 'file' }] };
    return method === 'fs.read' ? { text: 'hello\n', mtimeMs: 1, root: '/tmp' } : {};
  });
});
afterEach(() => { dropBuffers('c0'); call.mockReset(); call.mockImplementation(() => Promise.resolve({})); });

test('a right-click on a file or folder in the tree shows it in Finder', async () => {
  render(<><FilesArea id="c0" /><ContextMenu /></>);
  // fireEvent returns false when a listener called preventDefault, which keeps WebKit's own menu away
  expect(fireEvent.contextMenu(await screen.findByTestId('tree-README'))).toBe(false);
  fireEvent.click(entry());
  fireEvent.contextMenu(screen.getByTestId('tree-docs'));
  fireEvent.click(entry());
  expect(reveals()).toEqual([{ type: 'reveal', path: '/tmp/README' }, { type: 'reveal', path: '/tmp/docs' }]);
});

test('the open file shows in Finder from the tab strip', async () => {
  render(<FilesArea id="c0" />);
  await act(() => openFile(deps(), 'c0', 'README'));
  fireEvent.click(screen.getByTestId('files-finder'));
  expect(reveals()).toEqual([{ type: 'reveal', path: '/tmp/README' }]);
});

test('a robot on another machine offers no Finder', async () => {
  store.getState().setVia(VIA);
  render(<><FilesArea id="c0" /><ContextMenu /></>);
  await act(() => openFile(deps(), 'c0', 'README'));
  expect(screen.queryByTestId('files-finder')).toBeNull();
  fireEvent.contextMenu(await screen.findByTestId('tree-README'));
  expect(entry().getAttribute('aria-disabled')).toBe('true');
  expect(entry().dataset.tip).toBe('On linus-vault');
  fireEvent.click(entry());
  expect(reveals()).toEqual([]);
});
