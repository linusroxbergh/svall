import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { emptyState, PROTOCOL_VERSION, type MobileStatus, type PhoneSession } from '@svall/protocol';
import { expect, test } from './fixtures.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

const SERVING: MobileStatus = { serving: true, url: 'https://mac.tailnet.ts.net:8443/', port: 8443, logins: [], phones: [] };
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// the phone link needs a tailnet, which no test machine is promised, so the daemon behind these is a stand-in
async function fakeDaemon() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = { ...emptyState(), scribeAsk: undefined };
  const fake = {
    port: (wss.address() as { port: number }).port,
    status: SERVING,
    tell: (phones: PhoneSession[]) => {
      for (const ws of wss.clients) ws.send(JSON.stringify({ event: 'mobile.phones', data: { phones } }));
    },
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise((r) => wss.close(r)); },
  };
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; token?: string };
    if (msg.token !== undefined) { ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
    const result = msg.method === 'state.get' ? state : msg.method?.startsWith('mobile.') ? fake.status : {};
    ws.send(JSON.stringify({ id: msg.id, result }));
  }));
  return fake;
}

async function open(page: Page, port: number): Promise<void> {
  await page.addInitScript(({ key, value }) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
  }, { key: SETTINGS_KEY, value: JSON.stringify(DEFAULT_SETTINGS) });
  await page.goto(`/?port=${port}&token=t&view=board`);
  await expect(page.getByTestId('board')).toBeVisible();
}

test('the phone panel says who is on the page, and hears them arrive and leave', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    await open(page, fake.port);
    // each footer control centers its glyph and puts a readable label beneath it
    for (const id of ['mobile-tab', 'usage-tab']) {
      const tab = (await page.getByTestId(id).boundingBox())!;
      const glyph = (await page.getByTestId(id).locator('svg').boundingBox())!;
      const label = (await page.getByTestId(id).locator('.use-tab-label').boundingBox())!;
      expect(Math.abs(glyph.x + glyph.width / 2 - (tab.x + tab.width / 2))).toBeLessThanOrEqual(0.5);
      expect(glyph.y + glyph.height).toBeLessThan(label.y);
      expect(label.y + label.height).toBeLessThanOrEqual(tab.y + tab.height);
    }
    await page.getByTestId('mobile-tab').click();
    const here = page.getByTestId('mobile-here');
    await expect(here).toHaveText('nobody has this open');
    await expect(here).not.toHaveAttribute('data-live', /.*/);

    const since = Date.now() - 3_600_000;
    fake.tell([{ login: 'me@example.com', since }]);
    await expect(here).toHaveText(`me@example.com since ${hhmm(since)}`);
    await expect(here).toHaveAttribute('data-live', 'true');

    fake.tell([]);
    await expect(here).toHaveText('nobody has this open');
  } finally {
    await fake.close();
  }
});

test('the tab stands while the fleet is not served, and the switch in it turns the link on', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    fake.status = { serving: false, url: '', port: 8443, logins: [], phones: [] };
    await open(page, fake.port);
    const tab = page.getByTestId('mobile-tab');
    await expect(tab).toHaveAttribute('data-off', 'true');
    await tab.click();
    await expect(page.getByTestId('mobile-switch')).toHaveText('off');
    await expect(page.getByTestId('mobile-url')).toHaveCount(0);

    fake.status = SERVING;
    await page.getByTestId('mobile-switch').click();
    await expect(page.getByTestId('mobile-url')).toHaveText(SERVING.url);
    await expect(tab).not.toHaveAttribute('data-off', /.*/);
  } finally {
    await fake.close();
  }
});

test('the dock omits Phone when no link can be made on this machine', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    fake.status = { serving: false, url: '', port: 8443, logins: [], phones: [], error: 'tailscale is not installed' };
    await open(page, fake.port);
    await expect(page.getByTestId('usage-tab')).toBeVisible();
    await expect(page.getByTestId('mobile-tab')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

test('the dock stays available when the sidebar is hidden and opens one utility at a time', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    await open(page, fake.port);
    const dock = page.getByTestId('utility-dock');
    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    const footer = (await dock.boundingBox())!;
    expect(footer.x).toBe(0);
    expect(Math.abs(footer.width - sidebar.width)).toBeLessThanOrEqual(1);
    expect(footer.y + footer.height).toBeCloseTo(page.viewportSize()!.height, 0);

    await page.getByTestId('mobile-tab').click();
    const panel = (await page.getByTestId('mobile-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    await page.getByTestId('sidebar-hide').click();
    await expect(dock).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('mobile-tab')).toBeVisible();
    await expect(page.getByTestId('settings-open')).toBeVisible();
    await page.getByTestId('mobile-tab').click();
    await expect(page.getByTestId('mobile-panel')).toBeVisible();
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('mobile-panel')).toHaveCount(0);
    await expect(page.getByTestId('settings')).toBeVisible();

    await page.setViewportSize({ width: 520, height: 620 });
    await page.getByTestId('usage-tab').click();
    const narrow = (await page.getByTestId('usage-panel').boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(520);
    expect(narrow.y).toBeGreaterThanOrEqual(0);
  } finally {
    await fake.close();
  }
});

test('footer labels fit at the sidebar minimum width', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    await open(page, fake.port);
    const grip = (await page.getByTestId('side-drag-sidebar').boundingBox())!;
    const y = grip.y + grip.height / 4;
    await page.mouse.move(grip.x + grip.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(grip.x - 100, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())!.width).toBeLessThanOrEqual(181);

    for (const id of ['mobile-tab', 'usage-tab', 'settings-open']) {
      const label = page.getByTestId(id).locator('.use-tab-label');
      const widths = await label.evaluate((el) => ({ visible: el.clientWidth, text: el.scrollWidth }));
      expect(widths.text).toBeLessThanOrEqual(widths.visible + 1);
    }
  } finally {
    await fake.close();
  }
});

test('the settings carry the same answer, and the panel calls out a checkout with no phone page', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    const since = Date.now();
    fake.status = { ...SERVING, phones: [{ login: 'me@example.com', since }] };
    await open(page, fake.port);
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('set-mobile-here')).toHaveText(`me@example.com since ${hhmm(since)}`);
    fake.tell([]);
    await expect(page.getByTestId('set-mobile-here')).toHaveText('nobody');

    fake.status = { ...SERVING, pageMissing: true };
    await page.getByTestId('mobile-tab').click();
    await expect(page.getByTestId('mobile-nopage')).toBeVisible();
  } finally {
    await fake.close();
  }
});
