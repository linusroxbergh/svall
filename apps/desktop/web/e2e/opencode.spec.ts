import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test('an opencode robot takes its first prompt with --prompt and reports through Svall\'s plugin', async ({ page, svall }) => {
  await svall.open('board');
  const island = await svall.api.call('island.create', { name: svall.uniq('opencode') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: svall.home, command: 'opencode', run: 'fix the flaky test' });
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[c.id].agent?.status).toBe('done');
  expect((await svall.api.call('state.get', {})).robots[c.id].agent?.kind).toBe('opencode');
  expect(JSON.parse(fs.readFileSync(path.join(svall.home, 'fake-opencode', `${c.id}.argv`), 'utf8'))).toEqual(['--standalone', '--prompt', 'fix the flaky test']);
  await expect(page.getByTestId(`sb-robot-${c.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
});
