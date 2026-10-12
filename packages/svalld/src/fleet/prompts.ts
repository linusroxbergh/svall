import type { Agent, AgentStatus, Delivery } from '@svall/protocol';
import { readComposer } from '../agent/composer.js';
import { settle } from '../agent/reducer.js';
import type { Config } from '../config.js';
import { isAgentCommand } from '../context/launch.js';
import { Blocked, Invalid } from '../errors.js';
import type { Fleet } from '../fleet.js';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import { isShellCommand, type Tmux } from '../tmux/tmux.js';

export type WaitResult = AgentStatus | 'timeout' | 'gone';

const STEP_MS = 1000;
// how often a held prompt looks again at its agent's prompt line
const HOLD_MS = 1000;

type Deps = { fleet: Fleet; store: Store; tmux: Tmux; config: Config; log: Logger; reviving: ReadonlyMap<string, unknown>; writable: () => boolean };
// the pane and the agent session a prompt was sent to, which alone may take it
type Held = { text: string; enter: boolean; paneId: string; sessionId: string };

const laneOf = (id: string, term?: 2) => (term === 2 ? `${id}/2` : id);

/** What is typed into a character's terminals, the answers to its agent's questions, and waits on that agent. */
export class Prompts {
  // the question each character's answer is being typed for, so a second answer to it is refused rather than typed too
  private answering = new Map<string, string | undefined>();
  // the prompts each terminal holds until its agent's prompt line is free, oldest first
  private held = new Map<string, Held[]>();
  // one send at a time per terminal, so no paste lands between a look at the prompt line and the paste it allowed
  private lanes = new Map<string, Promise<unknown>>();
  // the waits under way, which look again when a terminal's held prompts run out, as no change to the fleet says so
  private waiters = new Set<() => void>();

  constructor(private deps: Deps) {}

  // Text goes into an agent's prompt line only while it shows empty: a draft or a dialog the agent did not report holds it,
  // a question it reported refuses it. Each agent queues a prompt sent mid-turn itself. Keys typed into the terminal pass no gate
  async run(id: string, text: string, enter: boolean, term?: 2): Promise<Delivery> {
    const { fleet } = this.deps;
    const c = fleet.char(id);
    // a dormant agent wakes with the text as its launch prompt; typed while it boots, a prompt can lose its Enter.
    // A window still alive takes it as a send of its own
    if (!term && enter && !c.tmux && !this.deps.reviving.has(id) && isAgentCommand(c.revive?.command ?? '')) {
      return (await fleet.reviveCharacter(id, text)).delivery ?? 'delivered';
    }
    const lane = laneOf(id, term);
    return this.inLane(lane, async () => {
      const t = fleet.terminal(id, term);
      // a shell takes the text as it comes
      if (!t.agent) {
        await this.send(id, text, enter, term);
        return 'delivered';
      }
      const free = await this.free(c.name, id, term, t.tmux.paneId);
      if (free && !this.held.has(lane) && this.deps.writable()) {
        await this.send(id, text, enter, term);
        return 'delivered';
      }
      this.hold(lane, id, term, { text, enter, paneId: t.tmux.paneId, sessionId: t.agent.sessionId });
      return 'queued';
    });
  }

  // whether the agent's prompt line is in view and empty; throws while the agent waits on an answer, which a paste could give.
  // The agent is looked at again once the screen is in, as a hook may have come while it was read
  private async free(name: string, id: string, term: 2 | undefined, paneId: string): Promise<boolean> {
    const live = () => (term === 2 ? this.deps.store.state.characters[id]?.second : this.deps.store.state.characters[id]);
    const asked = (a?: Agent) => {
      if (a?.status === 'blocked') throw new Blocked(`${name} is waiting on an answer${a.prompt ? ` (${a.prompt})` : ''}; answer it, then send again`);
    };
    asked(live()?.agent);
    const screen = await this.deps.tmux.screen(paneId);
    const t = live();
    if (!t?.agent || t.tmux?.paneId !== paneId) return false;
    const a = t.agent;
    asked(a);
    // the agent has not started yet, or has exited
    if (isShellCommand(screen.command, this.deps.config.shell)) return false;
    const composer = readComposer(a.kind, screen);
    // Claude Code notifies of its dialog seconds after it shows it; a tool asked about with no prompt line in view is that
    // dialog, which until then only its terminal can answer
    if (composer === 'hidden' && a.kind === 'claude' && a.askedTool) {
      throw new Blocked(`${name} is waiting on an answer (${a.askedTool}); answer it in its terminal, then send again`);
    }
    return composer === 'empty';
  }

