// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const answer = (method: string, _params?: unknown): Promise<unknown> => Promise.resolve(method === 'resources.get' ? { sources: [] } : {});
const call = vi.fn(answer);
const bridge = { present: false, send() {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { ResourcesLayer } = await import('../../src/resources/Shelf.js');
const { dispatchKey } = await import('../../src/keyboard.js');

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(answer);
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
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
