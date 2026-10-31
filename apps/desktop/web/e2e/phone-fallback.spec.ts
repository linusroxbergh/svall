import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { build } from 'vite';
import { PROTOCOL_VERSION, type FleetState, type MachineId } from '@svall/protocol';
import { serveBundle } from '../../../../packages/svalld/src/api/static.js';
import { chr, fleet } from '../test/fixtures.js';

const web = path.join(import.meta.dirname, '..');
const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const HOME = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;
const WORKER = 'linus-vault.tail.ts.net:8443';

// ada runs on linus-vault and bob on the Mac; the worker's copy names the Mac as its snapshot left it
const crew = (): FleetState => {
  const f = fleet();
  f.robots = {
    c0: chr('c0', 'i_b', { x: 1, y: 1 }, { name: 'ada', machine: VAULT }),
    c1: chr('c1', 'i_b', { x: 4, y: 1 }, { name: 'bob' }),
  };
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  return f;
};
const onWorker = (): FleetState => {
  const f = crew();
  f.machines = { ...f.machines, [HOME]: { name: 'mac', reachable: false, since: 0 } };
  return f;
};

// a stand-in daemon on a route: it greets, answers what the page asks, and paints `screen` for any terminal opened
function daemon(ws: WebSocketRoute, state: FleetState, screen: string, extra: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
  ws.onMessage((raw) => {
    const m = JSON.parse(String(raw)) as { id: number; method: string };
    const result = m.method === 'state.get' ? state : m.method === 'term.open' ? { screen: Buffer.from(screen).toString('base64') } : extra[m.method] ?? {};
    ws.send(JSON.stringify({ id: m.id, result }));
  });
}

test('a phone whose Mac is off opens the page it kept, controls the robots on the worker, and hands back to the Mac', async ({ page }) => {
  test.setTimeout(90_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-phone-'));
  await build({ root: web, configFile: path.join(web, 'vite.mobile.config.ts'), logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
  // the Mac's phone origin, served as svalld serves it; switched off, it takes requests and never answers them
  let on = true;
  const server = http.createServer((req, res) => { if (on) serveBundle(req, res, dir); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const macs: WebSocketRoute[] = [];
  try {
    await page.routeWebSocket((url) => url.host === `127.0.0.1:${port}`, (ws) => {
      if (!on) return;
      macs.push(ws);
      daemon(ws, crew(), 'on the mac', { 'mobile.fallbacks': { home: HOME, fallbacks: [{ machine: VAULT, name: 'linus-vault', url: `https://${WORKER}/`, pass: 'p4ss' }] } });
    });
    await page.routeWebSocket((url) => url.host === WORKER, (ws) => daemon(ws, onWorker(), 'on the vault'));

    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.getByRole('button', { name: 'New island' })).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null && localStorage.getItem('svall.fallbacks') !== null, undefined, { timeout: 10_000 });

    // the Mac shuts down: its socket goes, and the page opened again waits on it no longer than the kept page allows
    on = false;
    for (const ws of macs.splice(0)) await ws.close();
    await page.reload();
    const row = (name: string) => page.locator('.row', { hasText: name });
    await expect(page.locator('html[data-kept]')).toHaveCount(1);
    await expect(page.locator('.fleet .conn')).toHaveText('on linus-vault · mac asleep', { timeout: 10_000 });
    await expect(row('bob')).toHaveAttribute('data-status', 'unknown');
    await expect(row('ada')).toHaveAttribute('data-status', 'shell');
    await expect(page.getByRole('button', { name: 'New island' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Mission control' })).toHaveCount(0);

    await page.getByRole('button', { name: /^ada/ }).click();
    await expect(page.locator('.xterm-rows')).toContainText('on the vault');
    await page.getByRole('button', { name: '‹ fleet' }).click();
    await page.getByRole('button', { name: /^bob/ }).click();
    await expect(page.getByTestId('phone-unreachable')).toHaveText('mac is asleep');

    // the Mac's reconnect finds it back, and the page is the Mac's again
    on = true;
    await expect(page.getByTestId('phone-unreachable')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.xterm-rows')).toContainText('on the mac');
    await page.getByRole('button', { name: '‹ fleet' }).click();
    await expect(page.getByRole('button', { name: 'New island' })).toBeVisible();
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