  private hold(lane: string, id: string, term: 2 | undefined, p: Held): void {
    const queue = this.held.get(lane);
    if (queue) { queue.push(p); return; }
    const mine = [p];
    this.held.set(lane, mine);
    const look = (): void => {
      this.inLane(lane, () => this.deliverHeld(lane, id, term))
        .catch((e) => this.deps.log.error(`held prompt ${id}: ${String(e)}`))
        .finally(() => { if (this.held.get(lane) === mine) setTimeout(look, HOLD_MS).unref(); });
    };
    setTimeout(look, HOLD_MS).unref();
  }

  // the oldest held prompt goes in once the agent is between turns with its prompt line free, so a wait takes the end of its
  // turn, not the user's; a frozen fleet keeps them, and a pane or agent session other than the one they were sent to drops them all
  private async deliverHeld(lane: string, id: string, term?: 2): Promise<void> {
    const queue = this.held.get(lane);
    if (!queue || !this.deps.writable()) return;
    const c = this.deps.store.state.characters[id];
    const t = term === 2 ? c?.second : c;
    if (!c || !t?.tmux || !t.agent || t.tmux.paneId !== queue[0].paneId || t.agent.sessionId !== queue[0].sessionId) {
      this.deps.log.info(`${queue.length} held prompt(s) for ${id} dropped: the terminal or its agent they were sent to is gone`);
      this.drop(lane);
      return;
    }
    if (t.agent.status === 'working') return;
    const free = await this.free(c.name, id, term, t.tmux.paneId).catch((e: unknown) => { if (e instanceof Blocked) return false; throw e; });
    if (!free || !this.deps.writable()) return;
    await this.send(id, queue[0].text, queue[0].enter, term);
    queue.shift();
    if (!queue.length) this.drop(lane);
  }

  private drop(lane: string): void {
    this.held.delete(lane);
    for (const look of this.waiters) look();
  }

