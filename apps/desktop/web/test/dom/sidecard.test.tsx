// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { farRootId, type MachineId, type ResourceSource, type Robot } from '@svall/protocol';
import type { FromShell } from '../../src/bridge.js';
import { useApp } from '../../src/hooks.js';
import { figureOf, figureUrl, stepFigure } from '../../src/portraits.js';
import { isVeiled } from '../../src/selectors.js';
import { chr, fleet, isl } from '../fixtures.js';
import { bridge, call, freshStore, sent, store } from './harness.js';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= function () { return true; };

let refuse: ((method: string, params: Record<string, unknown>) => string | undefined) | undefined;
let load: unknown;
call.mockImplementation((method: string, params?: unknown) => {
  const why = refuse?.(method, params as Record<string, unknown>);
  return why ? Promise.reject(new Error(why))
    : Promise.resolve(method === 'robot.prompts' ? { prompts: [] } : method === 'resources.get' ? { sources: [] } : method === 'load.get' ? load ?? {}
      : method === 'machines.setup' ? { rows: [] } : {});
});
const calls = () => call.mock.calls as [string, Record<string, unknown>][];
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
vi.mock('../../src/resources/Shelf.js', () => ({ ResourcesLayer: () => null }));

const { Map } = await import('../../src/map/Map.js');
const { SideCard } = await import('../../src/SideCard.js');
const { IslandCard } = await import('../../src/IslandCard.js');
const { ConfirmClose, ConfirmDeleteIsland } = await import('../../src/Confirm.js');
const { dispatchKey } = await import('../../src/keyboard.js');
const { FleetSummary } = await import('../../src/FleetSummary.js');
const { followQuit } = await import('../../src/quit.js');

// the side card as App mounts it: no key, the id from the map's selection
function Side() {
  const id = useApp((s) => (s.selectedId && s.fleet.robots[s.selectedId] ? s.selectedId : undefined));
  return id ? <SideCard id={id} /> : null;
}
// the board shows a card of its own
function MapCard() {
  const shown = useApp((s) => s.view === 'map' && s.sideCardOpen);
  return shown ? <Side /> : null;
}
function IslandSide() {
  const id = useApp((s) => s.selectedIslandId);
  return id ? <IslandCard id={id} /> : null;
}

const updates = () => calls().filter(([m]) => m === 'robot.update' || m === 'island.update');
const field = (testId: string) => screen.getByTestId(testId) as HTMLTextAreaElement;
const type = (el: HTMLTextAreaElement, value: string) => { el.focus(); fireEvent.change(el, { target: { value } }); };

beforeEach(() => {
  refuse = undefined;
  load = undefined;
  freshStore();
  store.getState().select('c0', true);
});

test('a draft in one robot\'s instructions never shows or saves on the next one', () => {
  render(<Side />);
  type(field('side-instructions'), 'run the tests first');
  // the selection moves without the field hearing a blur, as a removed field in WebKit never does
  act(() => store.getState().select('c1', true));
  expect(field('side-instructions').value).toBe('');
  fireEvent.blur(field('side-instructions'));
  expect(updates()).not.toContainEqual(['robot.update', { id: 'c1', instructions: 'run the tests first' }]);
});

test('walking the sidebar across robots reads the docs listing once', async () => {
  render(<Side />);
  for (const id of ['c1', 'c2', 'c0', 'c1']) await act(async () => store.getState().select(id, true));
  expect(calls().filter(([m]) => m === 'resources.get')).toHaveLength(1);
});

