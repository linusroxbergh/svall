// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { farRootId, type MachineId } from '@svall/protocol';
import { getBuffer } from '../../src/ide/buffers.js';
import { createAppStore, localAppStorage } from '../../src/store/index.js';
import { bridge, call, freshStore, sent, store } from './harness.js';

Element.prototype.setPointerCapture ??= function () {};

const answer = (method: string, _params?: unknown): Promise<unknown> => Promise.resolve(method === 'resources.get' ? { sources: [] } : {});
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { ResourcesLayer } = await import('../../src/resources/Shelf.js');
const { dispatchKey } = await import('../../src/keyboard.js');

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(answer);
  freshStore();
  store.getState().toggleResources(true);
});

// the shelf lives on the map, which pans on a wheel and calls preventDefault on every press
function OnMap({ onWheel }: { onWheel?: () => void }) {
  return <div data-testid="map" onWheel={onWheel}><div className="map-sea" /><ResourcesLayer tip={0} rowTop={0} /></div>;
}

test('a press on the map closes the shelf', async () => {
  render(<OnMap />);
  await act(async () => {});
  // WebKit sends no mousedown after a pointerdown that called preventDefault
  act(() => { fireEvent.pointerDown(document.querySelector('.map-sea')!); });
  expect(store.getState().resourcesOpen).toBe(false);
});

test('a note half typed in the shelf is saved by the press that closes it', async () => {
  store.getState().showResourceField({ tier: 'robot', id: 'c0', field: 'note' });
  render(<OnMap />);
  await act(async () => {});
  const note = screen.getByTestId('resources-field') as HTMLTextAreaElement;
  note.focus();
  fireEvent.change(note, { target: { value: 'half a thought' } });
  act(() => { fireEvent.pointerDown(document.querySelector('.map-sea')!); });
  expect(call).toHaveBeenCalledWith('robot.update', { id: 'c0', note: 'half a thought' });
});

test('the shelf chord saves a half typed note before the shelf closes', async () => {
  store.getState().showResourceField({ tier: 'robot', id: 'c0', field: 'note' });
  render(<OnMap />);
  await act(async () => {});
  const note = screen.getByTestId('resources-field') as HTMLTextAreaElement;
  note.focus();
  fireEvent.change(note, { target: { value: 'half a thought' } });
  await act(() => dispatchKey({ type: 'toggleResources' }, { store, api: { call } as never, bridge }));
  expect(store.getState().resourcesOpen).toBe(false);
  expect(call).toHaveBeenCalledWith('robot.update', { id: 'c0', note: 'half a thought' });
});

test('the robot keys leave the keys with the shelf', async () => {
  render(<OnMap />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId('resources-shelf'));
  await act(() => dispatchKey({ type: 'nextRobot' }, { store, api: { call } as never, bridge }));
  expect(document.activeElement).toBe(screen.getByTestId('resources-shelf'));
});

// the Files editor types into a contenteditable, and nothing it holds is saved on a blur
test('opening the side card leaves the keys in the editor', async () => {
  store.getState().toggleResources(false);
  render(<div contentEditable data-testid="editor" />);
  screen.getByTestId('editor').focus();
  await act(() => dispatchKey({ type: 'toggleSideCard' }, { store, api: { call } as never, bridge }));
  expect(document.activeElement).toBe(screen.getByTestId('editor'));
});

test('scrolling inside the shelf leaves the map where it is', async () => {
  const pan = vi.fn();
  render(<OnMap onWheel={pan} />);
  await act(async () => {});
  fireEvent.wheel(screen.getByTestId('resources-shelf'), { deltaY: 40 });
  expect(pan).not.toHaveBeenCalled();
});

