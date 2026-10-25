// @vitest-environment jsdom
import './setup.js';
import { getOriginalDoc } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Diff } from '../../src/ide/Diff.js';

const lines = (first: string, last = 'end') => [first, ...Array.from({ length: 20 }, (_, i) => `same ${i}`), last, ''].join('\n');

test('a refreshed diff changes its view in place, so a stretch the user unfolded stays open', async () => {
  const { container, rerender } = render(<Diff path="notes" before={lines('a')} after={lines('b')} />);
  await waitFor(() => expect(container.querySelector('.cm-collapsedLines')).not.toBeNull());
  const editor = container.querySelector<HTMLElement>('.cm-editor')!;
  fireEvent.click(container.querySelector('.cm-collapsedLines')!);
  expect(container.querySelector('.cm-collapsedLines')).toBeNull();
  // the refresh changes the first line only, outside the stretch that was unfolded
  rerender(<Diff path="notes" before={lines('A')} after={lines('c')} />);
  expect(container.querySelector('.cm-editor')).toBe(editor);
  expect(container.querySelector('.cm-collapsedLines')).toBeNull();
  const state = EditorView.findFromDOM(editor)!.state;
  expect(state.doc.toString()).toBe(lines('c'));
  expect(getOriginalDoc(state).toString()).toBe(lines('A'));
});

test('sides that arrive while the language still loads are the ones shown', async () => {
  const { container, rerender } = render(<Diff path="notes.ts" before={lines('a')} after={lines('b')} />);
  rerender(<Diff path="notes.ts" before={lines('A')} after={lines('c')} />);
  await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
  const state = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!.state;
  expect(state.doc.toString()).toBe(lines('c'));
  expect(getOriginalDoc(state).toString()).toBe(lines('A'));
});
