import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { DURABLE_TEMP, DurableJson, cleanupDurableTemps, createDurable, realStages, writeDurable, type DurableStages } from '../../src/handover/durable.js';
import { writeJsonAtomic } from '../../src/atomic.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const temps = (dir: string): string[] => fs.readdirSync(dir).filter((f) => DURABLE_TEMP.test(f));

const failAfter = (stage: keyof DurableStages): Partial<DurableStages> => ({
  [stage]: (...args: unknown[]) => {
    (realStages[stage] as (...a: unknown[]) => unknown)(...args);
    throw new Error('crash');
  },
});

describe('writeDurable', () => {
  it('creates the directory and writes json at mode 0600 with no temp left behind', () => {
    const dir = path.join(makeHome(), 'handover');
    const file = path.join(dir, 'journal.json');
    writeDurable(file, { phase: 'freeze' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ phase: 'freeze' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(temps(dir)).toEqual([]);
  });

  it('writes bytes unchanged', () => {
    const file = path.join(makeHome(), 'blob.bin');
    writeDurable(file, Buffer.from([1, 2, 3]));
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
  });

  it.each([
    ['open', 'old'],
    ['write', 'old'],
    ['fsyncFile', 'old'],
    ['rename', 'new'],
    ['fsyncDir', 'new'],
  ] as const)('a crash after %s leaves the whole %s content', (stage, expected) => {
    const file = path.join(makeHome(), 'state.json');
    writeDurable(file, { v: 'old' });
    expect(() => writeDurable(file, { v: 'new' }, { stages: failAfter(stage) })).toThrow('crash');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe(expected);
  });

  it.each([
    ['open', 'open'], ['write', 'write'], ['fsyncFile', 'fsyncFile'], ['rename', 'link'],
  ] as const)('removes its temp when the write fails at %s', (replacing, creating) => {
    const dir = makeHome();
    const file = path.join(dir, 'state.json');
    writeDurable(file, { v: 'old' });
    expect(() => writeDurable(file, { v: 'new' }, { stages: failAfter(replacing) })).toThrow('crash');
    expect(() => createDurable(path.join(dir, 'new.json'), { v: 'new' }, { stages: failAfter(creating) })).toThrow('crash');
    expect(temps(dir)).toEqual([]);
  });

  it('leaves the temp a crash left before the rename to cleanup, which collects it once the write that followed finished', () => {
    const dir = makeHome();
    const file = path.join(dir, 'state.json');
    writeDurable(file, { v: 'old' });
    const left = `${file}.durable-1-0badc0de.tmp`;
    fs.writeFileSync(left, '{"v":"new"');
    fs.utimesSync(left, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
    writeDurable(file, { v: 'newer' });
    cleanupDurableTemps(dir);
    expect(temps(dir)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe('newer');
  });

  it('finishes a write the platform cuts short instead of renaming a truncated temp', () => {
    const file = path.join(makeHome(), 'state.json');
    writeDurable(file, { v: 'old' });
    let short = true;
    const stages: Partial<DurableStages> = {
      write: (fd, bytes, at) => {
        if (!short) return realStages.write(fd, bytes, at);
        short = false;
        return realStages.write(fd, bytes.subarray(0, at + 5), at);
      },
    };
    writeDurable(file, { v: 'new' }, { stages });
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ v: 'new' }, null, 2) + '\n');
  });

  it('leaves the whole old content when the write stalls part way', () => {
    const dir = makeHome();
    const file = path.join(dir, 'state.json');
    writeDurable(file, { v: 'old' });
    let wrote = false;
    const stages: Partial<DurableStages> = {
      write: (fd, bytes, at) => {
        if (wrote) return 0;
        wrote = true;
        return realStages.write(fd, bytes.subarray(0, 5), at);
      },
    };
    expect(() => writeDurable(file, { v: 'new' }, { stages })).toThrow(/stalled at 5 of/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe('old');
    expect(temps(dir)).toEqual([]);
  });

  it('swallows a directory fsync the platform refuses', () => {
    const file = path.join(makeHome(), 'state.json');
    const refuse = { fsyncDir: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); } };
    writeDurable(file, { v: 'new' }, { stages: refuse });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe('new');
  });
});

