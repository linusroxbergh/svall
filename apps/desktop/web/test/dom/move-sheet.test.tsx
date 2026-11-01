// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError, INTERRUPT_ACTIONS, UPGRADE_ACTION, WORKTREE_ACTION, type MachineId, type MoveSheet as Sheet, type Moving, type Refusal, type SetupRow } from '@svall/protocol';
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

test('the sheet says it is ready and what travels, a line each, re-asks with a ticked credential file, and Move starts the move', async () => {
  await open(VAULT);
  expect(screen.getByTestId('move-title').textContent).toBe('Move ada to linus-vault');
  expect(screen.getByTestId('move-ready').textContent).toBe('Ready to move');
  expect([...screen.getByTestId('move-summary').children].map((li) => li.textContent))
    .toEqual(['session 4 MB', 'branch kanban-board: 2 commits not on origin, 3 changed files', 'svall on linus-vault: will clone (first time)']);
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

test('while it checks, the sheet says what it checks', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/agent', value: { kind: 'claude', sessionId: 's1', status: 'idle' } }]));
  call.mockImplementation((method: string) => (method === 'robot.moveCheck' ? new Promise(() => {}) : Promise.resolve({})));
  await open(VAULT);
  expect(screen.getByTestId('move-checking').querySelector('.move-state')!.textContent).toBe('Checking that ada can move…');
  expect([...screen.getByTestId('move-checking').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    "linus-vault is reachable and on this Mac's release", 'Claude Code is installed, current and logged in on linus-vault', 'its branch, changes and session can travel',
  ]);
});

test("on the way back, the sheet checks that the machine it is on answers and this Mac's agent", async () => {
  act(() => store.getState().applyPatch([
    { op: 'add', path: '/robots/c0/machine', value: VAULT },
    { op: 'add', path: '/robots/c0/agent', value: { kind: 'claude', sessionId: 's1', status: 'idle' } },
  ]));
  call.mockImplementation((method: string) => (method === 'robot.moveCheck' ? new Promise(() => {}) : method === 'system.info' ? Promise.resolve({ machineId: HOME }) : Promise.resolve({})));
  await open();
  expect([...screen.getByTestId('move-checking').querySelectorAll('li')].map((li) => li.textContent))
    .toEqual(['linus-vault is reachable', 'Claude Code is installed, current and logged in on this Mac', 'its branch, changes and session can travel']);
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

test('a Retry shows the step running again, and one that fails again shows its new failure with no toast, Retry still offered', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'activate', error: 'claude exited back to its shell' });
  await move.settle({ moveId: MOVE });
  let fail!: (e: Error) => void;
  call.mockImplementation((method: string) => (method === 'robot.moveRetry' ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve({})));
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(lines().at(-1)).toBe('doing Starting ada there…');

  await mark({ id: MOVE, to: VAULT, phase: 'activate', error: 'claude exited back to its shell again' });
  await act(async () => fail(new ApiError('failed', 'claude exited back to its shell again')));
  expect(lines().at(-1)).toBe('failed Start failed: claude exited back to its shell again.');
  expect(store.getState().toast).toBeUndefined();
  expect(screen.getByTestId('move-action').textContent).toBe('Retry');
});

test('a Retry refused for a reason the robot\'s mark does not hold says that reason, Retry still offered', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'activate', error: 'claude exited back to its shell' });
  await move.settle({ moveId: MOVE });
  call.mockImplementation((method: string) => (method === 'robot.moveRetry' ? Promise.reject(new Error('svalld connection closed')) : Promise.resolve({})));
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(lines().at(-1)).toBe('failed Start failed: svalld connection closed.');
  expect(screen.getByTestId('move-action').textContent).toBe('Retry');
  // a mark that says more since is what stands
  await mark({ id: MOVE, to: VAULT, phase: 'activate', error: 'claude exited back to its shell again' });
  expect(lines().at(-1)).toBe('failed Start failed: claude exited back to its shell again.');
});

