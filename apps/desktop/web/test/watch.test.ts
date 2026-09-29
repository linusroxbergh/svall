import { describe, expect, it } from 'vitest';
import { createRepoWatch } from '../src/ide/watch.js';

describe('repo watch', () => {
  it('asks svalld once per character while anyone listens, and again after a reconnect', () => {
    const fired: [string, unknown][] = [];
    const w = createRepoWatch({ fire: (m, p) => { fired.push([m, p]); } });
    const stopA = w.watch('c1');
    const stopB = w.watch('c1');
    expect(fired).toEqual([['repo.watch', { id: 'c1' }]]);
    stopA();
    expect(fired.length).toBe(1);
    // what happened while svalld was away is unknown, so a reconnect counts as a change
    let heard = 0;
    const off = w.on('c1', () => { heard += 1; });
    w.resend();
    expect(fired).toEqual([['repo.watch', { id: 'c1' }], ['repo.watch', { id: 'c1' }]]);
    expect(heard).toBe(1);
    off();
    stopB();
    expect(fired.at(-1)).toEqual(['repo.unwatch', { id: 'c1' }]);
    w.resend();
    expect(fired.length).toBe(3);
  });

  it('hands a change to the listeners of that character only', () => {
    const w = createRepoWatch({ fire: () => {} });
    const seen: string[] = [];
    const off = w.on('c1', () => seen.push('c1'));
    w.on('c2', () => seen.push('c2'));
    w.emit('c1');
    off();
    w.emit('c1');
    w.emit('c2');
    expect(seen).toEqual(['c1', 'c2']);
  });
});
