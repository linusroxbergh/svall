import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { answers, displayName, fleetControl, fleetNamed, ProtocolMismatch, takenNames, type FleetDeps } from '../src/fleets.js';
import type { HomeSetup } from '../src/setup.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

// a fleet home is a folder holding a config.json
function fleetAt(homedir: string, dir: string, config: object = {}): string {
  const home = path.join(homedir, dir);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function fake(homedir: string, o: { up?: string[]; loaded?: string[]; apps?: number[] } = {}) {
  const calls: [string, string[]][] = [];
  const setups: HomeSetup[] = [];
  const up = new Set(o.up ?? []);
  const deps: FleetDeps = {
    homedir,
    exists: (p) => fs.existsSync(p),
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'print' && !(o.loaded ?? []).some((l) => args[1].endsWith(`/${l}`))) throw new Error('not loaded');
      // a bootstrapped agent starts its daemon
      if (args[0] === 'bootstrap') up.add(path.join(homedir, `.svall-${path.basename(args[2]).split('.svalld.')[1]?.replace('.plist', '')}`));
    },
    connect: async (home) => { if (!up.has(home)) throw new Error('down'); return { close() {} }; },
    setupHome: async (s) => { setups.push(s); fleetAt(homedir, path.basename(s.home)); fs.mkdirSync(s.launchAgentsDir, { recursive: true }); fs.writeFileSync(path.join(s.launchAgentsDir, `${s.label}.plist`), ''); return []; },
    isApp: (pid) => (o.apps ?? []).includes(pid),
    uid: 501,
    launchAgentsDir: path.join(homedir, 'Library/LaunchAgents'),
    repoRoot: '/r',
    timeoutMs: 40,
    intervalMs: 5,
  };
  return { deps, calls, setups, up };
}

describe('fleet names', () => {
  it('names a fleet by its config name, else by its directory', () => {
    const u = makeHome();
    expect(displayName(fleetAt(u, '.svall'), u)).toBe('private');
    expect(displayName(fleetAt(u, '.svall-work', { name: 'office' }), u)).toBe('office');
    expect(displayName(fleetAt(u, '.svall-side'), u)).toBe('side');
  });

  it('counts every other fleet\'s name and directory as taken, and not the fleet\'s own', () => {
    const u = makeHome();
    const priv = fleetAt(u, '.svall', { name: 'home' });
    fleetAt(u, '.svall-work', { name: 'office' });
    expect(takenNames(u).sort()).toEqual(['home', 'office', 'private', 'work']);
    expect(takenNames(u, priv).sort()).toEqual(['office', 'work']);
    expect(takenNames(u, `${priv}/`).sort()).toEqual(['office', 'work']);
  });

  it('finds a fleet by its config name, and none in a home folder that is not there', () => {
    const u = makeHome();
    const work = fleetAt(u, '.svall-work', { name: 'office' });
    expect(fleetNamed('office', u)).toBe(work);
    expect(fleetNamed('work', u)).toBeUndefined();
    expect(fleetNamed('office', path.join(u, 'nowhere'))).toBeUndefined();
  });
});

