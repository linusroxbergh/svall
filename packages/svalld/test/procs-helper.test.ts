import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { readProcs } from '../src/load/procs.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { hookHelperSources } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, ownerOf, waitFor } from './helpers.js';

const helperDir = fs.mkdtempSync('/tmp/svall-procs-');
const helper = path.join(helperDir, 'svall-hook');
const children: ChildProcess[] = [];

beforeAll(() => { execFileSync('swiftc', ['-O', '-wmo', '-o', helper, ...hookHelperSources().filter((f) => f.endsWith('.swift'))]); }, 180_000);
afterAll(() => fs.rmSync(helperDir, { recursive: true, force: true }));
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

type Row = { pid: number; ppid: number; start: number; cpu: number; mem: number; resp?: number; path: string; args: string; char?: string; home?: string };
const procs = (): Row[] => JSON.parse(execFileSync(helper, ['procs'], { encoding: 'utf8' })).procs;
const PROBE = { SVALL_CHAR_ID: 'c_probe', SVALL_HOME: '/tmp/svall-probe-home' };
// Homebrew's and python.org's Python exec a binary inside Python.framework's Python.app
const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'].find((p) => fs.existsSync(p));
const child = (code: string): ChildProcess => {
  const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore', env: { ...process.env, ...PROBE } });
  children.push(c);
  return c;
};

describe('svall-hook procs', () => {
  it('lists a child with its env marks, its parent and its memory', async () => {
    const c = child('setInterval(()=>{},1000)');
    await new Promise((r) => setTimeout(r, 300));
    const row = procs().find((p) => p.pid === c.pid);
    expect(row).toBeDefined();
    expect(row!.char).toBe('c_probe');
    expect(row!.home).toBe('/tmp/svall-probe-home');
    expect(row!.ppid).toBe(process.pid);
    expect(row!.mem).toBeGreaterThan(0);
    expect(row!.cpu).toBeGreaterThanOrEqual(0);
    expect(row!.start).toBeGreaterThan(0);
    expect(row!.args).toContain('setInterval');
    expect(row!.path).toBe(fs.realpathSync(process.execPath));
  });

  it('reports CPU time in nanoseconds', async () => {
    const c = child('const t=Date.now();while(Date.now()-t<300);setInterval(()=>{},1000)');
    await new Promise((r) => setTimeout(r, 1000));
    const ps = execFileSync('ps', ['-o', 'time=', '-p', String(c.pid)], { encoding: 'utf8' }).trim();
    const [min, sec] = ps.split(':');
    const psNs = (Number(min) * 60 + Number(sec)) * 1e9;
    const row = procs().find((p) => p.pid === c.pid)!;
    expect(Math.abs(row.cpu - psNs)).toBeLessThan(50e6);
  });

  it('lists no process of another user', () => {
    expect(procs().some((p) => p.pid === 1)).toBe(false);
  });

  it("reads a framework Python's marks and arguments, though its binary sits in Python.app", async (ctx) => {
    if (!python) return ctx.skip('no framework Python is installed');
    const c = spawn(python, ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore', env: { ...process.env, ...PROBE } });
    children.push(c);
    await waitFor(() => procs().some((p) => p.pid === c.pid && p.path.includes('.app/')));
    const row = procs().find((p) => p.pid === c.pid)!;
    expect(row.char).toBe('c_probe');
    expect(row.home).toBe('/tmp/svall-probe-home');
    expect(row.args).toContain('time.sleep(60)');
  });

  it('leaves the arguments and marks of apps out', (ctx) => {
    const app = procs().find((p) => p.path.includes('.app/') && !p.path.slice(0, p.path.indexOf('.app/')).includes('.framework/'));
    if (!app) return ctx.skip('no app process of this user is running');
    expect(app.args).toBe('');
    expect(app.char).toBeUndefined();
    expect(app.home).toBeUndefined();
    expect(app.mem).toBeGreaterThan(0);
  });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

(hasTmux() ? describe : describe.skip)('deleting a robot', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot(read: () => ReturnType<typeof readProcs>) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh', home: { cwd: path.join(home, 'mc') } });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store: Store.load(paths.state, () => {}), tmux, paths, config, ownership: ownerOf(home, config.id), log: silentLogger, pollMs: 150, processes: async () => [], readProcs: read });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); await fleet.stop(); await tmux.killServer(); });
    await started;
    const c = await fleet.createCharacter({ islandId: fleet.createIsland({ name: 'feature' }).id, cwd: '/tmp' });
    return { fleet, paths, tmux, c };
  }

  // backgrounded from a shell that exits, so launchd adopts it as it does a robot's nohup server
  const spawnMarked = (id: string, h: string, bin = process.execPath, code = '-e "setInterval(()=>{},1000)"'): number => {
    const out = execFileSync('/bin/sh', ['-c', `"$0" ${code} >/dev/null 2>&1 & echo $!`, bin], { encoding: 'utf8', env: { ...process.env, SVALL_CHAR_ID: id, SVALL_HOME: h } });
    const pid = Number(out.trim());
    cleanup.push(async () => { try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ } });
    return pid;
  };

  it('ends what it started in the background and spares another fleet\'s processes', async () => {
    const { fleet, paths, c } = await boot(() => readProcs(helper));
    const mine = spawnMarked(c.id, paths.home);
    const other = spawnMarked(c.id, '/tmp/svall-other-fleet');
    await waitFor(() => procs().some((r) => r.pid === mine && r.char === c.id) && procs().some((r) => r.pid === other));

    await fleet.closeCharacter(c.id);
    await waitFor(() => !alive(mine));
    expect(alive(other)).toBe(true);
  }, 20_000);

  it('ends a server it left running on a framework Python', async (ctx) => {
    if (!python) return ctx.skip('no framework Python is installed');
    const { fleet, paths, c } = await boot(() => readProcs(helper));
    const server = spawnMarked(c.id, paths.home, python, '-c "import time; time.sleep(600)"');
    await waitFor(() => procs().some((r) => r.pid === server && r.char === c.id));

    await fleet.closeCharacter(c.id);
    await waitFor(() => !alive(server));
  }, 20_000);

  it('never lists svalld or the fleet\'s tmux server among a robot\'s processes', async () => {
    let marks = { char: '', home: '' };
    let tmuxPid = 0;
    const row = (pid: number) => ({ pid, ppid: 1, start: 1, cpuNs: 0, mem: 0, path: '/bin/x', args: 'x', ...marks });
    const { fleet, paths, tmux, c } = await boot(async () => [row(process.pid), row(tmuxPid), row(4242)]);
    marks = { char: c.id, home: paths.home };
    tmuxPid = (await tmux.serverPid())!;
    const victims = await fleet['owned'](c, await fleet['readLive']());
    expect(victims.map((p) => p.pid)).toEqual([4242]);
  });
});