test('the new doc field stands until Enter or Escape, and a refused name keeps its text', async () => {
  const src = { rootId: 'r:/d/islands/i0', root: '/d/islands/i0', name: 'isle', tier: 'island' as const, docs: 'r:/d/islands/i0', islandIds: ['i0'], robotIds: [], groups: [] };
  call.mockImplementation((m: string) => (m === 'resources.get' ? Promise.resolve({ sources: [src] })
    : m === 'docs.create' ? Promise.reject(new Error('taken.md is already there')) : Promise.resolve({})));
  store.getState().setResources([src]);
  store.getState().toggleResources(true, { where: src.rootId, what: 'docs', naming: true });
  render(<OnMap />);
  await act(async () => {});
  const field = screen.getByTestId('resources-new-doc-name') as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  expect(screen.getByText('New doc')).toBeTruthy();

  act(() => { fireEvent.blur(field); });
  expect(screen.getByTestId('resources-new-doc-name')).toBe(field);

  fireEvent.change(field, { target: { value: 'taken' } });
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
  expect(field.value).toBe('taken');

  act(() => { fireEvent.keyDown(field, { key: 'Escape' }); });
  expect(screen.queryByTestId('resources-new-doc-name')).toBeNull();
});

test('a skill, an agent, a command and a memory file each offer a delete that Undo takes back; instructions, settings and MEMORY.md offer none', async () => {
  const C = 'r:/u/.claude';
  const row = (kind: string, name: string, path: string, folder?: string) =>
    ({ id: `${kind}:${name}`, name, reveal: `/u/.claude/${folder ?? path}`, target: folder ? 'folder' as const : 'file' as const, open: { rootId: C, path, ...(folder && { folder }) } });
  const src = { rootId: C, root: '/u/.claude', name: 'Claude', tier: 'global' as const, islandIds: [], robotIds: [], groups: [
    { kind: 'instructions' as const, items: [row('instructions', 'CLAUDE.md', 'CLAUDE.md')] },
    { kind: 'skills' as const, items: [row('skills', 'tidy', 'skills/tidy/SKILL.md', 'skills/tidy')] },
    { kind: 'agents' as const, items: [row('agents', 'critic', 'agents/critic.md')] },
    { kind: 'commands' as const, items: [row('commands', 'git:sync', 'commands/git/sync.md')] },
    { kind: 'settings' as const, items: [row('settings', 'settings.json', 'settings.json')] },
    { kind: 'autoMemory' as const, items: [row('autoMemory', 'MEMORY.md', 'projects/-r/memory/MEMORY.md'), row('autoMemory', 'old-plan.md', 'projects/-r/memory/old-plan.md')] },
  ] };
  call.mockImplementation((m: string) => Promise.resolve(m === 'resources.get' ? { sources: [src] } : m === 'resources.delete' ? { token: 't1' } : {}));
  store.getState().setResources([src]);
  store.getState().toggleResources(true, { where: C, what: 'all' });
  render(<OnMap />);
  await act(async () => {});
  for (const [kind, name] of [['skills', 'tidy'], ['agents', 'critic'], ['commands', 'git:sync'], ['autoMemory', 'old-plan.md']])
    expect(screen.queryByTestId(`resources-delete-${kind}-${name}`)).not.toBeNull();
  for (const [kind, name] of [['instructions', 'CLAUDE.md'], ['settings', 'settings.json'], ['autoMemory', 'MEMORY.md']])
    expect(screen.queryByTestId(`resources-delete-${kind}-${name}`)).toBeNull();

  await act(async () => { fireEvent.click(screen.getByTestId('resources-delete-skills-tidy')); });
  expect(call).toHaveBeenCalledWith('resources.delete', { id: C, path: 'skills/tidy' });
  expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Deleted tidy', action: { label: 'Undo' } });
  await act(async () => { store.getState().toast!.action!.run(); });
  expect(call).toHaveBeenCalledWith('resources.restore', { token: 't1' });
});

