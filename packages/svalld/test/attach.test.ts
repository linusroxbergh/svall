import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { expandHome, resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { TerminalHub, type Viewer } from '../src/terminals.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, ghosttyTermEnv, hasTmux, makeHome, waitFor, waitForPolls } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;
const viewer = (): Viewer => ({ kind: 'app', send() {}, backlog: () => 0 });
const ghostty = ghosttyTermEnv();

describe('expandHome', () => {
  it('expands a leading ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/x')).toBe(`${os.homedir()}/x`);
    expect(expandHome('/tmp/~')).toBe('/tmp/~');
  });
});

describe('tmuxConfText', () => {
  it('lets the attached client size the window and keeps tmux keys out of reach', () => {
    const text = tmuxConfText(Config.parse({}));
    expect(text).toContain('set -g window-size latest');
    expect(text).toContain('set -g prefix None');
    expect(text).toContain('set -g mouse on');
    expect(text).toContain('set -g detach-on-destroy on');
    expect(text).not.toContain('window-size manual');
    expect(text).toContain('set -s extended-keys on');
    expect(text).toContain('set -s extended-keys-format csi-u');
  });
});

runIf('desktop terminal attach', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot(staleSessionMs?: number) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 200, staleSessionMs });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); await fleet.stop(); await tmux.killServer(); });
    await started;
    const hub = new TerminalHub(fleet, tmux, store, silentLogger);
    const c = await fleet.createCharacter({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    return { fleet, tmux, store, hub, c, paths };
  }

  it('creates a session holding only the character window and reports how to attach', async () => {
    const { tmux, hub, c, paths } = await boot();
    const r = await hub.attach(c.id);
    expect(r).toEqual({ socket: paths.tmuxSock, session: `v-${c.id}` });
    const windows = (await tmux.run('list-windows', '-t', `=v-${c.id}`, '-F', '#{window_id}')).trim().split('\n');
    expect(windows).toEqual([c.tmux!.windowId]);
    expect(await tmux.run('show-hooks', '-t', `v-${c.id}`)).toContain(`set-option -t v-${c.id} destroy-unattached on`);
    // attaching again is idempotent
    expect(await hub.attach(c.id)).toEqual(r);
    expect((await tmux.run('list-windows', '-t', `=v-${c.id}`, '-F', '#{window_id}')).trim().split('\n')).toEqual([c.tmux!.windowId]);
  });

  it('attaches the second terminal through a session of its own', async () => {
    const { fleet, tmux, hub, c } = await boot();
    await fleet.openSecond(c.id);
    const main = await hub.attach(c.id);
    const second = await hub.attach(c.id, 2);
    expect(main.session).toBe(`v-${c.id}`);
    expect(second.session).toBe(`v-${c.id}-2`);
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(expect.arrayContaining([`v-${c.id}`, `v-${c.id}-2`]));
  });

  it('leaves the character and its second terminal live when their viewer sessions go', async () => {
    const { fleet, tmux, store, hub, c } = await boot();
    await fleet.openSecond(c.id);
    const main = await hub.attach(c.id);
    const second = await hub.attach(c.id, 2);
    // the poll puts both back, so a drop only shows while it lasts
    const lost = new Set<string>();
    const unsub = store.subscribe(() => {
      const ch = store.state.characters[c.id];
      if (!ch?.tmux) lost.add('main');
      if (!ch?.second) lost.add('second');
    });
    cleanup.push(async () => unsub());
    // what the sweep does, and what destroy-unattached does when a desktop terminal closes
    await tmux.killSession(main.session);
    await tmux.killSession(second.session);
    await waitForPolls(fleet, 3);
    expect([...lost]).toEqual([]);
  });

  it('dies with the character window', async () => {
    const { tmux, hub, c, fleet } = await boot();
    await hub.attach(c.id);
    await fleet.closeCharacter(c.id);
    await waitFor(async () => !(await tmux.hasSession(`v-${c.id}`)));
  });

  it('keeps resizing while the session it made has no client on it', async () => {
    const { tmux, hub, c } = await boot();
    const v = viewer();
    await hub.open(c.id, 90, 25, 2000, v);
    expect((await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, '-v', 'window-size')).trim()).toBe('manual');
    await hub.attach(c.id);
    expect((await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, 'window-size')).trim()).toBe('');
    await hub.resize(c.id, 100, 30, v);
    expect((await tmux.run('display-message', '-p', '-t', c.tmux!.windowId, '#{window_width}')).trim()).toBe('100');
  });

  it('sweeps a session nobody attached to', async () => {
    const { tmux, hub, c } = await boot(300);
    await hub.attach(c.id);
    expect(await tmux.hasSession(`v-${c.id}`)).toBe(true);
    await waitFor(async () => !(await tmux.hasSession(`v-${c.id}`)), 5000);
  });

  it.skipIf(!ghostty)('relays Shift+Enter as CSI u to a pane that asked for modified keys', async () => {
    const { tmux, hub, c, paths } = await boot();
    const log = path.join(paths.home, 'keys.log');
    const fixtures = path.join(import.meta.dirname, 'fixtures');
    await tmux.run('send-keys', '-t', c.tmux!.paneId, `${process.execPath} ${fixtures}/kitty-keys.cjs ${log}`, 'Enter');
    const r = await hub.attach(c.id);
    // a desktop client: tmux attached on a pty, TERM as Ghostty sets it
    const client = spawn('python3', [path.join(fixtures, 'on-pty.py'), tmux.binary, '-S', r.socket, 'attach', '-t', r.session], {
      env: { ...process.env, ...ghostty }, stdio: ['pipe', 'ignore', 'inherit'],
    });
    cleanup.push(async () => { client.kill(); });
    await waitFor(async () => (await tmux.run('list-clients', '-F', '#{client_termname}')).includes('xterm-ghostty'));
    await waitFor(async () => (await tmux.run('display', '-p', '-t', c.tmux!.paneId, '#{pane_current_command}')).trim() === 'node');
    // Ghostty encodes Shift+Enter as CSI 27;2;13~ whatever mode is active
    client.stdin.write('\x1b[27;2;13~');
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('1b5b31333b3275'));
  });

  // codex marks a link with OSC 8 over text it wraps itself, often a label with no url in it; without the
  // marking Ghostty has nothing to open
  it('passes a link a pane marks with OSC 8 on to the desktop terminal', async () => {
    const { tmux, hub, c, paths } = await boot();
    const script = path.join(paths.home, 'link.sh');
    fs.writeFileSync(script, `printf '\\033]8;;https://example.com/pull/157\\007PR 157\\033]8;;\\007\\n'; sleep 30\n`);
    await tmux.run('respawn-pane', '-k', '-t', c.tmux!.paneId, `sh ${script}`);
    const r = await hub.attach(c.id);
    const client = spawn('python3', [path.join(import.meta.dirname, 'fixtures', 'on-pty.py'), tmux.binary, '-S', r.socket, 'attach', '-t', r.session], {
      env: { ...process.env, ...(ghostty ?? { TERM: 'xterm-256color' }) }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    cleanup.push(async () => { client.kill(); });
    let seen = '';
    client.stdout.on('data', (d: Buffer) => { seen += d.toString('latin1'); });
    await waitFor(() => seen.includes('PR 157'));
    expect(seen).toMatch(/\x1b\]8;[^;]*;https:\/\/example\.com\/pull\/157(\x07|\x1b\\)/);
  });

  it('expands ~ in a new character cwd', async () => {
    const { fleet } = await boot();
    const c = await fleet.createCharacter({ islandId: fleet.createIsland({ name: 'y' }).id, cwd: '~' });
    expect(c.cwd).toBe(os.homedir());
  });
});
