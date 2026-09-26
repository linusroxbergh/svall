import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test('a codex character takes its first prompt as an argument and reports through codex hooks', async ({ page, archi }) => {
  await archi.open('board');
  const island = await archi.api.call('island.create', { name: archi.uniq('codex') });
  // a plain character stays viewed, so codex's `done` is not marked seen the instant it lands
  await archi.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const c = await archi.api.call('char.create', { islandId: island.id, cwd: archi.home, command: 'codex', run: 'fix the flaky test' });
  await expect.poll(async () => (await archi.api.call('state.get', {})).characters[c.id].agent?.status).toBe('done');
  expect((await archi.api.call('state.get', {})).characters[c.id].agent?.kind).toBe('codex');
  expect(JSON.parse(fs.readFileSync(path.join(archi.home, 'fake-codex', `${c.id}.argv`), 'utf8'))).toEqual(['--', 'fix the flaky test']);
  await expect(page.getByTestId(`sb-char-${c.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
});
