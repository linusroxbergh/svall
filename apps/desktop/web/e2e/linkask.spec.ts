import { expect, test } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

test('a link asks where it should open, and opening it here puts it in the character\'s browser', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('lnk') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'reader' });
  await svall.api.call('char.update', { id: c.id, context: [{ kind: 'other', ref: 'https://example.com/docs', label: 'docs', source: 'manual' }] });
  await svall.open();

  // a folder has one place to go, so only a web link raises the prompt
  await expect(page.getByTestId('link-ask')).toHaveCount(0);
  await page.getByTestId('side-context').locator('a').first().click();
  const ask = page.getByTestId('link-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('example.com/docs');

  // a click anywhere else puts it away without opening anything
  await page.mouse.click(5, 5);
  await expect(ask).toHaveCount(0);
  expect((await svall.api.call('state.get', {})).characters[c.id].browser).toBeUndefined();

  // opening it here shows the browser beside the terminal with the link as its tab
  await page.getByTestId('side-context').locator('a').first().click();
  await page.getByTestId('link-ask-here').click();
  await expect(page.getByTestId('link-ask')).toHaveCount(0);
  await expect(page.getByTestId('browser-area')).toBeVisible();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].browser?.tabs.map((t) => t.url))
    .toEqual(['https://example.com/docs']);
});

test('a link followed in a terminal asks over the terminal, with the keys, and hands them back', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('lnk') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'reader' });
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
  const since = async (from: number) => (await sent()).slice(from);
  const cutout = async () => (await sent()).filter((m) => m.type === 'shell.cutout').at(-1) as Extract<ToShell, { type: 'shell.cutout' }> | undefined;
  const follow = (url: string) => page.evaluate(({ id, url }) => (window as unknown as Shell).__svall.receive(
    JSON.stringify({ type: 'term.openUrl', id, url, x: 300, y: 200 })), { id: c.id, url });
  const ask = page.getByTestId('link-ask');

  let from = await mark();
  await follow('https://example.com/a');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('example.com/a');
  // the terminal is drawn above the page, so the ask takes a hole in it, and the keys, or Esc would reach the agent
  await expect.poll(async () => (await cutout())?.rects.length).toBe(1);
  expect(await since(from)).toContainEqual({ type: 'term.focus' });
  from = await mark();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect.poll(async () => (await cutout())?.rects).toEqual([]);
  expect(await since(from)).toContainEqual({ type: 'term.focus', id: c.id });

  // a press on the terminal never reaches the page; the shell answers for it
  await follow('https://example.com/b');
  await expect(ask).toBeVisible();
  await page.evaluate(() => (window as unknown as Shell).__svall.receive(JSON.stringify({ type: 'shell.pressedAway' })));
  await expect(ask).toHaveCount(0);

  await follow('https://example.com/c');
  from = await mark();
  await page.getByTestId('link-ask-outside').click();
  await expect(ask).toHaveCount(0);
  expect(await since(from)).toEqual(expect.arrayContaining([{ type: 'openUrl', url: 'https://example.com/c' }, { type: 'term.focus', id: c.id }]));
  expect((await svall.api.call('state.get', {})).characters[c.id].browser).toBeUndefined();

  await follow('https://example.com/d');
  await page.getByTestId('link-ask-here').click();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].browser?.tabs.map((t) => t.url))
    .toContain('https://example.com/d');
});
