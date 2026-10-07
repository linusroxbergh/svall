// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Character, ContextItem } from '@svall/protocol';
import { beforeEach, expect, test, vi } from 'vitest';
import { chr } from '../fixtures.js';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');
const { Token } = await import('../../src/map/Token.js');

const pr = (n: number, prState: ContextItem['prState']): ContextItem =>
  ({ kind: 'pr', ref: `https://github.com/o/r/pull/${n}`, label: `#${n}`, source: 'auto', prState });
const agent = (monitors?: string[]) => ({ kind: 'claude' as const, sessionId: 's', status: 'idle' as const, lastActivityAt: 1, monitors });

beforeEach(() => { freshStore(); });

const card = (c: Character, onLink = vi.fn()) => {
  render(<Token c={c} status="idle" world={{ x: 0, y: 0 }} selected={false} dragging={false} hover={false} pointer={{} as never}
    onHoverStart={() => {}} onHoverEnd={() => {}} onOpen={() => {}} onLink={onLink} onMenu={() => {}} />);
  return onLink;
};

test('a sidebar row marks a PR in review and a monitor, and names both in its title', () => {
  render(<Sidebar />);
  act(() => store.getState().applyPatch([
    { op: 'replace', path: '/characters/c1/context', value: [pr(41, 'open')] },
    { op: 'add', path: '/characters/c1/agent', value: agent(['m1']) },
  ]));
  const marks = screen.getByTestId('sb-char-c1').querySelector('.sb-ind')!;
  expect(marks.getAttribute('title')).toBe('PR #41 in review · Monitoring');
  expect([...marks.children].map((i) => i.getAttribute('data-kind'))).toEqual(['review', 'monitor']);
  expect(screen.getByTestId('sb-char-c0').querySelector('.sb-ind')).toBeNull();
});

test('a card hangs the PR in review on its left, and a click follows the PR as a link chip does', () => {
  const open = pr(41, 'open');
  const onLink = card(chr('c1', 'i', { x: 0, y: 0 }, { context: [open], agent: agent(['m1']) }));
  expect(screen.getByTestId('token-monitor-c1')).toBeTruthy();
  fireEvent.click(screen.getByTestId('token-review-c1'));
  expect(onLink).toHaveBeenCalledWith(open, 'c1', expect.anything());
});

test('a draft PR and no monitor leave the left of the card bare', () => {
  card(chr('c1', 'i', { x: 0, y: 0 }, { context: [pr(41, 'draft')], agent: agent() }));
  expect(screen.getByTestId('token-c1').querySelector('.rail.left')).toBeNull();
});