test('a move whose answer is lost before any mark of it came goes on at its check until a mark or the robot\'s arrival says how it went', async () => {
  const gap: SetupRow = { key: 'oauth:claude:mcp:linear', status: 'warn', detail: 'd', action: 'log in once on linus-vault', gap: { name: 'linear', what: 'not logged in' } };
  const move = heldMove();
  const held = call.getMockImplementation()!;
  call.mockImplementation((method: string, params?: unknown) => (method === 'machines.setup' ? Promise.resolve({ rows: [gap] }) : held(method, params)));
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await move.settle(new Error('svalld connection closed'));
  expect(lines()[0]).toBe('doing Checking…');
  expect(screen.queryByTestId('move-action')).toBeNull();

  await act(async () => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  expect(screen.getByTestId('move-through').textContent).toBe('ada runs on linus-vault. 1 part of its agent setup will not work there.');
  expect(call.mock.calls.filter(([m]) => m === 'robot.moveTo')).toHaveLength(1);
});

test('a move whose answer is lost with the link to svalld goes on by the robot\'s mark, and is through once the mark goes with the robot there', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'prepare' });
  await move.settle(new Error('svalld connection closed'));
  expect(lines()[3]).toBe('doing Carrying to linus-vault…');
  expect(screen.queryByTestId('move-action')).toBeNull();

  await mark({ id: MOVE, to: VAULT, phase: 'activate' });
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  await mark();
  expect(screen.getByTestId('move-through').textContent).toBe('ada runs on linus-vault.');
  expect(call.mock.calls.filter(([m]) => m === 'robot.moveTo')).toHaveLength(1);
});

test('a move whose answer is lost with the link to svalld, and whose mark goes with the robot still here, failed at the step it reached', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: VAULT, phase: 'prepare' });
  await move.settle(new Error('svalld connection closed'));
  await mark();
  expect(lines().at(-1)).toBe('failed Carry failed: svalld connection closed; ada is back on this Mac.');
  expect(screen.getByTestId('move-action').textContent).toBe('Try again');
});

test('a move back names its steps where they happen: the worker packs and carries, this Mac lands', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  await open();
  const move = heldMove();
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await mark({ id: MOVE, to: HOME, phase: 'bundle' });
  expect(lines()[2]).toBe('doing Packing branch and session…');
  await mark({ id: MOVE, to: HOME, phase: 'prepare' });
  expect(lines().slice(2, 5)).toEqual(['done Packed branch and session', 'done Carried to this Mac', 'doing Landing on this Mac…']);

  await mark();
  await move.settle(new ApiError('refused', 'changes on this Mac in /Users/ada/svall since the move; stash or commit them', { phase: 'prepare', moveId: MOVE }));
  expect(lines().at(-1)).toBe('failed Land failed: changes on this Mac in /Users/ada/svall since the move; stash or commit them; ada is back on linus-vault.');
});

test('the focus stays in the sheet while a move runs: on its × once Move goes, then on the button the move ends with', async () => {
  const move = heldMove();
  await open(VAULT);
  screen.getByTestId('move-go').focus();
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(document.activeElement).toBe(screen.getByTestId('move-close'));
  await move.settle({ moveId: MOVE });
  expect(document.activeElement).toBe(screen.getByTestId('move-done'));
});

