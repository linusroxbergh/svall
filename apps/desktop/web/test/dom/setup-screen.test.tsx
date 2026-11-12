// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SetupPlan } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stepLabel } from '../../src/host.js';
import { setAppStore } from '../../src/hooks.js';
import { Setup } from '../../src/Setup.js';
import { createAppStore, localAppStorage } from '../../src/store/index.js';

afterEach(() => { delete window.webkit; delete window.__svallHome; });
// as main.tsx starts the setup page
setAppStore(createAppStore());

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

test('file changes are available on demand and follow the selected agents', async () => {
  shell(ready);
  fireEvent.click(screen.getByLabelText('Codex'));
  next(); next();
  const details = screen.getByText(/Review changes/).closest('details')!;
  expect(details.open).toBe(false);
  // folded as the app's other folds, behind a caret
  expect([details.className, !!details.querySelector('summary > svg')]).toEqual(['modal-more', true]);
  expect(screen.queryByText('Codex: hooks')).toBeNull();
  expect(screen.getByText('2 locations')).toBeTruthy();
  const shown = vi.spyOn(details, 'scrollIntoView');
  fireEvent.click(screen.getByText(/Review changes/));
  expect(details.open).toBe(true);
  expect(screen.getByText('~/.claude/settings.json')).toBeTruthy();
  // the list comes into view, above the buttons pinned at the window's foot
  await waitFor(() => expect(shown).toHaveBeenCalledWith({ block: 'nearest' }));
});

test('the background service is listed by what it does, its launchd file nowhere in the window', () => {
  const plist = '/Users/test/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist';
  shell({ ...ready, writes: [...ready.writes, { what: "Svall's background service", path: plist }] });
  next(); next();
  fireEvent.click(screen.getByText(/Review changes/));
  expect(screen.getByText('4 locations')).toBeTruthy();
  expect(screen.getByText("Svall's background service").closest('li')!.textContent).toBe("Svall's background serviceruns your robots while Svall is open");
  expect(document.body.textContent).not.toMatch(/plist|LaunchAgents|svalld/);
  expect(screen.getByText('~/.svall')).toBeTruthy();
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

test('a check or a setup that fails says the CLI\'s sentence, and what a tool said waits behind details', () => {
  const said = () => { const alert = screen.getByRole('alert'); return [alert.querySelector('.said > div > span')!.textContent, alert.querySelector('details')?.textContent]; };
  window.webkit = { messageHandlers: { svall: { postMessage() {} } } };
  const { unmount } = render(<Setup />);
  act(() => window.__svall!.receive(JSON.stringify({ type: 'setup.result', step: 'plan', ok: false, json: 'svall: the login shell did not answer\n  zsh: command not found: brew\n' })));
  expect(said()).toEqual(['svall: the login shell did not answer', 'detailszsh: command not found: brew']);
  unmount();
  const s = shell(ready);
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  s.receive({ type: 'setup.result', step: 'run', ok: false, json: 'svall: hooks could not be written: Command failed: chmod 600 /u/.claude' });
  expect(said()).toEqual(['svall: hooks could not be written', 'detailsCommand failed: chmod 600 /u/.claude']);
});

test('successful setup retains actionable warnings before continuing, each a row with a warning mark', () => {
  const s = shell(ready);
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  s.receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ warnings: ['Trust the Codex hooks once.'] }) });
  expect(screen.getByText('Svall is set up')).toBeTruthy();
  expect(screen.getByText('Trust the Codex hooks once.').closest('.said')!.getAttribute('data-mark')).toBe('warn');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
});

test('a warning sets the commands the CLI marks, and a link, in mono, with no backticks', () => {
  const s = shell(ready);
  next(); next();
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  s.receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ warnings: ['Codex asks once to trust these hooks: start `codex` and choose "Trust all and continue", or trust them in `/hooks`', 'See https://svall.dev/docs.'] }) });
  const lines = [...document.querySelectorAll('.said > div > span:first-child')];
  expect(lines.map((l) => [l.textContent, [...l.querySelectorAll('code')].map((c) => c.textContent)])).toEqual([
    ['Codex asks once to trust these hooks: start codex and choose "Trust all and continue", or trust them in /hooks', ['codex', '/hooks']],
    ['See https://svall.dev/docs.', ['https://svall.dev/docs']],
  ]);
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


