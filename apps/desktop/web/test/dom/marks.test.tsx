// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Character, ContextItem } from '@svall/protocol';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DisplayStatus } from '../../src/selectors.js';
import { chr } from '../fixtures.js';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');
const { Token } = await import('../../src/map/Token.js');

const pr = (n: number, prState: ContextItem['prState']): ContextItem =>
  ({ kind: 'pr', ref: `https://github.com/o/r/pull/${n}`, label: `#${n}`, source: 'auto', prState });
const agent = (monitors?: string[]) => ({ kind: 'claude' as const, sessionId: 's', status: 'idle' as const, lastActivityAt: 1, monitors });

beforeEach(() => { freshStore(); });

const card = (c: Character, { onLink = vi.fn(), status = 'idle' as DisplayStatus, robots = false, links = false } = {}) => {
  render(<Token c={c} status={status} world={{ x: 0, y: 0 }} robots={robots} links={links} selected={false} dragging={false} hover={false} pointer={{} as never}
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

test('a card marks a PR in review and a monitor on its corner, and a click follows the PR as a link chip does', () => {
  const open = pr(41, 'open');
  const onLink = card(chr('c1', 'i', { x: 0, y: 0 }, { context: [open], agent: agent(['m1']) }), { status: 'blocked', robots: true });
  const marks = screen.getByTestId('token-c1').querySelector('.corner .marks')!;
  expect([...marks.children].map((m) => m.className)).toEqual(['mark review', 'mark monitor']);
  fireEvent.click(screen.getByTestId('token-review-c1'));
  expect(onLink).toHaveBeenCalledWith(open, 'c1', expect.anything());
});

test('a draft PR and no monitor leave the card without marks', () => {
  card(chr('c1', 'i', { x: 0, y: 0 }, { context: [pr(41, 'draft')], agent: agent() }));
  expect(screen.getByTestId('token-c1').querySelector('.mark')).toBeNull();
});

test('a card shows its link chips only when asked to', () => {
  const c = chr('c1', 'i', { x: 0, y: 0 }, { context: [pr(41, 'draft')] });
  card(c);
  expect(screen.getByTestId('token-c1').querySelector('.chip.lk')).toBeNull();
  cleanup();
  card(c, { links: true });
  expect(screen.getByTestId('token-c1').querySelectorAll('.chip.lk')).toHaveLength(1);
});

test('a working card spells its status out as done and blocked do', () => {
  card(chr('c1', 'i', { x: 0, y: 0 }, { agent: agent() }), { status: 'working' });
  const word = screen.getByTestId('token-c1').querySelector('.foot .sw')!;
  expect(word.textContent).toBe('working');
  expect(word.getAttribute('data-status')).toBe('working');
});
