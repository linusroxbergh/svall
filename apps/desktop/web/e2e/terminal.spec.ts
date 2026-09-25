import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FAKE_CLAUDE, expect, test } from './fixtures.js';

test('shows the selected terminal on the board, switches with Cmd+J, marks seen, and revives', async ({ page, archi }) => {
  const island = await archi.api.call('island.create', { name: archi.uniq('term') });
  const a = await archi.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await archi.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b', command: FAKE_CLAUDE });
  await archi.open();
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  await archi.api.call('char.run', { id: b.id, text: 'block', enter: true });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-attention', 'true');
  await archi.api.call('char.run', { id: b.id, text: 'go', enter: true });
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
  await expect.poll(async () => (await archi.api.call('state.get', {})).characters[b.id].unread).toBe(false);
  await expect.poll(async () => (await archi.api.call('state.get', {})).characters[b.id].agent?.status).toBe('idle');

  const state = await archi.api.call('state.get', {});
  execFileSync('tmux', ['-S', path.join(archi.home, 'tmux.sock'), 'kill-window', '-t', state.characters[b.id].tmux!.windowId]);
  await expect(page.getByTestId('revive')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`sb-char-${b.id}`)).toHaveAttribute('data-status', 'dormant');
  await page.getByTestId('revive').click();
  await expect(surface).toHaveAttribute('data-char', b.id, { timeout: 10_000 });
});
