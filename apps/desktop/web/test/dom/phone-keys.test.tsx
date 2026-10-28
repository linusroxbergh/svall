// @vitest-environment jsdom
import './setup.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { KeysSheet } from '../../src/mobile/KeysSheet.js';

test('a row sends its key and the sheet goes', () => {
  const onKey = vi.fn();
  const onClose = vi.fn();
  render(<KeysSheet kind="claude" fontSize={11} onKey={onKey} onSize={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: /cycle permission mode/ }));
  expect(onKey).toHaveBeenCalledWith('\x1b[Z');
  expect(onClose).toHaveBeenCalled();
});

test('the text size steps from the sheet and the sheet stays', () => {
  const onSize = vi.fn();
  const onClose = vi.fn();
  render(<KeysSheet kind={undefined} fontSize={11} onKey={() => {}} onSize={onSize} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Larger text' }));
  expect(onSize).toHaveBeenCalledWith(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText('Claude Code')).toBeNull();
});
