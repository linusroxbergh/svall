import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeDaemon } from '@svall/svalld/fleet/home-move';
import { adoptDir, journalLines, packFleet, readMarker, writeMarker } from '@svall/svalld/fleet/home-move';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { KEY, MAC, marker, world } from '../../svalld/test/fleet/home-world.js';

const daemon = vi.hoisted(() => ({ current: undefined as unknown as HomeDaemon, starts: 0 }));
vi.mock('../src/controller/home.js', async (actual) => ({ ...(await actual<object>()), realHomeDaemon: () => daemon.current }));

const { fleetCommands } = await import('../src/commands/fleet.js');

const ID = 'hm_abcdefghij';
const FAR_FLEET = '11111111-2222-3333-4444-555555555555';
let home: string;
let printed: string[];

async function run(args: string[], stdin = '', o: { tty?: boolean } = {}): Promise<unknown> {
  printed = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { printed.push(String(s)); return true; });
  const input = vi.spyOn(process, 'stdin', 'get').mockReturnValue(Object.assign(Readable.from([stdin]), o.tty && { isTTY: true }) as never);
  try {
    await fleetCommands(() => ({ name: 'private', home, managed: false }), () => true).parseAsync(args, { from: 'user' });
  } finally { out.mockRestore(); input.mockRestore(); }
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
  const packed = await packFleet(w.mac.paths, { ...w.manifest, id: ID as never, to: me });
  await run(['adopt', ID, '--stage', '--sha256', packed.sha256], packed.bytes.toString('base64'));
  return { w, packed };
}

describe('what the far machine runs for a driver', () => {
  it('status: an id never heard of is refused for good, and says so', async () => {
    expect(await run(['status', ID])).toEqual({ status: 'not-adopted' });
    expect(journalLines(resolvePaths(home), ID).at(-1)?.phase).toBe('aborted');
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

  it('adopt with the old home\'s dial installs and starts, and an answer that never comes rolls back', async () => {
    await stagedHere();
    expect(await run(['adopt', ID, '--home-ssh', 'ada@studio'])).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(daemon.starts).toBeGreaterThanOrEqual(1);
    daemon.current.answersHome = () => Promise.resolve(true);
    const a = await run(['adopt', ID, '--home-ssh', 'ada@studio']) as { status: string; enrol: { worker: { homeSsh: string; token: string }; home: { ssh: string } } };
    expect(a.status).toBe('adopted');
    expect(a.enrol.worker.homeSsh).toBe('ada@studio');
    expect(a.enrol.home.ssh).toBe('ada@studio');
    // what the old home was told is what workers.json holds
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).workersFile, 'utf8'))[MAC].token).toBe(a.enrol.worker.token);
  });

  it('export prints the archive and its sha256, and refuses a manifest of another move', async () => {
    const w = await world();
    home = w.mac.paths.home;
    await w.mac.daemon.stop();
    const manifest = { ...w.manifest, id: ID };
    const said = await run(['export', ID, '--manifest', JSON.stringify(manifest)]) as { sha256: string; archive: string };
    expect(said.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(said.archive, 'base64').length).toBeGreaterThan(1000);
    await expect(run(['export', 'hm_otherother', '--manifest', JSON.stringify(manifest)])).rejects.toThrow(/of another move/);
  });

  it('enroll-worker on a home on its way elsewhere refuses, naming where', async () => {
    writeMarker(resolvePaths(home), marker());
    await expect(run(['enroll-worker', MAC, '--name', 'mac', '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/opt/svall'])).rejects.toThrow(/moving to studio/);
  });
});

describe('fleet settle: the old home told by the machine it has no route to', () => {
  const waiting = () => {
    const { ask: _ask, ...m } = marker();
    writeMarker(resolvePaths(home), { ...m, id: ID as never });
  };
  const ENROL = { worker: { homeMachineId: MAC, fleetId: FAR_FLEET, token: 'x'.repeat(48), homeName: 'mac' } };

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
    expect(readMarker(resolvePaths(home))?.enrol?.worker.homeMachineId).toBe(MAC);
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

  it('is not offered in the help', () => {
    expect(fleetCommands(() => ({ name: 'private', home, managed: false }), () => true).helpInformation()).not.toMatch(/settle/);
  });

  it('a home that asks for itself is told by no one', async () => {
    writeMarker(resolvePaths(home), { ...marker(), id: ID as never });
    await expect(run(['settle', ID, '--outcome', 'not-adopted'])).rejects.toThrow(/told by no one/);
    expect(readMarker(resolvePaths(home))?.id).toBe(ID);
  });
});

