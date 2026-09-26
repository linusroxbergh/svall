import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultsPrefs, moveOldIds, oldIdsLeft, signInsLeft, type Launchctl, type Prefs } from '../src/legacy.js';
import { launchdPlist } from '../src/setup.js';
import type { AppQuit } from '../src/uninstall.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const OLD = 'com.archipelago.desktop';
const NEW = 'io.github.linusroxbergh.archipelago';
const domain = `gui/${os.userInfo().uid}`;
// no test has an app open to quit, so one that tries fails
const noApp: AppQuit = { isApp: () => false, quit: () => Promise.reject(new Error('quit an app that is not open')), wait: async () => {} };
// a window that never quits
const stays: AppQuit = { isApp: (pid) => pid === 101, quit: async () => {}, wait: async () => {} };

// records each launchctl call, with whether the new-label plist of its fleet is on disk by then
function recorder(): { calls: [string[], boolean][]; run: Launchctl } {
  const calls: [string[], boolean][] = [];
  return { calls, run: async (args) => { calls.push([args, fs.existsSync(args[2].replace('com.archipelago.archid', `${NEW}.archid`))]); } };
}

// the defaults as cfprefsd would hold them: moved once, then an emptied domain whose file stays
function prefsOnce(): { moved: string[][]; prefs: Prefs } {
  const moved: string[][] = [];
  return { moved, prefs: { move: async (from, to) => { moved.push([from, to]); return moved.length === 1; } } };
}

