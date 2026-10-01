import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FleetState, emptyState } from '@svall/protocol';
import { resolvePaths } from '../src/paths.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const bin = path.join(root, 'packages/svalld/src/bin.ts');
const runIf = hasTmux() ? describe : describe.skip;

async function runBin(home: string): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await exec(tsx, [bin], { env: { ...process.env, SVALL_HOME: home }, timeout: 30_000 });
    return { code: 0, stderr };
  } catch (e) {
    const err = e as { code: number; stderr: string };
    return { code: err.code, stderr: err.stderr };
  }
}

describe('svalld bin on the other build\'s home', () => {
  afterEach(cleanHomes);

  it('waits rather than exiting for launchd to restart every ten seconds', async () => {
    // the tests run as the release, whose daemon refuses Svall Dev's homes
    const home = path.join(makeHome(), '.svall-dev');
    const log = () => (fs.existsSync(resolvePaths(home).log) ? fs.readFileSync(resolvePaths(home).log, 'utf8') : '');
    const daemon = spawn(tsx, [bin], { env: { ...process.env, SVALL_HOME: home }, stdio: 'ignore' });
    try {
      await waitFor(() => log().includes("svalld waits until that build's setup takes the fleet over"), 30_000);
      expect(log()).toContain('belongs to Svall Dev');
      await new Promise((r) => setTimeout(r, 500));
      expect(daemon.exitCode).toBeNull();
    } finally {
      daemon.kill('SIGTERM');
      if (daemon.exitCode === null) await once(daemon, 'exit');
    }
  }, 40_000);
});

runIf('svalld bin', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('stops the fleet when the app quits, answers, and exits for good', async () => {
    const home = makeHome();
    homes.push(home);
    const p = resolvePaths(home);
    fs.writeFileSync(p.config, JSON.stringify({ shell: '/bin/sh', port: 0 }));
    const daemon = spawn(tsx, [bin], { env: { ...process.env, SVALL_HOME: home }, stdio: 'ignore' });
    try {
      await waitFor(() => fs.existsSync(p.port), 30_000);
      const ws = new WebSocket(`ws://127.0.0.1:${fs.readFileSync(p.port, 'utf8').trim()}`);
      await once(ws, 'open');
      const answer = new Promise((resolve) => ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id === 1) resolve(m); }));
      ws.send(JSON.stringify({ token: fs.readFileSync(p.token, 'utf8').trim() }));
      ws.send(JSON.stringify({ id: 1, method: 'fleet.stop', params: {} }));
      expect(await answer).toEqual({ id: 1, result: {} });
      // exit 0 is the end launchd leaves be, and the app is what starts it again
      const [code] = await once(daemon, 'exit');
      expect(code).toBe(0);
      expect(fs.existsSync(p.port)).toBe(false);
      await expect(new Tmux(p.tmuxSock, p.tmuxConf).run('list-sessions')).rejects.toThrow();
    } finally {
      if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit'); }
    }
  }, 60_000);

  it('exits non-zero and logs why when startup fails', async () => {
    const home = makeHome();
    homes.push(home);
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', host: '127.0.0.1', port }));
    try {
      const r = await runBin(home);
      expect(r.code).toBe(1);
      expect(fs.readFileSync(resolvePaths(home).log, 'utf8')).toMatch(/svalld failed to start: .*EADDRINUSE/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 40_000);

  it('waits on a newer state.json before writing anything, naming the copy to go back to on a terminal, and starts once it changes', async () => {
    const home = makeHome();
    homes.push(home);
    const version = FleetState.shape.version.value;
    const state = path.join(home, 'state.json');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', port: 0 }));
    fs.writeFileSync(state, JSON.stringify({ version: version + 1, islands: {}, characters: {} }));
    for (const at of [100, 200]) fs.writeFileSync(path.join(home, `state.json.v${version}-${at}`), '{}');
    const log = () => (fs.existsSync(resolvePaths(home).log) ? fs.readFileSync(resolvePaths(home).log, 'utf8') : '');
    const why = `move ${path.join(home, `state.json.v${version}-200`)} to ${state}; svalld starts once it is fixed`;
    let out = '';
    const pty = spawn('python3', [path.join(import.meta.dirname, 'fixtures', 'on-pty.py'), tsx, bin], { env: { ...process.env, SVALL_HOME: home } });
    pty.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    try {
      await waitFor(() => out.includes(why), 30_000);
      expect(out).toContain(`state.json is version ${version + 1}`);
      expect(log()).toContain(why);
      for (const written of ['hooks', 'tmux.conf', 'token']) expect(fs.existsSync(path.join(home, written))).toBe(false);
      fs.writeFileSync(state, JSON.stringify(emptyState()));
      await waitFor(() => log().includes('svalld started'), 30_000);
    } finally {
      pty.stdin.write('\x03');
      if (pty.exitCode === null) await once(pty, 'exit');
    }
  }, 70_000);

  it('waits for a config.json that does not parse to be fixed, rather than exiting for launchd to restart', async () => {
    const home = makeHome();
    homes.push(home);
    const config = path.join(home, 'config.json');
    const log = () => (fs.existsSync(resolvePaths(home).log) ? fs.readFileSync(resolvePaths(home).log, 'utf8') : '');
    fs.writeFileSync(config, '{ "shell": "/bin/sh", }');
    const daemon = spawn(tsx, [bin], { env: { ...process.env, SVALL_HOME: home }, stdio: 'ignore' });
    try {
      await waitFor(() => log().includes('svalld starts once it is fixed'), 30_000);
      expect(log()).toMatch(/invalid config .*config\.json: .*JSON/);
      fs.writeFileSync(config, JSON.stringify({ shell: '/bin/sh', port: 0 }));
      await waitFor(() => log().includes('svalld started'), 30_000);
      expect(daemon.exitCode).toBeNull();
      expect(log().match(/invalid config/g)).toHaveLength(1);
    } finally {
      daemon.kill('SIGTERM');
      if (daemon.exitCode === null) await once(daemon, 'exit');
    }
  }, 70_000);
});
