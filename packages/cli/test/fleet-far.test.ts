import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askAcross } from '@svall/svalld/fleet/home-far';
import type { HomeDaemon } from '@svall/svalld/fleet/home-move';
import { adoptDir, journalLines, packFleet, readMarker } from '@svall/svalld/fleet/home-move';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { ADOPT_KEY, FLEET, KEY, MAC, marker, STUDIO, world, putMarker } from '../../svalld/test/fleet/home-world.js';

const daemon = vi.hoisted(() => ({ current: undefined as unknown as HomeDaemon, starts: 0 }));
// what each driver was handed of the crew's choice
const driven = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/controller/home.js', async (actual) => {
  const drive = (...args: unknown[]) => { driven.push(args); return Promise.resolve({ result: 'ready', actions: [] }); };
  return { ...(await actual<object>()), realHomeDaemon: () => daemon.current, moveHomeOut: drive, moveHomeBack: drive, bringCrewBack: drive };
});

// what the way back's connection to the home was asked for
const forwarded = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/controller/connection.js', async (actual) => ({ ...(await actual<object>()), connectForwarded: (...args: unknown[]) => { forwarded.push(args); return Promise.resolve({ client: {}, forward: {} }); } }));
// a daemon that answers, while `on`: what settle hands it
const up = vi.hoisted(() => ({ on: false, calls: [] as unknown[] }));
vi.mock('../src/client.js', async (actual) => {
  const real = await actual<typeof import('../src/client.js')>();
  return { ...real, withClient: (connect: Parameters<typeof real.withClient>[0], f: Parameters<typeof real.withClient>[1]) => (up.on ? f({ call: (m: string, p: unknown) => { up.calls.push([m, p]); return Promise.resolve({}); }, close: () => {} } as never) : real.withClient(connect, f)) };
});

const { fleetCommands } = await import('../src/definitions/fleet.js');
const { versionCommand } = await import('../src/definitions/version.js');
type MoveDeps = import('../src/controller/home.js').MoveDeps;

const ID = 'hm_abcdefghij';
const FAR_FLEET = '11111111-2222-3333-4444-555555555555';
let home: string;
let printed: string[];

async function run(args: string[], stdin = '', o: { tty?: boolean; target?: { name: string; home: string; managed: boolean } } = {}): Promise<unknown> {
  printed = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { printed.push(String(s)); return true; });
  const input = vi.spyOn(process, 'stdin', 'get').mockReturnValue(Object.assign(Readable.from([stdin]), o.tty && { isTTY: true }) as never);
  try {
    await fleetCommands(() => o.target ?? { name: 'private', home, managed: false }, () => true).parseAsync(args, { from: 'user' });
  } finally { out.mockRestore(); input.mockRestore(); }
  return JSON.parse(printed.join(''));
}

async function version(): Promise<unknown> {
  printed = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { printed.push(String(s)); return true; });
  try { await versionCommand(() => true, () => home).parseAsync([], { from: 'user' }); } finally { out.mockRestore(); }
  return JSON.parse(printed.join(''));
}

beforeEach(() => {
  home = path.join(makeHome(), 'fleet');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: FAR_FLEET }));
  daemon.starts = 0;
  daemon.current = { stop: () => Promise.resolve(), start: () => { daemon.starts++; return Promise.resolve(); }, answersHome: () => Promise.resolve(false) };
});
afterEach(() => { vi.restoreAllMocks(); cleanHomes(); });

// the archive of a move to this machine, staged here
async function stagedHere() {
  const w = await world();
  await w.mac.daemon.stop();
  const me = machineId();
  // by a name of its own, as this machine's registry may hold 'mac'
  const packed = await packFleet(w.mac.paths, { ...w.manifest, id: ID as never, to: me, record: { ...w.manifest.record, name: 'the-old-home' } });
  await run(['adopt', ID, '--stage', '--sha256', packed.sha256], packed.bytes.toString('base64'));
  return { w, packed };
}

