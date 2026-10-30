// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId, SetupRow } from '@svall/protocol';
import { call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { OnMachine } = await import('../../src/OnMachine.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const linear: SetupRow = {
  key: 'claude:mcp:linear', status: 'warn', detail: 'd', action: "copy linear's keys to vault",
  tick: { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: false, preview: ['env.LINEAR_API_KEY lin…90'] }, gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
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
  expect(shown()).toEqual(['linear keys not copied (env.LINEAR_API_KEY)Copy keys', 'notion not logged inOpen terminal', 'chrome runs only on a Mac']);
  expect(screen.getByTestId('side-gap-aside').textContent).toBe('chrome runs only on a Mac');

  rows = [notion, chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-copy-claude:mcp:linear')); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: VAULT, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(2);
  expect(shown()).toEqual(['notion not logged inOpen terminal', 'chrome runs only on a Mac']);

  fireEvent.click(screen.getByTestId('side-gap-terminal-oauth:claude:mcp:notion'));
  expect(sent).toContainEqual({ type: 'host.list' });
  expect([store.getState().hostMachine, store.getState().hostTerminal]).toEqual(['vault', { run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 }]);
  // the login made there shows once the panel closes
  rows = [chrome];
  await act(async () => store.getState().toggleHost(false));
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(3);
  expect(shown()).toEqual(['chrome runs only on a Mac']);
});

test('a copy the machine did not take says why, and a robot whose agent setup all works there shows no section', async () => {
  call.mockImplementation((method: string) => (method === 'machines.consent' ? Promise.reject(new Error('the change is saved, but vault did not take it: ENOSPC'))
    : Promise.resolve({ rows })));
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-copy-claude:mcp:linear')); });
  expect(store.getState().toast).toMatchObject({ text: 'the change is saved, but vault did not take it: ENOSPC', tone: 'error' });

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
  expect(shown()).toEqual(['adlc not installed; ad needs itinstall adlc on vaultNot needed', 'npx not installed; ad needs itOpen terminalNot needed', 'chrome runs only on a Mac']);
  rows = [skip(true), chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-skip-runtime:adlc')); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: VAULT, item: 'runtime:adlc', fields: ['skip'], on: true });
  expect(shown()).toEqual(['chrome runs only on a Mac, and adlc is not needed there']);
});

test('a variable row on the card takes its value in a field and sends it, or copies this Mac\'s, and the rows come back as the machine has them', async () => {
  const x: SetupRow = { key: 'var:X', status: 'warn', detail: 'd', action: 'set X on vault', run: 'svall worker env X', gap: { name: 'X', what: 'not set; ad reads it' }, here: true };
  rows = [x, chrome];
  // the set answers the whole machine's rows; the card reads this robot's own again
  call.mockImplementation((method: string) => Promise.resolve(method === 'machines.setVar' ? { rows: [{ key: 'var:X', status: 'ok', detail: 'X is set on vault' }, linear, chrome] } : { rows }));
  await act(async () => { render(<OnMachine id="c1" machine={VAULT} name="vault" />); });
  unfold();
  expect(screen.queryByTestId('side-gap-terminal-var:X')).toBeNull();
  fireEvent.change(screen.getByTestId('side-gap-var-var:X-value'), { target: { value: 'v1' } });
  rows = [chrome];
  await act(async () => { fireEvent.click(screen.getByTestId('side-gap-var-var:X-set')); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: VAULT, name: 'X', value: 'v1' });
  expect(call.mock.calls.filter(([m]) => m === 'machines.setup')).toHaveLength(2);
  expect(shown()).toEqual(['chrome runs only on a Mac']);

  rows = [x];
  call.mockImplementation((method: string) => (method === 'machines.setVar' ? Promise.reject(new Error('this Mac has no X')) : Promise.resolve({ rows })));
  await act(async () => { render(<OnMachine id="c2" machine={VAULT} name="vault" />); });
  await act(async () => { fireEvent.click(screen.getAllByTestId('side-gap-var-var:X-copy').at(-1)!); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: VAULT, name: 'X', fromMac: true });
  expect(store.getState().toast).toMatchObject({ text: 'this Mac has no X', tone: 'error' });
});
