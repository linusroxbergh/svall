// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { HandoverEvent } from '../../src/handover.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const bridge = { present: true, send: () => {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ app: { get store() { return store; }, bridge, api: () => ({ call: vi.fn() }) } }));

const { HandoverSheet } = await import('../../src/HandoverSheet.js');
const { HostSetup } = await import('../../src/HostSetup.js');

const freeze: HandoverEvent = { event: 'handover.changed', data: { transactionId: 'tx', phase: 'freeze' } };
const blocked: HandoverEvent = { event: 'handover.blocked', data: { transactionId: 'tx', phase: 'freeze', blockers: [{ code: 'agent_working', message: "Ada's terminal is still working" }] } };

beforeEach(() => {
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  store.getState().setShell({ home: '/h', log: [], op: false, handoverEnabled: true, gateway: 'trift' });
  store.getState().handoverFollow('trift');
});

test('opened by hand, the sheet focuses its close button', () => {
  render(<HandoverSheet />);
  act(() => store.getState().toggleHandover(true));
  expect(document.activeElement).toBe(screen.getByTestId('handover-close'));
});

test('a decision that opens the sheet, or arrives while it is up, puts the focus on its answer', () => {
  render(<HandoverSheet />);
  act(() => { store.getState().handoverEvent(freeze); store.getState().handoverEvent(blocked); });
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));

  // closing leaves the decision waiting, and opening the sheet again goes back to it
  fireEvent.click(screen.getByTestId('handover-close'));
  expect(screen.queryByTestId('handover-sheet')).toBeNull();
  expect(store.getState().handover?.decision?.phase).toBe('freeze');
  act(() => store.getState().toggleHandover());
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));

  fireEvent.click(screen.getByTestId('handover-go'));
  act(() => screen.getByTestId('handover-close').focus());
  act(() => store.getState().handoverEvent(blocked));
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));
});

test('a release blocker opens the machines panel on the Linux machine, in place of the sheet', () => {
  render(<><HandoverSheet /><HostSetup /></>);
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
      { code: 'incompatible_release', message: 'trift runs release 0.5.0, and this Mac 0.6.0' },
    ] } });
  });
  fireEvent.click(screen.getByTestId('handover-upgrade'));
  expect(screen.queryByTestId('handover-sheet')).toBeNull();
  expect((screen.getByTestId('host-name') as HTMLInputElement).value).toBe('trift');
});

test('a folder that holds repositories no character works in blocks on its character until Carry the folder whole is chosen, and the start again carries it', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const message = "c1's terminal is in /Users/ada/Developer, which holds 2 Git repositories no character works in (old-stuff, unrelated), so the handover would carry them too";
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
      { code: 'repository_unused', message, entity: { kind: 'character', id: 'c1' } },
    ] } });
    store.getState().handoverExit(1);
  });
  const row = screen.getByTestId('handover-blocker-repository_unused');
  expect(row.querySelector('.ho-who')?.textContent).toBe('c1');
  expect(row.querySelector('.host-said')?.textContent).toContain(message);
  expect(row.querySelector('em')?.textContent).toBe('Carry the folder whole copies those repositories to trift with it.');
  fireEvent.click(screen.getByTestId('handover-choice-carry'));
  expect(screen.getByTestId('handover-choice-carry').textContent).toBe('Carry the folder whole');
  expect(store.getState().handover?.choices).toEqual({ carryUnused: true });
  fireEvent.click(screen.getByTestId('handover-try-again'));
  expect(send.mock.calls).toContainEqual([{ type: 'handover.start', to: 'trift', choices: { carryUnused: true } }]);
});
