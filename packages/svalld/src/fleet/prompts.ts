import type { AgentStatus } from '@svall/protocol';
import { settle } from '../agent/reducer.js';
import { isAgentCommand } from '../context/launch.js';
import { Invalid } from '../errors.js';
import type { Fleet } from '../fleet.js';
import type { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';

export type WaitResult = AgentStatus | 'timeout' | 'gone';

const STEP_MS = 1000;

type Deps = { fleet: Fleet; store: Store; tmux: Tmux; reviving: ReadonlyMap<string, unknown> };

/** What is typed into a character's terminals, the answers to its agent's questions, and waits on that agent. */
export class Prompts {
  // the question each character's answer is being typed for, so a second answer to it is refused rather than typed too
  private answering = new Map<string, string | undefined>();

  constructor(private deps: Deps) {}

  async run(id: string, text: string, enter: boolean, term?: 2): Promise<void> {
    const { fleet } = this.deps;
    const c = fleet.char(id);
    // a dormant agent wakes with the text as its launch prompt; typed while it boots, a prompt can lose its Enter
    if (!term && enter && !c.tmux && !this.deps.reviving.has(id) && isAgentCommand(c.revive?.command ?? '')) {
      await fleet.reviveCharacter(id, text);
      return;
    }
    const t = fleet.terminal(id, term);
    const before = t.agent?.status;
    const asked = t.agent?.promptId;
    await this.deps.tmux.sendLine(t.tmux.paneId, text, enter);
    // a submitted prompt makes the agent busy right away; the UserPromptSubmit hook only confirms it.
    // If a hook already moved the status, or put a new question, while the send was in flight, that wins, unread included.
    if (enter && t.agent) {
      this.deps.store.update((d) => {
        const slot = term === 2 ? d.characters[id]?.second : d.characters[id];
        const a = slot?.agent;
        if (!slot || !a || a.status !== before || a.promptId !== asked) return;
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
      if (t.agent && until.includes(t.agent.status)) return t.agent.status;
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

  forget(id: string): void {
    this.answering.delete(id);
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
      const finish = (fn: () => void) => { unsub(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
      const onAbort = () => finish(() => reject(new Error('wait cancelled')));
      const unsub = this.deps.store.subscribe(() => { const r = check(); if (r !== undefined) finish(() => resolve(r)); });
      const timer = setTimeout(() => finish(() => resolve(timedOut)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
