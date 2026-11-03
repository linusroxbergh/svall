import crypto from 'node:crypto';
import { RELAY_LIMIT, isRobotSaid, reportBegan, robotNotice, type FleetState, type Robot } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';

// sent: the line went in; retry: the terminal or session it waited for went away first
export type Notify = (id: string, text: string) => Promise<'sent' | 'retry'>;

// what a report's request ended on, or undefined while it runs on
function ending(c: Robot): string | undefined {
  const a = c.agent;
  if (!a || !c.tmux) return 'stopped: its agent exited';
  if (a.status === 'done') return a.prompt ? `stopped on an API error: ${a.prompt}` : `is done; full answer: svall robot read ${c.id} --last`;
  if (a.status === 'idle') return 'stopped: its turn was interrupted';
  return undefined;
}

const owe = (d: FleetState, to: string, c: Robot, rest: string, end?: true): void => {
  (d.robots[to].inbox ??= []).push({ from: c.id, text: robotNotice(c, rest), ...(end && { end }) });
};

/** One more robot message typed into `c`, counted from the user's newest prompt. */
export function countRelayed(c: Robot): void {
  const p = c.agent?.lastPrompt;
  const user = p && !isRobotSaid(p.text) ? p.id : undefined;
  const r = c.relayed && (!user || user === c.relayed.user) ? c.relayed : { n: 0, ...(user && { user }) };
  c.relayed = { ...r, n: r.n + 1 };
}

/** Whether the next robot message to `c` waits on the user, holding it there once it does. */
export function holdRelayed(c: Robot): boolean {
  if (!c.relayed || (!c.relayed.held && c.relayed.n < RELAY_LIMIT)) return false;
  c.relayed.held ??= crypto.randomUUID();
  return true;
}

/** Drops the lines robot `c` was owed; a finish one of them told of goes to the user as an unread one, where that robot runs `here`. */
export function dropInbox(d: FleetState, c: Robot, here: (c: Robot) => boolean, log: Logger): void {
  for (const m of c.inbox ?? []) {
    const from = Object.hasOwn(d.robots, m.from) ? d.robots[m.from] : undefined;
    if (!m.end || from?.agent?.status !== 'done' || from.unread) continue;
    if (here(from)) from.unread = true;
    else log.info(`${from.name}'s finish was told to ${c.name}, which can't take it, and its machine keeps it seen`);
  }
  delete c.inbox;
  if (c.relayed) delete c.relayed.held;
}

// what no later look changes: the robot is gone, or its terminal can't take a line; a dormant one comes back
const lasting = (e: unknown): boolean => ['invalid', 'not_found'].includes((e as { code?: unknown }).code as string);

/**
 * Keeps the reports robots are owed on the robots they asked: a line when it turns blocked, and one when its request ends,
 * done, closed, its agent gone, interrupted or on an API error. Each robot's lines go in one at a time through `notify`, while
 * the robot takes robot messages. The returned function stops it.
 */
export function startRelay(o: { store: Store; notify: Notify; log: Logger; here: (c: Robot) => boolean }): () => void {
  let before = o.store.state;
  // the robots a line is on its way to
  const sending = new Set<string>();
  let queued = false;
  let stopped = false;

  const step = (d: FleetState, c: Robot): void => {
    const p = c.agent?.lastPrompt;
    // a prompt of the user's lets robot messages in afresh
    if (c.relayed && p && !isRobotSaid(p.text) && p.id !== c.relayed.user) delete c.relayed;
    const r = c.report;
    if (!r || c.moving) return;
    if (!Object.hasOwn(d.robots, r.to)) { delete c.report; return; }
    if (!r.prompt) {
      if (!p || !reportBegan(c)) return;
      r.prompt = p.id;
    }
    // a quit mid-turn resumes the session with a note as its prompt, which carries the request on
    if (!c.tmux && c.revive?.interrupted) { r.resumed = true; return; }
    if (r.resumed) {
      if (!p || p.id === r.prompt) return;
      r.prompt = p.id;
      delete r.resumed;
    }
    const a = c.agent;
    if (a?.status !== 'blocked' || !c.tmux) delete r.asked;
    else if (!r.asked) {
      r.asked = true;
      owe(d, r.to, c, `is blocked${a.prompt ? `: ${a.prompt}` : ''}`);
    }
    const end = ending(c);
    if (end) { owe(d, r.to, c, end, true); delete c.report; }
  };

  const drain = (id: string): void => {
    const to = o.store.state.robots[id];
    const m = to?.inbox?.[0];
    if (!m || sending.has(id)) return;
    if (!to.agent && !to.revive) {
      o.log.info(`${to.inbox!.length} line(s) for ${to.name} dropped: it runs no agent`);
      o.store.update((d) => dropInbox(d, d.robots[id], o.here, o.log));
      return;
    }
    if (to.relayed?.held || (to.relayed?.n ?? 0) >= RELAY_LIMIT) {
      if (!to.relayed?.held) o.store.update((d) => { holdRelayed(d.robots[id]); });
      return;
    }
    sending.add(id);
    Promise.resolve().then(() => o.notify(id, m.text)).then((r) => {
      if (r === 'retry') return true;
      o.store.update((d) => {
        const c = Object.hasOwn(d.robots, id) ? d.robots[id] : undefined;
        if (c?.inbox?.[0]?.text !== m.text || c.inbox[0].from !== m.from) return;
        c.inbox.shift();
        if (!c.inbox.length) delete c.inbox;
        countRelayed(c);
      });
      return true;
    }, (e: Error) => {
      // a robot waiting on an answer, moving or out of reach takes its line once that changes
      if (!lasting(e)) return false;
      o.log.error(`lines for ${id} dropped: ${e.message}`);
      o.store.update((d) => { if (Object.hasOwn(d.robots, id)) dropInbox(d, d.robots[id], o.here, o.log); });
      return true;
    }).catch((e: unknown) => { o.log.error(`line for ${id}: ${String(e)}`); return false; })
      .finally(() => sending.delete(id)).then((again) => { if (again) look(); });
  };

  const pass = (): void => {
    queued = false;
    if (stopped) return;
    const f = o.store.state;
    const gone = Object.values(before.robots).filter((c) => !Object.hasOwn(f.robots, c.id));
    try {
      o.store.update((d) => {
        for (const c of gone) {
          if (c.report && Object.hasOwn(d.robots, c.report.to)) owe(d, c.report.to, c, 'was closed', true);
          dropInbox(d, structuredClone(c), o.here, o.log);
        }
        for (const c of Object.values(d.robots)) step(d, c);
      });
    } catch (e) { o.log.error(`relay: ${String(e)}`); }
    before = o.store.state;
    for (const c of Object.values(before.robots)) if (c.inbox) drain(c.id);
  };

  const look = (): void => {
    if (queued || stopped) return;
    queued = true;
    setImmediate(pass);
  };
  const off = o.store.subscribe(look);
  look();
  return () => { stopped = true; off(); };
}
