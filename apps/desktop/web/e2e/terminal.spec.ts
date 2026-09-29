import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FAKE_CLAUDE, expect, test } from './fixtures.js';

test('shows the selected terminal on the board, switches with Cmd+J, marks seen, and revives', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('term') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b', command: FAKE_CLAUDE });
  await svall.open();
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  await svall.api.call('char.run', { id: b.id, text: 'block', enter: true });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-attention', 'true');
  await svall.api.call('char.run', { id: b.id, text: 'go', enter: true });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-unread', 'true', { timeout: 15_000 });

  await page.getByTestId(`sb-char-${a.id}`).click();
  const surface = page.getByTestId('surface');
  await expect(surface).toHaveAttribute('data-char', a.id);
  await expect(surface).toContainText('terminal · a');
  // the map's card opens on the same character, and the board comes back to it
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-char', a.id);
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(surface).toHaveAttribute('data-char', a.id);

  await page.keyboard.press('Meta+j');
  await expect(surface).toHaveAttribute('data-char', b.id);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[b.id].unread).toBe(false);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[b.id].agent?.status).toBe('idle');

  const state = await svall.api.call('state.get', {});
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', state.characters[b.id].tmux!.windowId]);
  await expect(page.getByTestId('revive')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('revive').click();
  await expect(surface).toHaveAttribute('data-char', b.id, { timeout: 10_000 });
});
