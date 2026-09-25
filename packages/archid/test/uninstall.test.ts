import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { codexInstalled, codexPaths } from '../src/codex/install.js';
import { realDeps } from '../src/mobile.js';
import { HOOK_EVENTS, hookCommand, mergeHooks, mergeStatusLine, runSetup, statusWrapper, unmergeHooks, unmergeStatusLine } from '../src/setup.js';
import { fleetData, purge, runUninstall } from '../src/uninstall.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

afterEach(cleanHomes);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = '/h/.archipelago/hooks/agent-hook.mjs';
const statusScript = '/h/.archipelago/hooks/claude-status.mjs';
const hook = hookCommand('/n/node', script, 'claude');
const status = statusWrapper('/n/node', statusScript);
const noTailscale = realDeps(() => Promise.reject(new Error('no tailscale')));

describe('unmergeHooks', () => {
  it('removes only Archipelago entries and the groups and events they leave empty', () => {
    const mine = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] }, model: 'x' };
    expect(unmergeHooks(mergeHooks(mine, hook, HOOK_EVENTS, script), script)).toEqual(mine);
    expect(unmergeHooks(mergeHooks({}, hook, HOOK_EVENTS, script), script)).toEqual({});
  });

  it('keeps a hook of yours that shares a group with an Archipelago entry', () => {
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
  const home = path.join(root, '.archipelago');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'home') } }));
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const mine = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] }, statusLine: { type: 'command', command: 'ccstatusline' } };
  fs.mkdirSync(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(mine));
  const launchAgentsDir = path.join(root, 'LaunchAgents');
  const shimDir = path.join(root, 'bin');
  return { root, home, settingsPath, mine, launchAgentsDir, shimDir, o: { home, homes: [home], settingsPath, settingsPaths: [settingsPath], launchAgentsDir, shimDir, repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(root, '.codex') }), mobile: noTailscale } };
}

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
    expect((await runSetup(f.o)).some((l) => l.includes('codex'))).toBe(false);

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
    const plist = path.join(f.launchAgentsDir, 'com.archipelago.archid.plist');
    try {
      link(fs.readFileSync(f.o.codex.hooks, 'utf8'));
      await expect(runUninstall(f.o)).rejects.toThrow(`${f.o.codex.hooks} links to`);
      expect(fs.readFileSync(f.settingsPath, 'utf8')).toBe(set);
      expect(fs.existsSync(plist)).toBe(true);
      link('{}');
      await runUninstall(f.o);
      expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
      expect(fs.existsSync(plist)).toBe(false);
      expect(fs.existsSync(path.join(f.shimDir, 'archi'))).toBe(false);
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

  it('undoes what setup added to the machine and keeps the fleet', async () => {
    const f = installed();
    await runSetup(f.o);
    fs.writeFileSync(path.join(f.launchAgentsDir, 'com.archipelago.archid.work.plist'), '<plist/>');
    fs.writeFileSync(path.join(f.launchAgentsDir, 'com.other.plist'), '<plist/>');
    fs.writeFileSync(path.join(f.shimDir, 'other'), 'x');

    const lines = await runUninstall(f.o);
    expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual(f.mine);
    expect(fs.readdirSync(f.launchAgentsDir)).toEqual(['com.other.plist']);
    expect(fs.readdirSync(f.shimDir)).toEqual(['other']);
    expect(fs.existsSync(path.join(f.home, 'config.json'))).toBe(true);
    expect(lines).toContain(`removed ${path.join(f.launchAgentsDir, 'com.archipelago.archid.work.plist')}`);

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

  it('leaves an archi on PATH that setup did not write', async () => {
    const f = installed();
    fs.mkdirSync(f.shimDir);
    fs.writeFileSync(path.join(f.shimDir, 'archi'), '#!/bin/sh\necho someone else\n');
    await runUninstall(f.o);
    expect(fs.readFileSync(path.join(f.shimDir, 'archi'), 'utf8')).toContain('someone else');
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
    const work = path.join(f.root, '.archipelago-work');
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

  it('refuses from a terminal inside a fleet\'s tmux server before it changes anything', async () => {
    const f = installed();
    await runSetup(f.o);
    await expect(runUninstall({ ...f.o, tmux: `${path.join(f.home, 'tmux.sock')},123,0` })).rejects.toThrow('run archi uninstall from a terminal outside Archipelago');
    expect(fs.existsSync(path.join(f.launchAgentsDir, 'com.archipelago.archid.plist'))).toBe(true);
    expect(fs.existsSync(path.join(f.shimDir, 'archi'))).toBe(true);
    expect(await runUninstall({ ...f.o, tmux: '/private/tmp/tmux-501/default,123,0' })).toContain(`removed ${path.join(f.shimDir, 'archi')}`);
  });

  it('changes nothing when the Claude settings are not valid JSON', async () => {
    const f = installed();
    await runSetup(f.o);
    fs.writeFileSync(f.settingsPath, '{ nope');
    await expect(runUninstall(f.o)).rejects.toThrow('is not valid JSON');
    expect(fs.existsSync(path.join(f.launchAgentsDir, 'com.archipelago.archid.plist'))).toBe(true);
    expect(fs.existsSync(path.join(f.shimDir, 'archi'))).toBe(true);
  });
});

describe('purge', () => {
  it('finds every fleet home and the app, and deletes only those', async () => {
    const root = makeHome();
    for (const d of ['.archipelago', '.archipelago-work', '.archipelagos', 'other']) fs.mkdirSync(path.join(root, d));
    for (const d of ['.archipelago', '.archipelago-work']) fs.writeFileSync(path.join(root, d, 'config.json'), '{}');
    const appDest = path.join(root, 'Applications');
    fs.mkdirSync(path.join(appDest, 'Archipelago.app'), { recursive: true });
    const library = path.join(root, 'Library');
    const webkit = path.join(library, 'WebKit', 'com.archipelago.desktop');
    const caches = path.join(library, 'Caches', 'com.archipelago.desktop');
    const prefs = path.join(library, 'Preferences', 'com.archipelago.desktop.plist');
    for (const d of [webkit, caches, path.join(library, 'Caches', 'com.other')]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.dirname(prefs));
    for (const f of [prefs, path.join(library, 'Preferences', 'com.other.plist')]) fs.writeFileSync(f, '<plist/>');

    const data = fleetData({ homedir: root, appDests: [appDest] });
    expect(data).toEqual([path.join(root, '.archipelago'), path.join(root, '.archipelago-work'), path.join(appDest, 'Archipelago.app'), webkit, caches, prefs]);
    await purge(data);
    expect(fs.readdirSync(root).sort()).toEqual(['.archipelagos', 'Applications', 'Library', 'other']);
    expect(fs.readdirSync(path.join(library, 'WebKit'))).toEqual([]);
    expect(fs.readdirSync(path.join(library, 'Caches'))).toEqual(['com.other']);
    expect(fs.readdirSync(path.join(library, 'Preferences'))).toEqual(['com.other.plist']);
    expect(fs.readdirSync(appDest)).toEqual([]);
    expect(fleetData({ homedir: root, appDests: [appDest] })).toEqual([]);
  });

  it('leaves a folder of yours that is only named like a fleet, and a dangling link', async () => {
    const root = makeHome();
    fs.mkdirSync(path.join(root, '.archipelago-backup'));
    fs.writeFileSync(path.join(root, '.archipelago-backup', 'notes.md'), 'mine');
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, '.archipelago-old'));
    expect(fleetData({ homedir: root, appDests: ['/nowhere'] })).toEqual([]);
  });

  it('reports a path it could not delete and still deletes the rest', async () => {
    const root = makeHome();
    const gone = path.join(root, '.archipelago');
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'config.json'), '{}');
    const locked = path.join(root, 'locked');
    const app = path.join(locked, 'Archipelago.app');
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
