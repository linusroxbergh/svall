import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { Cell } from '@archipelago/protocol';
import { NodeClient } from './client.js';
import { ROOT, readInfo, startDaemon, stopDaemon, type DaemonInfo } from './daemon.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

export const FAKE_CLAUDE = `node ${path.join(ROOT, 'packages/archid/test/fixtures/fake-claude.mjs')}`;

export type Archi = DaemonInfo & {
  api: NodeClient;
  open(view?: 'board' | 'map', opts?: { firstRun?: boolean }): Promise<void>;
  stopDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
  uniq(prefix: string): string;
  // an island reshapes around its crew as it grows, so a cell read at creation goes stale
  cellOf(id: string): Promise<Cell>;
};

export const test = base.extend<{ archi: Archi }>({
  archi: async ({ page }, use) => {
    const home = process.env.ARCHI_E2E_HOME!;
    const info = readInfo(home);
    const archi: Archi = {
      ...info,
      api: await NodeClient.connect(info.port, info.token),
      uniq: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`,
      cellOf: async (id) => (await archi.api.call('state.get', {})).characters[id].cell,
      open: async (view: 'board' | 'map' = 'board', opts?: { firstRun?: boolean }) => {
        // the settings card opens by itself on a machine with no settings of its own, and would take the side card's place
        if (!opts?.firstRun) {
          await page.addInitScript(({ key, value }) => {
            // this runs again on every navigation, and a reload is where a spec reads back what it saved
            try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
          }, { key: SETTINGS_KEY, value: JSON.stringify(DEFAULT_SETTINGS) });
        }
        await page.goto(`/?port=${info.port}&token=${info.token}&view=${view}`);
        await expect(page.getByTestId(view)).toBeVisible();
        // the world transform lands a frame after the view; window.__map appears with it
        if (view === 'map') await page.waitForFunction(() => '__map' in window);
      },
      stopDaemon: async () => { archi.api.close(); await stopDaemon(home); },
      startDaemon: async () => { const next = await startDaemon(home); archi.pid = next.pid; archi.api = await NodeClient.connect(next.port, next.token); },
    };
    // every spec starts with home and nothing else: the map fits the whole world above theme.scale.min, so islands
    // left behind by an earlier spec push this spec's own islands out of the window
    const state = await archi.api.call('state.get', {});
    for (const id of Object.keys(state.characters)) await archi.api.call('char.close', { id });
    for (const [id, island] of Object.entries(state.islands)) if (island.kind !== 'home') await archi.api.call('island.delete', { id });
    // answers a new fleet's scribe question, which would otherwise cover the page
    await archi.api.call('scribe.set', { enabled: false });
    await use(archi);
    archi.api.close();
  },
});

export { expect };