test('the star beside the name stars the robot, and unstars it once starred', () => {
  render(<Side />);
  const button = () => screen.getByTestId('side-star');
  expect(button().getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(button());
  expect(calls()).toContainEqual(['robot.star', { id: 'c0' }]);
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/star', value: 0 }]));
  expect(button().getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(button());
  expect(calls()).toContainEqual(['robot.unstar', { id: 'c0' }]);
});

test('the portrait is the robot\'s robot, and its steppers page through the robots', () => {
  const src = () => screen.getByTestId('side-portrait').querySelector('img')!.getAttribute('src');
  render(<Side />);
  const figure = figureOf({ portrait: 'fox' });
  expect(src()).toBe(figureUrl(figure));
  fireEvent.click(screen.getByTestId('portrait-prev'));
  expect(updates().at(-1)).toEqual(['robot.update', { id: 'c0', figure: stepFigure(figure, -1) }]);
  fireEvent.click(screen.getByTestId('portrait-next'));
  expect(updates().at(-1)).toEqual(['robot.update', { id: 'c0', figure: stepFigure(figure, 1) }]);
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

// the page moves the selection, as a link opened beside a robot does, and the removed field hears no blur
test('a draft whose card the page takes away is saved to the island it was typed for', () => {
  store.getState().selectIsland('i_a');
  render(<IslandSide />);
  type(field('side-island-description'), 'the auth service');
  act(() => store.getState().focus('c1'));
  expect(screen.queryByTestId('side-island-description')).toBeNull();
  expect(updates()).toEqual([['island.update', { id: 'i_a', description: 'the auth service' }]]);
});

test('a press on another token saves the rename to the robot it was typed for', async () => {
  render(<><Map /><Side /></>);
  await act(async () => {});
  type(field('side-name'), 'auth fix');
  // a map press calls preventDefault, which in WebKit leaves the focus where it was
  act(() => {
    fireEvent.pointerDown(screen.getByTestId('token-c1'), { pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('map'), { pointerId: 1 });
  });
  expect(updates()).toEqual([['robot.update', { id: 'c0', name: 'auth fix' }]]);
  expect(store.getState().selectedId).toBe('c1');
});

test('the next-robot key saves the draft to the robot it was typed for', async () => {
  render(<Side />);
  type(field('side-instructions'), 'never push to main');
  await act(() => dispatchKey({ type: 'nextRobot' }, { store, api: { call } as never, bridge }));
  expect(store.getState().selectedId).toBe('c1');
  expect(updates()).toEqual([['robot.update', { id: 'c0', instructions: 'never push to main' }]]);
});

// the shell swallows the chord, so the field is removed without the blur a click would have sent
test.each(['toggleSideCard', 'toggleView'] as const)('%s saves the draft before the card goes', async (chord) => {
  render(<MapCard />);
  type(field('side-instructions'), 'never push to main');
  await act(() => dispatchKey({ type: chord }, { store, api: { call } as never, bridge }));
  expect(screen.queryByTestId('side-instructions')).toBeNull();
  expect(updates()).toEqual([['robot.update', { id: 'c0', instructions: 'never push to main' }]]);
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
  expect(updates()).toEqual([['robot.update', { id: 'c0', instructions: 'never push to main' }]]);
  expect(savedFirst).toBe(true);
  stop();
});

test('a link the scribe added is taken off by its ×', () => {
  const f = fleet();
  const doc = { kind: 'other' as const, ref: 'https://doc', label: 'doc', source: 'scribe' as const };
  f.robots.c0 = { ...f.robots.c0, context: [doc] };
  store.getState().setFleet(f);
  render(<Side />);
  fireEvent.click(screen.getByTestId('context-remove'));
  expect(updates()).toEqual([['robot.update', { id: 'c0', context: [], removed: ['https://doc'] }]]);
});

test('a link half typed for one robot is not offered to the next', () => {
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
  f.robots.c0.agent = { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1, transcriptPath: '/tmp/t.jsonl' };
  store.getState().setFleet(f);
  render(<Side />);
  await act(async () => {});
  const reads = () => calls().filter(([m]) => m === 'robot.prompts').length;
  expect(reads()).toBe(1);
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent/lastActivityAt', value: 2 }]));
  await act(async () => {});
  expect(reads()).toBe(1);
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/agent/lastPrompt', value: { id: 'p1', text: 'go', at: 3 } }]));
  await act(async () => {});
  expect(reads()).toBe(2);
  // a prompt sent mid-turn reports the id of the turn's first
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent/lastPrompt', value: { id: 'p1', text: 'and this', at: 4 } }]));
  await act(async () => {});
  expect(reads()).toBe(3);
  // a permission ask and its answer leave the turn running
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent/status', value: 'blocked' }]));
  await act(async () => {});
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent/status', value: 'working' }]));
  await act(async () => {});
  expect(reads()).toBe(3);
  // a turn Claude Code opened by itself is known for what it was only once its entry is written
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent/status', value: 'done' }]));
  await act(async () => {});
  expect(reads()).toBe(4);
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/agent', value: { kind: 'codex', sessionId: 's2', status: 'done', lastActivityAt: 4 } }]));
  await act(async () => {});
  expect(reads()).toBe(5);
});

test('last activity counts on while no patch arrives', async () => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    const f = fleet();
    f.robots.c0.agent = { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1_000_000, transcriptPath: '/tmp/t.jsonl' };
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
  refuse = (m, p) => (m === 'robot.update' && p.name ? `another robot is already called ${String(p.name)}` : undefined);
  render(<Side />);
  const name = field('side-name');
  type(name, 'C1');
  fireEvent.keyDown(name, { key: 'Enter' });
  await act(async () => {});
  expect(store.getState().toast?.text).toBe('another robot is already called C1');
  expect(name.value).toBe('C1');
  name.focus();
  name.blur();
  expect(updates()).toEqual([['robot.update', { id: 'c0', name: 'C1' }], ['robot.update', { id: 'c0', name: 'C1' }]]);
});

const writeNote = (value: string) => act(() => store.getState().applyPatch([{ op: 'replace', path: '/robots/c0/note', value }]));

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
  expect(updates()).toEqual([['robot.update', { id: 'c0', note: 'mine' }]]);
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
  expect(updates()).toEqual([['robot.update', { id: 'c0', note: 'a long note' }], ['robot.update', { id: 'c0', note: 'a long note' }]]);
});

test('the fleet summary counts one robot on one island in the singular', () => {
  store.getState().setFleet({ ...fleet(), islands: { i_a: isl('i_a', 'alpha', 0) }, robots: { c2: chr('c2', 'i_a', { x: 1, y: 1 }) } });
  render(<FleetSummary />);
  expect(screen.getByRole('heading').textContent).toMatch(/^1 robot\s*on 1 island$/);
});

test('Delete robot asks first, naming the unsaved files, and moves the selection on before the robot goes', async () => {
  store.getState().markFile('c0', '/tmp/a.ts', { dirty: true });
  render(<><Side /><ConfirmClose /></>);
  fireEvent.click(screen.getByTestId('side-close'));
  expect(screen.getByTestId('confirm-close-note').textContent).toContain('1 unsaved file goes with it');
  expect(calls().filter(([m]) => m === 'robot.close')).toEqual([]);
  fireEvent.click(screen.getByTestId('confirm-close-delete'));
  await act(async () => {});
  expect(calls().filter(([m]) => m === 'robot.close')).toEqual([['robot.close', { id: 'c0' }]]);
  expect(store.getState().selectedId).toBe('c1');
});

const deletes = () => calls().filter(([m]) => m === 'island.delete');

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
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c9', value: chr('c9', 'i_e', { x: 1, y: 1 }) }]));
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

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const withVault = (reachable: boolean, c0: Partial<Robot> = {}) => {
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable, since: 0 } };
  Object.assign(f.robots.c0, c0);
  act(() => store.getState().setFleet(f));
};
const moves = () => [...document.querySelectorAll('[data-testid^="side-move"]')].map((b) => b.textContent);
// the card's buttons, in the one block at its foot
const foot = () => [...document.querySelectorAll('.side > .acts button')].map((b) => b.textContent);