test('a move the daemon refuses at its own check fails at Check, and Check again shows the sheet\'s check', async () => {
  const move = heldMove();
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  await move.settle(new ApiError('refused', 'ada is working; interrupt it now', { refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } }));
  expect(lines()).toEqual(['failed Check failed: ada is working; interrupt it now.']);
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

test('a refusal is one sentence, what to do and one button, with its details behind it', async () => {
  answers = [
    { ok: false, refusal: { reason: 'linus-vault is not reachable', action: 'try again when it is awake', details: ['svall-notes has no remote; push svall-notes to a remote first'] } },
    { ok: true, sheet: sheet() },
  ];
  await open(VAULT);
  expect(screen.getByTestId('move-refusal').textContent).toContain('linus-vault is not reachabletry again when it is awake');
  expect(screen.queryByTestId('move-summary')).toBeNull();
  expect(screen.getByTestId('move-details').textContent).toContain('push svall-notes to a remote first');
  expect(screen.getAllByRole('button').filter((b) => b.closest('.acts')).map((b) => b.textContent)).toEqual(['Check again']);
});

test('every check a move failed shows at once, each with its own button, and one Check again for the ones without', async () => {
  answers = [{
    ok: false,
    refusal: {
      reason: 'linus-vault runs 0.20.0, this Mac 0.21.0', action: UPGRADE_ACTION, details: ['wait for it'],
      more: [{ reason: 'linus-vault runs claude 1.2.3, this Mac 1.2.4', action: 'update claude on linus-vault', run: 'claude update' }, { reason: 'ada is on a detached HEAD', action: 'check out a branch first' }],
    },
  }];
  await open(VAULT);
  expect(screen.getByTestId('move-refusal').textContent).toBe('linus-vault runs 0.20.0, this Mac 0.21.0detailswait for it');
  expect(screen.getByTestId('move-refusal-1').textContent).toBe('linus-vault runs claude 1.2.3, this Mac 1.2.4');
  expect(screen.getByTestId('move-refusal-2').textContent).toBe('ada is on a detached HEADcheck out a branch first');
  expect([...document.querySelectorAll('.modal button.btn')].map((b) => b.textContent)).toEqual(['Upgrade linus-vault', 'Update Claude Code', 'Check again']);
  await act(async () => fireEvent.click(screen.getByTestId('move-action-1')));
  expect(call).toHaveBeenCalledWith('machines.updateAgents', { machine: VAULT, kinds: ['claude'] });
  // the update done, the checks run again
  expect(checks()).toHaveLength(2);
});

test('a shared main checkout second in the list still takes its own worktree in the one sheet', async () => {
  answers = [
    { ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [], more: [{ reason: "two robots share svall's main checkout", action: WORKTREE_ACTION }] } },
    { ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } },
    { ok: true, sheet: sheet({ interrupts: true, converts: { main: '/Users/ada/svall', branch: 'ada', changed: 0, keep: true } }) },
  ];
  await open(VAULT);
  expect(checks()).toEqual([{ id: 'c0', machine: VAULT }, { id: 'c0', machine: VAULT, ownWorktree: true }, { id: 'c0', machine: VAULT, interruptAfterMs: 0, ownWorktree: true }]);
  expect(screen.queryByTestId('move-refusal')).toBeNull();
  expect((screen.getByLabelText(/^Give it its own worktree/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(/^Interrupt it now/) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByLabelText(/^Give it its own worktree/).closest('label')!.querySelector('.modal-sub')!.textContent).toBe("two robots share svall's main checkout");
});

test('a working robot is interrupted at once from the one sheet, whose box says why; unticked, the move refuses with the interrupt as its button', async () => {
  const working: Refusal = { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] };
  answers = [{ ok: false, refusal: working }, { ok: true, sheet: sheet({ interrupts: true }) }, { ok: false, refusal: working }];
  await open(VAULT);
  expect(checks()).toEqual([{ id: 'c0', machine: VAULT }, { id: 'c0', machine: VAULT, interruptAfterMs: 0 }]);
  expect(screen.queryByTestId('move-refusal')).toBeNull();
  await act(async () => fireEvent.click(screen.getByLabelText(/^Interrupt it now/)));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT });
  // the button says what to do, so no line does
  expect(screen.getByTestId('move-refusal').textContent).toBe('ada is working');
  expect(screen.getByTestId('move-action').textContent).toBe('Interrupt it now');
  answers = [{ ok: true, sheet: sheet({ interrupts: true }) }];
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  await act(async () => fireEvent.click(screen.getByTestId('move-go')));
  expect(call).toHaveBeenCalledWith('robot.moveTo', { id: 'c0', machine: VAULT, interruptAfterMs: 0 });
});

test('a command running in its shell is ended by the move, as its box says', async () => {
  answers = [{ ok: false, refusal: { reason: 'a command is running', action: INTERRUPT_ACTIONS.command, details: ['wait for it'] } }, { ok: true, sheet: sheet({ interrupts: true }) }];
  await open(VAULT);
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT, interruptAfterMs: 0 });
  expect((screen.getByLabelText(/^Move anyway and end it/) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByLabelText(/^Interrupt it now/)).toBeNull();
});

test('a robot sharing a main checkout gets its own worktree in the one sheet, which says why and that the checkout keeps its changes', async () => {
  answers = [
    { ok: false, refusal: { reason: "two robots share svall's main checkout", action: WORKTREE_ACTION, details: [] } },
    { ok: true, sheet: sheet({ changedFiles: 0, credentialFiles: [], stays: [], converts: { main: '/Users/ada/svall', branch: 'ada', changed: 3, keep: true } }) },
  ];
  await open(VAULT);
  expect(checks()).toEqual([{ id: 'c0', machine: VAULT }, { id: 'c0', machine: VAULT, ownWorktree: true }]);
  expect(screen.queryByTestId('move-refusal')).toBeNull();
  expect(screen.getByTestId('move-converts').textContent).toBe("it leaves svall's main checkout for a new branch ada; the checkout keeps its 3 changed files");
  expect((screen.getByLabelText(/^Give it its own worktree/) as HTMLInputElement).checked).toBe(true);
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
  await act(async () => fireEvent.click(screen.getByLabelText(/^Give it its own worktree/)));
  expect(checks().at(-1)).toEqual({ id: 'c0', machine: VAULT });
  expect(screen.getByTestId('move-action').textContent).toBe('Give it its own worktree');
});