test('step 1 says whether each agent is logged in, and offers to log in where it is not or cannot tell', () => {
  shell({ ...ready, agents: [{ ...ready.agents[0]!, signedIn: true }, { ...ready.agents[1]!, signedIn: false }, { kind: 'opencode', path: '/usr/local/bin/opencode' }] });
  expect(screen.getByText('Logged in')).toBeTruthy();
  expect(screen.getByText('Not logged in')).toBeTruthy();
  expect(screen.getByText('Could not tell')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Log in…' })).toHaveLength(2);
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

  test('offers running here, setting a server up and connecting to one, each with its line, and nothing starts until one is picked', () => {
    const { sent } = shell(ready, { fork: false });
    expect(screen.getByRole('heading', { name: 'Where should your fleet run?' })).toBeTruthy();
    expect(screen.getByText('The machine that runs the fleet is its home. You can change it later in Settings → Machines.')).toBeTruthy();
    expect(screen.getByTestId('fork-here').textContent).toBe('This MacRobots run here and rest while this Mac sleeps.');
    expect(screen.getByTestId('fork-server').textContent).toBe('A server, set up nowrecommendedSvall installs itself on a Linux server over ssh. The fleet runs all day; this Mac connects to it.');
    expect(screen.getByTestId('fork-server').querySelector('.badge')?.textContent).toBe('recommended');
    expect(screen.getByTestId('fork-join').textContent).toBe('A server that already runs your fleetThis Mac joins it.');
    expect(sent.some((m) => m.type === 'setup.run')).toBe(false);
  });

  test('a server path asks for the server under its own label, says what it needs, and offers to set it up or connect', () => {
    shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    expect(screen.getByRole('heading', { name: 'Set up a server' })).toBeTruthy();
    expect(screen.getByText('Needs Tailscale on this Mac and on the server.')).toBeTruthy();
    const field = screen.getByLabelText(/^server/);
    expect(field).toBe(screen.getByTestId('fork-ssh'));
    expect(field.className).toBe('fld mono');
    expect(field.closest('label')!.textContent).toContain('What you type after ssh, such as you@studio.');
    expect(screen.getByRole('checkbox', { name: 'Notify me when an agent needs me' }).closest('.setup-list')).toBe(screen.getByRole('checkbox', { name: 'Let robots run svall without asking' }).closest('.setup-list'));
    expect(screen.getByTestId('fork-go').textContent).toBe('Set up and connect');
    fireEvent.click(screen.getByTestId('fork-back'));
    fireEvent.click(screen.getByTestId('fork-join'));
    expect(screen.getByRole('heading', { name: 'Connect to your server' })).toBeTruthy();
    expect(screen.getByTestId('fork-go').textContent).toBe('Connect');
  });

  test('running here is today\'s three steps', () => {
    shell(ready);
    expect(screen.getByText('Connect your agents')).toBeTruthy();
    expect(screen.queryByTestId('fork-ssh')).toBeNull();
  });

  test('Connect stays off until the server\'s ssh destination is typed, and its tip on the setup page says so', async () => {
    shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    const go = screen.getByTestId('fork-go');
    fireEvent.pointerOver(go);
    expect((await screen.findByTestId('tip')).textContent).toBe("Needs the server's ssh destination");
    toSsh('ada@studio');
    expect([go.hasAttribute('disabled'), go.hasAttribute('data-tip')]).toEqual([false, false]);
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

  test('a server path keeps the notification ask, and shows Setup\'s warnings once the join lands', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notify me when an agent needs me' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notify me when an agent needs me' }));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ done: [], warnings: ['Trust the Codex hooks once.'] }) });
    expect(sent.filter((m) => m.type === 'notify.enable')).toHaveLength(1);
    expect(screen.queryByText('Trust the Codex hooks once.')).toBeNull();
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(screen.getByText('Trust the Codex hooks once.')).toBeTruthy();
    expect(replaced).not.toHaveBeenCalled();
  });

  test('a join that fails stays here, says why, and tries again; Back gives the form back filled, and Back again forgets it', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'join', event: { step: 'ssh', status: 'fail', detail: 'this machine cannot log in to ada@studio', action: 'run ssh ada@studio once from this machine', raw: 'ssh ada@studio exited 255: Permission denied' } });
    receive({ type: 'host.done', op: 'join', code: 1 });
    expect(replaced).not.toHaveBeenCalled();
    const failed = screen.getByTestId('fork-steps').querySelector('li[data-status="fail"]')!;
    expect(failed.querySelector('.said > div > span')!.textContent).toBe('this Mac cannot log in to ada@studio');
    expect(failed.querySelector('.modal-sub')!.textContent).toBe('run ssh ada@studio once from this Mac');
    expect(failed.querySelector('details')!.textContent).toContain('Permission denied');
    expect(screen.getByTestId('fork-go').textContent).toBe('Try again');
    fireEvent.click(screen.getByTestId('fork-back'));
    expect((screen.getByTestId('fork-ssh') as HTMLInputElement).value).toBe('ada@studio');
    expect(screen.queryByTestId('fork-steps')).toBeNull();
    fireEvent.click(screen.getByTestId('fork-back'));
    expect(screen.getByTestId('setup-fork')).toBeTruthy();
    expect(hosts(sent)).toHaveLength(1);
  });

  test('a failed step whose fix is a command for the server keeps it behind details, ahead of what a tool said', () => {
    const { receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'join', event: { step: 'home', status: 'fail', detail: 'Tailscale is not running on ada@studio', action: 'start it: sudo systemctl start tailscaled', run: 'sudo systemctl start tailscaled', raw: 'tailscaled is stopped' } });
    receive({ type: 'host.done', op: 'join', code: 1 });
    const failed = screen.getByTestId('fork-steps').querySelector('li[data-status="fail"]')!;
    expect(failed.querySelector('.said > div > span')!.textContent).toBe('Tailscale is not running on ada@studio');
    expect(failed.querySelector('.modal-sub')).toBeNull();
    expect(failed.querySelector('.modal-more-body.mono')!.textContent).toBe('start it: sudo systemctl start tailscaled\ntailscaled is stopped');
  });

  test('a failed step\'s fix says its link in mono', () => {
    const { receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'add', event: { step: 'tailscale', status: 'fail', detail: 'this Mac has no Tailscale', action: 'Install it from https://tailscale.com/download and sign in' } });
    receive({ type: 'host.done', op: 'add', code: 1 });
    const fix = screen.getByTestId('fork-steps').querySelector('li[data-status="fail"] .modal-sub')!;
    expect([fix.textContent, fix.querySelector('code')?.textContent]).toEqual(['Install it from https://tailscale.com/download and sign in', 'https://tailscale.com/download']);
  });

  test('installing on a server adds it as a home, then joins it', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@Studio.tailnet.ts.net');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    expect(hosts(sent)).toEqual([['add', { name: 'studio', ssh: 'ada@Studio.tailnet.ts.net', asHome: true }]]);
    receive({ type: 'host.step', op: 'add', event: { step: 'claude', status: 'warn', detail: 'claude is not installed there' } });
    receive({ type: 'host.step', op: 'add', event: { step: 'registry', status: 'ok', detail: 'studio is in this Mac\'s list of machines' } });
    receive({ type: 'host.done', op: 'add', code: 1 });
    expect(hosts(sent)[1]).toEqual(['join', { name: '', ssh: 'ada@Studio.tailnet.ts.net' }]);
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(replaced).toHaveBeenCalledWith('/');
  });

  test.each([1, 137])('an install that died with exit %i before its last step, a failure row or none, joins nothing, and says it stopped', (code) => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'add', event: { step: 'upload', status: 'start' } });
    receive({ type: 'host.done', op: 'add', code });
    expect(hosts(sent)).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(`exit ${code}`);
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(false);
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

  test('a recheck while the machine runs are under way asks nothing, and only Stop shows, so the add ends in its join', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    fireEvent.focus(window);
    receive({ type: 'app.active', active: true });
    expect(sent.filter((m) => m.type === 'setup.plan')).toHaveLength(1);
    expect(screen.queryByTestId('fork-go')).toBeNull();
    expect(screen.queryByTestId('fork-back')).toBeNull();
    expect(screen.getByTestId('fork-stop')).toBeTruthy();
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

  test('a run shows what needs a person and the step under way, and folds its notes and its done steps, by the tiers of an add and of a join', () => {
    const { receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    expect(screen.getByRole('heading', { name: 'Set up a server' })).toBeTruthy();
    expect(screen.getByText('ada@studio')).toBeTruthy();
    expect(screen.queryByTestId('fork-ssh')).toBeNull();
    expect(screen.queryByText(/Review changes/)).toBeNull();
    expect(screen.getByTestId('fork-now').textContent).toBe('Svall on this Mac…');
    receive(FAR);
    const step = (op: string, event: object) => receive({ type: 'host.step', op, event });
    step('add', { step: 'ssh', status: 'start' });
    expect(screen.getByTestId('fork-now').textContent).toBe(`${stepLabel('ssh')}…`);
    step('add', { step: 'ssh', status: 'ok', detail: 'logs in' });
    step('add', { step: 'home', status: 'ok', detail: '/home/ada' });
    step('add', { step: 'tmux', status: 'warn', detail: '3.4: Shift+Enter needs 3.5' });
    step('add', { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'ssh ada@studio, then loginctl enable-linger' });
    step('add', { step: 'os', status: 'start' });
    const list = screen.getByTestId('fork-steps');
    expect([...list.querySelectorAll('li')].map((li) => li.getAttribute('data-step') ?? li.getAttribute('data-testid'))).toEqual(['linger', 'fork-now']);
    // the command to run on the server waits behind details, in mono, as this window opens no terminal there
    expect(list.querySelector('[data-step="linger"] .said > div > span')!.textContent).toBe('off: the fleet stops when you log out');
    expect(list.querySelector('[data-step="linger"] .modal-sub')).toBeNull();
    expect(list.querySelector('[data-step="linger"] .modal-more-body.mono')!.textContent).toBe('ssh ada@studio, then loginctl enable-linger');
    expect(screen.getByTestId('fork-now').textContent).toBe(`${stepLabel('os')}…`);
    expect(screen.getByTestId('fork-notes').textContent).toBe('1 note');
    expect(screen.getByTestId('fork-done').textContent).toBe('2 steps done');
    fireEvent.click(screen.getByTestId('fork-notes'));
    expect(list.querySelector('[data-step="tmux"]')!.textContent).toBe(`${stepLabel('tmux')}3.4: Shift+Enter needs 3.5`);
    step('add', { step: 'os', status: 'ok', detail: 'Ubuntu 24.04 LTS, x86-64' });
    step('add', { step: 'registry', status: 'ok', detail: 'listed' });
    receive({ type: 'host.done', op: 'add', code: 1 });
    // a join is a flow: its warning needs a person, but for the offer to copy the agent setup
    step('join', { step: 'home', status: 'ok', detail: 'ada@studio is the fleet\'s home, on release 0.9.4' });
    step('join', { step: 'tailscale', status: 'warn', detail: 'Tailscale on this Mac is signed out' });
    step('join', { step: 'seed', status: 'warn', detail: 'this Mac\'s agent setup was not copied to studio' });
    expect([...list.querySelectorAll('ol')[0]!.querySelectorAll('li')].map((li) => li.getAttribute('data-step') ?? li.getAttribute('data-testid'))).toEqual(['linger', 'tailscale', 'fork-now']);
    expect(screen.getByTestId('fork-notes').textContent).toBe('2 notes');
    fireEvent.click(screen.getByTestId('fork-done'));
    // a done step says its name alone; the join's home is the fleet's, the add's the home folder. A flow's done steps come first
    expect(list.firstElementChild).toBe(screen.getByTestId('fork-done'));
    const done = list.querySelectorAll('ol')[0];
    expect(done.querySelector('.said')).toBeNull();
    expect([...done.querySelectorAll('li')].map((li) => li.textContent)).toEqual([stepLabel('ssh'), stepLabel('home'), stepLabel('os'), stepLabel('registry'), 'The home']);
  });

  test('Stop cancels the machine run, and a run it stopped joins nothing and ends on Try again and Back', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-server'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    receive({ type: 'host.step', op: 'add', event: { step: 'upload', status: 'start' } });
    fireEvent.click(screen.getByTestId('fork-stop'));
    expect(sent.at(-1)).toEqual({ type: 'host.cancel' });
    expect(screen.getByTestId('fork-stop').textContent).toBe('Stopping…');
    expect(screen.getByTestId('fork-stop').hasAttribute('disabled')).toBe(true);
    // the add ran through as the Stop went out
    receive({ type: 'host.done', op: 'add', code: 0 });
    expect(hosts(sent)).toHaveLength(1);
    expect(screen.getByTestId('fork-ended').textContent).toBe('Stopped');
    expect(screen.getByTestId('fork-go').textContent).toBe('Try again');
    expect(screen.getByTestId('fork-back')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    expect(hosts(sent)).toHaveLength(2);
    expect(screen.queryByTestId('fork-ended')).toBeNull();
  });

  test('a join that ends well as Stop goes out has joined, and opens the window', () => {
    const { receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive(FAR);
    fireEvent.click(screen.getByTestId('fork-stop'));
    receive({ type: 'host.done', op: 'join', code: 0 });
    expect(replaced).toHaveBeenCalledWith('/');
  });

  test('Stop while this Mac is set up starts no machine run', () => {
    const { sent, receive } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    fireEvent.click(screen.getByTestId('fork-stop'));
    receive(FAR);
    expect(hosts(sent)).toEqual([]);
    expect(screen.getByTestId('fork-ended').textContent).toBe('Stopped');
    expect(screen.getByTestId('fork-go').hasAttribute('disabled')).toBe(false);
  });

  test('this Mac\'s setup failing on a server path is its run\'s failed row, the tool\'s words behind details, and a recheck leaves it', () => {
    const { sent, receive, reply } = shell(ready, { fork: false });
    fireEvent.click(screen.getByTestId('fork-join'));
    toSsh('ada@studio');
    fireEvent.click(screen.getByTestId('fork-go'));
    receive({ type: 'setup.result', step: 'run', ok: false, json: 'svall: hooks could not be written: Command failed: chmod 600 /u/.claude' });
    const row = () => screen.getByTestId('fork-steps').querySelector('li[data-step="setup"]')!;
    expect(row().querySelector('.said > div > span')!.textContent).toBe('svall: hooks could not be written');
    expect(row().textContent).toMatch(/^Svall on this Mac/);
    expect(row().querySelector('details')!.textContent).toContain('chmod 600');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.focus(window);
    expect(sent.filter((m) => m.type === 'setup.plan')).toHaveLength(2);
    reply();
    expect(row()).toBeTruthy();
    expect(hosts(sent)).toEqual([]);
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
      fireEvent.click(screen.getByTestId('fork-done'));
      expect(screen.getByTestId('fork-steps').querySelectorAll('[data-step="ssh"]')).toHaveLength(2);
      expect(said.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    } finally { said.mockRestore(); }
  });
});
