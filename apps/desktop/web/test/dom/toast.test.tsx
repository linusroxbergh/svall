// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridge, freshStore, sent, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Toast } = await import('../../src/Toast.js');

beforeEach(() => {
  freshStore();
  // jsdom lays nothing out, and a hole that measures as nothing is left out
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 26, top: 700, width: 200, height: 40 } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); });

const last = () => sent.filter((m) => m.type === 'shell.cutout').at(-1);
const hole = { x: 26, y: 700, width: 200, height: 40 };

test('a toast with nothing to press shows through the terminal and leaves the presses there to it', () => {
  render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [hole] });
  act(() => store.getState().clearToast());
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
});

test('a toast with an action takes the presses in its hole, and gives them back once it has none', () => {
  render(<Toast />);
  act(() => store.getState().showToast('started, prompt not sent', 'error', { label: 'Send it', run() {} }));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [hole], passive: [] });
  act(() => store.getState().showToast('no such file'));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [hole] });
});
