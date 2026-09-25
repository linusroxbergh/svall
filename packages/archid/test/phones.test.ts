import { describe, expect, it, vi } from 'vitest';
import { Phones } from '../src/phones.js';

describe('Phones', () => {
  it('holds a socket until it leaves', () => {
    const phones = new Phones();
    expect(phones.list()).toEqual([]);
    const leave = phones.add('me@example.com');
    expect(phones.list()).toEqual([{ login: 'me@example.com', since: expect.any(Number) }]);
    leave();
    expect(phones.list()).toEqual([]);
  });

  it('names a login once, from the moment its first socket arrived', () => {
    vi.useFakeTimers();
    try {
      const phones = new Phones();
      vi.setSystemTime(new Date('2026-09-19T14:02:00Z'));
      const first = phones.add('me@example.com');
      vi.setSystemTime(new Date('2026-09-19T14:30:00Z'));
      const second = phones.add('me@example.com');
      expect(phones.list()).toEqual([{ login: 'me@example.com', since: Date.parse('2026-09-19T14:02:00Z') }]);
      // the tab that arrived first is gone, and the login is still here on the one that stayed
      first();
      expect(phones.list()).toEqual([{ login: 'me@example.com', since: Date.parse('2026-09-19T14:30:00Z') }]);
      second();
      expect(phones.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the logins in the order they arrived', () => {
    const phones = new Phones();
    phones.add('second@example.com');
    phones.add('first@example.com');
    expect(phones.list().map((p) => p.login)).toEqual(['second@example.com', 'first@example.com']);
  });

  it('tells a watcher on every arrival and departure, until it stops watching', () => {
    const phones = new Phones();
    const seen: number[] = [];
    const stop = phones.onChange((list) => seen.push(list.length));
    const leave = phones.add('me@example.com');
    leave();
    stop();
    phones.add('me@example.com');
    expect(seen).toEqual([1, 0]);
  });
});
