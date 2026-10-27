import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CWD, type MachineId } from '@svall/protocol';
import { createLogger } from '../src/log.js';
import { FlushInsideHold, Store } from '../src/store.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanHomes();
});

describe('Store', () => {
  it('starts empty when no file exists', () => {
    const s = Store.load(path.join(makeHome(), 'state.json'), () => {});
    expect(s.state.islands).toEqual({});
  });

  // prompts, notes and tab urls are in it; a file written before stays readable to the group until the first write
  it('writes state.json for the user alone, whatever it was before', async () => {
    const file = path.join(makeHome(), 'state.json');
    fs.writeFileSync(file, JSON.stringify({ version: 7, islands: {}, characters: {} }), { mode: 0o644 });
    const s = Store.load(file, () => {});
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    s.update((d) => { d.name = 'x'; });
    await s.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('persists updates atomically and emits patch ops', async () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    const seen: unknown[] = [];
    s.subscribe((ops) => seen.push(ops));
    const ops = s.update((d) => { d.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 }; });
    expect(ops[0]).toMatchObject({ op: 'add', path: '/islands/i_1' });
    expect(seen).toHaveLength(1);
    await s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).islands.i_1.name).toBe('a');
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('writes a burst of changes to disk once, soon after the first, while it batches', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.batchWrites();
    const renames = vi.spyOn(fs, 'renameSync');
    for (let n = 1; n <= 5; n++) s.update((d) => { d.dormantAfterHours = n; });
    expect(s.state.dormantAfterHours).toBe(5);
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(250);
    expect(renames).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).dormantAfterHours).toBe(5);
  });

  it('writes a change still waiting at once when flushed, and only once', async () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.batchWrites();
    const renames = vi.spyOn(fs, 'renameSync');
    s.update((d) => { d.scribeOff = true; });
    await s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).scribeOff).toBe(true);
    vi.advanceTimersByTime(1000);
    await s.flush();
    expect(renames).toHaveBeenCalledTimes(1);
  });

  it('withheld holds every write while fn runs, batching off, and the next flush writes its updates as one', async () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => { d.name = 'seed'; });
    const renames = vi.spyOn(fs, 'renameSync');
    await s.withheld(async () => {
      s.update((d) => { d.name = 'a'; });
      s.update((d) => { d.defaultCwd = '/a'; });
      vi.advanceTimersByTime(1000);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ name: 'seed', defaultCwd: DEFAULT_CWD });
    });
    expect(renames).not.toHaveBeenCalled();
    expect(await s.flush()).toBe(true);
    expect(renames).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ name: 'a', defaultCwd: '/a' });
  });

  it('a flush called while a hold runs waits for it, then writes what it changed in one write', async () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.batchWrites();
    const id = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // a listener runs outside the hold, so a flush it starts waits too
    const started: Promise<boolean>[] = [];
    s.subscribe(() => { if (!started.length) started.push(s.flush()); });
    const held = s.withheld(async () => {
      s.update((d) => { d.name = 'changed'; });
      await gate;
      s.update((d) => { d.machines = { [id]: { name: 'w1', reachable: true, since: 1, replayed: { epoch: 'e', seq: 1 } } }; });
    });
    let flushed: boolean | undefined;
    const flushing = s.flush().then((ok) => { flushed = ok; });
    await new Promise((r) => setTimeout(r, 50));
    expect([flushed, fs.existsSync(file)]).toEqual([undefined, false]);
    const renames = vi.spyOn(fs, 'renameSync');
    release();
    await held;
    await flushing;
    expect([flushed, await started[0]]).toEqual([true, true]);
    expect(renames).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ name: 'changed', machines: { [id]: { replayed: { epoch: 'e', seq: 1 } } } });
  });

  it('refuses a flush from inside the hold it would wait on, and lets the hold go', async () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => { d.name = 'seed'; });
    await expect(s.withheld(async () => {
      s.update((d) => { d.name = 'held'; });
      await s.flush();
    })).rejects.toBeInstanceOf(FlushInsideHold);
    expect(await s.flush()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).name).toBe('held');
  });

  it('logs a write that fails while it batches, keeps the change, and writes it at the next flush or change', () => {
    vi.useFakeTimers();
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    s.batchWrites();
    // stands in for a full disk or a permission error
    fs.chmodSync(home, 0o500);
    try {
      s.update((d) => { d.defaultCwd = '/elsewhere'; });
      vi.advanceTimersByTime(250);
    } finally {
      fs.chmodSync(home, 0o700);
    }
    expect(logs).toEqual([expect.stringMatching(/^state.json not written: /)]);
    expect(s.state.defaultCwd).toBe('/elsewhere');
    s.update((d) => { d.scribeOff = true; });
    vi.advanceTimersByTime(250);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ defaultCwd: '/elsewhere', scribeOff: true });
  });

  it('leaves the state as it was when the write fails, so every listener still agrees with it', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const s = Store.load(file, () => {});
    // stands in for a full disk or a permission error
    fs.chmodSync(home, 0o500);
    try {
      expect(() => s.update((d) => { d.defaultCwd = '/elsewhere'; })).toThrow();
    } finally {
      fs.chmodSync(home, 0o700);
    }
    expect(s.state.defaultCwd).not.toBe('/elsewhere');
  });

  it('does not make a fleet home that is gone again, nor fail on the log gone with it', async () => {
    const home = makeHome();
    const s = Store.load(path.join(home, 'state.json'), createLogger(path.join(home, 'svalld.log')).error);
    s.batchWrites();
    s.update((d) => { d.scribeOff = true; });
    fs.rmSync(home, { recursive: true });
    expect(await s.flush()).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('emits nothing when the mutator changes nothing', () => {
    const s = Store.load(path.join(makeHome(), 'state.json'), () => {});
    expect(s.update(() => {})).toEqual([]);
  });

  it('isolates a throwing listener from the rest', () => {
    const logs: string[] = [];
    const s = Store.load(path.join(makeHome(), 'state.json'), (m) => logs.push(m));
    s.subscribe(() => { throw new Error('boom'); });
    const seen: unknown[] = [];
    s.subscribe((ops) => seen.push(ops));
    expect(() => s.update((d) => { d.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 }; })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(logs[0]).toMatch(/listener failed/);
  });

  it('moves a corrupt file aside and starts empty', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    fs.writeFileSync(file, '{not json');
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    expect(s.state.robots).toEqual({});
    expect(fs.readdirSync(home).some((f) => f.startsWith('state.json.broken-'))).toBe(true);
    expect(logs[0]).toMatch(/unreadable/);
  });

  it('refuses a file from a newer svalld and leaves it in place', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const newer = JSON.stringify({ version: 13, islands: {}, robots: {} });
    fs.writeFileSync(file, newer);
    expect(() => Store.load(file, () => {})).toThrow(/version 13.*newer.*update svall/);
    expect(fs.readdirSync(home)).toEqual(['state.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });

  it('lifts a version 7, 8, 9, 10 or 11 file to 12, keeping the file as read beside it', () => {
    for (const version of [7, 8, 9, 10, 11]) {
      const home = makeHome();
      const file = path.join(home, 'state.json');
      const before = JSON.stringify({ version, islands: {}, [version >= 10 ? 'robots' : 'characters']: {} });
      fs.writeFileSync(file, before);
      expect(Store.load(file, () => {}).state.version).toBe(12);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(12);
      const kept = fs.readdirSync(home).find((f) => f.startsWith(`state.json.v${version}-`));
      expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
    }
  });

  it('refuses a file older than it reads and leaves it in place', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const older = JSON.stringify({ version: 5, islands: {}, characters: {} });
    fs.writeFileSync(file, older);
    expect(() => Store.load(file, () => {})).toThrow(/version 5, older than this svalld reads/);
    expect(fs.readdirSync(home)).toEqual(['state.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(older);
  });

  it('migrates a version 7 file and writes it back, keeping the file it read', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const before = JSON.stringify({ version: 7, islands: {}, characters: {} });
    fs.writeFileSync(file, before);
    const logs: string[] = [];
    Store.load(file, (m) => logs.push(m));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(12);
    expect(logs[0]).toMatch(/migrated/);
    const kept = fs.readdirSync(home).find((f) => f.startsWith('state.json.v7-'));
    expect(kept).toBeDefined();
    expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
  });

  it('leaves out a robot the schema rejects, keeps the file as read beside the rest, and writes the rest back', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
    const robot = (id: string) => ({ id, islandId: 'i_1', cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false });
    const before = JSON.stringify({ version: 12, islands: { i_1: island }, robots: { c_good: robot('c_good'), c_bad: { ...robot('c_bad'), agent: { kind: 'gemini' } } } });
    fs.writeFileSync(file, before);
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    expect(Object.keys(s.state.robots)).toEqual(['c_good']);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).robots)).toEqual(['c_good']);
    const kept = fs.readdirSync(home).find((f) => f.startsWith('state.json.broken-'));
    expect(kept).toBeDefined();
    expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
    expect(logs.join('\n')).toMatch(/robot c_bad: agent/);
  });
});

