import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { defaultColumns, type Cell } from '@svall/protocol';
import { NodeClient } from './client.js';
import { ROOT, readInfo, startDaemon, stopDaemon, type DaemonInfo } from './daemon.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { HALF_KEY, SETTINGS_KEY, TOUR_KEY } from '../src/store/index.js';

export const FAKE_CLAUDE = `node ${path.join(ROOT, 'packages/svalld/test/fixtures/fake-claude.mjs')}`;

export type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };
type NativeShell = { sent(): Promise<ToShell[]>; receive(m: FromShell): Promise<void> };
type Reply = { port: number; token: string; info?: Extract<FromShell, { type: 'shell.info' }> };

export type Svall = DaemonInfo & {
  api: NodeClient;
  open(view?: 'board' | 'map', opts?: { firstRun?: boolean; tour?: boolean }): Promise<void>;
  stopDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
  uniq(prefix: string): string;
  // an island reshapes around its crew as it grows, so a cell read at creation goes stale
  cellOf(id: string): Promise<Cell>;
  // installed before the page opens
  nativeShell(): Promise<NativeShell>;
};

export const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a';

// the state the daemon restarts on, edited by hand
export async function rewrite(svall: Svall, edit: (state: { machines?: unknown; robots: Record<string, Record<string, unknown>> }) => void): Promise<void> {
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(state);
  fs.writeFileSync(file, JSON.stringify(state));
  await svall.startDaemon();
}

/** ada on an island of her own, with linus-vault as the home last saw it; `ada` edits her record. */
export async function seed(svall: Svall, reachable: boolean, ada?: (c: Record<string, unknown>) => void): Promise<string> {
  const island = await svall.api.call('island.create', { name: svall.uniq('vault') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await rewrite(svall, (state) => {
    state.machines = { [VAULT]: { name: 'linus-vault', reachable, since: Date.now() } };
    ada?.(state.robots[a.id]);
  });
  return a.id;
}

// a robot placed on a machine that is gone cannot be closed, so the next spec's fixture finds every robot back home
export async function unplace(svall: Svall): Promise<void> {
  const state = await svall.api.call('state.get', {});
  if (!state.machines) return;
  await rewrite(svall, (s) => {
    delete s.machines;
    for (const c of Object.values(s.robots)) { delete c.machine; delete c.moving; }
  });
}

export const test = base.extend<{ svall: Svall }>({
  svall: async ({ page }, use) => {
    const home = process.env.SVALL_E2E_HOME!;
    const info = readInfo(home);
    const svall: Svall = {
      ...info,
      api: await NodeClient.connect(info.port, info.token),
      uniq: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`,
      cellOf: async (id) => (await svall.api.call('state.get', {})).robots[id].cell,
      open: async (view: 'board' | 'map' = 'board', opts?: { firstRun?: boolean; tour?: boolean }) => {
        // the first-run tour selects a robot and covers the map, so only the spec about it sees it
        if (!opts?.tour) await page.addInitScript((key) => { try { localStorage.setItem(key, 'done'); } catch { /* seeded where there is a store */ } }, TOUR_KEY);
        // the settings window opens by itself on a machine with no settings of its own, and would stand over the map;
        // the board's one-time toast is taken as shown
        if (!opts?.firstRun) {
          await page.addInitScript(({ key, value }) => {
            // this runs again on every navigation, and a reload is where a spec reads back what it saved
            try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
          }, { key: SETTINGS_KEY, value: JSON.stringify({ ...DEFAULT_SETTINGS, zoom: 1, boardToastShown: true }) });
          // specs click the map beside an open half card, so it opens at half the map rather than the first-use size
          await page.addInitScript((key) => {
            try { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ w: 0.5, h: 0.5 })); } catch { /* seeded where there is a store */ }
          }, HALF_KEY);
        }
        await page.goto(`/?port=${info.port}&token=${info.token}&view=${view}`);
        await expect(page.getByTestId(view)).toBeVisible();
        // the world's layout lands a frame after the view; window.__map appears with it
        if (view === 'map') await page.waitForFunction(() => '__map' in window);
      },
      nativeShell: () => nativeShell(page, { port: svall.port, token: svall.token }),
      stopDaemon: async () => { svall.api.close(); await stopDaemon(home); },
      startDaemon: async () => { const next = await startDaemon(home); svall.pid = next.pid; svall.api = await NodeClient.connect(next.port, next.token); },
    };
    // every spec starts with home and nothing else: the map fits the whole world above theme.scale.min, so islands
    // left behind by an earlier spec push this spec's own islands out of the window
    const state = await svall.api.call('state.get', {});
    for (const id of Object.keys(state.robots)) await svall.api.call('robot.close', { id });
    for (const [id, island] of Object.entries(state.islands)) if (island.kind !== 'home') await svall.api.call('island.delete', { id });
    // and with the board's default columns in their order; one a spec deleted comes back under a new id
    const want = defaultColumns().map((k) => k.name);
    let cols = (await svall.api.call('state.get', {})).columns;
    for (const name of want) if (!cols.some((k) => k.name === name)) cols = await svall.api.call('column.add', { name });
    for (const k of cols.filter((x) => !want.includes(x.name))) cols = await svall.api.call('column.delete', { id: k.id, moveTo: cols.find((x) => x.id !== k.id)!.id });
    const idOf = (name: string) => cols.find((k) => k.name === name)!.id;
    for (let i = 1; i < want.length; i++) cols = await svall.api.call('column.reorder', { id: idOf(want[i]), targetId: idOf(want[i - 1]), after: true });
    // answers a new fleet's scribe and placing questions, which would otherwise cover the page
    await svall.api.call('scribe.set', { enabled: false });
    await svall.api.call('placing.set', { enabled: false });
    await use(svall);
    svall.api.close();
  },
});

export const sent = (page: Page) => page.evaluate(() => (window as unknown as Shell).__sent);
export const receive = (page: Page, m: FromShell) => page.evaluate((json) => (window as unknown as Shell).__svall.receive(json), JSON.stringify(m));

// a stand-in for the native shell: it records what the page sends and answers each connection request with info and the daemon
export async function nativeShell(page: Page, reply: Reply): Promise<NativeShell> {
  await page.addInitScript((r: Reply) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type !== 'connection') return;
      setTimeout(() => {
        if (r.info) w.__svall.receive(JSON.stringify(r.info));
        w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port: r.port, token: r.token }));
      }, 0);
    } } } };
  }, reply);
  return { sent: () => sent(page), receive: (m) => receive(page, m) };
}

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
