import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { emptyState, PROTOCOL_VERSION } from '@svall/protocol';
import { expect, test } from './fixtures.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

const ME = '11111111-1111-4111-8111-111111111111';
const STUDIO = '22222222-2222-4222-8222-222222222222';
const ISLAND = { id: 'i_a', name: 'app', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
const fleet = { ...emptyState(), scribeAsk: undefined, placingAsk: undefined, islands: { ...emptyState().islands, i_a: ISLAND }, machines: {} };

type Calls = { method: string; params: { cwd?: string } }[];

// a daemon as the page meets it: it greets a token and answers each method by `answer`, or with nothing to say
async function daemon(answer: (method: string, params: { cwd?: string }) => unknown) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const calls: Calls = [];
  wss.on('connection', (ws) => ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: { cwd?: string }; token?: string };
    if (msg.token !== undefined) { ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
    calls.push({ method: msg.method!, params: msg.params ?? {} });
    const said = msg.method === 'state.get' ? fleet : await answer(msg.method!, msg.params ?? {});
    const data = (said as { data?: unknown } | undefined)?.data;
    ws.send(JSON.stringify({ id: msg.id, ...(said instanceof Error ? { error: { code: said.name, message: said.message, ...(data !== undefined && { data }) } } : { result: said ?? {} }) }));
  }));
  return {
    port: (wss.address() as { port: number }).port,
    calls,
    made: () => calls.filter((c) => c.method === 'robot.create').map((c) => c.params.cwd),
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

const notAFolder = (cwd?: string) => Object.assign(new Error(`cwd ${cwd} is not a directory`), { name: 'not_a_folder', data: { kind: cwd?.endsWith('.txt') ? 'file' : 'missing' } });
const defaults = { cwd: '/nowhere', home: '/nowhere' };
const many = Array.from({ length: 24 }, (_, i) => ({ path: `/home/linus/code/a-rather-long-clone-name-${i}`, clone: true }));

// the home's list waits on `listed` when one is given
async function farHome(listed?: Promise<void>) {
  const home = await daemon(async (m, p) => (m === 'workspace.clones' ? (await listed, { machine: STUDIO, folders: many, defaults })
    : m === 'robot.create' ? (p.cwd === '/home/linus/x' || p.cwd === '/home/linus/f.txt' ? notAFolder(p.cwd) : { id: 'c_new' }) : undefined));
  const local = await daemon((m) => (m === 'fleet.home' ? { machine: STUDIO, name: 'studio', mine: false, me: ME }
    : m === 'home.connection' ? { machine: STUDIO, name: 'studio', state: 'connected', ssh: 'linus@studio', controlSocket: '/tmp/m', port: home.port, token: 't' }
    : m === 'workspace.clones' ? { machine: ME, folders: [{ path: '/Users/ada/app', clone: true }, { path: '/Users/ada/notes', clone: false }], defaults } : undefined));
  return { home, local };
}

async function open(page: Page, port: number): Promise<void> {
  await page.addInitScript(({ key, value }) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* seeded where there is a store */ }
  }, { key: SETTINGS_KEY, value: JSON.stringify(DEFAULT_SETTINGS) });
  await page.goto(`/?port=${port}&token=t&view=board`);
  await expect(page.getByTestId('board')).toBeVisible();
}

const picks = (page: Page) => page.getByTestId('new-robot-folders').locator('[data-testid^="new-robot-pick-"]');

