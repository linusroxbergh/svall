import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_ISLAND, HOME_SEED, RUN_TIMEOUT_MS, cellKey, fleetNameProblem, homeSizeFor, isHomeSlot, isLand, randomPortrait, starredOf, type Agent, type AgentKind, type AgentStatus, type BrowserTab, type Cell, type Robot, type ContextItem, type Delivery, type FleetState, type Island, type TerminalSlot } from '@svall/protocol';
import { AGENTS, mainAgent } from './agents.js';
import { listAgentProfiles, readAgentProfile, seedAgentProfiles } from './agent-profiles.js';
import { markSeen as markSeenPure, settle } from './agent/reducer.js';
import { condenseTurns, readTail, recordedCwd, userPrompts } from './agent/transcript.js';
import { robotKeyEnv, rendererEnv } from './claude.js';
import { codexPaths } from './codex/install.js';
import { codexZshEnv } from './codex/zsh.js';
import { initConfig, modelPicks, patchFleetConfig, saveConfig, saveMainAgent, type Config } from './config.js';
import { renderBrief } from './context/brief.js';
import { isAgentCommand, promptText, withAddDirs, withPromptFile, withStandalone } from './context/launch.js';
import { settleItems } from './context/items.js';
import { docFolders, removeDocs } from './docs.js';
import { endAll, endIdleAgents, exited, freshCommand, loseSecond, markDormant, processes, rememberFlags, resumeHere, resumeNote, runsAgent, sleepFlags, startFlags, unsaved, type Proc, type Sleep } from './dormancy.js';
import { Dormant, Invalid, NotFound } from './errors.js';
import { attribute, type Scope } from './load/attribute.js';
import { endProcs } from './load/end.js';
import { readProcs, type LiveProc } from './load/procs.js';
import { takenNames } from './fleets.js';
import { AgentEvents } from './fleet/agent-events.js';
import { ControlLink, type PaneEvents } from './fleet/control.js';
import { Poll, resumeOf, type Resume } from './fleet/poll.js';
import { Prompts, type WaitResult } from './fleet/prompts.js';
import { repairBrief } from './handover/sessions/repair.js';
import type { SocketEvent } from './hooks/receiver.js';
import { newId } from './ids.js';
import { arrangeIslands, createIsland, deleteIsland, reorderIsland, updateIsland, type IslandPatch, type NewIsland } from './islands.js';
import { blockedCells, crewOf, defaultPosition, freePosition, occupiedCells, placeOnIsland, settleHome, unfold, uniqueName } from './layout.js';
import { refreshLinks, type Deps as LinkDeps } from './links/refresh.js';
import type { Logger } from './log.js';
import { randomName } from './names.js';
import { linkOpencodeConfig, opencodePaths } from './opencode/install.js';
import type { OwnershipState } from './ownership/state.js';
import { expandHome, userPaths, type Paths } from './paths.js';
import { SHIM } from './profile.js';
import { reconcile, secondName, snapshot, type Carried } from './reconcile.js';
import { codexRunner } from './scribe/codex.js';
import { opencodeRunner } from './scribe/opencode.js';
import { claudeRunner, perPass, type RunScribe } from './scribe/run.js';
import { Scribe, type SweepOptions } from './scribe/scribe.js';
import { fullWake } from './scribe/wake.js';
import { installHomeTemplate } from './setup.js';
import type { Store } from './store.js';
import { activateTab, closeTab, openTab, updateTab } from './tabs.js';
import type { LiveWindow, Tmux } from './tmux/tmux.js';
import { appPid } from './uninstall.js';

type Events = PaneEvents & { stopped: []; 'session-start': [robotId: string, term: 2 | undefined, sessionId: string] };

// text a person writes stays theirs until they clear it; cleared, the scribe may write it again
function setNote(c: Robot, note: string): void {
  c.note = note;
  if (note) c.noteSource = 'manual'; else delete c.noteSource;
}

export type RefreshLinks = (store: Store, config: Config, robotId: string) => Promise<void>;
type Deps = {
  store: Store; tmux: Tmux; paths: Paths; config: Config; log: Logger; ownership: OwnershipState; pollMs?: number; staleSessionMs?: number; runTimeoutMs?: number; resumeMs?: number;
  runScribe?: RunScribe; linkDeps?: Partial<LinkDeps>; refreshLinks?: RefreshLinks; processes?: () => Promise<Proc[]>; readProcs?: () => Promise<LiveProc[]>;
  endOpts?: Parameters<typeof endProcs>[2]; agentsFound?: AgentKind[]; platform?: NodeJS.Platform;
};
type LiveRobot = Robot & { tmux: NonNullable<Robot['tmux']> };
// a revive onto a window still alive sends its prompt as any send goes, which a draft there can hold
type Revived = Robot & { delivery?: Delivery };

export class Fleet extends EventEmitter<Events> {
  private reviving = new Map<string, Promise<Revived>>();
  // the windows of agents ended for idleness or put to sleep, until tmux has closed them, the agent has exited and a
  // sleep has ended what it started
  private ending = new Map<string, Promise<void>>();
  // the window names of robots being closed, which a listing meanwhile must not adopt
  private closing = new Set<string>();
  // when the user last looked at each robot's main terminal
  private seen = new Map<string, number>();
  private openingSecond = new Map<string, Promise<Robot>>();
  // new robots between opening their window and typing their start command
  private creating = new Set<Promise<unknown>>();
  // each revived terminal's resume, by window name, until its session starts
  private resuming = new Map<string, Resume>();
  private stopped = false;
  private activated?: Promise<void>;
  // the background writes in flight, so a freeze can wait for the last of them to land
  private background = new Set<Promise<unknown>>();
  private carried: Carried = () => false;

  private scribe: Scribe;
  private sleep: Sleep;
  private link: ControlLink;
  private poll: Poll;
  private agentEvents: AgentEvents;
  private prompts: Prompts;

  constructor(private deps: Deps) {
    super();
    const { store, log, config } = deps;
    const run = deps.runScribe ?? perPass(() => this.scribeRunner());
    this.scribe = new Scribe({ store, log, run, awake: fullWake, brief: (island, c) => this.render(island, c) });
    this.sleep = { store, tmux: deps.tmux, log, processes: deps.processes ?? processes, ending: this.ending };
    const writable = () => this.writable();
    const track = (work: Promise<unknown>, what: string) => this.track(work, what);
    this.link = new ControlLink({ store, tmux: deps.tmux, log, events: this, reconcile: () => this.reconcileNow(), writable, track, atShell: (key) => this.poll.atShell(key) });
    this.poll = new Poll({
      ...deps, scribe: this.scribe, listWindows: () => this.listWindows(), endIdleAgents: () => this.endIdleAgents(),
      writable, carried: (id, term) => this.carried(id, term), resuming: this.resuming, ending: this.ending, track, processes: this.sleep.processes,
    });
    this.agentEvents = new AgentEvents({
      store, config, log, render: (island, c) => this.render(island, c), refreshLinks: deps.refreshLinks ?? refreshLinks,
      writable, frozen: () => deps.ownership.isFrozen(), track, processes: this.sleep.processes,
    });
    this.prompts = new Prompts({
      fleet: this, store, tmux: deps.tmux, config, log, reviving: this.reviving, writable, assertOwner: () => deps.ownership.assertOwner('mutation'),
    });
  }