const island = (id: string) => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 });

describe('Store.update', () => {
  it('writes no robot the schema would refuse, and leaves the fleet as every listener last saw it', () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => {
      d.robots.c_1 = {
        id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'ada', note: '', portrait: 'fox', instructions: '', cwd: '/w', context: [],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const written = fs.readFileSync(file, 'utf8');
    const seen: unknown[] = [];
    s.subscribe((ops) => seen.push(...ops));
    expect(() => s.update((d) => { d.robots.c_2 = { ...d.robots.c_1, id: 'c_2', name: undefined as never, cwd: undefined as never }; })).toThrow(/c_2/);
    expect(() => s.update((d) => { delete (d.robots.c_1 as { cwd?: string }).cwd; })).toThrow(/c_1/);
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    expect(Object.keys(s.state.robots)).toEqual(['c_1']);
    expect(seen).toEqual([]);
  });
});

describe('Store.load', () => {
  it('collects a stale write temp that a finished write left behind', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => { d.islands.i_1 = island('i_1'); });
    const stale = `${file}.durable-1-deadbeef.tmp`;
    fs.writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 86_400_000);
    fs.utimesSync(stale, old, old);
    Store.load(file, () => {});
    expect(fs.existsSync(stale)).toBe(false);
  });
});
