// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/api.js';
import type { HostStep } from '../../src/bridge.js';
import { fleet } from '../fixtures.js';
import { call, freshStore, sent, shell, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { HostSetup, MachineActions } = await import('../../src/HostSetup.js');
const { terminalOn } = await import('../../src/MoveSheet.js');

beforeEach(() => {
  freshStore();
  call.mockImplementation(() => Promise.resolve({}));
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false });
  // a fleet whose mission control and scribe run Claude Code
  store.getState().setFleet({ ...fleet(), mainAgent: 'claude', scribeAgent: 'claude' });
});

test('opened to add a machine, the panel asks its name and ssh under their labels, and the run it starts is that machine\'s add', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true));
  expect(screen.getByTestId('host-machine').textContent).toBe('Add a machine');
  expect(screen.getByTestId('host-intro').firstElementChild!.firstChild!.textContent).toBe('Installs Svall on a Linux machine over ssh and lists what is left to do.');
  expect(screen.getByRole('tooltip').textContent).toBe('Ubuntu 22.04 LTS or newer with systemd, x86-64 or arm64, and an account you reach over ssh.');
  for (const [id, label, placeholder] of [['host-name', 'name', 'atlas'], ['host-ssh', 'ssh destination', 'you@atlas']]) {
    const field = screen.getByTestId(id);
    expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => field.getAttribute(a)), id).toEqual(['off', 'off', 'false', 'off']);
    expect([field.closest('label')?.firstElementChild?.textContent, field.getAttribute('placeholder')]).toEqual([label, placeholder]);
  }
  expect(screen.getByTestId('host-add').className).toBe('btn pri');
  expect(document.querySelector('.host-foot')!.contains(screen.getByTestId('host-add'))).toBe(true);
  fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'studio' } });
  fireEvent.change(screen.getByTestId('host-ssh'), { target: { value: 'ada@studio' } });
  fireEvent.click(screen.getByTestId('host-add'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'ada@studio' } });
  // while it runs: its name and ssh, the steps, and Stop; no intro, no form
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.queryByTestId('host-intro')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('Add studio');
  expect(document.querySelector('.host-body > .modal-sub')?.textContent).toBe('ada@studio');
  expect(screen.getByTestId('host-running').textContent).toBe('Adding studio…Stop');
});

test('on a far home the add says that home installs Svall, over an account it reaches', () => {
  act(() => store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'studio', online: true }));
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true));
  expect(screen.getByTestId('host-intro').firstElementChild!.firstChild!.textContent).toBe('studio installs Svall on a Linux machine over ssh and lists what is left to do.');
  expect(screen.getByRole('tooltip').textContent).toBe('Ubuntu 22.04 LTS or newer with systemd, x86-64 or arm64, and an account studio reaches over ssh.');
  // its example is never the home
  act(() => store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'atlas', online: true }));
  expect([screen.getByTestId('host-name').getAttribute('placeholder'), screen.getByTestId('host-ssh').getAttribute('placeholder')]).toEqual(['studio', 'you@studio']);
});

test('an add that did not go through says where it stopped and asks again with its form filled; one that did is the machine\'s sheet', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true);
    store.getState().hostStarted('add', { name: 'studio', ssh: 'ada@studio' });
    store.getState().hostStep('add', { step: 'claude', status: 'warn', detail: '2.1.3, not logged in', action: 'ssh ada@studio, then claude auth login', run: 'claude auth login' });
    store.getState().hostStep('add', { step: 'ssh', status: 'fail', detail: 'this Mac cannot log in to studio', action: 'run ssh ada@studio once in a terminal and answer what it asks', run: 'ssh ada@studio', raw: 'Permission denied (publickey).' });
    store.getState().hostDone('add', 1);
  });
  expect(screen.getByTestId('host-machine').textContent).toBe('Add studio');
  // the failed row alone, said once, a tool's words behind details
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-ssh']);
  const said = screen.getByTestId('host-step-ssh');
  // a row of the checklist: its name in its column, how it stands, what to do on the line under it
  expect([said.className, said.querySelector('.host-name')?.textContent, said.querySelector('.modal-sub')?.textContent])
    .toEqual(['host-step', 'Login', 'run ssh ada@studio once in a terminal and answer what it asks']);
  // the login's fix runs on this Mac, and a terminal on studio would need the login it lacks
  expect(said.textContent).toBe('Loginthis Mac cannot log in to studiorun ssh ada@studio once in a terminal and answer what it asksdetailsPermission denied (publickey).');
  expect(screen.queryByTestId('host-terminal-ssh')).toBeNull();
  expect(screen.queryByTestId('machine-more')).toBeNull();
  expect(screen.getByTestId('host-outcome').textContent).toBe('Add machine did not finishTry againClose');

  fireEvent.click(screen.getByTestId('host-edit'));
  expect(screen.getByTestId('host-machine').textContent).toBe('Add a machine');
  expect([(screen.getByTestId('host-name') as HTMLInputElement).value, (screen.getByTestId('host-ssh') as HTMLInputElement).value]).toEqual(['studio', 'ada@studio']);
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-add'));
  expect(sent).toEqual([{ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'ada@studio' } }]);
  act(() => {
    store.getState().hostStep('add', { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'ssh ada@studio, then sudo loginctl enable-linger ada', run: 'sudo loginctl enable-linger ada' });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'listed' });
    store.getState().hostDone('add', 1);
  });
  expect(screen.getByTestId('host-machine').textContent).toBe('studio');
  expect(screen.getByTestId('machine-more').getAttribute('aria-label')).toBe('More for studio');
  expect(screen.getByTestId('host-outcome').textContent).toBe('studio has 1 thing to fixCheck againDone');
  sent.length = 0;
  fireEvent.click(screen.getByTestId('machine-doctor'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }]);

  act(() => {
    store.getState().hostStarted('add', { name: 'studio', ssh: 'ada@studio' });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'listed' });
    store.getState().hostDone('add', 0);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('studio is readyDone');
  expect(screen.getByTestId('host-done').className).toBe('btn pri');
});

test('a name the registry would refuse says what a name takes, and Add machine waits for one it takes', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true));
  fireEvent.change(screen.getByTestId('host-ssh'), { target: { value: 'ada@studio' } });
  expect(screen.queryByTestId('host-name-problem')).toBeNull();
  for (const name of ['Studio', 'vault.local']) {
    fireEvent.change(screen.getByTestId('host-name'), { target: { value: name } });
    expect(screen.getByTestId('host-name-problem').textContent, name).toBe('Name the machine with up to 32 lowercase letters, digits and dashes, starting with a letter');
    expect((screen.getByTestId('host-add') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('host-add').getAttribute('data-tip')).toBe('Needs a name: lowercase letters, digits and dashes');
  }
  fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'vault-local' } });
  expect(screen.queryByTestId('host-name-problem')).toBeNull();
  expect((screen.getByTestId('host-add') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId('host-add').hasAttribute('data-tip')).toBe(false);
  fireEvent.change(screen.getByTestId('host-ssh'), { target: { value: '' } });
  expect(screen.getByTestId('host-add').getAttribute('data-tip')).toBe('Needs the ssh destination, such as you@atlas');
});

test('opened on a machine, the panel names it once, its ⋯ beside the ×, and offers Check at its foot', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true, 'trift'));
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.queryByTestId('host-ssh')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('trift');
  const more = screen.getByTestId('machine-more');
  expect([more.className, more.getAttribute('aria-label'), more.closest('.machine-acts')?.nextElementSibling?.getAttribute('data-testid')]).toEqual(['ib', 'More for trift', 'host-close']);
  expect(screen.getByTestId('machine-doctor').className).toBe('btn pri');
  fireEvent.click(more);
  fireEvent.click(screen.getByTestId('machine-upgrade'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });
  expect(screen.getByTestId('host-machine').textContent).toBe('Upgrade trift');
  // one run at a time: Stop alone
  expect(screen.queryByTestId('machine-doctor')).toBeNull();
  expect(screen.getByTestId('host-running').textContent).toBe('Upgrading trift…Stop');
});
test('the panel\'s menu is the row\'s: a worker of this Mac\'s home can take the fleet, and a far home brings it back and is not removed', () => {
  const STUDIO = 'bbbbbbbb-0000-4000-8000-000000000000';
  store.getState().setMachines([{ name: 'studio', id: STUDIO, ssh: 'ada@studio', platform: 'linux-x64' }]);
  store.getState().setFleet({ ...store.getState().fleet, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 0 } } } as never);
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true, 'studio'));
  fireEvent.click(screen.getByTestId('machine-more'));
  fireEvent.click(screen.getByTestId('machine-make-home'));
  expect(store.getState().homeSheet).toEqual({ to: STUDIO, name: 'studio', back: false });
  expect(store.getState().hostOpen).toBe(false);

  act(() => {
    store.getState().setHomeSheet(undefined);
    store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: STUDIO as never, name: 'studio', online: true });
    store.getState().toggleHost(true, 'studio');
  });
  fireEvent.click(screen.getByTestId('machine-more'));
  expect(screen.queryByTestId('machine-remove')).toBeNull();
  expect(screen.queryByTestId('machine-make-home')).toBeNull();
  fireEvent.click(screen.getByTestId('machine-bring-back'));
  expect(store.getState().homeSheet).toEqual({ to: STUDIO, name: 'studio', back: true });
});

