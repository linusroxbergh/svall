import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/config.js';
import { tmuxConfText, tmuxTooOld } from '../src/tmux/conf.js';
import { ControlClient } from '../src/tmux/control.js';
import { SESSION, Tmux, rawPasteArgs, resolveTmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

describe('tmuxConfText', () => {
  it('sets a default shell only when configured', () => {
    expect(tmuxConfText(Config.parse({}))).not.toMatch(/default-shell/);
    expect(tmuxConfText(Config.parse({ shell: '/bin/sh' }))).toMatch(/set -g default-shell "\/bin\/sh"/);
    expect(tmuxConfText(Config.parse({}))).toMatch(/exit-empty off/);
  });

  // a copy sent on to the terminal as OSC 52 as well would ask again under Ghostty's clipboard-write = ask
  it('leaves the copy to pbcopy alone', () => {
    expect(tmuxConfText(Config.parse({}))).toMatch(/^set -s set-clipboard off$/m);
  });
});

describe('tmuxTooOld', () => {
  it('flags a tmux before 3.5 and lets newer or unparseable versions through', () => {
    expect(tmuxTooOld('tmux 3.4')).toBe(true);
    expect(tmuxTooOld('tmux 2.9a')).toBe(true);
    expect(tmuxTooOld('tmux 3.5')).toBe(false);
    expect(tmuxTooOld('tmux 3.5a')).toBe(false);
    expect(tmuxTooOld('tmux next-3.6')).toBe(false);
    expect(tmuxTooOld('tmux 4.0')).toBe(false);
    expect(tmuxTooOld('tmux master')).toBe(false);
  });
});

describe('rawPasteArgs', () => {
  it('turns off the paste sanitizing only on a tmux that has the flag for it', () => {
    expect(rawPasteArgs('paste-buffer (pasteb) [-dprS] [-s separator] [-b buffer-name] [-t target-pane]')).toEqual(['-S']);
    expect(rawPasteArgs('paste-buffer (pasteb) [-dpr] [-s separator] [-b buffer-name] [-t target-pane]')).toEqual([]);
  });
});

runIf('Tmux', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  let lastHome = '';

  async function boot(): Promise<Tmux> {
    const home = makeHome();
    lastHome = home;
    fs.writeFileSync(`${home}/tmux.conf`, tmuxConfText(Config.parse({ shell: '/bin/sh' })));
    const t = new Tmux(`${home}/tmux.sock`, `${home}/tmux.conf`);
    const ready = t.ensureServer();
    cleanup.push(async () => { await ready.catch(() => {}); await t.killServer(); });
    await ready;
    return t;
  }

  it('creates windows named by id, lists them without _keep, and round-trips input', async () => {
    const t = await boot();
    const w = await t.newWindow('c_abc', '/tmp', { SVALL_CHAR_ID: 'c_abc' });
    expect(w.windowId).toMatch(/^@\d+$/);
    expect(w.paneId).toMatch(/^%\d+$/);
    const list = await t.listWindows();
    expect(list.map((x) => x.name)).toEqual(['c_abc']);
    await t.sendLine(w.paneId, 'echo $SVALL_CHAR_ID-ok', true);
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString().includes('c_abc-ok'));
    await t.sendBytes(w.paneId, Buffer.from('echo å\n'));
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString('utf8').split('\n').some((l) => l.trim() === 'å'));
    await t.resize(w.windowId, 100, 30);
    await t.renameWindow(w.windowId, 'c_xyz');
    expect((await t.listWindows())[0].name).toBe('c_xyz');
    await t.killWindow(w.windowId);
    expect(await t.listWindows()).toEqual([]);
  });

  // a pane running a recorder that asks for modified keys, as Claude Code does, and logs every byte it gets as hex
  async function recorder(t: Tmux) {
    const w = await t.newWindow('c_keys', '/tmp', {});
    const log = path.join(lastHome, 'keys.log');
    await t.run('send-keys', '-t', w.paneId, `${process.execPath} ${path.join(import.meta.dirname, 'fixtures')}/kitty-keys.cjs ${log}`, 'Enter');
    // it asks only once its terminal is raw, where Ctrl-C is a byte and not a signal
    await waitFor(async () => (await t.run('display', '-p', '-t', w.paneId, '#{pane_key_mode}')).trim() !== 'VT10x');
    const recorded = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').replaceAll('\n', '') : '');
    return { paneId: w.paneId, recorded };
  }

  it('types text of any length, and text tmux would read as its own syntax, as it was written', async () => {
    const t = await boot();
    const { paneId, recorded } = await recorder(t);
    // tmux refuses a command over about 1000 arguments or 16 KB, and reads an argument ending in ; as a separator
    await t.sendBytes(paneId, Buffer.from('b'.repeat(2000)));
    await t.sendLine(paneId, 'a'.repeat(17000), true);
    await t.sendLine(paneId, 'one;', true);
    const sent = Buffer.from(`${'b'.repeat(2000)}${'a'.repeat(17000)}\rone;\r`).toString('hex');
    await waitFor(() => recorded().length >= sent.length).catch(() => {});
    expect(recorded()).toBe(sent);
    // nothing is left in tmux's buffers, not even by a paste into a pane that is gone
    await expect(t.sendBytes('%999', Buffer.from('x'))).rejects.toThrow(/can't find pane/);
    expect(await t.run('list-buffers')).toBe('');
    // nor does a tmux that gives up before reading the text take the daemon down
    await t.killServer();
    await expect(t.sendBytes(paneId, Buffer.alloc(1_000_000, 'a'))).rejects.toThrow();
  });

  it('hands a pane every byte it is sent, control bytes included', async () => {
    const t = await boot();
    const { paneId, recorded } = await recorder(t);
    for (const s of ['\x1b', '\x1b[A', '\x03', '\x7f']) await t.sendBytes(paneId, Buffer.from(s));
    await waitFor(() => recorded().length >= 12, 2000).catch(() => {});
    expect(recorded()).toBe('1b1b5b41037f');
  });

  it('asks tmux again how to paste raw when the first ask fails', async () => {
    const t = await boot();
    const { paneId, recorded } = await recorder(t);
    vi.spyOn(t, 'run').mockRejectedValueOnce(new Error('spawn EAGAIN'));
    // without knowing, a paste fails rather than typing ESC as ^[
    await expect(t.sendBytes(paneId, Buffer.from('\x1b'))).rejects.toThrow(/EAGAIN/);
    await t.sendBytes(paneId, Buffer.from('\x03'));
    await waitFor(() => recorded().length >= 2, 2000).catch(() => {});
    expect(recorded()).toBe('03');
  });

  it('submits a line to a pane scrolled back into copy mode', async () => {
    const t = await boot();
    const { paneId, recorded } = await recorder(t);
    await t.run('copy-mode', '-t', paneId);
    await t.sendLine(paneId, 'hi', true);
    await waitFor(() => recorded().length >= 6, 2000).catch(() => {});
    expect(recorded()).toBe('68690d');
  });

  it('opens a window in a directory whose name tmux would read as a format or a separator', async () => {
    const t = await boot();
    const pathOf = async (paneId: string) => (await t.run('display', '-p', '-t', paneId, '#{pane_current_path}')).trim();
    for (const [i, name] of ['issue ##4', 'a#{x}b', 'dir;'].entries()) {
      const dir = path.join(fs.realpathSync(lastHome), name);
      fs.mkdirSync(dir);
      const w = await t.newWindow(`c_dir${i}`, dir, {});
      await waitFor(async () => (await pathOf(w.paneId)) === dir, 2000).catch(() => {});
      expect(await pathOf(w.paneId)).toBe(dir);
    }
  });

  it('pipes copied text to the system clipboard', async () => {
    const t = await boot();
    expect((await t.run('show-options', '-gv', 'copy-command')).trim()).toBe('pbcopy');
  });

  it('reports one row per window when a window is split', async () => {
    const t = await boot();
    const w = await t.newWindow('c_split', '/tmp', {});
    await t.run('split-window', '-t', w.paneId, '-d');
    const list = await t.listWindows();
    expect(list.map((x) => x.name)).toEqual(['c_split']);
    expect(list[0].paneId).toBe(w.paneId);
  });

  it('ensureServer is idempotent', async () => {
    const t = await boot();
    await t.ensureServer();
    expect(await t.listWindows()).toEqual([]);
  });

  it('attaches a viewer session in one tmux call, holding only its window, as often as asked', async () => {
    const t = await boot();
    const main = await t.newWindow('c_view', '/tmp', {});
    const second = await t.newWindow('c_view2', '/tmp', {});
    const windows = async (s: string) => (await t.run('list-windows', '-t', `=${s}`, '-F', '#{window_id}')).trim().split('\n');
    await t.resize(main.windowId, 100, 30);
    // a session whose name starts with another's is not taken for it
    await t.attachSession('v-c_view-2', second.windowId);
    const run = vi.spyOn(t, 'run');
    await t.attachSession('v-c_view', main.windowId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await windows('v-c_view')).toEqual([main.windowId]);
    expect(await windows('v-c_view-2')).toEqual([second.windowId]);
    // with no client on it the session stays; attaching one sets destroy-unattached
    expect(await t.run('show-hooks', '-t', 'v-c_view')).toContain('set-option -t v-c_view destroy-unattached on');
    expect((await t.run('show-options', '-t', 'v-c_view', 'destroy-unattached')).trim()).toBe('');
    expect((await t.run('show-options', '-w', '-t', main.windowId, 'window-size')).trim()).toBe('');
    await t.attachSession('v-c_view', main.windowId);
    expect(await windows('v-c_view')).toEqual([main.windowId]);
    await expect(t.attachSession('v-c_gone', '@999')).rejects.toThrow(/can't find window/);
  });

  // stand-ins ignore SIGHUP until their pty is gone, then start the real command on it, as a child that lost the race would
  it('leaves no keeper or viewer placeholder running once its pty is gone, even one that never got SIGHUP', async () => {
    const home = makeHome();
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const held = (real: string) => `#!/bin/sh\ntrap '' HUP\ntouch ${bin}/$$\nfor i in $(/usr/bin/seq 400); do [ -e ${bin}/go ] && exec ${real} "$@"; /bin/sleep 0.05; done\n`;
    for (const cmd of ['cat', 'sleep', 'zsh']) fs.writeFileSync(path.join(bin, cmd), held(`/bin/${cmd}`), { mode: 0o755 });
    // tmux looks a command up on the PATH of the client that asks for it
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    fs.writeFileSync(`${home}/tmux.conf`, tmuxConfText(Config.parse({ shell: path.join(bin, 'zsh') })));
    const t = new Tmux(`${home}/tmux.sock`, `${home}/tmux.conf`);
    cleanup.push(() => t.killServer());
    await t.ensureServer();
    // a link that fails leaves the placeholder's session up
    await expect(t.attachSession('v-c_held', '@999')).rejects.toThrow(/can't find window/);
    const pids = (await t.run('list-panes', '-a', '-F', '#{pane_pid}')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    await waitFor(() => pids.every((p) => fs.existsSync(path.join(bin, String(p)))));
    await t.killServer();
    fs.writeFileSync(path.join(bin, 'go'), '');
    const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const ended = await waitFor(() => !pids.some(alive), 2000).then(() => true, () => false);
    for (const p of pids.filter(alive)) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
    expect(ended).toBe(true);
  });

  it('control client streams output for panes turned on and stays quiet for panes turned off', async () => {
    const t = await boot();
    const w = await t.newWindow('c_one', '/tmp', {});
    const c = t.connect();
    const got: string[] = [];
    c.on('output', (paneId, data) => { if (paneId === w.paneId) got.push(data.toString()); });
    await c.start();
    c.send(`refresh-client -A '${w.paneId}:off'`);
    await t.sendLine(w.paneId, 'echo quiet', true);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.join('')).not.toMatch(/quiet/);
    c.send(`refresh-client -A '${w.paneId}:on'`);
    await t.sendLine(w.paneId, 'echo loud', true);
    await waitFor(() => got.join('').includes('loud'));
    const closed: string[] = [];
    c.on('window-close', (id) => closed.push(id));
    await t.killWindow(w.windowId);
    await waitFor(() => closed.includes(w.windowId));
    c.stop();
  });

  it('emits exit once when the server dies under an attached client', async () => {
    const t = await boot();
    const c = t.connect();
    const reasons: string[] = [];
    c.on('exit', (r) => reasons.push(r));
    await c.start();
    await t.killServer();
    await waitFor(() => reasons.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(reasons).toHaveLength(1);
    c.stop();
  });

  it('start rejects when the client does not become ready in time', async () => {
    await boot();
    const c = new ControlClient({
      binary: resolveTmux(),
      socket: `${lastHome}/tmux.sock`,
      conf: `${lastHome}/tmux.conf`,
      session: SESSION,
      readyTimeoutMs: 1,
    });
    await expect(c.start()).rejects.toThrow(/did not become ready within/);
  });
});

runIf('ControlClient', () => {
  afterEach(cleanHomes);
  it('reports tmux stderr when the connection fails', async () => {
    const home = makeHome();
    fs.writeFileSync(`${home}/tmux.conf`, tmuxConfText(Config.parse({})));
    fs.writeFileSync(`${home}/not-a-socket`, 'x');
    const c = new ControlClient({ binary: resolveTmux(), socket: `${home}/not-a-socket`, conf: `${home}/tmux.conf`, session: SESSION, readyTimeoutMs: 3000 });
    await expect(c.start()).rejects.toThrow(/error connecting to/i);
  });

  it('rejects instead of throwing when the tmux binary cannot be spawned', async () => {
    const home = makeHome();
    const c = new ControlClient({ binary: `${home}/no-tmux`, socket: `${home}/tmux.sock`, conf: `${home}/tmux.conf`, session: SESSION, readyTimeoutMs: 3000 });
    await expect(c.start()).rejects.toThrow(/ENOENT/);
  });
});
