import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures.js';

// outside SVALL_E2E_HOME, so the global teardown never sweeps it
let dir = '';
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-show-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Storefront\n\nThe shop.\n');
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("svall app show opens a robot's card on its panes, a file formatted, and the phone panel", async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('show') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: dir, name: 'shown' });
  await svall.open();

  expect(await svall.api.call('app.show', { id: c.id, left: 'terminal', right: 'files', file: 'README.md', preview: true, tree: false })).toEqual({ apps: 1 });
  await expect(page.getByTestId('pane-left-terminal')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('pane-right-files')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('markdown-preview').locator('h1')).toHaveText('Storefront');
  await expect(page.getByTestId('files-tree-show')).toBeVisible();

  await svall.api.call('app.show', { id: c.id, card: 'closed', panel: 'phone', sidebar: false });
  await expect(page.getByTestId('panes')).toBeHidden();
  await expect(page.getByTestId('side-card')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(page.getByTestId('mobile-body')).toBeVisible();
});