describe('what the far machine runs for a driver', () => {
  const ASKED = ['--asker', MAC, '--fleet', FLEET];
  const serving = () => fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify({ homeMachineId: MAC, fleetId: FLEET, token: 'b'.repeat(48), homeName: 'mac' }));

  it('status: an id never heard of, from the home this folder serves, is refused for good, and says so', async () => {
    serving();
    expect(await run(['status', ID, ...ASKED])).toEqual({ status: 'not-adopted' });
    expect(journalLines(resolvePaths(home), ID).at(-1)?.phase).toBe('aborted');
  });

  it.each(['status', 'abort'])('%s by no home named, or by one this folder does not serve, answers pending and writes nothing', async (op) => {
    expect(await run([op, ID])).toMatchObject({ status: 'pending', phase: 'unknown' });
    expect(await run([op, ID, ...ASKED])).toMatchObject({ status: 'pending', phase: 'unknown' });
    serving();
    expect(await run([op, ID, '--asker', STUDIO, '--fleet', FLEET])).toMatchObject({ status: 'pending', phase: 'unknown' });
    expect(fs.existsSync(resolvePaths(home).homeMoves)).toBe(false);
  });

  it.each(['status', 'abort'])('%s in a folder that is not there makes none', async (op) => {
    home = path.join(makeHome(), 'gone');
    expect(await run([op, ID, ...ASKED])).toMatchObject({ status: 'pending', phase: 'unknown' });
    expect(fs.existsSync(home)).toBe(false);
  });

  it('facts names the fleet a worker serves, whatever its own fleet.json holds, and a folder with none fails', async () => {
    const OWN = '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70';
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: OWN }));
    serving();
    expect(await run(['facts'])).not.toHaveProperty('fleetKb');
    expect(await run(['facts'])).toMatchObject({ fleetId: FLEET });
    fs.rmSync(resolvePaths(home).workerFile);
    expect(await run(['facts'])).toHaveProperty('fleetKb');
    expect(await run(['facts'])).toMatchObject({ fleetId: OWN });
    fs.rmSync(resolvePaths(home).fleetConfig);
    await expect(run(['facts'])).rejects.toThrow();
  });

  it('version names the fleet a worker serves, as facts does, and the asker takes that for the fleet it marked for', async () => {
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' }));
    serving();
    expect(await run(['facts'])).toMatchObject({ fleetId: FLEET });
    const ask = async () => {
      const said = await version();
      const master = { run: (argv: string[]) => Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify(argv.at(-1) === "'version'" ? said : { status: 'pending', phase: 'unknown' }) }), close: () => Promise.resolve() };
      return askAcross({ ...marker(), to: machineId() as never, ask: { ssh: 'ada@here' as never, svallBase: '/x' as never, fleetHome: home as never } }, 'status', () => Promise.resolve(master as never));
    };
    expect(await ask()).toEqual({ status: 'pending', phase: 'unknown' });
    fs.rmSync(resolvePaths(home).workerFile);
    await expect(ask()).rejects.toThrow(/another machine or fleet/);
  });

  it('adopt --stage takes the archive from stdin, checked against its sha256', async () => {
    const { packed } = await stagedHere();
    expect(JSON.parse(printed.join(''))).toEqual({ status: 'pending', phase: 'staged' });
    expect(fs.existsSync(path.join(adoptDir(resolvePaths(home), ID), 'incoming', 'fleet.json'))).toBe(true);
    await expect(run(['adopt', 'hm_otherother', '--stage', '--sha256', 'f'.repeat(64)], packed.bytes.toString('base64'))).rejects.toThrow(/sha256/);
  });

  it('adopt --stage with no sha256 is refused', async () => {
    await expect(run(['adopt', ID, '--stage'])).rejects.toThrow(/--stage takes --sha256/);
  });

  it('a move id that is none is refused before anything', async () => {
    await expect(run(['status', 'hm_../../etc'])).rejects.toThrow(/not a home move's id/);
    expect(fs.existsSync(resolvePaths(home).homeMoves)).toBe(false);
  });

  it('abort calls a staged move off for good, and what was staged goes', async () => {
    await stagedHere();
    expect(await run(['abort', ID])).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(adoptDir(resolvePaths(home), ID))).toBe(false);
    expect(await run(['adopt', ID])).toMatchObject({ status: 'not-adopted' });
  });

  it('adopt with the old home\'s dial and its driver\'s key on stdin installs and starts, and an answer that never comes rolls back', async () => {
    await stagedHere();
    expect(await run(['adopt', ID, '--home-ssh', 'ada@studio'], `${ADOPT_KEY}\n`)).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(daemon.starts).toBeGreaterThanOrEqual(1);
    daemon.current.answersHome = () => Promise.resolve(true);
    const a = await run(['adopt', ID, '--home-ssh', 'ada@studio'], ADOPT_KEY) as { status: string; enrol: { worker: { homeSsh: string; token: string }; home: { ssh: string } } };
    expect(a.status).toBe('adopted');
    expect(a.enrol.worker.homeSsh).toBe('ada@studio');
    expect(a.enrol.home.ssh).toBe('ada@studio');
    // what the old home was told is what workers.json holds
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).workersFile, 'utf8'))[MAC].token).toBe(a.enrol.worker.token);
  });

  describe('adopt typed by hand on a staged machine', () => {
    it.each([
      ['at a terminal', '', true], ['with nothing piped', '', false], ['with a wrong key', 'typed by hand', false], ['with a key cut short', ADOPT_KEY.slice(0, 20), false], ['with what is no key at all', '{"key":"not json', false],
    ])('%s installs nothing, and no message holds what stdin held or the key', async (_how, stdin, tty) => {
      await stagedHere();
      const stop = vi.spyOn(daemon.current, 'stop');
      const said = await run(['adopt', ID, '--home-ssh', 'ada@studio'], stdin, { tty }).then(() => 'answered', (e: Error) => e.message);
      expect(said).toMatch(/only the driver of .* installs it/);
      const out = `${said}${printed.join('')}`;
      if (stdin) expect(out).not.toContain(stdin);
      expect(out).not.toContain(ADOPT_KEY);
      expect(stop).not.toHaveBeenCalled();
      expect(daemon.starts).toBe(0);
      expect(journalLines(resolvePaths(home), ID).at(-1)?.phase).toBe('staged');
    });

    it('is not offered in the help', () => {
      expect(fleetCommands(() => ({ name: 'private', home, managed: false }), () => true).helpInformation()).not.toMatch(/adopt/);
    });
  });

  it('export prints the archive and its sha256, and refuses a manifest of another move', async () => {
    const w = await world();
    home = w.mac.paths.home;
    await w.mac.daemon.stop();
    const manifest = { ...w.manifest, id: ID };
    const said = await run(['export', ID], JSON.stringify(manifest)) as { sha256: string; archive: string };
    expect(said.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(said.archive, 'base64').length).toBeGreaterThan(1000);
    await expect(run(['export', 'hm_otherother'], JSON.stringify(manifest))).rejects.toThrow(/of another move/);
  });

  it('enroll-worker on a home on its way elsewhere refuses, naming where', async () => {
    putMarker(resolvePaths(home), marker());
    await expect(run(['enroll-worker', MAC, '--name', 'mac', '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/opt/svall'])).rejects.toThrow(/moving to studio/);
  });
});

