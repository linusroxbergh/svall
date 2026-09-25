// @vitest-environment jsdom
import './setup.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Sheet } from '../../src/mobile/Sheet.js';

test('the sheet is a dialog carrying its title and its children', () => {
  render(<Sheet title="Docs" onClose={() => {}}><p>a doc</p></Sheet>);
  expect(screen.getByRole('dialog', { name: 'Docs' })).toBeTruthy();
  expect(screen.getByText('a doc')).toBeTruthy();
});

test('the close button closes it', () => {
  const onClose = vi.fn();
  render(<Sheet title="Docs" onClose={onClose}><p>a doc</p></Sheet>);
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(onClose).toHaveBeenCalled();
});

test('a press on the dimmed list behind it closes it', () => {
  const onClose = vi.fn();
  const { container } = render(<Sheet title="Docs" onClose={onClose}><p>a doc</p></Sheet>);
  fireEvent.pointerDown(container.querySelector('.sheet-back')!);
  expect(onClose).toHaveBeenCalled();
});

test('a press inside it stays inside', () => {
  const onClose = vi.fn();
  render(<Sheet title="Docs" onClose={onClose}><p>a doc</p></Sheet>);
  fireEvent.pointerDown(screen.getByRole('dialog'));
  expect(onClose).not.toHaveBeenCalled();
});
