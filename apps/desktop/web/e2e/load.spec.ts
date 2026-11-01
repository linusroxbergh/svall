import { FAKE_CLAUDE, expect, test } from './fixtures.js';

test('the load tab lists the robot, whose row deletes it, and Svall itself', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('load') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'busy', command: FAKE_CLAUDE });
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[c.id].agent?.kind).toBe('claude');
  await svall.open();

  const tab = page.getByTestId('load-tab');
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
  await tab.click();
  const panel = page.getByTestId('load-panel');
  await expect(panel.getByTestId('load-app')).toBeVisible();
  await expect(panel.getByTestId(`load-row-${c.id}`)).toContainText('busy');
  // the fake agent runs under node, whose session svalld cannot resume
  await expect(panel.getByTestId(`load-sleep-${c.id}`)).toHaveCount(0);

  await panel.getByTestId(`load-delete-${c.id}`).click();
  await expect(page.getByTestId('confirm-close')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-close')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});
