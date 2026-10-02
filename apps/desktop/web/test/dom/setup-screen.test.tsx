// @vitest-environment jsdom
import './setup.js';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Setup } from '../../src/Setup.js';

afterEach(() => { delete window.webkit; });

test('a plan that is not the JSON asked for is shown as it came, not left on the loading line', async () => {
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    if ((JSON.parse(json) as { type: string }).type !== 'setup.plan') return;
    const reply = { type: 'setup.result', step: 'plan', ok: true, json: 'nvm: using node 24\n{}' };
    setTimeout(() => window.__svall!.receive(JSON.stringify(reply)), 0);
  } } } };
  render(<Setup />);
  expect(await screen.findByText(/nvm: using node 24/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
});
