import type { PhoneSession } from '@svall/protocol';

type Socket = { login: string; since: number; viewing?: string };

/** The phone sockets open right now: the serve mapping says the door is open, this says who came through it and when. */
export class Phones {
  private open: Socket[] = [];
  private watchers = new Set<(phones: PhoneSession[]) => void>();

  /** A socket from `login` until it leaves; `view` names the robot its page shows while in view, or none. */
  add(login: string): { leave(): void; view(robot: string | undefined): void } {
    const socket: Socket = { login, since: Date.now() };
    this.open.push(socket);
    this.changed();
    return {
      leave: () => {
        const i = this.open.indexOf(socket);
        if (i === -1) return;
        this.open.splice(i, 1);
        this.changed();
      },
      view: (robot) => { socket.viewing = robot; },
    };
  }

  /** Whether a page of `login` shows `robot` in view now. */
  viewing(login: string, robot: string): boolean {
    return this.open.some((s) => s.login === login && s.viewing === robot);
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
