// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { emptyState, type MachineId } from '@svall/protocol';
import { ApiError } from '../../src/api.js';
import type { Via } from '../../src/placement.js';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { NewRobot } = await import('../../src/NewRobot.js');
const { newRobotOn } = await import('../../src/actions.js');
const { deps } = await import('../../src/boot.js');

const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
const far: Via = { machine: MAC, home: STUDIO, name: 'studio', online: true };
const apart: Via = { machine: MAC, home: STUDIO, name: 'studio' };

const DEFAULTS = { cwd: '/home/linus', home: '/home/linus/.svall/home' };
type Folders = { path: string; clone: boolean }[];
const FOLDERS: Folders = [{ path: '/home/linus/app', clone: true }, { path: '/home/linus/notes', clone: false }];

// a daemon that answers the list, and refuses or takes the start as `create` says
function answers(machine: MachineId, folders: Folders, create: (p: { cwd: string }) => Promise<unknown> = () => Promise.resolve({ id: 'c_new' })) {
  call.mockImplementation(((m: string, p: { cwd: string }) => {
    if (m === 'workspace.clones') return Promise.resolve({ machine, folders, defaults: DEFAULTS });
    return m === 'robot.create' ? create(p) : Promise.resolve({});
  }) as never);
}
const creates = () => call.mock.calls.filter(([m]) => m === 'robot.create').map(([, p]) => p as { cwd: string });
const asked = () => call.mock.calls.filter(([m]) => m === 'workspace.clones').length;

async function open(via?: Via) {
  act(() => { store.getState().setVia(via); store.getState().setNamingRobot(true); });
  await act(async () => { render(<NewRobot />); });
}
const shown = () => [...document.querySelectorAll('[data-testid="new-robot-folders"] [role="option"]:not([data-testid="new-robot-other"])')].map((b) => b.textContent);
const folder = () => screen.getByTestId<HTMLInputElement>('new-robot-folder');
// the listed folder the dialog stands on, none while the field holds the folder
const picked = () => document.querySelector('[data-testid="new-robot-folders"] [aria-selected="true"]')?.getAttribute('data-tip') ?? undefined;
const typeOther = () => fireEvent.click(screen.getByTestId('new-robot-other'));
const create = async () => { await act(async () => { fireEvent.click(screen.getByTestId('new-robot-create')); }); };

beforeEach(() => {
  call.mockReset();
  freshStore();
  act(() => store.getState().selectIsland('i_b'));
});

test('on a Mac home the dialog has no folder field, asks for no list, and starts as ever', async () => {
  answers(MAC, FOLDERS);
  await open();
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  expect(screen.queryByTestId('new-robot-where')).toBeNull();
  expect(asked()).toBe(0);
  await create();
  expect(creates()).toEqual([expect.objectContaining({ islandId: 'i_b', cwd: '/tmp' })]);
});

test('on a Mac home a folder gone gives way to the fleet\'s default, as ever', async () => {
  call.mockImplementation(((m: string, p: { cwd: string }) => (m === 'robot.create' && p.cwd === '/tmp'
    ? Promise.reject(new ApiError('not_a_folder', 'cwd /tmp is not a directory')) : Promise.resolve({ id: 'c_new' }))) as never);
  act(() => { const f = store.getState().fleet; store.getState().setFleet({ ...f, newRobotStart: 'shell' }); });
  await open();
  await create();
  expect(creates().map((p) => p.cwd)).toEqual(['/tmp', store.getState().fleet.defaultCwd]);
  expect(store.getState().namingRobot).toBe(false);
});

test('the + beside an island with no robot there opens the dialog, and the robot starts on that island, in its column', async () => {
  answers(STUDIO, FOLDERS);
  act(() => { store.getState().select('c0'); store.getState().setVia(far); store.getState().setFleet({ ...store.getState().fleet, robots: {} }); });
  await act(async () => { await newRobotOn(deps(), 'i_e', 'k_review'); render(<NewRobot />); });
  expect(creates()).toEqual([]);
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on studio');
  fireEvent.click(screen.getByTestId('new-robot-pick-/home/linus/notes'));
  await create();
  expect(creates()).toEqual([expect.objectContaining({ islandId: 'i_e', cwd: '/home/linus/notes' })]);
  expect(call.mock.calls.filter(([m]) => m === 'robot.place').map(([, p]) => p)).toEqual([{ id: 'c_new', columnId: 'k_review' }]);
  expect(store.getState().namingRobot).toBe(false);
});

