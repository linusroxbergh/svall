import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/config.js';
import { tmuxConfText, tmuxTooOld } from '../src/tmux/conf.js';
import { ControlClient } from '../src/tmux/control.js';
import { unescapeOutput } from '../src/tmux/parse.js';
import { SESSION, Tmux, isShellCommand, parseViewerScreen, rawPasteArgs, resolveTmux } from '../src/tmux/tmux.js';
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
    expect(tmuxConfText(Config.parse({}), { platform: 'darwin' })).toMatch(/^set -s set-clipboard off$/m);
  });

  it('copies through pbcopy on macOS and through the attached terminal on Linux, and differs in nothing else', () => {
    const mac = tmuxConfText(Config.parse({}), { platform: 'darwin' }).split('\n');
    const linux = tmuxConfText(Config.parse({}), { platform: 'linux' }).split('\n');
    expect(mac.filter((l) => !linux.includes(l))).toEqual(['set -g copy-command "pbcopy"', 'set -s set-clipboard off']);
    expect(linux.filter((l) => !mac.includes(l))).toEqual(['set -s set-clipboard on', 'set -s get-clipboard off']);
  });

  it('drops get-clipboard on a tmux before 3.7, which fails source-file on it', () => {
    const current = tmuxConfText(Config.parse({}), { platform: 'linux', tmuxVersion: 'tmux 3.7c' }).split('\n');
    const old = tmuxConfText(Config.parse({}), { platform: 'linux', tmuxVersion: 'tmux 3.6a' }).split('\n');
    expect(current.filter((l) => !old.includes(l))).toEqual(['set -s get-clipboard off']);
    expect(old.filter((l) => !current.includes(l))).toEqual([]);
  });

  it('drops the option a tmux before 3.5 fails source-file on, and nothing else', () => {
    const current = tmuxConfText(Config.parse({}), { platform: 'linux', tmuxVersion: 'tmux 3.5a' }).split('\n');
    const old = tmuxConfText(Config.parse({}), { platform: 'linux', tmuxVersion: 'tmux 3.4' }).split('\n');
    expect(current.filter((l) => !old.includes(l))).toEqual(['set -s extended-keys-format csi-u']);
    expect(old.filter((l) => !current.includes(l))).toEqual([]);
    expect(old).toContain('set -s extended-keys on');
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

describe('isShellCommand', () => {
  it('knows the common shells and the one config.json names', () => {
    expect(isShellCommand('-zsh')).toBe(true);
    expect(isShellCommand('nu')).toBe(false);
    expect(isShellCommand('nu', '/opt/homebrew/bin/nu')).toBe(true);
    expect(isShellCommand('claude', '/opt/homebrew/bin/nu')).toBe(false);
  });
});

describe('ControlClient replies', () => {
  it('takes a %pause or %continue written inside the reply to a line it sent quietly as the notification it is, as tmux 3.7c writes them', () => {
    const c = new ControlClient({ binary: 'tmux', socket: '/nonexistent.sock', conf: '/dev/null', session: SESSION });
    const seen: string[] = [];
    c.on('pause', (id) => seen.push(`pause ${id}`));
    c.on('continue', (id) => seen.push(`continue ${id}`));
    c['ready'] = true;
    c.send("refresh-client -A '%3:pause'");
    c.send("refresh-client -A '%3:continue'");
    c['onData']('%begin 1 2 1\n%pause %3\n%end 1 2 1\n%begin 1 3 1\n%continue %3\n%end 1 3 1\n');
    expect(seen).toEqual(['pause %3', 'continue %3']);
  });
});

describe('hasWindow', () => {
  it('passes on a tmux that timed out rather than call the window gone', async () => {
    const tmux = new Tmux('/nonexistent.sock', '/dev/null');
    vi.spyOn(tmux, 'run').mockRejectedValue(Object.assign(new Error('timed out'), { killed: true }));
    await expect(tmux.hasWindow('@1')).rejects.toThrow('timed out');
    vi.spyOn(tmux, 'run').mockRejectedValue(new Error("can't find window: @1"));
    expect(await tmux.hasWindow('@1')).toBe(false);
  });
});

describe('parseViewerScreen', () => {
  it('passes the normal screen through with its history, as rows a terminal can print, and the cursor where it is', () => {
    expect(parseViewerScreen('0 1 2 4 1 1 0 0 0 0 0 0\nold\none\ntwo\n', 100).toString()).toBe('old\r\none\r\ntwo\x1b[2;5H');
  });

  it('puts the history and the saved screen under an alternate screen, then the cursor, mouse modes and hidden cursor', () => {
    // asked for one line of four, two rows high, with a saved screen of two rows whose cursor sat on its second
    const out = parseViewerScreen('1 4 2 4 1 0 3 1 0 0 1 1\nh4\nALT1\nALT2\nprompt$\nls\n', 1).toString();
    expect(out).toBe('h4\r\nprompt$\r\nls\x1b[2;4H\x1b[?1049h\x1b[HALT1\r\nALT2\x1b[2;5H\x1b[?1003h\x1b[?1006h\x1b[?25l');
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
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const f of cleanup.splice(0)) await f();
    cleanHomes();
    for (const k of ['SVALL_RELEASE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete process.env[k];
  });

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

  it('keeps the release the daemon runs from out of every pane', async () => {
    // the svalld shim exports it; a checkout's `pnpm svall` in a pane would take itself for that release
    process.env.SVALL_RELEASE_ROOT = '/home/linus/.local/share/svall/releases/1.2.3';
    const t = await boot();
    await expect(t.run('show-environment', '-g', 'SVALL_RELEASE_ROOT')).rejects.toThrow(/unknown variable/);
    expect(await t.run('show-environment', '-g', 'HOME')).toContain('HOME=');
  });
  it('creates windows named by id, lists them without _keep, and round-trips input', async () => {
    const t = await boot();
    const w = await t.newWindow('c_abc', '/tmp', { SVALL_ROBOT_ID: 'c_abc' });
    expect(w.windowId).toMatch(/^@\d+$/);
    expect(w.paneId).toMatch(/^%\d+$/);
    const list = await t.listWindows();
    expect(list.map((x) => x.name)).toEqual(['c_abc']);
    await t.sendLine(w.paneId, 'echo $SVALL_ROBOT_ID-ok', true);
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString().includes('c_abc-ok'));
    await t.sendBytes(w.paneId, Buffer.from('echo å\n'));
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString('utf8').split('\n').some((l) => l.trim() === 'å'));
    await t.resize(w.windowId, 100, 30);
    await t.renameWindow(w.windowId, 'c_xyz');
    expect((await t.listWindows())[0].name).toBe('c_xyz');
    await t.killWindow(w.windowId);
    expect(await t.listWindows()).toEqual([]);
  });

  it('hands a window its secrets on stdin, never as an argument, and keeps none in the session for the next', async () => {
    const t = await boot();
    const call = vi.spyOn(t as unknown as { call: (args: string[]) => Promise<string> }, 'call');
    const secret = `sk-'it's' $HOME #{pane_id} ~; "q" back\\slash`;
    const w = await t.newWindow('c_secret', '/tmp', { SVALL_ROBOT_ID: 'c_secret' }, { SVALL_T_KEY: secret });
    await expect(t.run('show-environment', '-t', 'fleet', 'SVALL_T_KEY')).rejects.toThrow(/unknown variable/);
    await t.sendLine(w.paneId, 'echo "[$SVALL_T_KEY|$SVALL_ROBOT_ID]"', true);
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString().includes(`[${secret}|c_secret]`));
    const w2 = await t.newWindow('c_secret2', '/tmp', {});
    await t.sendLine(w2.paneId, 'echo "[${SVALL_T_KEY-unset}]"', true);
    await waitFor(async () => (await t.capture(w2.paneId, 50)).toString().includes('[unset]'));
    expect(call.mock.calls.flatMap(([args]) => args).join(' ')).not.toContain('sk-');
  });

  // a pane running a recorder that asks for modified keys, as Claude Code does, and logs every byte it gets as hex
  async function recorder(t: Tmux, mode = '') {
    const w = await t.newWindow('c_keys', '/tmp', {});
    const log = path.join(lastHome, 'keys.log');
    await t.run('send-keys', '-t', w.paneId, `${process.execPath} ${path.join(import.meta.dirname, 'fixtures')}/kitty-keys.cjs ${log} ${mode}`, 'Enter');
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

  it('hands a viewer both screens of an app on the alternate screen, with its mouse modes and cursor', async () => {
    const t = await boot();
    const w = await t.newWindow('c_alt', '/tmp', {});
    await t.sendLine(w.paneId, "seq 1 200 && printf '\\033[?1049h\\033[?1002h\\033[?1006h\\033[?25l\\033[HALT' && sleep 30", true);
    await waitFor(async () => (await t.run('display', '-p', '-t', w.paneId, '#{alternate_on}')).trim() === '1');
    const [normal, alt] = (await t.viewerScreen(w.paneId, 100)).toString().split('\x1b[?1049h\x1b[H');
    // 1–161 scrolled into history before the app started, and 162–200 were on the screen tmux saved
    expect(normal).toContain('150');
    expect(normal).toContain('200');
    expect(alt).not.toContain('150');
    expect(alt.startsWith('ALT')).toBe(true);
    expect(alt.endsWith('\x1b[1;4H\x1b[?1002h\x1b[?1006h\x1b[?25l')).toBe(true);
    expect(alt.match(/\r\n/g)).toHaveLength(Number((await t.run('display', '-p', '-t', w.paneId, '#{pane_height}')).trim()) - 1);
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

  it('pastes a line as one bracketed paste to an app that asks for it, its Enter and other bytes outside', async () => {
    const t = await boot();
    const { paneId, recorded } = await recorder(t, 'paste');
    await t.sendLine(paneId, 'a\nb', true);
    await t.sendBytes(paneId, Buffer.from('\x1b'));
    const sent = Buffer.from('\x1b[200~a\nb\x1b[201~\r\x1b').toString('hex');
    await waitFor(() => recorded().length >= sent.length, 2000).catch(() => {});
    expect(recorded()).toBe(sent);
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

  // the Mac's terminal reaches a robot on a Linux machine over ssh, where no pbcopy reaches the Mac's clipboard
  it('hands a copy on Linux, made by tmux or by the app in the pane, to the terminal attached as OSC 52', async () => {
    const home = makeHome();
    fs.writeFileSync(`${home}/tmux.conf`, tmuxConfText(Config.parse({ shell: '/bin/sh' }), { platform: 'linux' }));
    const t = new Tmux(`${home}/tmux.sock`, `${home}/tmux.conf`);
    // the terminal: another tmux, which keeps each OSC 52 it is sent as a buffer
    const term = new Tmux(`${home}/term.sock`, '/dev/null');
    cleanup.push(async () => { await Promise.all([t.killServer(), term.killServer()]); });
    await t.ensureServer();
    await term.ensureServer();
    await term.run('set', '-s', 'set-clipboard', 'on');
    const w = await t.newWindow('c_copy', '/tmp', {});
    await t.attachSession('v-c_copy', w.windowId);
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    await term.run('new-window', '-d', `env TERM=xterm-256color ${q(t.binary)} -S ${q(`${home}/tmux.sock`)} attach -t '=v-c_copy'`);
    await waitFor(async () => (await t.run('list-clients', '-t', '=v-c_copy')) !== '');
    const copied = async () => (await term.run('show-buffer').catch(() => '')).trim();

    await t.sendLine(w.paneId, "printf '\\033]52;c;YnktYXBw\\a'", true);
    await waitFor(async () => (await copied()) === 'by-app');

    await t.sendLine(w.paneId, 'echo by-tmux', true);
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString().split('\n').some((l) => l.trim() === 'by-tmux'));
    for (const step of [['copy-mode'], ['send-keys', '-X', 'cursor-up'], ['send-keys', '-X', 'select-line'], ['send-keys', '-X', 'copy-pipe-and-cancel']]) {
      await t.run(step[0], '-t', w.paneId, ...step.slice(1));
    }
    await waitFor(async () => (await copied()) === 'by-tmux');

    // and a program that reaches only its terminal, in a container or past another ssh, reads no copy back
    const reply = path.join(home, 'reply');
    fs.writeFileSync(path.join(home, 'query.cjs'), `process.stdin.setRawMode(true);
let got = '';
process.stdin.on('data', (d) => { got += d; });
process.stdout.write('\\x1b]52;c;?\\x07');
setTimeout(() => { const fs = require('fs'); fs.writeFileSync(${JSON.stringify(reply + '.part')}, got); fs.renameSync(${JSON.stringify(reply + '.part')}, ${JSON.stringify(reply)}); process.exit(0); }, 1000);
`);
    await t.sendLine(w.paneId, `${q(process.execPath)} ${q(path.join(home, 'query.cjs'))}`, true);
    await waitFor(() => fs.existsSync(reply));
    expect(fs.readFileSync(reply, 'utf8')).toBe('');
  });

  // a server an earlier release started runs that release's tmux; Linux names a process's binary under /proc
  async function fakeProc(t: Tmux, exe: string): Promise<string> {
    const proc = makeHome();
    const pid = (await t.run('display', '-p', '#{pid}')).trim();
    fs.mkdirSync(path.join(proc, pid));
    fs.symlinkSync(exe, path.join(proc, pid, 'exe'));
    return proc;
  }
  const old = '/home/ada/.local/share/svall/releases/1.0.0/bin/tmux';

  it("ends a server running another tmux than the daemon's own when no robot runs in it, and names one it keeps", async () => {
    const t = await boot();
    const own = fs.realpathSync(t.binary);
    expect(await t.startOverStale(own, await fakeProc(t, own))).toBeUndefined();
    const w = await t.newWindow('c_kept', '/tmp', {});
    // the daemon's own tmux replaced in place, as by an apt upgrade, leaves the server on the file it started from
    expect(await t.startOverStale(own, await fakeProc(t, `${own} (deleted)`))).toEqual({ running: own, kept: 'robots' });
    const proc = await fakeProc(t, old);
    expect(await t.startOverStale(own, proc)).toEqual({ running: old, kept: 'robots' });
    await t.killWindow(w.windowId);
    expect(await t.startOverStale(own, proc)).toEqual({ running: old });
    await expect(t.run('has-session')).rejects.toThrow();
  });

  // kill-server answers before the server exits
  function lateKill(t: Tmux, then: () => void): void {
    const run = (...args: string[]) => Tmux.prototype.run.apply(t, args);
    vi.spyOn(t, 'run').mockImplementation(async (...args) => {
      if (args[0] !== 'kill-server') return run(...args);
      then();
      return '';
    });
  }

  it('ends a stale server once its process is gone, and kills one that does not end unless its pid runs another binary', async () => {
    const t = await boot();
    const own = fs.realpathSync(t.binary);
    const proc = await fakeProc(t, old);
    const pid = Number((await t.run('display', '-p', '#{pid}')).trim());
    const exe = path.join(proc, String(pid), 'exe');
    const kill = vi.spyOn(process, 'kill');
    // the pid went to another program
    lateKill(t, () => { fs.rmSync(exe); fs.symlinkSync('/usr/bin/vi', exe); });
    expect(await t.startOverStale(own, proc, 300)).toEqual({ running: old });
    expect(await t.run('has-session', '-t', '=fleet')).toBe('');
    fs.rmSync(exe);
    fs.symlinkSync(old, exe);
    lateKill(t, () => {});
    expect(await t.startOverStale(own, proc, 300)).toEqual({ running: old });
    expect(kill).toHaveBeenCalledWith(pid, 'SIGKILL');
    await waitFor(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });

    const u = await boot();
    const late = Number((await u.run('display', '-p', '#{pid}')).trim());
    lateKill(u, () => { setTimeout(() => { Tmux.prototype.run.call(u, 'kill-server').catch(() => {}); }, 300); });
    kill.mockClear();
    expect(await u.startOverStale(own, await fakeProc(u, old))).toEqual({ running: old });
    expect(() => process.kill(late, 0)).toThrow();
    expect(kill).not.toHaveBeenCalledWith(late, 'SIGKILL');
  });

  it('keeps a stale server that does not list its windows, and lists them on a tmux older than list-windows -f', async () => {
    const t = await boot();
    const proc = await fakeProc(t, old);
    const run = t.run.bind(t);
    vi.spyOn(t, 'run').mockImplementation(async (...args) => (args[0] === 'list-windows' ? Promise.reject(new Error('timed out')) : run(...args)));
    expect(await t.startOverStale(fs.realpathSync(t.binary), proc)).toEqual({ running: old, kept: 'unlisted' });
    // as tmux 3.0a answers
    vi.spyOn(t, 'run').mockImplementation(async (...args) => (args[0] === 'list-windows' && args.includes('-f') ? Promise.reject(new Error('usage: list-windows [-a] [-F format] [-t target-session]')) : run(...args)));
    expect(await t.startOverStale(fs.realpathSync(t.binary), proc)).toEqual({ running: old });
  });

  it('keeps a stale server while a viewer holds a robot, its fleet session gone, across starts, and compares an own tmux gone from disk as named', async () => {
    const t = await boot();
    const proc = await fakeProc(t, old);
    const w = await t.newWindow('c_viewed', '/tmp', {});
    await t.attachSession('v-c_viewed', w.windowId);
    await t.run('kill-session', '-t', '=fleet');
    const own = '/home/ada/.local/share/svall/releases/2.0.0/bin/tmux';
    expect(await t.startOverStale(own, proc)).toEqual({ running: old, kept: 'robots' });
    await t.ensureServer();
    expect(await t.startOverStale(own, proc)).toEqual({ running: old, kept: 'robots' });
    expect(await t.run('has-session', '-t', '=v-c_viewed')).toBe('');
  });

  it('asks tmux nothing where there is no /proc', async () => {
    const t = await boot();
    const run = vi.spyOn(t, 'run');
    expect(await t.startOverStale(fs.realpathSync(t.binary), path.join(makeHome(), 'proc'))).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('reports one row per window when a window is split', async () => {
    const t = await boot();
    const w = await t.newWindow('c_split', '/tmp', {});
    await t.run('split-window', '-t', w.paneId, '-d');
    const list = await t.listWindows();
    expect(list.map((x) => x.name)).toEqual(['c_split']);
    expect(list[0].paneId).toBe(w.paneId);
  });

  it('opens windows with the agent homes of the daemon that ensured the server, not of the one that started it', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/old/claude';
    process.env.CODEX_HOME = '/old/codex';
    const first = await boot();
    // the unit restarted with new agent homes while the server lived on
    process.env.CLAUDE_CONFIG_DIR = '/new/claude';
    delete process.env.CODEX_HOME;
    const t = new Tmux(first.socket, `${lastHome}/tmux.conf`);
    await t.ensureServer();
    const w = await t.newWindow('c_homes', '/tmp', {});
    await t.sendLine(w.paneId, 'echo "[$CLAUDE_CONFIG_DIR|${CODEX_HOME-unset}]"', true);
    await waitFor(async () => (await t.capture(w.paneId, 50)).toString().includes('[/new/claude|unset]'));
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
    c.on('output', (paneId, escaped) => { if (paneId === w.paneId) got.push(unescapeOutput(escaped).toString()); });
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

  it('answers listings, screens and captures on the control client as a client of their own would, pane text that reads as a guard included', async () => {
    const t = await boot();
    const spawned = new Tmux(t.socket, `${lastHome}/tmux.conf`, t.binary);
    const text = `${lastHome}/text`;
    fs.writeFileSync(text, Buffer.from('%end 1 2 1\r\n%error 1 2 1\r\n%begin 1 2 1\r\n%continue %0\r\ncaf\xc3\xa9 \xff tab\there \x1b[31mred\x1b[0m\r\n' + 'x'.repeat(3000), 'latin1'));
    const w = await t.newWindow('c_one', '/tmp', {});
    await t.run('respawn-pane', '-k', '-t', w.paneId, 'cat', text, '-');
    await t.newWindow('we;ird #{x} back\\slash ü', `${lastHome}`, {});
    // a client outside a UTF-8 locale
    for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) vi.stubEnv(k, '');
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const c = t.connect();
    await c.start();
    c.send('refresh-client -f pause-after=3');
    const continued: string[] = [];
    c.on('continue', (id) => continued.push(id));
    await waitFor(async () => (await spawned.capture(w.paneId, 10)).includes('red'));
    const call = vi.spyOn(t as unknown as { call: () => Promise<string> }, 'call');
    expect(await t.listWindows()).toEqual(await spawned.listWindows());
    expect(await t.listSessions()).toEqual(await spawned.listSessions());
    expect(await t.screen(w.paneId)).toEqual(await spawned.screen(w.paneId));
    expect(await t.capture(w.paneId, 100)).toEqual(await spawned.capture(w.paneId, 100));
    expect(call).not.toHaveBeenCalled();
    expect(continued).toEqual([]);
    c.stop();
  });

  it('captures up to 100 lines on the control client and a longer history in a client of its own, so no pane output waits behind it', async () => {
    const t = await boot();
    const w = await t.newWindow('c_one', '/tmp', {});
    const c = t.connect();
    await c.start();
    const call = vi.spyOn(t as unknown as { call: () => Promise<string> }, 'call');
    await t.capture(w.paneId, 100);
    expect(call).not.toHaveBeenCalled();
    await t.capture(w.paneId, 101);
    expect(call).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('asks a client of its own what the control client fails, cannot answer in time, or is gone for, and keeps later replies in order', async () => {
    const t = await boot();
    const spawned = new Tmux(t.socket, `${lastHome}/tmux.conf`, t.binary);
    const w = await t.newWindow('c_one', '/tmp', {});
    const c = t.connect();
    await c.start();
    const error = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => e.message);
    expect(await error(t.capture('%999', 10))).toBe(await error(spawned.capture('%999', 10)));
    // a command that waits holds up every reply behind it
    c.send("run-shell 'sleep 2'");
    const call = vi.spyOn(t as unknown as { call: () => Promise<string> }, 'call');
    expect(await t.listWindows()).toEqual(await spawned.listWindows());
    expect(call).toHaveBeenCalledTimes(1);
    expect(c.answering).toBe(false);
    await waitFor(() => c.answering);
    expect(await t.screen(w.paneId)).toEqual(await spawned.screen(w.paneId));
    expect(call).toHaveBeenCalledTimes(1);
    const asked = t.listSessions();
    c.stop();
    expect(await asked).toEqual(await spawned.listSessions());
    expect(call).toHaveBeenCalledTimes(2);
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

  it('start rejects when tmux refuses the attach', async () => {
    const t = await boot();
    const c = new ControlClient({ binary: t.binary, socket: t.socket, conf: `${lastHome}/tmux.conf`, session: 'nosuch' });
    await expect(c.start()).rejects.toThrow("tmux refused the attach: can't find session: nosuch");
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