describe('fleetControl', () => {
  it('lists each fleet with its name, this window\'s, the running ones and the ones a window shows', async () => {
    const u = makeHome();
    const priv = fleetAt(u, '.svall');
    const work = fleetAt(u, '.svall-work', { name: 'office' });
    const side = fleetAt(u, '.svall-side');
    fs.writeFileSync(path.join(work, 'app.pid'), `4242\t${work}`);
    // a pid file left by a crash, now naming another process
    fs.writeFileSync(path.join(side, 'app.pid'), `99\t${side}`);
    const f = fake(u, { up: [work], apps: [4242] });
    expect(await fleetControl(priv, f.deps).list()).toEqual([
      { home: priv, name: 'private', current: true, running: true, windowOpen: false },
      { home: side, name: 'side', current: false, running: false, windowOpen: false },
      { home: work, name: 'office', current: false, running: true, windowOpen: true },
    ]);
  });

  it('creates a fleet with a free port and its own agent, and waits for it to answer', async () => {
    const u = makeHome();
    const priv = fleetAt(u, '.svall');
    const f = fake(u);
    const home = await fleetControl(priv, f.deps).create('work');
    expect(home).toBe(path.join(u, '.svall-work'));
    expect(f.setups).toEqual([{ home, label: 'io.github.linusroxbergh.svall.svalld.work', repoRoot: '/r', launchAgentsDir: f.deps.launchAgentsDir, launchctl: false, port: 0 }]);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', path.join(f.deps.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.work.plist')]]);
    expect(f.up.has(home)).toBe(true);
  });

  it('refuses a name another fleet goes by, or one svall could not open, before touching anything', async () => {
    const u = makeHome();
    const priv = fleetAt(u, '.svall', { name: 'home' });
    fleetAt(u, '.svall-work', { name: 'office' });
    const f = fake(u);
    const fleets = fleetControl(priv, f.deps);
    for (const [name, why] of [['home', 'another fleet is called home'], ['work', 'another fleet is called work'], ['office', 'another fleet is called office'], ['status', 'svall status is a command'], ['Big', 'lowercase']]) {
      await expect(fleets.create(name)).rejects.toThrow(why);
    }
    fs.mkdirSync(path.join(u, '.svall-stray'));
    await expect(fleets.create('stray')).rejects.toThrow(`${path.join(u, '.svall-stray')} already exists`);
    expect(f.setups).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('says where the log is when a new fleet never answers', async () => {
    const u = makeHome();
    const f = fake(u);
    f.deps.exec = async (cmd, args) => { f.calls.push([cmd, args]); if (args[0] === 'print') throw new Error('not loaded'); };
    await expect(fleetControl(fleetAt(u, '.svall'), f.deps).create('work')).rejects.toThrow(`svalld did not start; see ${path.join(u, '.svall-work', 'svalld.log')} (down)`);
  });

  it('starts a stopped fleet through its agent, and leaves a loaded one to answer', async () => {
    const u = makeHome();
    const priv = fleetAt(u, '.svall');
    const work = fleetAt(u, '.svall-work');
    const plist = path.join(u, 'Library/LaunchAgents', 'io.github.linusroxbergh.svall.svalld.work.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '');
    const f = fake(u);
    expect(await fleetControl(priv, f.deps).start(work)).toBe(work);
    expect(f.calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', plist]]);
    const loaded = fake(u, { up: [work], loaded: ['io.github.linusroxbergh.svall.svalld.work'] });
    await fleetControl(priv, loaded.deps).start(work);
    expect(loaded.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false);
  });

  it('starts only a fleet home it lists', async () => {
    const u = makeHome();
    const f = fake(u);
    await expect(fleetControl(fleetAt(u, '.svall'), f.deps).start('/tmp')).rejects.toThrow('no fleet at /tmp');
    expect(f.calls).toEqual([]);
  });
});

describe('answers', () => {
  const servers: WebSocketServer[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  async function daemon(protocol: number): Promise<string> {
    const home = makeHome();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.once('message', (raw) => {
      ws.send(JSON.stringify(JSON.parse(raw.toString()).token === 't' ? { id: 0, result: { ok: true, protocol } } : { id: 0, error: {} }));
    }));
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');
    return home;
  }

  it('holds for a daemon that takes the token and speaks this protocol', async () => {
    await expect(answers(await daemon(PROTOCOL_VERSION))).resolves.toMatchObject({ close: expect.any(Function) });
  });

  it('fails for one that speaks another protocol, or has no port', async () => {
    await expect(answers(await daemon(PROTOCOL_VERSION - 1))).rejects.toBeInstanceOf(ProtocolMismatch);
    await expect(answers(makeHome())).rejects.toThrow();
  });
});
