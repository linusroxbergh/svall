import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { HOME_ISLAND, crewGrid, emptyState, type Character } from '@svall/protocol';
import { startApi } from '../src/api/server.js';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { aboveHome, placementOk, worldIslands } from '../src/layout.js';
import { resolveRepo } from '../src/links/git.js';
import { silentLogger, type Logger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Phones } from '../src/phones.js';
import { PushStore } from '../src/push/store.js';
import { Store } from '../src/store.js';
import { TerminalHub } from '../src/terminals.js';
import { Tmux, type LiveWindow } from '../src/tmux/tmux.js';
import { Workspace } from '../src/workspace/workspace.js';
import { cleanHomes, makeHome, stubFleets, stubMobile, stubUsage, waitFor } from './helpers.js';

vi.mock('../src/links/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/links/git.js')>();
  return { ...actual, resolveRepo: vi.fn(actual.resolveRepo) };
});

afterEach(cleanHomes);

const char = (id: string, islandId: string, over: Partial<Character> = {}): Character => ({
  id, islandId, cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

// a fleet that is never started: what these guards decide happens in the store, without tmux
function fleetOn(seed: (s: ReturnType<typeof emptyState>) => void, log: Logger = silentLogger) {
  const home = makeHome();
  const paths = resolvePaths(home);
  const store = Store.load(paths.state, () => {});
  store.update((d) => seed(d));
  let windows = 0;
  const live: LiveWindow[] = [];
  const tmux = { newWindow: async () => { windows++; return { windowId: `@${windows}`, paneId: `%${windows}` }; }, listWindows: async () => live } as unknown as Tmux;
  const fleet = new Fleet({ store, tmux, paths, config: Config.parse({ shell: '/bin/sh' }), log });
  return { fleet, store, home, paths, live };
}

function repo(parent: string, name: string): string {
  const dir = path.join(fs.realpathSync(parent), name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('following a hook into another checkout', () => {
  const setup = (log?: Logger) => {
    const f = fleetOn((d) => { d.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 }; }, log);
    const [one, two] = [repo(f.home, 'one'), repo(f.home, 'two')];
    f.store.update((d) => { d.characters.c_a = char('c_a', 'i_1', { cwd: one }); });
    const follow = (id: string, cwd: string): Promise<void> => f.fleet['followCwd'](id, cwd);
    return { ...f, one, two, follow };
  };

  it('moves the character to the root of the checkout its hook reports', async () => {
    const { store, two, follow } = setup();
    await follow('c_a', path.join(two, 'src'));
    expect(store.state.characters.c_a.cwd).toBe(two);
  });

  it('ignores a hook from the second terminal', () => {
    const { fleet, store, one, two } = setup();
    const follow = vi.spyOn(fleet as unknown as { followCwd: () => Promise<void> }, 'followCwd');
    fleet.onSocketEvent({ hook: { charId: 'c_a', backend: 'claude', name: 'PreToolUse', cwd: two, term: 2 } });
    expect(follow).not.toHaveBeenCalled();
    expect(store.state.characters.c_a.cwd).toBe(one);
  });

  it('keeps the path a character has within the checkout the hook reports', async () => {
    const { store, one, follow } = setup();
    store.update((d) => { d.characters.c_a.cwd = path.join(one, 'src'); });
    await follow('c_a', path.join(one, 'lib'));
    expect(store.state.characters.c_a.cwd).toBe(path.join(one, 'src'));
  });

  it('stays put for a hook outside any checkout', async () => {
    const { store, home, one, follow } = setup();
    await follow('c_a', fs.realpathSync(home));
    expect(store.state.characters.c_a.cwd).toBe(one);
  });

  it('acts on a reported directory once, so a hook repeating it does not undo a move the pane made since', async () => {
    const { store, one, two, follow } = setup();
    await follow('c_a', two);
    store.update((d) => { d.characters.c_a.cwd = one; });
    await follow('c_a', two);
    expect(store.state.characters.c_a.cwd).toBe(one);
  });

  it('asks git nothing for a character that is gone', async () => {
    const { two, follow } = setup();
    vi.mocked(resolveRepo).mockClear();
    await follow('c_gone', two);
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  it('logs a directory a hook reported but the fleet could not follow', async () => {
    const errors: string[] = [];
    const { fleet, two } = setup({ info() {}, error: (m) => errors.push(m) });
    vi.mocked(resolveRepo).mockRejectedValueOnce(new Error('git went away'));
    fleet.onSocketEvent({ hook: { charId: 'c_a', backend: 'claude', name: 'PreToolUse', cwd: two } });
    await waitFor(() => errors.length > 0);
    expect(errors).toEqual([`follow c_a to ${two}: Error: git went away`]);
  });

  it('follows the newer of two reports when git answers the older one last', async () => {
    const { store, home, two, follow } = setup();
    const three = repo(home, 'three');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const real = vi.mocked(resolveRepo).getMockImplementation()!;
    vi.mocked(resolveRepo).mockImplementationOnce(async (dir) => { await held; return real(dir); });
    const older = follow('c_a', two);
    await follow('c_a', three);
    release();
    await older;
    expect(store.state.characters.c_a.cwd).toBe(three);
  });

  it('leaves a character closed while git answered closed', async () => {
    const { store, two, follow } = setup();
    const moving = follow('c_a', two);
    store.update((d) => { delete d.characters.c_a; });
    await expect(moving).resolves.toBeUndefined();
    expect(store.state.characters.c_a).toBeUndefined();
  });
});

describe('Store.update', () => {
  it('keeps mission control under every island the change moves', () => {
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const island = (id: string, y: number) => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y }, size: { w: 6, h: 4 }, seed: 1 });
    store.update((d) => { d.islands[HOME_ISLAND] = { ...island(HOME_ISLAND, 10), kind: 'home' }; d.islands.i_1 = island('i_1', 0); });
    store.update((d) => { d.islands.i_1.position.y = 20; });
    expect(worldIslands(store.state).every((i) => aboveHome(store.state, i))).toBe(true);
  });
});

describe('moving a character to another island by update', () => {
  it('places it beside the crew there, on ground grown for one more', async () => {
    const { fleet, store } = fleetOn(() => {});
    const a = fleet.createIsland({ name: 'a' });
    const b = fleet.createIsland({ name: 'b' });
    const mover = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const stayer = await fleet.createCharacter({ islandId: b.id, cwd: '/tmp' });
    fleet.updateCharacter(mover.id, { islandId: b.id });
    const s = store.state;
    const { size, cells } = crewGrid(2);
    expect(s.islands[b.id].size).toEqual(size);
    expect([s.characters[stayer.id].cell, s.characters[mover.id].cell]).toEqual(cells);
    expect(placementOk(s, s.islands[b.id])).toBe(true);
  });
});

describe('char.wait over a socket', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

  it('is called off when the socket that asked closes', async () => {
    const { fleet, store, home, paths } = fleetOn((d) => {
      d.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
      d.characters.c_a = char('c_a', 'i_1', { tmux: { windowId: '@1', paneId: '%1' } });
    });
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    const workspace = new Workspace(() => home, silentLogger, () => [claude.json], [paths.docs]);
    const api = await startApi({
      host: '127.0.0.1', port: 0, token: 'secret', store, fleet, fleets: stubFleets, terminals: new TerminalHub(fleet, new Tmux(paths.tmuxSock, paths.tmuxConf), store, silentLogger),
      workspace, usage: stubUsage, mobileControl: stubMobile, log: silentLogger,
      push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(), claude, docs: paths.docs,
    });
    cleanup.push(async () => { await api.close(); workspace.close(); });
    let signal: AbortSignal | undefined;
    const wait = fleet.waitFor.bind(fleet);
    vi.spyOn(fleet, 'waitFor').mockImplementation((id, until, timeoutMs, s, term) => { signal = s; return wait(id, until, timeoutMs, s, term); });

    const ws = new WebSocket(`ws://127.0.0.1:${api.port}`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ token: 'secret' }));
    ws.send(JSON.stringify({ id: 1, method: 'char.wait', params: { id: 'c_a', until: ['done'], timeoutMs: 60_000 } }));
    await waitFor(() => signal !== undefined);
    expect(signal!.aborted).toBe(false);
    ws.close();
    await waitFor(() => signal!.aborted, 2000);
  });
});