  private inLane<T>(lane: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(lane) ?? Promise.resolve()).then(fn);
    const done = run.catch(() => {});
    this.lanes.set(lane, done);
    void done.then(() => { if (this.lanes.get(lane) === done) this.lanes.delete(lane); });
    return run;
  }

  private async send(id: string, text: string, enter: boolean, term?: 2): Promise<void> {
    const t = this.deps.fleet.terminal(id, term);
    const before = t.agent?.status;
    const asked = t.agent?.promptId;
    const heard = t.agent?.lastActivityAt;
    await this.deps.tmux.sendLine(t.tmux.paneId, text, enter);
    // a submitted prompt makes the agent busy right away; the UserPromptSubmit hook only confirms it.
    // A hook heard while the send was in flight wins, unread included: the turn may have begun, or begun and ended.
    if (enter && t.agent) {
      this.deps.store.update((d) => {
        const slot = term === 2 ? d.characters[id]?.second : d.characters[id];
        const a = slot?.agent;
        if (!slot || !a || a.status !== before || a.promptId !== asked || a.lastActivityAt !== heard) return;
        settle(a, 'working');
        slot.unread = false;
      });
    }
  }

  async answer(id: string, answer: 'approve' | 'deny', promptId?: string): Promise<void> {
    const c = this.deps.fleet.live(id);
    const asked = c.agent?.promptId;
    if (c.agent?.status !== 'blocked') throw new Invalid(`${c.name} is not waiting on an answer`);
    if (promptId !== undefined && promptId !== asked) throw new Invalid(`${c.name} has moved on from that question`);
    if (this.answering.has(id) && this.answering.get(id) === asked) throw new Invalid(`${c.name}'s answer is already in`);
    this.answering.set(id, asked);
    // an answer to a newer question may have been typed meanwhile; its hold stays
    const release = () => { if (this.answering.get(id) === asked) this.answering.delete(id); };
    try { await this.deps.tmux.sendBytes(c.tmux.paneId, Buffer.from(answer === 'approve' ? '\r' : '\x1b')); }
    catch (e) { release(); throw e; }
    // OpenCode's plugin reports each answer, and a key may only open a further step, as Esc on a subagent's question
    // does; the hold stays until the plugin moves the card on. Enter may only move a question on to its next part,
    // which takes an Enter of its own once the plugin has had time to report an answer
    if (c.agent.kind === 'opencode') {
      if (answer === 'approve') setTimeout(release, STEP_MS).unref();
      return;
    }
    release();
    this.settleAnswer(id, asked, answer);
  }

  // Enter typed into the terminal takes the question's highlighted option and Esc or ^C turns it down, as the
  // keys `answer` sends do; only the keys a viewer sends through the daemon are seen here
  typed(id: string, data: Buffer, asked: string | undefined): void {
    const key = data.toString('latin1');
    const answer = key === '\r' ? 'approve' : key === '\x1b' || key === '\x03' ? 'deny' : undefined;
    if (answer && asked) this.settleAnswer(id, asked, answer);
  }

  waitFor(id: string, until: AgentStatus[], timeoutMs: number, signal?: AbortSignal, term?: 2): Promise<WaitResult> {
    return this.until<WaitResult>(() => {
      const c = this.deps.store.state.characters[id];
      const t = term === 2 ? c?.second : c;
      // a terminal whose tmux window died will never reach the awaited status.
      if (!t?.tmux) return 'gone';
      // the turn of a prompt still held has not begun, so the end of the turn before it does not count
      const ended = t.agent?.status === 'done' || t.agent?.status === 'idle';
      if (t.agent && until.includes(t.agent.status) && !(ended && this.held.has(laneOf(id, term)))) return t.agent.status;
      return undefined;
    }, timeoutMs, 'timeout', signal);
  }

  // true once the SessionStart hook has attached an agent; false when the window dies or the wait runs out
  waitForAgent(id: string, timeoutMs: number): Promise<boolean> {
    return this.until(() => {
      const c = this.deps.store.state.characters[id];
      if (!c || !c.tmux) return false;
      return c.agent ? true : undefined;
    }, timeoutMs, false);
  }

  holds(id: string): boolean {
    return this.held.has(laneOf(id)) || this.held.has(laneOf(id, 2));
  }

  forget(id: string): void {
    this.answering.delete(id);
    this.held.delete(laneOf(id));
    this.held.delete(laneOf(id, 2));
  }

  stop(): void {
    this.held.clear();
  }

  // Claude Code fires no hook when Esc ends the turn, though Esc on a question asked while background agents
  // run ends no turn; a hook that moved the agent on while the key was sent wins
  private settleAnswer(id: string, asked: string | undefined, answer: 'approve' | 'deny'): void {
    this.deps.store.update((d) => {
      const a = d.characters[id]?.agent;
      if (a?.status !== 'blocked' || a.promptId !== asked || a.kind === 'opencode') return;
      a.status = answer === 'approve' || a.background ? 'working' : 'idle';
      delete a.prompt;
      delete a.promptId;
    });
  }

  // the first answer `check` gives, now or after a change to the fleet; `timedOut` once the wait runs out
  private until<T>(check: () => T | undefined, timeoutMs: number, timedOut: T, signal?: AbortSignal): Promise<T> {
    const now = check();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => { unsub(); this.waiters.delete(look); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
      const onAbort = () => finish(() => reject(new Error('wait cancelled')));
      const look = () => { const r = check(); if (r !== undefined) finish(() => resolve(r)); };
      const unsub = this.deps.store.subscribe(look);
      this.waiters.add(look);
      const timer = setTimeout(() => finish(() => resolve(timedOut)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