describe('the driver\'s commands', () => {
  beforeEach(() => { driven.length = 0; });

  it('home set and crew-back interrupt nothing unless --interrupt-after says when', async () => {
    await run(['home', 'set', 'studio']);
    await run(['home', 'set', 'local']);
    await run(['home', 'crew-back']);
    expect(driven.map((args) => args.at(-1))).toEqual([{}, {}, {}]);
    await run(['home', 'set', 'studio', '--interrupt-after', '0']);
    await run(['home', 'crew-back', '--interrupt-after', '24h']);
    expect(driven.slice(3).map((args) => args.at(-1))).toEqual([{ interruptAfterMs: 0 }, { interruptAfterMs: 24 * 3_600_000 }]);
  });

  it.each([
    [{ name: 'work', managed: true }, 'work'],
    [{ name: 'private', managed: false }, undefined],
  ])('the way back\'s connection to the home of %o names the -p a mismatch\'s upgrade goes by', async (t, profile) => {
    await run(['home', 'set', 'local'], '', { target: { ...t, home } });
    await (driven.at(-1)![0] as MoveDeps).farClient({} as never, {} as never, '/home/ada/.svall', FAR_FLEET);
    expect(forwarded.at(-1)![2]).toEqual({ fleetId: FAR_FLEET, fleetHome: '/home/ada/.svall', here: { profile } });
  });

  it('--interrupt-after past 24h is refused before anything moves', async () => {
    await expect(run(['home', 'set', 'studio', '--interrupt-after', '25h'])).rejects.toThrow('--interrupt-after takes at most 24h, not 25h');
    await expect(run(['home', 'crew-back', '--interrupt-after', '25h'])).rejects.toThrow(/at most 24h/);
    expect(driven).toEqual([]);
  });
});