test('on a far home it lists the home\'s folders and starts in the one chosen, naming no machine', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on studio');
  expect(shown()).toEqual(['~/app', '~/notes']);
  fireEvent.click(screen.getByTestId('new-robot-pick-/home/linus/notes'));
  expect(picked()).toBe('/home/linus/notes');
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  await create();
  expect(creates()).toHaveLength(1);
  expect(creates()[0]).toEqual({ islandId: 'i_b', cwd: '/home/linus/notes' });
  expect(store.getState().namingRobot).toBe(false);
});

test('it starts on the folder of the robot beside it when the home has that, else on the first listed', async () => {
  const f = store.getState().fleet;
  act(() => store.getState().setFleet({ ...f, robots: {
    ...f.robots, c0: { ...f.robots.c0, cwd: '/home/linus/notes' }, c1: { ...f.robots.c1, cwd: '/Users/ada/code', machine: MAC },
  } }));
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(picked()).toBe('/home/linus/notes');
});

test('a robot here beside it names no folder on the home, so the first listed stands', async () => {
  const f = store.getState().fleet;
  act(() => store.getState().setFleet({ ...f, robots: { c0: { ...f.robots.c0, cwd: '/Users/ada/code', machine: MAC } } }));
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(picked()).toBe('/home/linus/app');
});

test('a typed path the home refuses is said in the dialog, with the home\'s name, and is not retried anywhere else', async () => {
  answers(STUDIO, FOLDERS, (p) => Promise.reject(new ApiError('not_a_folder', `cwd ${p.cwd} is not a directory`, { kind: p.cwd.endsWith('.txt') ? 'file' : 'missing' })));
  await open(far);
  typeOther();
  fireEvent.change(folder(), { target: { value: ' /home/linus/x ' } });
  await create();
  expect(screen.getByTestId('new-robot-refused').textContent).toBe('No such folder on studio');
  expect(creates().map((p) => p.cwd)).toEqual(['/home/linus/x']);
  expect(store.getState().namingRobot).toBe(true);
  // the same folder would be refused again, so Create waits for another
  expect([screen.getByTestId('new-robot-create').hasAttribute('disabled'), screen.getByTestId('new-robot-create').dataset.tip]).toEqual([true, 'Choose another folder on studio']);
  fireEvent.change(folder(), { target: { value: '/home/linus/app' } });
  expect(screen.queryByTestId('new-robot-refused')).toBeNull();
  expect(screen.getByTestId('new-robot-create').hasAttribute('disabled')).toBe(false);
  fireEvent.change(folder(), { target: { value: '~/fartest-file.txt' } });
  await create();
  expect(screen.getByTestId('new-robot-refused').textContent).toBe('That is a file, not a folder');
});

test('another refusal is the home\'s own words, on the toast', async () => {
  answers(STUDIO, FOLDERS, () => Promise.reject(new ApiError('invalid', 'island i_b is full')));
  await open(far);
  await create();
  expect(store.getState().toast?.text).toBe('island i_b is full');
  expect(screen.queryByTestId('new-robot-refused')).toBeNull();
});

test('with no folder there is nothing to create until one is typed, and the list says why it is empty', async () => {
  answers(STUDIO, []);
  await open(far);
  expect(screen.getByTestId('new-robot-none').textContent).toBe('No clone or robot folder on studio yet.');
  // an empty list gives up the height its rows would take, so the field sits under its line
  expect(screen.getByTestId('new-robot-folders').hasAttribute('data-empty')).toBe(true);
  expect(screen.queryByTestId('new-robot-other')).toBeNull();
  expect(screen.getByTestId('new-robot-create').hasAttribute('disabled')).toBe(true);
  expect(screen.getByTestId('new-robot-create').dataset.tip).toBe('Choose a folder on studio');
  fireEvent.keyDown(folder(), { key: 'Enter' });
  await act(async () => {});
  expect(creates()).toEqual([]);
  fireEvent.change(folder(), { target: { value: '/srv/app' } });
  expect(screen.getByTestId('new-robot-create').dataset.tip).toBeUndefined();
  fireEvent.keyDown(folder(), { key: 'Enter' });
  await act(async () => {});
  expect(creates().map((p) => p.cwd)).toEqual(['/srv/app']);
});

