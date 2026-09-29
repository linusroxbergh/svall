import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

test('the settings open from the sidebar, zoom the page and are remembered', async ({ page, svall }) => {
  await svall.open();
  await expect(page.getByTestId('new-island')).toHaveCount(0);
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings')).toBeVisible();

  await page.getByTestId('zoom-in').click();
  await expect(page.getByTestId('zoom-level')).toHaveText('110%');
  // no shell in a browser: CSS carries the zoom
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.1');
  await page.keyboard.press('Meta+-');
  await page.keyboard.press('Meta+-');
  await expect(page.getByTestId('zoom-level')).toHaveText('90%');
  await page.keyboard.press('Meta+0');
  await expect(page.getByTestId('zoom-level')).toHaveText('100%');

  await page.getByTestId('set-cardOpacity').fill('0.5');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.keyboard.press('Meta+,');
  await expect(page.getByTestId('set-cardOpacity')).toHaveValue('0.5');
});

test('each control keeps its explanation behind the mark until it is hovered', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();

  const tip = page.locator('#set-tip-scribe');
  await expect(tip).toBeHidden();
  await page.getByTestId('set-info-scribe').hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('may cost API credits');
  // the last row has no room under it, so its tip stands over the row instead
  await expect(tip).toHaveAttribute('data-place', 'up');
  const panel = (await page.getByTestId('settings').boundingBox())!;
  const box = (await tip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(panel.y);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
  // the tip stays up while the pointer crosses into it, so a link inside is reachable
  await tip.hover();
  await expect(tip).toBeVisible();

  await page.getByTestId('zoom-level').hover();
  await expect(tip).toBeHidden();
});

test('the tip waits before it closes, so the pointer can reach it from the mark', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();

  const tip = page.locator('#set-tip-zoom');
  const mark = page.getByTestId('set-info-zoom');
  await mark.hover();
  await expect(tip).toBeVisible();
  // the gap between the mark and the tip belongs to neither, so the crossing goes through it
  const box = (await mark.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 3);
  await tip.hover();
  await expect(tip).toBeVisible();

  // parked outside both, it closes
  await page.getByTestId('zoom-level').hover();
  await expect(tip).toBeHidden();
});

test('a tip too tall for the room left to it is capped, not spilled', async ({ page, svall }) => {
  await page.setViewportSize({ width: 1280, height: 200 });
  await svall.open();
  await page.getByTestId('settings-open').click();

  const tip = page.locator('#set-tip-phone');
  await page.getByTestId('set-info-phone').hover();
  await expect(tip).toBeVisible();
  const panel = (await page.getByTestId('settings').boundingBox())!;
  const box = (await tip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(panel.y);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
});

test('the usage meter can leave the dock, and stays gone across a reload', async ({ page, svall }) => {
  await svall.open();
  await expect(page.getByTestId('usage-tab')).toBeVisible();
  await page.getByTestId('usage-tab').click();
  await expect(page.getByTestId('usage-panel')).toBeVisible();

  await page.getByTestId('settings-open').click();
  const meter = page.getByTestId('set-usage-tab');
  await expect(meter).toHaveAttribute('aria-checked', 'true');
  await meter.click();
  // the panel goes with its dock button; Phone still answers for this machine's tailnet
  await expect(page.getByTestId('usage-tab')).toHaveCount(0);
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('usage-tab')).toHaveCount(0);
});

test('the scribe switches on and off for the whole fleet', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();
  const scribe = page.getByTestId('set-scribe');
  await expect(scribe).toHaveAttribute('aria-checked', 'false');
  await scribe.click();
  await expect(scribe).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await svall.api.call('state.get', {})).scribeOff).toBeUndefined();
  await scribe.click();
  await expect(scribe).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await svall.api.call('state.get', {})).scribeOff).toBe(true);
});

test('a new fleet asks once before the scribe runs, and the settings show its last failure', async ({ page, svall }) => {
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const { scribeOff: _off, ...state } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...state, scribeAsk: true, scribeError: { message: 'claude -p failed: Not logged in', at: Date.now() } }));
  await svall.startDaemon();
  await svall.open();
  const ask = page.getByTestId('scribe-ask');
  await expect(ask).toBeVisible();
  await ask.getByTestId('scribe-ask-on').click();
  await expect(ask).toHaveCount(0);
  await expect.poll(async () => { const s = await svall.api.call('state.get', {}); return [s.scribeAsk, s.scribeOff]; }).toEqual([undefined, undefined]);
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('scribe-ask')).toHaveCount(0);
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('set-scribe')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('set-scribe-error')).toContainText('Not logged in');
});

