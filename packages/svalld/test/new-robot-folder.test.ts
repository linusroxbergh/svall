import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type FleetState, type Island, type MachineId, type Robot } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { fleetKeys, resolvePaths } from '../src/paths.js';
import { cloneGit, resolveRepo, type GitRunner } from '../src/links/git.js';
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

afterEach(() => { vi.unstubAllEnvs(); cleanHomes(); });

const isl = (id: string, o: Partial<Island> = {}): Island => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1, ...o });
const mac = { [OTHER]: { name: 'mac', reachable: true, since: 0, home: '/Users/a' } };
const onMac = (id: string, mainRoot: string): Robot => robot(id, {
  islandId: 'i1', machine: OTHER, cwd: `${mainRoot}/.claude/worktrees/${id}`, repo: { root: `${mainRoot}/.claude/worktrees/${id}`, mainRoot, branch: id, isWorktree: true },
});

describe('where a new robot on an island starts', () => {
  it('puts the island\'s folder first and starts there', async () => {
    const root = makeHome();
    const app = clone(root, 'app');
    const f = { ...state(root, [robot('c1', { islandId: 'i1', cwd: folder(root, 'plain') })]), islands: { i1: isl('i1', { folder: '~/app' }) } };
    const r = await startFolders(f, () => true, { islandId: 'i1', homedir: root });
    expect(r.folders.slice(0, 2)).toEqual([{ path: app, clone: true }, { path: path.join(root, 'plain'), clone: false }]);
    expect(r.start).toBe(app);
  });

  it('else starts beside the robot asked for, of the island\'s own', async () => {
    const root = makeHome();
    const f = { ...state(root, [robot('c1', { islandId: 'i1', cwd: folder(root, 'one') }), robot('c2', { islandId: 'i1', cwd: folder(root, 'two') })]), islands: { i1: isl('i1', { folder: '~/gone' }) } };
    expect((await startFolders(f, () => true, { islandId: 'i1', beside: 'c2', homedir: root })).start).toBe(path.join(root, 'two'));
  });

  it('offers the repo a robot of the island works in elsewhere, at its place here, to clone when it is missing', async () => {
    const root = makeHome();
    const f = { ...state(root, [onMac('c1', '/Users/a/x')]), islands: { i1: isl('i1') }, machines: mac };
    const probe = vi.fn(async () => 'https://tok@github.com/a/x.git');
    const r = await startFolders(f, (c) => c.machine === undefined, { islandId: 'i1', probe, homedir: root });
    expect(r.folders[0]).toEqual({ path: path.join(root, 'x'), clone: true, remote: 'https://github.com/a/x.git', from: OTHER });
    expect(r.start).toBe(path.join(root, 'x'));
    expect(probe).toHaveBeenCalledWith(OTHER, '/Users/a/x');
  });

  it('offers the island\'s folder from the machine that holds it after what is here, and asks nothing of a place already here', async () => {
    const root = makeHome();
    const here = clone(root, 'x');
    const f = { ...state(root, [onMac('c1', '/Users/a/x')]), islands: { i1: isl('i1', { folder: '~/app' }) }, machines: mac };
    const probe = vi.fn(async (_m: MachineId, p: string) => (p === '/Users/a/app' ? 'git@github.com:a/app.git' : undefined));
    const r = await startFolders(f, (c) => c.machine === undefined, { islandId: 'i1', probe, homedir: root });
    expect(r.folders.slice(0, 2)).toEqual([{ path: here, clone: true }, { path: path.join(root, 'app'), clone: true, remote: 'git@github.com:a/app.git', from: OTHER }]);
    expect(probe.mock.calls).toEqual([[OTHER, '/Users/a/app']]);
  });

  it('offers the island\'s folder from a machine none of its robots is on', async () => {
    const root = makeHome();
    const f = { ...state(root, []), islands: { i1: isl('i1', { folder: '~/app' }) }, machines: mac };
    const probe = vi.fn(async () => 'git@github.com:a/app.git');
    const r = await startFolders(f, () => true, { islandId: 'i1', probe, homedir: root });
    expect(r.folders[0]).toEqual({ path: path.join(root, 'app'), clone: true, remote: 'git@github.com:a/app.git', from: OTHER });
    expect(probe.mock.calls).toEqual([[OTHER, '/Users/a/app']]);
  });

  it('offers no clone the other machine cannot name a remote for, and then starts nowhere in particular', async () => {
    const root = makeHome();
    const f = { ...state(root, [onMac('c1', '/Users/a/x')]), islands: { i1: isl('i1') }, machines: mac };
    const r = await startFolders(f, (c) => c.machine === undefined, { islandId: 'i1', probe: async () => undefined, homedir: root });
    expect(r.folders.filter((x) => x.remote)).toEqual([]);
    expect(r.start).toBeUndefined();
  });

  it('starts mission control in its own folder', async () => {
    const root = makeHome();
    const f = { ...state(root, []), islands: { home: isl('home', { kind: 'home' }) } };
    expect((await startFolders(f, () => true, { islandId: 'home', homedir: root })).start).toBe(f.home.cwd);
  });
});

