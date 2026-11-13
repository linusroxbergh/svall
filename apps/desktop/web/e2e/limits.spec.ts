import { WebSocketServer } from 'ws';
import { emptyState, PROTOCOL_VERSION, type LimitsReport } from '@svall/protocol';
import { expect, test } from './fixtures.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

const MAC = '11111111-1111-4111-8111-111111111111';
const STUDIO = '22222222-2222-4222-8222-222222222222';
const LIMITS: LimitsReport = { size: { cores: 12, memoryMb: 96256 }, suggested: { cpus: 11, memoryMb: 95232 }, limits: { cpus: 11, memoryMb: 95232 }, state: 'applied', heldMb: 6349, hits: 1, lastHit: Date.now() };

// a fleet's memory limit is a Linux server's, which no test machine is promised, so the daemon behind this is a stand-in
async function fakeDaemon() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = { ...emptyState(), scribeAsk: undefined, placingAsk: undefined, machines: { [STUDIO]: { name: 'studio', reachable: true } } };
  const set: unknown[] = [];
  const answers: Record<string, (p: { cpus?: number | null; memoryMb?: number | null }) => unknown> = {
    'state.get': () => state,
    'fleet.home': () => ({ machine: MAC, name: 'mac', mine: true, me: MAC }),
    'machines.list': () => ({ machines: [
      { id: MAC, name: 'mac', role: 'home', platform: 'darwin', reachable: true, robots: 0 },
      { id: STUDIO, name: 'studio', role: 'worker', platform: 'linux', reachable: true, robots: 0 },
    ] }),
    'machines.limits': () => LIMITS,
    'machines.setLimits': (p) => { set.push(p); return { ...LIMITS, limits: { ...(p.cpus && { cpus: p.cpus }), ...(p.memoryMb && { memoryMb: p.memoryMb }) } }; },
    'mobile.get': () => ({ serving: false, url: '', port: 0, logins: [], phones: [] }),
  };
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: object; token?: string };
    if (msg.token !== undefined) { ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
    ws.send(JSON.stringify({ id: msg.id, result: answers[msg.method!]?.(msg.params as never) ?? {} }));
  }));
  return {
    port: (wss.address() as { port: number }).port, set,
    hit: () => { for (const ws of wss.clients) ws.send(JSON.stringify({ event: 'machines.limitHit', data: { machine: STUDIO, name: 'studio', hits: 1, at: Date.now() } })); },
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

test('a fleet that reached its memory limit on a worker is said in a toast, whose Change limits opens and saves that machine\'s limits', async ({ page }) => {
  const fake = await fakeDaemon();
  try {
    await page.addInitScript(({ key, value }) => {
      try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
    }, { key: SETTINGS_KEY, value: JSON.stringify(DEFAULT_SETTINGS) });
    await page.goto(`/?port=${fake.port}&token=t&view=board`);
    await expect(page.getByTestId('board')).toBeVisible();
    fake.hit();
    await expect(page.getByTestId('toast-text')).toHaveText("studio reached its memory limitOne of the fleet's processes was stopped");
    await expect(page.getByTestId('toast')).toHaveAttribute('data-tone', 'info');
    await page.getByTestId('toast-action').click();
    const row = page.getByTestId('machine-limits-studio');
    await expect(row.getByTestId('limits-edit')).toBeVisible();
    await expect(page.locator(`#set-tip-limits-${STUDIO}`)).toContainText('This fleet reached it once');
    await row.getByTestId('limits-memory').fill('64');
    await row.getByTestId('limits-save').click();
    await expect(row.getByTestId('limits-value')).toHaveText('11 of 12 cores · 64 of 94 GB');
    expect(fake.set).toEqual([{ machine: STUDIO, cpus: 11, memoryMb: 65536 }]);
  } finally {
    await fake.close();
  }
});