test('the shell is told the opacity, the zoom and which config to open', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('set') });
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
  const chord = (key: string) => page.evaluate((k) => (window as unknown as Shell).__svall.receive(JSON.stringify({ type: 'key', chord: k })), key);
  const shown = async () => (await sent()).filter((m) => m.type === 'term.show' && m.id === c.id).at(-1) as { opacity?: number } | undefined;
  await expect.poll(shown).toBeTruthy();

  await chord('cmd+,');
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('set-fullOpacity').fill('0.8');
  await expect.poll(async () => (await shown())?.opacity).toBe(0.8);

  await chord('cmd+=');
  await expect.poll(async () => (await sent()).filter((m) => m.type === 'zoom').at(-1)).toEqual({ type: 'zoom', factor: 1.1, fontDelta: 1.5 });

  await page.getByTestId('settings-ghostty').click();
  await page.getByTestId('settings-fleet').click();
  expect((await sent()).filter((m) => m.type === 'openConfig')).toEqual([{ type: 'openConfig', which: 'ghostty' }, { type: 'openConfig', which: 'fleet' }]);

  await page.getByTestId('settings-cookies').click();
  expect((await sent()).at(-1)).toEqual({ type: 'browser.importCookies' });

  // the switch waits for a shell that has found the 1Password CLI, and the pane grows its fill button with it
  await expect(page.getByTestId('set-1password')).toBeDisabled();
  await page.evaluate(() => (window as unknown as Shell).__svall.receive(JSON.stringify({ type: 'shell.info', home: '/tmp/fleet-x', log: [], op: true })));
  await page.getByTestId('set-1password').click();
  await expect(page.getByTestId('set-1password')).toHaveAttribute('aria-checked', 'true');
  await chord('cmd+b');
  await expect(page.getByTestId('browser-fill')).toBeDisabled();
  // with a tab under it the button asks the shell to fill that tab
  await chord('cmd+l');
  await page.getByTestId('browser-address').fill('example.com');
  await page.getByTestId('browser-address').press('Enter');
  await expect(page.getByTestId('browser-surface')).toBeVisible();
  const tab = (await svall.api.call('state.get', {})).characters[c.id].browser!.active;
  await page.getByTestId('browser-fill').click();
  expect((await sent()).at(-1)).toEqual({ type: 'browser.fill', tab });
});

test('the first launch on a machine opens the settings, and no launch after it', async ({ page, svall }) => {
  await svall.open('board', { firstRun: true });
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('settings-close').click();

  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('settings')).toHaveCount(0);
});

test('the keyboard rows take a new chord, ask before a taken one, clear and put back', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('key-toggleSideCard')).toHaveCount(0);
  await page.getByTestId('settings-keys').click();
  await expect(page.getByTestId('keys-modal')).toBeVisible();

  const side = page.getByTestId('key-toggleSideCard');
  await expect(side).toHaveText('⌘I');
  await side.click();
  await expect(side).toHaveText('press a key');
  await page.keyboard.press('Meta+y');
  await expect(side).toHaveText('⌘Y');

  // the side card must not have flipped open under the rebind
  await expect(page.getByTestId('keys-modal')).toBeVisible();
  await page.getByTestId('key-reset-toggleSideCard').click();
  await expect(side).toHaveText('⌘I');

  // a chord another row answers names it and waits
  await side.click();
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('key-ask-toggleSideCard')).toContainText('⌘M is taken by Map or board');
  await page.getByTestId('key-take-toggleSideCard').click();
  await expect(side).toHaveText('⌘M');
  await expect(page.getByTestId('key-toggleView')).toHaveText('—');

  await page.getByTestId('key-clear-toggleSideCard').click();
  await expect(side).toHaveText('—');

  // Escape answers the row that is waiting before it answers the dialog
  await side.click();
  await expect(side).toHaveText('press a key');
  await page.keyboard.press('Escape');
  await expect(side).toHaveText('—');
  await expect(page.getByTestId('keys-modal')).toBeVisible();

  // Escape closes the editor and leaves the settings behind it
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('keys-modal')).toHaveCount(0);
  await expect(page.getByTestId('settings')).toBeVisible();
});

test('the fleet is renamed from the settings, and a name that will not do is never sent', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();
  const field = page.getByTestId('set-fleet-name');
  await field.fill('Big Base');
  await field.press('Enter');
  await expect(page.getByTestId('set-fleet-name-error')).toContainText('lowercase');
  const name = svall.uniq('crew');
  await field.fill(name);
  await field.press('Enter');
  await expect.poll(async () => (await svall.api.call('state.get', {})).name).toBe(name);
  await expect(page.getByTestId('set-fleet-name-error')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(svall.home, 'config.json'), 'utf8')).name).toBe(name);
  // the specs after this one know the fleet by its directory
  await svall.api.call('fleet.rename', { name: path.basename(svall.home) });
});

test('closing the settings while a row waits for a key leaves the other chords working', async ({ page, svall }) => {
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-keys').click();
  await page.getByTestId('key-quit').click();
  await expect(page.getByTestId('key-quit')).toHaveText('press a key');

  await page.getByTestId('keys-close').click();
  await expect(page.getByTestId('keys-modal')).toHaveCount(0);
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings')).toHaveCount(0);
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
});
