// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/api.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { DEFAULT_CWD, type MachineId } from '@svall/protocol';
import { figureOf, figureUrl } from '../../src/portraits.js';
import { chr, fleet, isl } from '../fixtures.js';

const call = vi.fn(() => Promise.resolve({}));
const fire = vi.fn();
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call, fire }) } }));

const { Fleet } = await import('../../src/mobile/Fleet.js');
const { NewRobot } = await import('../../src/mobile/NewRobot.js');

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

test('a row shows the robot\'s robot', () => {
  store.getState().setFleet(fleet());
  const { container } = render(<Fleet onOpen={() => {}} />);
  const faces = [...container.querySelectorAll('.face img')].map((img) => img.getAttribute('src'));
  expect(new Set(faces)).toEqual(new Set([figureUrl(figureOf({ portrait: 'fox' }))]));
});

test('starred robots lead the list in star order, and stay on their islands too', () => {
  const f = fleet();
  f.robots.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { star: 0 });
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { star: 1 });
  store.getState().setFleet(f);
  render(<Fleet onOpen={() => {}} />);
  const starred = screen.getByRole('region', { name: 'Starred' });
  expect([...starred.querySelectorAll('.row-name')].map((el) => el.textContent)).toEqual(['c2', 'c0']);
  expect(document.querySelector('.fleet > section')).toBe(starred);
  expect(screen.getAllByText('c0')).toHaveLength(2);
});

test('a robot on a worker out of reach reads unknown, and its last question asks nothing', () => {
  const f = fleet();
  const vault = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
  f.machines = { [vault]: { name: 'linus-vault', reachable: false, since: 0 } };
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { machine: vault, agent: { kind: 'claude', sessionId: 's', status: 'blocked', lastActivityAt: 0 } });
  store.getState().setFleet(f);
  const { container } = render(<Fleet onOpen={() => {}} />);
  const row = [...container.querySelectorAll('.row')].find((r) => r.querySelector('.row-name')?.textContent === 'c0')!;
  expect(row.getAttribute('data-status')).toBe('unknown');
  expect(row.querySelector('.row-status')?.textContent).toBe('unknown');
  expect(row.querySelector('.pip')).toBeNull();
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

test('the header counts the robots waiting on the user', () => {
  const f = fleet();
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { unread: true });
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

test('tapping a row opens that robot', () => {
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
  f.robots.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { unread: true });
  store.getState().setFleet(f);
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark c2 read' }));
  expect(fire).toHaveBeenCalledWith('robot.seen', { id: 'c2' });
});

test('a one-tap robot whose crew mate\'s directory is gone starts in the fleet default', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation(((_m: string, p: { cwd: string }) => (p.cwd === DEFAULT_CWD
    ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new ApiError('invalid', 'cwd /tmp is not a directory')))) as never);
  const onOpen = vi.fn();
  render(<Fleet onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'New robot on beta' }));
  await act(async () => {});
  expect(call.mock.calls).toEqual([['robot.create', { islandId: 'i_b', cwd: '/tmp' }], ['robot.create', { islandId: 'i_b', cwd: DEFAULT_CWD }]]);
  expect(onOpen).toHaveBeenCalledWith('c_new');
  call.mockImplementation(() => Promise.resolve({}));
});

test('a robot made in the sheet on a directory that is gone starts in the fleet default', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation(((_m: string, p: { cwd: string }) => (p.cwd === DEFAULT_CWD
    ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new ApiError('invalid', 'cwd /tmp is not a directory')))) as never);
  const onCreated = vi.fn();
  render(<NewRobot islandId="i_b" onClose={() => {}} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await act(async () => {});
  expect(call.mock.calls).toEqual([['robot.create', { islandId: 'i_b', cwd: '/tmp' }], ['robot.create', { islandId: 'i_b', cwd: DEFAULT_CWD }]]);
  expect(onCreated).toHaveBeenCalledWith('c_new');
  call.mockImplementation(() => Promise.resolve({}));
});

