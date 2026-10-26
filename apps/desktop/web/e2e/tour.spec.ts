import type { Locator, Page } from '@playwright/test';
import type { ToShell } from '../src/bridge.js';
import { expect, test } from './fixtures.js';

test('the first-run tour waits for the settings card, starts on the first robot and stays done', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  const tour = page.getByTestId('tour');
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(tour).toHaveCount(0);
  await page.getByTestId('settings-close').click();
  await expect(tour).toContainText('1 of 5');
  await expect(tour).toContainText('A shell in /tmp');
  // selected, so Enter opens it, with its side card open for the next step
  await expect(page.getByTestId('side-name')).toHaveValue(c.name);
  for (const [i, title] of ['What the robot knows', 'Resources', 'Robots make robots', 'Mission control'].entries()) {
    await page.getByTestId('tour-next').click();
    await expect(tour).toContainText(`${i + 2} of 5`);
    await expect(tour).toContainText(title);
  }
  await expect(page.getByTestId('tour-skip')).toHaveCount(0);
  await page.getByTestId('tour-next').click();
  await expect(tour).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('skipping the tour ends it for good', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('a machine past its first run gets no tour', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { tour: true });
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();
  // the tour would land within a frame of its anchor showing
  await page.waitForTimeout(300);
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('Escape ends the tour for good and leaves the robot it showed selected', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('tour')).toContainText('1 of 5');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page.getByTestId('side-name')).toHaveValue(c.name);
  await page.reload();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

// the ring hugs its target, kept 3px inside the window
const ringsOn = async (page: Page, target: Locator) => {
  const r = await page.locator('.tour-ring').boundingBox(), t = await target.boundingBox(), vp = page.viewportSize()!;
  if (!r || !t) return false;
  const want = [Math.max(t.x - 6, 3), Math.max(t.y - 6, 3), Math.min(t.x + t.width + 6, vp.width - 3), Math.min(t.y + t.height + 6, vp.height - 3)];
  return Math.max(...[r.x, r.y, r.x + r.width, r.y + r.height].map((v, i) => Math.abs(v - want[i]))) < 2;
};

test('over an open terminal the tour rings what is in sight, and the terminal gives the bubble up where it stands', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  const { sent } = await svall.nativeShell();
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  const tour = page.getByTestId('tour');
  await expect(tour).toContainText('1 of 5');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-settled', 'true');
  const held = async () => {
    const cut = (await sent()).filter((m) => m.type === 'shell.cutout').at(-1) as Extract<ToShell, { type: 'shell.cutout' }> | undefined;
    const b = await tour.boundingBox();
    return !!cut && !!b && cut.rects.some((r) => Math.max(Math.abs(r.x - b.x), Math.abs(r.y - b.y), Math.abs(r.width - b.width), Math.abs(r.height - b.height)) < 1);
  };
  const targets = [page.getByTestId(`sb-robot-${c.id}`), page.getByTestId('side-card'), page.getByTestId('side-resources'), page.getByTestId(`sb-folder-${island.id}`)];
  for (const [i, target] of targets.entries()) {
    await expect(tour).toContainText(`${i + 1} of 5`);
    await expect.poll(() => ringsOn(page, target)).toBe(true);
    await expect.poll(held).toBe(true);
    await page.getByTestId('tour-next').click();
  }
});

test('under the page zoom a browser applies, the ring stands on its target', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  // a first run's default zoom, which a browser takes as CSS
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe('0.9');
  await expect(page.getByTestId('tour')).toContainText('1 of 5');
  await expect.poll(() => ringsOn(page, page.getByTestId(`token-${c.id}`))).toBe(true);
  await page.getByTestId('tour-next').click();
  await expect.poll(() => ringsOn(page, page.getByTestId('side-card'))).toBe(true);
});

test('a rename and a map drag keep their own Escape while the tour shows', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  const tour = page.getByTestId('tour');
  await expect(tour).toContainText('1 of 5');
  await page.getByTestId(`sb-island-${island.id}`).dblclick();
  const input = page.getByTestId('island-name-input');
  await input.fill(svall.uniq('renamed'));
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId(`sb-island-${island.id}`)).toContainText(island.name);
  await expect(tour).toBeVisible();
  const token = page.getByTestId(`token-${c.id}`), before = (await token.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, { steps: 5 });
  await expect.poll(async () => (await token.boundingBox())!.x - before.x).toBeGreaterThan(30);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(tour).toBeVisible();
  // a drop would land a beat after the release
  await page.waitForTimeout(500);
  expect((await svall.api.call('state.get', {})).robots[c.id].cell).toEqual(c.cell);
});
