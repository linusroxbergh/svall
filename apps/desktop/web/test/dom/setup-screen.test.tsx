// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SetupPlan } from '@svall/protocol';
import { afterEach, expect, test } from 'vitest';
import { Setup } from '../../src/Setup.js';

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

test('file changes are available on demand and follow the selected agents', () => {
  shell(ready);
  const details = screen.getByText(/Review changes/).closest('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByLabelText('Codex'));
  expect(screen.queryByText('Codex hooks')).toBeNull();
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
  expect(s.sent.at(-1)).toEqual({ type: 'copy', text: 'install-codex' });
});

test('rechecks on native activation, focus and visibility without duplicate in-flight requests', () => {
  const s = shell(missing);
  fireEvent.change(screen.getByLabelText('Projects folder'), { target: { value: '~/work' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  s.receive({ type: 'app.active', active: false });
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(1);
  s.receive({ type: 'app.active', active: true });
  fireEvent.focus(window);
  fireEvent(document, new Event('visibilitychange'));
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true);
  s.reply();
  expect((screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.focus(window);
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(3);
  s.reply(ready);
  expect((screen.getByLabelText('Projects folder') as HTMLInputElement).value).toBe('~/work');
  fireEvent.focus(window);
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(3);
});

test('rechecking preserves existing agent selections and even an intentionally empty folder', () => {
  const blocked = { ...ready, blockers: ['Shell did not answer.'] };
  const s = shell(blocked);
  fireEvent.click(screen.getByLabelText('Codex'));
  fireEvent.change(screen.getByLabelText('Projects folder'), { target: { value: '' } });
  s.receive({ type: 'app.active', active: true });
  s.reply(ready);
  expect((screen.getByLabelText('Codex') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Projects folder') as HTMLInputElement).value).toBe('');
});

test('running setup communicates progress, locks configuration and prevents activation checks', () => {
  const s = shell(ready);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  expect(s.sent.at(-1)).toEqual({ type: 'setup.run', agents: ['claude', 'codex'], found: ['claude', 'codex'], projects: '~/Developer' });
  expect((screen.getByRole('button', { name: 'Setting up…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/Connecting your agents/);
  expect(screen.getByLabelText('Projects folder').closest('fieldset')!.disabled).toBe(true);
  s.receive({ type: 'app.active', active: true });
  s.receive({ type: 'folder.picked', path: '/unexpected' });
  expect(s.sent.filter((m) => m.type === 'setup.plan')).toHaveLength(1);
  expect((screen.getByLabelText('Projects folder') as HTMLInputElement).value).toBe('~/Developer');
  s.receive({ type: 'setup.result', step: 'run', ok: false, json: 'Could not write hooks. Try again.' });
  expect(screen.getByRole('alert').textContent).toMatch(/Could not write hooks/);
  expect((screen.getByRole('button', { name: 'Set up Svall' }) as HTMLButtonElement).disabled).toBe(false);
});

test('successful setup retains actionable warnings before continuing', () => {
  const s = shell(ready);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Svall' }));
  s.receive({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ warnings: ['Trust the Codex hooks once.'] }) });
  expect(screen.getByText('Svall is set up')).toBeTruthy();
  expect(screen.getByText('Trust the Codex hooks once.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
});
