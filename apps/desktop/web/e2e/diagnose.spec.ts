import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { expect, nativeShell, test } from './fixtures.js';
import { theme } from '../src/theme.js';

test('the connect screen names the daemon log and shows its last lines', async ({ page }) => {
  const { sent } = await nativeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error svalld failed to start: listen EADDRINUSE'], op: false },
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('/tmp/fleet-x/svalld.log');
  await expect(screen.getByTestId('connect-log')).toContainText('EADDRINUSE');
  await screen.getByTestId('connect-log-reveal').click();
  expect((await sent()).filter((m) => m.type === 'reveal')).toEqual([{ type: 'reveal', path: '/tmp/fleet-x/svalld.log' }]);
});

test('the connect screen asks for svall setup while the daemon has never logged', async ({ page }) => {
  await nativeShell(page, { port: 0, token: '', info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  await expect(page.getByTestId('connect-screen')).toContainText('run svall-dev setup');
});

test('the connect screen says the fleet is starting at first, and shows the log once svalld is slow to answer', async ({ page }) => {
  // a daemon that took the socket and does not answer, as every launch sees for a moment
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  try {
    await nativeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error svalld failed to start: listen EADDRINUSE'], op: false },
    });
    await page.clock.install();
    await page.goto('/');
    const screen = page.getByTestId('connect-screen');
    await expect(screen).toHaveText('Starting the fleet…');
    await page.clock.fastForward(theme.connectGraceMs);
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
    await nativeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false },
    });
    await page.goto('/');
    // a daemon that answered needs no grace to say so: this is well inside the 10 s the connect screen waits
    await expect(page.getByTestId('connect-screen')).toContainText('pnpm desktop:install', { timeout: 1500 });
    await expect(page.getByTestId('connect-screen')).not.toContainText('svall-dev setup');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