test('a window on a far home starts a robot in one of the home\'s folders, its list inside the dialog, and hears a typed path refused', async ({ page }) => {
  let read = () => {};
  const { home, local } = await farHome(new Promise((r) => { read = r; }));
  try {
    await open(page, local.port);
    await expect.poll(() => home.calls.some((c) => c.method === 'state.get')).toBe(true);
    await page.keyboard.press('Meta+t');
    await expect(page.getByTestId('new-robot-where')).toHaveText('folder on studio');
    // the list holds its place while it is read, so the buttons under it stay where they are
    await expect(page.getByTestId('new-robot-folders')).toHaveText('Reading studio\'s folders…');
    // measured once the dialog has risen into place
    await page.locator('.modal.dialog').evaluate(async (e) => { await Promise.all(e.getAnimations().map((a) => a.finished)); });
    const create = async () => (await page.getByTestId('new-robot-create').boundingBox())!.y;
    const before = await create();
    read();
    await expect(picks(page)).toHaveCount(24);
    expect(await create()).toBe(before);
    await expect(page.getByTestId('new-robot-folder')).toBeHidden();
    expect(local.calls.filter((c) => c.method === 'workspace.clones')).toEqual([]);

    // two dozen long paths scroll inside the list, which stays in the dialog, which stays on the screen
    const dialog = (await page.locator('.modal.dialog').boundingBox())!;
    const list = (await page.getByTestId('new-robot-folders').boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(dialog.x + dialog.width);
    expect(list.y + list.height).toBeLessThanOrEqual(dialog.y + dialog.height);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    // and each stays a line of its own to read, for the list to scroll past
    expect((await picks(page).first().boundingBox())!.height).toBeGreaterThanOrEqual(20);
    expect(await page.getByTestId('new-robot-folders').evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);

    await page.getByTestId('new-robot-other').click();
    await expect(page.getByTestId('new-robot-folder')).toBeFocused();
    await page.keyboard.type('/home/linus/x');
    await page.getByTestId('new-robot-create').click();
    await expect(page.getByTestId('new-robot-refused')).toHaveText('studio has no folder /home/linus/x');
    await page.getByTestId('new-robot-folder').fill('/home/linus/f.txt');
    await page.getByTestId('new-robot-create').click();
    await expect(page.getByTestId('new-robot-refused')).toHaveText('/home/linus/f.txt is a file, not a folder');
    await expect(page.getByTestId('new-robot')).toBeVisible();

    await page.getByTestId('new-robot-pick-/home/linus/code/a-rather-long-clone-name-1').click();
    await page.getByTestId('new-robot-create').click();
    await expect(page.getByTestId('new-robot')).toBeHidden();
    expect(home.made()).toEqual(['/home/linus/x', '/home/linus/f.txt', '/home/linus/code/a-rather-long-clone-name-1']);
    expect(local.made()).toEqual([]);
  } finally {
    await home.close();
    await local.close();
  }
});

test('the + beside an island with no robot there asks for the folder before anything starts, and the robot goes to the column asked from', async ({ page }) => {
  const { home, local } = await farHome();
  try {
    await open(page, local.port);
    await expect.poll(() => home.calls.some((c) => c.method === 'state.get')).toBe(true);
    const column = fleet.columns[1]!.id;
    await page.getByTestId(`col-new-${column}`).click();
    await expect(page.getByTestId('new-robot-where')).toHaveText('folder on studio');
    expect(home.made()).toEqual([]);
    await page.getByTestId('new-robot-pick-/home/linus/code/a-rather-long-clone-name-1').click();
    await page.getByTestId('new-robot-create').click();
    await expect(page.getByTestId('new-robot')).toBeHidden();
    expect(home.made()).toEqual(['/home/linus/code/a-rather-long-clone-name-1']);
    expect(local.made()).toEqual([]);
    await expect.poll(() => home.calls.filter((c) => c.method === 'robot.place').map((c) => c.params)).toEqual([{ id: 'c_new', columnId: column }]);
  } finally {
    await home.close();
    await local.close();
  }
});

test('when the home goes the open dialog lists this Mac\'s clones, and says whose they are', async ({ page }) => {
  const { home, local } = await farHome();
  try {
    await open(page, local.port);
    await expect.poll(() => home.calls.some((c) => c.method === 'state.get')).toBe(true);
    await page.keyboard.press('Meta+t');
    await expect(page.getByTestId('new-robot-where')).toHaveText('folder on studio');
    await home.close();
    await expect(page.getByTestId('new-robot-where')).toHaveText('folder on this Mac, while studio is not reachable');
    await expect(picks(page)).toHaveText(['/Users/ada/app'].map((p) => p.replace('/Users/ada', '~')));
    await expect(page.getByTestId('new-robot-pick-/Users/ada/app')).toHaveAttribute('aria-selected', 'true');
  } finally {
    await local.close();
  }
});
