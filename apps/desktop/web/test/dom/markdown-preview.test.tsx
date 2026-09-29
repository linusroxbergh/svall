// @vitest-environment jsdom
import './setup.js';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('../../src/boot.js', () => ({ app: { bridge: { present: false, send() {}, onMessage: () => () => {} } }, deps: () => ({}) }));
const { MarkdownPreview } = await import('../../src/ide/MarkdownPreview.js');

test('the preview shows the body and leaves the frontmatter out', () => {
  render(<MarkdownPreview id="r:/d" path="plan.md" text={'---\ndescription: When to read.\n---\n# Plan\n'} />);
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
  expect(screen.getByTestId('markdown-preview').textContent).not.toContain('description');
});
