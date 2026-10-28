// @vitest-environment jsdom
import './setup.js';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Token } from '../../src/map/Token.js';
import { chr } from '../fixtures.js';

const none = () => {};
const pointer = { onPointerDown: none };

// svall.dev's demo map and flow scene draw tokens with no app store behind them
test('a token draws without an app store, and shows a failed resume only when told one', () => {
  const props = { c: chr('c0', 'i_b', { x: 1, y: 1 }), status: 'idle' as const, world: { x: 1, y: 1 }, selected: false, dragging: false, hover: false,
    pointer, onHoverStart: none, onHoverEnd: none, onOpen: none, onLink: none, onMenu: none };
  const { rerender } = render(<Token {...props} />);
  expect(screen.getByTestId('token-c0')).toBeTruthy();
  expect(screen.queryByTestId('token-resume-error-c0')).toBeNull();
  rerender(<Token {...props} failed="codex exited back to its shell" />);
  expect(screen.getByTestId('token-resume-error-c0').getAttribute('data-tip')).toBe('codex exited back to its shell');
});

test('a token on a worker wears a band naming the machine across the top of its card', () => {
  const props = { c: chr('c0', 'i_b', { x: 1, y: 1 }), status: 'idle' as const, world: { x: 1, y: 1 }, selected: false, dragging: false, hover: false,
    pointer, onHoverStart: none, onHoverEnd: none, onOpen: none, onLink: none, onMenu: none };
  const { rerender } = render(<Token {...props} />);
  expect(screen.queryByTestId('token-machine-c0')).toBeNull();
  rerender(<Token {...props} machine="linus-vault" />);
  const band = screen.getByTestId('token-machine-c0');
  expect(band.textContent).toBe('on linus-vault');
  expect(band.getAttribute('data-tip')).toBe('Runs on linus-vault');
  expect(band.parentElement?.className).toBe('card');
  expect(band.nextElementSibling?.className).toBe('edge');
});
