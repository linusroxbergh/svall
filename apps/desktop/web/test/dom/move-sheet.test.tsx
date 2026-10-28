// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError, INTERRUPT_ACTIONS, WORKTREE_ACTION, type MachineId, type MoveSheet as Sheet, type Moving, type Refusal, type SetupRow } from '@svall/protocol';
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
    if (method === 'machines.setup') return Promise.resolve({ rows: [] });
    return Promise.resolve({});
  });
});

const open = async (to?: MachineId) => {
  render(<MoveSheet />);
  await act(async () => store.getState().setMoveSheet({ id: 'c0', to }));
};

// robot.moveTo answers once `settle` is called with what it answers
function heldMove() {
  let settle!: (answer: { moveId: string } | Error) => void;
  const answer = new Promise<unknown>((resolve, reject) => { settle = (a) => (a instanceof Error ? reject(a) : resolve(a)); });
  call.mockImplementation((method: string) => {
    if (method === 'robot.moveTo') return answer;
    if (method === 'machines.setup') return Promise.resolve({ rows: [] });
    return Promise.resolve(method === 'robot.moveCheck' ? { ok: true, sheet: sheet() } : {});
  });
  return { settle: (a: { moveId: string } | Error) => act(async () => settle(a)) };
}
const mark = (moving?: Moving) => act(() => store.getState().applyPatch([moving ? { op: 'add', path: '/robots/c0/moving', value: moving } : { op: 'remove', path: '/robots/c0/moving' }]));
const MOVE = 'mv_0123456789';
// each line the running move shows, by its state
const lines = () => [...screen.getByTestId('move-steps').querySelectorAll('li')].map((li) => `${li.getAttribute('data-state')} ${li.lastElementChild!.textContent}`);
const bar = () => [...screen.getByTestId('move-bar').children].map((i) => i.getAttribute('data-state'));

test('the sheet says what travels in one line, re-asks with a ticked credential file, and Move starts the move', async () => {
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
  expect(screen.queryByTestId('move-summary')).toBeNull();
});

test('a running move shows one line per step as it gets there under a bar of six, and once through Done closes the sheet', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(lines()).toEqual(['doing Checking…', 'todo Rest ada', 'todo Pack branch and session', 'todo Carry to linus-vault', 'todo Land on linus-vault', 'todo Start ada there']);
  expect(bar()).toEqual(['doing', 'todo', 'todo', 'todo', 'todo', 'todo']);
  expect(screen.queryByTestId('move-action')).toBeNull();

  await mark({ id: MOVE, to: VAULT, phase: 'rest' });
  expect(lines().slice(0, 2)).toEqual(['done Checked', 'doing Resting ada…']);
  await mark({ id: MOVE, to: VAULT, phase: 'bundle' });
  expect(lines()[2]).toBe('doing Packing branch and session…');
  await mark({ id: MOVE, to: VAULT, phase: 'prepare' });
  expect(lines()[3]).toBe('doing Carrying to linus-vault…');
  await mark({ id: MOVE, to: VAULT, phase: 'commit' });
  expect(lines()[4]).toBe('doing Landing on linus-vault…');
  await mark({ id: MOVE, to: VAULT, phase: 'activate' });
  expect(lines()).toEqual(['done Checked', 'done Rested ada', 'done Packed branch and session', 'done Carried to linus-vault', 'done Landed on linus-vault', 'doing Starting ada there…']);
  expect(screen.getByTestId('move-bar').getAttribute('aria-valuenow')).toBe('5');
  // the mark goes before the move answers, and the last step stands meanwhile
  await mark();
  expect(lines().at(-1)).toBe('doing Starting ada there…');

  await move.settle({ moveId: MOVE });
  expect(lines().at(-1)).toBe('done Started ada there');
  expect(bar()).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  expect(screen.getByTestId('move-through').textContent).toBe('ada runs on linus-vault.');
  await act(async () => fireEvent.click(screen.getByTestId('move-done')));
  expect(store.getState().moveSheet).toBeUndefined();
});

test("once through on a worker the sheet says how much of the robot's agent setup will not work there", async () => {
  const gap = (name: string): SetupRow => ({ key: `oauth:claude:mcp:${name}`, status: 'warn', detail: 'd', action: 'log in once on linus-vault', gap: { name, what: 'not logged in' } });
  const rows = [gap('linear'), gap('notion'), { key: 'var:X', status: 'ok', detail: 'X is set on linus-vault' } satisfies SetupRow];
  const move = heldMove();
  const held = call.getMockImplementation()!;
  call.mockImplementation((method: string, params?: unknown) => (method === 'machines.setup' ? Promise.resolve({ rows }) : held(method, params)));
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call.mock.calls.some(([m]) => m === 'machines.setup')).toBe(false);
  await move.settle({ moveId: MOVE });
  expect(call).toHaveBeenCalledWith('machines.setup', { machine: VAULT, robot: 'c0' });
  expect(screen.getByTestId('move-through').textContent).toBe('ada runs on linus-vault. 2 parts of its agent setup will not work there.');
});

