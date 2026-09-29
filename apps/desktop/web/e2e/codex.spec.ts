import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test('a codex character takes its first prompt as an argument and reports through codex hooks', async ({ page, svall }) => {
  await svall.open('board');
  const island = await svall.api.call('island.create', { name: svall.uniq('codex') });
  // a plain character stays viewed, so codex's `done` is not marked seen the instant it lands
  await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: svall.home, command: 'codex', run: 'fix the flaky test' });
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].agent?.status).toBe('done');
  expect((await svall.api.call('state.get', {})).characters[c.id].agent?.kind).toBe('codex');
  expect(JSON.parse(fs.readFileSync(path.join(svall.home, 'fake-codex', `${c.id}.argv`), 'utf8'))).toEqual(['--', 'fix the flaky test']);
  await expect(page.getByTestId(`sb-char-${c.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
});