test('a robot here offers a move to each worker within reach, which opens the move sheet', () => {
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 }, ['0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId]: { name: 'studio', reachable: false, since: 0 } };
  act(() => store.getState().setFleet(f));
  render(<Side />);
  expect(moves()).toEqual(['Move to linus-vault']);
  expect(foot()).toEqual(['Finder', 'Resources', 'Move to linus-vault', 'Open terminal', 'Delete robot']);
  expect(screen.queryByTestId('side-machine')).toBeNull();
  fireEvent.click(screen.getByTestId(`side-move-${VAULT}`));
  expect(store.getState().moveSheet).toEqual({ id: 'c0', to: VAULT });
});

test('a placed robot wears its machine, moves back to this Mac, and its folder buttons act there', async () => {
  load = { at: 0, cores: 8, total: { cpu: 1, mem: 1, procs: 1 }, app: { cpu: 0, mem: 0, procs: 0 }, robots: { c0: { cpu: 0.5, mem: 1e8, procs: 3, shellOnly: false, sleepable: false } } };
  withVault(true, { machine: VAULT, cwd: '/home/ada/svall' });
  await act(async () => { render(<Side />); });
  expect(screen.getByTestId('side-machine').textContent).toBe('Runs on linus-vault');
  expect(screen.getByTestId('side-machine').querySelector('b')?.textContent).toBe('linus-vault');
  expect(screen.getByTestId('side-machine').getAttribute('data-tip')).toBeNull();
  expect(screen.getByTestId('side-machine').closest('.kicker')).toBeNull();
  expect(moves()).toEqual(['Move to this Mac']);
  expect(foot()).toEqual(['Terminal there', 'Resources', 'Move to this Mac', 'Open terminal', 'Delete robot']);
  expect(screen.queryByTestId('side-cpu')).toBeNull();
  // what of its agent setup will not work there, which here is nothing
  expect(calls()).toContainEqual(['machines.setup', { machine: VAULT, robot: 'c0' }]);
  expect(document.querySelector('[data-section="robot.machine"]')).toBeNull();
  // this Mac has a clone at the same path, and the button opens the worker's
  const repo = (rootId: string): ResourceSource => ({ rootId, root: '/home/ada/svall', name: 'svall', tier: 'repo', islandIds: [], robotIds: ['c0'], groups: [] });
  act(() => store.getState().setResources([repo('r:/home/ada/svall'), repo(farRootId(VAULT, '/home/ada/svall'))]));
  fireEvent.click(screen.getByTestId('side-resources'));
  expect(store.getState().resourcesWhere).toBe(farRootId(VAULT, '/home/ada/svall'));
  expect(screen.getByTestId('side-cwd').getAttribute('data-tip')).toBe('Copy linus-vault:/home/ada/svall');
  bridge.present = true;
  try { fireEvent.click(screen.getByTestId('side-cwd')); } finally { bridge.present = false; }
  expect(sent).toContainEqual({ type: 'copy', text: 'linus-vault:/home/ada/svall' });
  fireEvent.click(screen.getByTestId('side-finder'));
  expect(screen.getByTestId('side-finder').textContent).toBe('Terminal there');
  expect(sent).toContainEqual({ type: 'host.list' });
  expect(store.getState().hostTerminal).toEqual({ run: "cd '/home/ada/svall'" });
  fireEvent.click(screen.getByTestId('side-move-home'));
  expect(store.getState().moveSheet).toEqual({ id: 'c0' });
});

