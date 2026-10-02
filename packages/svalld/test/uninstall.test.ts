import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { codexInstalled, codexPaths } from '../src/codex/install.js';
import { realDeps } from '../src/mobile.js';
import { BUNDLE_ID, LAUNCHD_LABEL } from '../src/profile.js';
import { bundleRuntime, checkoutRuntime } from '../src/runtime.js';
import { HOOK_EVENTS, hookCommand, mergeHooks, mergeStatusLine, runSetup, shimText, statusWrapper, unmergeHooks, unmergeStatusLine } from '../src/setup.js';
import { appQuit, fleetData, fleetHomes, purge, quitApp, runUninstall, type AppQuit } from '../src/uninstall.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

afterEach(cleanHomes);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = '/h/.svall/hooks/agent-hook.mjs';
const statusScript = '/h/.svall/hooks/claude-status.mjs';
const hook = hookCommand('/n/node', script, 'claude');
const status = statusWrapper('/n/node', statusScript);
const noTailscale = realDeps(() => Promise.reject(new Error('no tailscale')));
// no test has an app open to quit, so one that tries fails
const noApp: AppQuit = { isApp: () => false, quit: () => Promise.reject(new Error('quit an app that is not open')), wait: async () => {} };

describe('unmergeHooks', () => {
  it('removes only Svall entries and the groups and events they leave empty', () => {
    const mine = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] }, model: 'x' };
    expect(unmergeHooks(mergeHooks(mine, hook, HOOK_EVENTS, script), script)).toEqual(mine);
    expect(unmergeHooks(mergeHooks({}, hook, HOOK_EVENTS, script), script)).toEqual({});
  });

  it('keeps a hook of yours that shares a group with an Svall entry', () => {
    const shared = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hook }, { type: 'command', command: 'mine.sh' }] }] } };
    expect(unmergeHooks(shared, script)).toEqual({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
  });
});

describe('unmergeStatusLine', () => {
  it('gives back the statusline setup wrapped, with its other keys', () => {
    const mine = { statusLine: { type: 'command', command: "ccstatusline --it's", padding: 1 } };
    expect(unmergeStatusLine(mergeStatusLine(mine, status, statusScript), statusScript)).toEqual(mine);
  });

  it('removes a wrapper that wrapped nothing, and leaves a statusline of your own alone', () => {
    expect(unmergeStatusLine(mergeStatusLine({}, status, statusScript), statusScript)).toEqual({});
    const mine = { statusLine: { type: 'command', command: 'ccstatusline' } };
    expect(unmergeStatusLine(mine, statusScript)).toEqual(mine);
  });
});

function installed() {
  const root = makeHome();
  const home = path.join(root, '.svall');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'home') } }));
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const mine = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] }, statusLine: { type: 'command', command: 'ccstatusline' } };
  fs.mkdirSync(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(mine));
  const launchAgentsDir = path.join(root, 'LaunchAgents');
  const shimDir = path.join(root, 'bin');
  return { root, home, settingsPath, mine, launchAgentsDir, shimDir, o: { home, homes: [home], settingsPath, settingsPaths: [settingsPath], launchAgentsDir, shimDir, runtime: checkoutRuntime(repoRoot), launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(root, '.codex') }), mobile: noTailscale, app: noApp } };
}

describe('fleetHomes', () => {
  it('lists only this variant\'s fleet homes', () => {
    const u = fs.mkdtempSync(path.join(os.tmpdir(), 'u-'));
    for (const d of ['.svall', '.svall-work', '.svall-dev', '.svall-dev-x']) {
      fs.mkdirSync(path.join(u, d)); fs.writeFileSync(path.join(u, d, 'config.json'), '{}');
    }
    expect(fleetHomes(u).map((h) => path.basename(h))).toEqual(['.svall', '.svall-work']);
  });
});

