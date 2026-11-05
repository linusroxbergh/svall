import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type FleetState, type MachineId, type Robot } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { fleetKeys, resolvePaths } from '../src/paths.js';
import { resolveRepo } from '../src/links/git.js';
import { workspaceRoot } from '../src/resources/scan.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { isFolder, startFolders } from '../src/workspace/clones.js';
import { fleetConfigFile } from '../src/workspace/fleet-config.js';
import { Workspace } from '../src/workspace/workspace.js';
import { cleanHomes, makeHome } from './helpers.js';

const FLEET = crypto.randomUUID();
const ME = crypto.randomUUID() as MachineId;
const OTHER = crypto.randomUUID() as MachineId;

const folder = (...at: string[]): string => { const p = path.join(...at); fs.mkdirSync(p, { recursive: true }); return p; };
const clone = (...at: string[]): string => { const p = folder(...at); fs.mkdirSync(path.join(p, '.git')); return p; };
const robot = (id: string, o: Partial<Robot>): Robot => ({ id, ...o }) as Robot;
const state = (root: string, robots: Robot[]): FleetState => ({
  ...emptyState(), defaultCwd: folder(root, 'code'), home: { ...emptyState().home, cwd: folder(root, 'mc') }, robots: Object.fromEntries(robots.map((c) => [c.id, c])),
});

afterEach(cleanHomes);

