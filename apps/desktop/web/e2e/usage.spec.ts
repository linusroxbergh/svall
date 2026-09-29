import { FAKE_CLAUDE, expect, test } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

test('the usage tab tells nothing until it is opened, then reads the plan limits', async ({ page, svall }) => {
  await svall.open();
  const tab = page.getByTestId('usage-tab');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
  // shut, the corner carries no reading of its own
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);
  await expect(page.locator('.use')).not.toContainText('%');

  // a plan shows only while an agent runs on it
  await tab.click();
  await expect(page.getByTestId('usage-idle')).toHaveText('No agent is running.');
  await page.keyboard.press('Escape');
  const island = await svall.api.call('island.create', { name: svall.uniq('use') });
  const agent = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'agent', command: FAKE_CLAUDE });
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[agent.id].agent?.kind).toBe('claude');

  await tab.click();
  const rows = page.getByTestId('usage-windows').locator('.use-win');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Session');
  await expect(rows.nth(0)).toContainText('35%');
  await expect(rows.nth(1)).toContainText('Week');
  await expect(rows.nth(1)).toContainText('56%');
  await expect(rows.nth(2)).toContainText('Fable');
  await expect(rows.nth(2)).toContainText('52%');
  // each window spells its reset out as a day, date and clock time, then how long that is away
  await expect(rows.nth(1).locator('.use-reset'))
    .toHaveText(/^resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} · in 4d 9h$/);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);

  await tab.click();
  await expect(page.getByTestId('usage-panel')).toBeVisible();
  await page.mouse.click(400, 400);
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);
});

test('the panel takes a hole in the terminal rather than the whole of it', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('use') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  // a stand-in for the native shell: it records what the page sends and answers the connection request
  await page.addInitScript(({ port, token }) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type === 'connection') setTimeout(() => w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port, token })), 0);
    } } } };
  }, { port: svall.port, token: svall.token });
  await svall.open();
  const sent = () => page.evaluate(() => (window as unknown as Shell).__sent);
  const mark = async () => (await sent()).length;
  const since = async (from: number) => (await sent()).slice(from).filter((m) => !('id' in m) || m.id === c.id).map((m) => m.type);
  const cutout = async () => {
    const all = await sent();
    return all.filter((m) => m.type === 'shell.cutout').at(-1) as Extract<ToShell, { type: 'shell.cutout' }> | undefined;
  };
  await expect.poll(async () => (await sent()).some((m) => m.type === 'term.show' && m.id === c.id)).toBe(true);

  const opened = await mark();
  const tab = page.getByTestId('usage-tab');
  await tab.click();
  const panel = page.getByTestId('usage-panel');
  await expect(panel).toBeVisible();
  // the shell draws the terminal above the page: the panel is on top of the rect the terminal gives up
  await expect.poll(async () => (await cutout())?.rects.length).toBe(1);
  const box = (await panel.boundingBox())!;
  const [rect] = (await cutout())!.rects;
  expect(rect.width).toBeCloseTo(box.width, 0);
  expect(rect.height).toBeCloseTo(box.height, 0);
  expect(rect.x).toBeCloseTo(box.x, 0);
  expect(rect.y).toBeCloseTo(box.y, 0);
  // the rest of the terminal stays where it was, and so does the browser tab beside it
  expect(await since(opened)).not.toContain('term.hide');
  // the keys leave the terminal, or the panel could not be answered at all
  expect(await since(opened)).toContain('term.focus');

  const escaped = await mark();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // the hole is handed back, and Esc is a close of its own: the keyboard goes with it
  await expect.poll(async () => (await cutout())?.rects).toEqual([]);
  expect(await since(escaped)).not.toContain('term.hide');
  expect(await since(escaped)).toContain('term.focus');

  await tab.click();
  await expect(panel).toBeVisible();
  // a field of the side card's that the panel does not reach over
  const note = page.getByTestId('side-card').getByTestId('side-instructions');
  const clicked = await mark();
  await note.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await cutout())?.rects).toEqual([]);
  // the click that closed the panel is also the one that chose where the keys go
  expect(await since(clicked)).not.toContain('term.focus');
  await expect(note).toBeFocused();

  // a press that landed on a surface never reaches the page; the shell answers for it
  await tab.click();
  await expect(panel).toBeVisible();
  const touched = await mark();
  await page.evaluate(() => (window as unknown as Shell).__svall.receive(JSON.stringify({ type: 'shell.pressedAway' })));
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await cutout())?.rects).toEqual([]);
  expect(await since(touched)).not.toContain('term.focus');

  // a browser tab is drawn above the page the same way, and is left standing the same way
  await page.evaluate(() => (window as unknown as Shell).__svall.receive(JSON.stringify({ type: 'key', chord: 'cmd+l' })));
  await expect(page.getByTestId('browser-surface')).toBeVisible();
  const paned = await mark();
  await tab.click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await cutout())?.rects.length).toBe(1);
  expect((await sent()).slice(paned).map((m) => m.type)).not.toContain('browser.hide');

  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-hide').click();
  // With the sidebar folded away, the compact rail itself needs a hole in a native surface.
  const rail = (await page.getByTestId('utility-dock').boundingBox())!;
  await expect.poll(async () => (await cutout())?.rects.length).toBe(1);
  const [railCutout] = (await cutout())!.rects;
  expect(railCutout.x).toBeCloseTo(rail.x, 0);
  expect(railCutout.y).toBeCloseTo(rail.y, 0);
  expect(railCutout.width).toBeCloseTo(rail.width, 0);
  expect(railCutout.height).toBeCloseTo(rail.height, 0);

  // the panel beside the rail takes a hole of its own, and the terminal above the rail stays
  await tab.click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await cutout())?.rects.length).toBe(2);
  const beside = (await panel.boundingBox())!;
  const [railHole, panelHole] = (await cutout())!.rects;
  expect(railHole.height).toBeCloseTo(rail.height, 0);
  expect(panelHole.x).toBeCloseTo(beside.x, 0);
  expect(panelHole.height).toBeCloseTo(beside.height, 0);
});