// a machine an older install set up: two fleets' agents, the app with its sign-ins, caches and defaults
function oldInstall() {
  const root = makeHome();
  const library = path.join(root, 'Library');
  const launchAgentsDir = path.join(library, 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  const homes = [path.join(root, '.archipelago'), path.join(root, '.archipelago-work')];
  for (const home of homes) {
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
  }
  const plist = (label: string, home: string) => launchdPlist({ label, program: ['/r/node_modules/.bin/tsx', '/r/packages/archid/src/bin.ts'], home, log: path.join(home, 'archid.log'), pathEnv: '/usr/bin:/bin' });
  fs.writeFileSync(path.join(launchAgentsDir, 'com.archipelago.archid.plist'), plist('com.archipelago.archid', homes[0]));
  fs.writeFileSync(path.join(launchAgentsDir, 'com.archipelago.archid.work.plist'), plist('com.archipelago.archid.work', homes[1]));
  fs.writeFileSync(path.join(launchAgentsDir, 'com.other.plist'), '<plist/>');
  const store = path.join(library, 'WebKit', OLD, 'WebsiteDataStore', 'a-store');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'cookies'), 'signed in');
  fs.mkdirSync(path.join(library, 'Caches', OLD, 'WebKit'), { recursive: true });
  fs.mkdirSync(path.join(library, 'Preferences'));
  fs.writeFileSync(path.join(library, 'Preferences', `${OLD}.plist`), '<plist/>');
  // the app installed, which this build replaces with one under the new id
  const apps = path.join(root, 'Applications');
  const info = path.join(apps, 'Archipelago.app', 'Contents', 'Info.plist');
  fs.mkdirSync(path.dirname(info), { recursive: true });
  const install = (id: string) => fs.writeFileSync(info, `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
  install(NEW);
  return {
    library, launchAgentsDir, homes, install, app: path.join(apps, 'Archipelago.app'),
    at: (label: string) => path.join(launchAgentsDir, `${label}.plist`),
    o: { library, launchAgentsDir, homes, appDests: [apps] },
  };
}

describe('moveOldIds', () => {
  it('leaves a machine with nothing under the old ids alone', async () => {
    const f = oldInstall();
    for (const d of ['WebKit', 'Caches', 'Preferences']) fs.rmSync(path.join(f.library, d), { recursive: true });
    for (const n of fs.readdirSync(f.launchAgentsDir)) fs.rmSync(path.join(f.launchAgentsDir, n));
    fs.writeFileSync(f.at(`${NEW}.archid`), '<plist/>');
    const r = recorder();
    const prefs: Prefs = { move: () => Promise.reject(new Error('moved defaults that are not there')) };
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);
    expect(await moveOldIds({ ...f.o, app: noApp, run: r.run, prefs })).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('quits the app, moves its sign-ins, caches and defaults, and moves every agent, stopping each old one before its new one is written', async () => {
    const f = oldInstall();
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(true);
    fs.writeFileSync(path.join(f.homes[1], 'app.pid'), `101\t${f.homes[1]}`);
    const open = new Set([101]);
    const seen: [number, boolean][] = [];
    const quit: AppQuit = { isApp: (pid) => open.has(pid), quit: async (pid) => { seen.push([pid, fs.existsSync(path.join(f.library, 'WebKit', OLD))]); open.delete(pid); }, wait: async () => {} };
    const r = recorder();
    const p = prefsOnce();
    const o = { ...f.o, run: r.run, prefs: p.prefs };

    const lines = await moveOldIds({ ...o, app: quit });
    expect(seen).toEqual([[101, true]]);
    expect(lines[0]).toBe('quit Archipelago');
    expect(fs.readFileSync(path.join(f.library, 'WebKit', NEW, 'WebsiteDataStore', 'a-store', 'cookies'), 'utf8')).toBe('signed in');
    expect(fs.readdirSync(path.join(f.library, 'WebKit'))).toEqual([NEW]);
    expect(fs.readdirSync(path.join(f.library, 'Caches'))).toEqual([NEW]);
    expect(p.moved).toEqual([[OLD, NEW]]);
    expect(lines).toContain(`moved the ${OLD} defaults to ${NEW}`);
    expect(fs.readdirSync(path.join(f.library, 'Preferences'))).toEqual([]);

    expect(fs.readdirSync(f.launchAgentsDir).sort()).toEqual(['com.other.plist', `${NEW}.archid.plist`, `${NEW}.archid.work.plist`]);
    const work = fs.readFileSync(f.at(`${NEW}.archid.work`), 'utf8');
    expect(work).toContain(`<key>Label</key><string>${NEW}.archid.work</string>`);
    expect(work).toContain(`<key>ARCHI_HOME</key><string>${f.homes[1]}</string>`);
    expect(work).not.toContain('com.archipelago');
    // the private fleet's agent is left to setup, which writes its plist afresh and starts it
    expect(r.calls).toEqual([
      [['bootout', domain, f.at('com.archipelago.archid')], false],
      [['bootout', domain, f.at('com.archipelago.archid.work')], false],
      [['bootout', domain, f.at(`${NEW}.archid.work`)], true], [['bootstrap', domain, f.at(`${NEW}.archid.work`)], true],
    ]);
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);

    r.calls.length = 0;
    expect(await moveOldIds({ ...o, app: noApp })).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('keeps the sign-ins and defaults where an older build installed still reads them, says so on every run, and moves the agents with the app left open', async () => {
    const f = oldInstall();
    f.install(OLD);
    fs.writeFileSync(path.join(f.homes[0], 'app.pid'), `101\t${f.homes[0]}`);
    const open: AppQuit = { ...stays, quit: () => Promise.reject(new Error('asked a window to quit')) };
    const r = recorder();
    const p = prefsOnce();
    const left = `left the app's sign-ins and defaults under ${OLD}, as ${f.app} is an older build that reads them: pnpm desktop:install replaces it, or delete it if it is a spare copy`;
    const lines = await moveOldIds({ ...f.o, app: open, run: r.run, prefs: p.prefs });
    expect(lines[0]).toBe(left);
    expect(fs.readdirSync(path.join(f.library, 'WebKit'))).toEqual([OLD]);
    expect(p.moved).toEqual([]);
    expect(fs.readdirSync(f.launchAgentsDir).sort()).toEqual(['com.other.plist', `${NEW}.archid.plist`, `${NEW}.archid.work.plist`]);
    expect(await moveOldIds({ ...f.o, app: open, run: r.run, prefs: p.prefs })).toEqual([left]);
    // desktop:install runs setup again once it has put the new build in place
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(true);
    f.install(NEW);
    fs.rmSync(path.join(f.homes[0], 'app.pid'));
    expect((await moveOldIds({ ...f.o, app: noApp, run: r.run, prefs: p.prefs }))[0]).toBe(`moved ${path.join(f.library, 'WebKit', OLD)} -> ${path.join(f.library, 'WebKit', NEW)}`);
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);
  });

  it('leaves sign-ins beside ones the new id already has, which the check keeps naming, and keeps an agent archi wrote before setup ran', async () => {
    const f = oldInstall();
    fs.writeFileSync(f.at(`${NEW}.archid`), 'written by archi');
    const webkit = (id: string) => path.join(f.library, 'WebKit', id);
    fs.mkdirSync(webkit(NEW));
    const r = recorder();
    const lines = await moveOldIds({ ...f.o, app: noApp, run: r.run, prefs: prefsOnce().prefs });
    expect(fs.readdirSync(path.join(f.library, 'WebKit')).sort()).toEqual([OLD, NEW]);
    expect(fs.readdirSync(webkit(NEW))).toEqual([]);
    expect(fs.readdirSync(path.join(f.library, 'Caches'))).toEqual([NEW]);
    expect(lines).toContain(`moved ${path.join(f.library, 'Caches', OLD)} -> ${path.join(f.library, 'Caches', NEW)}`);
    expect(fs.readFileSync(f.at(`${NEW}.archid`), 'utf8')).toBe('written by archi');
    expect(fs.existsSync(f.at('com.archipelago.archid'))).toBe(false);
    // setup never merges the two, so they no longer ask for it, and a second run passes them by
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);
    expect(await moveOldIds({ ...f.o, app: noApp, run: r.run, prefs: prefsOnce().prefs })).toEqual([]);
    expect(signInsLeft(f.library)).toBe(`${webkit(OLD)} is left beside ${webkit(NEW)}, which the app reads: quit the app, then keep whichever holds your sign-ins at ${webkit(NEW)} and delete the other`);
    fs.rmSync(webkit(OLD), { recursive: true });
    expect(signInsLeft(f.library)).toBeUndefined();
  });

  it('leaves defaults an older build wrote once the new id has its own', async () => {
    const f = oldInstall();
    for (const d of ['WebKit', 'Caches']) fs.rmSync(path.join(f.library, d), { recursive: true });
    for (const n of fs.readdirSync(f.launchAgentsDir)) fs.rmSync(path.join(f.launchAgentsDir, n));
    fs.writeFileSync(path.join(f.library, 'Preferences', `${NEW}.plist`), '<plist/>');
    const prefs: Prefs = { move: () => Promise.reject(new Error('moved defaults over the new ones')) };
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);
    expect(await moveOldIds({ ...f.o, app: noApp, run: recorder().run, prefs })).toEqual([]);
    expect(fs.existsSync(path.join(f.library, 'Preferences', `${OLD}.plist`))).toBe(true);
  });

  it('keeps the old defaults for the next run when they will not move', async () => {
    const f = oldInstall();
    for (const d of ['WebKit', 'Caches']) fs.rmSync(path.join(f.library, d), { recursive: true });
    for (const n of fs.readdirSync(f.launchAgentsDir)) fs.rmSync(path.join(f.launchAgentsDir, n));
    const prefs: Prefs = { move: () => Promise.reject(new Error('Could not import\nmore')) };
    expect(await moveOldIds({ ...f.o, app: noApp, run: recorder().run, prefs })).toEqual([`could not move the ${OLD} defaults: Could not import`]);
    expect(fs.existsSync(path.join(f.library, 'Preferences', `${OLD}.plist`))).toBe(true);
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(true);
  });

  it('keeps an agent it could not stop under its old label, and says which agent would not start', async () => {
    const f = oldInstall();
    for (const d of ['WebKit', 'Caches', 'Preferences']) fs.rmSync(path.join(f.library, d), { recursive: true });
    const calls: string[][] = [];
    // the private fleet's agent was not loaded, and the work fleet's will not stop
    const stuck: Launchctl = async (args) => {
      calls.push(args);
      if (args[0] === 'bootout' && args[2] === f.at('com.archipelago.archid')) throw new Error('Boot-out failed: 3: No such process');
      if (args[0] === 'print' && args[1] === `${domain}/com.archipelago.archid`) throw new Error('Could not find service');
      if (args[0] === 'bootout' && args[2] === f.at('com.archipelago.archid.work')) throw new Error('Boot-out failed: 5: Input/output error');
    };
    expect(await moveOldIds({ ...f.o, app: noApp, run: stuck, prefs: prefsOnce().prefs })).toEqual([
      `moved ${f.at('com.archipelago.archid')} -> ${f.at(`${NEW}.archid`)}`,
      'could not stop com.archipelago.archid.work, so it stays under its old label; run archi setup again',
    ]);
    expect(fs.readdirSync(f.launchAgentsDir).sort()).toEqual(['com.archipelago.archid.work.plist', 'com.other.plist', `${NEW}.archid.plist`]);
    expect(calls.some(([c]) => c === 'bootstrap')).toBe(false);
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(true);

    const fails: Launchctl = async (args) => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error\nmore'); };
    expect(await moveOldIds({ ...f.o, app: noApp, run: fails, prefs: prefsOnce().prefs })).toEqual([
      `moved ${f.at('com.archipelago.archid.work')} -> ${f.at(`${NEW}.archid.work`)}`,
      `could not start ${NEW}.archid.work: Bootstrap failed: 5: Input/output error`,
    ]);
    expect(oldIdsLeft(f.launchAgentsDir, f.library)).toBe(false);
  });

  it('quits the app before it moves the defaults alone', async () => {
    const f = oldInstall();
    for (const d of ['WebKit', 'Caches']) fs.rmSync(path.join(f.library, d), { recursive: true });
    for (const n of fs.readdirSync(f.launchAgentsDir)) fs.rmSync(path.join(f.launchAgentsDir, n));
    fs.writeFileSync(path.join(f.homes[0], 'app.pid'), `101\t${f.homes[0]}`);
    const p = prefsOnce();
    await expect(moveOldIds({ ...f.o, app: stays, run: recorder().run, prefs: p.prefs })).rejects.toThrow('then run archi setup again');
    expect(p.moved).toEqual([]);
  });

  it('changes nothing while the app will not quit', async () => {
    const f = oldInstall();
    fs.writeFileSync(path.join(f.homes[0], 'app.pid'), `101\t${f.homes[0]}`);
    const r = recorder();
    await expect(moveOldIds({ ...f.o, app: stays, run: r.run, prefs: prefsOnce().prefs }))
      .rejects.toThrow('Archipelago did not quit within 60 s, so nothing was changed; quit it, then run archi setup again');
    expect(r.calls).toEqual([]);
    expect(fs.existsSync(f.at('com.archipelago.archid'))).toBe(true);
    expect(fs.existsSync(path.join(f.library, 'WebKit', OLD))).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('defaultsPrefs', () => {
  // a path names a defaults file of its own, so this never reaches an app's real defaults
  it('moves every default to the new domain and empties the old one', async () => {
    const dir = makeHome();
    const from = path.join(dir, 'old.plist');
    const to = path.join(dir, 'new.plist');
    execFileSync('defaults', ['write', from, 'NSWindow Frame main', '1 2 3 4']);
    execFileSync('defaults', ['write', to, 'kept', '-int', '5']);
    expect(await defaultsPrefs.move(from, to)).toBe(true);
    expect(execFileSync('defaults', ['read', to, 'NSWindow Frame main'], { encoding: 'utf8' }).trim()).toBe('1 2 3 4');
    expect(execFileSync('defaults', ['read', to, 'kept'], { encoding: 'utf8' }).trim()).toBe('5');
    expect(await defaultsPrefs.move(from, to)).toBe(false);
  });
});