test('a move undone before its commit says in one sentence which step failed, with details, and Try again moves again', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'prepare' });
  await mark();
  await move.settle(new ApiError('not_reachable', 'linus-vault is not reachable', { phase: 'prepare', moveId: MOVE }));
  expect(lines()).toEqual(['done Checked', 'done Rested ada', 'done Packed branch and session', 'failed Carry failed: linus-vault is not reachable; ada is back on this Mac.']);
  expect(bar()).toEqual(['done', 'done', 'done', 'failed', 'todo', 'todo']);
  expect(screen.getByTestId('move-run-details').textContent).toContain(`move ${MOVE}`);
  expect(screen.getByTestId('move-action').textContent).toBe('Try again');

  heldMove();
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(call.mock.calls.filter(([m]) => m === 'robot.moveTo')).toHaveLength(2);
  expect(lines()[0]).toBe('doing Checking…');
});

test('a move stalled after its commit names its step from the robot\'s mark, and Retry runs that step again', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'activate', error: 'claude exited back to its shell' });
  await move.settle({ moveId: MOVE });
  expect(lines().at(-1)).toBe('failed Start failed: claude exited back to its shell.');
  expect(screen.getByTestId('move-run-details').textContent).toBe(`detailsmove ${MOVE}`);
  expect(screen.getByTestId('move-action').textContent).toBe('Retry');

  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(call).toHaveBeenCalledWith('robot.moveRetry', { moveId: MOVE });
  await mark();
  expect(screen.getByTestId('move-through').textContent).toBe('ada runs on linus-vault.');
});

test('a move the daemon refuses at its own check fails at Check, and Check again shows the sheet\'s check', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await move.settle(new ApiError('refused', 'ada is working; interrupt after this turn', { refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } }));
  expect(lines()).toEqual(['failed Check failed: ada is working; interrupt after this turn.']);
  expect(screen.queryByTestId('move-run-details')).toBeNull();
  answers = [{ ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } }];
  call.mockImplementation((method: string) => Promise.resolve(method === 'robot.moveCheck' ? answers[0] : {}));
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(screen.queryByTestId('move-steps')).toBeNull();
  expect(screen.getByTestId('move-reason').textContent).toBe('ada is working');
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

test('a robot sharing a main checkout is offered its own worktree, and the sheet says the checkout keeps its changes', async () => {
  answers = [
    { ok: false, refusal: { reason: "two robots share svall's main checkout", action: WORKTREE_ACTION, details: [] } },
    { ok: true, sheet: sheet({ changedFiles: 0, credentialFiles: [], stays: [], converts: { main: '/Users/ada/svall', branch: 'ada', changed: 3, keep: true } }) },
  ];
  await open(VAULT);
  expect(screen.getByTestId('move-reason').textContent).toBe("two robots share svall's main checkout");
  expect(screen.getByTestId('move-action').textContent).toBe('Give it its own worktree');

  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT, ownWorktree: true });
  expect(screen.getByTestId('move-converts').textContent).toBe("it leaves svall's main checkout for a new branch ada; the checkout keeps its 3 changed files");
  expect((screen.getByLabelText('Give it its own worktree') as HTMLInputElement).checked).toBe(true);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: VAULT, ownWorktree: true });
});

test('unticking its own worktree asks again without it', async () => {
  answers = [
    { ok: false, refusal: { reason: "two robots share svall's main checkout", action: WORKTREE_ACTION, details: [] } },
    { ok: true, sheet: sheet({ converts: { main: '/Users/ada/svall', branch: 'ada', changed: 0, keep: true } }) },
    { ok: false, refusal: { reason: "two robots share svall's main checkout", action: WORKTREE_ACTION, details: [] } },
  ];
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  await act(async () => fireEvent.click(screen.getByLabelText('Give it its own worktree')));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT });
  expect(screen.getByTestId('move-action').textContent).toBe('Give it its own worktree');
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
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await act(async () => fireEvent.click(screen.getByTestId('move-close')));
  expect(screen.queryByTestId('move-sheet')).toBeNull();
  await move.settle(new ApiError('refused', 'linus-vault runs claude 1.2.3, this Mac 1.2.4; update claude on linus-vault'));
  const toast = store.getState().toast;
  expect(toast?.text).toBe('linus-vault runs claude 1.2.3, this Mac 1.2.4; update claude on linus-vault');
  expect(toast?.action?.label).toBe('Check again');
  await act(async () => toast!.action!.run());
  expect(store.getState().moveSheet).toEqual({ id: 'c0', to: VAULT });
  expect(screen.getByTestId('move-sheet')).toBeTruthy();
});

test('a move that fails for any other reason after the sheet closed says why, with nothing to check again', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await act(async () => fireEvent.click(screen.getByTestId('move-close')));
  await move.settle(new Error('svalld connection closed'));
  expect(store.getState().toast).toEqual({ text: 'svalld connection closed', tone: 'error' });
});
