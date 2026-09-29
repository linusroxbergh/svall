import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/log.js';
import { startDaemon, type Daemon } from '../src/main.js';
import { resolvePaths } from '../src/paths.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome } from './helpers.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../..');
const runIf = hasTmux() ? describe : describe.skip;

runIf('one daemon per home', () => {
  const homes: string[] = [];
  // a start still under way when its test ends is stopped once it lands, before its tmux server is killed
  const starts: Promise<Daemon>[] = [];
  const start = (o: Parameters<typeof startDaemon>[0]): Promise<Daemon> => { const d = startDaemon(o); starts.push(d); return d; };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of starts.splice(0)) await d.then((x) => x.stop(), () => {});
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  function fleetHome(): string {
    const home = makeHome();
    homes.push(home);
    // port 0: a start that got as far as the api must never reach for the real fleet's port
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', port: 0 }));
    return home;
  }

  it('refuses a second daemon before it touches the state, the hooks, tmux.conf or the tmux server', async () => {
    const home = fleetHome();
    const paths = resolvePaths(home);
    const first = await start({ home, port: 0, log: silentLogger });
    try {
      // what a second start would rewrite, or move aside, if it got that far
      fs.writeFileSync(paths.tmuxConf, '# the running one\n');
      fs.writeFileSync(paths.hookScript, '// the running one\n');
      fs.writeFileSync(paths.state, '{not json');
      const running = first.fleet['deps'].tmux;
      const asked: string[][] = [];
      const run = Tmux.prototype.run;
      vi.spyOn(Tmux.prototype, 'run').mockImplementation(function (this: Tmux, ...args: string[]) {
        if (this !== running) asked.push(args);
        return run.apply(this, args);
      });

      await expect(start({ home, port: 0, log: silentLogger })).rejects.toThrow(/svalld is already running for/);
      expect(fs.readFileSync(paths.tmuxConf, 'utf8')).toBe('# the running one\n');
      expect(fs.readFileSync(paths.hookScript, 'utf8')).toBe('// the running one\n');
      expect(fs.readdirSync(home).filter((f) => f.startsWith('state.json.broken-'))).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await first.stop();
    }
    // the lock goes with the daemon that held it
    await (await start({ home, port: 0, log: silentLogger })).stop();
  });

  it('refuses a start while another process holds the lock, and starts once that process is killed', async () => {
    const home = fleetHome();
    // what the daemon opens: O_EXLOCK is 0x20 on macOS, and node names no constant for it
    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(path.join(home, 'daemon.lock'))}, 0x2 | 0x200 | 0x4 | 0x20, 0o600); console.log('held'); setInterval(() => {}, 1000)`]);
    try {
      await new Promise((r) => holder.stdout.once('data', r));
      await expect(start({ home, port: 0, log: silentLogger })).rejects.toThrow(/svalld is already running for/);
      holder.kill('SIGKILL');
      await new Promise((r) => holder.once('exit', r));
      await (await start({ home, port: 0, log: silentLogger })).stop();
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL');
    }
  });

  it('lets go of the lock when a start fails, and a stop run twice lets go once', async () => {
    const home = fleetHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{not json');
    await expect(start({ home, port: 0, log: silentLogger })).rejects.toThrow(/JSON/);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', port: 0 }));
    const daemon = await start({ home, port: 0, log: silentLogger });
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it('starts in a home whose path is as long as its hook socket allows', async () => {
    // a unix socket path holds at most 104 bytes on macOS
    const base = fleetHome();
    const home = path.join(base, 'x'.repeat(104 - base.length - '/'.length - '/hooks.sock'.length));
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', port: 0 }));
    homes.push(home);
    expect(resolvePaths(home).hooksSock).toHaveLength(104);
    await (await start({ home, port: 0, log: silentLogger })).stop();
  });

  it('leaves the running daemon\'s log unrotated when svalld is started again for its home', async () => {
    const home = fleetHome();
    const paths = resolvePaths(home);
    const first = await start({ home, port: 0, log: silentLogger });
    const big = 6 * 1024 * 1024;
    fs.writeFileSync(paths.log, 'x'.repeat(big));
    try {
      const r = await exec(path.join(root, 'node_modules/.bin/tsx'), [path.join(root, 'packages/svalld/src/bin.ts')], { env: { ...process.env, SVALL_HOME: home }, timeout: 30_000 })
        .then(() => 0, (e: { code: number }) => e.code);
      expect(r).toBe(1);
      expect(fs.existsSync(`${paths.log}.1`)).toBe(false);
      expect(fs.readFileSync(paths.log, 'utf8').slice(0, big)).toBe('x'.repeat(big));
      expect(fs.readFileSync(paths.log, 'utf8')).toMatch(/svalld is already running for/);
    } finally {
      await first.stop();
    }
  }, 40_000);
});