test('a robot on a worker this Mac cannot reach says so under its machine line, and Check opens the Machines panel on a check of it', () => {
  withVault(false, { machine: VAULT, cwd: '/home/ada/svall' });
  render(<Side />);
  expect(document.querySelector('.side > .kicker')?.textContent).toBe('unreachable');
  expect(screen.getByTestId('side-away').textContent).toBe('linus-vault is not reachableCheck linus-vault');
  sent.length = 0;
  fireEvent.click(screen.getByTestId('side-away-run'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'linus-vault' } }]);
  expect([store.getState().hostOpen, store.getState().hostMachine, store.getState().host?.running]).toEqual([true, 'linus-vault', true]);
  // one run at a time
  expect((screen.getByTestId('side-away-run') as HTMLButtonElement).disabled).toBe(true);

  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: false, since: 0, mismatch: true } };
  Object.assign(f.robots.c0, { machine: VAULT, cwd: '/home/ada/svall' });
  act(() => { store.getState().hostDone('doctor', 0); store.getState().setFleet(f); });
  expect(screen.getByTestId('side-away').textContent).toBe('linus-vault runs a different build; upgrade it under MachinesUpgrade linus-vault');
  sent.length = 0;
  fireEvent.click(screen.getByTestId('side-away-run'));
  expect(sent).toEqual([{ type: 'host.start', op: 'upgrade', args: { name: 'linus-vault' } }]);

  withVault(true, { machine: VAULT, cwd: '/home/ada/svall' });
  expect(screen.queryByTestId('side-away')).toBeNull();
});

test('a placed robot that landed on mission control can still move back to this Mac', () => {
  withVault(true, { machine: VAULT, islandId: 'home' });
  render(<Side />);
  expect(moves()).toEqual(['Move to this Mac']);
});

test('a robot on a worker the fleet no longer lists goes by the machine\'s id', () => {
  withVault(true, { machine: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId });
  render(<Side />);
  expect(screen.getByTestId('side-machine').textContent).toBe('Runs on 0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
  expect(screen.getByTestId('side-cwd').getAttribute('data-tip')).toBe('Copy 0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f:/tmp');
});

test('a placed robot that is moving asks nothing of its machine and shows no section for it', async () => {
  withVault(true, { machine: VAULT, moving: { id: 'mv_0123456789', to: 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId, phase: 'bundle' } });
  await act(async () => { render(<Side />); });
  expect(calls().some(([m]) => m === 'machines.setup')).toBe(false);
  expect(document.querySelector('[data-section="robot.machine"]')).toBeNull();
});

test('mission control and a robot already moving offer no move', () => {
  withVault(true, { islandId: 'home' });
  render(<Side />);
  expect(moves()).toEqual([]);
  withVault(true, { moving: { id: 'mv_0123456789', to: VAULT, phase: 'bundle' } });
  expect(moves()).toEqual([]);
});