  /** Whether this daemon may write the fleet: the unfrozen owner, and nobody else. */
  private writable(): boolean {
    return this.deps.ownership.writable();
  }

  async start(): Promise<void> {
    // an inactive replica and a frozen source adopt no window and write nothing: they hold their
    // snapshot for reading, and start no tmux server to hold a window in
    if (this.writable()) await this.activate();
  }

  /** Reconciles, adopts the tmux windows and starts the poll. Calling it again changes nothing, unless the last attempt failed. */
  activate(): Promise<void> {
    this.activated ??= this.begin().catch((e) => { this.activated = undefined; throw e; });
    return this.activated;
  }

  /** Ends every window, held prompt and the poll: a fleet another machine now runs keeps no terminal running here. */
  async deactivate(): Promise<void> {
    const was = this.activated;
    this.activated = undefined;
    await was?.catch(() => {});
    this.prompts.stop();
    await this.link.stop();
    await this.poll.stop();
    await this.deps.tmux.killServer();
  }

  private async begin(): Promise<void> {
    await this.deps.tmux.ensureServer();
    await this.reconcileNow();
    // when the user last looked is not kept across a restart, so every agent awake now gets a whole rest from here
    const now = Date.now();
    for (const c of Object.values(this.deps.store.state.robots)) if (c.tmux) this.seen.set(c.id, now);
    const opening = this.ensureHome();
    this.syncAgents();
    // the shell is for the Mac app's tour; a Linux machine's new fleet is the one host add starts, which enable replaces only unused
    if (opening && (this.deps.platform ?? process.platform) === 'darwin') {
      await this.createRobot({ islandId: opening, cwd: this.deps.config.defaultCwd })
        .catch((e) => this.deps.log.error(`first robot: ${String(e)}`));
    }
    this.deps.store.update((d) => { if (this.deps.config.name) d.name = this.deps.config.name; else delete d.name; });
    try { if (seedAgentProfiles(this.deps.paths.agentProfiles)) this.deps.log.info(`agent profiles -> ${this.deps.paths.agentProfiles}`); }
    catch (e) { this.deps.log.error(`agent profiles: ${String(e)}`); }
    await this.link.start();
    this.poll.start();
  }

  private track(work: Promise<unknown>, what: string): void {
    const done = work.catch((e) => this.deps.log.error(`${what}: ${String(e)}`));
    this.background.add(done);
    void done.then(() => this.background.delete(done));
  }

  /** Resolves once the background writes and every window opening in flight have landed, and the fleet is on disk:
   *  after a freeze, none follows it. */
  async settle(): Promise<void> {
    const inFlight = () => [...this.background, ...this.creating, ...this.reviving.values(), ...this.openingSecond.values()];
    while (inFlight().length) await Promise.allSettled(inFlight());
    await this.scribe.settled();
    this.deps.store.flush();
  }

  // the links a robot's cwd implies, rebuilt off the critical path
  private refresh(robotId: string): void {
    this.track((this.deps.refreshLinks ?? refreshLinks)(this.deps.store, this.deps.config, robotId), `links ${robotId}`);
  }

  /** Stops polling, the scribe, held prompts and the control client; resolves once a poll under way has finished and the fleet is on disk. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.scribe.stop();
    this.prompts.stop();
    await this.link.stop();
    await this.poll.stop();
    this.deps.store.flush();
  }

  robot(id: string): Robot {
    const c = this.deps.store.state.robots[id];
    if (!Object.hasOwn(this.deps.store.state.robots, id)) throw new NotFound(`no robot ${id}`);
    return c;
  }

  island(id: string): Island {
    const i = this.deps.store.state.islands[id];
    if (!Object.hasOwn(this.deps.store.state.islands, id)) throw new NotFound(`no island ${id}`);
    return i;
  }

  // a profile that is missing or cannot be used is left out, and the side card says why
  private render(island: Island, c?: Robot): string {
    const p = c?.agentProfile ? readAgentProfile(this.deps.paths.agentProfiles, c.agentProfile) : undefined;
    return renderBrief(island, c, docFolders(this.deps.paths.docs, island, c), p && !('error' in p) ? p : undefined, !this.deps.store.state.worktreesOff);
  }

  // a profile given by name must be one that can be used now; one that goes later is shown as missing
  private checkAgentProfile(name: string): void {
    const found = listAgentProfiles(this.deps.paths.agentProfiles);
    const p = found.find((x) => x.name === name);
    if (!p) throw new Invalid(`no agent profile ${name}; there are: ${found.map((x) => x.name).join(', ') || 'none'}`);
    if ('error' in p) throw new Invalid(`agent profile ${name} ${p.error}`);
  }

  brief(id: string): string {
    const c = this.robot(id);
    const island = this.deps.store.state.islands[c.islandId];
    return island ? this.render(island, c) : '';
  }

  islandBrief(id: string): string {
    return this.render(this.island(id));
  }

  live(id: string): LiveRobot {
    const c = this.robot(id);
    if (!c.tmux) throw new Dormant(`${c.name} is dormant; revive it first`);
    return c as LiveRobot;
  }

  // the terminal a call means: the main one, or the second when it says so
  terminal(id: string, term?: 2): { tmux: NonNullable<Robot['tmux']>; agent?: Agent } {
    if (term !== 2) return this.live(id);
    const c = this.robot(id);
    if (!c.second) throw new Invalid(`${c.name} has no second terminal`);
    if (!c.second.tmux) throw new Dormant(`the second terminal of ${c.name} is dormant; revive it first`);
    return { tmux: c.second.tmux, agent: c.second.agent };
  }

  /** Names the terminals a handover has yet to start: reconciling leaves the agent and resume command each carries to it. */
  carries(fn: Carried): void {
    this.carried = fn;
  }

  setPaneOutput(id: string, on: boolean): void {
    this.link.setPaneOutput(id, on);
  }

  continuePane(id: string): void {
    this.link.continuePane(id);
  }

  // the windows tmux has, less those still closing for idleness, a sleep or a close, which are not to be taken back
  private async listWindows(): Promise<LiveWindow[]> {
    const ending = new Set(this.ending.keys());
    return (await this.deps.tmux.listWindows()).filter((w) => !ending.has(w.name) && !this.ending.has(w.name) && !this.closing.has(w.name));
  }

