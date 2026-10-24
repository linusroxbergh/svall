// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { HostSetup } = await import('../../src/HostSetup.js');

beforeEach(() => {
  freshStore();
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, handoverEnabled: true, gateway: 'trift' });
});

test('opened to add a machine, the panel asks its name and ssh, and the run it starts is that machine\'s', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true));
  for (const id of ['host-name', 'host-ssh']) {
    expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => screen.getByTestId(id).getAttribute(a)), id).toEqual(['off', 'off', 'false', 'off']);
  }
  fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'studio' } });
  fireEvent.change(screen.getByTestId('host-ssh'), { target: { value: 'ada@studio' } });
  fireEvent.click(screen.getByTestId('host-add'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'ada@studio' } });
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('studio');
});

test('opened on a machine, the panel names it once and acts on it without asking its name', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true, 'trift'));
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.queryByTestId('host-ssh')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('trift');
  fireEvent.click(screen.getByTestId('machine-upgrade'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });
  // one run at a time
  expect((screen.getByTestId('machine-doctor') as HTMLButtonElement).disabled).toBe(true);
});
test('every step that failed offers a way on: what the step said to do, or the run again', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'tmux', status: 'fail', detail: 'tmux is not installed' });
    store.getState().hostStep('doctor', { step: 'linger', status: 'fail', detail: 'off', action: 'ssh ada@trift, then loginctl enable-linger ada' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-action-linger').textContent).toBe('ssh ada@trift, then loginctl enable-linger ada');
  expect(screen.queryByTestId('host-again-linger')).toBeNull();
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again-tmux'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});
