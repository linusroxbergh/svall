import path from 'node:path';
import { expect, nativeShell, test } from './fixtures.js';
import { theme } from '../src/theme.js';

const SHOTS = path.resolve(import.meta.dirname, '../../../../.superpowers/sdd/2026-10-29-feedback-plan/shots');

test('the sidebar link, the collapsed rail and the panel open the feedback form', async ({ page, svall }) => {
  const shell = await svall.nativeShell();
  await svall.open();
  const sidebar = page.getByTestId('sidebar');
  await expect(page.getByTestId('feedback-tab')).toBeHidden();
  await sidebar.screenshot({ path: path.join(SHOTS, 'sidebar.png') });

  await shell.receive({ type: 'update.available', version: '0.15.0' });
  await expect(page.getByTestId('sidebar-update')).toBeVisible();
  await sidebar.screenshot({ path: path.join(SHOTS, 'sidebar-update.png') });

  await page.getByTestId('sidebar-feedback').click();
  const panel = page.getByTestId('feedback-panel');
  await expect(panel).toContainText('Send feedback');
  await expect(page.getByTestId('feedback-diagnostics')).toBeEnabled();
  await page.screenshot({ path: path.join(SHOTS, 'panel-bug.png') });
  await page.getByTestId('feedback-kind-idea').click();
  await page.getByTestId('feedback-see').click();
  await expect(page.getByTestId('feedback-preview')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'panel-idea-preview.png') });

  await page.getByTestId('corner-panel-close').click();
  await expect(panel).toBeHidden();
  await page.getByTestId('sidebar-hide').click();
  await expect(page.getByTestId('feedback-tab')).toBeVisible();
  await page.getByTestId('utility-dock').screenshot({ path: path.join(SHOTS, 'rail.png') });
  await page.getByTestId('feedback-tab').click();
  await expect(panel).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'rail-panel.png') });
});

test('the connect screen offers the form with the shell log', async ({ page }) => {
  await nativeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/Users/ada/.svall', log: ['2026-09-14T10:00:00Z error svalld failed to start in /Users/ada/.svall: listen EADDRINUSE'], op: false },
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  await page.getByTestId('connect-feedback').click();
  await expect(page.getByTestId('feedback-diagnostics')).toBeEnabled();
  await page.getByTestId('feedback-see').click();
  await expect(page.getByTestId('feedback-preview')).toContainText('~/.svall');
  await page.screenshot({ path: path.join(SHOTS, 'connect.png') });
});