  /** Each robot's pane pids, the Svall app's pid and svalld's own, for attributing `procs`. */
  async loadScope(procs: LiveProc[]): Promise<Scope> {
    const pids = new Map((await this.listWindows()).map((w) => [w.windowId, w.panePid]));
    const panes = new Map<string, number[]>();
    for (const c of Object.values(this.deps.store.state.robots)) {
      const ids = [c.tmux?.windowId, c.second?.tmux?.windowId];
      panes.set(c.id, ids.flatMap((id) => (id && pids.get(id)) || []));
    }
    const apps = new Set(procs.filter((p) => p.path.endsWith('/Contents/MacOS/Svall')).map((p) => p.pid));
    const server = await this.deps.tmux.serverPid();
    return { home: this.deps.paths.home, panes, appPid: appPid(this.deps.paths.home, { isApp: (pid) => apps.has(pid) }), own: [process.pid, ...(server ? [server] : [])] };
  }

  private readLive(): Promise<LiveProc[]> {
    const { hookHelper } = this.deps.paths;
    return (this.deps.readProcs ?? (() => readProcs(fs.existsSync(hookHelper) ? hookHelper : undefined)))();
  }

  // `c` is already out of the state, or closing, so its windows' panes join the scope by hand
  private async owned(c: Robot, procs: LiveProc[]): Promise<LiveProc[]> {
    const scope = await this.loadScope(procs);
    const ids = new Set([c.tmux?.windowId, c.second?.tmux?.windowId]);
    scope.panes.set(c.id, (await this.deps.tmux.listWindows()).filter((w) => ids.has(w.windowId)).map((w) => w.panePid));
    // svalld, its tmux server and the app may carry a robot's marks but are never the robot's to end
    const keep = new Set([...scope.own, scope.appPid]);
    return (attribute(procs, scope).robots.get(c.id) ?? []).filter((p) => !keep.has(p.pid));
  }

  sleepable(id: string, procs: LiveProc[]): boolean {
    const c = this.deps.store.state.robots[id];
    return !!c?.tmux && sleepFlags(c, procs) !== undefined;
  }

  async reconcileNow(): Promise<void> {
    if (!this.writable()) return;
    const before = snapshot(this.deps.store.state);
    const live = await this.listWindows();
    if (this.stopped || !this.writable()) return;
    const { mutate, renames, unplaced } = reconcile(this.deps.store.state, live, Date.now(), before, this.carried);
    this.deps.store.update(mutate);
    for (const line of unplaced) this.deps.log.error(line);
    for (const r of renames) {
      // a stray window that died since the listing must not abort startup.
      await this.deps.tmux.renameWindow(r.windowId, r.name)
        .catch((e) => this.deps.log.error(`rename ${r.windowId} -> ${r.name}: ${String(e)}`));
    }
  }

  // one home island per fleet; its cwd, command and buttons, and the fleet's default cwd, come from config on every start
  private ensureHome(): string | undefined {
    // the crew's model is the one syncAgents picks for the main agent's CLI
    const { model: _picks, ...home } = this.deps.config.home;
    // a robot is refused a cwd that is not a directory, so mission control's crew needs this one;
    // make the folder the buttons promise, holding the skills they call
    try { for (const l of installHomeTemplate(home.cwd, { replaceSettings: false })) this.deps.log.info(l); }
    catch (e) { this.deps.log.error(`home cwd ${home.cwd}: ${String(e)}`); }
    // the directory a crewless island starts in; it is the user's folder, so never create it
    const cwd = this.deps.config.defaultCwd;
    if (!fs.statSync(expandHome(cwd), { throwIfNoEntry: false })?.isDirectory()) {
      this.deps.log.error(`default cwd ${cwd} is not a directory: robots cannot start there`);
    }
    // a fleet with no islands at all is new; a recovered or salvaged one already has some by now
    const first = Object.keys(this.deps.store.state.islands).length === 0;
    this.deps.store.update((d) => {
      d.home = { ...home, command: this.crewCommand() };
      d.defaultCwd = this.deps.config.defaultCwd;
      if (!d.islands[HOME_ISLAND]) {
        const size = homeSizeFor(2);
        const home: Island = {
          id: HOME_ISLAND, kind: 'home', name: 'mission control', description: '', instructions: '', context: [],
          position: defaultPosition(d), size, seed: HOME_SEED,
        };
        home.position = freePosition(d, home);
        d.islands[HOME_ISLAND] = home;
      }
      // a start is the one moment mission control comes back up to the fleet; from here it only follows it down
      settleHome(d);
    });
    // a new fleet opens with one island beside mission control, for start to put a shell on; only its first start makes it, so a deleted one stays gone
    return first ? this.createIsland({ name: 'Island 1' }).id : undefined;
  }

  private endIdleAgents(): Promise<void> {
    // a freeze, or the fleet moving to another machine, while ps ran or an earlier agent closed leaves every agent be
    return endIdleAgents(this.sleep, this.seen, () => this.stopped || !this.writable(), (id) => this.prompts.holds(id));
  }

  /** Ends every terminal as the app quits: each robot goes dormant with the revive that resumes it, then the
   * tmux server goes, and nothing runs again until a robot is opened. A replica only stops: its terminals are the owner's. */
  async stopAll(): Promise<void> {
    // the control client's exit would otherwise start a server again, and a poll under way write back what this ends
    await this.stop();
    if (this.deps.ownership.writable()) await endAll(this.sleep, this.reviving);
    setImmediate(() => this.emit('stopped'));
  }

  setWorktrees(enabled: boolean): void {
    this.deps.store.update((d) => { if (enabled) delete d.worktreesOff; else d.worktreesOff = true; });
  }

  setDormancy(hours: number): void {
    this.deps.store.update((d) => { d.dormantAfterHours = hours; });
  }

  // the scribe's CLI and model as fleet.json and the main agent name them now
  private scribeRunner(): RunScribe {
    const { paths, store } = this.deps;
    const agent = store.state.scribeAgent ?? 'claude';
    const cwd = path.join(paths.home, 'scribe');
    const model = this.model('scribe', agent);
    if (agent === 'claude') return claudeRunner({ model: model!, cwd, envFile: paths.env });
    return agent === 'codex' ? codexRunner({ model, cwd }) : opencodeRunner({ model, cwd });
  }

  // fleet.json's model for `agent`'s CLI, else the CLI's default
  private model(of: 'scribe' | 'home', agent: AgentKind): string | undefined {
    return modelPicks(this.deps.config, of)[agent] ?? (of === 'scribe' ? AGENTS[agent].scribeModel : AGENTS[agent].crewModel);
  }

  // fleet.json's home.command, else the main agent's on the crew's model
  private crewCommand(): string {
    const agent = mainAgent(this.deps.config.mainAgent, this.deps.agentsFound ?? []);
    return this.deps.config.home.command ?? AGENTS[agent].crewCommand(this.model('home', agent));
  }

  // fleet.json holds the choice; the fleet carries it, and what svalld finds, to the app
  private syncAgents(): void {
    const found = this.deps.agentsFound ?? [];
    this.deps.store.update((d) => {
      d.mainAgent = mainAgent(this.deps.config.mainAgent, found);
      d.agentsFound = found;
      d.scribeAgent = this.deps.config.scribe.agent ?? d.mainAgent;
      d.scribeModel = this.model('scribe', d.scribeAgent);
      d.home.command = this.crewCommand();
      d.home.model = this.model('home', d.mainAgent);
    });
  }

