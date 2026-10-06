import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test('an opencode character takes its first prompt with --prompt and reports through Svall\'s plugin', async ({ page, svall }) => {
  await svall.open('board');
  const island = await svall.api.call('island.create', { name: svall.uniq('opencode') });
  // a plain character stays viewed, so opencode's `done` is not marked seen the instant it lands
  await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: svall.home, command: 'opencode', run: 'fix the flaky test' });
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].agent?.status).toBe('done');
  expect((await svall.api.call('state.get', {})).characters[c.id].agent?.kind).toBe('opencode');
  expect(JSON.parse(fs.readFileSync(path.join(svall.home, 'fake-opencode', `${c.id}.argv`), 'utf8'))).toEqual(['--standalone', '--prompt', 'fix the flaky test']);
  await expect(page.getByTestId(`sb-char-${c.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
});
