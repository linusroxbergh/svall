// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError, INTERRUPT_ACTIONS, type MachineId, type MoveSheet as Sheet, type Refusal } from '@svall/protocol';
import { chr, fleet } from '../fixtures.js';
import { call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { MoveSheet } = await import('../../src/MoveSheet.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const HOME = '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' as MachineId;
const sheet = (more: Partial<Sheet> = {}): Sheet => ({
  sessionBytes: 4_000_000, branch: 'kanban-board', commits: 2, changedFiles: 3, untrackedFiles: 0, clone: 'clone',
  credentialFiles: ['.env'], stays: ['.env stays here'], interrupts: false, question: false, notInRepo: false, ...more,
});
// what each moveCheck answers, in turn; the last one stands for every ask after it
let answers: ({ ok: true; sheet: Sheet } | { ok: false; refusal: Refusal })[] = [];
const checks = () => call.mock.calls.filter(([m]) => m === 'robot.moveCheck').map(([, p]) => p);

beforeEach(() => {
  freshStore();
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  f.robots.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { name: 'ada', repo: { root: '/Users/ada/svall', mainRoot: '/Users/ada/svall', branch: 'kanban-board', isWorktree: false } });
  store.getState().setFleet(f);
  answers = [{ ok: true, sheet: sheet() }];
  call.mockImplementation((method: string) => {
    if (method === 'robot.moveCheck') return Promise.resolve(answers.length > 1 ? answers.shift() : answers[0]);
    if (method === 'robot.moveTo') return Promise.resolve({ moveId: 'mv_0123456789' });
    if (method === 'system.info') return Promise.resolve({ machineId: HOME });
    return Promise.resolve({});
  });
});

const open = async (to?: MachineId) => {
  render(<MoveSheet />);
  await act(async () => store.getState().setMoveSheet({ id: 'c0', to }));
};

test('the sheet says what travels in one line, re-asks with a ticked credential file, and Move starts the move and closes', async () => {
  await open(VAULT);
  expect(screen.getByTestId('move-title').textContent).toBe('Move ada to linus-vault');
  expect(screen.getByTestId('move-summary').textContent)
    .toBe('session 4 MB · branch kanban-board: 2 commits not on origin, 3 changed files · svall on linus-vault: will clone (first time) · .env stays here');
  expect(checks()).toEqual([{ id: 'c0', machine: VAULT }]);

  answers = [{ ok: true, sheet: sheet({ stays: [] }) }];
  const carry = screen.getByLabelText('copy .env to linus-vault') as HTMLInputElement;
  await act(async () => fireEvent.click(carry));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT, carry: ['.env'] });
  expect(screen.getByTestId('move-summary').textContent).not.toContain('.env stays here');
  expect((screen.getByLabelText('copy .env to linus-vault') as HTMLInputElement).checked).toBe(true);

  expect(screen.getAllByRole('button').filter((b) => b.closest('.acts'))).toHaveLength(1);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: VAULT, carry: ['.env'] });
  expect(store.getState().moveSheet).toBeUndefined();
  expect(screen.queryByTestId('move-sheet')).toBeNull();
});

test('a robot on main says its changes move to a new branch, and one asking a question that it asks again', async () => {
  answers = [{ ok: true, sheet: sheet({ credentialFiles: [], stays: ['node_modules is not carried'], question: true, converts: { main: '/Users/ada/svall', branch: 'kanban', changed: 3 } }) }];
  await open(VAULT);
  expect(screen.getByTestId('move-summary').textContent).toContain('node_modules is not carried');
  expect(screen.getByTestId('move-converts').textContent).toBe("your 3 changed files in svall's main checkout move to a new branch kanban");
  expect(screen.getByTestId('move-question').textContent).toBe('its open question is dropped; it asks again');
});

test('a refusal is one sentence and one button, with the rest behind details; the interrupt it asks for is chosen from it', async () => {
  answers = [
    { ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: ['svall-notes has no remote; push svall-notes to a remote first'] } },
    { ok: true, sheet: sheet({ interrupts: true }) },
  ];
  await open(VAULT);
  expect(screen.getByTestId('move-reason').textContent).toBe('ada is working');
  expect(screen.queryByTestId('move-summary')).toBeNull();
  expect(screen.getByTestId('move-details').textContent).toContain('push svall-notes to a remote first');
  const buttons = screen.getAllByRole('button').filter((b) => b.closest('.acts'));
  expect(buttons.map((b) => b.textContent)).toEqual(['Interrupt after this turn']);

  await act(async () => fireEvent.click(buttons[0]));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT, interruptAfterMs: 0 });
  expect((screen.getByLabelText('Interrupt after this turn') as HTMLInputElement).checked).toBe(true);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: VAULT, interruptAfterMs: 0 });
});