test('on a far home a machine\'s terminal opens on that home: an ssh to the machine typed ahead of what it runs, its login forwarded on each hop, and the home\'s own fix typed bare', () => {
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const shown = () => sent.filter((m) => m.type === 'term.show').at(-1) as unknown as { machine: { ssh: string; type?: string; forward?: number } };
  act(() => {
    store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: HOME as never, name: 'studio', online: true });
    store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }] as never);
    store.getState().toggleHost(true);
    store.getState().hostStarted('add', { name: 'box', ssh: 'ada@box' });
    store.getState().hostStep('add', { step: 'ssh', status: 'fail', detail: 'studio cannot log in to ada@box', action: 'on studio, run this', run: 'ssh-copy-id ada@box' });
    store.getState().hostDone('add', 1);
  });
  render(<HostSetup />);
  fireEvent.click(screen.getByTestId('host-terminal-ssh'));
  expect(shown().machine).toEqual({ ssh: 'ada@studio', type: 'ssh-copy-id ada@box' });
  // the home's own fix runs on the home, which the sheet names
  expect(screen.getByTestId('host-machine').textContent).toBe('Terminal on studio');
  expect(screen.getByTestId('host-terminal-note').firstElementChild!.textContent).toBe('Press Return to run ssh-copy-id ada@box on studio. Click a link to open it in your browser.');
  act(() => {
    store.getState().closeHostTerminal();
    store.getState().hostStarted('add', { name: 'box', ssh: 'ada@box' });
    store.getState().hostStep('add', { step: 'codex', status: 'warn', detail: 'not logged in', action: 'ssh ada@box, then codex login', run: 'codex login' });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'listed' });
    store.getState().hostDone('add', 1);
  });
  fireEvent.click(screen.getByTestId('host-notes'));
  fireEvent.click(screen.getByTestId('host-terminal-codex'));
  expect(shown().machine).toEqual({ ssh: 'ada@studio', type: "ssh -t -L 1455:localhost:1455 ada@box 'codex login'", forward: 1455 });
});

test('Done in a terminal goes back to where it was opened: out of the panel, or to its checks, which run again', () => {
  store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
  render(<HostSetup />);
  act(() => store.getState().openHostTerminal('trift', 'claude auth login'));
  expect(screen.getByTestId('host-terminal-done').getAttribute('data-tip')).toBe('Close the terminal');
  fireEvent.click(screen.getByTestId('host-terminal-done'));
  expect(store.getState().hostOpen).toBe(false);
  expect(sent.some((m) => m.type === 'host.start')).toBe(false);

  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().openHostTerminal('trift', 'claude auth login');
  });
  expect(screen.getByTestId('host-terminal-done').getAttribute('data-tip')).toBe('Close the terminal and check the machine again');
  fireEvent.click(screen.getByTestId('host-terminal-done'));
  expect(store.getState().hostOpen).toBe(true);
  expect(screen.queryByTestId('host-terminal')).toBeNull();
  expect(sent).toContainEqual({ type: 'host.start', op: 'doctor', args: { name: 'trift' } });
});

test('a step that failed says how it stands and what to do behind details; a step of an upgrade offers the run again, a check row leaves that to Check again', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'tmux', status: 'fail', detail: 'tmux is not installed' });
    store.getState().hostStep('doctor', { step: 'linger', status: 'fail', detail: 'off', action: 'ssh ada@trift, then loginctl enable-linger ada' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-step-linger').querySelector('.host-said > span')!.textContent).toBe('off');
  expect(screen.getByTestId('host-action-linger').textContent).toBe('ssh ada@trift, then loginctl enable-linger ada');
  expect(screen.queryByTestId('host-again-linger')).toBeNull();
  expect(screen.queryByTestId('host-again-tmux')).toBeNull();
  act(() => {
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'install', status: 'fail', detail: 'install exited 1' });
    store.getState().hostDone('upgrade', 1);
  });
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again-install'));
  expect(sent).toEqual([{ type: 'host.start', op: 'upgrade', args: { name: 'trift' } }]);
});

test.each(['home', 'home-retry', 'home-abort', 'home-crew'] as const)('a %s run that failed offers no Try again here, which would run it with no sheet and none of its words', (op) => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted(op, { name: 'trift', interrupt: true });
    store.getState().hostStep(op, { step: 'pause', status: 'fail', detail: 'a call this home took is still running; try again in a moment' });
    store.getState().hostDone(op, 1);
  });
  expect(screen.queryByTestId('host-again-pause')).toBeNull();
});

test('a rollback that failed with nothing to do offers itself again on its row', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('rollback', { name: 'trift' });
    store.getState().hostStep('rollback', { step: 'install', status: 'fail', detail: 'install exited 1' });
    store.getState().hostDone('rollback', 1);
  });
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again-install'));
  expect(sent).toEqual([{ type: 'host.start', op: 'rollback', args: { name: 'trift' } }]);
});

test('a remove that failed offers Try again at its foot, not on its row, and one that went through only Done', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('remove', { name: 'trift', forget: true });
    store.getState().hostStep('remove', { step: 'uninstall', status: 'fail', detail: 'did not finish', raw: 'svall uninstall exited 1: no' });
    store.getState().hostDone('remove', 1);
  });
  expect(screen.getByTestId('host-machine').textContent).toBe('Forget trift');
  expect(screen.queryByTestId('host-again-uninstall')).toBeNull();
  expect(screen.getByTestId('host-outcome').textContent).toBe('Remove did not finishTry againClose');
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again'));
  expect(sent).toEqual([{ type: 'host.start', op: 'remove', args: { name: 'trift', forget: true } }]);
  act(() => store.getState().hostDone('remove', 0));
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is forgottenDone');
  expect(screen.getByTestId('host-done').className).toBe('btn pri');
  expect(screen.queryByTestId('machine-more')).toBeNull();
});

test('a remove that took the machine off the list but left copied keys there says what to fix, and offers Done, not Try again', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('remove', { name: 'trift' });
    store.getState().hostStep('remove', { step: 'uninstall', status: 'ok', detail: 'Svall removed' });
    store.getState().hostStep('remove', { step: 'registry', status: 'ok', detail: 'removed' });
    store.getState().hostStep('remove', { step: 'keys', status: 'warn', detail: '2 copied keys could not be removed', action: 'on ada@trift, remove them by hand' });
    store.getState().hostDone('remove', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift has 1 thing to fixDone');
  expect(screen.queryByTestId('host-again')).toBeNull();
  expect(screen.queryByTestId('machine-more')).toBeNull();
});

test('a terminal says what its command is for, as the row that opened it says, and gives its note up to a shell that quit', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'gh', status: 'warn', detail: 'not logged in: pull request links stay unresolved', action: 'gh auth login', run: "gh auth login --hostname 'github.com' --git-protocol ssh --scopes 'repo,read:org'" });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-notes'));
  fireEvent.click(screen.getByTestId('host-terminal-gh'));
  expect(screen.getByTestId('host-terminal-note').firstElementChild!.textContent).toBe('Press Return to log in to GitHub CLI on trift. Click a link to open it in your browser.');
  act(() => shell({ type: 'term.failed', id: 'machine:trift', reason: 'ssh quit as soon as it started: Could not request local forwarding.' }));
  expect(screen.queryByTestId('host-terminal-note')).toBeNull();
  const failed = screen.getByTestId('host-terminal-failed');
  expect([failed.querySelector('.said')!.getAttribute('data-mark'), failed.querySelector('.said > div > span')!.textContent]).toEqual(['fail', 'ssh quit as soon as it started']);
});

