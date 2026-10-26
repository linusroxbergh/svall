// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { readStep, Tour } = await import('../../src/Tour.js');

beforeEach(() => { localStorage.clear(); window.__svallHome = '/u/.svall'; freshStore(); });
afterEach(() => { vi.restoreAllMocks(); delete window.__svallHome; });

test('the tour is offered on a first run and not on a machine with settings under its fleet key or the unscoped one', () => {
  expect(readStep()).toBe(0);
  localStorage.setItem('svall.settings@/u/.svall', '{}');
  expect(readStep()).toBeGreaterThan(0);
  localStorage.clear();
  localStorage.setItem('svall.settings', '{}');
  expect(readStep()).toBeGreaterThan(0);
});

test('a step kept from last time is where the tour goes on, and done is done', () => {
  localStorage.setItem('svall.tour', '2');
  expect(readStep()).toBe(2);
  localStorage.setItem('svall.tour', 'done');
  expect(readStep()).toBeGreaterThan(2);
});

test('a store switched off offers no tour rather than throwing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('site data switched off'); });
  expect(readStep()).toBeGreaterThan(0);
});

test('the tour selects its first robot once, so a robot shown after a sheet closes stays selected', () => {
  render(<Tour />);
  expect(store.getState().selectedId).toBe('c1');
  act(() => store.getState().setNamingRobot(true));
  act(() => store.getState().focus('c2'));
  act(() => store.getState().setNamingRobot(false));
  expect(store.getState().selectedId).toBe('c2');
});

test('with its anchor out of sight the tour still offers its buttons, and Escape ends it for good', () => {
  const { queryByTestId } = render(<Tour />);
  expect(queryByTestId('tour-next')).not.toBeNull();
  expect(queryByTestId('tour-skip')).not.toBeNull();
  const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  // a dialog over the page keeps its own Escape
  act(() => store.getState().setMissionPrompt(true));
  esc();
  expect(queryByTestId('tour')).not.toBeNull();
  act(() => store.getState().setMissionPrompt(false));
  esc();
  expect(queryByTestId('tour')).toBeNull();
  expect(localStorage.getItem('svall.tour')).toBe('done');
});
