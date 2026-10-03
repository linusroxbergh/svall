import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { Cell } from '@svall/protocol';
import { NodeClient } from './client.js';
import { ROOT, readInfo, startDaemon, stopDaemon, type DaemonInfo } from './daemon.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

export const FAKE_CLAUDE = `node ${path.join(ROOT, 'packages/svalld/test/fixtures/fake-claude.mjs')}`;

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };
type NativeShell = { sent(): Promise<ToShell[]>; receive(m: FromShell): Promise<void> };

export type Svall = DaemonInfo & {
  api: NodeClient;
  open(view?: 'board' | 'map', opts?: { firstRun?: boolean }): Promise<void>;
  stopDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
  uniq(prefix: string): string;
  // an island reshapes around its crew as it grows, so a cell read at creation goes stale
  cellOf(id: string): Promise<Cell>;
  // a stand-in for the native shell, installed before the page opens: it records what the page sends and answers the connection request
  nativeShell(): Promise<NativeShell>;
};

export const test = base.extend<{ svall: Svall }>({
  svall: async ({ page }, use) => {
    const home = process.env.SVALL_E2E_HOME!;
    const info = readInfo(home);
    const svall: Svall = {
      ...info,
      api: await NodeClient.connect(info.port, info.token),
      uniq: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`,
      cellOf: async (id) => (await svall.api.call('state.get', {})).characters[id].cell,
      open: async (view: 'board' | 'map' = 'board', opts?: { firstRun?: boolean }) => {
        // the settings card opens by itself on a machine with no settings of its own, and would take the side card's place
        if (!opts?.firstRun) {
          await page.addInitScript(({ key, value }) => {
            // this runs again on every navigation, and a reload is where a spec reads back what it saved
            try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
          }, { key: SETTINGS_KEY, value: JSON.stringify({ ...DEFAULT_SETTINGS, zoom: 1 }) });
          // specs click the map beside an open half card, so it opens at half the map rather than the first-use size
          await page.addInitScript(() => {
            try { if (localStorage.getItem('svall.card.half') === null) localStorage.setItem('svall.card.half', JSON.stringify({ w: 0.5, h: 0.5 })); } catch { /* seeded where there is a store */ }
          });
        }
        await page.goto(`/?port=${info.port}&token=${info.token}&view=${view}`);
        await expect(page.getByTestId(view)).toBeVisible();
        // the world transform lands a frame after the view; window.__map appears with it
        if (view === 'map') await page.waitForFunction(() => '__map' in window);
      },
      nativeShell: async () => {
        await page.addInitScript(({ port, token }) => {
          const w = window as unknown as Shell & { webkit: unknown };
          w.__sent = [];
          w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
            const m = JSON.parse(json) as ToShell;
            w.__sent.push(m);
            if (m.type === 'connection') setTimeout(() => w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port, token })), 0);
          } } } };
        }, { port: svall.port, token: svall.token });
        return {
          sent: () => page.evaluate(() => (window as unknown as Shell).__sent),
          receive: (m) => page.evaluate((json) => (window as unknown as Shell).__svall.receive(json), JSON.stringify(m)),
        };
      },
      stopDaemon: async () => { svall.api.close(); await stopDaemon(home); },
      startDaemon: async () => { const next = await startDaemon(home); svall.pid = next.pid; svall.api = await NodeClient.connect(next.port, next.token); },
    };
    // every spec starts with home and nothing else: the map fits the whole world above theme.scale.min, so islands
    // left behind by an earlier spec push this spec's own islands out of the window
    const state = await svall.api.call('state.get', {});
    for (const id of Object.keys(state.characters)) await svall.api.call('char.close', { id });
    for (const [id, island] of Object.entries(state.islands)) if (island.kind !== 'home') await svall.api.call('island.delete', { id });
    // answers a new fleet's scribe question, which would otherwise cover the page
    await svall.api.call('scribe.set', { enabled: false });
    await use(svall);
    svall.api.close();
  },
});

// the fit ease keeps shifting the layout for a few frames after the view opens, a move, or a panel taking width, so
// the layout is read a beat apart until two reads agree (waitForFunction would take the returned promise as a pass)
export const settleMap = (page: Page) => expect.poll(() => page.evaluate(() => {
  const m = window.__map!;
  const before = JSON.stringify(m.layout());
  // a frame can lag past the wait, so the layout is read again two frames on
  return new Promise<boolean>((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done(before === JSON.stringify(m.layout())))), 100));
}), { intervals: [50] }).toBe(true);

// the viewport that leaves the map `w` px wide beside whatever panels are open
export async function setMapWidth(page: Page, w: number): Promise<void> {
  const map = (await page.getByTestId('map').boundingBox())!, vp = page.viewportSize()!;
  await page.setViewportSize({ width: Math.round(vp.width + w - map.width), height: vp.height });
  await expect.poll(async () => Math.round((await page.getByTestId('map').boundingBox())!.width)).toBe(w);
}

export { expect };
