import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@archipelago/protocol';
import { expect, test } from './fixtures.js';
import type { FromShell, ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __archi: { receive(json: string): void } };
type Reply = { port: number; token: string; info: Extract<FromShell, { type: 'shell.info' }> };

// a stand-in for the native shell: it records what the page sends and answers the connection request
async function fakeShell(page: Page, reply: Reply): Promise<() => Promise<ToShell[]>> {
  await page.addInitScript((r: Reply) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.webkit = { messageHandlers: { archi: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type !== 'connection') return;
      setTimeout(() => {
        w.__archi.receive(JSON.stringify(r.info));
        w.__archi.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port: r.port, token: r.token }));
      }, 0);
    } } } };
  }, reply);
  return () => page.evaluate(() => (window as unknown as Shell).__sent);
}

test('the connect screen names the daemon log and shows its last lines', async ({ page }) => {
  const sent = await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error archid failed to start: listen EADDRINUSE'], op: false },
  });
  await page.goto('/');
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('/tmp/fleet-x/archid.log');
  await expect(screen.getByTestId('connect-log')).toContainText('EADDRINUSE');
  await screen.getByTestId('connect-log-reveal').click();
  expect((await sent()).filter((m) => m.type === 'reveal')).toEqual([{ type: 'reveal', path: '/tmp/fleet-x/archid.log' }]);
});

test('the connect screen asks for archi setup while the daemon has never logged', async ({ page }) => {
  await fakeShell(page, { port: 0, token: '', info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });
  await page.goto('/');
  await expect(page.getByTestId('connect-screen')).toContainText('run archi setup');
});

test('the connect screen says it is connecting at first, and shows the log once archid is slow to answer', async ({ page }) => {
  // a daemon that took the socket and does not answer, as every launch sees for a moment
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  try {
    await fakeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error archid failed to start: listen EADDRINUSE'], op: false },
    });
    await page.goto('/');
    const screen = page.getByTestId('connect-screen');
    await expect(screen).toHaveText('Connecting to archid…');
    await expect(screen.getByTestId('connect-log')).toContainText('EADDRINUSE');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test('a daemon on another protocol asks for a reinstall', async ({ page }) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => ws.once('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION + 1 } }))));
  await new Promise((r) => wss.once('listening', r));
  try {
    await fakeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false },
    });
    await page.goto('/');
    // a daemon that answered needs no grace to say so: this is well inside the 2.5 s the connect screen waits
    await expect(page.getByTestId('connect-screen')).toContainText('pnpm desktop:install', { timeout: 1500 });
    await expect(page.getByTestId('connect-screen')).not.toContainText('archi setup');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