test('a running check shows what needs the person as found and the step under way; the notes, the fine checks and the agent setup each fold behind one line', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'master', status: 'start' });
    store.getState().hostStep('doctor', { step: 'master', status: 'ok', detail: 'connected' });
    store.getState().hostStep('doctor', { step: 'doctor', status: 'start' });
  });
  const rows = () => screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'));
  expect(screen.getByTestId('host-machine').textContent).toBe('Check trift');
  expect(screen.getByTestId('host-now').textContent).toBe('Checks there…');
  expect(screen.getByTestId('host-fine').textContent).toBe('1 check fine');
  expect(rows()).toEqual([]);
  act(() => {
    store.getState().hostStep('doctor', { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out; ssh ada@trift, then sudo loginctl enable-linger ada', run: 'sudo loginctl enable-linger ada' });
  });
  // what needs the person shows as it is found, above the step under way
  expect(rows()).toEqual(['host-step-linger']);
  expect(screen.getByTestId('host-now').previousElementSibling!.contains(screen.getByTestId('host-step-linger'))).toBe(true);
  act(() => {
    store.getState().hostStep('doctor', { step: 'doctor', status: 'ok', detail: 'answered' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'ok', detail: 'running' });
    store.getState().hostStep('doctor', { step: 'opencode', status: 'warn', detail: 'opencode v2.1.4, not signed in: opencode auth login', run: 'opencode auth login' });
    store.getState().hostStep('doctor', { step: 'tmux', status: 'warn', detail: '3.4: Shift+Enter needs 3.5' });
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'warn', detail: 'd', action: 'set X on trift', run: 'svall worker env X', gap: { name: 'X', what: 'not set' } });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.queryByTestId('host-now')).toBeNull();
  // one flat list, with no section headings
  expect(rows()).toEqual(['host-step-linger']);
  expect(screen.queryAllByTestId('host-phase')).toEqual([]);
  // the command its terminal types is behind details
  expect(screen.getByTestId('host-step-linger').querySelector('.host-said > span')!.textContent).toBe('off: the fleet stops when you log out');
  // the terminal opens the ssh, so details hold only what to run there
  expect(screen.getByTestId('host-details-linger').textContent).toBe('detailssudo loginctl enable-linger ada');
  expect(screen.getByTestId('host-terminal-linger').textContent).toBe('Open terminal');
  // an agent the fleet does not run, and a warning nobody can act on, are notes
  expect(screen.getByTestId('host-notes').textContent).toBe('2 notes');
  fireEvent.click(screen.getByTestId('host-notes'));
  expect(rows()).toEqual(['host-step-linger', 'host-step-opencode', 'host-step-tmux']);
  expect(screen.getByTestId('host-step-opencode').querySelector('.host-said > span')!.textContent).toBe('opencode v2.1.4, not signed in');
  expect(screen.getByTestId('host-details-opencode').textContent).toBe('detailsopencode auth login');
  expect(screen.getByTestId('host-fine').textContent).toBe('3 checks fine');
  fireEvent.click(screen.getByTestId('host-fine'));
  // the fine checks under the sections they belong to, the only headings; a section of one row that bears its name has none
  expect(screen.getAllByTestId('host-phase').map((e) => e.textContent)).toEqual(['Svall on trift']);
  expect(rows()).toEqual(['host-step-linger', 'host-step-opencode', 'host-step-tmux', 'host-step-master', 'host-step-doctor', 'host-step-systemd']);
  expect(screen.getByTestId('host-setup-fold').textContent).toBe('Your agent setup · 1 not on trift yet');
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(rows()).toContain('host-step-mirror:var:X');
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift has 1 thing to fixCheck againDone');
});

test('a run ends in one line and its foot, Done last in every verdict: primary once it worked, and Close once it did not finish', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'ok', detail: 'answers' });
    store.getState().hostDone('upgrade', 0);
  });
  expect(screen.getByTestId('host-machine').textContent).toBe('Upgrade trift');
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is readyCheck againDone');
  expect([screen.getByTestId('machine-doctor').className, screen.getByTestId('host-done').className]).toEqual(['btn', 'btn pri']);
  fireEvent.click(screen.getByTestId('host-done'));
  expect(store.getState().hostOpen).toBe(false);

  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'claude', status: 'warn', detail: 'not logged in', action: 'ssh ada@trift, then claude auth login' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'inactive' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift has 2 things to fixCheck againDone');
  expect(screen.getByTestId('host-done').className).toBe('btn');
  expect(screen.queryByTestId('host-again-systemd')).toBeNull();
  sent.length = 0;
  fireEvent.click(screen.getByTestId('machine-doctor'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);

  // stopped part way, it says so, with its exit behind details
  act(() => store.getState().hostDone('doctor', 143));
  expect(screen.getByTestId('host-outcome').querySelector('.host-verdict')!.textContent).toBe('Check ended without saying whydetailsexit 143');

  // an upgrade that did not finish closes; one of a name the list does not hold did not finish rather than leave things to fix
  act(() => {
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'machine', status: 'fail', detail: 'no machine trift in the registry' });
    store.getState().hostDone('upgrade', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('Upgrade did not finishCheck againClose');
});

test('the rows to fix list what failed first, then what warned, as found', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'not running' });
    store.getState().hostStep('doctor', { step: 'claude', status: 'warn', detail: '2.1.310, not logged in' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.9.3 there, 0.9.4 on this Mac' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-systemd', 'host-step-release', 'host-step-linger', 'host-step-claude']);
});

test('the confirm stands in for the list while it asks, its buttons at the foot', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'not running' });
    store.getState().hostDone('doctor', 1);
    store.getState().confirmHost({ name: 'trift', forget: false });
  });
  expect(screen.getByTestId('host-confirm').textContent).toBe('Remove uninstalls Svall on trift. Its fleets and files stay there.');
  expect(screen.getByTestId('host-machine').textContent).toBe('Remove trift');
  expect(screen.queryByTestId('host-steps')).toBeNull();
  expect(screen.queryByTestId('host-outcome')).toBeNull();
  expect([...document.querySelectorAll('.host-foot .btn')].map((b) => [b.textContent, b.className])).toEqual([['Remove trift', 'btn dan'], ['Cancel', 'btn']]);
  fireEvent.click(screen.getByTestId('host-confirm-no'));
  expect(screen.getByTestId('host-steps')).toBeTruthy();
  expect(screen.getByTestId('host-machine').textContent).toBe('Check trift');
  act(() => store.getState().confirmHost({ name: 'trift', forget: true }));
  expect(screen.getByTestId('host-confirm').textContent).toBe('Forget drops trift from this list. Nothing on it changes.');
  expect(screen.getByTestId('host-confirm-yes').textContent).toBe('Forget trift');
});

const MACHINE = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const tick = (on: boolean) => ({ item: 'claude:mcp:linear', name: 'linear', fields: ['env.LINEAR_API_KEY'], on, preview: ['env.LINEAR_API_KEY lin…90'], ticked: on ? ['env.LINEAR_API_KEY'] : [] });
const unticked = {
  step: 'mirror:claude:mcp:linear', status: 'warn' as const, action: 'Tick to copy, or set LINEAR_API_KEY on trift: svall worker env LINEAR_API_KEY', tick: tick(false),
  detail: 'not copied', gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
};
// a check of trift whose report has one server to copy the keys of, a variable and the check after it
function checked(machines = [{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]) {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines(machines);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'ssh', status: 'ok', detail: 'ada@trift accepted an interactive login' });
    store.getState().hostStep('doctor', unticked);
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'ok', detail: 'set' });
    store.getState().hostStep('doctor', { step: 'probe', status: 'ok', detail: 'trift answers' });
    store.getState().hostDone('doctor', 0);
  });
  // the agent setup is folded until opened
  fireEvent.click(screen.getByTestId('host-setup-fold'));
}

test('a key row is named by its key, says how it stands, its box labelled copy; the tick asks svalld and the rows it answers stand in place', async () => {
  call.mockImplementation(async (method: string) => (method === 'machines.consent'
    ? { rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'copied', tick: tick(true) }] } : {}));
  checked();
  const row = screen.getByTestId('host-step-mirror:claude:mcp:linear');
  expect(row.querySelector('.host-name')?.textContent).toBe("linear's LINEAR_API_KEY");
  expect(row.querySelector('.host-said > span')?.textContent).toBe('not copied');
  // its details say what else would do, not what its box does, in a sentence and the command whole on a line of its own
  expect(screen.getByTestId('host-action-mirror:claude:mcp:linear').textContent).toBe('Set LINEAR_API_KEY on trift instead:');
  const command = screen.getByTestId('host-command-mirror:claude:mcp:linear');
  expect([command.tagName, command.className, command.textContent]).toEqual(['CODE', 'host-cmd', 'svall worker env LINEAR_API_KEY']);
  // the agent setup holds no robot back: the verdict says ready, and the fold counts what is not there yet
  expect(screen.getByTestId('host-outcome').querySelector('.host-verdict')!.textContent).toBe('trift is ready');
  expect(screen.getByTestId('host-setup-fold').textContent).toBe('Your agent setup · 1 not on trift yet');
  expect(screen.getByRole('tooltip').textContent).toBe('None of this stops a move there. Set it up when a robot there needs it.');
  const box = screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  expect([box.type, box.checked, box.disabled, box.closest('label')?.textContent, box.getAttribute('aria-label')])
    .toEqual(['checkbox', false, false, 'copy', "Copy linear's LINEAR_API_KEY to trift"]);
  // what the row is about is the sentence beside the box
  expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toBe('not copied');
  // what is already there folds under its own line
  expect(screen.queryByTestId('host-step-mirror:var:X')).toBeNull();
  fireEvent.click(screen.getByTestId('host-setup-there'));
  expect(screen.getByTestId('host-setup-there').textContent).toBe('1 already there');
  expect(screen.getByTestId('host-step-mirror:var:X').textContent).toBe('Xset');

  await act(async () => { fireEvent.click(box); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
  expect(store.getState().host?.steps.map((s) => s.step)).toEqual(['ssh', 'mirror:claude:mcp:linear', 'probe']);
  expect(screen.getByTestId('host-step-mirror:claude:mcp:linear').getAttribute('data-status')).toBe('ok');
  expect((screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByTestId('host-details-mirror:claude:mcp:linear')).toBeNull();
  expect(screen.getByTestId('host-setup-fold').textContent).toBe('Your agent setup · all there');
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is readyCheck againDone');
});

test('a file that travels whole says so in its name, and its box what the action would say, so it has no details to open', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'mirror:claude:plugin:acme', status: 'warn', detail: 'not copied', action: 'Tick to copy the whole file, keys included',
      tick: { item: 'claude:plugin:acme', name: "acme's config", fields: ['env'], on: false, preview: ['env'] }, gap: { name: "acme's config", what: 'not copied; tick to copy it as it is' },
    });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(screen.getByTestId('host-step-mirror:claude:plugin:acme').querySelector('.host-name')!.textContent).toBe("acme's config, whole, keys included");
  expect(screen.queryByTestId('host-details-mirror:claude:plugin:acme')).toBeNull();
});

