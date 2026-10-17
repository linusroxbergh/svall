import fs from 'node:fs';
import path from 'node:path';
import type { Operation } from 'fast-json-patch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.js';
import { Store } from '../src/store.js';
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

  it('persists updates atomically and emits patch ops', () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    const seen: unknown[] = [];
    s.subscribe((ops) => seen.push(ops));
    const ops = s.update((d) => { d.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 }; });
    expect(ops[0]).toMatchObject({ op: 'add', path: '/islands/i_1' });
    expect(seen).toHaveLength(1);
    s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).islands.i_1.name).toBe('a');
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('writes a burst of changes to disk once, soon after the first, while it batches', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.batchWritesWhile(() => true);
    const renames = vi.spyOn(fs, 'renameSync');
    for (let n = 1; n <= 5; n++) s.update((d) => { d.dormantAfterHours = n; });
    expect(s.state.dormantAfterHours).toBe(5);
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(250);
    expect(renames).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).dormantAfterHours).toBe(5);
  });

  it('writes a change still waiting at once when flushed, and only once', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.batchWritesWhile(() => true);
    const renames = vi.spyOn(fs, 'renameSync');
    s.update((d) => { d.scribeOff = true; });
    s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).scribeOff).toBe(true);
    vi.advanceTimersByTime(1000);
    s.flush();
    expect(renames).toHaveBeenCalledTimes(1);
  });

  it('writes a change it takes while it does not batch, along with any still waiting', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    let batch = true;
    s.batchWritesWhile(() => batch);
    s.update((d) => { d.scribeOff = true; });
    batch = false;
    s.update((d) => { d.dormantAfterHours = 3; });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ scribeOff: true, dormantAfterHours: 3 });
  });

  it('logs a write that fails while it batches, keeps the change, and writes it at the next flush or change', () => {
    vi.useFakeTimers();
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    s.batchWritesWhile(() => true);
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

  it('does not make a fleet home that is gone again, nor fail on the log gone with it', () => {
    const home = makeHome();
    const s = Store.load(path.join(home, 'state.json'), createLogger(path.join(home, 'svalld.log')).error);
    s.batchWritesWhile(() => true);
    s.update((d) => { d.scribeOff = true; });
    fs.rmSync(home, { recursive: true });
    expect(() => s.flush()).not.toThrow();
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
    expect(s.state.characters).toEqual({});
    expect(fs.readdirSync(home).some((f) => f.startsWith('state.json.broken-'))).toBe(true);
    expect(logs[0]).toMatch(/unreadable/);
  });

  it('refuses a file from a newer svalld and leaves it in place', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const newer = JSON.stringify({ version: 10, islands: {}, characters: {} });
    fs.writeFileSync(file, newer);
    expect(() => Store.load(file, () => {})).toThrow(/version 10.*newer.*update svall/);
    expect(fs.readdirSync(home)).toEqual(['state.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });

  it('lifts a version 7 or 8 file to 9, keeping the file as read beside it', () => {
    for (const version of [7, 8]) {
      const home = makeHome();
      const file = path.join(home, 'state.json');
      const before = JSON.stringify({ version, islands: {}, characters: {} });
      fs.writeFileSync(file, before);
      expect(Store.load(file, () => {}).state.version).toBe(9);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(9);
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
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(9);
    expect(logs[0]).toMatch(/migrated/);
    const kept = fs.readdirSync(home).find((f) => f.startsWith('state.json.v7-'));
    expect(kept).toBeDefined();
    expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
  });

  it('leaves out a character the schema rejects, keeps the file as read beside the rest, and writes the rest back', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
    const char = (id: string) => ({ id, islandId: 'i_1', cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false });
    const before = JSON.stringify({ version: 9, islands: { i_1: island }, characters: { c_good: char('c_good'), c_bad: { ...char('c_bad'), agent: { kind: 'gemini' } } } });
    fs.writeFileSync(file, before);
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    expect(Object.keys(s.state.characters)).toEqual(['c_good']);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).characters)).toEqual(['c_good']);
    const kept = fs.readdirSync(home).find((f) => f.startsWith('state.json.broken-'));
    expect(kept).toBeDefined();
    expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
    expect(logs.join('\n')).toMatch(/character c_bad: agent/);
  });
});

const island = (id: string) => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 });

describe('Store.update', () => {
  it('writes no character the schema would refuse, and leaves the fleet as every listener last saw it', () => {
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => {
      d.characters.c_1 = {
        id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'ada', note: '', portrait: 'fox', instructions: '', cwd: '/w', context: [],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const written = fs.readFileSync(file, 'utf8');
    const seen: unknown[] = [];
    s.subscribe((ops) => seen.push(...ops));
    expect(() => s.update((d) => { d.characters.c_2 = { ...d.characters.c_1, id: 'c_2', name: undefined as never, cwd: undefined as never }; })).toThrow(/c_2/);
    expect(() => s.update((d) => { delete (d.characters.c_1 as { cwd?: string }).cwd; })).toThrow(/c_1/);
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    expect(Object.keys(s.state.characters)).toEqual(['c_1']);
    expect(seen).toEqual([]);
  });
});

describe('prepared state', () => {
  it('reads a prepared snapshot without making it active', () => {
    const home = makeHome();
    const s = Store.load(path.join(home, 'state.json'), () => {});
    const prepared = path.join(home, 'handover', 'prepared-tx-1.json');
    fs.mkdirSync(path.dirname(prepared), { recursive: true });
    fs.writeFileSync(prepared, JSON.stringify({ ...s.state, islands: { i_1: island('i_1') } }));
    expect(Object.keys(Store.readSnapshot(prepared).islands)).toEqual(['i_1']);
    expect(s.state.islands).toEqual({});
  });

  it('refuses a prepared file that is not a valid snapshot', () => {
    const home = makeHome();
    const prepared = path.join(home, 'prepared-tx-1.json');
    fs.writeFileSync(prepared, '{"version":7,"islands":{"bad":{}},"characters":{}}');
    expect(() => Store.readSnapshot(prepared)).toThrow();
  });

  it('promotes a prepared file onto state.json and replaces the live state', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const s = Store.load(file, () => {});
    s.update((d) => { d.islands.i_1 = island('i_1'); });
    const prepared = path.join(home, 'handover', 'prepared-tx-1.json');
    fs.mkdirSync(path.dirname(prepared), { recursive: true });
    fs.writeFileSync(prepared, JSON.stringify({ ...s.state, islands: { i_9: island('i_9') } }));
    const seen: Operation[][] = [];
    s.subscribe((ops) => seen.push(ops));
    const ops = s.promote(prepared);
    expect(seen).toEqual([ops]);
    expect(Object.keys(s.state.islands)).toEqual(['i_9']);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).islands)).toEqual(['i_9']);
    expect(fs.existsSync(prepared)).toBe(false);
  });

  it('leaves the prepared file in place when it does not validate', () => {
    const home = makeHome();
    const s = Store.load(path.join(home, 'state.json'), () => {});
    const prepared = path.join(home, 'prepared-tx-1.json');
    fs.writeFileSync(prepared, '{"version":7,"islands":{"bad":{}},"characters":{}}');
    expect(() => s.promote(prepared)).toThrow();
    expect(fs.existsSync(prepared)).toBe(true);
    expect(s.state.islands).toEqual({});
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
