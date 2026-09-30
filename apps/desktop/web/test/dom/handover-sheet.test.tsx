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
  expect((screen.getByTestId('handover-close') as HTMLButtonElement).disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));

  fireEvent.click(screen.getByTestId('handover-go'));
  act(() => screen.getByTestId('handover-close').focus());
  act(() => store.getState().handoverEvent(blocked));
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));
});
