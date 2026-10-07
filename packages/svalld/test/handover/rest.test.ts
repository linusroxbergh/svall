import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetId, MachineId, emptyState, type Agent, type Character } from '@svall/protocol';
import { hookCommand, statusWrapper } from '../../src/agent-hooks.js';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { SourceJournal, openJournal } from '../../src/handover/journal.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import { armFailpoints } from '../../src/handover/failpoints.js';
import { classifyTerminals, restChoices, restTerminals, unapproved, type Clock, type RestDeps } from '../../src/handover/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { silentLogger } from '../../src/log.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { installedScripts, resolvePaths, type Paths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import { TerminalHub } from '../../src/terminals.js';
import { tmuxConfText } from '../../src/tmux/conf.js';
import { Tmux, type LiveWindow } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, idleSides, makeHome, waitFor } from '../helpers.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const SID2 = '7a1d2e3f-4b5c-4d6e-8f70-81a2b3c4d5e6';
const OSID = 'ses_eeda388f0ffeOB6E6MBZswShKL';
const OC_SERVER = '/Users/ada/.opencode/bin/opencode serve --stdio --port 0';
const fleetId = FleetId.parse(crypto.randomUUID());
const me = MachineId.parse(crypto.randomUUID());
const other = MachineId.parse(crypto.randomUUID());
const tx = { id: 'tx-1', fromMachineId: me, toMachineId: other, phase: 'preparing' as const, startedAt: 0 };

const win = (n: number) => ({ windowId: `@${n}`, paneId: `%${n}` });
const agent = (kind: Agent['kind'], status: Agent['status'], sessionId = SID, prompt?: string): Agent =>
  ({ kind, sessionId, transcriptPath: `/t/${sessionId}.jsonl`, status, lastActivityAt: 0, ...(prompt && { prompt }) });
const char = (id: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'i_1', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd: `/work/${id}`, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

// a terminal as tmux and ps show it: a shell at its prompt unless a job holds it. Under the job's last process, an
// agent's tool commands run off the terminal in groups of their own, outliving the job unless signalled, and its
// MCP servers stay on the terminal in groups of their own
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
};

class World {
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
      return [shell, ...job, ...own, ...tools, ...servers];
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

const journalOf = (paths: Paths): SourceJournal => {
  const s = openJournal(paths).load();
  if (s.kind !== 'open' || s.journal.role !== 'source') throw new Error(`no source journal: ${s.kind}`);
  return s.journal;
};

afterEach(cleanHomes);

function boot(characters: Character[]) {
  const paths = resolvePaths(makeHome());
  const store = Store.load(paths.state, () => {});
  store.update((d) => { for (const c of characters) d.characters[c.id] = c; });
  const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger });
  const handover = new HandoverService({ ownership, journal: openJournal(paths), ...idleSides(paths, { store }) });
  handover.write(SourceJournal.parse({
    role: 'source', transactionId: tx.id, generation: 0, fleetId, fromMachineId: me, toMachineId: other, phase: 'freeze', updatedAt: 0,
  }));
  const world = new World();
  const deps: RestDeps = {
    store, tmux: world.tmux, viewers: world.viewers, journal: handover, processes: world.processes, kill: world.kill, clock: world.clock, bootId: () => 'boot-1',
  };
  return { store, world, deps, paths, ownership };
}