describe('where a new robot can start', () => {
  it('lists where each robot here starts from, the clones the default folder holds, then the fleet\'s two folders', async () => {
    const root = makeHome();
    const plain = folder(root, 'plain');
    const main = clone(root, 'app');
    const tree = folder(root, 'app-trees/one');
    const f = state(root, [robot('c1', { cwd: plain }), robot('c2', { cwd: tree, repo: { mainRoot: main, isWorktree: true } as Robot['repo'] })]);
    const held = clone(f.defaultCwd, 'held');
    expect((await startFolders(f, () => true)).folders).toEqual([
      { path: main, clone: true }, { path: plain, clone: false }, { path: held, clone: true }, { path: f.defaultCwd, clone: false }, { path: f.home.cwd, clone: false },
    ]);
  });

  it('leaves out a robot elsewhere, a folder gone, and what in the default folder is no clone', async () => {
    const root = makeHome();
    const far = folder(root, 'far');
    const f = state(root, [robot('c1', { cwd: far, machine: OTHER }), robot('c2', { cwd: path.join(root, 'gone') }), robot('c3', { cwd: path.join(far, 'x.txt', 'under') })]);
    fs.writeFileSync(path.join(far, 'x.txt'), '');
    folder(f.defaultCwd, 'not-a-clone');
    fs.writeFileSync(path.join(f.defaultCwd, 'a-file'), '');
    fs.symlinkSync(clone(root, 'out'), path.join(f.defaultCwd, 'link-out'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(f.defaultCwd, 'dangling'));
    expect((await startFolders(f, (c) => c.machine === undefined)).folders.map((x) => x.path)).toEqual([f.defaultCwd, f.home.cwd]);
  });

  it('says a folder is a clone by the robot in it or by its .git, and a file named .git counts, as a worktree\'s is', async () => {
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
    expect((await startFolders(f, () => true)).folders.filter((x) => x.clone).map((x) => x.path)).toEqual([inRepo, linked, below]);
  });

  it('names the fleet\'s two folders as this machine spells them, from what a new fleet\'s state holds', async () => {
    const f = emptyState();
    expect([f.defaultCwd, f.home.cwd.slice(0, 2)]).toEqual(['~', '~/']);
    const { folders, defaults } = await startFolders(f, () => true);
    expect(defaults).toEqual({ cwd: os.homedir(), home: path.join(os.homedir(), f.home.cwd.slice(2)) });
    expect(folders.map((x) => x.path)).toContain(os.homedir());
  });

  it('leaves out a dot folder, however much of a clone, which a typed path still reaches', async () => {
    const root = makeHome();
    const f = state(root, []);
    const hidden = clone(f.defaultCwd, '.nvm');
    const shown = clone(f.defaultCwd, 'app');
    expect((await startFolders(f, () => true)).folders.map((x) => x.path)).toEqual([shown, f.defaultCwd, f.home.cwd]);
    expect(isFolder(hidden)).toBe(true);
  });

  it('leaves out a folder it cannot read, and the rest stand', async () => {
    const root = makeHome();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    const f = state(root, [robot('c1', { cwd: path.join(root, 'a') })]);
    expect((await startFolders(f, () => true)).folders.map((x) => x.path)).toEqual([f.defaultCwd, f.home.cwd]);
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

  it('asks the machine an island\'s repo is on for its remote, on the home alone', async () => {
    const root = makeHome();
    const name = `x-${crypto.randomUUID()}`;
    const f = { ...state(root, [onMac('c1', `/Users/a/${name}`)]), islands: { i1: isl('i1') }, machines: mac };
    const call = vi.fn(async () => ({ state: 'clone', remote: 'git@github.com:a/x.git', refs: [] }));
    const base = { viewer: { kind: 'app' }, store: { state: f }, fleetHome: () => ({ machine: ME, name: 'studio', mine: true, me: ME }), router: { runsHere: (r: Robot) => r.machine === undefined } };
    const clones = async (o: object) => ((await dispatch({ id: 1, method: 'workspace.clones', params: { islandId: 'i1' } }, { ...base, ...o } as unknown as Ctx)) as { result: { folders: { remote?: string }[]; start?: string } }).result;
    expect((await clones({ links: { call } })).folders[0]).toEqual({ path: path.join(os.homedir(), name), clone: true, remote: 'git@github.com:a/x.git', from: OTHER });
    expect(call).toHaveBeenCalledWith(OTHER, 'repo.probe', { path: `/Users/a/${name}` }, { timeoutMs: 5_000 });
    const away = await clones({});
    expect([away.folders.filter((x) => x.remote), away.start]).toEqual([[], undefined]);
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
    ['no folder', (r: string) => path.join(r, 'x'), 'missing'],
    ['a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); return path.join(r, 'f'); }, 'file'],
    ['under a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); return path.join(r, 'f', 'x'); }, 'missing'],
    ['a link that leads nowhere', (r: string) => { fs.symlinkSync(path.join(r, 'gone'), path.join(r, 'l')); return path.join(r, 'l'); }, 'missing'],
    ['a link to a file', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); fs.symlinkSync(path.join(r, 'f'), path.join(r, 'l')); return path.join(r, 'l'); }, 'file'],
    ['a file named from ~, as the window sends it', (r: string) => { fs.writeFileSync(path.join(r, 'f'), ''); vi.stubEnv('HOME', r); return '~/f'; }, 'file'],
    ['a relative path, even to a folder there is', () => '.', undefined],
  ])('refuses %s, opening no window, and says whether something else stands there', async (_name, make, kind) => {
    window.mockClear();
    const { fleet, islandId, root } = fleetOn();
    const refused = await fleet.createRobot({ islandId, cwd: make(root) }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'not_a_folder' });
    expect((refused as { data?: unknown }).data).toEqual(kind && { kind });
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

describe('a folder New robot clones before the robot starts', () => {
  const window = vi.fn(() => Promise.reject(new Error('a window opened')));
  const source = () => {
    const src = folder(makeHome(), 'src');
    execFileSync('git', ['init', '-q', src]);
    execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one']);
    return src;
  };
  const fleetOn = () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const clones: string[][] = [];
    const counted: GitRunner = (args, cwd) => { clones.push([...args]); return cloneGit(args, cwd); };
    const fleet = new Fleet({ store, tmux: { newWindow: window } as unknown as Tmux, paths, config: Config.parse({}), log: silentLogger, cloneGit: counted });
    return { fleet, islandId: fleet.createIsland({ name: 'x' }).id, root: paths.home, clones };
  };

  it('clones the remote into a folder that is not there, then starts in it', async () => {
    const { fleet, islandId, root } = fleetOn();
    const cwd = path.join(root, 'code', 'app');
    await expect(fleet.createRobot({ islandId, cwd, remote: source() })).rejects.toThrow('a window opened');
    expect(fs.existsSync(path.join(cwd, '.git'))).toBe(true);
  });

  it('clones once for two robots started into the same folder at once', async () => {
    const { fleet, islandId, root, clones } = fleetOn();
    const [cwd, remote] = [path.join(root, 'app'), source()];
    const both = await Promise.allSettled([fleet.createRobot({ islandId, cwd, remote }), fleet.createRobot({ islandId, cwd, remote })]);
    expect(both.map((r) => r.status === 'rejected' && (r.reason as Error).message)).toEqual(['a window opened', 'a window opened']);
    expect(clones).toHaveLength(1);
  });

  it('says why a clone failed, and opens no window', async () => {
    window.mockClear();
    const { fleet, islandId, root } = fleetOn();
    const cwd = path.join(root, 'app');
    await expect(fleet.createRobot({ islandId, cwd, remote: path.join(root, 'no-such-repo') })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('git clone') });
    expect(fs.existsSync(cwd)).toBe(false);
    expect(window).not.toHaveBeenCalled();
  });

  it('clones nothing into a folder already there', async () => {
    const { fleet, islandId, root, clones } = fleetOn();
    await expect(fleet.createRobot({ islandId, cwd: folder(root, 'app'), remote: source() })).rejects.toThrow('a window opened');
    expect(clones).toEqual([]);
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