test('a tick the worker did not take says why on its row, and the rows are read again as svalld kept them', async () => {
  call.mockImplementation(async (method: string) => {
    if (method === 'machines.consent') throw new ApiError('not_mirrored', `the change is saved, but machine ${MACHINE} did not take it: token=s3cr3t`);
    return { rows: [{ key: 'claude:mcp:linear', status: 'warn', action: 'check trift again', detail: 'sent; not on trift yet', tick: tick(true) }] };
  });
  checked();
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  expect(call.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['machines.consent', { machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true }],
    ['machines.setup', { machine: MACHINE }],
  ]);
  const failed = screen.getByTestId('host-tick-failed-mirror:claude:mcp:linear');
  expect([failed.textContent, failed.getAttribute('role')]).toEqual(['the change is saved, but trift did not take it: token=…', 'status']);
  expect(screen.getByTestId('host-action-mirror:claude:mcp:linear').textContent).toBe('check trift again');
  expect((screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement).checked).toBe(true);

  // what a tool said of it waits behind details
  act(() => { store.getState().hostRows([unticked]); });
  call.mockImplementation(async (method: string) => {
    if (method === 'machines.consent') throw new ApiError('not_mirrored', 'the change is saved, but trift did not take it: ssh: connect to host trift port 22: refused');
    return { rows: [unticked] };
  });
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  const said = screen.getByTestId('host-tick-failed-mirror:claude:mcp:linear');
  expect([said.querySelector('.said > div > span')!.textContent, said.querySelector('details')!.textContent])
    .toEqual(['the change is saved, but trift did not take it', 'detailsssh: connect to host trift port 22: refused']);
});

test('a tick under way keeps the box where focus is, showing what was asked, and takes no second change', async () => {
  let answer: (v: unknown) => void = () => {};
  call.mockImplementation((method: string) => (method === 'machines.consent' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({})));
  checked();
  const box = () => screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  box().focus();
  await act(async () => { fireEvent.click(box()); });
  expect([box().checked, box().disabled, box().getAttribute('aria-disabled'), document.activeElement === box()]).toEqual([true, false, 'true', true]);
  // the row says what is under way, and its box is described by that
  expect(screen.getByTestId('host-pushing-mirror:claude:mcp:linear').textContent).toBe('pushing to trift…');
  expect(document.getElementById(box().getAttribute('aria-describedby')!)?.textContent).toBe('pushing to trift…');
  await act(async () => { fireEvent.click(box()); });
  expect(call.mock.calls.filter(([method]) => method === 'machines.consent')).toHaveLength(1);
  expect(box().checked).toBe(true);
  await act(async () => { answer({ rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift', tick: tick(true) }] }); });
  expect([box().checked, box().getAttribute('aria-disabled')]).toEqual([true, null]);
  expect(screen.queryByTestId('host-pushing-mirror:claude:mcp:linear')).toBeNull();
});

test('a consent answer goes to the run its tick was made in, not to a later run of the machine of another kind', async () => {
  let answer: (v: unknown) => void = () => {};
  call.mockImplementation((method: string) => (method === 'machines.consent' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({})));
  checked();
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  act(() => {
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'ok', detail: 'trift answers on release 1.2.3' });
    store.getState().hostDone('upgrade', 0);
  });
  await act(async () => { answer({ rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift', tick: tick(true) }] }); });
  expect(store.getState().host?.steps.map((s) => s.step)).toEqual(['probe']);
});

test('a machine not yet in the list has its rows shown but nothing ticked, and the sheet keeps its title and outcome out of the scrolling rows', () => {
  checked([]);
  const box = screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  // why, said once at the top of the list rather than in a tip over each box
  expect([box.disabled, box.closest('label')!.hasAttribute('data-tip')]).toEqual([true, false]);
  expect(screen.getByTestId('host-unlisted').textContent).toBe('Check again to list trift here; Update and the copy boxes work after that.');
  const body = document.querySelector('.host-body')!;
  expect(body.contains(screen.getByTestId('host-steps'))).toBe(true);
  expect(body.contains(screen.getByTestId('host-machine'))).toBe(false);
  expect(body.contains(screen.getByTestId('host-outcome'))).toBe(false);
  expect(screen.getByTestId('host-outcome').classList).toContain('host-foot');
});

test('a check row whose fix is an agent update runs it there from the row and checks again; one that fails says why on the row', async () => {
  let finish!: (e?: Error) => void;
  call.mockImplementation((method: string) => (method === 'machines.updateAgents' ? new Promise((resolve, reject) => { finish = (e) => (e ? reject(e) : resolve({})); }) : Promise.resolve({})));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', action: 'ssh ada@trift, then claude update && codex update', run: 'claude update && codex update' });
    store.getState().hostStep('doctor', { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh ada@trift, then claude auth login', run: 'claude auth login' });
    store.getState().hostDone('doctor', 1);
  });
  // a login is the user's own, in a terminal there
  expect(screen.getByTestId('host-terminal-claude').textContent).toBe('Open terminal');
  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  expect(call).toHaveBeenCalledWith('machines.updateAgents', { machine: MACHINE, kinds: ['claude', 'codex'] });
  expect(screen.getByTestId('host-updating-versions').textContent).toBe('updating on trift…');

  await act(async () => finish(new Error('codex update exited 1: no network')));
  expect(screen.getByTestId('host-tick-failed-versions').textContent).toBe('codex updatedetailsexited 1: no network');
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([]);

  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  await act(async () => finish());
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});

test('a check row whose agent is behind on this Mac updates it here, after the ones there, from the same button', async () => {
  call.mockImplementation(() => Promise.resolve({}));
  render(<HostSetup />);
  const updated = async (row: HostStep) => {
    call.mockClear();
    act(() => {
      store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
      store.getState().toggleHost(true, 'trift');
      store.getState().hostStarted('doctor', { name: 'trift' });
      store.getState().hostStep('doctor', row);
      store.getState().hostDone('doctor', 1);
    });
    await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
    return call.mock.calls.filter(([m]) => m === 'machines.updateAgents');
  };
  expect(await updated({
    step: 'versions', status: 'warn', run: 'opencode upgrade',
    detail: 'codex 0.164.0 there, ahead of 0.162.1 on this Mac; opencode 2.1.4 there, behind 2.2.0 on this Mac: a move there and back needs the same release on both; ssh ada@trift, then opencode upgrade; on this Mac, run codex update',
  })).toEqual([['machines.updateAgents', { machine: MACHINE, kinds: ['opencode'] }], ['machines.updateAgents', { kinds: ['codex'] }]]);
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
  // an add's step keeps its action apart from what it found
  expect(await updated({ step: 'versions', status: 'warn', detail: 'claude 1.2.4 there, ahead of 1.2.3 on this Mac', action: 'on this Mac, run claude update' }))
    .toEqual([['machines.updateAgents', { kinds: ['claude'] }]]);
});

test("a check row that setup there fixes offers Repair, which installs this Mac's release there again, while the machine runs that release", () => {
  render(<HostSetup />);
  const check = (release: 'ok' | 'fail', more: HostStep[] = []) => act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: release, detail: release === 'ok' ? '0.21.0, as on this Mac' : '0.20.0 there; this Mac runs 0.21.0' });
    for (const s of more) store.getState().hostStep('doctor', s);
    store.getState().hostStep('doctor', { step: 'hooks', status: 'fail', detail: 'not installed in /home/ada/.claude/settings.json: svall setup', run: 'svall setup' });
    store.getState().hostDone('doctor', 1);
  });
  check('ok');
  fireEvent.click(screen.getByTestId('host-repair-hooks'));
  expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });

  // the background service stopped, as the machine's doctor says it: this fleet's setup, or a named fleet's upgrade from here
  check('ok', [
    { step: 'systemd', status: 'fail', detail: 'not running', action: 'svall setup', run: 'svall setup', raw: 'svall-svalld@private.service: loaded, inactive (dead), enabled' },
    { step: 'daemon env', status: 'warn', detail: 'lacks CODEX_HOME', action: 'svall host upgrade <this machine> from the controller' },
  ]);
  expect(screen.getByTestId('host-repair-systemd').textContent).toBe('Repair');
  fireEvent.click(screen.getByTestId('host-notes'));
  expect(screen.getByTestId('host-repair-daemon env').textContent).toBe('Repair');
  // what Repair runs there, said as the command it is
  expect(screen.getByTestId('host-action-systemd').className).toBe('host-cmd');

  // another release there is the release row's upgrade to make
  check('fail');
  expect(screen.queryByTestId('host-repair-hooks')).toBeNull();

  // another Mac's worker keeps its setup to run there
  check('ok', [{ step: 'worker', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from that Mac first', action: 'on bea-mbp, run svall host remove trift' }]);
  expect(screen.queryByTestId('host-repair-hooks')).toBeNull();
  expect(screen.getByTestId('host-terminal-hooks').textContent).toBe('Open terminal');

  // an add's agent row whose fix is setup there keeps its terminal
  act(() => {
    store.getState().hostStarted('add', { name: 'trift', ssh: 'ada@trift' });
    store.getState().hostStep('add', { step: 'release', status: 'ok', detail: '0.21.0' });
    store.getState().hostStep('add', {
      step: 'claude', status: 'warn', detail: '2.1.300, logged in; the hooks check there says not installed in /home/ada/.claude/settings.json',
      action: 'ssh ada@trift, then svall setup', run: 'svall setup',
    });
    store.getState().hostDone('add', 0);
  });
  expect(screen.queryByTestId('host-repair-claude')).toBeNull();
  expect(screen.getByTestId('host-terminal-claude').textContent).toBe('Open terminal');
});

test("a check this Mac cannot log in for offers no terminal on the machine, since the key's fix runs on this Mac", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'master', status: 'fail', detail: 'this Mac cannot log in to ada@trift', action: 'on this Mac, run ssh-copy-id ada@trift, then try again',
      run: 'ssh-copy-id ada@trift', raw: 'Permission denied (publickey).',
    });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-step-master').textContent).toContain('on this Mac, run ssh-copy-id ada@trift');
  expect(screen.queryByTestId('host-terminal-master')).toBeNull();
});