  // `agent`'s pick, kept beside the other CLIs'; with no model, that CLI's default
  setModel(of: 'scribe' | 'home', agent: AgentKind, model: string | undefined): void {
    const picks = { ...modelPicks(this.deps.config, of), [agent]: model };
    saveConfig(this.deps.paths, of === 'home' ? { home: { model: picks } } : { scribe: { model: picks } }, this.deps.log.info);
    this.deps.config[of].model = picks;
    this.syncAgents();
  }

  setMainAgent(agent: AgentKind): void {
    if (!(this.deps.agentsFound ?? []).includes(agent)) {
      throw new Invalid(`svalld doesn't find ${AGENTS[agent].bin}; install ${AGENTS[agent].label}, then run ${SHIM} setup`);
    }
    saveMainAgent(this.deps.paths, agent, this.deps.log.info);
    this.deps.config.mainAgent = agent;
    this.syncAgents();
  }

  // only the label changes: the directory, launchd label, tmux socket and ports stay
  renameFleet(name: string): void {
    const problem = fleetNameProblem(name, takenNames(os.homedir(), this.deps.paths.home));
    if (problem) throw new Invalid(problem);
    initConfig(this.deps.paths, {}, this.deps.log.info);
    patchFleetConfig(this.deps.paths.fleetConfig, { name });
    this.deps.config.name = name;
    this.deps.store.update((d) => { d.name = name; });
  }

  // names, notes, links and island descriptions for the whole fleet, now; one line per change
  sweep(o: SweepOptions): Promise<string[]> {
    return this.scribe.sweep(o);
  }

  setScribe(enabled: boolean): void {
    this.deps.store.update((d) => { delete d.scribeAsk; if (enabled) delete d.scribeOff; else d.scribeOff = true; });
  }

  createIsland(p: NewIsland): Island {
    return createIsland(this.deps, p);
  }

  updateIsland(id: string, patch: IslandPatch): Island {
    return updateIsland(this.deps, id, patch);
  }

  arrangeIslands(aspect?: number, homeRoom?: number): void {
    arrangeIslands(this.deps, aspect, homeRoom);
  }

  reorderIsland(id: string, targetId: string, after: boolean): Island {
    return reorderIsland(this.deps, id, targetId, after);
  }

  deleteIsland(id: string): void {
    deleteIsland(this.deps, id);
  }

  async createRobot(p: { islandId: string; cwd: string; name?: string; command?: string; cell?: Cell; run?: string; agentProfile?: string }): Promise<Robot & { runSent?: boolean }> {
    if (p.run && !p.command) throw new Invalid('run needs a command to start the agent');
    this.island(p.islandId);
    if (p.agentProfile) this.checkAgentProfile(p.agentProfile);
    if (p.cell) {
      this.checkCell(this.island(p.islandId), p.cell);
      if (occupiedCells(this.deps.store.state, p.islandId).has(cellKey(p.cell))) throw new Invalid(`cell ${cellKey(p.cell)} is occupied`);
      if (blockedCells(this.deps.store.state, p.islandId).has(cellKey(p.cell))) throw new Invalid(`cell ${cellKey(p.cell)} touches another robot`);
    } else {
      // probe the real placement (including any grow) on a clone: a full island must fail before the
      // tmux window exists, not after — the clone keeps this one code path with placeOnIsland
      placeOnIsland(structuredClone(this.deps.store.state), p.islandId);
    }
    const cwd = expandHome(p.cwd);
    // tmux would start the window in the daemon's own directory, or in $HOME
    if (!path.isAbsolute(cwd)) throw new Invalid(`cwd ${p.cwd} is not an absolute path`);
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Invalid(`cwd ${p.cwd} is not a directory`);
    const id = newId('c');
    // the path tmux reports for a pane started here, as for /tmp, so a poll moves the robot only once the pane moves
    const panePath = fs.realpathSync(cwd);
    const prompt = p.command && isAgentCommand(p.command) ? p.run : undefined;
    this.deps.ownership.assertOwner('terminal');
    const opening = this.openRobot(id, cwd, panePath, p, prompt);
    this.creating.add(opening);
    const done = () => { this.creating.delete(opening); };
    void opening.then(done, done);
    await opening;
    // a freeze since the window opened stops the background work and the prompt
    if (!this.writable()) {
      if (p.run && !prompt) this.deps.log.error(`robot ${id}: the fleet froze for a handover, prompt not sent`);
      return { ...this.robot(id), ...(p.run && { runSent: !!prompt }) };
    }
    this.refresh(id);
    if (!p.run) return this.robot(id);
    const timeoutMs = this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    let runSent = await this.prompts.waitForAgent(id, timeoutMs);
    // an agent has its prompt already, and submits it once it is up
    if (prompt) return { ...this.robot(id), runSent: true };
    if (runSent && !this.writable()) {
      this.deps.log.error(`robot ${id}: the fleet froze for a handover, prompt not sent`);
      return { ...this.robot(id), runSent: false };
    }
    if (runSent) {
      // the window can die between the agent attaching and the send; the robot stays, without its prompt
      try { await this.run(id, p.run, true); } catch { runSent = false; }
    }
    // Claude Code asks whether an unfamiliar directory is trusted before it starts, and reports in only
    // once answered: the whole wait passes with the pane sitting on the question, which is worth a line
    if (!runSent) this.deps.log.error(`robot ${id}: no agent reported in within ${timeoutMs}ms, prompt not sent`);
    return { ...this.robot(id), runSent };
  }

  // the window, the record and the start command of a new robot; neither an orphan window nor a half-made robot outlives a failure
  private async openRobot(
    id: string, cwd: string, panePath: string, p: { islandId: string; name?: string; command?: string; cell?: Cell; run?: string; agentProfile?: string }, prompt: string | undefined,
  ): Promise<void> {
    const w = await this.deps.tmux.newWindow(id, cwd, this.robotEnv(id));
    try {
      this.deps.store.update((d) => {
        // a name asked for twice, as a button pressed twice does, gets a number
        const names = Object.values(d.robots).map((c) => c.name);
        d.robots[id] = {
          id, islandId: p.islandId, cell: p.cell ?? placeOnIsland(d, p.islandId, undefined, this.deps.log),
          name: uniqueName(names, p.name ?? randomName(new Set(names))),
          portrait: randomPortrait(new Set(Object.values(d.robots).map((c) => c.portrait))),
          note: '', instructions: '', ...(p.agentProfile && { agentProfile: p.agentProfile }), cwd, panePath, context: [],
          tmux: { windowId: w.windowId, paneId: w.paneId },
          shell: { lastOutputAt: Date.now() }, unread: false,
        };
        // a hidden island comes back to take the robot, as one placed there for it does
        if (p.cell && d.islands[p.islandId].collapsed) unfold(d, p.islandId, this.deps.log);
      });
      if (p.command) await this.deps.tmux.sendLine(w.paneId, this.launchLine(id, withAddDirs(p.command, this.deps.store.state.islands[p.islandId].context), prompt), true);
    } catch (e) {
      // the island filled up while the window was being created, or the start command never reached the
      // pane: neither an orphan window nor a half-created robot survives
      if (prompt) fs.rmSync(this.promptFile(id), { force: true });
      this.deps.store.update((d) => { delete d.robots[id]; });
      await this.deps.tmux.killWindow(w.windowId);
      throw e;
    }
  }

