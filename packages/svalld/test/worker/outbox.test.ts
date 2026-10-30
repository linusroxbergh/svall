import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LINE } from '../../src/link/stream.js';
import { resolvePaths } from '../../src/paths.js';
import { Outbox } from '../../src/worker/outbox.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const seqs = (o: Outbox, after = 0): number[] => o.after(after).map((e) => e.seq);

describe('Outbox', () => {
  it('append returns increasing seqs that survive reopen; ack trims only past the acked seq', () => {
    const paths = resolvePaths(makeHome());
    const first = Outbox.open(paths);
    expect([first.last(), first.acked()]).toEqual([0, 0]);
    expect([first.append('robot.sync', { n: 1 }), first.append('robot.sync', { n: 2 }), first.append('docs.changed', { n: 3 })]).toEqual([1, 2, 3]);

    const reopened = Outbox.open(paths);
    expect(reopened.last()).toBe(3);
    expect(reopened.after(1)).toEqual([{ seq: 2, kind: 'robot.sync', data: { n: 2 } }, { seq: 3, kind: 'docs.changed', data: { n: 3 } }]);

    reopened.ack(2);
    expect([reopened.acked(), ...seqs(reopened)]).toEqual([2, 3]);
    expect(fs.readFileSync(paths.outbox, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq)).toEqual([3]);
    // an ack the home sends again, or one behind it, changes nothing
    reopened.ack(1);
    expect(Outbox.open(paths).acked()).toBe(2);

    const third = Outbox.open(paths);
    expect([third.last(), third.acked(), ...seqs(third)]).toEqual([3, 2, 3]);
    third.ack(3);
    // with every entry acked the file is empty, and the next seq still follows the last
    expect(fs.readFileSync(paths.outbox, 'utf8')).toBe('');
    const emptied = Outbox.open(paths);
    expect([emptied.last(), emptied.acked(), seqs(emptied).length]).toEqual([3, 3, 0]);
    expect(emptied.append('robot.sync', {})).toBe(4);
  });

  // a thousand durable writes, which take tens of seconds under a loaded run
  it("keeps one unacknowledged entry per kind and key, on disk too, and never folds an entry without a key", () => {
    const paths = resolvePaths(makeHome());
    const o = Outbox.open(paths);
    o.append('robot.sync', { robotId: 'r_2', n: 0 }, 'r_2');
    o.append('docs.write', { path: 'a.md', n: 1 });
    for (let n = 1; n <= 1000; n++) o.append('robot.sync', { robotId: 'r_1', n }, 'r_1');
    o.append('docs.write', { path: 'a.md', n: 2 });
    const kept = [
      { seq: 1, kind: 'robot.sync', data: { robotId: 'r_2', n: 0 }, key: 'r_2' },
      { seq: 2, kind: 'docs.write', data: { path: 'a.md', n: 1 } },
      { seq: 1002, kind: 'robot.sync', data: { robotId: 'r_1', n: 1000 }, key: 'r_1' },
      { seq: 1003, kind: 'docs.write', data: { path: 'a.md', n: 2 } },
    ];
    expect([o.last(), ...o.after(0)]).toEqual([1003, ...kept]);
    expect(fs.readFileSync(paths.outbox, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(kept);
    expect(Outbox.open(paths).after(0)).toEqual(kept);
  }, 90_000);

  it('an ack of a seq that gave way trims up to it, and the entries after it replay in order', () => {
    const paths = resolvePaths(makeHome());
    const o = Outbox.open(paths);
    o.append('robot.sync', { n: 1 }, 'r_1');
    o.append('docs.write', { n: 2 });
    o.append('robot.sync', { n: 3 }, 'r_1');
    // the home took seq 1 before it gave way, and acks it
    o.ack(1);
    expect([o.acked(), ...seqs(o)]).toEqual([1, 2, 3]);
    o.append('robot.sync', { n: 4 }, 'r_1');
    const reopened = Outbox.open(paths);
    expect([reopened.last(), reopened.acked(), ...seqs(reopened, 1)]).toEqual([4, 1, 2, 4]);
    reopened.ack(4);
    expect([reopened.acked(), seqs(reopened).length, reopened.append('robot.sync', { n: 5 }, 'r_1')]).toEqual([4, 0, 5]);
  });

  it('keeps one epoch per journal, and ack records the entries it drops before the file is trimmed', () => {
    const paths = resolvePaths(makeHome());
    const a = Outbox.open(paths);
    a.append('x', 1);
    a.append('x', 2);
    expect(Outbox.open(paths).epoch()).toBe(a.epoch());
    const dropped: number[] = [];
    a.ack(1, (entries) => {
      dropped.push(...entries.map((e) => e.seq));
      expect(fs.readFileSync(paths.outbox, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
      expect(fs.readFileSync(paths.acked, 'utf8').trim()).toBe('0');
    });
    expect(dropped).toEqual([1]);
    expect(a.after(0).map((e) => e.seq)).toEqual([2]);
    a.ack(2);
    expect(Outbox.open(paths).epoch()).toBe(a.epoch());
  });

  it('a journal that lost its epoch keeps only the entries past the acked seq it had', () => {
    const paths = resolvePaths(makeHome());
    const o = Outbox.open(paths);
    for (const n of [1, 2, 3]) o.append('x', n);
    const untrimmed = fs.readFileSync(paths.outbox);
    o.ack(2);
    // a crash between writing acked and trimming the file
    fs.writeFileSync(paths.outbox, untrimmed);
    fs.rmSync(paths.epoch);
    const after = Outbox.open(paths);
    expect(after.epoch()).not.toBe(o.epoch());
    expect([after.acked(), ...seqs(after)]).toEqual([0, 3]);
    expect(seqs(Outbox.open(paths))).toEqual([3]);
  });

  it('a journal that lost acked or outbox.ndjson gets a new epoch with acked 0', () => {
    const paths = resolvePaths(makeHome());
    const fresh = Outbox.open(paths);
    expect([fs.readFileSync(paths.epoch, 'utf8').trim(), fs.readFileSync(paths.acked, 'utf8').trim(), fs.readFileSync(paths.outbox, 'utf8')]).toEqual([fresh.epoch(), '0', '']);
    fresh.append('x', 1);
    fresh.append('x', 2);
    fresh.ack(1);

    fs.rmSync(paths.acked);
    const noAcked = Outbox.open(paths);
    expect(noAcked.epoch()).not.toBe(fresh.epoch());
    expect([noAcked.acked(), ...seqs(noAcked)]).toEqual([0, 2]);
    expect(fs.readFileSync(paths.acked, 'utf8').trim()).toBe('0');

    fs.rmSync(paths.outbox);
    const noOutbox = Outbox.open(paths);
    expect(noOutbox.epoch()).not.toBe(noAcked.epoch());
    expect([noOutbox.acked(), noOutbox.last(), fs.readFileSync(paths.outbox, 'utf8')]).toEqual([0, 0, '']);

    // a journal without an epoch, as an older release leaves one, keeps its entries
    noOutbox.append('x', 3);
    fs.rmSync(paths.epoch);
    const noEpoch = Outbox.open(paths);
    expect(noEpoch.epoch()).not.toBe(noOutbox.epoch());
    expect([noEpoch.acked(), ...seqs(noEpoch)]).toEqual([0, 1]);
    expect(Outbox.open(paths).epoch()).toBe(noEpoch.epoch());
  });

  it("drops on open an entry an older build journaled past the link's line limit, saying so, and keeps the rest", () => {
    const paths = resolvePaths(makeHome());
    const first = Outbox.open(paths);
    first.append('robot.sync', { n: 1 });
    // as a build that journaled before it measured a frame
    const data = { note: 'x'.repeat(MAX_LINE) };
    fs.appendFileSync(paths.outbox, `${JSON.stringify({ seq: 2, kind: 'mutation', data })}\n`);
    const logged: string[] = [];
    const reopened = Outbox.open(paths, { error: (m) => logged.push(m) });
    expect([reopened.last(), ...seqs(reopened)]).toEqual([1, 1]);
    const bytes = Buffer.byteLength(JSON.stringify({ t: 'event', seq: 2, kind: 'mutation', data }));
    expect(logged).toEqual([`journal: entry 2 (mutation) is ${bytes} bytes, over the link's limit of ${MAX_LINE}; dropped`]);
    expect(fs.readFileSync(paths.outbox, 'utf8')).toBe(`${JSON.stringify({ seq: 1, kind: 'robot.sync', data: { n: 1 } })}\n`);
    expect(reopened.append('robot.sync', { n: 3 })).toBe(2);
  });

  it('keeps an older build\'s create past the line limit without its run text, as its robot still runs there', () => {
    const paths = resolvePaths(makeHome());
    Outbox.open(paths);
    const create = { id: 'mu_0000000001', method: 'robot.create', params: { islandId: 'i_1', cwd: '/w', run: 'x'.repeat(MAX_LINE) }, robot: { id: 'c_1' } };
    fs.appendFileSync(paths.outbox, `${JSON.stringify({ seq: 1, kind: 'mutation', data: create })}\n`);
    const logged: string[] = [];
    const reopened = Outbox.open(paths, { error: (m) => logged.push(m) });
    const { run: _, ...params } = create.params;
    expect(reopened.after(0)).toEqual([{ seq: 1, kind: 'mutation', data: { ...create, params } }]);
    expect(logged).toEqual([expect.stringMatching(/^journal: entry 1 \(mutation\) is \d+ bytes, over the link's limit of 2097152; kept without its run text$/)]);
    expect(Outbox.open(paths).after(0)).toEqual(reopened.after(0));
  });

  it('drops a last line a crash cut short, and the next append starts on a line of its own', () => {
    const paths = resolvePaths(makeHome());
    Outbox.open(paths).append('robot.sync', { n: 1 });
    fs.appendFileSync(paths.outbox, '{"seq":2,"kind":"rob');

    const after = Outbox.open(paths);
    expect(after.last()).toBe(1);
    expect(after.append('robot.sync', { n: 2 })).toBe(2);
    expect(Outbox.open(paths).after(0)).toEqual([{ seq: 1, kind: 'robot.sync', data: { n: 1 } }, { seq: 2, kind: 'robot.sync', data: { n: 2 } }]);
  });
});