describe('fleet settle: the old home told by the machine it has no route to', () => {
  const waiting = () => {
    const { ask: _ask, ...m } = marker();
    putMarker(resolvePaths(home), { ...m, id: ID as never });
  };
  const ENROL = { worker: { homeMachineId: marker().to, fleetId: FLEET, token: 'x'.repeat(48), homeName: 'studio' } };

  it('not-adopted with no daemon there ends the marker and starts it', async () => {
    waiting();
    expect(await run(['settle', ID, '--outcome', 'not-adopted'], JSON.stringify({ key: KEY }))).toEqual({ status: 'not-adopted' });
    expect(readMarker(resolvePaths(home))).toBeUndefined();
    expect(journalLines(resolvePaths(home), ID).at(-1)?.phase).toBe('released');
    expect(daemon.starts).toBe(1);
  });

  it('adopted with no daemon there writes the enrolment for its next start, and no thaw', async () => {
    waiting();
    expect(await run(['settle', ID, '--outcome', 'adopted'], JSON.stringify({ key: KEY, enrol: ENROL }))).toEqual({ status: 'adopted' });
    expect(readMarker(resolvePaths(home))?.enrol?.worker.homeMachineId).toBe(marker().to);
    expect(journalLines(resolvePaths(home), ID).at(-1)?.phase).not.toBe('aborted');
    expect(daemon.starts).toBe(1);
  });

  it('adopted with an enrolment that is none changes nothing', async () => {
    waiting();
    await expect(run(['settle', ID, '--outcome', 'adopted'], JSON.stringify({ key: KEY, enrol: { worker: {} } }))).rejects.toThrow();
    await expect(run(['settle', ID, '--outcome', 'adopted'], JSON.stringify({ key: KEY }))).rejects.toThrow(/takes the enrolment/);
    expect(readMarker(resolvePaths(home))?.enrol).toBeUndefined();
  });

  it('an outcome that is neither is refused, and is no thaw', async () => {
    waiting();
    await expect(run(['settle', ID, '--outcome', 'done'])).rejects.toThrow(/adopted or not-adopted/);
    expect(readMarker(resolvePaths(home))?.id).toBe(ID);
  });

  it('a move this home holds no marker of: heard already', async () => {
    expect(await run(['settle', ID, '--outcome', 'not-adopted'])).toEqual({ status: 'done' });
    expect(daemon.starts).toBe(0);
  });

  it.each(['not-adopted', 'adopted'])('%s typed by hand, at a terminal or piped without the key, refuses naming fleet home abort, and the marker stands', async (outcome) => {
    waiting();
    for (const [stdin, tty] of [['', true], ['', false], [JSON.stringify({ key: 'typed by hand', enrol: ENROL }), false]] as const) {
      await expect(run(['settle', ID, '--outcome', outcome], stdin, { tty })).rejects.toThrow(/only studio ends this move.*svall fleet home abort there/);
    }
    expect(readMarker(resolvePaths(home))?.enrol).toBeUndefined();
    expect(journalLines(resolvePaths(home), ID)).toEqual([]);
    expect(daemon.starts).toBe(0);
  });

  it('a daemon that answers is handed the key from stdin with the outcome', async () => {
    waiting();
    up.on = true;
    up.calls = [];
    try {
      await run(['settle', ID, '--outcome', 'not-adopted'], JSON.stringify({ key: KEY }));
      await run(['settle', ID, '--outcome', 'adopted'], JSON.stringify({ key: KEY, enrol: ENROL }));
    } finally { up.on = false; }
    expect(up.calls).toEqual([['fleet.homeMove', { op: 'told', id: ID, key: KEY }], ['fleet.homeMove', { op: 'join', id: ID, enrol: ENROL, key: KEY }]]);
  });

  it('is not offered in the help', () => {
    expect(fleetCommands(() => ({ name: 'private', home, managed: false }), () => true).helpInformation()).not.toMatch(/settle/);
  });

  it('a home that asks for itself is told by no one', async () => {
    putMarker(resolvePaths(home), { ...marker(), id: ID as never });
    await expect(run(['settle', ID, '--outcome', 'not-adopted'])).rejects.toThrow(/told by no one/);
    expect(readMarker(resolvePaths(home))?.id).toBe(ID);
  });
});

