// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { UsageSnapshot, UsageWindow } from '@svall/protocol';
import { call, freshStore } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
const { UsagePanel } = await import('../../src/Usage.js');

let snap: UsageSnapshot;
beforeEach(() => {
  freshStore();
  call.mockImplementation((method: string) => Promise.resolve(method === 'usage.get' ? snap : {}));
});

const win = (key: string, label: string, account?: string): UsageWindow => ({ key, label, pct: 10, ...(account && { account }) });
// each login's name, then the windows under it
const shown = async () => {
  const { unmount } = render(<UsagePanel />);
  await screen.findByTestId('usage-windows');
  const read = screen.getAllByTestId(/^usage-(account|window)$/).map((el) => el.textContent?.replace(/\d+%.*$/, ''));
  unmount();
  return read;
};

test('one login is named once above every window', async () => {
  snap = { available: true, windows: [win('week', 'Week', 'r@x.io'), win('codex:primary', 'Codex 5 hours', 'r@x.io')] };
  expect(await shown()).toEqual(['r@x.io', 'Week', 'Codex 5 hours']);
});

test('each login heads its own windows, in the order the fleet read them', async () => {
  snap = { available: true, windows: [win('week', 'Week', 'd@x.io'), win('week', 'Week', 'r@x.io'), win('codex:primary', 'Codex 5 hours', 'r@x.io'), win('model:0:Fable', 'Fable', 'd@x.io')] };
  expect(await shown()).toEqual(['d@x.io', 'Week', 'Fable', 'r@x.io', 'Week', 'Codex 5 hours']);
});

test('windows whose login is unknown come first, under no name', async () => {
  snap = { available: true, windows: [win('week', 'Week', 'r@x.io'), win('session', 'Session')] };
  expect(await shown()).toEqual(['Session', 'r@x.io', 'Week']);
  snap = { available: true, windows: [win('session', 'Session')] };
  expect(await shown()).toEqual(['Session']);
});