test('a worker\'s clone offers no Show in Finder and no delete, and opens its files read-only; its docs here keep both', async () => {
  const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
  const C = farRootId(VAULT, '/home/ada/app'), D = 'r:/u/.svall/docs/repos/app-0123abcd';
  const row = (kind: string, name: string, path: string, open = true) =>
    ({ id: `${kind}:${name}`, name, reveal: `/home/ada/app/${path}`, target: 'file' as const, ...(open && { open: { rootId: C, path } }) });
  const src = { rootId: C, root: '/home/ada/app', name: 'app', tier: 'repo' as const, docs: D, islandIds: [], robotIds: ['c0'], groups: [
    { kind: 'docs' as const, items: [{ id: 'docs:plan', name: 'plan', reveal: '/u/.svall/docs/repos/app-0123abcd/plan.md', target: 'file' as const, open: { rootId: D, path: 'plan.md' } }] },
    { kind: 'instructions' as const, items: [row('instructions', 'CLAUDE.md', 'CLAUDE.md')] },
    { kind: 'skills' as const, items: [row('skills', 'tidy', '.claude/skills/tidy/SKILL.md'), row('skills', 'shared', '.claude/skills/shared', false)] },
  ] };
  call.mockImplementation((m: string, p?: unknown) => Promise.resolve(m === 'resources.get' ? { sources: [src] }
    : m === 'fs.read' ? { text: '# hi\n', mtimeMs: 1, root: (p as { id: string }).id === D ? '/u/.svall/docs/repos/app-0123abcd' : '/home/ada/app' } : {}));
  store.getState().setFleet({ ...store.getState().fleet, machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } });
  store.getState().setResources([src]);
  store.getState().toggleResources(true, { where: C, what: 'all' });
  render(<OnMap />);
  await act(async () => {});
  expect(screen.queryByTestId('resources-delete-skills-tidy')).toBeNull();
  expect(screen.getByTestId('resources-doc-delete-plan')).toBeTruthy();
  const shared = screen.getByTestId('resources-item-skills-shared');
  expect([shared.getAttribute('aria-disabled'), shared.getAttribute('data-tip')]).toEqual(['true', '/home/ada/app/.claude/skills/shared (on linus-vault)']);
  expect(screen.getByTestId('resources-item-skills-tidy').hasAttribute('aria-disabled')).toBe(false);
  bridge.present = true;
  try { await act(async () => { fireEvent.click(shared); }); } finally { bridge.present = false; }
  expect(sent.filter((m) => m.type === 'reveal' || m.type === 'openFolder')).toEqual([]);

  await act(async () => { fireEvent.click(screen.getByTestId('resources-item-instructions-CLAUDE.md')); });
  expect(screen.getByTestId('editor').dataset.path).toBe('CLAUDE.md');
  expect(getBuffer(C, 'CLAUDE.md')!.state.readOnly).toBe(true);
  expect(screen.getByTestId('editor-read-only').textContent).toBe('read-only · on linus-vault');
  expect(screen.queryByText('Show in Finder ›')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId('resources-item-docs-plan')); });
  expect(screen.getByText('Show in Finder ›')).toBeTruthy();
  expect(screen.queryByTestId('editor-read-only')).toBeNull();
});

// the shelf's box in percent of its room
const box = () => {
  const st = screen.getByTestId('resources-shelf').style;
  const pc = (v: string) => Math.round(parseFloat(v) * 100) / 100;
  return { left: pc(st.left), top: pc(st.top), width: pc(st.width), height: pc(st.height) };
};

test('the shelf opens centred at nine tenths of its room, and the size button fills the room and points at the islet', async () => {
  render(<OnMap />);
  await act(async () => {});
  expect(box()).toEqual({ left: 5, top: 5, width: 90, height: 90 });
  expect(screen.getByTestId('resources-shelf').dataset.full).toBe('false');
  fireEvent.click(screen.getByTestId('resources-size'));
  expect(box()).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  expect(screen.getByTestId('resources-shelf').dataset.full).toBe('true');
  expect(screen.queryByTestId('resources-grip')).toBeNull();
  fireEvent.click(screen.getByTestId('resources-size'));
  expect(box().width).toBe(90);
});

test('the grip drags the shelf from its corner and the size is kept once it is let go', async () => {
  localStorage.clear();
  freshStore(() => createAppStore(localAppStorage()));
  store.getState().toggleResources(true);
  render(<OnMap />);
  await act(async () => {});
  const room = document.querySelector('.res-room')!;
  room.getBoundingClientRect = () => ({ width: 1000, height: 600 }) as DOMRect;
  const grip = screen.getByTestId('resources-grip');
  // the shelf stays centred, so it shrinks by twice what the grip travels
  fireEvent.pointerDown(grip, { pointerId: 1, clientX: 900, clientY: 560 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: 800, clientY: 500, buttons: 1 });
  expect(box()).toEqual({ left: 15, top: 15, width: 70, height: 70 });
  expect(localStorage.getItem('svall.resources.size')).toBeNull();
  fireEvent.pointerUp(grip, { pointerId: 1 });
  const kept = createAppStore(localAppStorage()).getState().resourceSize;
  expect(kept.w).toBeCloseTo(0.7);
  expect(kept.h).toBeCloseTo(0.7);
});