  private robotEnv(id: string, extra: Record<string, string> = {}): Record<string, string> {
    return { ...robotKeyEnv(this.deps.paths.env), ...rendererEnv(userPaths().claudeSettings), SVALL_ROBOT_ID: id, SVALL_HOME: this.deps.paths.home, ...this.codexEnv(), ...this.opencodeEnv(), ...extra };
  }

  private codexEnv(): Record<string, string> {
    if (!(this.deps.config.integrations?.includes('codex') ?? true) || !(this.deps.agentsFound?.includes('codex') || fs.existsSync(codexPaths().dir))) return {};
    try {
      return codexZshEnv(this.deps.paths.zdotdir);
    } catch (e) {
      this.deps.log.error(`codex zsh: ${(e as Error).message}`);
      return {};
    }
  }

  private opencodeEnv(): Record<string, string> {
    const o = opencodePaths();
    // only where OpenCode is, as for the plugin: a config folder made here would pass for an install
    if (!(this.deps.config.integrations?.includes('opencode') ?? true) || !(this.deps.agentsFound?.includes('opencode') || fs.existsSync(o.dir))) return {};
    const { opencodeConfig, opencodeReplaced } = this.deps.paths;
    // every TUI in a directory shares one live tab strip, so a robot's OpenCode shows only its own session. The
    // highlights dialog after an update hides the cursor, which holds safe send; ctrl+z undoes instead of suspending
    const cli = { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ tabs: { mode: 'off' }, highlights: false, keybinds: { 'terminal.suspend': 'none', 'input.undo': 'ctrl+z,ctrl+-,super+z' } }) };
    try {
      for (const f of linkOpencodeConfig(opencodeConfig, o, opencodeReplaced)) this.deps.log.error(`opencode config: ${f}`);
      return { ...cli, OPENCODE_CONFIG_DIR: opencodeConfig };
    } catch (e) {
      this.deps.log.error(`opencode config: ${(e as Error).message}`);
      return cli;
    }
  }

  private promptFile(id: string): string {
    return path.join(this.deps.paths.home, `${id}.prompt`);
  }

  // an agent takes a first prompt as its argument, which the shell reads from a file: typed into a composer
  // that is still booting, a long prompt can arrive in pieces that swallow the Enter
  private launchLine(id: string, launch: string, prompt?: string): string {
    const command = withStandalone(launch);
    // a prompt file an OpenCode plugin never took must not reach the next resume
    if (!prompt) fs.rmSync(this.promptFile(id), { force: true });
    if (!prompt || !isAgentCommand(command)) return command;
    fs.writeFileSync(this.promptFile(id), promptText(command, prompt), { mode: 0o600 });
    return withPromptFile(command, this.promptFile(id));
  }

  // the cell before the islandId, or the robot's stale cell would count as occupied on the target island
  private placeOn(d: FleetState, id: string, islandId: string): void {
    const cell = placeOnIsland(d, islandId, id, this.deps.log);
    d.robots[id].islandId = islandId;
    d.robots[id].cell = cell;
  }

  /** A profile renamed in its folder takes the robots that use it along. */
  renameAgentProfile(from: string, to: string): void {
    this.deps.store.update((d) => { for (const c of Object.values(d.robots)) if (c.agentProfile === from) c.agentProfile = to; });
  }

  updateRobot(id: string, patch: {
    name?: string; note?: string; instructions?: string; agentProfile?: string; islandId?: string; context?: ContextItem[]; figure?: number; keepHere?: boolean;
  }): Robot {
    const current = this.robot(id);
    if (patch.islandId) this.island(patch.islandId);
    if (patch.agentProfile) this.checkAgentProfile(patch.agentProfile);
    // names resolve without regard to case, so a twin would leave both robots unreachable by name
    const clash = patch.name !== undefined && Object.values(this.deps.store.state.robots)
      .find((c) => c.id !== id && c.name.toLowerCase() === patch.name!.toLowerCase());
    if (clash) throw new Invalid(`another robot is already called ${clash.name}`);
    const context = patch.context && settleItems(patch.context, current.context);
    this.deps.store.update((d) => {
      const c = d.robots[id];
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.figure !== undefined) c.figure = patch.figure;
      if (patch.note !== undefined) setNote(c, patch.note);
      if (patch.instructions !== undefined) c.instructions = patch.instructions;
      if (patch.agentProfile) c.agentProfile = patch.agentProfile;
      else if (patch.agentProfile === '') delete c.agentProfile;
      if (patch.keepHere) c.keepHere = true;
      else if (patch.keepHere === false) delete c.keepHere;
      if (context) c.context = context;
      if (patch.islandId && patch.islandId !== c.islandId) this.placeOn(d, id, patch.islandId);
    });
    return this.robot(id);
  }

  // one store update: a swap must never be observed half done
  moveRobot(id: string, islandId: string, cell?: Cell): Robot {
    this.robot(id);   // whichever path runs, the robot has to exist
    const island = this.island(islandId);
    // without a cell the fleet picks one and grows the island to fit, even on the island the robot already stands on
    if (!cell) {
      this.deps.store.update((d) => this.placeOn(d, id, islandId));
      return this.robot(id);
    }
    this.checkCell(island, cell);
    const state = this.deps.store.state;
    const occupant = Object.values(state.robots).find((o) => o.id !== id && o.islandId === islandId && cellKey(o.cell) === cellKey(cell));
    if (!occupant && blockedCells(state, islandId, id).has(cellKey(cell))) throw new Invalid(`cell ${cellKey(cell)} touches another robot`);
    this.deps.store.update((d) => {
      const c = d.robots[id];
      const other = occupant ? d.robots[occupant.id] : undefined;
      if (other) { other.islandId = c.islandId; other.cell = c.cell; }
      c.islandId = islandId;
      c.cell = cell;
      if (d.islands[islandId].collapsed) unfold(d, islandId, this.deps.log);
    });
    return this.robot(id);
  }

  // a cell asked for by name is one of mission control's slots, or land on any other island
  private checkCell(island: Island, cell: Cell): void {
    if (island.kind === 'home' && !isHomeSlot(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not a home slot`);
    if (!isLand(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not land`);
  }

  // A sidebar drop inserts into the target crew in one update. On another island it first
  // makes room there; within one island it rotates only the occupied cells between the rows.
  reorderRobot(id: string, targetId: string, after: boolean): Robot {
    const moving = this.robot(id);
    const target = this.robot(targetId);
    if (id === targetId) return moving;
    this.deps.store.update((d) => {
      if (moving.islandId !== target.islandId) this.placeOn(d, id, target.islandId);
      const crew = crewOf(d, target.islandId).map((robotId) => d.robots[robotId]);
      const cells = crew.map((c) => c.cell);
      const order = crew.map((c) => c.id).filter((c) => c !== id);
      order.splice(order.indexOf(targetId) + Number(after), 0, id);
      order.forEach((robotId, index) => { d.robots[robotId].cell = cells[index]; });
    });
    return this.robot(id);
  }

  // without a target the star goes first; every starred robot is numbered anew in one update
  starRobot(id: string, targetId?: string, after = false): Robot {
    this.robot(id);
    if (targetId !== undefined && this.robot(targetId).star === undefined) throw new Invalid(`${this.robot(targetId).name} is not starred`);
    if (id === targetId) return this.robot(id);
    const order = starredOf(this.deps.store.state).map((c) => c.id).filter((x) => x !== id);
    order.splice(targetId === undefined ? 0 : order.indexOf(targetId) + Number(after), 0, id);
    this.deps.store.update((d) => { order.forEach((x, n) => { d.robots[x].star = n; }); });
    return this.robot(id);
  }

  unstarRobot(id: string): Robot {
    this.robot(id);
    this.deps.store.update((d) => { delete d.robots[id].star; });
    return this.robot(id);
  }

  async closeRobot(id: string): Promise<void> {
    // out of the state before any await, so a revive or second terminal opening meanwhile kills its own window
    const c = this.robot(id);
    for (const name of [id, secondName(id)]) this.closing.add(name);
    this.deps.store.update((d) => { delete d.robots[id]; });
    const killed = this.readLive().then((procs) => this.owned(c, procs)).catch((e) => { this.deps.log.error(`close ${id}: ${String(e)}`); return []; })
      .then(async (victims) => {
        if (c.tmux) await this.deps.tmux.killWindow(c.tmux.windowId);
        if (c.second?.tmux) await this.deps.tmux.killWindow(c.second.tmux.windowId);
        return victims;
      })
      .finally(() => { for (const name of [id, secondName(id)]) this.closing.delete(name); });
    // a freeze waits for the windows to close and what the robot started to end
    this.track(killed.then((victims) => endProcs(victims, () => this.readLive(), this.deps.endOpts)), `end ${id}`);
    await killed;
    // nothing the fleet keeps outside the state outlives the robot
    this.seen.delete(id);
    for (const m of [this.link, this.poll, this.agentEvents, this.prompts, this.scribe]) m.forget(id);
    removeDocs(this.deps.paths.docs, 'robot', id, this.deps.log);
  }

  /** Ends the agent and everything it started, closes the second terminal, dormant if it ran an agent, and leaves the
   * robot dormant without a carry-on note; the session resumes on the next open. */
  async sleepRobot(id: string): Promise<void> {
    await Promise.all([this.reviving.get(id), this.ending.get(id)].map((p) => p?.catch(() => {})));
    const c = this.robot(id);
    const procs = await this.readLive();
    const flags = sleepFlags(c, procs);
    if (!c.tmux || !flags) throw new Invalid(`${c.name} can't be put to sleep`);
    const victims = await this.owned(c, procs);
    // only a pid still running its agent is waited on, and killed if it outstays the wait; a dormant second's is stale
    const agentProc = (a?: Agent) => (a?.pid ? procs.find((p) => p.pid === a.pid && runsAgent(p.args, a.kind)) : undefined);
    const second = c.second?.tmux ? agentProc(c.second.agent) : undefined;
    const secondFlags = second && c.second?.agent && startFlags(second.args, c.second.agent.kind);
    const pids = [agentProc(c.agent), second].flatMap((p) => (p ? [p.pid] : []));
    const windows = [c.tmux.windowId];
    const keys = [id];
    // a freeze while the processes were read leaves the robot as it is
    this.deps.ownership.assertOwner('mutation');
    // dormant before the kill: the SessionEnd the kill sends then finds no live robot to clear. A close, another
    // sleep or an idle ending meanwhile leaves nothing to put to sleep
    this.deps.store.update((d) => {
      const cur = d.robots[id];
      if (!cur) throw new NotFound(`no robot ${id}`);
      if (cur.tmux?.windowId !== c.tmux!.windowId) throw new Invalid(`${c.name} can't be put to sleep`);
      markDormant(cur, flags);
      delete cur.revive?.interrupted;
      // the second terminal goes with the rest, even one opened while the processes were read
      if (cur.second?.tmux) {
        windows.push(cur.second.tmux.windowId);
        keys.push(secondName(id));
        loseSecond(cur, cur.second.tmux.windowId === c.second?.tmux?.windowId ? secondFlags : undefined);
      }
    });
    // registered with the state change under both windows' names, so a revive or a poll waits for the windows, the
    // agents and what they started, as a freeze does
    const killed = Promise.all(windows.map((w) => this.deps.tmux.killWindow(w)));
    const closing: Promise<void> = killed
      .then(() => Promise.all(pids.map((pid) => exited(pid))))
      .then(() => endProcs(victims, () => this.readLive(), this.deps.endOpts))
      .catch((e) => this.deps.log.error(`sleep ${id}: ${String(e)}`))
      .finally(() => { for (const k of keys) if (this.ending.get(k) === closing) this.ending.delete(k); });
    for (const k of keys) this.ending.set(k, closing);
    this.track(closing, `sleep ${id}`);
    await killed;
  }

  /** Revives every robot whose agent a quit, reboot or crash ended mid-turn; called once hooks can reach the fleet.
   *  Only the owner opens windows, and a terminal an open handover carries is that handover's to reopen. */
  async resumeInterrupted(): Promise<void> {
    if (!this.writable()) return;
    const ids = Object.values(this.deps.store.state.robots).filter((c) => c.revive?.interrupted && !this.carried(c.id)).map((c) => c.id);
    await Promise.all(ids.map((id) => this.reviveRobot(id).catch((e) => this.deps.log.error(`resume ${id}: ${String(e)}`))));
  }

  // concurrent revives would each spawn a window and orphan all but the last. `fresh` starts a new session with it in place of the resume
  reviveRobot(id: string, prompt?: string, fresh?: string): Promise<Revived> {
    // a page still open on a robot that the stop has just put to sleep would wake it again
    if (this.stopped) return Promise.reject(new Invalid('the fleet is stopping'));
    const inFlight = this.reviving.get(id);
    if (inFlight) return inFlight;
    const p = this.doRevive(id, prompt, this.writable(), fresh).finally(() => this.reviving.delete(id));
    this.reviving.set(id, p);
    return p;
  }

  // `admitted`: asked while the fleet was writable, so a freeze since then stops it before it opens anything; a
  // handover's own revive runs frozen
  private async doRevive(id: string, prompt: string | undefined, admitted: boolean, fresh?: string): Promise<Revived> {
    // a window still closing for idleness or a sleep is not one to go back to
    await this.ending.get(id);
    if (admitted) this.deps.ownership.assertOwner('terminal');
    const c = this.robot(id);
    if (c.tmux) return c;
    // a robot marked dormant while its window lived goes back to that window; a new one would run the resume twice
    const alive = (await this.deps.tmux.listWindows()).find((w) => w.name === id && !w.dead);
    if (admitted) this.deps.ownership.assertOwner('terminal');
    if (alive) {
      this.deps.store.update((d) => {
        const cur = d.robots[id];
        if (cur) { cur.tmux = { windowId: alive.windowId, paneId: alive.paneId }; if (!this.carried(id)) delete cur.revive; delete cur.resumeError; }
      });
      const delivery = prompt ? await this.run(id, prompt, true) : undefined;
      return { ...this.robot(id), ...(delivery && { delivery }) };
    }
    const cwd = this.reviveCwd(c);
    const w = await this.deps.tmux.newWindow(id, cwd, this.robotEnv(id));
    if (!this.deps.store.state.robots[id]) {
      await this.deps.tmux.killWindow(w.windowId);
      throw new NotFound(`no robot ${id}`);
    }
    const island = this.deps.store.state.islands[c.islandId];
    if (!this.carried(id)) fresh ??= unsaved(c);
    const gone = fresh === undefined && (c.revive?.interrupted || c.agent?.kind === 'codex') ? this.goneFolder(c) : undefined;
    const moved = gone ? { from: gone, to: cwd } : undefined;
    if (c.revive?.interrupted && fresh === undefined) prompt = prompt ? `${resumeNote(moved)}\n\n${prompt}` : resumeNote(moved);
    const resuming = fresh === undefined ? resumeOf(this.deps.store.state.robots[id], this.carried(id), id) : undefined;
    try {
      const command = this.launchLine(id, withAddDirs(fresh ?? resumeHere(c.revive?.command ?? '', !!gone), [...(island?.context ?? []), ...c.context]), prompt);
      this.deps.store.update((d) => {
        const cur = d.robots[id];
        cur.tmux = { windowId: w.windowId, paneId: w.paneId };
        // one a handover has yet to answer for keeps the resume command it carries, which a retry lays it dormant with again
        if (!this.carried(id)) delete cur.revive;
        delete cur.resumeError;
        // a new session reports itself as it starts
        if (fresh !== undefined) delete cur.agent;
        // a resumed session keeps its old agent record; its stale status must not answer the next wait,
        // nor its old activity have it ended again as idle before it is up
        if (cur.agent) { settle(cur.agent, 'idle'); cur.agent.lastActivityAt = Date.now(); cur.unread = false; }
      });
      if (resuming && command) this.resuming.set(id, resuming); else this.resuming.delete(id);
      if (command) await this.deps.tmux.sendLine(w.paneId, command, true);
    } catch (e) {
      // the prompt file could not be written, or the resume never reached the pane: the window goes, or a poll would
      // take it as the robot's and drop the revive. A failed resume and its session stay, for a fresh start to retry
      this.resuming.delete(id);
      this.deps.store.update((d) => {
        const cur = d.robots[id];
        if (cur?.tmux?.windowId !== w.windowId) return;
        delete cur.tmux;
        if (c.revive) cur.revive = c.revive;
        if (c.resumeError) cur.resumeError = c.resumeError;
        if (c.agent && !cur.agent) cur.agent = c.agent;
      });
      await this.deps.tmux.killWindow(w.windowId).catch((k) => this.deps.log.error(`revive ${id}: ${String(k)}`));
      throw e;
    }
    return this.robot(id);
  }

  /**
   * Starts a new session of a dormant terminal's agent in its folder, with the launch flags its resume carries and, as
   * its first prompt, a summary of the session it could not resume, whose files stay where they are.
   */
  async startFresh(id: string, term?: 2): Promise<Robot> {
    const c = this.robot(id);
    const slot = term === 2 ? c.second : c;
    const which = term === 2 ? `${c.name}'s second terminal` : c.name;
    if (!slot?.agent || slot.tmux) throw new Invalid(`${which} has no dormant session to start afresh from`);
    if (!slot.resumeError) throw new Invalid(`${which} has no failed resume to start afresh from; revive it`);
    if (this.carried(id, term)) throw new Invalid(`${which} is still being resumed by a handover`);
    const { kind, sessionId, transcriptPath } = slot.agent;
    const prompt = repairBrief(kind, transcriptPath ? readTail(transcriptPath, 4 * 1024 * 1024) : '', { sessionId });
    const command = freshCommand(slot.revive?.command ?? '', kind, sessionId);
    return term === 2 ? this.openSecond(id, { command, prompt }) : this.reviveRobot(id, prompt, command);
  }

  // the folder a dormant terminal's transcript last records its session working in, when this machine lacks it, as a
  // handover between homes leaves it
  private goneFolder(t: TerminalSlot): string | undefined {
    const recorded = t.agent?.transcriptPath && t.revive?.command ? recordedCwd(t.agent.kind, t.agent.transcriptPath) : undefined;
    return recorded && !fs.existsSync(recorded) ? recorded : undefined;
  }

  // tmux starts a window whose folder is gone in $HOME. Claude resumes a session from any folder: a removed worktree's robot
  // goes back to its main checkout, any other to the nearest folder left. Codex resumes into the gone folder; OpenCode stops to ask
  private reviveCwd(c: Robot, term?: 2): string {
    const t = term === 2 ? c.second : c;
    const cwd = t?.cwd ?? c.cwd;
    const isDir = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();
    if (isDir(cwd)) return cwd;
    const kind = t?.revive?.command && t.agent?.kind;
    if (kind === 'codex' || kind === 'opencode') {
      const whose = term === 2 ? `${c.name}'s second terminal's` : `${c.name}'s`;
      throw new Invalid(`${whose} folder ${cwd} is gone, and ${AGENTS[kind].label} resumes its session only there; recreate the folder, or close ${c.name}`);
    }
    if (c.repo?.isWorktree && isDir(c.repo.mainRoot)) return c.repo.mainRoot;
    let dir = path.dirname(cwd);
    while (!isDir(dir)) dir = path.dirname(dir);
    return dir;
  }

  // concurrent opens would each spawn a window and orphan all but the last; a dormant second is revived here too, or
  // started `fresh` with that command and its prompt
  openSecond(id: string, fresh?: { command: string; prompt: string }): Promise<Robot> {
    const inFlight = this.openingSecond.get(id);
    if (inFlight) return inFlight;
    const p = this.doOpenSecond(id, this.writable(), fresh).finally(() => this.openingSecond.delete(id));
    this.openingSecond.set(id, p);
    return p;
  }

  private async doOpenSecond(id: string, admitted: boolean, fresh?: { command: string; prompt: string }): Promise<Robot> {
    // a second window still closing is not one to open beside
    await this.ending.get(secondName(id));
    if (admitted) this.deps.ownership.assertOwner('terminal');
    const c = this.robot(id);
    if (c.second?.tmux) return c;
    const cwd = c.second ? this.reviveCwd(c, 2) : c.cwd;
    const island = this.deps.store.state.islands[c.islandId];
    const unprompted = c.second && !this.carried(id, 2) ? unsaved(c.second) : undefined;
    if (unprompted !== undefined) fresh ??= { command: unprompted, prompt: '' };
    const revive = fresh || !c.second?.revive ? '' : resumeHere(c.second.revive.command, c.second.agent?.kind === 'codex' && !!this.goneFolder(c.second));
    const launch = withAddDirs(fresh?.command ?? revive, [...(island?.context ?? []), ...c.context]);
    const command = fresh ? this.launchLine(secondName(id), launch, fresh.prompt) : withStandalone(launch);
    const w = await this.deps.tmux.newWindow(secondName(id), cwd, this.robotEnv(id, { SVALL_TERM: '2' }));
    if (!this.deps.store.state.robots[id]) {
      await this.deps.tmux.killWindow(w.windowId);
      throw new NotFound(`no robot ${id}`);
    }
    const resuming = fresh ? undefined : resumeOf(this.deps.store.state.robots[id].second, this.carried(id, 2), id, 2);
    this.deps.store.update((d) => {
      const cur = d.robots[id];
      const second = { unread: false, ...cur.second, cwd, tmux: { windowId: w.windowId, paneId: w.paneId } };
      if (!this.carried(id, 2)) delete second.revive;
      delete second.resumeError;
      if (fresh) delete second.agent;
      // a resumed session keeps its old agent record; its stale status must not answer the next wait.
      if (second.agent) { settle(second.agent, 'idle'); second.unread = false; }
      cur.second = second;
    });
    try {
      if (resuming && command) this.resuming.set(secondName(id), resuming); else this.resuming.delete(secondName(id));
      if (command) await this.deps.tmux.sendLine(w.paneId, command, true);
    } catch (e) {
      // as a revive's: the window goes, and a failed resume and its session stay, for a fresh start to retry
      this.resuming.delete(secondName(id));
      this.deps.store.update((d) => {
        const second = d.robots[id]?.second;
        if (second?.tmux?.windowId !== w.windowId) return;
        delete second.tmux;
        if (c.second?.revive) second.revive = c.second.revive;
        if (c.second?.resumeError) second.resumeError = c.second.resumeError;
        if (c.second?.agent && !second.agent) second.agent = c.second.agent;
      });
      await this.deps.tmux.killWindow(w.windowId).catch((k) => this.deps.log.error(`open ${secondName(id)}: ${String(k)}`));
      throw e;
    }
    return this.robot(id);
  }

  // only the terminal the viewer is looking at: a surface that cannot show the second one must not clear it
  markSeen(id: string, term?: 2): Robot {
    this.robot(id);
    if (term !== 2) this.seen.set(id, Date.now());
    this.deps.store.update((d) => {
      if (term === 2) {
        const second = d.robots[id].second;
        if (second) d.robots[id].second = markSeenPure(second);
        return;
      }
      d.robots[id] = markSeenPure(d.robots[id]);
    });
    return this.robot(id);
  }

  openTab(id: string, url: string, tab?: string): BrowserTab {
    return openTab(this.deps.store, this.robot(id), url, tab);
  }

  closeTab(id: string, tab: string): void {
    closeTab(this.deps.store, this.robot(id), tab);
  }

  activateTab(id: string, tab: string): void {
    activateTab(this.deps.store, this.robot(id), tab);
  }

  updateTab(id: string, tab: string, patch: { url?: string; title?: string }): void {
    updateTab(this.deps.store, this.robot(id), tab, patch);
  }

  run(id: string, text: string, enter: boolean, term?: 2): Promise<Delivery> {
    return this.prompts.run(id, text, enter, term);
  }

  answerPrompt(id: string, answer: 'approve' | 'deny', promptId?: string): Promise<void> {
    return this.prompts.answer(id, answer, promptId);
  }

  typedAnswer(id: string, data: Buffer, asked: string | undefined): void {
    this.prompts.typed(id, data, asked);
  }

  async readScreen(id: string, lines: number, term?: 2): Promise<string> {
    return (await this.deps.tmux.capture(this.terminal(id, term).tmux.paneId, lines)).toString('utf8');
  }

  readTranscript(id: string, turns: number, term?: 2): string {
    const c = this.robot(id);
    const agent = term === 2 ? c.second?.agent : c.agent;
    if (!agent) throw new Invalid(`${c.name} has no agent${term === 2 ? ' in its second terminal' : ''}`);
    if (!agent.transcriptPath) return '';
    return condenseTurns(agent.kind, readTail(agent.transcriptPath, 4 * 1024 * 1024), turns);
  }

  readPrompts(id: string, limit: number): string[] {
    const c = this.robot(id);
    if (!c.agent) return [];
    const text = c.agent.transcriptPath ? readTail(c.agent.transcriptPath, 4 * 1024 * 1024) : '';
    return userPrompts(c.agent.kind, text, limit, c.agent.lastPrompt);
  }

  waitFor(id: string, until: AgentStatus[], timeoutMs: number, signal?: AbortSignal, term?: 2): Promise<WaitResult> {
    return this.prompts.waitFor(id, until, timeoutMs, signal, term);
  }

  /** Hears each session that starts in a terminal, once its SessionStart has landed there. */
  onSessionStart(fn: (robotId: string, term: 2 | undefined, sessionId: string) => void): () => void {
    this.on('session-start', fn);
    return () => { this.off('session-start', fn); };
  }

  async onSocketEvent(e: SocketEvent): Promise<string | undefined> {
    // a frozen source still watches its agents settle; a replica's agents belong to the owner
    if (!this.deps.ownership.isOwner()) return undefined;
    const reply = await this.agentEvents.apply(e);
    if ('hook' in e && e.hook.name === 'SessionStart') {
      const { robotId, term, sessionId, pid } = e.hook;
      this.resuming.delete(term === 2 ? secondName(robotId) : robotId);
      const c = this.deps.store.state.robots[robotId];
      if (sessionId && (term === 2 ? c?.second : c)?.agent?.sessionId === sessionId) this.emit('session-start', robotId, term, sessionId);
      // only a start the robot took: one dropped as a server's or a nested run's reads nothing
      if (pid && (term === 2 ? c?.second : c)?.agent?.pid === pid) this.track(this.rememberFlags(robotId, term, pid), `flags ${robotId}`);
    }
    return reply;
  }

  // the flags a quit resumes the agent with when ps fails it, read while the process that started the session is known
  private async rememberFlags(id: string, term: 2 | undefined, pid: number): Promise<void> {
    const procs = await this.sleep.processes().catch((e) => { this.deps.log.error(`flags ${id}: ${String(e)}`); return undefined; });
    if (!procs || this.stopped) return;
    this.deps.store.update((d) => {
      const t = term === 2 ? d.robots[id]?.second : d.robots[id];
      if (t?.agent?.pid === pid) rememberFlags(t, procs);
    });
  }
}