describe('runUninstall', () => {
  it('writes the codex hooks beside the user own, once, and takes back only its own', async () => {
    const f = installed();
    const hooksFile = f.o.codex.hooks;
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    fs.mkdirSync(f.o.codex.dir);
    fs.writeFileSync(hooksFile, JSON.stringify(mine));

    const first = await runSetup(f.o);
    expect(first.some((l) => l.includes('/hooks'))).toBe(true);
    expect(codexInstalled(JSON.parse(fs.readFileSync(hooksFile, 'utf8')), path.join(f.home, 'hooks/agent-hook.mjs'))).toBe(true);
    // codex skills and rules are rewritten every run; only the hooks write is once
    expect((await runSetup(f.o)).some((l) => l.includes('codex') && !l.startsWith('home codex'))).toBe(false);

    await runUninstall(f.o);
    expect(JSON.parse(fs.readFileSync(hooksFile, 'utf8'))).toEqual(mine);
  });

  it('changes nothing when the codex hooks file is not JSON, on the way in or out', async () => {
    const f = installed();
    fs.mkdirSync(f.o.codex.dir);
    fs.writeFileSync(f.o.codex.hooks, '{ "hooks": ');
    await expect(runSetup(f.o)).rejects.toThrow(`${f.o.codex.hooks} is not valid JSON`);
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
    expect(fs.existsSync(f.shimDir)).toBe(false);

    fs.rmSync(f.o.codex.hooks);
    await runSetup(f.o);
    const set = fs.readFileSync(f.settingsPath, 'utf8');
    fs.writeFileSync(f.o.codex.hooks, '{ "hooks": ');
    await expect(runUninstall(f.o)).rejects.toThrow('is not valid JSON');
    expect(fs.readFileSync(f.settingsPath, 'utf8')).toBe(set);
  });

  it('takes back nothing while a file linked into a read-only folder holds its hooks, and the rest once it does not', async () => {
    const f = installed();
    fs.mkdirSync(f.o.codex.dir);
    await runSetup(f.o);
    const set = fs.readFileSync(f.settingsPath, 'utf8');
    const store = path.join(f.root, 'store');
    fs.mkdirSync(store);
    const link = (text: string) => {
      fs.rmSync(f.o.codex.hooks);
      fs.chmodSync(store, 0o755);
      fs.writeFileSync(path.join(store, 'hooks.json'), text);
      fs.chmodSync(store, 0o555);
      fs.symlinkSync(path.join(store, 'hooks.json'), f.o.codex.hooks);
    };
    const plist = path.join(f.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.plist');
    try {
      link(fs.readFileSync(f.o.codex.hooks, 'utf8'));
      await expect(runUninstall(f.o)).rejects.toThrow(`${f.o.codex.hooks} links to`);
      expect(fs.readFileSync(f.settingsPath, 'utf8')).toBe(set);
      expect(fs.existsSync(plist)).toBe(true);
      link('{}');
      await runUninstall(f.o);
      expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
      expect(fs.existsSync(plist)).toBe(false);
      expect(fs.existsSync(path.join(f.shimDir, 'svall'))).toBe(false);
    } finally {
      fs.chmodSync(store, 0o755);
    }
  });

  it('leaves a machine without codex alone', async () => {
    const f = installed();
    await runSetup(f.o);
    await runUninstall(f.o);
    expect(fs.existsSync(f.o.codex.dir)).toBe(false);
  });

  it('removes a codex hooks file that held only its hooks', async () => {
    const f = installed();
    fs.mkdirSync(f.o.codex.dir);
    await runSetup(f.o);
    expect(await runUninstall(f.o)).toContain(`removed ${f.o.codex.hooks}`);
    expect(fs.readdirSync(f.o.codex.dir)).toEqual([]);
  });

  it('quits each open window once by its pid, waiting for it to go before the next, and before it takes anything back', async () => {
    const f = installed();
    await runSetup(f.o);
    const work = path.join(f.root, '.svall-work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'config.json'), '{}');
    fs.writeFileSync(path.join(f.home, 'app.pid'), `101\t${f.home}`);
    fs.writeFileSync(path.join(work, 'app.pid'), `102\t${work}`);
    const plist = path.join(f.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
    const open = new Set([101, 102]);
    const asked: [number, boolean, boolean][] = [];
    let waits = 0;
    // each window takes a few seconds to answer, as one asking about unsaved edits would; the mark in its home has it skip the question
    const app: AppQuit = {
      isApp: (pid) => open.has(pid),
      quit: async (pid) => { asked.push([pid, fs.existsSync(plist), fs.existsSync(path.join(pid === 101 ? f.home : work, 'quit-quietly'))]); },
      wait: async () => { if (++waits % 5 === 0) open.delete(asked[asked.length - 1][0]); },
    };
    const lines = await runUninstall({ ...f.o, homes: [f.home, work], app });
    expect(asked).toEqual([[101, true, true], [102, true, true]]);
    expect(fs.existsSync(path.join(work, 'quit-quietly'))).toBe(false);
    expect(waits).toBe(10);
    expect(lines[0]).toBe('quit Svall');

    // one that stays, as after Cancel, is asked once and stops the run before anything is taken back
    const g = installed();
    await runSetup(g.o);
    fs.writeFileSync(path.join(g.home, 'app.pid'), `101\t${g.home}`);
    let quits = 0;
    let waited = 0;
    const stays: AppQuit = { isApp: (pid) => pid === 101, quit: async () => { quits++; }, wait: async () => { waited++; } };
    await expect(runUninstall({ ...g.o, app: stays })).rejects.toThrow('Svall did not quit within 60 s, so nothing was changed');
    expect([quits, waited]).toEqual([1, 60]);
    expect(fs.existsSync(path.join(g.launchAgentsDir, `${LAUNCHD_LABEL}.plist`))).toBe(true);

    // a quit macOS will not pass on stops the run at once, with the reason
    const refused: AppQuit = { ...stays, quit: () => Promise.reject(new Error('Not authorized to send Apple events to Svall. (-1743)')) };
    await expect(runUninstall({ ...g.o, app: refused }))
      .rejects.toThrow('could not ask Svall to quit (Not authorized to send Apple events to Svall. (-1743)), so nothing was changed');
    expect(waited).toBe(60);
    // a mark left behind would have the user's own next quit skip the question
    expect(fs.existsSync(path.join(g.home, 'quit-quietly'))).toBe(false);

    // a pid the file names for another home is some other fleet's
    fs.writeFileSync(path.join(g.home, 'app.pid'), `101\t/elsewhere/.svall`);
    expect(await runUninstall({ ...g.o, app: stays })).toContain(`removed ${path.join(g.launchAgentsDir, `${LAUNCHD_LABEL}.plist`)}`);
    expect(quits).toBe(1);
  });

  it('does not quit the app that asked for the uninstall', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'u-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'u-'));
    fs.writeFileSync(path.join(a, 'app.pid'), `111\t${a}`);
    fs.writeFileSync(path.join(b, 'app.pid'), `222\t${b}`);
    const quit: number[] = [];
    const open = new Set([111, 222]);
    const app: AppQuit = { isApp: (pid) => open.has(pid), quit: async (pid) => { quit.push(pid); open.delete(pid); }, wait: async () => {} };
    await quitApp([a, b], app, 'svall uninstall', 111);
    expect(quit).toEqual([222]);
  });

  it('leaves the app and its Library data to the app when the app itself asked', () => {
    const u = fs.mkdtempSync(path.join(os.tmpdir(), 'u-'));
    fs.mkdirSync(path.join(u, 'Apps', 'Svall.app'), { recursive: true });
    fs.mkdirSync(path.join(u, 'Library', 'Caches', BUNDLE_ID), { recursive: true });
    const data = fleetData({ homedir: u, appDests: [path.join(u, 'Apps')], fromApp: true });
    expect(data).not.toContain(path.join(u, 'Apps', 'Svall.app'));
    expect(data).not.toContain(path.join(u, 'Library', 'Caches', BUNDLE_ID));
  });

  it('takes a pid that app.pid names but is not Svall for a window that crashed', async () => {
    const f = installed();
    await runSetup(f.o);
    fs.writeFileSync(path.join(f.home, 'app.pid'), `${process.pid}\t${f.home}`);
    expect(await runUninstall({ ...f.o, app: { ...noApp, isApp: appQuit.isApp } })).toContain(`removed ${path.join(f.launchAgentsDir, `${LAUNCHD_LABEL}.plist`)}`);
  });

  it('writes a codex hooks file that links elsewhere, rather than removing the link', async () => {
    const f = installed();
    fs.mkdirSync(f.o.codex.dir);
    await runSetup(f.o);
    const target = path.join(f.root, 'dotfiles', 'hooks.json');
    fs.mkdirSync(path.dirname(target));
    fs.renameSync(f.o.codex.hooks, target);
    fs.symlinkSync(target, f.o.codex.hooks);
    await runUninstall(f.o);
    expect(fs.lstatSync(f.o.codex.hooks).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({});
  });

  it('undoes what setup added to the machine and keeps the fleet', async () => {
    const f = installed();
    await runSetup(f.o);
    fs.writeFileSync(path.join(f.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.work.plist'), '<plist/>');
    fs.writeFileSync(path.join(f.launchAgentsDir, 'com.other.plist'), '<plist/>');
    fs.writeFileSync(path.join(f.shimDir, 'other'), 'x');

    const lines = await runUninstall(f.o);
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
    expect(fs.readdirSync(f.launchAgentsDir)).toEqual(['com.other.plist']);
    expect(fs.readdirSync(f.shimDir)).toEqual(['other']);
    expect(fs.existsSync(path.join(f.home, 'config.json'))).toBe(true);
    expect(lines).toContain(`removed ${path.join(f.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.work.plist')}`);

    // a second run has nothing of ours left to take back, so it writes nothing and backs nothing up
    expect(await runUninstall(f.o)).toEqual([]);
    expect(fs.readdirSync(path.dirname(f.settingsPath)).filter((n) => n.includes('.bak-'))).toHaveLength(2);
  });

  it('takes its hooks back from every Claude settings file it is given', async () => {
    const f = installed();
    await runSetup(f.o);
    const other = path.join(f.root, 'claude-config', 'settings.json');
    fs.mkdirSync(path.dirname(other));
    fs.copyFileSync(f.settingsPath, other);
    await runUninstall({ ...f.o, settingsPaths: [other, f.settingsPath] });
    expect(JSON.parse(fs.readFileSync(other, 'utf8'))).toEqual(f.mine);
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
  });

  it('writes nothing on a machine where setup never ran', async () => {
    const f = installed();
    fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: {}, model: 'x' }));
    expect(await runUninstall(f.o)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual({ hooks: {}, model: 'x' });
    expect(fs.readdirSync(path.dirname(f.settingsPath))).toEqual(['settings.json']);
  });

  it('removes the shim of an installed app', async () => {
    const f = installed();
    fs.mkdirSync(f.shimDir);
    const shim = path.join(f.shimDir, 'svall');
    fs.writeFileSync(shim, shimText(bundleRuntime('/Applications/Svall.app')));
    expect(await runUninstall(f.o)).toContain(`removed ${shim}`);
    expect(fs.existsSync(shim)).toBe(false);
  });

  it('leaves an svall on PATH that setup did not write', async () => {
    const f = installed();
    fs.mkdirSync(f.shimDir);
    fs.writeFileSync(path.join(f.shimDir, 'svall'), '#!/bin/sh\necho someone else\n');
    await runUninstall(f.o);
    expect(fs.readFileSync(path.join(f.shimDir, 'svall'), 'utf8')).toContain('someone else');
  });

  it.runIf(hasTmux())('stops every fleet\'s tmux server and keeps its home', async () => {
    const f = installed();
    const sock = path.join(f.home, 'tmux.sock');
    execFileSync('tmux', ['-S', sock, '-f', '/dev/null', 'new-session', '-d', 'sleep 600']);
    const pid = Number(execFileSync('tmux', ['-S', sock, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }));
    expect(await runUninstall(f.o)).toEqual([`stopped tmux server ${sock}`]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive());
    expect(fs.existsSync(path.join(f.home, 'config.json'))).toBe(true);
  });

  it('turns off every phone link that proxies to its fleet\'s key, whatever port the daemon had, and no other', async () => {
    const f = installed();
    const work = path.join(f.root, '.svall-work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'config.json'), '{}');
    for (const [home, key] of [[f.home, 'mine'], [work, 'work']]) fs.writeFileSync(path.join(home, 'mobile-key'), key);
    // no daemon runs, and the private fleet's had another port when its link went on; the work fleet's port proxies to a key it no longer holds
    const web = { 'mac.ts.net:443': 'http://127.0.0.1:47799/mine', 'mac.ts.net:8443': 'http://127.0.0.1:47801/old', 'mac.ts.net:10000': 'http://127.0.0.1:3000/notmine' };
    const calls: string[][] = [];
    const tailscale = (serveStatus: () => string) => realDeps(async (_cmd, args) => {
      calls.push(args);
      return args.join(' ') === 'serve status --json' ? serveStatus() : '';
    });
    const served = () => JSON.stringify({ Web: Object.fromEntries(Object.entries(web).map(([at, proxy]) => [at, { Handlers: { '/': { Proxy: proxy } } }])) });

    expect(await runUninstall({ ...f.o, homes: [f.home, work], mobile: tailscale(served) })).toEqual([`turned off the phone link to ${f.home} on port 443`]);
    expect(calls.filter((a) => a.includes('off'))).toEqual([['serve', '--https=443', 'off']]);

    calls.length = 0;
    const unread = tailscale(() => { throw new Error('tailscaled is not running\nretry later'); });
    expect(await runUninstall({ ...f.o, homes: [f.home, work], mobile: unread })).toEqual(['could not read tailscale serve status, so any phone link was left in place: tailscaled is not running']);
    expect(calls.filter((a) => a.includes('off'))).toEqual([]);
  });

  it('turns off a phone link its running daemon serves under a key already turned over', async () => {
    const f = installed();
    fs.writeFileSync(path.join(f.home, 'mobile-key'), 'new');
    fs.writeFileSync(path.join(f.home, 'port'), '47801');
    const web = { 'mac.ts.net:443': 'http://127.0.0.1:47801/old', 'mac.ts.net:8443': 'http://127.0.0.1:47802/other' };
    const calls: string[][] = [];
    const served = JSON.stringify({ Web: Object.fromEntries(Object.entries(web).map(([at, proxy]) => [at, { Handlers: { '/': { Proxy: proxy } } }])) });
    const mobile = realDeps(async (_cmd, args) => { calls.push(args); return args.join(' ') === 'serve status --json' ? served : ''; });
    expect(await runUninstall({ ...f.o, mobile })).toEqual([`turned off the phone link to ${f.home} on port 443`]);
    expect(calls.filter((a) => a.includes('off'))).toEqual([['serve', '--https=443', 'off']]);
  });

  it('carries on when tailscale answers its serve status in prose', async () => {
    const f = installed();
    await runSetup(f.o);
    const mobile = realDeps(async (_cmd, args) => args.join(' ') === 'serve status --json' ? 'The Tailscale CLI failed to start: Failed to load preferences.\n' : '');
    expect(await runUninstall({ ...f.o, mobile })).toContain('could not read tailscale serve status, so any phone link was left in place: The Tailscale CLI failed to start: Failed to load preferences.');
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
    expect(fs.readdirSync(f.launchAgentsDir)).toEqual([]);
    expect(fs.readdirSync(f.shimDir)).toEqual([]);
  });

  it('refuses from a terminal inside a fleet\'s tmux server before it changes anything', async () => {
    const f = installed();
    await runSetup(f.o);
    await expect(runUninstall({ ...f.o, tmux: `${path.join(f.home, 'tmux.sock')},123,0` })).rejects.toThrow('run svall uninstall from a terminal outside Svall');
    expect(fs.existsSync(path.join(f.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.plist'))).toBe(true);
    expect(fs.existsSync(path.join(f.shimDir, 'svall'))).toBe(true);
    expect(await runUninstall({ ...f.o, tmux: '/private/tmp/tmux-501/default,123,0' })).toContain(`removed ${path.join(f.shimDir, 'svall')}`);
  });

  it('changes nothing when the Claude settings are not valid JSON', async () => {
    const f = installed();
    await runSetup(f.o);
    fs.writeFileSync(f.settingsPath, '{ nope');
    fs.writeFileSync(path.join(f.home, 'app.pid'), `101\t${f.home}`);
    await expect(runUninstall({ ...f.o, app: { ...noApp, isApp: () => true } })).rejects.toThrow('is not valid JSON');
    expect(fs.existsSync(path.join(f.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.plist'))).toBe(true);
    expect(fs.existsSync(path.join(f.shimDir, 'svall'))).toBe(true);
  });
});

describe('purge', () => {
  it('finds every fleet home, the app and what macOS keeps under the app id, and deletes only those', async () => {
    const root = makeHome();
    for (const d of ['.svall', '.svall-work', '.svalls', 'other']) fs.mkdirSync(path.join(root, d));
    for (const d of ['.svall', '.svall-work']) fs.writeFileSync(path.join(root, d, 'config.json'), '{}');
    const appDest = path.join(root, 'Applications');
    fs.mkdirSync(path.join(appDest, 'Svall.app'), { recursive: true });
    const library = path.join(root, 'Library');
    const ids = ['io.github.linusroxbergh.svall'];
    const webkit = ids.map((id) => path.join(library, 'WebKit', id));
    const caches = ids.map((id) => path.join(library, 'Caches', id));
    const prefs = ids.map((id) => path.join(library, 'Preferences', `${id}.plist`));
    const http = ids.map((id) => path.join(library, 'HTTPStorages', id));
    const saved = ids.map((id) => path.join(library, 'Saved Application State', `${id}.savedState`));
    for (const d of [...webkit, ...caches, ...http, ...saved, path.join(library, 'Caches', 'com.other')]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(library, 'Preferences'));
    for (const f of [...prefs, path.join(library, 'Preferences', 'com.other.plist')]) fs.writeFileSync(f, '<plist/>');

    const data = fleetData({ homedir: root, appDests: [appDest] });
    expect(data).toEqual([path.join(root, '.svall'), path.join(root, '.svall-work'), path.join(appDest, 'Svall.app'), webkit[0], caches[0], http[0], saved[0], prefs[0]]);
    await purge(data);
    expect(fs.readdirSync(root).sort()).toEqual(['.svalls', 'Applications', 'Library', 'other']);
    expect(fs.readdirSync(path.join(library, 'WebKit'))).toEqual([]);
    expect(fs.readdirSync(path.join(library, 'HTTPStorages'))).toEqual([]);
    expect(fs.readdirSync(path.join(library, 'Saved Application State'))).toEqual([]);
    expect(fs.readdirSync(path.join(library, 'Caches'))).toEqual(['com.other']);
    expect(fs.readdirSync(path.join(library, 'Preferences'))).toEqual(['com.other.plist']);
    expect(fs.readdirSync(appDest)).toEqual([]);
    expect(fleetData({ homedir: root, appDests: [appDest] })).toEqual([]);
  });

  it('leaves a folder of yours that is only named like a fleet, and a dangling link', async () => {
    const root = makeHome();
    fs.mkdirSync(path.join(root, '.svall-backup'));
    fs.writeFileSync(path.join(root, '.svall-backup', 'notes.md'), 'mine');
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, '.svall-old'));
    expect(fleetData({ homedir: root, appDests: ['/nowhere'] })).toEqual([]);
  });

  it('reports a path it could not delete and still deletes the rest', async () => {
    const root = makeHome();
    const gone = path.join(root, '.svall');
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'config.json'), '{}');
    const locked = path.join(root, 'locked');
    const app = path.join(locked, 'Svall.app');
    fs.mkdirSync(app, { recursive: true });
    fs.chmodSync(locked, 0o555);
    try {
      const lines = await purge([gone, app]);
      expect(lines[0]).toBe(`deleted ${gone}`);
      expect(lines[1]).toMatch(/^could not delete /);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

});