test('in fallback the list is this Mac\'s, its clones alone, and the worker\'s away rule is said in its own words', async () => {
  const outside = '/Users/ada/notes is not inside a clone on ada-mac; start it in one';
  answers(MAC, [{ path: '/Users/ada/app', clone: true }, { path: '/Users/ada/notes', clone: false }], () => Promise.reject(new ApiError('invalid', outside)));
  await open(apart);
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on this Mac');
  const away = screen.getByTestId('new-robot-away');
  expect([...away.querySelectorAll('.said > div > span')].map((e) => e.textContent)).toEqual(['studio is not reachable', 'This robot starts on this Mac.']);
  expect(away.querySelector('.said')!.getAttribute('data-mark')).toBe('warn');
  expect(shown()).toEqual(['~/app']);
  typeOther();
  fireEvent.change(folder(), { target: { value: '/Users/ada/notes' } });
  await create();
  expect(store.getState().toast?.text).toBe(outside);
  expect(screen.queryByTestId('new-robot-refused')).toBeNull();
  expect(store.getState().namingRobot).toBe(true);
});

test('in fallback with no clone it says so', async () => {
  answers(MAC, [{ path: '/Users/ada/notes', clone: false }]);
  await open(apart);
  expect(screen.getByTestId('new-robot-none').textContent).toBe('No clone listed here; type a path inside one.');
});

test('a refusal in fallback that names no folder there says this Mac, never the home', async () => {
  answers(MAC, [{ path: '/Users/ada/app', clone: true }], () => Promise.reject(new ApiError('not_a_folder', 'cwd /x is not a directory')));
  await open(apart);
  typeOther();
  fireEvent.change(folder(), { target: { value: '/x' } });
  await create();
  expect(screen.getByTestId('new-robot-refused').textContent).toBe('No such folder on this Mac');
});

test('a window whose home dials it reads the list where the robot would start, and says so', async () => {
  answers(MAC, FOLDERS);
  await open(far);
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on this Mac');
});

test('a window that changes source reads the list again, and a folder the user chose stands', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(picked()).toBe('/home/linus/app');
  answers(MAC, [{ path: '/Users/ada/app', clone: true }]);
  await act(async () => { store.getState().setVia(apart); });
  expect(asked()).toBe(2);
  expect(shown()).toEqual(['~/app']);
  expect(picked()).toBe('/Users/ada/app');

  typeOther();
  fireEvent.change(folder(), { target: { value: '/Users/ada/typed' } });
  answers(STUDIO, FOLDERS);
  await act(async () => { store.getState().setVia(far); });
  expect(shown()).toEqual(['~/app', '~/notes']);
  expect(folder().value).toBe('/Users/ada/typed');
});

test('a list that cannot be read leaves the field to type in', async () => {
  call.mockImplementation((() => Promise.reject(new Error('svalld connection closed'))) as never);
  await open(far);
  expect(shown()).toEqual([]);
  expect(screen.getByTestId('new-robot-folders').textContent).toBe('studio did not list its folders');
  expect(screen.queryByTestId('new-robot-none')).toBeNull();
  expect(folder().value).toBe('');
});

test('closing it forgets the folder and the list', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  typeOther();
  fireEvent.change(folder(), { target: { value: '/typed' } });
  act(() => store.getState().setNamingRobot(false));
  await act(async () => { store.getState().setNamingRobot(true); });
  expect(picked()).toBe('/home/linus/app');
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  expect(asked()).toBe(2);
});

