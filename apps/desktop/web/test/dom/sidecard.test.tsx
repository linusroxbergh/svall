// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { FromShell } from '../../src/bridge.js';
import { setAppStore, useApp } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { isVeiled } from '../../src/selectors.js';
import { chr, fleet, isl } from '../fixtures.js';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= function () { return true; };

const calls: [string, Record<string, unknown>][] = [];
let refuse: ((method: string, params: Record<string, unknown>) => string | undefined) | undefined;
const call = (method: string, params: Record<string, unknown>) => {
  calls.push([method, params]);
  const why = refuse?.(method, params);
  return why ? Promise.reject(new Error(why)) : Promise.resolve(method === 'char.prompts' ? { prompts: [] } : {});
};
const bridge = { present: false, send() {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }), manager: () => ({ move() {} }), browser: () => ({ move() {} }) },
  deps: () => ({ api: { call }, store, bridge }),
}));
vi.mock('../../src/resources/Shelf.js', () => ({ ResourcesLayer: () => null }));

const { Map } = await import('../../src/map/Map.js');
const { IslandCard, SideCard } = await import('../../src/SideCard.js');
const { ConfirmDeleteIsland } = await import('../../src/ConfirmDeleteIsland.js');
const { ConfirmClose } = await import('../../src/ConfirmClose.js');
const { dispatchKey } = await import('../../src/keyboard.js');
const { FleetSummary } = await import('../../src/FleetSummary.js');
const { followQuit } = await import('../../src/quit.js');

// the side card as App mounts it: no key, the id from the map's selection
function Side() {
  const id = useApp((s) => (s.selectedId && s.fleet.characters[s.selectedId] ? s.selectedId : undefined));
  return id ? <SideCard id={id} /> : null;
}
// on the map the settings take the card's place, and the board shows a card of its own
function MapCard() {
  const shown = useApp((s) => s.view === 'map' && s.sideCardOpen && !s.settingsOpen);
  return shown ? <Side /> : null;
}
function IslandSide() {
  const id = useApp((s) => s.selectedIslandId);
  return id ? <IslandCard id={id} /> : null;
}

const updates = () => calls.filter(([m]) => m === 'char.update' || m === 'island.update');
const field = (testId: string) => screen.getByTestId(testId) as HTMLTextAreaElement;
const type = (el: HTMLTextAreaElement, value: string) => { el.focus(); fireEvent.change(el, { target: { value } }); };

beforeEach(() => {
  calls.length = 0;
  refuse = undefined;
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  store.getState().select('c0', true);
});

test('a draft in one character\'s instructions never shows or saves on the next one', () => {
  render(<Side />);
  type(field('side-instructions'), 'run the tests first');
  // the selection moves without the field hearing a blur, as a removed field in WebKit never does
  act(() => store.getState().select('c1', true));
  expect(field('side-instructions').value).toBe('');
  fireEvent.blur(field('side-instructions'));
  expect(updates()).not.toContainEqual(['char.update', { id: 'c1', instructions: 'run the tests first' }]);
});

test('a draft in one island\'s instructions never shows or saves on the next one', () => {
  store.getState().selectIsland('i_a');
  render(<IslandSide />);
  type(field('side-island-instructions'), 'merge without asking');
  act(() => store.getState().selectIsland('i_b'));
  expect(field('side-island-instructions').value).toBe('');
  fireEvent.blur(field('side-island-instructions'));
  expect(updates()).not.toContainEqual(['island.update', { id: 'i_b', instructions: 'merge without asking' }]);
});

