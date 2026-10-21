// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { freshStore } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { readStep } = await import('../../src/Tour.js');

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
