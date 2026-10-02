import type { PhoneSession } from '@svall/protocol';

/** The phone sockets open right now: the serve mapping says the door is open, this says who came through it and when. */
export class Phones {
  private open: { login: string; since: number }[] = [];
  private watchers = new Set<(phones: PhoneSession[]) => void>();

  add(login: string): () => void {
    const socket = { login, since: Date.now() };
    this.open.push(socket);
    this.changed();
    return () => {
      const i = this.open.indexOf(socket);
      if (i === -1) return;
      this.open.splice(i, 1);
      this.changed();
    };
  }

  /** One row per login: a phone with two tabs is one phone, there since the tab that has been open longest. */
  list(): PhoneSession[] {
    const byLogin = new Map<string, PhoneSession>();
    for (const { login, since } of this.open) {
      const held = byLogin.get(login);
      if (held) held.since = Math.min(held.since, since);
      else byLogin.set(login, { login, since });
    }
    return [...byLogin.values()];
  }

  onChange(fn: (phones: PhoneSession[]) => void): () => void {
    this.watchers.add(fn);
    return () => { this.watchers.delete(fn); };
  }

  private changed(): void {
    const list = this.list();
    for (const fn of [...this.watchers]) fn(list);
  }
}
