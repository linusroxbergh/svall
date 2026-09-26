// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ContextItem } from '@archipelago/protocol';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const calls: [string, Record<string, unknown>][] = [];
let refuse: string | undefined;
const call = (method: string, params: Record<string, unknown>) => {
  calls.push([method, params]);
  if (method === 'resources.get') return Promise.resolve({ sources: [] });
  if (method === 'char.prompts') return Promise.resolve({ prompts: ['second ask', 'first ask'] });
  return refuse ? Promise.reject(new Error(refuse)) : Promise.resolve({});
};
let store: AppStore;
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call }), get store() { return store; } } }));
const { CharacterMenu } = await import('../../src/mobile/CharacterMenu.js');

const pr: ContextItem = { kind: 'pr', ref: 'https://github.com/o/r/pull/7', label: 'the PR', source: 'auto', pinned: true };
const plan: ContextItem = { kind: 'file', ref: '~/work/plan.md', label: '', source: 'manual' };
const updates = () => calls.filter(([m]) => m === 'char.update').map(([, p]) => p);

function open(extra: Parameters<typeof chr>[3] = {}) {
  const f = fleet();
  f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { context: [pr, plan], note: 'old note', ...extra });
  store.getState().setFleet(f);
  const onClose = vi.fn();
  render(<CharacterMenu id="c0" onClose={onClose} onClosed={() => {}} />);
  return onClose;
}

beforeEach(() => {
  calls.length = 0;
  refuse = undefined;
  store = createAppStore();
  setAppStore(store);
});

test('a link opens in the browser, and a path on the Mac is only named', () => {
  open();
  expect(screen.getByText('the PR').closest('a')!.getAttribute('href')).toBe(pr.ref);
  expect(screen.getByText('plan.md').closest('a')).toBeNull();
});

test('pins, removes and adds context as the whole list', () => {
  open();
  const { pinned: _, ...unpinned } = pr;
  fireEvent.click(screen.getByRole('button', { name: 'Pin the PR' }));
  expect(updates().at(-1)).toEqual({ id: 'c0', context: [unpinned, plan] });
  fireEvent.click(screen.getByRole('button', { name: 'Pin plan.md' }));
  expect(updates().at(-1)).toEqual({ id: 'c0', context: [pr, { ...plan, pinned: true }] });
  fireEvent.click(screen.getByRole('button', { name: 'Remove plan.md' }));
  expect(updates().at(-1)).toEqual({ id: 'c0', context: [pr] });
  expect(screen.queryByRole('button', { name: 'Remove the PR' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Add a url or path'), { target: { value: ' https://herdr.dev/docs ' } });
  fireEvent.submit(screen.getByLabelText('Add a url or path').closest('form')!);
  expect(updates().at(-1)).toEqual({ id: 'c0', context: [pr, plan, { kind: 'other', ref: 'https://herdr.dev/docs', label: '', source: 'manual' }] });
});

test('a note being typed is saved when the sheet is dismissed', () => {
  const onClose = open();
  const note = screen.getByLabelText('Note');
  note.focus();
  fireEvent.change(note, { target: { value: 'new note' } });
  fireEvent.pointerDown(document.querySelector('.sheet-back')!);
  expect(updates()).toEqual([{ id: 'c0', note: 'new note' }]);
  expect(onClose).toHaveBeenCalled();
});

test('a refused edit says why beside it', async () => {
  refuse = 'fleet is read-only';
  open();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pin the PR' })); });
  expect(screen.getByText('fleet is read-only')).toBeTruthy();
});

test('reads the prompts sent, newest first, and steps back through them', async () => {
  await act(async () => { open({ agent: { kind: 'claude', status: 'idle', sessionId: 's1', lastActivityAt: 0 } as never }); });
  expect(screen.getByText('second ask')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Earlier command' }));
  expect(screen.getByText('first ask')).toBeTruthy();
  expect(screen.getByText('2/2')).toBeTruthy();
});
