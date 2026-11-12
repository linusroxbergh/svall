// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError, type MachineId, type SetupRow } from '@svall/protocol';
import { call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { OnMachine } = await import('../../src/OnMachine.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const linear: SetupRow = {
  key: 'claude:mcp:linear', status: 'warn', detail: 'd', action: "copy linear's keys to vault",
  tick: { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: false, preview: ['env.LINEAR_API_KEY lin…90'], ticked: [] }, gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
};
const notion: SetupRow = {
  key: 'oauth:claude:mcp:notion', status: 'warn', detail: 'then /mcp and sign in to notion', action: 'log in once on vault', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118,
  gap: { name: 'notion', what: 'not logged in' },
};
const chrome: SetupRow = { key: 'maconly:claude:chrome', status: 'skip', detail: 'chrome only runs on a Mac; not mirrored', gap: { name: 'chrome', what: 'runs only on a Mac' } };
let rows: SetupRow[] = [];

beforeEach(() => {
  freshStore();
  rows = [linear, notion, { key: 'var:X', status: 'ok', detail: 'X is set on vault' }, chrome];
  call.mockImplementation((method: string) => Promise.resolve(method === 'machines.setup' || method === 'machines.consent' ? { rows } : {}));
});

const shown = () => [...document.querySelectorAll('[data-section="robot.machine"] .side-gap')].map((e) => e.textContent);
// the section starts folded
const unfold = () => fireEvent.click(screen.getByTestId('sec-fold-robot.machine'));

test('a placed robot\'s card lists what of its agent setup will not work on its machine, each with its one way on', async () => {
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  expect(call).toHaveBeenCalledWith('machines.setup', { machine: VAULT, robot: 'c1' });
  expect(screen.getByTestId('sec-fold-robot.machine').textContent).toBe('On vault');
  expect(shown()).toEqual([]);
  unfold();
  expect(shown()).toEqual(["linear's LINEAR_API_KEY not copiedCopy key", 'notion not logged inLog in', 'chrome runs only on a Mac.']);
  expect(screen.getByTestId('side-gap-claude:mcp:linear').querySelector('b')!.textContent).toBe("linear's LINEAR_API_KEY");
  expect(screen.getByTestId('side-gap-aside').textContent).toBe('chrome runs only on a Mac.');

  rows = [notion, chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-copy-claude:mcp:linear')); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: VAULT, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(2);
  expect(shown()).toEqual(['notion not logged inLog in', 'chrome runs only on a Mac.']);

  fireEvent.click(screen.getByTestId('side-gap-terminal-oauth:claude:mcp:notion'));
  expect(sent).toContainEqual({ type: 'host.list' });
  expect([store.getState().hostMachine, store.getState().hostTerminal]).toEqual(['vault', { run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 }]);
  // the login made there shows once the panel closes
  rows = [chrome];
  await act(async () => store.getState().toggleHost(false));
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(3);
  expect(shown()).toEqual(['chrome runs only on a Mac.']);
});

test('a copy the machine did not take says why, and a robot whose agent setup all works there shows no section', async () => {
  call.mockImplementation((method: string) => (method === 'machines.consent' ? Promise.reject(new ApiError('not_mirrored', 'Saved; vault has not taken it yet', { raw: 'ENOSPC: no space left on device' }))
    : Promise.resolve({ rows })));
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  // the saved tick shows, as the rows are read again
  rows = [{ key: linear.key, status: 'warn', detail: 'd', tick: { ...linear.tick!, on: true }, gap: { name: 'linear', what: 'ticked; not on vault yet' } }, notion, chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-copy-claude:mcp:linear')); });
  expect(store.getState().toast).toMatchObject({ text: 'Saved; vault has not taken it yet', raw: 'ENOSPC: no space left on device', tone: 'error' });
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(2);
  expect(shown()[0]).toBe('linear ticked; not on vault yet');

  rows = [{ key: 'var:X', status: 'ok', detail: 'X is set on vault' }];
  const { container } = await act(async () => render(<OnMachine id="c2" machine={VAULT} name="vault" />));
  expect(container.innerHTML).toBe('');
});

test('a row whose way on is its action says it, and one whose copy is still there offers no copy', async () => {
  const still: SetupRow = { ...linear, key: 'claude:mcp:jira', action: 'check vault again', gap: { name: 'jira', what: 'unticked; still on vault' } };
  const db: SetupRow = { key: 'runtime:/Users/ada/bin/db-mcp', status: 'warn', detail: 'd', action: 'install db-mcp on vault', gap: { name: 'db-mcp', what: 'not installed; db needs it' } };
  rows = [still, db];
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  expect(shown()).toEqual(['jira unticked; still on vaultcheck vault again', 'db-mcp not installed; db needs itinstall db-mcp on vault']);
  expect(screen.queryByTestId('side-gap-copy-claude:mcp:jira')).toBeNull();
});

test('a program row offers Not needed, which ticks it; ticked, it joins the one line of what stands aside', async () => {
  const skip = (on: boolean): SetupRow => ({
    key: 'runtime:adlc', status: on ? 'skip' : 'warn', detail: 'd', ...(!on && { action: 'install adlc on vault' }),
    tick: { item: 'runtime:adlc', fields: ['skip'], on, preview: [] }, gap: on ? { name: 'adlc', what: 'not needed there, you ticked' } : { name: 'adlc', what: 'not installed; ad needs it' },
  });
  const npx: SetupRow = { ...skip(false), key: 'runtime:npx', run: 'sudo apt install nodejs npm', action: 'install npx on vault', tick: { item: 'runtime:npx', fields: ['skip'], on: false, preview: [] }, gap: { name: 'npx', what: 'not installed; ad needs it' } };
  rows = [skip(false), npx, chrome];
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  expect(shown()).toEqual(['adlc not installedNot needed', 'npx not installedInstallNot needed', 'chrome runs only on a Mac.']);
  rows = [skip(true), chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-skip-runtime:adlc')); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: VAULT, item: 'runtime:adlc', fields: ['skip'], on: true });
  expect(shown()).toEqual(['chrome runs only on a Mac, and adlc is not needed there.']);
});

test('a variable row on the card takes its value in a field and sends it, or copies this Mac\'s, and the rows come back as the machine has them', async () => {
  const x: SetupRow = { key: 'var:X', status: 'warn', detail: 'd', action: 'set X on vault', run: 'svall worker env X', gap: { name: 'X', what: 'not set; ad reads it' }, here: true };
  rows = [x, chrome];
  // the set answers the whole machine's rows; the card reads this robot's own again
  call.mockImplementation((method: string) => Promise.resolve(method === 'machines.setVar' ? { rows: [{ key: 'var:X', status: 'ok', detail: 'X is set on vault' }, linear, chrome] } : { rows }));
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  expect(screen.getByTestId('side-gap-var:X').firstElementChild!.textContent).toBe('X not set');
  expect(screen.queryByTestId('side-gap-terminal-var:X')).toBeNull();
  fireEvent.change(screen.getByTestId('side-gap-var-var:X-value'), { target: { value: 'v1' } });
  rows = [chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-var-var:X-set')); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: VAULT, name: 'X', value: 'v1' });
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(2);
  expect(shown()).toEqual(['chrome runs only on a Mac.']);

  rows = [x];
  call.mockImplementation((method: string) => (method === 'machines.setVar' ? Promise.reject(new Error('this Mac has no X')) : Promise.resolve({ rows })));
  await act(async () => { render(<OnMachine id="c2" machine={VAULT} name="vault" />); });
  await act(async () => { fireEvent.click(screen.getAllByTestId('side-gap-var-var:X-copy').at(-1)!); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: VAULT, name: 'X', fromMac: true });
  expect(store.getState().toast).toMatchObject({ text: 'this Mac has no X', tone: 'error' });
});

test('while its machine is not reachable, what needs the machine waits and says why, and a copy is still saved for when it answers', async () => {
  const x: SetupRow = { key: 'var:X', status: 'warn', detail: 'd', action: 'set X on vault', run: 'svall worker env X', gap: { name: 'X', what: 'not set; ad reads it' }, here: true };
  rows = [linear, notion, x];
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" away="vault is not reachable" />); });
  unfold();
  fireEvent.change(screen.getByTestId('side-gap-var-var:X-value'), { target: { value: 'v1' } });
  const state = (t: string) => { const b = screen.getByTestId(t) as HTMLButtonElement; return [b.textContent, b.disabled, b.dataset.tip]; };
  expect(['side-gap-terminal-oauth:claude:mcp:notion', 'side-gap-var-var:X-set', 'side-gap-var-var:X-copy'].map(state)).toEqual([
    ['Log in', true, 'vault is not reachable'], ['Set on vault', true, 'vault is not reachable'], ['Copy from this Mac', true, 'vault is not reachable'],
  ]);
  fireEvent.submit(screen.getByTestId('side-gap-var-var:X'));
  expect(call).not.toHaveBeenCalledWith('machines.setVar', expect.anything());
  expect((screen.getByTestId('side-gap-copy-claude:mcp:linear') as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-copy-claude:mcp:linear')); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: VAULT, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
});

test('a variable row copies from the home: this Mac on the home, and by its name in a window on a worker', async () => {
  rows = [{ key: 'var:X', status: 'warn', detail: 'd', action: 'set X on vault', run: 'svall worker env X', gap: { name: 'X', what: 'not set; ad reads it' }, here: true }];
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  const copy = screen.getByTestId('side-gap-var-var:X-copy');
  expect([copy.textContent, copy.dataset.tip]).toEqual(['Copy from this Mac', 'This Mac has X; its value goes to vault without being shown']);
  act(() => store.getState().setVia({ machine: VAULT, home: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId, name: 'studio', online: true }));
  expect([copy.textContent, copy.dataset.tip]).toEqual(['Copy from studio', 'studio has X; its value goes to vault without being shown']);
});