describe('where the field starts, on what a new fleet\'s state holds', () => {
  const HELD: Folders = [{ path: '/home/linus/aardvark', clone: true }, { path: DEFAULTS.cwd, clone: false }, { path: DEFAULTS.home, clone: false }];
  const fresh = () => {
    const f = emptyState();
    act(() => { store.getState().setFleet({ ...f, islands: store.getState().fleet.islands }); store.getState().selectIsland(undefined); });
    expect(f.defaultCwd).toBe('~');
    expect(f.home.cwd.startsWith('~/')).toBe(true);
  };

  test('mission control selected: its own folder, as the home spells it', async () => {
    fresh();
    act(() => store.getState().selectIsland('home'));
    answers(STUDIO, HELD);
    await open(far);
    expect(picked()).toBe(DEFAULTS.home);
    await create();
    expect(creates()[0]).toMatchObject({ islandId: 'home', cwd: DEFAULTS.home });
  });

  test('an empty island selected: the fleet\'s default, as the home spells it', async () => {
    fresh();
    act(() => store.getState().selectIsland('i_e'));
    answers(STUDIO, HELD);
    await open(far);
    expect(picked()).toBe(DEFAULTS.cwd);
  });

  test('in fallback a start that is no clone gives way to the first clone listed', async () => {
    fresh();
    act(() => store.getState().selectIsland('i_e'));
    answers(MAC, [{ path: '/Users/ada', clone: false }, { path: '/Users/ada/app', clone: true }]);
    await open(apart);
    expect(picked()).toBe('/Users/ada/app');
  });
});

test('on a Mac home a folder refused with an agent to start is said on the toast, as ever', async () => {
  const words = 'cwd /tmp is not a directory';
  call.mockImplementation(((m: string) => (m === 'robot.create' ? Promise.reject(new ApiError('not_a_folder', words)) : Promise.resolve({}))) as never);
  act(() => { const f = store.getState().fleet; store.getState().setFleet({ ...f, newRobotStart: 'agent' }); });
  await open();
  await create();
  expect(store.getState().toast?.text).toBe(words);
  expect(store.getState().namingRobot).toBe(true);
  expect(screen.queryByTestId('new-robot-refused')).toBeNull();
});

test('an answer from a source it has left is not listed', async () => {
  let answer: (r: unknown) => void = () => {};
  call.mockImplementationOnce((() => new Promise((r) => { answer = r; })) as never);
  await open(far);
  answers(MAC, [{ path: '/Users/ada/app', clone: true }]);
  await act(async () => { store.getState().setVia(apart); });
  await act(async () => { answer({ machine: STUDIO, folders: FOLDERS, defaults: DEFAULTS }); });
  expect(shown()).toEqual(['~/app']);
  expect(picked()).toBe('/Users/ada/app');
});

test('a window that learns its home is elsewhere with the dialog open asks then', async () => {
  answers(MAC, [{ path: '/Users/ada/app', clone: true }]);
  await open();
  expect(asked()).toBe(0);
  await act(async () => { store.getState().setVia(apart); });
  expect(asked()).toBe(1);
  expect(shown()).toEqual(['~/app']);
});

test('the field takes a path as typed', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  typeOther();
  expect([folder().getAttribute('autocapitalize'), folder().getAttribute('spellcheck')]).toEqual(['off', 'false']);
});

test('a window its daemon stops serving reads the list again, as the robot now starts on the home', async () => {
  answers(MAC, [{ path: '/Users/ada/app', clone: true }]);
  await open({ ...far, served: true });
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on this Mac');
  answers(STUDIO, FOLDERS);
  await act(async () => { store.getState().setVia(far); });
  expect(asked()).toBe(2);
  expect(screen.getByTestId('new-robot-where').textContent).toBe('folder on studio');
});

test('a robot\'s folder gone gives way to the fleet\'s default, not to the first clone sorted', async () => {
  const f = store.getState().fleet;
  act(() => store.getState().setFleet({ ...f, robots: { c0: { ...f.robots.c0, cwd: '/home/linus/gone' } } }));
  answers(STUDIO, [{ path: '/home/linus/aardvark', clone: true }, { path: DEFAULTS.cwd, clone: false }]);
  await open(far);
  expect(picked()).toBe(DEFAULTS.cwd);
});