test("a machine's Check and Upgrade, off while another run is under way, say so in their tips", () => {
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().hostStarted('doctor', { name: 'box' });
  });
  render(<MachineActions id={MACHINE} name="trift" />);
  expect(screen.getByTestId('machine-doctor').hasAttribute('disabled')).toBe(true);
  expect(screen.getByTestId('machine-doctor').getAttribute('data-tip')).toBe('Another run on a machine is under way');
  fireEvent.click(screen.getByTestId('machine-more'));
  expect(screen.getByTestId('machine-upgrade').getAttribute('data-tip')).toBe('Another run on a machine is under way');
});

test('a check row whose fix is to forget the machine offers Forget, which asks first', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'master', status: 'fail', detail: 'nothing answers at ada@trift', action: 'svall host remove trift --forget' });
    store.getState().hostDone('doctor', 1);
  });
  fireEvent.click(screen.getByTestId('host-forget-master'));
  expect(screen.getByTestId('host-confirm').getAttribute('data-op')).toBe('forget');
  // the confirm stands alone under its title, with no menu beside it
  expect(screen.queryByTestId('machine-more')).toBeNull();
});

test('a remove that did not finish offers no button on its row; Forget waits in the ⋯ menu, though the machine answers', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().setFleet({ ...store.getState().fleet, machines: { [MACHINE]: { name: 'trift', reachable: true, since: 0 } } } as never);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('remove', { name: 'trift' });
    store.getState().hostStep('remove', {
      step: 'uninstall', status: 'fail', detail: 'stopped with an error', raw: 'svall uninstall exited 1 on ada@trift: no',
      action: 'ssh ada@trift, then svall uninstall and see what stops it; svall host remove trift --forget drops the route and leaves the machine as it is',
    });
    store.getState().hostDone('remove', 1);
  });
  const row = screen.getByTestId('host-step-uninstall');
  expect(row.querySelector('.btn')).toBeNull();
  expect(screen.getByTestId('host-outcome').textContent).toBe('Remove did not finishTry againClose');
  fireEvent.click(screen.getByTestId('machine-more'));
  // half removed, it is only reached or forgotten: no upgrade, no home there, and Remove is the foot's Try again
  expect([...document.querySelectorAll('.machine-menu .menu-item')].map((b) => b.getAttribute('data-testid'))).toEqual(['machine-terminal', 'machine-forget']);
  fireEvent.click(screen.getByTestId('machine-forget'));
  expect(store.getState().hostConfirm).toEqual({ name: 'trift', forget: true });
});

test("an add's agent update waits, saying why, until this Mac's list names the machine, then runs from the same row", async () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true);
    store.getState().hostStarted('add', { name: 'trift', ssh: 'ada@trift' });
    store.getState().hostStep('add', { step: 'versions', status: 'warn', detail: 'Claude Code 1.2.3 there, 1.2.4 on this Mac', action: 'ssh ada@trift, then claude update', run: 'claude update' });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'listed' });
    store.getState().hostDone('add', 1);
  });
  const update = () => screen.getByTestId('host-update-versions') as HTMLButtonElement;
  expect(update().disabled).toBe(true);
  expect(screen.getByTestId('host-unlisted')).toBeTruthy();
  expect(screen.queryByTestId('host-terminal-versions')).toBeNull();
  act(() => store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]));
  expect(update().disabled).toBe(false);
  expect(screen.queryByTestId('host-unlisted')).toBeNull();
  await act(async () => { fireEvent.click(update()); });
  expect(call).toHaveBeenCalledWith('machines.updateAgents', { machine: MACHINE, kinds: ['claude'] });
});

test('a terminal whose ssh quit closes with Close', () => {
  store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
  render(<HostSetup />);
  act(() => store.getState().openHostTerminal('trift', 'claude auth login'));
  expect(screen.getByTestId('host-terminal-done').textContent).toBe('Done');
  act(() => shell({ type: 'term.failed', id: 'machine:trift', reason: 'ssh quit as soon as it started: Connection closed' }));
  expect(screen.getByTestId('host-terminal-done').textContent).toBe('Close');
});

test("an upgrade that put the release before back did not finish; its rows keep only what was said behind details, as the sheet's Check again sees why", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'install', status: 'ok', detail: '0.9.4 installed' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'warn', detail: 'answers from 0.9.3, not 0.9.4', action: 'see why: svall host doctor trift' });
    store.getState().hostStep('upgrade', { step: 'rollback', status: 'ok', detail: 'back on 0.9.3', action: 'see why: svall host doctor trift', raw: 'current -> /home/ada/.local/share/svall/releases/0.9.3' });
    store.getState().hostDone('upgrade', 1);
  });
  // finding out why is the way on
  expect(screen.getByTestId('host-outcome').textContent).toBe('Upgrade did not finishCheck againClose');
  expect(screen.getByTestId('machine-doctor').className).toBe('btn pri');
  // the rollback that worked stays in sight, as done, after the check it followed
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => [e.getAttribute('data-testid'), e.getAttribute('data-status')]))
    .toEqual([['host-step-probe', 'warn'], ['host-step-rollback', 'ok']]);
  expect(screen.getByTestId('host-fine').textContent).toBe('1 step done');
  expect(screen.queryByTestId('host-action-probe')).toBeNull();
  expect(screen.getByTestId('host-details-rollback').textContent).not.toContain('see why');
});

test('an upgrade whose rollback failed did not finish, and offers the rollback the CLI names before Close', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'warn', detail: 'does not answer', action: 'see why: svall host doctor trift' });
    store.getState().hostStep('upgrade', { step: 'rollback', status: 'fail', detail: 'on 0.9.4; 0.9.3 could not be put back', action: 'see why: svall host doctor trift' });
    store.getState().hostDone('upgrade', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('Upgrade did not finishRoll back triftClose');
  // in the order they ran, as every run's steps
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-probe', 'host-step-rollback']);
});

