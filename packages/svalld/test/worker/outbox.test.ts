import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
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
  });

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
