import fs from 'node:fs';
import path from 'node:path';
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

  it('writes a burst of changes to disk once, soon after the first', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const s = Store.load(file, () => {});
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
    const renames = vi.spyOn(fs, 'renameSync');
    s.update((d) => { d.scribeOff = true; });
    s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).scribeOff).toBe(true);
    vi.advanceTimersByTime(1000);
    s.flush();
    expect(renames).toHaveBeenCalledTimes(1);
  });

  it('logs a write that fails, keeps the change, and writes it at the next flush or change', () => {
    vi.useFakeTimers();
    const file = path.join(makeHome(), 'state.json');
    const logs: string[] = [];
    const s = Store.load(file, (m) => logs.push(m));
    // stands in for a full disk or a permission error
    fs.mkdirSync(`${file}.tmp`);
    s.update((d) => { d.defaultCwd = '/elsewhere'; });
    vi.advanceTimersByTime(250);
    expect(logs).toEqual([expect.stringMatching(/^state.json not written: /)]);
    expect(s.state.defaultCwd).toBe('/elsewhere');
    fs.rmdirSync(`${file}.tmp`);
    s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).defaultCwd).toBe('/elsewhere');
    s.update((d) => { d.scribeOff = true; });
    vi.advanceTimersByTime(250);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ defaultCwd: '/elsewhere', scribeOff: true });
  });

  it('does not make a fleet home that is gone again, nor fail on the log gone with it', () => {
    const home = makeHome();
    const s = Store.load(path.join(home, 'state.json'), createLogger(path.join(home, 'svalld.log')).error);
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
    const newer = JSON.stringify({ version: 8, islands: {}, characters: {} });
    fs.writeFileSync(file, newer);
    expect(() => Store.load(file, () => {})).toThrow(/version 8.*newer.*update svall/);
    expect(fs.readdirSync(home)).toEqual(['state.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
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

  it('migrates a version 6 file and writes it back, keeping the file it read', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const before = JSON.stringify({ version: 6, islands: {}, characters: {} });
    fs.writeFileSync(file, before);
    const logs: string[] = [];
    Store.load(file, (m) => logs.push(m));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(7);
    expect(logs[0]).toMatch(/migrated/);
    const kept = fs.readdirSync(home).find((f) => f.startsWith('state.json.v6-'));
    expect(kept).toBeDefined();
    expect(fs.readFileSync(path.join(home, kept!), 'utf8')).toBe(before);
  });

  it('leaves out a character the schema rejects, keeps the file as read beside the rest, and writes the rest back', () => {
    const home = makeHome();
    const file = path.join(home, 'state.json');
    const island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
    const char = (id: string) => ({ id, islandId: 'i_1', cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false });
    const before = JSON.stringify({ version: 7, islands: { i_1: island }, characters: { c_good: char('c_good'), c_bad: { ...char('c_bad'), agent: { kind: 'gemini' } } } });
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