test('a refusal with a command to run opens a terminal there with it typed, over the sheet, which checks again once it closes', async () => {
  answers = [{ ok: false, refusal: { reason: 'claude is not logged in on linus-vault', action: 'log claude in there', run: 'claude auth login', details: [] } }, { ok: true, sheet: sheet() }];
  await open(VAULT);
  expect(screen.getByTestId('move-blocked').textContent).toBe('Not ready to move yet');
  expect(screen.queryByTestId('move-details')).toBeNull();
  expect(screen.getByTestId('move-action').textContent).toBe('Open terminal');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(screen.getByTestId('move-sheet')).toBeTruthy();
  expect(sent).toContainEqual({ type: 'host.list' });
  expect(store.getState().hostOpen).toBe(true);
  expect(store.getState().hostMachine).toBe('linus-vault');
  expect(store.getState().hostTerminal).toEqual({ run: 'claude auth login' });
  expect(checks()).toHaveLength(1);

  await act(async () => store.getState().toggleHost(false));
  expect(checks()).toHaveLength(2);
  expect(screen.getByTestId('move-ready')).toBeTruthy();
});

test('an agent older there is updated from the sheet, which says so and then checks again; an update that fails says why', async () => {
  const older: Refusal = { reason: 'linus-vault runs claude 1.2.3, this Mac 1.2.4', action: 'update claude on linus-vault', run: 'claude update', details: [] };
  answers = [{ ok: false, refusal: older }, { ok: true, sheet: sheet() }];
  let finish!: (e?: Error) => void;
  const base = call.getMockImplementation()!;
  call.mockImplementation((method: string, p: unknown) => (method === 'machines.updateAgents'
    ? new Promise((resolve, reject) => { finish = (e) => (e ? reject(e) : resolve({})); }) : base(method, p)));
  await open(VAULT);
  expect(screen.getByTestId('move-action').textContent).toBe('Update Claude Code');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(call).toHaveBeenCalledWith('machines.updateAgents', { machine: VAULT, kinds: ['claude'] });
  expect(screen.getByTestId('move-fixing').textContent).toBe('Updating Claude Code on linus-vault…');
  expect(store.getState().hostOpen).toBe(false);

  await act(async () => finish(new Error('claude update exited 1: no network')));
  expect(screen.getByTestId('move-fix-failed').textContent).toBe('claude update exited 1: no network');
  expect(checks()).toHaveLength(1);

  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  await act(async () => finish());
  expect(checks()).toHaveLength(2);
  expect(screen.getByTestId('move-summary')).toBeTruthy();
});

test('a machine on another release is upgraded from the sheet, which follows its steps and checks again once it ran through', async () => {
  answers = [{ ok: false, refusal: { reason: 'linus-vault runs 0.20.0, this Mac 0.21.0', action: UPGRADE_ACTION, details: [] } }, { ok: true, sheet: sheet() }];
  await open(VAULT);
  expect(screen.getByTestId('move-action').textContent).toBe('Upgrade linus-vault');
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: 'linus-vault' } });
  expect(screen.getByTestId('move-fixing').textContent).toBe('Upgrading linus-vault…');
  await act(async () => store.getState().hostStep('upgrade', { step: 'upload', status: 'start' }));
  expect(screen.getByTestId('move-fixing').textContent).toBe('Upgrading linus-vault: Upload…');
  expect(checks()).toHaveLength(1);

  // through, with something left to do there, which the check says if a move needs it
  await act(async () => store.getState().hostStep('upgrade', { step: 'claude', status: 'warn', action: 'claude auth login' }));
  await act(async () => store.getState().hostDone('upgrade', 1));
  expect(checks()).toHaveLength(2);
  expect(screen.getByTestId('move-summary')).toBeTruthy();
});

test('an upgrade that fails says how it ended and offers the upgrade again', async () => {
  answers = [{ ok: false, refusal: { reason: 'linus-vault runs 0.20.0, this Mac 0.21.0', action: UPGRADE_ACTION, details: [] } }];
  await open(VAULT);
  await act(async () => fireEvent.click(screen.getByTestId('move-action')));
  await act(async () => store.getState().hostStep('upgrade', { step: 'upload', status: 'fail', detail: 'no space left' }));
  await act(async () => store.getState().hostDone('upgrade', 1));
  expect(screen.getByTestId('move-fix-failed').textContent).toBe('Upgrade stopped at Upload: no space left');
  expect(screen.getByTestId('move-action').textContent).toBe('Upgrade linus-vault');
  expect(checks()).toHaveLength(1);
});

test('a refusal with nothing to run checks again', async () => {
  answers = [{ ok: false, refusal: { reason: 'linus-vault is not reachable', action: 'try again when it is awake', details: [] } }, { ok: true, sheet: sheet() }];
  await open(VAULT);
  expect(screen.getByTestId('move-again').textContent).toBe('Check again');
  await act(async () => fireEvent.click(screen.getByTestId('move-again')));
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

test('the way back of a working robot interrupts it at once', async () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  answers = [{ ok: false, refusal: { reason: 'ada is working', action: INTERRUPT_ACTIONS.agent, details: [] } }, { ok: true, sheet: sheet({ interrupts: true }) }];
  await open();
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