describe('createDurable', () => {
  it('creates a whole file at mode 0600, and refuses a name already taken without touching it', () => {
    const dir = path.join(makeHome(), 'replicas');
    const file = path.join(dir, 'r.json');
    createDurable(file, { v: 'first' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe('first');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => createDurable(file, { v: 'second' })).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe('first');
    expect(temps(dir)).toEqual([]);
  });

  it('leaves no file when it crashes before the link, and the whole file after it', () => {
    const dir = makeHome();
    expect(() => createDurable(path.join(dir, 'a.json'), { v: 1 }, { stages: failAfter('fsyncFile') })).toThrow('crash');
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
    expect(() => createDurable(path.join(dir, 'b.json'), { v: 1 }, { stages: failAfter('link') })).toThrow('crash');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')).v).toBe(1);
  });
});

describe('cleanupDurableTemps', () => {
  // what a writer that died before its rename leaves
  const crashed = (dir: string): void => fs.writeFileSync(path.join(dir, 'state.json.durable-1-0badc0de.tmp'), '{"v":');

  it('keeps a temp it cannot prove finished', () => {
    const dir = makeHome();
    crashed(dir);
    cleanupDurableTemps(dir);
    expect(temps(dir)).toHaveLength(1);
  });

  it('removes a temp older than the bounded age even without a final file', () => {
    const dir = makeHome();
    crashed(dir);
    const stale = path.join(dir, temps(dir)[0]);
    const old = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(stale, old, old);
    cleanupDurableTemps(dir);
    expect(temps(dir)).toEqual([]);
  });

  it('leaves a file that is not one of our temps alone', () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'state.json.tmp'), 'someone else');
    cleanupDurableTemps(dir);
    expect(fs.existsSync(path.join(dir, 'state.json.tmp'))).toBe(true);
  });

  it('ignores a directory that does not exist', () => {
    expect(() => cleanupDurableTemps(path.join(makeHome(), 'nope'))).not.toThrow();
  });
});

const Rec = z.object({ n: z.number() });

describe('DurableJson', () => {
  it('reports a missing file', () => {
    const j = new DurableJson(Rec, path.join(makeHome(), 'rec.json'));
    expect(j.read()).toEqual({ ok: false, reason: 'missing' });
  });

  it('round-trips a validated value', () => {
    const j = new DurableJson(Rec, path.join(makeHome(), 'rec.json'));
    j.write({ n: 3 });
    expect(j.read()).toEqual({ ok: true, value: { n: 3 } });
  });

  it('calls a file it cannot read malformed, never missing', () => {
    const home = makeHome();
    const asDir = path.join(home, 'dir.json');
    fs.mkdirSync(asDir);
    expect(new DurableJson(Rec, asDir).read()).toMatchObject({ ok: false, reason: 'malformed' });
    if (process.getuid?.() === 0) return;
    const locked = path.join(home, 'locked.json');
    fs.writeFileSync(locked, '{"n":1}', { mode: 0o000 });
    expect(new DurableJson(Rec, locked).read()).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('reports malformed json and a value the schema rejects', () => {
    const file = path.join(makeHome(), 'rec.json');
    const j = new DurableJson(Rec, file);
    fs.writeFileSync(file, '{oops');
    expect(j.read()).toMatchObject({ ok: false, reason: 'malformed' });
    fs.writeFileSync(file, '{"n":"three"}');
    expect(j.read()).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses to write a value the schema rejects', () => {
    const file = path.join(makeHome(), 'rec.json');
    expect(() => new DurableJson(Rec, file).write({ n: 'three' } as never)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('writeJsonAtomic', () => {
  it('still writes mode 0600 json through the durable writer', () => {
    const file = path.join(makeHome(), 'owner.json');
    writeJsonAtomic(file, { a: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
