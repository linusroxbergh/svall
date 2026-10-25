import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test('a codex robot starts off the shared app-server, takes its first prompt as an argument and reports through codex hooks', async ({ page, svall }) => {
  await svall.open('board');
  const island = await svall.api.call('island.create', { name: svall.uniq('codex') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: svall.home, command: 'codex', run: 'fix the flaky test' });
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[c.id].agent?.status).toBe('done');
  expect((await svall.api.call('state.get', {})).robots[c.id].agent?.kind).toBe('codex');
  expect(JSON.parse(fs.readFileSync(path.join(svall.home, 'fake-codex', `${c.id}.argv`), 'utf8'))).toEqual(['--no-daemon', '-c', 'check_for_update_on_startup=false', '--', 'fix the flaky test']);
  await expect(page.getByTestId(`sb-robot-${c.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
});