test('a robot made on mission control from the phone starts the home command, by one tap or the sheet', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementation((() => Promise.resolve({ id: 'c_new' })) as never);
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'New robot on mission control' }));
  await act(async () => {});
  expect(call).toHaveBeenLastCalledWith('robot.create', { islandId: 'home', cwd: '/mc', command: 'claude --model opus' });

  render(<NewRobot islandId="home" onClose={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await act(async () => {});
  expect(call).toHaveBeenLastCalledWith('robot.create', { islandId: 'home', cwd: '/mc', command: 'claude --model opus' });
  call.mockImplementation(() => Promise.resolve({}));
});

test('an empty fleet says so', () => {
  store.getState().setFleet({ ...fleet(), islands: {}, robots: {} });
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByText('No islands yet. Tap + to make one.')).toBeTruthy();
});

test('a refused login is pointed at fleet.json, where the fleet keeps its logins', () => {
  store.getState().setStatus('refused');
  render(<Fleet onOpen={() => {}} />);
  expect(screen.getByText(/can't open this fleet/).textContent).toContain('mobile.logins in fleet.json');
});

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const HOME = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;
// the fleet as linus-vault holds it while the Mac does not answer: c0 runs there, c1 and c2 at home
const throughVault = () => {
  const f = fleet();
  f.machines = { [HOME]: { name: 'mac', reachable: false, since: 0 }, [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { machine: VAULT, cwd: '/home/me/a' });
  f.robots.c1 = chr('c1', 'i_b', { x: 4, y: 1 }, { agent: { kind: 'claude', sessionId: 's', status: 'blocked', lastActivityAt: 0 } });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  store.getState().setVia({ machine: VAULT, home: HOME });
};

test('through a worker, the list offers no new island, settings or island sheet, and the robots elsewhere read unknown and wait on nobody', () => {
  throughVault();
  const { container } = render(<Fleet onOpen={() => {}} />);
  expect(screen.queryByRole('button', { name: 'New island' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'beta options' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New robot on mission control' })).toBeNull();
  expect(screen.getByRole('button', { name: 'New robot on alpha' })).toBeTruthy();
  expect(container.querySelector('.conn')!.textContent).toBe('on linus-vault · mac asleep');
  const status = (name: string) => screen.getByText(name).closest('.row')!.getAttribute('data-status');
  expect([status('c0'), status('c1'), status('c2')]).toEqual(['shell', 'unknown', 'unknown']);
  // only a robot running on the worker can be closed from it
  expect(container.querySelector('[aria-label="Close c1"]')).toBeNull();
  expect(container.querySelector('[aria-label="Close c0"]')).toBeTruthy();
});

test('through a worker, a new robot is started in a folder of the robots running there', async () => {
  throughVault();
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'New robot on alpha' }));
  expect(call).not.toHaveBeenCalled();
  expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['/home/me/a']);
  call.mockResolvedValueOnce({ id: 'c9' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(call).toHaveBeenCalledWith('robot.create', { islandId: 'i_a', cwd: '/home/me/a' });
});

test('through a worker with no robot of its own, a new robot has no folder to start in', () => {
  throughVault();
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, robots: { ...f.robots, c0: { ...f.robots.c0, machine: undefined } } });
  render(<NewRobot islandId="i_a" onClose={() => {}} onCreated={() => {}} />);
  expect(screen.getByText(/No robot runs on linus-vault yet/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
});

test('through a worker, an island folds nowhere, and one folded on the Mac shows its crew', () => {
  throughVault();
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, islands: { ...f.islands, i_b: { ...f.islands.i_b, collapsed: true } } });
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'beta' }));
  expect(call).not.toHaveBeenCalled();
  expect(screen.getByText('c0')).toBeTruthy();
});

test('through a worker, only its own robots are marked read from the list', () => {
  throughVault();
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, robots: { ...f.robots, c0: { ...f.robots.c0, unread: true }, c2: { ...f.robots.c2, unread: true } } });
  render(<Fleet onOpen={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Mark c2 read' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Mark c0 read' }));
  expect(fire).toHaveBeenCalledWith('robot.seen', { id: 'c0' });
});

test('a new robot sheet open as the Mac comes back starts in the Mac\'s folder, not the worker\'s', async () => {
  throughVault();
  render(<Fleet onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'New robot on alpha' }));
  act(() => store.getState().setVia(undefined));
  call.mockResolvedValueOnce({ id: 'c9' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(call).toHaveBeenCalledWith('robot.create', { islandId: 'i_a', cwd: '/tmp' });
});