test('while the list is read it holds its place with one line, and nothing can be created', async () => {
  let answer: (r: unknown) => void = () => {};
  call.mockImplementationOnce((() => new Promise((r) => { answer = r; })) as never);
  await open(far);
  expect(screen.getByTestId('new-robot-folders').textContent).toBe('Reading studio\'s folders…');
  expect(screen.getByTestId('new-robot-folders').getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  expect(screen.getByTestId('new-robot-create').hasAttribute('disabled')).toBe(true);
  await act(async () => { answer({ machine: STUDIO, folders: FOLDERS, defaults: DEFAULTS }); });
  expect(shown()).toEqual(['~/app', '~/notes']);
  expect(screen.getByTestId('new-robot-folders').hasAttribute('aria-busy')).toBe(false);
});

test('Other folder… brings the field, which takes the keys; a listed folder puts it away', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  expect(screen.getByTestId('new-robot-other').getAttribute('aria-selected')).toBe('false');
  typeOther();
  expect(document.activeElement).toBe(folder());
  expect(folder().value).toBe('');
  expect(folder().placeholder).toBe('~/code/project');
  expect(picked()).toBeUndefined();
  expect(screen.getByTestId('new-robot-other').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('new-robot-create').hasAttribute('disabled')).toBe(true);
  fireEvent.change(folder(), { target: { value: '/srv/app' } });
  await create();
  expect(creates().map((p) => p.cwd)).toEqual(['/srv/app']);
});

test('the arrow keys walk the list, choosing as they go, and leave the focus there on Other folder…', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  expect(picked()).toBe('/home/linus/app');
  const list = screen.getByTestId('new-robot-folders');
  const tabbable = () => [...list.querySelectorAll('[role="option"]')].filter((o) => o.getAttribute('tabindex') === '0').map((o) => o.textContent);
  expect(tabbable()).toEqual(['~/app']);
  screen.getByTestId('new-robot-pick-/home/linus/app').focus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(picked()).toBe('/home/linus/notes');
  expect(document.activeElement).toBe(screen.getByTestId('new-robot-pick-/home/linus/notes'));
  expect(tabbable()).toEqual(['~/notes']);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(screen.getByTestId('new-robot-other').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(screen.getByTestId('new-robot-other'));
  expect(screen.getByTestId('new-robot-folder')).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(picked()).toBe('/home/linus/app');
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
});

test('folders past the list\'s foot are said by a fade over it, gone once the list is scrolled to its end', async () => {
  // jsdom lays nothing out, so the list's heights are the ones a window would measure
  const tall = { clientHeight: 119, scrollHeight: 340 };
  for (const [k, v] of Object.entries(tall)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get() { return (this as HTMLElement).dataset.testid === 'new-robot-folders' ? v : 0; } });
  try {
    answers(STUDIO, FOLDERS);
    await open(far);
    const list = screen.getByTestId('new-robot-folders');
    expect(list.hasAttribute('data-more')).toBe(true);
    expect(list.hasAttribute('data-empty')).toBe(false);
    list.scrollTop = 221;
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-more')).toBe(false);
  } finally {
    for (const k of Object.keys(tall)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

test('a listed folder chosen after Other folder… is the one created in', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  typeOther();
  fireEvent.change(folder(), { target: { value: '/srv/app' } });
  fireEvent.click(screen.getByTestId('new-robot-pick-/home/linus/notes'));
  expect(screen.queryByTestId('new-robot-folder')).toBeNull();
  await create();
  expect(creates().map((p) => p.cwd)).toEqual(['/home/linus/notes']);
});

test('a folder chosen from a list a new source no longer holds shows in the field, not nowhere', async () => {
  answers(STUDIO, FOLDERS);
  await open(far);
  fireEvent.click(screen.getByTestId('new-robot-pick-/home/linus/notes'));
  answers(MAC, [{ path: '/Users/ada/app', clone: true }]);
  await act(async () => { store.getState().setVia(apart); });
  expect(picked()).toBeUndefined();
  expect(folder().value).toBe('/home/linus/notes');
  expect(screen.getByTestId('new-robot-other').getAttribute('aria-selected')).toBe('true');
});
