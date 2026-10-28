import crypto from 'node:crypto';
import { FleetId, type Agent, type Robot } from '@svall/protocol';
import { ProcessTable, type Proc } from '../../src/processes.js';
import { RestJournal, type Clock, type RestDeps } from '../../src/placement/rest.js';
import { installedScripts, resolvePaths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import type { LiveWindow } from '../../src/tmux/tmux.js';
import { makeHome } from '../helpers.js';

export const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
export const SID2 = '7a1d2e3f-4b5c-4d6e-8f70-81a2b3c4d5e6';
export const OSID = 'ses_eeda388f0ffeOB6E6MBZswShKL';
export const OC_SERVER = '/Users/ada/.opencode/bin/opencode serve --stdio --port 0';
export const fleetId = FleetId.parse(crypto.randomUUID());

export const win = (n: number) => ({ windowId: `@${n}`, paneId: `%${n}` });
export const agent = (kind: Agent['kind'], status: Agent['status'], sessionId = SID, prompt?: string): Agent =>
  ({ kind, sessionId, transcriptPath: `/t/${sessionId}.jsonl`, status, lastActivityAt: 0, ...(prompt && { prompt }) });
export const robot = (id: string, over: Partial<Robot> = {}): Robot => ({
  id, islandId: 'i_1', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd: `/work/${id}`, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

// a terminal as tmux and ps show it: a shell at its prompt unless a job holds it; the agent's tools run off the
// terminal and its MCP servers on it, each in a group of its own that outlives the job unless signalled
type Pane = {
  windowId: string; paneId: string; pid: number; path: string; job?: string[]; tools?: string[]; servers?: string[];
  ignoresTerm?: boolean; unkillable?: boolean; stubbornTools?: boolean;
  // servers that outlive the job unless their own group is signalled; the ones named here ignore SIGTERM
  lingeringServers?: boolean; stubbornServers?: string[];
  // an OpenCode TUI's private server, off the terminal, which runs the tools and Svall's plugin; it exits with the
  // job, or that long after the window closes
  server?: string; serverLingersMs?: number;
  // what a lingering server starts after its window closed, in a group of its own
  lateChild?: string;
  // a job ctrl+z stopped on the terminal, in a group of its own, which takes a SIGTERM only once continued
  stopped?: string; stoppedTerm?: boolean;
};

export class World {
  panes = new Map<string, Pane>();
  log: string[] = [];
  now = 0;
  reads = 0;
  hangPs = false;
  psSignals: (AbortSignal | undefined)[] = [];
  hangKill = new Set<string>();
  // processes a closed window left running until `until`
  orphans: { row: Proc; until: number }[] = [];
  // orphans SIGKILL does not end, as a process stuck in the kernel: every one, or those running these command lines
  stuck: boolean | string[] = false;
  // windows a kill leaves open without a word, as tmux's kill-window failing does
  keepOnKill = new Set<string>();
  onSignal?: () => void;
  onKill?: () => void;
  private sleepers: { at: number; wake: () => void }[] = [];

  pane(n: number, over: Partial<Pane> = {}): Pane {
    const p = { ...win(n), pid: n * 1000, path: `/pane/${n}`, ...over };
    this.panes.set(p.windowId, p);
    return p;
  }

  clock: Clock = {
    now: () => this.now,
    sleep: (ms, signal) => new Promise((wake) => {
      const s = { at: this.now + ms, wake };
      this.sleepers.push(s);
      signal?.addEventListener('abort', () => { this.sleepers = this.sleepers.filter((x) => x !== s); });
    }),
  };

  // timers still set: resting clears each one once whatever it raced has settled
  timers(): number {
    return this.sleepers.length;
  }

  tmux: RestDeps['tmux'] = {
    listWindows: async (): Promise<LiveWindow[]> => [...this.panes.values()].map((p) => ({
      windowId: p.windowId, paneId: p.paneId, panePid: p.pid, name: '', command: '', path: p.path, activity: 0, dead: false,
    })),
    sendBytes: async (paneId, bytes) => { this.log.push(`keys ${paneId} ${bytes.toString('hex')}`); },
    killWindow: async (windowId) => {
      this.onKill?.();
      this.log.push(`kill ${windowId}`);
      if (this.hangKill.has(windowId)) await new Promise(() => {});
      const p = this.panes.get(windowId);
      if (p?.server && p.serverLingersMs) {
        this.orphans.push({ row: { pid: p.pid + 60, ppid: 1, pgid: p.pid + 60, tpgid: 0, stat: 'Ss', args: p.server }, until: this.now + p.serverLingersMs });
        if (p.lateChild) this.orphans.push({ row: { pid: p.pid + 80, ppid: p.pid + 60, pgid: p.pid + 80, tpgid: 0, stat: 'Ss', args: p.lateChild }, until: Infinity });
      }
      if (!this.keepOnKill.has(windowId)) this.panes.delete(windowId);
    },
  };

  viewers: RestDeps['viewers'] = { detach: async (id) => { this.log.push(`detach ${id}`); } };

  processes = async (signal?: AbortSignal): Promise<ProcessTable> => {
    this.reads++;
    this.psSignals.push(signal);
    if (this.hangPs) await new Promise(() => {});
    return new ProcessTable(this.rows(), installedScripts('/Users/ada/.svall'));
  };

  kill = (group: number, signal: NodeJS.Signals): void => {
    this.onSignal?.();
    this.log.push(`${signal} ${group}`);
    this.orphans = this.orphans.filter((o) => o.row.pgid !== group || this.stuck === true || (Array.isArray(this.stuck) && this.stuck.includes(o.row.args)));
    for (const p of this.panes.values()) {
      if (p.job && p.pid + 1 === group && !p.unkillable && (signal === 'SIGKILL' || !p.ignoresTerm)) {
        delete p.job;
        delete p.server;
        if (!p.lingeringServers) delete p.servers;
      }
      const tool = group - p.pid - 50;
      if (p.tools?.[tool] !== undefined && (signal === 'SIGKILL' || !p.stubbornTools)) p.tools = p.tools.filter((_, i) => i !== tool);
      const server = group - p.pid - 70;
      const named = p.servers?.[server];
      // an ended server keeps its place, so the ones after it keep their groups
      if (named && (signal === 'SIGKILL' || !p.stubbornServers?.includes(named))) p.servers![server] = '';
      if (p.stopped && p.pid + 90 === group) {
        p.stoppedTerm ||= signal === 'SIGTERM';
        if (signal === 'SIGKILL' || (signal === 'SIGCONT' && p.stoppedTerm)) delete p.stopped;
      }
    }
  };

  private rows(): Proc[] {
    return [...this.panes.values()].flatMap((p) => {
      const group = p.job ? p.pid + 1 : p.pid;
      const shell = { pid: p.pid, ppid: 1, pgid: p.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
      const job = (p.job ?? []).map((args, i) => ({ pid: group + i, ppid: i ? group + i - 1 : p.pid, pgid: group, tpgid: group, stat: 'S+', args }));
      const under = group + (p.job?.length ?? 1) - 1;
      const own = p.job && p.server ? [
        { pid: p.pid + 60, ppid: under, pgid: p.pid + 60, tpgid: 0, stat: 'Ss', args: p.server },
        { pid: p.pid + 61, ppid: p.pid + 60, pgid: p.pid + 60, tpgid: 0, stat: 'S', args: `ps -o args= -p ${under}` },
      ] : [];
      const toolsUnder = own.length ? p.pid + 60 : under;
      const tools = (p.tools ?? []).map((args, i) => ({ pid: p.pid + 50 + i, ppid: toolsUnder, pgid: p.pid + 50 + i, tpgid: 0, stat: 'Ss', args }));
      const servers = (p.servers ?? []).flatMap((args, i) => (args ? [{ pid: p.pid + 70 + i, ppid: under, pgid: p.pid + 70 + i, tpgid: group, stat: 'S', args }] : []));
      const stopped = p.stopped ? [{ pid: p.pid + 90, ppid: p.pid, pgid: p.pid + 90, tpgid: group, stat: 'T', args: p.stopped }] : [];
      return [shell, ...job, ...own, ...tools, ...servers, ...stopped];
    }).concat(this.orphans.filter((o) => this.now < o.until).map((o) => o.row));
  }

  // lets the resting loop run until it waits again
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }

  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = this.sleepers.filter((s) => s.at <= this.now);
    this.sleepers = this.sleepers.filter((s) => s.at > this.now);
    for (const s of due) s.wake();
    await this.settle();
  }
}

// the rest's journal, held as a move holds it in its own
export const restJournal = (): RestDeps['journal'] => {
  let j = RestJournal.parse({});
  return { read: () => j, write: (next) => { j = next; } };
};

export function boot(robots: Robot[]) {
  const paths = resolvePaths(makeHome());
  const store = Store.load(paths.state, () => {});
  store.update((d) => { for (const c of robots) d.robots[c.id] = c; });
  const world = new World();
  const deps: RestDeps = {
    store, tmux: world.tmux, viewers: world.viewers, journal: restJournal(), processes: world.processes, kill: world.kill, clock: world.clock, bootId: () => 'boot-1',
  };
  return { store, world, deps, paths };
}
