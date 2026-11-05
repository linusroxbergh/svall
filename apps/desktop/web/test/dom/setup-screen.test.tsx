// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SetupPlan } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { Setup } from '../../src/Setup.js';
import { createAppStore, localAppStorage } from '../../src/store/index.js';

afterEach(() => { delete window.webkit; delete window.__svallHome; });

test('a plan that is not the JSON asked for is shown as it came, not left on the loading line', async () => {
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    if ((JSON.parse(json) as { type: string }).type !== 'setup.plan') return;
    const reply = { type: 'setup.result', step: 'plan', ok: true, json: 'nvm: using node 24\n{}' };
    setTimeout(() => window.__svall!.receive(JSON.stringify(reply)), 0);
  } } } };
  render(<Setup />);
  expect(await screen.findByText(/nvm: using node 24/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
});

const ready: SetupPlan = {
  agents: [{ kind: 'claude', path: '/usr/local/bin/claude', version: '2.0' }, { kind: 'codex', path: '/usr/local/bin/codex', version: '0.155' }],
  projects: '~/Developer', blockers: [], shimDir: '/Users/test/.local/bin', shimOnPath: true,
  writes: [{ what: 'Claude Code hooks', path: '/Users/test/.claude/settings.json', agent: 'claude' }, { what: 'Codex hooks', path: '/Users/test/.codex/hooks.json', agent: 'codex' }, { what: 'Your fleet', path: '/Users/test/.svall' }],
};
const missing: SetupPlan = {
  ...ready, agents: [], blockers: ['Install an agent in Terminal, then check again.'],
  install: [{ kind: 'claude', command: 'install-claude', url: 'https://example.com/claude' }, { kind: 'codex', command: 'install-codex', url: 'https://example.com/codex' }],
};

function shell(plan: SetupPlan, opts: { fork?: false } = {}) {
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    sent.push(JSON.parse(json));
  } } } };
  render(<Setup />);
  const receive = (message: object) => act(() => window.__svall!.receive(JSON.stringify(message)));
  const reply = (next = plan) => receive({ type: 'setup.result', step: 'plan', ok: true, json: JSON.stringify(next) });
  reply();
  if (opts.fork !== false) fireEvent.click(screen.getByTestId('fork-here'));
  return { sent, receive, reply };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

test('file changes are available on demand and follow the selected agents', () => {
  shell(ready);
  fireEvent.click(screen.getByLabelText('Codex'));
  next(); next();
  const details = screen.getByText(/Review changes/).closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.queryByText('Codex: hooks')).toBeNull();
  expect(screen.getByText('2 locations')).toBeTruthy();
  fireEvent.click(screen.getByText(/Review changes/));
  expect(details.open).toBe(true);
  expect(screen.getByText('~/.claude/settings.json')).toBeTruthy();
});