test("while the background service has failed, its port's own check says nothing more", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'svalld', status: 'warn', detail: 'not running (no port file in /home/ada/.svall): it starts when Svall opens on this fleet' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'not running', action: 'svall setup', run: 'svall setup' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-notes')).toBeNull();
  expect(screen.queryByTestId('host-step-svalld')).toBeNull();
  // with the service up, the same row is a note of its own
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'svalld', status: 'warn', detail: 'not running (no port file in /home/ada/.svall): it starts when Svall opens on this fleet' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'ok', detail: 'running' });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-notes').textContent).toBe('1 note');
  // another process on the port is a problem of its own, listed and counted
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'svalld', status: 'fail', detail: 'not running: nc (pid 4242) holds port 47801, which /home/ada/.svall/node.json sets; stop it, or take port out of node.json' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'not running', action: 'svall setup', run: 'svall setup' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-svalld', 'host-step-systemd']);
  expect(screen.getByTestId('host-outcome').querySelector('.host-verdict')!.textContent).toBe('trift has 2 things to fix');
  // a unit that could not be read says nothing of the service, so the port's check stands
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'svalld', status: 'warn', detail: 'not running (no port file in /home/ada/.svall): it starts when Svall opens on this fleet' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'could not be read', raw: 'systemctl: no systemd user services' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-notes').textContent).toBe('1 note');
});

test('the fine checks list a section of one row first, with no heading, and count apart what was not checked', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    for (const [step, status] of [['master', 'ok'], ['linger', 'ok'], ['release', 'ok'], ['worker', 'ok'], ['svalld', 'skip'], ['hook receiver', 'skip']] as const) {
      store.getState().hostStep('doctor', { step, status, detail: status === 'skip' ? 'not checked' : 'd' });
    }
    // an agent the fleet does not run, skipped, is nothing wrong
    store.getState().hostStep('doctor', { step: 'codex', status: 'skip', detail: 'not installed' });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-fine').textContent).toBe('5 checks fine · 2 not checked');
  fireEvent.click(screen.getByTestId('host-fine'));
  expect(screen.getAllByTestId('host-phase').map((e) => e.textContent)).toEqual(['Svall on trift']);
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid')))
    .toEqual(['host-step-master', 'host-step-linger', 'host-step-codex', 'host-step-release', 'host-step-worker', 'host-step-svalld', 'host-step-hook receiver']);
});

test("a key the machine has its own of says so by the machine's name, with no box to copy over it; a state's consequence keeps whole", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'gh', status: 'warn', detail: 'not logged in: pull request links stay unresolved', action: 'gh auth login', run: 'gh auth login' });
    store.getState().hostStep('doctor', { step: 'mirror:codex:mcp:github', status: 'ok', detail: 'trift has its own', tick: { item: 'codex:mcp:github', name: 'github', fields: ['env.GITHUB_TOKEN'], on: false, preview: [], ticked: [] } });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  const row = screen.getByTestId('host-step-mirror:codex:mcp:github');
  expect(row.querySelector('.host-said > span')!.textContent).toBe('trift has its own');
  expect(screen.queryByTestId('host-tick-mirror:codex:mcp:github')).toBeNull();
  // one with a key ticked keeps its box, mixed, and a click takes that key back without sending the other
  act(() => store.getState().hostRows([{ step: 'mirror:codex:mcp:github', status: 'ok', detail: 'trift has its own', tick: { item: 'codex:mcp:github', name: 'github', fields: ['env.A', 'env.B'], on: false, preview: [], ticked: ['env.A'] } }]));
  const box = screen.getByTestId('host-tick-mirror:codex:mcp:github') as HTMLInputElement;
  expect([box.checked, box.indeterminate]).toEqual([false, true]);
  call.mockClear();
  fireEvent.click(box);
  const consents = call.mock.calls.filter(([method]) => method === 'machines.consent');
  expect(consents).toEqual([['machines.consent', { machine: MACHINE, item: 'codex:mcp:github', fields: ['env.A'], on: false }]]);
  fireEvent.click(screen.getByTestId('host-notes'));
  expect(screen.getByTestId('host-step-gh').querySelector('.host-said > span .host-leads')!.textContent).toBe('pull request links stay unresolved');
});

test("a remove's steps that went well fold as steps done, in the order they ran", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('remove', { name: 'trift' });
    for (const step of ['machine', 'uninstall', 'registry', 'keys']) store.getState().hostStep('remove', { step, status: 'ok', detail: 'd' });
    store.getState().hostDone('remove', 0);
  });
  expect(screen.getByTestId('host-fine').textContent).toBe('4 steps done');
  fireEvent.click(screen.getByTestId('host-fine'));
  expect(screen.queryAllByTestId('host-phase')).toEqual([]);
  expect(screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-machine', 'host-step-uninstall', 'host-step-registry', 'host-step-keys']);
});

test("the ⋯ menu offers no upgrade to the release the machine runs, as its last check or one just made found", () => {
  act(() => store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64', current: true }]));
  render(<MachineActions id={MACHINE} name="trift" />);
  fireEvent.click(screen.getByTestId('machine-more'));
  expect(screen.queryByTestId('machine-upgrade')).toBeNull();
  expect(screen.getByTestId('machine-terminal')).toBeTruthy();
  // a check that finds another release there offers it again, though the list said otherwise
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.9.3 there, 0.9.4 on this Mac', action: 'svall host upgrade trift' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('machine-upgrade')).toBeTruthy();
  act(() => store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]));
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'ok', detail: '0.9.4, same as this Mac' });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.queryByTestId('machine-upgrade')).toBeNull();
  // a warning there keeps it, as an agent setup row does not
  for (const [row, offered] of [[{ step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out' }, true], [{ step: 'mirror:var:X', status: 'warn', detail: 'not set · ad reads it' }, false]] as const) {
    act(() => {
      store.getState().hostStarted('doctor', { name: 'trift' });
      store.getState().hostStep('doctor', { step: 'release', status: 'ok', detail: '0.9.4, same as this Mac' });
      store.getState().hostStep('doctor', row);
      store.getState().hostDone('doctor', 0);
    });
    expect(!!screen.queryByTestId('machine-upgrade'), row.step).toBe(offered);
  }
  // on this release, a machine not yet this fleet's worker still wants the upgrade that makes it one
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'ok', detail: '0.9.4, same as this Mac' });
    store.getState().hostStep('doctor', { step: 'worker', status: 'fail', detail: "does not run this fleet's robots yet", action: 'svall host upgrade trift sets it up' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('machine-upgrade')).toBeTruthy();
});

test('a check that finds the machine on another release offers its upgrade on that row', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.20.0 there, 0.21.0 on this Mac', action: 'svall host upgrade trift' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-again-release')).toBeNull();
  fireEvent.click(screen.getByTestId('host-upgrade'));
  expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });
});

test("a check that finds the machine not running this fleet's robots offers the upgrade that sets it up, and not when another Mac holds it or it runs a newer release", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.20.0 there, 0.21.0 on this Mac', action: 'svall host upgrade trift' });
    store.getState().hostStep('doctor', { step: 'worker', status: 'fail', detail: "does not run this fleet's robots yet", action: 'svall host upgrade trift sets it up' });
    store.getState().hostDone('doctor', 1);
  });
  fireEvent.click(screen.getByTestId('host-worker'));
  expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });

  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'worker', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from that Mac first', action: 'on bea-mbp, run svall host remove trift' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-worker')).toBeNull();

  // an upgrade there would go back to this Mac's older release
  act(() => {
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.22.0 there, 0.21.0 on this Mac', action: 'update svall on this Mac' });
    store.getState().hostStep('doctor', { step: 'worker', status: 'fail', detail: "does not run this fleet's robots yet", action: 'svall host upgrade trift sets it up' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-worker')).toBeNull();
});

test('a check row keeps how it stands in its sentence and puts the command behind details, less the ssh its terminal opens', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'linger', status: 'warn', detail: 'off for ada: the fleet stops when you log out; ssh ada@trift, then sudo loginctl enable-linger ada', run: 'sudo loginctl enable-linger ada',
    });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-step-linger').querySelector('.host-said')?.firstChild?.textContent).toBe('off for ada: the fleet stops when you log out');
  expect(screen.getByTestId('host-details-linger').textContent).toBe('detailssudo loginctl enable-linger ada');
});

test('a machine on a newer release than this Mac is not offered an upgrade there', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: "0.22.0 there, newer than this Mac's 0.21.0", action: 'update svall on this Mac' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-upgrade')).toBeNull();
  expect(screen.getByTestId('host-action-release').textContent).toBe('update svall on this Mac');
});

