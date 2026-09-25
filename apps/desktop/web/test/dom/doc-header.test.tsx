// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { dropBuffers, editBuffer, getBuffer, loadBuffer } from '../../src/ide/buffers.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';

const ROOT = 'r:/d/islands/i1';
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ app: { get store() { return store; } } }));
const { DocHeader } = await import('../../src/resources/DocHeader.js');

beforeEach(() => {
  dropBuffers(ROOT);
  store = createAppStore();
  setAppStore(store);
  loadBuffer(ROOT, 'a.md', '---\ndescription: \n---\n\n', 1, []);
});

test('typing in the field writes the description line and flags the doc unsaved', () => {
  render(<DocHeader id={ROOT} path="a.md" focus={false} />);
  const field = screen.getByTestId('resources-doc-description') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Before the billing code: read it' } });
  expect(getBuffer(ROOT, 'a.md')!.state.doc.toString()).toBe('---\ndescription: "Before the billing code: read it"\n---\n\n');
  expect(field.value).toBe('Before the billing code: read it');
  expect(store.getState().ide[ROOT].dirty).toContain('a.md');
});

test('the field follows the text when the frontmatter is edited elsewhere', () => {
  render(<DocHeader id={ROOT} path="a.md" focus={false} />);
  act(() => { editBuffer(ROOT, 'a.md', { changes: { from: 17, insert: 'from the text' } }); });
  expect((screen.getByTestId('resources-doc-description') as HTMLInputElement).value).toBe('from the text');
});

test('a doc just made takes the keys in its field', () => {
  render(<DocHeader id={ROOT} path="a.md" focus />);
  expect(document.activeElement).toBe(screen.getByTestId('resources-doc-description'));
});

test('Enter puts the cursor at the start of the body', () => {
  render(<DocHeader id={ROOT} path="a.md" focus={false} />);
  fireEvent.keyDown(screen.getByTestId('resources-doc-description'), { key: 'Enter' });
  expect(getBuffer(ROOT, 'a.md')!.state.selection.main.head).toBe(22);
});
