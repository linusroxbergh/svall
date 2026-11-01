// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SetupPlan } from '@svall/protocol';
import { afterEach, expect, test } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { Setup } from '../../src/Setup.js';
import { createAppStore } from '../../src/store/index.js';

afterEach(() => { delete window.webkit; });

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

function shell(plan: SetupPlan) {
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    sent.push(JSON.parse(json));
  } } } };
  render(<Setup />);
  const receive = (message: object) => act(() => window.__svall!.receive(JSON.stringify(message)));
  const reply = (next = plan) => receive({ type: 'setup.result', step: 'plan', ok: true, json: JSON.stringify(next) });
  reply();
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