test('an agent update keeps its row through the fine checks opening, and leaves a run started meanwhile alone', async () => {
  let finish!: () => void;
  call.mockImplementation((method: string) => (method === 'machines.updateAgents' ? new Promise((resolve) => { finish = () => resolve({}); }) : Promise.resolve({})));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'ok', detail: '0.21.0' });
    store.getState().hostStep('doctor', { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', run: 'claude update' });
    store.getState().hostDone('doctor', 1);
  });
  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  fireEvent.click(screen.getByTestId('host-fine'));
  expect(screen.getByTestId('host-updating-versions').textContent).toBe('updating on trift…');

  act(() => { store.getState().hostStarted('upgrade', { name: 'trift' }); });
  await act(async () => finish());
  expect(store.getState().host?.op).toBe('upgrade');
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([]);
});

test('the agent setup fold lists what is left to set up, then what runs only on a Mac or is not needed there, each saying so, and what is there behind its own line', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'mirror:maconly:claude:chrome', status: 'skip', detail: 'runs only on a Mac', gap: { name: 'chrome', what: 'runs only on a Mac' } });
    store.getState().hostStep('doctor', { step: 'mirror:runtime:adlc', status: 'warn', action: 'install adlc on trift', detail: 'not installed · ad needs it', tick: { item: 'runtime:adlc', fields: ['skip'], on: false, preview: [] }, gap: { name: 'adlc', what: 'not installed; ad needs it' } });
    store.getState().hostStep('doctor', { step: 'mirror:oauth:claude:mcp:notion', status: 'ok', detail: 'logged in' });
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'warn', action: 'svall worker env X', run: 'svall worker env X', detail: 'not set · ad reads it', gap: { name: 'X', what: 'not set; ad reads it' } });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-setup-fold').textContent).toBe('Your agent setup · 2 not on trift yet');
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  const steps = () => [...document.querySelectorAll('[data-testid^="host-step-mirror"], [data-testid="host-setup-there"]')].map((e) => e.getAttribute('data-testid'));
  expect(steps()).toEqual(['host-step-mirror:runtime:adlc', 'host-step-mirror:var:X', 'host-step-mirror:maconly:claude:chrome', 'host-setup-there']);
  expect(screen.getByTestId('host-step-mirror:maconly:claude:chrome').textContent).toBe('chromeruns only on a Mac');
  const box = screen.getByTestId('host-tick-mirror:runtime:adlc');
  expect([box.getAttribute('aria-label'), box.closest('label')?.textContent]).toEqual(['adlc is not needed on trift', 'not needed']);
  fireEvent.click(screen.getByTestId('host-setup-there'));
  // a login is named by its server
  expect(screen.getByTestId('host-step-mirror:oauth:claude:mcp:notion').textContent).toBe('notionlogged in');
});

test('an agent setup all there opens straight onto its rows', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'mirror:oauth:claude:mcp:notion', status: 'ok', detail: 'logged in' });
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'ok', detail: 'set' });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-setup-fold').textContent).toBe('Your agent setup · all there');
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(screen.queryByTestId('host-setup-there')).toBeNull();
  expect(screen.queryAllByTestId(/^host-step-mirror/).map((e) => e.getAttribute('data-testid'))).toEqual(['host-step-mirror:oauth:claude:mcp:notion', 'host-step-mirror:var:X']);
});

test("the phone's row names the home by the window's name for it, and its box turns it on", () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'studio', online: true });
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64', far: true }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'mirror:phone', status: 'skip', detail: 'off', action: 'On, trift serves its robots to the phone while studio is off', tick: { item: 'phone', fields: ['serve'], on: false, preview: [] } });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  const row = screen.getByTestId('host-step-mirror:phone');
  expect(row.querySelector('.host-name')!.textContent).toBe('Phone while studio is off');
  expect(screen.getByTestId('host-tick-mirror:phone').closest('label')?.textContent).toBe('on');
});

test('a phone row that does not serve, with a repair to run there, keeps Open terminal beside its box', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'mirror:phone', status: 'warn', detail: 'on, not serving', action: 'Tailscale on trift does not let Svall share this fleet. Run once on trift: sudo tailscale set --operator=$USER',
      run: 'sudo tailscale set --operator=$USER', tick: { item: 'phone', fields: ['serve'], on: true, preview: [] },
    });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(screen.getByTestId('host-tick-mirror:phone')).toBeTruthy();
  fireEvent.click(screen.getByTestId('host-terminal-mirror:phone'));
  expect(store.getState().hostTerminal).toMatchObject({ run: 'sudo tailscale set --operator=$USER' });
});

test('a program row with an install command keeps Open terminal beside its not-needed box', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'mirror:runtime:npx', status: 'warn', action: 'install npx on trift', run: 'sudo apt install nodejs npm', detail: 'linear needs it; tick if trift does not',
      tick: { item: 'runtime:npx', fields: ['skip'], on: false, preview: [] }, gap: { name: 'npx', what: 'not installed; linear needs it' },
    });
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(screen.getByTestId('host-tick-mirror:runtime:npx')).toBeTruthy();
  fireEvent.click(screen.getByTestId('host-terminal-mirror:runtime:npx'));
  expect(store.getState().hostTerminal).toEqual({ run: 'sudo apt install nodejs npm', fromPanel: true });
});

test('a variable row takes its value in a field, shown to no one, and Set sends it to the machine; this Mac\'s own copies without it; a refusal says why', async () => {
  const unset: HostStep = { step: 'mirror:var:X', status: 'warn', action: 'set X on trift', run: 'svall worker env X', detail: 'ad reads X, which is not set on trift', gap: { name: 'X', what: 'not set; ad reads it' }, here: true };
  call.mockImplementation(async (method: string) => (method === 'machines.setVar' ? { rows: [{ key: 'var:X', status: 'ok', detail: 'X is set on trift' }] } : {}));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', unset);
    store.getState().hostDone('doctor', 0);
  });
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(screen.queryByTestId('host-terminal-mirror:var:X')).toBeNull();
  const field = screen.getByTestId('host-var-mirror:var:X-value') as HTMLInputElement;
  expect([field.type, field.getAttribute('autocomplete')]).toEqual(['password', 'off']);
  expect((screen.getByTestId('host-var-mirror:var:X-set') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: 's3cr3t' } });
  await act(async () => { fireEvent.click(screen.getByTestId('host-var-mirror:var:X-set')); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: MACHINE, name: 'X', value: 's3cr3t' });
  expect(screen.getByTestId('host-step-mirror:var:X').getAttribute('data-status')).toBe('ok');
  expect(document.body.innerHTML).not.toContain('s3cr3t');

  act(() => { store.getState().hostRows([unset]); });
  await act(async () => { fireEvent.click(screen.getByTestId('host-var-mirror:var:X-copy')); });
  expect(call).toHaveBeenCalledWith('machines.setVar', { machine: MACHINE, name: 'X', fromMac: true });
  expect(screen.getByTestId('host-step-mirror:var:X').getAttribute('data-status')).toBe('ok');

  act(() => { store.getState().hostRows([{ ...unset, here: undefined }]); });
  expect(screen.queryByTestId('host-var-mirror:var:X-copy')).toBeNull();
  call.mockImplementation(async () => { throw new ApiError('not_mirrored', 'trift runs a release that cannot take a variable from here; upgrade it under Machines'); });
  fireEvent.change(screen.getByTestId('host-var-mirror:var:X-value'), { target: { value: 'v' } });
  await act(async () => { fireEvent.click(screen.getByTestId('host-var-mirror:var:X-set')); });
  expect(screen.getByTestId('host-tick-failed-mirror:var:X').textContent).toBe('trift runs a release that cannot take a variable from here; upgrade it under Machines');
  expect((screen.getByTestId('host-var-mirror:var:X-value') as HTMLInputElement).value).toBe('');
});