test('missing agents show one installer at a time', () => {
  const s = shell(missing);
  expect(screen.getByText('install-claude')).toBeTruthy();
  expect(screen.queryByText('install-codex')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  expect(screen.getByText('install-codex')).toBeTruthy();
  expect(screen.queryByText('install-claude')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(s.sent.at(-1)).toMatchObject({ type: 'copy', text: 'install-codex' });
});

test('rechecks on native activation, focus and visibility without duplicate in-flight requests or locking choices', () => {
  const s = shell(missing);
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  s.receive({ type: 'app.active', active: false });
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(1);
  s.receive({ type: 'app.active', active: true });
  fireEvent.focus(window);
  fireEvent(document, new Event('visibilitychange'));
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('radio', { name: 'Codex' }).closest('fieldset')!.disabled).toBe(false);
  s.reply();
  expect((screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement).checked).toBe(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(3);
  s.reply();
  fireEvent.focus(window);
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(4);
  s.reply(ready);
  fireEvent.focus(window);
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(5);
});

test('rechecking preserves existing agent selections and even an intentionally empty folder', () => {
  const blocked = { ...ready, blockers: ['Shell did not answer.'] };
  const s = shell(blocked);
  fireEvent.click(screen.getByLabelText('Codex'));
  s.reply(ready);
  next();
  fireEvent.change(screen.getByLabelText('Projects folder'), { target: { value: '' } });
  s.receive({ type: 'app.active', active: true });
  s.reply(ready);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect((screen.getByLabelText('Codex') as HTMLInputElement).checked).toBe(false);
  next();
  expect((screen.getByLabelText('Projects folder') as HTMLInputElement).value).toBe('');
});

test('running setup communicates progress and locks configuration', () => {
  const s = shell(ready);
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  expect(s.sent.at(-1)).toMatchObject({ type: 'setup.run', agents: ['claude', 'codex'], found: ['claude', 'codex'], projects: '~/Developer' });
  expect((screen.getByRole('button', { name: 'Setting up…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/Connecting your agents/);
  expect(screen.getByLabelText('Automatically update robot notes').closest('fieldset')!.disabled).toBe(true);
  s.receive({ type: 'folder.picked', path: '/unexpected' });
  s.receive({ type: 'setup.result', step: 'run', ok: false, json: 'Could not write hooks. Try again.' });
  expect(screen.getByRole('alert').textContent).toMatch(/Could not write hooks/);
  expect((screen.getByRole('button', { name: 'Set up Svall' }) as HTMLButtonElement).disabled).toBe(false);
});

test('successful setup retains actionable warnings before continuing', () => {
  const s = shell(ready);
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  s.receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ warnings: ['Trust the Codex hooks once.'] }) });
  expect(screen.getByText('Svall is set up')).toBeTruthy();
  expect(screen.getByText('Trust the Codex hooks once.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
});

test('Help\'s Send Feedback… opens the form on the setup page, and Esc closes it', async () => {
  setAppStore(createAppStore());
  const s = shell(ready);
  s.receive({ type: 'menu.run', action: 'feedback' });
  expect(screen.getByTestId('feedback-panel')).toBeTruthy();
  expect(await screen.findByText('Diagnostics unavailable')).toBeTruthy();
  fireEvent.keyDown(screen.getByTestId('feedback-text'), { key: 'Escape' });
  expect(screen.queryByTestId('feedback-panel')).toBeNull();
});


test('skips only a single definitely signed-in CLI and keeps sign-in unknown visible', () => {
  shell({ ...ready, agents: [{ ...ready.agents[0]!, signedIn: true }] });
  expect(screen.getByRole('heading', { name: 'Choose where you work' })).toBeTruthy();
});

test('the folder picker names this machine once the shell has, as the id can come with the plan', () => {
  const s = shell(ready);
  s.receive({ type: 'shell.info', home: '/h', log: [], op: false, ghosttyKeys: {}, machine: 'mac-id' });
  next();
  fireEvent.click(screen.getByRole('button', { name: 'Choose a project…' }));
  expect(s.sent.at(-1)).toEqual({ type: 'folder.pick', start: '~/Developer', machine: 'mac-id' });
  s.receive({ type: 'shell.info', home: '/h', log: [], op: false, ghosttyKeys: {}, machine: 'made-since' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose a project…' }));
  expect(s.sent.at(-1)).toEqual({ type: 'folder.pick', start: '~/Developer', machine: 'made-since' });
});

test('collects main agent, project and preferences without writing until the last action', () => {
  const s = shell(ready);
  fireEvent.click(screen.getByRole('radio', { name: 'Codex main' }));
  next();
  fireEvent.click(screen.getByRole('button', { name: 'Choose a project…' }));
  expect(s.sent.at(-1)).toEqual({ type: 'folder.pick', start: '~/Developer' });
  s.receive({ type: 'folder.picked', path: '~/Developer/storefront' });
  expect(screen.getByText('storefront')).toBeTruthy();
  next();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Automatically update robot notes' }));
  expect(s.sent.filter((m) => m.type === 'setup.run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  expect(s.sent.at(-1)).toMatchObject({ type: 'setup.run', mainAgent: 'codex', firstProject: '~/Developer/storefront', scribe: false, svallPermissions: true, newRobotStart: 'agent' });
});

const finishSetup = () => {
  const s = shell(ready);
  s.receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ warnings: ['Trust the Codex hooks once.'] }) });
};

test('a fresh install stays a fresh install for the keys: Setup\'s save names none, and the first window asks Ghostty', () => {
  localStorage.clear();
  window.__svallHome = '/u/.svall';
  finishSetup();
  const store = createAppStore(localAppStorage('/u/.svall'));
  store.getState().setShell({ home: '/u/.svall', log: [], op: false, ghosttyKeys: { 'cmd+t': 'new_split:right' } });
  expect(store.getState().settings.bindings).toEqual({ newRobot: null });
});

test('Setup keeps the keys a fleet has saved', () => {
  localStorage.clear();
  window.__svallHome = '/u/.svall';
  localStorage.setItem('svall.settings@/u/.svall', JSON.stringify({ bindings: { newRobot: 'cmd+n' } }));
  finishSetup();
  expect(localAppStorage('/u/.svall')!.getSavedBindings()).toEqual({ newRobot: 'cmd+n' });
});

describe('the first run forks three ways', () => {
  const FAR = { type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ done: [], warnings: [] }) };
  const hosts = (sent: Array<{ type: string; op?: unknown; args?: unknown }>) => sent.filter((m) => m.type === 'host.start').map((m) => [m.op, m.args]);
  const replaced = vi.fn();
  beforeEach(() => { replaced.mockClear(); vi.stubGlobal('location', { ...window.location, replace: replaced, search: '' }); });
  afterEach(() => vi.unstubAllGlobals());
  const toSsh = (dest: string) => fireEvent.change(screen.getByTestId('fork-ssh'), { target: { value: dest } });

  test('offers running here, installing on a server and connecting, and nothing starts until one is picked', () => {
    const { sent } = shell(ready, { fork: false });
    expect(screen.getByTestId('fork-here').textContent).toBe('Run the fleet on this Mac');
    expect(screen.getByTestId('fork-server').textContent).toBe('Install Svall on a server and connect this Mac');
    expect(screen.getByTestId('fork-join').textContent).toBe('Connect to a fleet already on a server');
    expect(sent.some((m) => m.type === 'setup.run')).toBe(false);
  });

  test('running here is today\'s three steps', () => {
    shell(ready);
    expect(screen.getByText('Connect your agents')).toBeTruthy();
    expect(screen.queryByTestId('fork-ssh')).toBeNull();
  });

  test('connecting sets this Mac up, then joins, and only a join that ended well opens the window, so no first start comes before it', async () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(true);
    toSsh('-oProxyCommand=x');
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(true);
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    expect(sent.at(-1)?.type).toBe('setup.join');
    expect(hosts(sent)).toEqual([]);
    receive(FAR);
    expect(hosts(sent)).toEqual([['join', { name: '', ssh: 'ada@studio' }]]);
    expect(replaced).not.toHaveBeenCalled();
    receive({ type: 'host.step', op: 'join', event: { step: 'snapshot', status: 'ok', detail: "studio's fleet is here" } });
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(replaced).toHaveBeenCalledWith('/');
  });

  test('a join that fails stays here, says why, and tries again; going back forgets it', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'join', event: { step: 'ssh', status: 'fail', detail: 'ssh ada@studio exited 255', action: 'run ssh ada@studio once in Terminal' } });
    receive({ type: 'host.done', op: 'join', code: 1 });
    expect(replaced).not.toHaveBeenCalled();
    expect(screen.getByTestId('fork-steps').textContent).toContain('ssh ada@studio exited 255');
    expect(screen.getByTestId('fork-go').textContent).toBe('Try again');
    fireEvent.click(screen.getByTestId('fork-back'));
    expect(screen.getByTestId('setup-fork')).toBeTruthy();
    expect(hosts(sent)).toHaveLength(1);
  });

  test('installing on a server adds it as a home, then joins it', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@Studio.tailnet.ts.net');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    expect(hosts(sent)).toEqual([['add', { name: 'studio', ssh: 'ada@Studio.tailnet.ts.net', asHome: true }]]);
    receive({ type: 'host.step', op: 'add', event: { step: 'claude', status: 'warn', detail: 'claude is not installed there' } });
    receive({ type: 'host.done', op: 'add', code: 1 });
    expect(hosts(sent)[1]).toEqual(['join', { name: '', ssh: 'ada@Studio.tailnet.ts.net' }]);
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(replaced).toHaveBeenCalledWith('/');
  });

  test('an install that stops joins nothing', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('100.117.42.24');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    expect(hosts(sent)[0]?.[1]).toMatchObject({ name: 'server' });
    receive({ type: 'host.step', op: 'add', event: { step: 'os', status: 'fail', detail: 'not Ubuntu' } });
    receive({ type: 'host.done', op: 'add', code: 1 });
    expect(hosts(sent)).toHaveLength(1);
  });

  test('the server paths say what setup writes, keep an agent turned off off, and send the permissions tick as left', () => {
    const { sent } = shell({ ...ready, integrations: ['claude'] }, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    fireEvent.click(screen.getByText(/Review changes/));
    expect(screen.getByText('Svall adds agent hooks, a background service and the svall command. The hooks only act inside Svall.')).toBeTruthy();
    expect(screen.getByText('Claude Code: hooks, status line and svall permissions')).toBeTruthy();
    expect(screen.queryByText('Codex: hooks')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let robots run svall without asking' }));
    expect(screen.getByText('Claude Code: hooks, status line')).toBeTruthy();
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    expect(sent.at(-1)).toEqual({ type: 'setup.join', svallPermissions: false });
    expect(sent.some((m) => m.type === 'setup.run')).toBe(false);
  });

  test('a Mac with no agent CLI takes either server path, as its robots start on the server; the here path still asks for one', () => {
    const { sent } = shell(missing, { fork: false });
    expect(screen.queryByText(missing.blockers[0])).toBeNull();
    fireEvent.click(screen.getByTestId('fork-join'));
    expect(screen.queryByText(missing.blockers[0])).toBeNull();
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    expect(sent.at(-1)?.type).toBe('setup.join');
  });

  test('a blocker of every path shows on the server paths with a way to check again', () => {
    const shellSilent = 'Your login shell did not answer within 20 seconds, so Svall cannot see where your agent CLIs are. Check again, or run svall setup in a terminal.';
    const { sent, reply } = shell({ ...ready, blockers: [shellSilent] }, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    expect(screen.getByText(shellSilent)).toBeTruthy();
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(sent.filter((m) => m.type === 'setup.plan')).toHaveLength(2);
    reply(ready);
    expect(screen.queryByText(shellSilent)).toBeNull();
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(false);
  });

  test('a recheck while the machine runs are under way asks nothing and leaves Go and Back off, so the add ends in its join', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    fireEvent.focus(window);
    receive({ type: 'app.active', active: true });
    expect(sent.filter((m) => m.type === 'setup.plan')).toHaveLength(1);
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('fork-back').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('fork-back'));
    receive({ type: 'host.done', op: 'add', code: 0 });
    expect(hosts(sent).map(([op]) => op)).toEqual(['add', 'join']);
    receive({ type: 'host.step', op: 'join', event: { step: 'ssh', status: 'fail', detail: 'ssh ada@studio exited 255' } });
    receive({ type: 'host.done', op: 'join', code: 1 });
    fireEvent.focus(window);
    expect(sent.filter((m) => m.type === 'setup.plan')).toHaveLength(2);
  });

  test('Go and Back wait for a recheck to answer', () => {
    const { reply } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.focus(window);
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('fork-back').hasAttribute('disabled')).toBe(true);
    reply();
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(false);
  });

  test('a join that ends badly with no failed row, as one killed, stays here', () => {
    const { receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'join', event: { step: 'enrol', status: 'ok', detail: 'studio issued this machine a token' } });
    receive({ type: 'host.done', op: 'join', code: 143 });
    expect(replaced).not.toHaveBeenCalled();
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(false);
  });

  test('the end of a machine run this screen did not start, or left, does nothing', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    receive({ type: 'host.done', op: 'add', code: 0 });
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(hosts(sent)).toEqual([]);
    expect(replaced).not.toHaveBeenCalled();
  });

  test('the add\'s rows and the join\'s show apart, though they share step names', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { receive } = shell(ready, { fork: false });
      fireEvent.click(screen.getByTestId('fork-server'));
      toSsh('ada@studio');
      fireEvent.click(screen.getByTestId('fork-go'));
      receive(FAR);
      receive({ type: 'host.step', op: 'add', event: { step: 'ssh', status: 'ok', detail: 'ada@studio accepted an interactive login' } });
      receive({ type: 'host.done', op: 'add', code: 0 });
      receive({ type: 'host.step', op: 'join', event: { step: 'ssh', status: 'ok', detail: 'ada@studio accepted an interactive login' } });
      expect(screen.getByTestId('fork-steps').querySelectorAll('[data-step="ssh"]')).toHaveLength(2);
      expect(said.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    } finally { said.mockRestore(); }
  });
});