test('a press on another token saves the rename to the character it was typed for', async () => {
  render(<><Map /><Side /></>);
  await act(async () => {});
  type(field('side-name'), 'auth fix');
  // a map press calls preventDefault, which in WebKit leaves the focus where it was
  act(() => {
    fireEvent.pointerDown(screen.getByTestId('token-c1'), { pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('map'), { pointerId: 1 });
  });
  expect(updates()).toEqual([['char.update', { id: 'c0', name: 'auth fix' }]]);
  expect(store.getState().selectedId).toBe('c1');
});

test('the next-character key saves the draft to the character it was typed for', async () => {
  render(<Side />);
  type(field('side-instructions'), 'never push to main');
  await act(() => dispatchKey({ type: 'nextCharacter' }, { store, api: { call } as never, bridge }));
  expect(store.getState().selectedId).toBe('c1');
  expect(updates()).toEqual([['char.update', { id: 'c0', instructions: 'never push to main' }]]);
});

// the shell swallows the chord, so the field is removed without the blur a click would have sent
test.each(['toggleSideCard', 'toggleSettings', 'toggleView'] as const)('%s saves the draft before the card goes', async (chord) => {
  render(<MapCard />);
  type(field('side-instructions'), 'never push to main');
  await act(() => dispatchKey({ type: chord }, { store, api: { call } as never, bridge }));
  expect(screen.queryByTestId('side-instructions')).toBeNull();
  expect(updates()).toEqual([['char.update', { id: 'c0', instructions: 'never push to main' }]]);
});

// the shell asks before it quits, and nothing blurs the field on the way out
test('a quit saves the draft before it answers', async () => {
  render(<Side />);
  type(field('side-instructions'), 'never push to main');
  let ask = (_: FromShell) => {};
  let savedFirst: boolean | undefined;
  const stop = followQuit({ store, api: () => undefined, bridge: {
    send: (m) => { if (m.type === 'quit.answer') savedFirst = updates().length > 0; },
    onMessage: (h) => { ask = h; return () => {}; },
  } });
  await act(async () => { ask({ type: 'quit.ask' }); });
  expect(updates()).toEqual([['char.update', { id: 'c0', instructions: 'never push to main' }]]);
  expect(savedFirst).toBe(true);
  stop();
});

test('a link half typed for one character is not offered to the next', () => {
  render(<Side />);
  fireEvent.change(screen.getByTestId('context-ref'), { target: { value: 'https://example.com/for-c0' } });
  act(() => store.getState().select('c1', true));
  fireEvent.click(screen.getByTestId('context-add'));
  expect(updates()).toEqual([]);
  expect((screen.getByTestId('context-ref') as HTMLInputElement).value).toBe('');
});

test('a link half typed for one island is not offered to the next', () => {
  store.getState().selectIsland('i_a');
  render(<IslandSide />);
  fireEvent.change(screen.getByTestId('island-context-ref'), { target: { value: 'https://example.com/for-i_a' } });
  act(() => store.getState().selectIsland('i_b'));
  fireEvent.click(screen.getByTestId('island-context-add'));
  expect(updates()).toEqual([]);
});

test('the last command is read again for a new prompt, a turn\'s end and a new session, not for every hook event', async () => {
  const f = fleet();
  f.characters.c0.agent = { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1, transcriptPath: '/tmp/t.jsonl' };
  store.getState().setFleet(f);
  render(<Side />);
  await act(async () => {});
  const reads = () => calls.filter(([m]) => m === 'char.prompts').length;
  expect(reads()).toBe(1);
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/agent/lastActivityAt', value: 2 }]));
  await act(async () => {});
  expect(reads()).toBe(1);
  act(() => store.getState().applyPatch([{ op: 'add', path: '/characters/c0/agent/lastPrompt', value: { id: 'p1', text: 'go', at: 3 } }]));
  await act(async () => {});
  expect(reads()).toBe(2);
  // a permission ask and its answer leave the turn running
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/agent/status', value: 'blocked' }]));
  await act(async () => {});
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/agent/status', value: 'working' }]));
  await act(async () => {});
  expect(reads()).toBe(2);
  // a turn Claude Code opened by itself is known for what it was only once its entry is written
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/agent/status', value: 'done' }]));
  await act(async () => {});
  expect(reads()).toBe(3);
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/agent', value: { kind: 'codex', sessionId: 's2', status: 'done', lastActivityAt: 4 } }]));
  await act(async () => {});
  expect(reads()).toBe(4);
});

test('last activity counts on while no patch arrives', async () => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    const f = fleet();
    f.characters.c0.agent = { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1_000_000, transcriptPath: '/tmp/t.jsonl' };
    store.getState().setFleet(f);
    render(<Side />);
    await act(async () => {});
    expect(screen.getByText('0s ago')).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('1m ago')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test('a refused rename is reported, stays in the field, and the next blur sends it again', async () => {
  refuse = (m, p) => (m === 'char.update' && p.name ? `another character is already called ${String(p.name)}` : undefined);
  render(<Side />);
  const name = field('side-name');
  type(name, 'C1');
  fireEvent.keyDown(name, { key: 'Enter' });
  await act(async () => {});
  expect(store.getState().toast?.text).toBe('another character is already called C1');
  expect(name.value).toBe('C1');
  name.focus();
  name.blur();
  expect(updates()).toEqual([['char.update', { id: 'c0', name: 'C1' }], ['char.update', { id: 'c0', name: 'C1' }]]);
});

const writeNote = (value: string) => act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/note', value }]));

// WebKit blurs the focused field when a native terminal takes the keys and focuses it again on the way back,
// leaving it the active element in between, so a fleet write meanwhile is not shown in it
test('a field left focused while the fleet rewrote it takes the fleet\'s text, not the old one back', () => {
  render(<Side />);
  const note = field('side-note');
  note.focus();
  fireEvent.blur(note);
  writeNote('from the scribe');
  fireEvent.focus(note);
  note.blur();
  expect(updates()).toEqual([]);
  expect(note.value).toBe('from the scribe');
});

test('an edit the fleet took is not sent again over a later write', () => {
  render(<Side />);
  const note = field('side-note');
  type(note, 'mine');
  note.blur();
  writeNote('mine');
  note.focus();
  fireEvent.blur(note);
  writeNote('newer');
  fireEvent.focus(note);
  note.blur();
  expect(updates()).toEqual([['char.update', { id: 'c0', note: 'mine' }]]);
  expect(note.value).toBe('newer');
});

test('an edit that already matches the fleet is not held back to send over a later write', () => {
  render(<Side />);
  const note = field('side-note');
  note.focus();
  writeNote('same');
  fireEvent.change(note, { target: { value: 'same' } });
  note.blur();
  note.focus();
  fireEvent.blur(note);
  writeNote('newer');
  fireEvent.focus(note);
  note.blur();
  expect(updates()).toEqual([]);
  expect(note.value).toBe('newer');
});

test('a name cleared to nothing goes back to the fleet\'s name', () => {
  render(<Side />);
  const name = field('side-name');
  type(name, '  ');
  name.blur();
  expect(name.value).toBe('c0');
  expect(updates()).toEqual([]);
});

test('a note written while svalld is away stays in the field, and the next blur sends it again', async () => {
  refuse = () => 'svalld offline';
  render(<Side />);
  const note = field('side-note');
  type(note, 'a long note');
  note.blur();
  await act(async () => {});
  expect(store.getState().toast?.text).toBe('svalld offline');
  expect(note.value).toBe('a long note');
  // the window loses the keys and gets them back, which blurs and focuses the field again
  refuse = undefined;
  note.focus();
  note.blur();
  expect(updates()).toEqual([['char.update', { id: 'c0', note: 'a long note' }], ['char.update', { id: 'c0', note: 'a long note' }]]);
});

test('the fleet summary counts one character on one island in the singular', () => {
  store.getState().setFleet({ ...fleet(), islands: { i_a: isl('i_a', 'alpha', 0) }, characters: { c2: chr('c2', 'i_a', { x: 1, y: 1 }) } });
  render(<FleetSummary />);
  expect(screen.getByRole('heading').textContent).toMatch(/^1 character\s*on 1 island$/);
});

test('Delete character asks first, naming the unsaved files, and moves the selection on before the character goes', async () => {
  store.getState().markFile('c0', '/tmp/a.ts', { dirty: true });
  render(<><Side /><ConfirmClose /></>);
  fireEvent.click(screen.getByTestId('side-close'));
  expect(screen.getByTestId('confirm-close-note').textContent).toContain('1 unsaved file goes with it');
  expect(calls.filter(([m]) => m === 'char.close')).toEqual([]);
  fireEvent.click(screen.getByTestId('confirm-close-delete'));
  await act(async () => {});
  expect(calls.filter(([m]) => m === 'char.close')).toEqual([['char.close', { id: 'c0' }]]);
  expect(store.getState().selectedId).toBe('c1');
});

const deletes = () => calls.filter(([m]) => m === 'island.delete');

test('an island delete asks in a dialog, and Cancel, Esc or a press outside keep the island', () => {
  store.getState().selectIsland('i_e');
  render(<><IslandSide /><ConfirmDeleteIsland /></>);
  expect(screen.queryByTestId('confirm-delete-island')).toBeNull();
  fireEvent.click(screen.getByTestId('side-island-delete'));
  expect(screen.getByTestId('confirm-delete-island').textContent).toContain('empty');
  fireEvent.click(screen.getByTestId('confirm-delete-island-cancel'));
  fireEvent.click(screen.getByTestId('side-island-delete'));
  fireEvent.keyDown(screen.getByTestId('confirm-delete-island-cancel'), { key: 'Escape' });
  fireEvent.click(screen.getByTestId('side-island-delete'));
  fireEvent.pointerDown(screen.getByTestId('confirm-delete-island'));
  expect(screen.queryByTestId('confirm-delete-island')).toBeNull();
  expect(deletes()).toEqual([]);
  fireEvent.click(screen.getByTestId('side-island-delete'));
  // the second press of a double click on an opener beneath does not answer it
  fireEvent.click(screen.getByTestId('confirm-delete-island-delete'), { detail: 2 });
  expect(deletes()).toEqual([]);
  fireEvent.click(screen.getByTestId('confirm-delete-island-delete'));
  expect(screen.queryByTestId('confirm-delete-island')).toBeNull();
  expect(deletes()).toEqual([['island.delete', { id: 'i_e' }]]);
});

test('the island delete dialog veils the terminals and closes when the island goes or gains a crew', () => {
  store.getState().selectIsland('i_e');
  render(<><IslandSide /><ConfirmDeleteIsland /></>);
  fireEvent.click(screen.getByTestId('side-island-delete'));
  expect(isVeiled(store.getState())).toBe(true);
  act(() => store.getState().applyPatch([{ op: 'add', path: '/characters/c9', value: chr('c9', 'i_e', { x: 1, y: 1 }) }]));
  expect(screen.queryByTestId('confirm-delete-island')).toBeNull();
  act(() => store.getState().setFleet(fleet()));
  fireEvent.click(screen.getByTestId('side-island-delete'));
  expect(screen.getByTestId('confirm-delete-island')).toBeTruthy();
  const f = fleet();
  delete f.islands.i_e;
  act(() => store.getState().setFleet(f));
  expect(screen.queryByTestId('confirm-delete-island')).toBeNull();
  expect(isVeiled(store.getState())).toBe(false);
});

test('Enter in the island delete dialog stays with the button in focus, Cancel first', () => {
  store.getState().selectIsland('i_e');
  render(<><IslandSide /><ConfirmDeleteIsland /></>);
  const page = vi.fn();
  window.addEventListener('keydown', page);
  try {
    fireEvent.click(screen.getByTestId('side-island-delete'));
    expect(document.activeElement).toBe(screen.getByTestId('confirm-delete-island-cancel'));
    fireEvent.keyDown(screen.getByTestId('confirm-delete-island-cancel'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('confirm-delete-island-delete'), { key: 'Enter' });
    expect(page).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', page);
  }
});