describe('restTerminals', () => {
  it('rests idle agents and shells at their prompt, detaching viewers before a window closes, and leaves both slots dormant with resume commands', async () => {
    const { store, world, deps, paths } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'idle'), second: { cwd: '/side', unread: false, tmux: win(2) } }),
      char('c_bo', { tmux: win(3), agent: agent('codex', 'done', SID2) }),
    ]);
    world.pane(1, { job: [`claude --resume ${SID}`] });
    world.pane(2, { path: '/side/moved' });
    world.pane(3, { job: ['codex'] });
    let stoppedBeforeKill: unknown;
    world.onKill = () => { stoppedBeforeKill ??= journalOf(paths).stoppedTerminals; };

    const result = await restTerminals(deps, { choices: {} });

    expect(result).toEqual({
      ok: true,
      terminals: [
        { characterId: 'c_ada' },
        { characterId: 'c_ada', term: 2 },
        { characterId: 'c_bo' },
      ],
    });
    expect(world.log).toEqual(['detach c_ada', 'detach c_bo', 'kill @1', 'kill @2', 'kill @3']);
    const stopped = [{ characterId: 'c_ada' }, { characterId: 'c_ada', term: 2 }, { characterId: 'c_bo' }];
    expect(stoppedBeforeKill).toEqual(stopped);
    expect(journalOf(paths).stoppedTerminals).toEqual(stopped);
    const ada = store.state.characters.c_ada;
    expect(ada.tmux).toBeUndefined();
    expect(ada.cwd).toBe('/work/c_ada');
    expect(ada.revive).toEqual({ command: `claude --resume ${SID}` });
    // each terminal names the handover that closed it, which is what the destination opens again
    expect(ada.restedBy).toBe(tx.id);
    expect(ada.second).toEqual({ cwd: '/side/moved', unread: false, revive: { command: '' }, restedBy: tx.id });
    expect(store.state.characters.c_bo).toMatchObject({ revive: { command: `codex resume -c tui.resume_cwd=session ${SID2}` }, restedBy: tx.id });
    expect(world.timers()).toBe(0);
  });

  it('resumes each rested agent with the launch flags an idle close would keep, and one whose launch cannot be repeated without any', async () => {
    const SID3 = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    const { store, world, deps } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'idle'), second: { cwd: '/side', unread: false, tmux: win(2), agent: agent('codex', 'idle', SID2) } }),
      char('c_bo', { tmux: win(3), agent: agent('claude', 'done', SID3) }),
    ]);
    world.pane(1, { job: ['claude --dangerously-skip-permissions --model opus --effort high -- fix it'] });
    world.pane(2, { job: ['codex --yolo -m gpt-6-astra -p work'] });
    world.pane(3, { job: ['claude --settings /x/deny.json'] });

    expect((await restTerminals(deps, { choices: {} })).ok).toBe(true);

    const { c_ada: ada, c_bo: bo } = store.state.characters;
    expect(ada.revive).toEqual({ command: `claude --dangerously-skip-permissions --effort 'high' --resume ${SID}` });
    expect(ada.second?.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -p 'work' ${SID2}` });
    expect(bo.revive).toEqual({ command: `claude --resume ${SID3}` });
  });

  it('refuses a foreground job nobody chose to end at the recheck, before it interrupts, signals or closes anything', async () => {
    const { store, world, deps, paths } = boot([
      char('c_ada', { tmux: win(1) }),
      char('c_bo', { tmux: win(3), agent: agent('claude', 'working') }),
    ]);
    world.pane(1, { job: ['npm run dev', 'node vite'] });
    world.pane(3, { job: ['claude'] });
    const before = structuredClone(store.state);

    // were the recheck not first, the working agent would be interrupted at once
    const result = await restTerminals(deps, { choices: { interruptAfterMs: 0, terminate: [{ characterId: 'c_bo' }] } });

    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "ada's terminal is running npm run dev", entity: { kind: 'character', id: 'c_ada' } }],
    });
    expect(world.log).toEqual([]);
    expect(store.state).toEqual(before);
    expect(journalOf(paths).terminated).toEqual([]);
  });

  it('refuses a blocked agent unless the choices say it may be interrupted', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2), agent: agent('codex', 'blocked', SID2, 'Allow rm -rf build?') } })]);
    world.pane(1);
    world.pane(2, { job: ['codex'] });

    expect(await restTerminals(deps, { choices: { terminate: true } })).toEqual({
      ok: false,
      blockers: [{ code: 'agent_blocked', message: "ada's second terminal is waiting on an answer: Allow rm -rf build?", entity: { kind: 'character', id: 'c_ada' } }],
    });
    expect(world.log).toEqual([]);
  });

  it('waits on a working agent until its hook reports the turn over, and rests it on that event', async () => {
    const { store, world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, waitMs: 60_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(result).toBeUndefined();
    expect(world.log).toEqual([]);

    // the Stop hook lands while the fleet is frozen; no clock moves before the rest follows it
    store.update((d) => { d.characters.c_ada.agent!.status = 'done'; });
    await world.settle();
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it('reports an agent still working when the wait runs out, and never sends it Escape', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, waitMs: 2000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'agent_working', message: "ada's terminal is still working", entity: { kind: 'character', id: 'c_ada' } }],
    });
    expect(world.log).toEqual([]);
  });

  it('interrupts a working agent only once the chosen delay has passed, and rests it when the process tree shows its tool command ended', async () => {
    const { store, world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    const pane = world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 30_000 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(29_500);
    expect(world.log).toEqual([]);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b']);

    // Claude Code reports no hook for an interrupted turn; the tool command is still running
    await world.advance(500);
    expect(result).toBeUndefined();
    delete pane.tools;
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(world.log).toEqual(['keys %1 1b', 'detach c_ada', 'kill @1']);
    expect(store.state.characters.c_ada.revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('reports an interrupted agent that does not come to rest, and closes nothing', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'blocked') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 2000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(result).toEqual({
      ok: false,
      // the command that keeps it from settling is named, for the sheet to show
      blockers: [{ code: 'agent_unsettled', message: "ada's terminal did not come to rest after it was interrupted: /bin/zsh -c npm test still runs", entity: { kind: 'character', id: 'c_ada' } }],
    });
    expect(world.log).toEqual(['keys %1 1b']);
  });

  it('terminates an interrupted agent that will not settle when its terminal may be terminated, journaling it first and keeping the session it carries', async () => {
    const { store, world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let journaled: unknown;
    world.onSignal = () => { journaled = journalOf(paths).terminated; };
    let result: unknown;
    const run = restTerminals(deps, {
      choices: { interruptAfterMs: 0, terminate: [{ characterId: 'c_ada' }] }, pollMs: 500, settleMs: 1000,
    }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050']);
    expect(journaled).toEqual([{ characterId: 'c_ada', processes: ['claude', '/bin/zsh -c npm test'] }]);
    // the agent's SessionEnd hook arrives as it exits
    store.update((d) => { delete d.characters.c_ada.agent; });
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(store.state.characters.c_ada.agent?.sessionId).toBe(SID);
    expect(store.state.characters.c_ada.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(journalOf(paths).terminated).toEqual([{ characterId: 'c_ada', processes: ['claude', '/bin/zsh -c npm test'] }]);
  });

  it("ends the tool commands of a terminal it terminates too, journaled first, and follows SIGTERM with SIGKILL for one that ignores it", async () => {
    const { world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'], stubbornTools: true });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= journalOf(paths).terminated; };
    let result: unknown;
    const run = restTerminals(deps, {
      choices: { interruptAfterMs: 0, terminate: [{ characterId: 'c_ada' }] }, pollMs: 500, settleMs: 1000,
    }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050']);
    expect(journaled).toEqual([{ characterId: 'c_ada', processes: ['claude', '/bin/zsh -c npm run dev'] }]);
    // the agent is gone and its shell is back at the prompt, but the dev server it started still runs
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050', 'SIGKILL 1050']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
  });

  it("ends Codex's own-group helpers on the terminal with it when its terminal is terminated, and closes nothing until the last is gone", async () => {
    const { store, world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('codex', 'working') })]);
    const pane = world.pane(1, {
      job: ['codex'], tools: ['/bin/zsh -lc npm test'], servers: ['node_repl', '/opt/codex/bin/codex-code-mode-host'],
      lingeringServers: true, stubbornServers: ['/opt/codex/bin/codex-code-mode-host'],
    });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= journalOf(paths).terminated; };
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0, terminate: true }, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050', 'SIGTERM 1070', 'SIGTERM 1071']);
    expect(journaled).toEqual([{ characterId: 'c_ada', processes: ['codex', '/bin/zsh -lc npm test', 'node_repl', '/opt/codex/bin/codex-code-mode-host'] }]);
    // Codex and its tool are gone and the shell is back at its prompt, but its code-mode host still holds on
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log.slice(5)).toEqual(['SIGKILL 1071']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(pane.servers?.filter(Boolean)).toEqual([]);
    expect(world.log.slice(6)).toEqual(['detach c_ada', 'kill @1']);
    expect(store.state.characters.c_ada.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}` });
  });

  it('rests an idle agent still running commands in the background only by terminating it when chosen, and names those commands otherwise', async () => {
    const idle = () => boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'idle') })]);
    const kept = idle();
    kept.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });
    expect(await restTerminals(kept.deps, { choices: { interruptAfterMs: 0 } })).toEqual({
      ok: false,
      blockers: [{
        code: 'agent_unsettled', message: "ada's terminal is idle with work still running in the background: /bin/zsh -c npm run dev still runs",
        entity: { kind: 'character', id: 'c_ada' },
      }],
    });
    expect(kept.world.log).toEqual([]);

    const ended = idle();
    ended.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });
    let result: unknown;
    const run = restTerminals(ended.deps, { choices: { terminate: [{ characterId: 'c_ada' }] }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await ended.world.settle();
    await ended.world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(ended.world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1050', 'detach c_ada', 'kill @1']);
    expect(journalOf(ended.paths).terminated).toEqual([{ characterId: 'c_ada', processes: ['claude', '/bin/zsh -c npm run dev'] }]);
    expect(ended.store.state.characters.c_ada.revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('rests an idle OpenCode, its private server and Svall\'s plugin its own, and waits for that server to exit once its window closes', async () => {
    const { store, world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 300 });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 100, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
    // the session is dormant as soon as its window closes, but the server still holds its database
    expect(store.state.characters.c_ada.revive).toEqual({ command: `opencode -s ${OSID}` });
    await world.advance(200);
    expect(result).toBeUndefined();
    await world.advance(100);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it('kills a private OpenCode server that outlasts its closed window by the settle time, with what it runs, journaled first, and sees them gone', async () => {
    const { world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000, lateChild: 'node /mcp/server.js' });
    let stopped: unknown;
    world.onKill = () => { stopped ??= journalOf(paths).stoppedTerminals; };
    let journaled: unknown;
    world.onSignal = () => { journaled ??= journalOf(paths).serverKills; };
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060', 'SIGKILL 1080']);
    // the server is journaled with its terminal before the window closes, so a rest or an abort after a crash finds it
    expect(stopped).toEqual([{ characterId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-1' } }]);
    expect(journaled).toEqual([{
      characterId: 'c_ada', boot: 'boot-1', processes: [{ pid: 1060, pgid: 1060, args: OC_SERVER }, { pid: 1080, pgid: 1080, args: 'node /mcp/server.js' }],
    }]);
    expect(journalOf(paths).terminated).toEqual([]);
    expect(world.orphans).toEqual([]);
  });

  it('waits for, and kills, a private OpenCode server a rest that died left running once it rests again, before it answers', async () => {
    const { world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
    // the daemon dies as the wait for the server ends
    const disarm = armFailpoints((name, edge) => { if (name === 'source.rest.server.journal' && edge === 'before') throw new Error('crashed'); });
    let failed: unknown;
    const first = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => { failed = e.message; });
    await world.settle();
    for (let t = 0; t < 2; t++) await world.advance(500);
    await first;
    disarm();
    expect(failed).toBe('crashed');

    let result: unknown;
    const again = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await again;

    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060']);
    expect(journalOf(paths).serverKills).toEqual([{ characterId: 'c_ada', boot: 'boot-1', processes: [{ pid: 1060, pgid: 1060, args: OC_SERVER }] }]);
    expect(world.orphans).toEqual([]);
  });

  for (const [what, stopped] of [
    ['with the server it had before an abort reopened it', { characterId: 'c_ada', server: { pid: 5060, pgid: 5060, args: OC_SERVER, boot: 'boot-1' } }],
    ['with no server', { characterId: 'c_ada' }],
  ] as const) {
    it(`journals and waits for the live server of a terminal the journal already names ${what}`, async () => {
      const { world, deps, paths } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
      deps.journal.write({ ...journalOf(paths), stoppedTerminals: [stopped] });
      world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
      let result: unknown;
      const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

      await world.settle();
      await world.advance(500);
      expect(result).toBeUndefined();
      await world.advance(500);
      await run;

      expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
      expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060']);
      expect(journalOf(paths).stoppedTerminals).toEqual([{ characterId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-1' } }]);
    });
  }

  // a server and a kill journaled under boot-0, whose pids now run the same command lines
  const rebooted = () => {
    const b = boot([char('c_ada', { agent: agent('opencode', 'done', OSID), revive: { command: `opencode -s ${OSID}` } })]);
    b.deps.journal.write({
      ...journalOf(b.paths),
      stoppedTerminals: [{ characterId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-0' } }],
      serverKills: [{ characterId: 'c_ada', boot: 'boot-0', processes: [{ pid: 1080, pgid: 1080, args: 'node /mcp/server.js' }] }],
    });
    b.world.orphans.push(
      { row: { pid: 1060, ppid: 1, pgid: 1060, tpgid: 0, stat: 'Ss', args: OC_SERVER }, until: Infinity },
      { row: { pid: 1080, ppid: 1, pgid: 1080, tpgid: 0, stat: 'Ss', args: 'node /mcp/server.js' }, until: Infinity },
    );
    return b;
  };

  it('takes a server or a kill journaled under another boot of this machine for gone, though its pid now runs the same command line', async () => {
    const { world, deps } = rebooted();
    let result: unknown;
    void restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual([]);
  });

  it('matches a journaled server by its pid and command line alone when this boot cannot be read', async () => {
    const { world, deps } = rebooted();
    let result: unknown;
    const run = restTerminals({ ...deps, bootId: () => undefined }, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await run;
    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual(['SIGKILL 1060', 'SIGKILL 1080']);
  });

  it('takes a journaled server whose pid now runs another command for gone, signalling nothing', async () => {
    const { world, deps, paths } = boot([char('c_ada', { agent: agent('opencode', 'done', OSID), revive: { command: `opencode -s ${OSID}` } })]);
    deps.journal.write({ ...journalOf(paths), stoppedTerminals: [{ characterId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER } }] });
    world.orphans.push({ row: { pid: 1060, ppid: 1, pgid: 1060, tpgid: 0, stat: 'Ss', args: 'vim notes.md' }, until: Infinity });

    expect(await restTerminals(deps, { choices: {} })).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual([]);
  });

  it('kills again what the kill of a lingering server journaled and still runs when it rests again, and fails while any of it survives', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000, lateChild: 'node /mcp/server.js' });
    world.stuck = ['node /mcp/server.js'];
    const rest = async (advances: number): Promise<unknown> => {
      const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => e.message);
      await world.settle();
      for (let t = 0; t < advances; t++) await world.advance(500);
      return run;
    };

    expect(await rest(4)).toBe("ada's terminal: node /mcp/server.js still runs after SIGKILL");
    // the server is gone, so only the journal still leads to what it ran
    expect(await rest(2)).toBe("ada's terminal: node /mcp/server.js still runs after SIGKILL");
    expect(world.log.slice(2)).toEqual(['SIGKILL 1060', 'SIGKILL 1080', 'SIGKILL 1080']);
    world.stuck = false;
    expect(await rest(0)).toEqual({ ok: true, terminals: [] });
    expect(world.log.slice(5)).toEqual(['SIGKILL 1080']);
    expect(world.orphans).toEqual([]);
  });

  it('fails the rest when a private OpenCode server outlives its SIGKILL', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
    world.stuck = true;
    let failed: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => { failed = e.message; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;

    expect(failed).toMatch(/ada's terminal: .*serve --stdio.* still runs after SIGKILL/);
  });

  it("rests an idle OpenCode whose server still runs its MCP and language servers, which close with it", async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['node /mcp/server.js', 'typescript-language-server --stdio'] });
    expect(await restTerminals(deps, { choices: {} })).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it("refuses an idle OpenCode whose job outlived the shell command that started it, and ends it with its group when chosen", async () => {
    const idle = () => {
      const b = boot([char('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
      b.world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['sleep 300'] });
      // reparented, still in the group of the command the server runs
      b.world.orphans.push({ row: { pid: 1090, ppid: 1, pgid: 1050, tpgid: 0, stat: 'S', args: 'sleep 501' }, until: Infinity });
      return b;
    };
    const kept = idle();
    expect(await restTerminals(kept.deps, { choices: {} })).toEqual({
      ok: false,
      blockers: [{
        code: 'agent_unsettled', message: "ada's terminal is idle with work still running in the background: sleep 501 still runs",
        entity: { kind: 'character', id: 'c_ada' },
      }],
    });
    expect(kept.world.log).toEqual([]);

    const ended = idle();
    let result: unknown;
    const run = restTerminals(ended.deps, { choices: { terminate: true }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await ended.world.settle();
    await ended.world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(ended.world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1060', 'SIGTERM 1050', 'detach c_ada', 'kill @1']);
    expect(ended.world.orphans).toEqual([]);
    expect(ended.store.state.characters.c_ada.revive).toEqual({ command: `opencode -s ${OSID}` });
  });

  it('interrupts a working or blocked OpenCode with two Escapes sent 200 ms apart, and rests a working one only once its plugin reports the turn over, not when its command ends alone', async () => {
    const OSID2 = 'ses_0123456789abCDEFGHIJKLMNop';
    const { store, world, deps } = boot([
      char('c_ada', { tmux: win(1), agent: agent('opencode', 'working', OSID) }),
      char('c_bo', { tmux: win(3), agent: agent('opencode', 'blocked', OSID2, 'Allow rm -rf build?') }),
    ]);
    const pane = world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['sleep 300'] });
    world.pane(3, { job: [`opencode --standalone -s ${OSID2}`], server: OC_SERVER });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    // OpenCode interrupts only on a second Escape within 5 s, and reads two in one write as one
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(199);
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(1);
    expect(world.log).toEqual(['keys %1 1b', 'keys %1 1b', 'keys %3 1b']);
    await world.advance(200);
    expect(world.log).toEqual(['keys %1 1b', 'keys %1 1b', 'keys %3 1b', 'keys %3 1b']);
    // unlike Claude Code, OpenCode reports the interrupted turn, so a command gone alone does not settle it
    delete pane.tools;
    await world.advance(500);
    await world.advance(500);
    expect(result).toBeUndefined();
    store.update((d) => { d.characters.c_ada.agent!.status = 'idle'; });
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }, { characterId: 'c_bo' }] });
    expect(world.log.slice(4)).toEqual(['detach c_ada', 'detach c_bo', 'kill @1', 'kill @3']);
  });

  it('waits for an interrupt chosen for later than the wait would last, and interrupts then', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 3000 }, waitMs: 1000, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    for (let t = 500; t < 3000; t += 500) await world.advance(500);
    expect(result).toBeUndefined();
    expect(world.log).toEqual([]);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
  });

  it('ends a job only in the terminal the choice names, journaling it before the signal, and follows an ignored SIGTERM with SIGKILL', async () => {
    const { store, world, deps, paths } = boot([char('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2) } })]);
    world.pane(1);
    world.pane(2, { job: ['tail -f build.log'], ignoresTerm: true });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= journalOf(paths).terminated; };
    let result: unknown;
    const run = restTerminals(deps, { choices: { terminate: [{ characterId: 'c_ada', term: 2 }] }, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['SIGTERM 2001']);
    expect(journaled).toEqual([{ characterId: 'c_ada', term: 2, processes: ['tail -f build.log'] }]);
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log).toEqual(['SIGTERM 2001', 'SIGKILL 2001']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }, { characterId: 'c_ada', term: 2 }] });
    expect(world.log).toEqual(['SIGTERM 2001', 'SIGKILL 2001', 'detach c_ada', 'kill @1', 'kill @2']);
    expect(store.state.characters.c_ada.second?.revive).toEqual({ command: '' });
  });

  it('stops before closing anything when a shell at rest starts a job while an agent is still working', async () => {
    const { world, deps } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'working') }),
      char('c_bo', { tmux: win(3) }),
    ]);
    world.pane(1, { job: ['claude'] });
    const bo = world.pane(3);
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    bo.job = ['make release'];
    await world.advance(500);
    await run;

    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "bo's terminal is running make release", entity: { kind: 'character', id: 'c_bo' } }],
    });
    expect(world.log).toEqual([]);
  });

  it("confirms an interrupted Codex, standalone or behind npm's launcher, once its tool command ends though its MCP servers stay", async () => {
    const { store, world, deps } = boot([
      char('c_ada', { tmux: win(1), agent: agent('codex', 'working') }),
      char('c_bo', { tmux: win(3), agent: agent('codex', 'working', SID2) }),
    ]);
    const standalone = world.pane(1, {
      job: ['codex'], servers: ['node_repl', 'node /opt/homebrew/bin/adlc mcp-server', '/opt/codex/bin/codex-code-mode-host'], tools: ['/bin/zsh -lc npm test'],
    });
    const npm = world.pane(3, {
      job: ['node /usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex'],
      servers: ['node /home/ada/mcp/server.js'], tools: ['/bin/bash -lc cargo build'],
    });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['keys %1 1b', 'keys %3 1b']);
    await world.advance(500);
    expect(result).toBeUndefined();
    delete standalone.tools;
    await world.advance(500);
    // the command runs under the native Codex, a level below the launcher holding the terminal
    expect(result).toBeUndefined();
    delete npm.tools;
    await world.advance(500);
    await run;

    expect(result).toEqual({
      ok: true,
      terminals: [
        { characterId: 'c_ada' },
        { characterId: 'c_bo' },
      ],
    });
    expect(store.state.characters.c_bo.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID2}` });
  });

  it('reads a terminal whose agent record has gone stale by what holds it, and neither rests nor interrupts that job unasked', async () => {
    const { world, deps } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      char('c_bo', { tmux: win(3), agent: agent('codex', 'working', SID2) }),
    ]);
    world.pane(1, { job: ['npm run dev'] });
    world.pane(3, { job: ['vim notes.md'] });

    expect(await restTerminals(deps, { choices: { interruptAfterMs: 0 } })).toEqual({
      ok: false,
      blockers: [
        { code: 'shell_busy', message: "ada's terminal is running npm run dev", entity: { kind: 'character', id: 'c_ada' } },
        { code: 'shell_busy', message: "bo's terminal is running vim notes.md", entity: { kind: 'character', id: 'c_bo' } },
      ],
    });
    expect(world.log).toEqual([]);
  });

  it('reclassifies from state on a hook event, and reads the process tree again only before it acts', async () => {
    const { store, world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500 }).then((r) => { result = r; });

    await world.settle();
    expect(world.reads).toBe(1);
    for (let pct = 10; pct < 60; pct += 10) {
      store.update((d) => { d.characters.c_ada.agent!.contextPct = pct; });
      await world.settle();
    }
    expect(world.reads).toBe(1);
    store.update((d) => { d.characters.c_ada.agent!.status = 'done'; });
    await world.settle();
    await run;

    expect(world.reads).toBe(2);
    expect(result).toMatchObject({ ok: true });
  });

  it('gives up on a ps that does not answer, closing nothing', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1) })]);
    world.pane(1);
    world.hangPs = true;
    let error: unknown;
    const run = restTerminals(deps, { choices: {}, callTimeoutMs: 5000 }).catch((e) => { error = e; });

    await world.settle();
    await world.advance(4999);
    expect(error).toBeUndefined();
    await world.advance(1);
    await run;
    expect(String(error)).toMatch(/ps did not answer within 5000 ms/);
    // the ps it gave up on is told to go
    expect(world.psSignals[0]?.aborted).toBe(true);
    expect(world.log).toEqual([]);
  });

  it('leaves a terminal whose window it closed dormant with its session even when a later window will not close', async () => {
    const { store, world, deps, ownership, paths } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      char('c_bo', { tmux: win(3), agent: agent('codex', 'idle', SID2) }),
    ]);
    world.pane(1, { job: ['claude'] });
    world.pane(3, { job: ['codex'] });
    world.hangKill.add('@3');
    await ownership.freeze(tx);
    let error: unknown;
    const run = restTerminals(deps, { choices: {}, callTimeoutMs: 5000 }).catch((e) => { error = e; });

    await world.settle();
    await world.advance(5000);
    await run;
    expect(String(error)).toMatch(/kill-window did not answer/);

    // the first window is gone and its record says so, so the exit hook its agent sends next finds nothing to take
    const fleet = new Fleet({ store, tmux: new Tmux(paths.tmuxSock, paths.tmuxConf), paths, config: Config.parse({ id: fleetId }), ownership, log: silentLogger });
    fleet.onSocketEvent({ hook: { charId: 'c_ada', backend: 'claude', name: 'SessionEnd', sessionId: SID } });
    expect(store.state.characters.c_ada.tmux).toBeUndefined();
    expect(store.state.characters.c_ada.agent?.sessionId).toBe(SID);
    expect(store.state.characters.c_ada.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(store.state.characters.c_bo.tmux).toEqual(win(3));
  });

  it('stops with the journal open and the slot live when a window is still open after its kill, laying only the ones closed before it dormant', async () => {
    const { store, world, deps, paths } = boot([
      char('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      char('c_bo', { tmux: win(3), agent: agent('codex', 'idle', SID2) }),
    ]);
    world.pane(1, { job: ['claude'] });
    world.pane(3, { job: ['codex'] });
    world.keepOnKill.add('@3');

    await expect(restTerminals(deps, { choices: {} })).rejects.toThrow(/bo's terminal is still open/);

    expect(store.state.characters.c_ada).toMatchObject({ restedBy: tx.id, revive: { command: `claude --resume ${SID}` } });
    expect(store.state.characters.c_ada.tmux).toBeUndefined();
    expect(store.state.characters.c_bo.tmux).toEqual(win(3));
    expect(store.state.characters.c_bo.restedBy).toBeUndefined();
    expect(journalOf(paths).stoppedTerminals).toEqual([{ characterId: 'c_ada' }, { characterId: 'c_bo' }]);
  });

  it('still waits on a background job of an interrupted Claude, but not on its Svall statusline and hook', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    const node = '/Applications/Svall.app/Contents/Helpers/node';
    const [script, status] = installedScripts('/Users/ada/.svall');
    const pane = world.pane(1, {
      job: ['claude'],
      tools: [
        `/bin/sh -c ${statusWrapper(node, status)} 'ccstatusline'`,
        `/bin/sh -c ${hookCommand(node, script, 'claude')}`,
        '/Users/ada/.svall/hooks/svall-hook claude 1001',
        '/bin/zsh -c npm run dev',
      ],
    });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    pane.tools = pane.tools!.slice(0, 3);
    await world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
  });

  it('reports a job that outlives its termination as a busy shell, even under a stale agent record', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'idle') })]);
    world.pane(1, { job: ['tail -f build.log'], unkillable: true });
    let result: unknown;
    const run = restTerminals(deps, { choices: { terminate: true }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(world.log).toEqual(['SIGTERM 1001', 'SIGKILL 1001']);
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "ada's terminal is still running tail -f build.log after it was terminated", entity: { kind: 'character', id: 'c_ada' } }],
    });
  });

  it('stops waiting when cancelled, and closes nothing', async () => {
    const { world, deps } = boot([char('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    const cancel = new AbortController();
    const run = restTerminals(deps, { choices: {}, pollMs: 500, cancel: cancel.signal });

    await world.settle();
    await world.advance(500);
    cancel.abort();
    await expect(run).rejects.toThrow(/abort/i);
    expect(world.log).toEqual([]);
  });

  it('makes a terminal whose window already went dormant too', async () => {
    const { store, world, deps, paths } = boot([
      char('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2), agent: agent('claude', 'idle', SID2) } }),
    ]);
    world.pane(1);

    const result = await restTerminals(deps, { choices: {} });

    expect(result).toEqual({ ok: true, terminals: [{ characterId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
    // the handover did not stop the second, so an abort has nothing of it to bring back, nor a destination to open
    expect(journalOf(paths).stoppedTerminals).toEqual([{ characterId: 'c_ada' }]);
    expect(store.state.characters.c_ada.restedBy).toBe(tx.id);
    expect(store.state.characters.c_ada.second).toEqual({
      cwd: '/s', unread: false, agent: agent('claude', 'idle', SID2), revive: { command: `claude --resume ${SID2}` },
    });
  });
});

describe('unapproved', () => {
  it('names what would stop resting without touching anything, and leaves a working agent to be waited on', async () => {
    const world = new World();
    const state = emptyState();
    state.characters.c_ada = char('c_ada', { tmux: win(1), agent: agent('claude', 'working'), second: { cwd: '/s', unread: false, tmux: win(2) } });
    state.characters.c_bo = char('c_bo', { tmux: win(3), agent: agent('claude', 'blocked', SID2) });
    world.pane(1, { job: ['claude'] });
    world.pane(2, { job: ['npm run dev'] });
    world.pane(3, { job: ['claude'] });
    state.characters.c_cy = char('c_cy', { tmux: win(4), agent: agent('claude', 'idle', SID2) });
    world.pane(4, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });

    const terminals = classifyTerminals(state, await world.tmux.listWindows(), await world.processes());

    expect(terminals.map((t) => t.class)).toEqual(['agent-working', 'foreground', 'agent-blocked', 'agent-ready']);
    expect(unapproved(state, terminals, {}).map((b) => b.code)).toEqual(['shell_busy', 'agent_blocked', 'agent_unsettled']);
    expect(unapproved(state, terminals, { interruptAfterMs: 30_000, terminate: [{ characterId: 'c_ada', term: 2 }, { characterId: 'c_cy' }] })).toEqual([]);
    expect(world.log).toEqual([]);
  });
});

describe('restChoices', () => {
  it('reads a character the protocol names as both of its terminals', () => {
    expect(restChoices({ interruptAfterMs: 30_000, terminateShells: ['c_ada'] })).toEqual({
      interruptAfterMs: 30_000, terminate: [{ characterId: 'c_ada' }, { characterId: 'c_ada', term: 2 }],
    });
    expect(restChoices({ terminateShells: true })).toEqual({ terminate: true });
    expect(restChoices({})).toEqual({});
  });
});

describe('a frozen fleet', () => {
  it('keeps the agent of a terminal the handover closed when a late SessionEnd arrives, and still hears a live one', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger, standalone: true });
    const fleet = new Fleet({ store, tmux: new Tmux(paths.tmuxSock, paths.tmuxConf), paths, config: Config.parse({ id: fleetId }), ownership, log: silentLogger });
    store.update((d) => {
      d.characters.c_ada = char('c_ada', {
        agent: agent('claude', 'idle'), revive: { command: `claude --resume ${SID}` },
        second: { cwd: '/s', unread: false, agent: agent('codex', 'idle', SID2), revive: { command: `codex resume ${SID2}` } },
      });
      d.characters.c_bo = char('c_bo', { tmux: win(3), agent: agent('claude', 'working', SID2) });
    });
    await ownership.freeze(tx);

    fleet.onSocketEvent({ hook: { charId: 'c_ada', backend: 'claude', name: 'SessionEnd', sessionId: SID } });
    fleet.onSocketEvent({ hook: { charId: 'c_ada', backend: 'codex', name: 'SessionEnd', sessionId: SID2, term: 2 } });
    fleet.onSocketEvent({ hook: { charId: 'c_bo', backend: 'claude', name: 'Stop', sessionId: SID2 } });

    expect(store.state.characters.c_ada.agent?.sessionId).toBe(SID);
    expect(store.state.characters.c_ada.second?.agent?.sessionId).toBe(SID2);
    expect(store.state.characters.c_bo.agent?.status).toBe('done');
  });

  it("keeps the session of an OpenCode terminal the handover closed whatever its plugin reports as its server shuts down, and still hears a live one", async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger, standalone: true });
    const fleet = new Fleet({ store, tmux: new Tmux(paths.tmuxSock, paths.tmuxConf), paths, config: Config.parse({ id: fleetId }), ownership, log: silentLogger });
    const other = 'ses_0123456789abCDEFGHIJKLMNop';
    store.update((d) => {
      d.characters.c_ada = char('c_ada', { agent: agent('opencode', 'idle', OSID), revive: { command: `opencode -s ${OSID}` } });
      d.characters.c_bo = char('c_bo', { tmux: win(3), agent: agent('opencode', 'working', other) });
    });
    await ownership.freeze(tx);

    fleet.onSocketEvent({ hook: { charId: 'c_ada', backend: 'opencode', name: 'Interrupt', sessionId: OSID } });
    fleet.onSocketEvent({ hook: { charId: 'c_ada', backend: 'opencode', name: 'SessionStart', sessionId: other } });
    fleet.onSocketEvent({ hook: { charId: 'c_bo', backend: 'opencode', name: 'Stop', sessionId: other } });

    expect(store.state.characters.c_ada.agent).toMatchObject({ sessionId: OSID, status: 'idle' });
    expect(store.state.characters.c_ada.revive).toEqual({ command: `opencode -s ${OSID}` });
    expect(store.state.characters.c_bo.agent?.status).toBe('done');
  });
});

const runIf = hasTmux() ? describe : describe.skip;

runIf(`resting real terminals${hasTmux() ? '' : ' (skipped: tmux is not on PATH)'}`, () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

  it('ends the chosen job in a real pane, detaches an attached client, and closes both windows', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ id: fleetId, shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger, standalone: true });
    const fleet = new Fleet({ store, tmux, paths, config, ownership, log: silentLogger, pollMs: 150 });
    await fleet.start();
    cleanup.push(async () => { fleet.stop(); await tmux.killServer(); });
    const hub = new TerminalHub(fleet, tmux, store, silentLogger);
    const c = await fleet.createCharacter({ islandId: fleet.createIsland({ name: 'rest' }).id, cwd: home });
    await fleet.openSecond(c.id);
    const second = store.state.characters[c.id].second!.tmux!;
    await tmux.sendLine(second.paneId, 'sleep 300', true);
    const secondPid = (await tmux.listWindows()).find((w) => w.windowId === second.windowId)!.panePid;
    await waitFor(async () => (await ProcessTable.read()).pane(secondPid)?.foreground[0]?.args === 'sleep 300');

    const { session, socket } = await hub.attach(c.id);
    let screen = '';
    const client = spawn('python3', [path.join(import.meta.dirname, '../fixtures/on-pty.py'), tmux.binary, '-S', socket, 'attach', '-t', session], {
      env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    client.stdout.on('data', (d: Buffer) => { screen += d.toString(); });
    cleanup.push(async () => { client.kill(); });
    await waitFor(async () => (await tmux.run('list-clients', '-t', `=${session}`, '-F', '#{client_name}')).trim() !== '');

    await ownership.freeze(tx);
    await fleet.settle();
    const handover = new HandoverService({ ownership, journal: openJournal(paths), ...idleSides(paths, { store }) });
    handover.write(SourceJournal.parse({
      role: 'source', transactionId: tx.id, generation: 0, fleetId, fromMachineId: me, toMachineId: other, phase: 'freeze', updatedAt: 0,
    }));

    const result = await restTerminals(
      { store, tmux, viewers: hub, journal: handover },
      { choices: { terminate: [{ characterId: c.id, term: 2 }] }, pollMs: 50, settleMs: 3000 },
    );

    expect(result).toMatchObject({ ok: true });
    expect(await tmux.listWindows()).toEqual([]);
    await waitFor(() => screen.includes('detached'));
    const rested = store.state.characters[c.id];
    expect(rested.tmux).toBeUndefined();
    expect(rested.second).toEqual({ cwd: fs.realpathSync(home), unread: false, revive: { command: '' }, restedBy: tx.id });
    expect(journalOf(paths).terminated).toEqual([{ characterId: c.id, term: 2, processes: ['sleep 300'] }]);
  }, 20_000);

  it('rests a fleet whose tmux server died with its windows, or left no socket at all, as one with no window, closing none', async () => {
    const paths = resolvePaths(makeHome());
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(Config.parse({ id: fleetId, shell: '/bin/sh' })));
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    await tmux.ensureServer();
    cleanup.push(() => tmux.killServer());
    const store = Store.load(paths.state, () => {});
    const w = await tmux.newWindow('c_ada', paths.home, {});
    store.update((d) => { d.characters.c_ada = char('c_ada', { tmux: w, agent: agent('claude', 'idle') }); });
    const handover = new HandoverService({ ownership: OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger }), journal: openJournal(paths), ...idleSides(paths, { store }) });
    handover.write(SourceJournal.parse({
      role: 'source', transactionId: tx.id, generation: 0, fleetId, fromMachineId: me, toMachineId: other, phase: 'freeze', updatedAt: 0,
    }));
    const detached: string[] = [];
    const rest = () => restTerminals({ store, tmux, viewers: { detach: async (id) => { detached.push(id); } }, journal: handover }, { choices: {} });

    // the whole unit went down: the server, every window and every agent in it, and its socket file stays behind
    const pid = Number((await tmux.run('display-message', '-p', '#{pid}')).trim());
    process.kill(pid, 'SIGKILL');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(fs.existsSync(paths.tmuxSock)).toBe(true);
    expect(await rest()).toEqual({ ok: true, terminals: [] });
    const ada = store.state.characters.c_ada;
    expect(ada.tmux).toBeUndefined();
    expect(ada).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` } });
    // the handover closed no window, so neither an abort nor the destination opens one
    expect(ada.restedBy).toBeUndefined();
    expect(journalOf(paths).stoppedTerminals).toEqual([]);

    fs.rmSync(paths.tmuxSock);
    expect(await rest()).toEqual({ ok: true, terminals: [] });
    expect(detached).toEqual([]);
  }, 20_000);
});
