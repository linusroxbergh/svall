import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { codexInstalled, codexPaths } from '../src/codex/install.js';
import { silentLogger } from '../src/log.js';
import { readOrCreateToken, startDaemon, type Daemon } from '../src/main.js';
import { resolvePaths } from '../src/paths.js';
import { runtimeVersion } from '../src/setup-plan.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('startDaemon', () => {
  const homes: string[] = [];
  // a start still under way when its test ends is stopped once it lands, before its tmux server is killed
  const starts: Promise<Daemon>[] = [];
  const start = (o: Parameters<typeof startDaemon>[0]): Promise<Daemon> => { const d = startDaemon(o); starts.push(d); return d; };
  afterEach(async () => {
    for (const d of starts.splice(0)) await d.then((x) => x.stop(), () => {});
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('writes the codex hooks when the private fleet starts, and no other fleet does', async () => {
    const codex = codexPaths();
    fs.mkdirSync(codex.dir, { recursive: true });
    const other = makeHome();
    homes.push(other);
    await (await start({ home: other, port: 0, log: silentLogger })).stop();
    expect(fs.existsSync(codex.hooks)).toBe(false);

    const home = path.join(os.homedir(), '.svall');
    fs.mkdirSync(home, { recursive: true });
    homes.push(home);
    await (await start({ home, port: 0, log: silentLogger })).stop();
    const written = JSON.parse(fs.readFileSync(codex.hooks, 'utf8'));
    expect(codexInstalled(written, resolvePaths(home).hookScript)).toBe(true);
    expect(written.hooks.Stop[0].hooks[0].command).toContain(resolvePaths(home).hookScript);
  });

  it('has the fleet on disk by the time its port file goes', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    const d = await start({ home, port: 0, log: silentLogger });
    d.fleet.setDormancy(7);
    let onDisk: number | undefined;
    const rm = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (p === paths.port) onDisk = JSON.parse(fs.readFileSync(paths.state, 'utf8')).dormantAfterHours;
      rm(p, o);
    });
    try { await d.stop(); } finally { spy.mockRestore(); }
    expect(onDisk).toBe(7);
  });

  it('returns from a second stop only once the first has the fleet on disk', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    const d = await start({ home, port: 0, log: silentLogger });
    d.fleet.setDormancy(7);
    const first = d.stop();
    await d.stop();
    expect(JSON.parse(fs.readFileSync(paths.state, 'utf8')).dormantAfterHours).toBe(7);
    expect(fs.existsSync(paths.port)).toBe(false);
    await first;
  });

  it('writes the version it runs as, which a launch refresh compares with the app\'s', async () => {
    const home = makeHome();
    homes.push(home);
    await (await start({ home, port: 0, log: silentLogger })).stop();
    expect(fs.readFileSync(path.join(home, 'version'), 'utf8')).toBe(runtimeVersion());
  });

  it('writes no codex hooks when the private fleet starts with Codex turned off in setup', async () => {
    const codex = codexPaths();
    fs.rmSync(codex.hooks, { force: true });
    fs.mkdirSync(codex.dir, { recursive: true });
    const home = path.join(os.homedir(), '.svall');
    fs.mkdirSync(home, { recursive: true });
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ integrations: ['claude'] }));
    await (await start({ home, port: 0, log: silentLogger })).stop();
    expect(fs.existsSync(codex.hooks)).toBe(false);
  });

  it('gives a fleet with no main agent of its own the private fleet\'s, and keeps one it has', async () => {
    const privateConfig = path.join(os.homedir(), '.svall', 'config.json');
    fs.mkdirSync(path.dirname(privateConfig), { recursive: true });
    const before = fs.existsSync(privateConfig) ? fs.readFileSync(privateConfig, 'utf8') : undefined;
    fs.writeFileSync(privateConfig, JSON.stringify({ mainAgent: 'codex' }));
    try {
      const home = makeHome();
      homes.push(home);
      const d = await start({ home, port: 0, log: silentLogger });
      expect(d.store.state.mainAgent).toBe('codex');
      await d.stop();
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mainAgent: 'claude' }));
      const again = await start({ home, port: 0, log: silentLogger });
      expect(again.store.state.mainAgent).toBe('claude');
      await again.stop();
    } finally {
      if (before === undefined) fs.rmSync(privateConfig); else fs.writeFileSync(privateConfig, before);
    }
  });

  it('survives a daemon restart, then a tmux restart', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const paths = resolvePaths(home);

    fs.mkdirSync(path.dirname(paths.hookScript), { recursive: true });
    fs.writeFileSync(paths.hookScript, '// stale\n');

    const d1 = await start({ home, port: 0, log: silentLogger });
    // a start refreshes the hook scripts, so an install that only pulled still speaks the reply protocol
    expect(fs.readFileSync(paths.hookScript, 'utf8')).toContain('additionalContext');
    expect(fs.readFileSync(paths.port, 'utf8')).toBe(String(d1.port));
    expect(fs.readFileSync(paths.token, 'utf8')).toHaveLength(48);
    expect(fs.existsSync(paths.tmuxConf)).toBe(true);
    // the app attaches with the tmux the daemon runs, not one it finds on its own
    expect(fs.readFileSync(path.join(home, 'tmux-binary'), 'utf8')).toBe(new Tmux(paths.tmuxSock, paths.tmuxConf).binary);
    const island = d1.fleet.createIsland({ name: 'x' });
    const c = await d1.fleet.createCharacter({ islandId: island.id, cwd: '/tmp' });
    await d1.fleet.run(c.id, 'echo persist-me', true);
    await waitFor(async () => (await d1.fleet.readScreen(c.id, 20)).includes('persist-me'));
    await d1.stop();
    expect(fs.existsSync(paths.port)).toBe(false);

    const d2 = await start({ home, port: 0, log: silentLogger });
    expect(d2.token).toBe(d1.token);
    const again = d2.store.state.characters[c.id];
    expect(again.tmux).toEqual(c.tmux);
    expect(await d2.fleet.readScreen(c.id, 20)).toContain('persist-me');
    d2.fleet.onSocketEvent({ hook: { charId: c.id, backend: 'claude', name: 'SessionStart', sessionId: '9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e', transcriptPath: '/nope' } });
    await d2.stop();

    await new Tmux(paths.tmuxSock, paths.tmuxConf).killServer();
    const d3 = await start({ home, port: 0, log: silentLogger });
    const dormant = d3.store.state.characters[c.id];
    expect(dormant.tmux).toBeUndefined();
    expect(dormant.revive).toEqual({ command: 'claude --resume 9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e' });
    d3.store.update((s) => { s.characters[c.id].revive = { command: 'echo back' }; });
    await d3.fleet.reviveCharacter(c.id);
    await waitFor(async () => (await d3.fleet.readScreen(c.id, 20)).includes('back'));
    await d3.stop();
  });

  it('rejects when the port is taken and leaves nothing running', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const paths = resolvePaths(home);
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(start({ home, port, host: '127.0.0.1', log: silentLogger })).rejects.toThrow(/EADDRINUSE/);
      expect(fs.existsSync(paths.hooksSock)).toBe(false);
      expect(fs.existsSync(paths.port)).toBe(false);
      await waitFor(async () => (await new Tmux(paths.tmuxSock, paths.tmuxConf).run('list-clients')).trim() === '');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('keeps the first daemon receiving hooks when a second start is refused', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const paths = resolvePaths(home);
    const first = await start({ home, port: 0, log: silentLogger });
    try {
      await expect(start({ home, port: first.port, host: '127.0.0.1', log: silentLogger })).rejects.toThrow(/already running/);
      expect(fs.existsSync(paths.hooksSock)).toBe(true);
      const c = await first.fleet.createCharacter({ islandId: first.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(paths.hooksSock);
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.end(JSON.stringify({ charId: c.id, backend: 'codex', hook: {
            hook_event_name: 'SessionStart', session_id: '9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e',
          } }) + '\n', resolve);
        });
      });
      await waitFor(() => first.fleet.char(c.id).agent?.kind === 'codex');
    } finally {
      await first.stop();
    }
  });

  // a key learned while the link was up opens nothing once the link has been turned off; the log never names the login
  it('turns the phone key over on a mobile off, shutting out the old key and letting in the one in mobile-key', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', mobile: { logins: ['me@example.com'] } }));
    const paths = resolvePaths(home);
    const logged: string[] = [];
    const d = await start({ home, port: 0, log: { info: (m) => logged.push(m), error: (m) => logged.push(m) } });
    const sockets: WebSocket[] = [];
    const open = (key?: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}/${key ?? ''}`, key ? { headers: { 'Tailscale-User-Login': 'me@example.com' } } : {});
      sockets.push(ws);
      return ws;
    };
    const reply = (ws: WebSocket, id: number) => new Promise<unknown>((resolve, reject) => {
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as { id?: number }; if (m.id === id) resolve(m); });
      ws.once('close', (code) => reject(new Error(`closed ${code}`)));
    });
    try {
      const old = fs.readFileSync(paths.mobileKey, 'utf8').trim();
      expect(await reply(open(old), 0)).toMatchObject({ result: { ok: true } });
      const app = open();
      await new Promise((r) => app.once('open', r));
      const admitted = reply(app, 0);
      app.send(JSON.stringify({ token: d.token }));
      await admitted;
      const answered = reply(app, 1);
      app.send(JSON.stringify({ id: 1, method: 'mobile.set', params: { enabled: false } }));
      await answered;
      const fresh = fs.readFileSync(paths.mobileKey, 'utf8').trim();
      expect(fresh).not.toBe(old);
      const stale = open(old);
      await new Promise((r) => stale.once('open', r));
      const refused = reply(stale, 1);
      stale.send(JSON.stringify({ id: 1, method: 'state.get', params: {} }));
      await expect(refused).rejects.toThrow('closed 4401');
      expect(await reply(open(fresh), 0)).toMatchObject({ result: { ok: true } });
      expect(logged).toContain('api: phone socket');
      expect(logged.join('\n')).not.toContain('me@example.com');
    } finally {
      for (const s of sockets) s.close();
      await d.stop();
    }
  });

  it('keeps every fleet\'s keys and the Claude login out of Files, one made after the start and never set up among them', async () => {
    const home = path.join(os.homedir(), '.svall-files');
    fs.mkdirSync(home, { recursive: true });
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    fs.writeFileSync(path.join(home, '.env'), 'ANTHROPIC_API_KEY=secret');
    const claudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{"secret":1}');
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# me\n');
    const d = await start({ home, port: 0, log: silentLogger });
    const later = path.join(os.homedir(), '.svall-later');
    fs.mkdirSync(later, { recursive: true });
    fs.writeFileSync(path.join(later, 'token'), 'secret');
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
    let next = 1;
    const call = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: { code: string } }>((resolve) => {
      const id = next++;
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as { id?: number }; if (m.id === id) resolve(m as never); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    try {
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ token: d.token }));
      const c = await d.fleet.createCharacter({ islandId: d.fleet.createIsland({ name: 'x' }).id, cwd: os.homedir() });
      for (const p of ['.svall-files/token', '.svall-files/mobile-key', '.svall-files/vapid.json', '.svall-files/.env', '.svall-later/token']) {
        expect(await call('fs.read', { id: c.id, path: p })).toMatchObject({ error: { code: 'invalid' } });
      }
      expect(await call('fs.read', { id: c.id, path: '.svall-files/config.json' })).toMatchObject({ result: { text: expect.any(String) } });
      expect(await call('fs.read', { id: `r:${claudeDir}`, path: '.credentials.json' })).toMatchObject({ error: { code: 'invalid' } });
      expect(await call('fs.read', { id: `r:${claudeDir}`, path: 'CLAUDE.md' })).toMatchObject({ result: { text: '# me\n' } });
    } finally {
      ws.close();
      await d.stop();
    }
  });

  it('refuses to start with an install hint when tmux is not on PATH', async () => {
    const home = makeHome();
    const saved = process.env.PATH;
    process.env.PATH = home;
    try {
      await expect(start({ home, port: 0, log: silentLogger })).rejects.toThrow(/tmux not found.*brew install tmux/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('readOrCreateToken', () => {
  afterEach(cleanHomes);

  it('regenerates an empty or whitespace-only token file', () => {
    const file = path.join(makeHome(), 'token');
    fs.writeFileSync(file, '');
    const t = readOrCreateToken(file);
    expect(t).toHaveLength(48);
    expect(fs.readFileSync(file, 'utf8')).toBe(t);
    fs.writeFileSync(file, ' \n');
    expect(readOrCreateToken(file)).not.toBe(t);
    expect(readOrCreateToken(file)).toHaveLength(48);
  });
});
