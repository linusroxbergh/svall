// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Agent, MachineId } from '@svall/protocol';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const call = vi.fn((_m: string, _p: unknown) => Promise.resolve({}));
const fire = vi.fn();
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call, fire }), get store() { return store; } } }));

const { Fleet } = await import('../../src/mobile/Fleet.js');
const { Waiting } = await import('../../src/mobile/Waiting.js');

let store: AppStore;
const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const HOME = '11111111-1111-4111-8111-111111111111' as MachineId;
const agent = (status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 0, ...extra });
const card = (name: string) => screen.getByRole('article', { name });

beforeEach(() => {
  call.mockClear();
  fire.mockClear();
  store = createAppStore();
  setAppStore(store);
  store.getState().setStatus('online');
});

test('the header\'s count opens the page, and through a worker sits beside the worker line', () => {
  const f = fleet();
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { unread: true });
  store.getState().setFleet(f);
  const onWaiting = vi.fn();
  render(<Fleet onWaiting={onWaiting} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '1 waiting' }));
  expect(onWaiting).toHaveBeenCalledOnce();
  act(() => store.getState().setVia({ machine: VAULT, home: HOME }));
  f.robots.c0 = { ...f.robots.c0, machine: VAULT };
  act(() => store.getState().setFleet({ ...f, robots: { ...f.robots } }));
  expect(screen.getByText(/asleep$/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy();
});

test('a yes or no is answered on its card, for the question it asked, once', async () => {
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { name: 'ada', machine: VAULT,
    agent: agent('blocked', { prompt: 'Claude needs your permission to use Bash', askedTool: 'Bash', askedFor: 'pnpm test', promptId: 'p1' }) });
  store.getState().setFleet(f);
  render(<Waiting onOpen={() => {}} onBack={() => {}} />);
  const ada = card('ada');
  expect(within(ada).getByText('pnpm test')).toBeTruthy();
  expect(within(ada).getByTestId('phone-machine-c0').textContent).toBe('on linus-vault');
  fireEvent.click(within(ada).getByRole('button', { name: 'approve' }));
  expect(call).toHaveBeenCalledWith('robot.answer', { id: 'c0', answer: 'approve', promptId: 'p1' });
  expect((within(ada).getByRole('button', { name: 'deny' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {});
});

test('a question, and an ask in the second terminal, open the robot in place of buttons', () => {
  const f = fleet();
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { name: 'bob', agent: agent('blocked', { prompt: 'Which auth flow?', askedTool: 'AskUserQuestion', promptId: 'q1' }) });
  f.robots.c1 = chr('c1', 'i_b', { x: 4, y: 1 }, { name: 'cy', agent: agent('working', { askedFor: 'main.ts' }),
    second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: agent('blocked', { prompt: 'Allow Edit?', askedTool: 'Edit', askedFor: 'a.ts', promptId: 'e1' }) } });
  store.getState().setFleet(f);
  const onOpen = vi.fn();
  render(<Waiting onOpen={onOpen} onBack={() => {}} />);
  expect(within(card('bob')).queryByRole('button', { name: 'approve' })).toBeNull();
  fireEvent.click(within(card('bob')).getByRole('button', { name: /open/ }));
  expect(onOpen).toHaveBeenCalledWith('c0');
  // the second terminal's own command, not the main one's
  expect(within(card('cy')).getByText('a.ts')).toBeTruthy();
  expect(within(card('cy')).queryByText('main.ts')).toBeNull();
  expect(within(card('cy')).getByText('on the Mac')).toBeTruthy();
  expect(within(card('cy')).queryByRole('button', { name: 'approve' })).toBeNull();
});

test('unread work waits apart from the asks, and with nothing left the page says so', () => {
  const f = fleet();
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { agent: agent('done'), unread: true });
  store.getState().setFleet(f);
  render(<Waiting onOpen={() => {}} onBack={() => {}} />);
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  fireEvent.click(within(screen.getByRole('region', { name: 'To review' })).getByRole('button', { name: 'Mark c0 read' }));
  expect(fire).toHaveBeenCalledWith('robot.seen', { id: 'c0' });
  act(() => store.getState().setFleet(fleet()));
  expect(screen.getByText('Nothing waits on you.')).toBeTruthy();
});

test('before the fleet loads, the page claims nothing', () => {
  render(<Waiting onOpen={() => {}} onBack={() => {}} />);
  expect(screen.queryByText('Nothing waits on you.')).toBeNull();
  act(() => store.getState().setFleet(fleet()));
  expect(screen.getByText('Nothing waits on you.')).toBeTruthy();
});
