// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { createAppStore, localAppStorage } from '../../src/store/index.js';
import { bridge, call, freshStore, store } from './harness.js';

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
  return <div data-testid="map" onWheel={onWheel}><div className="map-sea" /><ResourcesLayer tip={0} /></div>;
}

test('a press on the map closes the shelf', async () => {
  render(<OnMap />);
  await act(async () => {});
  // WebKit sends no mousedown after a pointerdown that called preventDefault
  act(() => { fireEvent.pointerDown(document.querySelector('.map-sea')!); });
  expect(store.getState().resourcesOpen).toBe(false);
});

test('a note half typed in the shelf is saved by the press that closes it', async () => {
  store.getState().showResourceField({ tier: 'character', id: 'c0', field: 'note' });
  render(<OnMap />);
  await act(async () => {});
  const note = screen.getByTestId('resources-field') as HTMLTextAreaElement;
  note.focus();
  fireEvent.change(note, { target: { value: 'half a thought' } });
  act(() => { fireEvent.pointerDown(document.querySelector('.map-sea')!); });
  expect(call).toHaveBeenCalledWith('char.update', { id: 'c0', note: 'half a thought' });
});

test('the shelf chord saves a half typed note before the shelf closes', async () => {
  store.getState().showResourceField({ tier: 'character', id: 'c0', field: 'note' });
  render(<OnMap />);
  await act(async () => {});
  const note = screen.getByTestId('resources-field') as HTMLTextAreaElement;
  note.focus();
  fireEvent.change(note, { target: { value: 'half a thought' } });
  await act(() => dispatchKey({ type: 'toggleResources' }, { store, api: { call } as never, bridge }));
  expect(store.getState().resourcesOpen).toBe(false);
  expect(call).toHaveBeenCalledWith('char.update', { id: 'c0', note: 'half a thought' });
});

test('the character keys leave the keys with the shelf', async () => {
  render(<OnMap />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId('resources-shelf'));
  await act(() => dispatchKey({ type: 'nextCharacter' }, { store, api: { call } as never, bridge }));
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
  const src = { rootId: 'r:/d/islands/i0', root: '/d/islands/i0', name: 'isle', tier: 'island' as const, docs: 'r:/d/islands/i0', islandIds: ['i0'], characterIds: [], groups: [] };
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
  const src = { rootId: C, root: '/u/.claude', name: 'Claude', tier: 'global' as const, islandIds: [], characterIds: [], groups: [
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
