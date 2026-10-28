// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { freshStore, sent } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Tips } = await import('../../src/Tips.js');

beforeEach(() => { freshStore(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const page = () => render(
  <>
    <button data-tip="Star">star</button>
    <button data-tip={'Sleep\n• Ends its terminal\n• Opening it resumes'}>sleep</button>
    <span>plain</span>
    <Tips />
  </>,
);
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => screen.queryByTestId('tip');

test('a tip opens after a short pause, then at once on the next control, and its bullets are lines of their own', () => {
  page();
  fireEvent.pointerOver(screen.getByText('star'));
  wait(250);
  expect(tip()).toBeNull();
  wait(50);
  expect(tip()?.textContent).toBe('Star');
  expect(sent.at(-1)?.type).toBe('shell.cutout');

  fireEvent.pointerOver(screen.getByText('sleep'));
  expect([...tip()!.children].map((l) => [l.className, l.textContent])).toEqual([['', 'Sleep'], ['tip-li', '•Ends its terminal'], ['tip-li', '•Opening it resumes']]);

  fireEvent.pointerOver(screen.getByText('plain'));
  expect(tip()).toBeNull();
});

test('a press puts the tip away until the pointer comes onto another control', () => {
  page();
  fireEvent.pointerOver(screen.getByText('star'));
  wait(300);
  fireEvent.pointerDown(screen.getByText('star'));
  expect(tip()).toBeNull();
  fireEvent.pointerOver(screen.getByText('star'));
  wait(1000);
  expect(tip()).toBeNull();

  fireEvent.pointerOver(screen.getByText('plain'));
  wait(1000);
  fireEvent.pointerOver(screen.getByText('sleep'));
  wait(300);
  expect(tip()?.textContent).toContain('Sleep');
});
