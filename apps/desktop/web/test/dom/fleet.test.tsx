// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/api.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { DEFAULT_CWD } from '@svall/protocol';
import { portraitUrl, robotOf, robotUrl } from '../../src/portraits.js';
import { chr, fleet, isl } from '../fixtures.js';

const call = vi.fn(() => Promise.resolve({}));
const fire = vi.fn();
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call, fire }) } }));

const { Fleet } = await import('../../src/mobile/Fleet.js');
const { NewCharacter } = await import('../../src/mobile/NewCharacter.js');

let store: AppStore;

beforeEach(() => {
  call.mockClear();
  fire.mockClear();
  store = createAppStore();
  setAppStore(store);
});

test('every island and its crew are listed once the fleet arrives', () => {
  store.getState().setFleet(fleet());
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByRole('button', { name: 'beta' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'empty' })).toBeTruthy();
  expect(screen.getAllByText('c0')).toHaveLength(1);
  expect(screen.getAllByText('c2')).toHaveLength(1);
});

test('a row shows the character\'s robot, and its animal while the fleet has robots off', () => {
  store.getState().setFleet(fleet());
  const { container } = render(<Fleet onOpen={() => {}} />);
  const faces = () => [...container.querySelectorAll('.face img')].map((img) => img.getAttribute('src'));
  expect(new Set(faces())).toEqual(new Set([robotUrl(robotOf({ portrait: 'fox' }))]));
  act(() => store.getState().setFleet({ ...fleet(), animals: true }));
  expect(faces()).toContain(portraitUrl('fox'));
});

test('starred characters lead the list in star order, and stay on their islands too', () => {
  const f = fleet();
  f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { star: 0 });
  f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { star: 1 });
  store.getState().setFleet(f);
  render(<Fleet onOpen={() => {}} />);
  const starred = screen.getByRole('region', { name: 'Starred' });
  expect([...starred.querySelectorAll('.row-name')].map((el) => el.textContent)).toEqual(['c2', 'c0']);
  expect(document.querySelector('.fleet > section')).toBe(starred);
  expect(screen.getAllByText('c0')).toHaveLength(2);
});

test('no Starred section while nothing is starred', () => {
  store.getState().setFleet(fleet());
  render(<Fleet onOpen={() => {}} />);
  expect(screen.queryByRole('region', { name: 'Starred' })).toBeNull();
});

test('a collapsed island keeps its crew out of the list', () => {
  const f = fleet();
  f.islands.i_b = isl('i_b', 'beta', 0, { collapsed: true });
  store.getState().setFleet(f);
  render(<Fleet onOpen={() => {}} />);
  expect(screen.queryByText('c0')).toBeNull();
  expect(screen.getByRole('button', { expanded: false }).textContent).toContain('2');
});

test('the header counts the characters waiting on the user', () => {
  const f = fleet();
  f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { unread: true });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByText('1 waiting')).toBeTruthy();
});

test('all quiet when nobody is waiting', () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByText('all quiet')).toBeTruthy();
});

test('tapping a row opens that character', () => {
  store.getState().setFleet(fleet());
  const onOpen = vi.fn();
  render(<Fleet onOpen={onOpen} />);
  fireEvent.click(screen.getByText('c2').closest('button')!);
  expect(onOpen).toHaveBeenCalledWith('c2');
});

test('folding an island asks the daemon to remember it', () => {
  store.getState().setFleet(fleet());
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'beta' }));
  expect(call).toHaveBeenCalledWith('island.update', { id: 'i_b', collapsed: true });
});

test('a row with unread output offers to mark it read', () => {
  const f = fleet();
  f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { unread: true });
  store.getState().setFleet(f);
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark c2 read' }));
  expect(fire).toHaveBeenCalledWith('char.seen', { id: 'c2' });
});

test('a one-tap character whose crew mate\'s directory is gone starts in the fleet default', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation(((_m: string, p: { cwd: string }) => (p.cwd === DEFAULT_CWD
    ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new ApiError('invalid', 'cwd /tmp is not a directory')))) as never);
  const onOpen = vi.fn();
  render(<Fleet onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'New character on beta' }));
  await act(async () => {});
  expect(call.mock.calls).toEqual([['char.create', { islandId: 'i_b', cwd: '/tmp' }], ['char.create', { islandId: 'i_b', cwd: DEFAULT_CWD }]]);
  expect(onOpen).toHaveBeenCalledWith('c_new');
  call.mockImplementation(() => Promise.resolve({}));
});

test('a character made in the sheet on a directory that is gone starts in the fleet default', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation(((_m: string, p: { cwd: string }) => (p.cwd === DEFAULT_CWD
    ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new ApiError('invalid', 'cwd /tmp is not a directory')))) as never);
  const onCreated = vi.fn();
  render(<NewCharacter islandId="i_b" onClose={() => {}} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await act(async () => {});
  expect(call.mock.calls).toEqual([['char.create', { islandId: 'i_b', cwd: '/tmp' }], ['char.create', { islandId: 'i_b', cwd: DEFAULT_CWD }]]);
  expect(onCreated).toHaveBeenCalledWith('c_new');
  call.mockImplementation(() => Promise.resolve({}));
});

test('a character made on mission control from the phone starts the home command, by one tap or the sheet', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation((() => Promise.resolve({ id: 'c_new' })) as never);
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'New character on mission control' }));
  await act(async () => {});
  expect(call).toHaveBeenLastCalledWith('char.create', { islandId: 'home', cwd: '/mc', command: 'claude --model sonnet' });

  render(<NewCharacter islandId="home" onClose={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await act(async () => {});
  expect(call).toHaveBeenLastCalledWith('char.create', { islandId: 'home', cwd: '/mc', command: 'claude --model sonnet' });
  call.mockImplementation(() => Promise.resolve({}));
});

test('an empty fleet says so', () => {
  store.getState().setFleet({ ...fleet(), islands: {}, characters: {} });
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByText('No islands yet. Tap + to make one.')).toBeTruthy();
});