test('a command running in its shell is ended by the move once the user says so, and the box says so', async () => {
  answers = [{ ok: false, refusal: { reason: 'a command is running', action: INTERRUPT_ACTIONS.command, details: ['wait for it'] } }, { ok: true, sheet: sheet({ interrupts: true }) }];
  await open(VAULT);
  expect(screen.getByTestId('move-action').textContent).toBe('Move anyway and it ends');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT, interruptAfterMs: 0 });
  expect((screen.getByLabelText('a command is running; move anyway and it ends') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByLabelText('Interrupt after this turn')).toBeNull();
});

test('a refusal with a command to run opens a terminal there with it typed', async () => {
  answers = [{ ok: false, refusal: { reason: 'linus-vault runs claude 1.2.3, this Mac 1.2.4', action: 'update claude on linus-vault', run: 'claude update', details: [] } }];
  await open(VAULT);
  expect(screen.queryByTestId('move-details')).toBeNull();
  expect(screen.getByTestId('move-action').textContent).toBe('Open terminal');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(screen.queryByTestId('move-sheet')).toBeNull();
  expect(sent).toContainEqual({ type: 'host.list' });
  expect(store.getState().hostOpen).toBe(true);
  expect(store.getState().hostMachine).toBe('linus-vault');
  expect(store.getState().hostTerminal).toEqual({ run: 'claude update' });
});

test('a refusal with nothing to run checks again', async () => {
  answers = [{ ok: false, refusal: { reason: 'linus-vault is not reachable', action: 'try again when it is awake', details: [] } }, { ok: true, sheet: sheet() }];
  await open(VAULT);
  expect(screen.getByTestId('move-action').textContent).toBe('Check again');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(checks()).toHaveLength(2);
  expect(screen.getByTestId('move-summary')).toBeTruthy();
});

test('the way back asks about this Mac by the id the daemon gives itself', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  await open();
  expect(screen.getByTestId('move-title').textContent).toBe('Move ada to this Mac');
  expect(checks()).toEqual([{ id: 'c0', machine: HOME }]);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: HOME });
});

test('the way back of a working robot is refused, and the interrupt chosen from it moves the robot after its turn', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  answers = [{ ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } }, { ok: true, sheet: sheet({ interrupts: true }) }];
  await open();
  expect(screen.getByTestId('move-reason').textContent).toBe('ada is working');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: HOME, interruptAfterMs: 0 });
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: HOME, interruptAfterMs: 0 });
});

test('a move the daemon refuses after the sheet closed says why in a toast, whose Check again opens the sheet on it', async () => {
  call.mockImplementation((method: string) => (method === 'robot.moveTo'
    ? Promise.reject(new ApiError('refused', 'linus-vault runs claude 1.2.3, this Mac 1.2.4; update claude on linus-vault'))
    : Promise.resolve(method === 'robot.moveCheck' ? { ok: true, sheet: sheet() } : {})));
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(screen.queryByTestId('move-sheet')).toBeNull();
  const toast = store.getState().toast;
  expect(toast?.text).toBe('linus-vault runs claude 1.2.3, this Mac 1.2.4; update claude on linus-vault');
  expect(toast?.action?.label).toBe('Check again');
  await act(async () => toast!.action!.run());
  expect(store.getState().moveSheet).toEqual({ id: 'c0', to: VAULT });
  expect(screen.getByTestId('move-sheet')).toBeTruthy();
});

test('a move that fails for any other reason says why, with nothing to check again', async () => {
  call.mockImplementation((method: string) => (method === 'robot.moveTo'
    ? Promise.reject(new Error('svalld connection closed'))
    : Promise.resolve(method === 'robot.moveCheck' ? { ok: true, sheet: sheet() } : {})));
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(store.getState().toast).toEqual({ text: 'svalld connection closed', tone: 'error' });
});