// two instruction files, so the filter can leave one of them
const twoFiles = () => {
  const C = 'r:/u/.claude';
  const row = (name: string) => ({ id: `instructions:${name}`, name, reveal: `/u/.claude/${name}`, target: 'file' as const, open: { rootId: C, path: name } });
  const src = { rootId: C, root: '/u/.claude', name: 'Claude', tier: 'global' as const, islandIds: [], robotIds: [], groups: [{ kind: 'instructions' as const, items: [row('CLAUDE.md'), row('AGENTS.md')] }] };
  call.mockImplementation((m: string) => Promise.resolve(m === 'resources.get' ? { sources: [src] } : m === 'fs.read' ? { text: '# hi\n', mtimeMs: 1, root: '/u/.claude' } : {}));
  store.getState().setResources([src]);
  store.getState().toggleResources(true, { where: C, what: 'all' });
};

test('a filter typed down to one file shows it and keeps the keys in the filter', async () => {
  twoFiles();
  render(<OnMap />);
  await act(async () => {});
  const find = screen.getByTestId('resources-filter') as HTMLInputElement;
  fireEvent.pointerDown(find);
  find.focus();
  await act(async () => { fireEvent.change(find, { target: { value: 'CLA' } }); });
  expect(screen.getByTestId('editor').dataset.path).toBe('CLAUDE.md');
  expect(document.activeElement).toBe(find);
  await act(async () => { fireEvent.change(find, { target: { value: 'CLAU' } }); });
  expect(find.value).toBe('CLAU');
  expect(document.activeElement).toBe(find);
});

test('a row the pointer picks still hands the keys to its file', async () => {
  twoFiles();
  render(<OnMap />);
  await act(async () => {});
  const row = screen.getByTestId('resources-item-instructions-AGENTS.md');
  fireEvent.pointerDown(row);
  await act(async () => { fireEvent.click(row); });
  expect(screen.getByTestId('editor').dataset.path).toBe('AGENTS.md');
  expect(document.activeElement?.closest('.editor')).not.toBeNull();
});

test('a file the list opens on its own under a chip leaves nothing behind that a later Enter pick would trip on', async () => {
  const C = 'r:/u/.claude';
  const src = { rootId: C, root: '/u/.claude', name: 'Claude', tier: 'global' as const, islandIds: [], robotIds: [], groups: [
    { kind: 'instructions' as const, items: [{ id: 'instructions:CLAUDE.md', name: 'CLAUDE.md', reveal: '/u/.claude/CLAUDE.md', target: 'file' as const, open: { rootId: C, path: 'CLAUDE.md' } }] },
    { kind: 'skills' as const, items: [{ id: 'skills:tidy', name: 'tidy', reveal: '/u/.claude/skills/tidy', target: 'folder' as const, open: { rootId: C, path: 'skills/tidy/SKILL.md', folder: 'skills/tidy' } }] },
  ] };
  call.mockImplementation((m: string) => Promise.resolve(m === 'resources.get' ? { sources: [src] } : m === 'fs.read' ? { text: '# hi\n', mtimeMs: 1, root: '/u/.claude' } : {}));
  store.getState().setResources([src]);
  store.getState().toggleResources(true, { where: C, what: 'all' });
  render(<OnMap />);
  await act(async () => {});
  const claude = screen.getByTestId('resources-item-instructions-CLAUDE.md');
  fireEvent.pointerDown(claude);
  await act(async () => { fireEvent.click(claude); });
  expect(screen.getByTestId('editor').dataset.path).toBe('CLAUDE.md');
  // the chip leaves one file, the one already shown, so the pane mounts nothing
  await act(async () => { fireEvent.click(screen.getByTestId('resources-what-instructions')); });
  await act(async () => { fireEvent.click(screen.getByTestId('resources-what-all')); });
  const tidy = screen.getByTestId('resources-item-skills-tidy');
  tidy.focus();
  await act(async () => { fireEvent.click(tidy); });
  expect(screen.getByTestId('editor').dataset.path).toBe('skills/tidy/SKILL.md');
  expect(document.activeElement?.closest('.editor')).not.toBeNull();
});