describe('where a new robot can start', () => {
  it('lists where each robot here starts from, the clones the default folder holds, then the fleet\'s two folders', () => {
    const root = makeHome();
    const plain = folder(root, 'plain');
    const main = clone(root, 'app');
    const tree = folder(root, 'app-trees/one');
    const f = state(root, [robot('c1', { cwd: plain }), robot('c2', { cwd: tree, repo: { mainRoot: main, isWorktree: true } as Robot['repo'] })]);
    const held = clone(f.defaultCwd, 'held');
    expect(startFolders(f, () => true).folders).toEqual([
      { path: main, clone: true }, { path: plain, clone: false }, { path: held, clone: true }, { path: f.defaultCwd, clone: false }, { path: f.home.cwd, clone: false },
    ]);
  });

  it('leaves out a robot elsewhere, a folder gone, and what in the default folder is no clone', () => {
    const root = makeHome();
    const far = folder(root, 'far');
    const f = state(root, [robot('c1', { cwd: far, machine: OTHER }), robot('c2', { cwd: path.join(root, 'gone') }), robot('c3', { cwd: path.join(far, 'x.txt', 'under') })]);
    fs.writeFileSync(path.join(far, 'x.txt'), '');
    folder(f.defaultCwd, 'not-a-clone');
    fs.writeFileSync(path.join(f.defaultCwd, 'a-file'), '');
    fs.symlinkSync(clone(root, 'out'), path.join(f.defaultCwd, 'link-out'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(f.defaultCwd, 'dangling'));
    expect(startFolders(f, (c) => c.machine === undefined).folders.map((x) => x.path)).toEqual([f.defaultCwd, f.home.cwd]);
  });

  it('says a folder is a clone by the robot in it or by its .git, and a file named .git counts, as a worktree\'s is', () => {
    const root = makeHome();
    const inRepo = folder(root, 'known');
    const below = folder(root, 'repo/pkg');
    const linked = folder(root, 'linked');
    fs.writeFileSync(path.join(linked, '.git'), 'gitdir: elsewhere\n');
    const f = state(root, [
      robot('c1', { cwd: inRepo, repo: { mainRoot: inRepo } as Robot['repo'] }),
      robot('c2', { cwd: below, repo: { mainRoot: path.dirname(below) } as Robot['repo'] }),
      robot('c3', { cwd: linked }),
    ]);
    expect(startFolders(f, () => true).folders.filter((x) => x.clone).map((x) => x.path)).toEqual([inRepo, linked, below]);
  });

  it('names the fleet\'s two folders as this machine spells them, from what a new fleet\'s state holds', () => {
    const f = emptyState();
    expect([f.defaultCwd, f.home.cwd.slice(0, 2)]).toEqual(['~', '~/']);
    const { folders, defaults } = startFolders(f, () => true);
    expect(defaults).toEqual({ cwd: os.homedir(), home: path.join(os.homedir(), f.home.cwd.slice(2)) });
    expect(folders.map((x) => x.path)).toContain(os.homedir());
  });

  it('leaves out a dot folder, however much of a clone, which a typed path still reaches', async () => {
    const root = makeHome();
    const f = state(root, []);
    const hidden = clone(f.defaultCwd, '.nvm');
    const shown = clone(f.defaultCwd, 'app');
    expect(startFolders(f, () => true).folders.map((x) => x.path)).toEqual([shown, f.defaultCwd, f.home.cwd]);
    expect(isFolder(hidden)).toBe(true);
  });

  it('leaves out a folder it cannot read, and the rest stand', () => {
    const root = makeHome();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    const f = state(root, [robot('c1', { cwd: path.join(root, 'a') })]);
    expect(startFolders(f, () => true).folders.map((x) => x.path)).toEqual([f.defaultCwd, f.home.cwd]);
  });
});

describe('workspace.clones', () => {
  const ctx = (o: object = {}) => {
    const root = makeHome();
    const c = folder(root, 'here');
    return { c, ctx: { viewer: { kind: 'app' }, store: { state: state(root, [robot('c1', { cwd: c }), robot('c2', { cwd: folder(root, 'away'), machine: OTHER })]) }, fleetHome: () => ({ machine: ME, name: 'studio', mine: true, me: ME }), ...o } as unknown as Ctx };
  };

  it('answers on the home, naming it, with its own robots\' folders alone', async () => {
    const { c, ctx: home } = ctx({ router: { runsHere: (r: Robot) => r.machine === undefined } });
    const res = await dispatch({ id: 1, method: 'workspace.clones', params: {} }, home) as { result: { machine: string; folders: { path: string }[] } };
    expect(res.result.machine).toBe(ME);
    expect(res.result.folders[0].path).toBe(c);
    expect(res.result.folders.filter((f) => f.path.endsWith('/away'))).toEqual([]);
  });

  it('is not open to a phone, whose list is its own', async () => {
    expect(await dispatch({ id: 1, method: 'workspace.clones', params: {} }, ctx({ viewer: { kind: 'phone' } }).ctx)).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('on a worker reads its own disk and names itself, and asks the home nothing', async () => {
    const toHome = vi.fn(() => Promise.reject(new Error('sent home')));
    const worker = { machine: OTHER, name: 'studio', mine: false, me: ME };
    const { ctx: c } = ctx({ fleetHome: () => worker, router: { onWorker: true, toHome, placedAt: () => undefined, runsHere: (r: Robot) => r.machine === ME } });
    expect(await dispatch({ id: 1, method: 'workspace.clones', params: {} }, c)).toMatchObject({ result: { machine: ME } });
    expect(toHome).not.toHaveBeenCalled();
  });
});

describe('a typed path, which the home checks before the robot starts', () => {
  const window = vi.fn(() => Promise.reject(new Error('a window opened')));
  const fleetOn = () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const fleet = new Fleet({ store, tmux: { newWindow: window } as unknown as Tmux, paths, config: Config.parse({}), log: silentLogger });
    return { fleet, islandId: fleet.createIsland({ name: 'x' }).id, root: paths.home };
  };

  it.each([
    ['no folder', (r: string) => path.join(r, 'x')],
    ['a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); return path.join(r, 'f'); }],
    ['under a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); return path.join(r, 'f', 'x'); }],
    ['a link that leads nowhere', (r: string) => { fs.symlinkSync(path.join(r, 'gone'), path.join(r, 'l')); return path.join(r, 'l'); }],
    ['a link to a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); fs.symlinkSync(path.join(r, 'f'), path.join(r, 'l')); return path.join(r, 'l'); }],
    ['a relative path, even to a folder there is', () => '.'],
  ])('refuses %s, opening no window', async (_name, make) => {
    window.mockClear();
    const { fleet, islandId, root } = fleetOn();
    await expect(fleet.createRobot({ islandId, cwd: make(root) })).rejects.toMatchObject({ code: 'not_a_folder' });
    expect(window).not.toHaveBeenCalled();
  });

  it('says what stops it from reading a path, rather than call it no folder', async () => {
    window.mockClear();
    const { fleet, islandId, root } = fleetOn();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    await expect(fleet.createRobot({ islandId, cwd: path.join(root, 'a') })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(window).not.toHaveBeenCalled();
  });

  it('says an island gone while the window opened is gone, rather than crash on it', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const fleet: Fleet = new Fleet({ store, tmux: new Proxy({}, { get: (_t, k) => (k === 'newWindow' ? async () => { fleet.deleteIsland(islandId); return { windowId: '@1', paneId: '%1' }; } : async () => {}) }) as Tmux, paths, config: Config.parse({}), log: silentLogger });
    const islandId = fleet.createIsland({ name: 'x' }).id;
    await expect(fleet.createRobot({ islandId, cwd: paths.home })).rejects.toMatchObject({ code: 'not_found', message: `no island ${islandId}` });
  });

  it('starts in a link that leads to a folder, wherever that is, as the CLI does', async () => {
    window.mockClear();
    const { fleet, islandId, root } = fleetOn();
    fs.symlinkSync(folder(makeHome(), 'elsewhere'), path.join(root, 'l'));
    await expect(fleet.createRobot({ islandId, cwd: path.join(root, 'l') })).rejects.toThrow('a window opened');
  });
});

describe('fleet.json in the editor', () => {
  const home = () => {
    const paths = resolvePaths(makeHome());
    fs.writeFileSync(paths.fleetConfig, `{"id":"${FLEET}"}\n`);
    fs.writeFileSync(paths.state, '{"secret":"state"}');
    fs.writeFileSync(paths.token, 'held');
    const store = Store.load(path.join(paths.home, 'other-state.json'), () => {});
    const refused = () => fleetKeys(paths);
    const claude = { dir: folder(paths.home, 'claude'), json: path.join(paths.home, 'claude.json') };
    const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude), silentLogger, refused);
    const fleetConfig = fleetConfigFile(paths, silentLogger, refused);
    const { rootId } = fleetConfig;
    const ctx = (kind = 'app') => ({ viewer: { kind }, store, workspace, fleetConfig }) as unknown as Ctx;
    return { paths, rootId, ctx };
  };
  const mtime = (file: string) => fs.statSync(file).mtimeMs;

  it('names its root on the home, and a worker holds none', async () => {
    const { rootId, ctx } = home();
    expect(await dispatch({ id: 1, method: 'fleet.config', params: {} }, ctx())).toEqual({ id: 1, result: { rootId, path: 'fleet.json' } });
    expect(await dispatch({ id: 1, method: 'fleet.config', params: {} }, { ...ctx(), fleetConfig: undefined } as Ctx)).toMatchObject({ error: { code: 'not_on_worker' } });
    expect(await dispatch({ id: 1, method: 'fleet.config', params: {} }, ctx('phone'))).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('reads and writes that one file', async () => {
    const { paths, rootId, ctx } = home();
    const read = await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: 'fleet.json' } }, ctx()) as { result: { text: string; mtimeMs: number; root: string } };
    expect(read.result.text).toBe(`{"id":"${FLEET}"}\n`);
    const text = `{"id":"${FLEET}","name":"studio"}\n`;
    expect(await dispatch({ id: 2, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text, mtimeMs: read.result.mtimeMs, root: read.result.root } }, ctx())).toMatchObject({ result: { mtimeMs: expect.any(Number) } });
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(text);
  });

  it.each(['state.json', 'token', './fleet.json', 'x/../state.json', '../fleet.json', ''])('reaches nothing else through its root: %s', async (rel) => {
    const { rootId, ctx } = home();
    const unknownRoot = { error: { code: 'not_found', message: `no robot ${rootId}` } };
    expect(await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: rel } }, ctx())).toMatchObject(unknownRoot);
    expect(await dispatch({ id: 2, method: 'fs.write', params: { id: rootId, path: rel, text: '{}', mtimeMs: 0 } }, ctx())).toMatchObject(unknownRoot);
  });

  it('reaches state.json by no absolute path, and lists, deletes or renames nothing there', async () => {
    const { paths, rootId, ctx } = home();
    expect(await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: paths.state } }, ctx())).toMatchObject({ error: { code: 'not_found' } });
    expect(await dispatch({ id: 2, method: 'fs.list', params: { id: rootId, path: '' } }, ctx())).toMatchObject({ error: { code: 'not_found' } });
    expect(await dispatch({ id: 3, method: 'docs.delete', params: { id: rootId, path: 'fleet.json' } }, ctx())).toMatchObject({ error: { code: 'not_found' } });
    expect(await dispatch({ id: 4, method: 'docs.rename', params: { id: rootId, path: 'fleet.json', to: 'x.json' } }, ctx())).toMatchObject({ error: { code: 'not_found' } });
    expect(fs.existsSync(paths.fleetConfig)).toBe(true);
  });

  it('is not open to a phone, for a read or a write', async () => {
    const { paths, rootId, ctx } = home();
    expect(await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: 'fleet.json' } }, ctx('phone'))).toMatchObject({ error: { code: 'forbidden' } });
    const before = fs.readFileSync(paths.fleetConfig, 'utf8');
    expect(await dispatch({ id: 2, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text: `{"id":"${FLEET}","mobile":{"logins":["x"]}}`, mtimeMs: mtime(paths.fleetConfig) } }, ctx('phone'))).toMatchObject({ error: { code: 'forbidden' } });
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(before);
  });

  it('refuses another fleet\'s id, which would cut the window off its home, and keeps the file', async () => {
    const { paths, rootId, ctx } = home();
    const other = `{"id":"${crypto.randomUUID()}"}`;
    const res = await dispatch({ id: 1, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text: other, mtimeMs: mtime(paths.fleetConfig) } }, ctx());
    expect(res).toMatchObject({ error: { code: 'invalid', message: `fleet.json's id is this fleet's own: keep it as ${FLEET}` } });
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(`{"id":"${FLEET}"}\n`);
  });

  it('repairs a file that does not parse, to any id', async () => {
    const { paths, rootId, ctx } = home();
    fs.writeFileSync(paths.fleetConfig, '{ broken');
    const text = `{"id":"${crypto.randomUUID()}"}`;
    expect(await dispatch({ id: 1, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text, mtimeMs: mtime(paths.fleetConfig) } }, ctx())).toMatchObject({ result: { mtimeMs: expect.any(Number) } });
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(text);
  });

  it.each([['out of the fleet home', () => makeHome()], ['inside it', (h: string) => folder(h, 'kept')]])('reads and writes through a link %s, which stays a link', async (_name, dir) => {
    const { paths, rootId, ctx } = home();
    const real = path.join(dir(paths.home), 'real-fleet.json');
    fs.writeFileSync(real, `{"id":"${FLEET}"}\n`);
    fs.rmSync(paths.fleetConfig);
    fs.symlinkSync(real, paths.fleetConfig);
    const read = await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: 'fleet.json' } }, ctx()) as { result: { text: string; mtimeMs: number; root: string } };
    expect(read.result.text).toBe(`{"id":"${FLEET}"}\n`);
    const text = `{"id":"${FLEET}","name":"studio"}\n`;
    expect(await dispatch({ id: 2, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text, mtimeMs: read.result.mtimeMs, root: read.result.root } }, ctx())).toMatchObject({ result: { mtimeMs: expect.any(Number) } });
    expect(fs.readFileSync(real, 'utf8')).toBe(text);
    expect(fs.lstatSync(paths.fleetConfig).isSymbolicLink()).toBe(true);
  });

  it('refuses a link to a key, for a read and a write, and leaves the key', async () => {
    const { paths, rootId, ctx } = home();
    fs.rmSync(paths.fleetConfig);
    fs.symlinkSync(paths.token, paths.fleetConfig);
    expect(await dispatch({ id: 1, method: 'fs.read', params: { id: rootId, path: 'fleet.json' } }, ctx())).toMatchObject({ error: { code: 'invalid' } });
    expect(await dispatch({ id: 2, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text: `{"id":"${FLEET}"}`, mtimeMs: mtime(paths.token) } }, ctx())).toMatchObject({ error: { code: 'invalid' } });
    expect(fs.readFileSync(paths.token, 'utf8')).toBe('held');
  });

  it.each([['no JSON', '{ nope'], ['another shape', '{"defaultCwd":7}']])('refuses %s, which a daemon could not start on, and keeps the file', async (_name, text) => {
    const { paths, rootId, ctx } = home();
    const res = await dispatch({ id: 1, method: 'fs.write', params: { id: rootId, path: 'fleet.json', text, mtimeMs: mtime(paths.fleetConfig) } }, ctx());
    expect(res).toMatchObject({ error: { code: 'invalid', message: expect.stringContaining('invalid config') } });
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(`{"id":"${FLEET}"}\n`);
  });
});

describe('a worker away from its home', () => {
  it('reads no repository in a folder that is not there, the answer its clone rule turns into words', async () => {
    expect(await resolveRepo(path.join(makeHome(), 'no-such'))).toBeUndefined();
  });
});