describe('a terminal for a far worker, wherever it is opened from', () => {
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const BOX = 'cccccccc-0000-4000-8000-000000000000';
  const shown = () => sent.filter((m) => m.type === 'term.show').at(-1) as unknown as { machine: { ssh: string; type?: string; forward?: number } };
  const far = () => {
    store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: HOME as never, name: 'studio', online: true });
    store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }, { id: BOX, name: 'box', ssh: 'ada@box', platform: 'linux-x64', far: true }] as never);
  };

  test.each([
    ['a login, by its port', 'codex login', 1455, "ssh -t -L 1455:localhost:1455 ada@box 'codex login'", 1455, 'Terminal on box',
      'Press Return to run codex login on box. Its sign-in comes back through port 1455 on this Mac.'],
    ['a login with no port of its own, as Codex waits on its own', 'codex login', undefined, "ssh -t -L 1455:localhost:1455 ada@box 'codex login'", 1455, 'Terminal on box',
      'Press Return to run codex login on box. Its sign-in comes back through port 1455 on this Mac.'],
    ['a cd, which leaves a shell open there', "cd '/home/ada/o'\\''brien'", undefined, `ssh -t ada@box 'cd '\\''/home/ada/o'\\''\\'\\'''\\''brien'\\''; exec "$SHELL" -l'`, undefined, 'Shell on box',
      "Press Return to open a shell on box in /home/ada/o'brien."],
    ['any other command', 'svall worker env FOO', undefined, "ssh -t ada@box 'svall worker env FOO'", undefined, 'Terminal on box', 'Press Return to run svall worker env FOO on box.'],
    ['a command too long to read in a line', `echo ${'x'.repeat(50)}`, undefined, `ssh -t ada@box 'echo ${'x'.repeat(50)}'`, undefined, 'Terminal on box', 'Press Return to run the command on box.'],
  ])('%s runs on the worker, by way of the home, and the sheet says so in one line with the typed line behind details', (_what, run, forward, typed, port, title, note) => {
    act(() => { far(); terminalOn('box', run, forward); });
    render(<HostSetup />);
    expect(shown().machine).toEqual({ ssh: 'ada@studio', type: typed, ...(port && { forward: port }) });
    expect(screen.getByTestId('host-machine').textContent).toBe(title);
    expect(screen.getByTestId('host-terminal-note').firstElementChild!.textContent).toBe(`${note} Click a link to open it in your browser.`);
    const command = screen.getByTestId('host-terminal-note').querySelector('details')!;
    expect([command.querySelector('summary')!.textContent, command.querySelector('code')!.textContent, command.hasAttribute('open')]).toEqual(['details', typed, false]);
  });

  test('none typed is a shell on the worker', () => {
    act(() => { far(); terminalOn('box'); });
    render(<HostSetup />);
    expect(shown().machine).toEqual({ ssh: 'ada@studio', type: 'ssh ada@box' });
    expect(screen.getByTestId('host-terminal-note').firstElementChild!.textContent).toBe('Press Return to open a shell on box. Click a link to open it in your browser.');
  });

  test('on a Mac home a plain terminal is a shell there, with nothing typed and nothing behind details', () => {
    act(() => { store.getState().setMachines([{ id: BOX, name: 'box', ssh: 'ada@box', platform: 'linux-x64' }] as never); terminalOn('box'); });
    render(<HostSetup />);
    expect(screen.getByTestId('host-machine').textContent).toBe('Terminal on box');
    expect(screen.getByTestId('host-terminal-note').textContent).toBe('A shell on box. Click a link to open it in your browser.');
  });

  test('the home itself and a Mac\'s own machine open as they always did', () => {
    act(() => { far(); terminalOn('studio', 'svall setup'); });
    render(<HostSetup />);
    expect(shown().machine).toEqual({ ssh: 'ada@studio', type: 'svall setup' });
  });

  test('a far row runs by its id, while the panel goes by its name', () => {
    act(() => { far(); store.getState().toggleHost(true, 'box'); });
    render(<MachineActions id={BOX} name="box" />);
    fireEvent.click(screen.getByTestId('machine-doctor'));
    expect(sent.filter((m) => m.type === 'host.start').at(-1)).toMatchObject({ op: 'doctor', args: { name: BOX } });
    expect(store.getState().hostMachine).toBe('box');
    expect(store.getState().host?.args).toMatchObject({ name: 'box', id: BOX });
  });

  test('a far worker\'s own fix for its master, as its login, is typed bare on the home', () => {
    act(() => {
      far();
      store.getState().toggleHost(true, 'box');
      store.getState().hostStarted('doctor', { name: 'box', id: BOX });
      store.getState().hostStep('doctor', { step: 'master', status: 'fail', detail: 'studio cannot log in to ada@box', action: 'on studio, run this', run: 'ssh-copy-id ada@box' });
      store.getState().hostDone('doctor', 1);
    });
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('host-terminal-master'));
    expect(shown().machine).toEqual({ ssh: 'ada@studio', type: 'ssh-copy-id ada@box' });
  });
});

describe('a far worker this Mac\'s registry names as it names its home', () => {
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const BOX = 'cccccccc-0000-4000-8000-000000000000';
  const started = () => sent.filter((m) => m.type === 'host.start').at(-1);
  // the home's own row first, as `svall host list` gives this Mac's rows before the far home's
  const collide = () => {
    store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: HOME as never, name: 'studio', online: true });
    store.getState().setMachines([{ id: HOME, name: 'box', ssh: 'ada@studio', platform: 'linux-x64' }, { id: BOX, name: 'box', ssh: 'ada@box', platform: 'linux-x64', far: true }] as never);
  };
  // a run of the far row, which went by its id, ended with `steps`
  const ran = (op: 'doctor' | 'upgrade', steps: HostStep[]) => act(() => {
    collide();
    store.getState().toggleHost(true, 'box');
    store.getState().hostStarted(op, { name: 'box', id: BOX });
    for (const s of steps) store.getState().hostStep(op, s);
    store.getState().hostDone(op, 1);
  });

  test('the panel\'s own Check and the check after its terminal go on by the id its run went by', () => {
    ran('doctor', []);
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('machine-doctor'));
    expect(started()).toMatchObject({ op: 'doctor', args: { name: BOX } });
    act(() => {
      store.getState().hostDone('doctor', 0);
      store.getState().openHostTerminal('box', 'codex login');
    });
    fireEvent.click(screen.getByTestId('host-terminal-done'));
    expect(started()).toMatchObject({ op: 'doctor', args: { name: BOX } });
  });

  test('a row\'s Upgrade and Forget go by that id', () => {
    ran('doctor', [
      { step: 'release', status: 'fail', detail: 'box runs 1.2.2' },
      { step: 'master', status: 'fail', detail: 'nothing answers at ada@box', action: 'svall host remove box --forget' },
    ]);
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('host-upgrade'));
    expect(started()).toMatchObject({ op: 'upgrade', args: { name: BOX } });
    ran('doctor', [{ step: 'master', status: 'fail', detail: 'nothing answers at ada@box', action: 'svall host remove box --forget' }]);
    fireEvent.click(screen.getByTestId('host-forget-master'));
    expect(store.getState().hostConfirm).toEqual({ name: 'box', forget: true, id: BOX });
  });

  test.each([
    ["a row's Set up", 'host-worker', 'upgrade', [{ step: 'worker', status: 'fail', detail: "does not run this fleet's robots yet: svall host upgrade box sets it up" }]],
    ["a row's Repair", 'host-repair-hooks', 'upgrade', [
      { step: 'release', status: 'ok', detail: '0.21.0, as on this Mac' },
      { step: 'hooks', status: 'fail', detail: 'not installed in /home/ada/.claude/settings.json: svall setup', run: 'svall setup' },
    ]],
    ["the check after a row's Update", 'host-update-versions', 'doctor', [
      { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', action: 'ssh ada@box, then claude update', run: 'claude update' },
    ]],
  ] as const)('%s goes by that id', async (_what, button, op, steps) => {
    ran('doctor', [...steps]);
    render(<HostSetup />);
    await act(async () => { fireEvent.click(screen.getByTestId(button)); });
    expect(started()).toMatchObject({ op, args: { name: BOX } });
  });

  test('a row\'s Update and Forget act on the far worker, not the home this Mac names the same', async () => {
    ran('doctor', [
      { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', action: 'ssh ada@box, then claude update', run: 'claude update' },
      { step: 'master', status: 'fail', detail: 'nothing answers at ada@box', action: 'svall host remove box --forget' },
    ]);
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('host-forget-master'));
    expect(store.getState().hostConfirm).toEqual({ name: 'box', forget: true, id: BOX });
    fireEvent.click(screen.getByTestId('host-confirm-no'));
    await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
    expect(call).toHaveBeenCalledWith('machines.updateAgents', expect.objectContaining({ machine: BOX }));
    expect(call).not.toHaveBeenCalledWith('machines.updateAgents', expect.objectContaining({ machine: HOME }));
  });

  test('a Rollback after a failed upgrade goes by that id', () => {
    ran('upgrade', [{ step: 'rollback', status: 'fail', detail: 'the release before did not start' }]);
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('host-rollback'));
    expect(started()).toMatchObject({ op: 'rollback', args: { name: BOX } });
  });

  test.each([['Remove', 'machine-remove', {}], ['Forget', 'machine-forget', { forget: true }]] as const)('the row\'s %s asks by that id, and its yes runs by it', (_what, item, forget) => {
    act(() => collide());
    render(<MachineActions id={BOX} name="box" />);
    fireEvent.click(screen.getByTestId('machine-more'));
    fireEvent.click(screen.getByTestId(item));
    expect(store.getState().hostConfirm).toEqual({ name: 'box', forget: 'forget' in forget, id: BOX });
    cleanup();
    render(<HostSetup />);
    fireEvent.click(screen.getByTestId('host-confirm-yes'));
    expect(started()).toEqual({ type: 'host.start', op: 'remove', args: { name: BOX, ...forget } });
  });
});
