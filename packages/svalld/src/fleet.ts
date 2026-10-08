import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_ISLAND, HOME_SEED, RUN_TIMEOUT_MS, cellKey, fleetNameProblem, homeSizeFor, isHomeSlot, isLand, randomPortrait, starredOf, type Agent, type AgentKind, type AgentStatus, type BrowserTab, type Cell, type Character, type ContextItem, type FleetState, type Island, type Portrait } from '@svall/protocol';
import { AGENTS, mainAgent } from './agents.js';
import { listAgentProfiles, readAgentProfile, seedAgentProfiles } from './agent-profiles.js';
import { markSeen as markSeenPure, settle } from './agent/reducer.js';
import { condenseTurns, readTail, userPrompts } from './agent/transcript.js';
import { characterKeyEnv } from './claude.js';
import { saveConfig, scribeModel, type Config } from './config.js';
import { renderBrief } from './context/brief.js';
import { isAgentCommand, promptText, withAddDirs, withoutV1Flags, withPromptFile, withStandalone } from './context/launch.js';
import { settleItems } from './context/items.js';
import { docFolders, removeDocs } from './docs.js';
import { endAll, endIdleAgents, processes, RESUME_NOTE, type Proc, type Sleep } from './dormancy.js';
import { Dormant, Invalid, NotFound } from './errors.js';
import { takenNames } from './fleets.js';
import { AgentEvents } from './fleet/agent-events.js';
import { ControlLink, type PaneEvents } from './fleet/control.js';
import { Poll } from './fleet/poll.js';
import { Prompts, type WaitResult } from './fleet/prompts.js';
import type { SocketEvent } from './hooks/receiver.js';
import { newId } from './ids.js';
import { arrangeIslands, createIsland, deleteIsland, reorderIsland, updateIsland, type IslandPatch, type NewIsland } from './islands.js';
import { blockedCells, crewOf, defaultPosition, freePosition, occupiedCells, placeOnIsland, settleHome, unfold, uniqueName } from './layout.js';
import { refreshLinks, type Deps as LinkDeps } from './links/refresh.js';
import type { Logger } from './log.js';
import { randomName } from './names.js';
import { linkOpencodeConfig, opencodePaths } from './opencode/install.js';
import { expandHome, type Paths } from './paths.js';
import { SHIM } from './profile.js';
import { reconcile, secondName, snapshot } from './reconcile.js';
import { codexRunner } from './scribe/codex.js';
import { opencodeRunner } from './scribe/opencode.js';
import { claudeRunner, perPass, type RunScribe } from './scribe/run.js';
import { Scribe, type SweepOptions } from './scribe/scribe.js';
import { installHomeTemplate } from './setup.js';
import type { Store } from './store.js';
import { activateTab, closeTab, openTab, updateTab } from './tabs.js';
import type { LiveWindow, Tmux } from './tmux/tmux.js';

type Events = PaneEvents & { stopped: [] };

// text a person writes stays theirs until they clear it; cleared, the scribe may write it again
function setNote(c: Character, note: string): void {
  c.note = note;
  if (note) c.noteSource = 'manual'; else delete c.noteSource;
}

type Deps = { store: Store; tmux: Tmux; paths: Paths; config: Config; log: Logger; pollMs?: number; staleSessionMs?: number; runTimeoutMs?: number; runScribe?: RunScribe; linkDeps?: Partial<LinkDeps>; processes?: () => Promise<Proc[]>; agentsFound?: AgentKind[] };
type LiveCharacter = Character & { tmux: NonNullable<Character['tmux']> };

export class Fleet extends EventEmitter<Events> {
  private reviving = new Map<string, Promise<Character>>();
  // the windows of agents ended for idleness, until tmux has closed them and the agent has exited
  private ending = new Map<string, Promise<void>>();
  // when the user last looked at each character's main terminal
  private seen = new Map<string, number>();
  private openingSecond = new Map<string, Promise<Character>>();
  private stopped = false;

  private scribe: Scribe;
  private sleep: Sleep;
  private link: ControlLink;
  private poll: Poll;
  private agentEvents: AgentEvents;
  private prompts: Prompts;

  constructor(private deps: Deps) {
    super();
    const { store, log, config, paths } = deps;
    const cwd = path.join(paths.home, 'scribe');
    const run = deps.runScribe ?? perPass({
      claude: claudeRunner({ model: scribeModel(config.scribe, 'claude') ?? 'sonnet', cwd, envFile: paths.env }),
      codex: codexRunner({ model: scribeModel(config.scribe, 'codex'), cwd }),
      opencode: opencodeRunner({ model: scribeModel(config.scribe, 'opencode'), cwd }),
    }, () => store.state.scribeAgent ?? 'claude');
    this.scribe = new Scribe({ store, log, run, brief: (island, c) => this.render(island, c) });
    this.sleep = { store, tmux: deps.tmux, log, processes: deps.processes ?? processes, ending: this.ending };
    this.link = new ControlLink({ store, tmux: deps.tmux, log, events: this, reconcile: () => this.reconcileNow() });
    this.poll = new Poll({ ...deps, scribe: this.scribe, listWindows: () => this.listWindows(), endIdleAgents: () => this.endIdleAgents() });
    this.agentEvents = new AgentEvents({ store, config, log, render: (island, c) => this.render(island, c) });
    this.prompts = new Prompts({ fleet: this, store, tmux: deps.tmux, reviving: this.reviving });
  }

  async start(): Promise<void> {
    await this.deps.tmux.ensureServer();
    await this.reconcileNow();
    // when the user last looked is not kept across a restart, so every agent awake now gets a whole rest from here
    const now = Date.now();
    for (const c of Object.values(this.deps.store.state.characters)) if (c.tmux) this.seen.set(c.id, now);
    this.ensureHome();
    this.syncAgents();
    this.deps.store.update((d) => { if (this.deps.config.name) d.name = this.deps.config.name; else delete d.name; });
    try { if (seedAgentProfiles(this.deps.paths.agentProfiles)) this.deps.log.info(`agent profiles -> ${this.deps.paths.agentProfiles}`); }
    catch (e) { this.deps.log.error(`agent profiles: ${String(e)}`); }
    await this.link.attach();
    this.poll.schedule();
  }

  /** Stops polling and the control client; resolves once a poll under way has finished and the fleet is on disk. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.link.stop();
    await this.poll.stop();
    this.deps.store.flush();
  }

  char(id: string): Character {
    const c = this.deps.store.state.characters[id];
    if (!Object.hasOwn(this.deps.store.state.characters, id)) throw new NotFound(`no character ${id}`);
    return c;
  }

  island(id: string): Island {
    const i = this.deps.store.state.islands[id];
    if (!Object.hasOwn(this.deps.store.state.islands, id)) throw new NotFound(`no island ${id}`);
    return i;
  }

  // a profile that is missing or cannot be used is left out, and the side card says why
  private render(island: Island, c?: Character): string {
    const p = c?.agentProfile ? readAgentProfile(this.deps.paths.agentProfiles, c.agentProfile) : undefined;
    return renderBrief(island, c, docFolders(this.deps.paths.docs, island, c), p && !('error' in p) ? p : undefined, !!c?.worktree && !this.deps.store.state.worktreesOff);
  }

  // a profile given by name must be one that can be used now; one that goes later is shown as missing
  private checkAgentProfile(name: string): void {
    const found = listAgentProfiles(this.deps.paths.agentProfiles);
    const p = found.find((x) => x.name === name);
    if (!p) throw new Invalid(`no agent profile ${name}; there are: ${found.map((x) => x.name).join(', ') || 'none'}`);
    if ('error' in p) throw new Invalid(`agent profile ${name} ${p.error}`);
  }

  brief(id: string): string {
    const c = this.char(id);
    const island = this.deps.store.state.islands[c.islandId];
    return island ? this.render(island, c) : '';
  }

  islandBrief(id: string): string {
    return this.render(this.island(id));
  }

  live(id: string): LiveCharacter {
    const c = this.char(id);
    if (!c.tmux) throw new Dormant(`${c.name} is dormant; revive it first`);
    return c as LiveCharacter;
  }

  // the terminal a call means: the main one, or the second when it says so
  terminal(id: string, term?: 2): { tmux: NonNullable<Character['tmux']>; agent?: Agent } {
    if (term !== 2) return this.live(id);
    const c = this.char(id);
    if (!c.second) throw new Invalid(`${c.name} has no second terminal`);
    return c.second;
  }

  setPaneOutput(id: string, on: boolean): void {
    this.link.setPaneOutput(id, on);
  }

  continuePane(id: string): void {
    this.link.continuePane(id);
  }

  // the windows tmux has, less those still closing for idleness, which are not to be taken back
  private async listWindows(): Promise<LiveWindow[]> {
    const ending = new Set(this.ending.keys());
    return (await this.deps.tmux.listWindows()).filter((w) => !ending.has(w.name) && !this.ending.has(w.name));
  }

  async reconcileNow(): Promise<void> {
    const before = snapshot(this.deps.store.state);
    const live = await this.listWindows();
    if (this.stopped) return;
    const { mutate, renames, unplaced } = reconcile(this.deps.store.state, live, Date.now(), before);
    this.deps.store.update(mutate);
    for (const line of unplaced) this.deps.log.error(line);
    for (const r of renames) {
      // a stray window that died since the listing must not abort startup.
      await this.deps.tmux.renameWindow(r.windowId, r.name)
        .catch((e) => this.deps.log.error(`rename ${r.windowId} -> ${r.name}: ${String(e)}`));
    }
  }

  // one home island per fleet; its cwd, command and buttons, and the fleet's default cwd, come from config on every start
  private ensureHome(): void {
    const home = this.deps.config.home;
    // a character is refused a cwd that is not a directory, so mission control's crew needs this one;
    // make the folder the buttons promise, holding the skills they call
    try { for (const l of installHomeTemplate(home.cwd, { replaceSettings: false })) this.deps.log.info(l); }
    catch (e) { this.deps.log.error(`home cwd ${home.cwd}: ${String(e)}`); }
    // the directory a crewless island starts in; it is the user's folder, so never create it
    const cwd = this.deps.config.defaultCwd;
    if (!fs.statSync(expandHome(cwd), { throwIfNoEntry: false })?.isDirectory()) {
      this.deps.log.error(`default cwd ${cwd} is not a directory: characters cannot start there`);
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
    // a new fleet opens with one empty island beside mission control; only its first start makes it, so a deleted one stays gone
    if (first) this.createIsland({ name: 'Island 1' });
  }

  private endIdleAgents(): Promise<void> {
    return endIdleAgents(this.sleep, this.seen, () => this.stopped);
  }

  /** Ends every terminal as the app quits: each character goes dormant with the revive that resumes it, then the
   * tmux server goes, and nothing runs again until a character is opened. */
  async stopAll(): Promise<void> {
    // the control client's exit would otherwise start a server again, and a poll under way write back what this ends
    await this.stop();
    await endAll(this.sleep, this.reviving);
    setImmediate(() => this.emit('stopped'));
  }

  setWorktrees(enabled: boolean): void {
    this.deps.store.update((d) => { if (enabled) delete d.worktreesOff; else d.worktreesOff = true; });
  }

  setRobots(enabled: boolean): void {
    this.deps.store.update((d) => { if (enabled) d.robots = true; else delete d.robots; });
  }

  setDormancy(hours: number): void {
    this.deps.store.update((d) => { d.dormantAfterHours = hours; });
  }

  // config.json's home.command, else the main agent's
  private crewCommand(): string {
    return this.deps.config.home.command ?? AGENTS[mainAgent(this.deps.config.mainAgent, this.deps.agentsFound ?? [])].crewCommand;
  }

  // config.json holds the choice; the fleet carries it, and what svalld finds, to the app
  private syncAgents(): void {
    const found = this.deps.agentsFound ?? [];
    this.deps.store.update((d) => {
      d.mainAgent = mainAgent(this.deps.config.mainAgent, found);
      d.agentsFound = found;
      d.scribeAgent = this.deps.config.scribe.agent ?? d.mainAgent;
      d.home.command = this.crewCommand();
    });
  }

  setMainAgent(agent: AgentKind): void {
    if (!(this.deps.agentsFound ?? []).includes(agent)) {
      throw new Invalid(`svalld doesn't find ${AGENTS[agent].bin}; install ${AGENTS[agent].label}, then run ${SHIM} setup`);
    }
    saveConfig(this.deps.paths.config, { mainAgent: agent });
    this.deps.config.mainAgent = agent;
    this.syncAgents();
  }

  // only the label changes: the directory, launchd label, tmux socket and ports stay
  renameFleet(name: string): void {
    const problem = fleetNameProblem(name, takenNames(os.homedir(), this.deps.paths.home));
    if (problem) throw new Invalid(problem);
    saveConfig(this.deps.paths.config, { name });
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

  async createCharacter(p: { islandId: string; cwd: string; name?: string; command?: string; cell?: Cell; run?: string; agentProfile?: string }): Promise<Character & { runSent?: boolean }> {
    if (p.run && !p.command) throw new Invalid('run needs a command to start the agent');
    this.island(p.islandId);
    if (p.agentProfile) this.checkAgentProfile(p.agentProfile);
    if (p.cell) {
      this.checkCell(this.island(p.islandId), p.cell);
      if (occupiedCells(this.deps.store.state, p.islandId).has(cellKey(p.cell))) throw new Invalid(`cell ${cellKey(p.cell)} is occupied`);
      if (blockedCells(this.deps.store.state, p.islandId).has(cellKey(p.cell))) throw new Invalid(`cell ${cellKey(p.cell)} touches another character`);
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
    // the path tmux reports for a pane started here, as for /tmp, so a poll moves the character only once the pane moves
    const panePath = fs.realpathSync(cwd);
    const prompt = p.command && isAgentCommand(p.command) ? p.run : undefined;
    const w = await this.deps.tmux.newWindow(id, cwd, this.charEnv(id));
    try {
      this.deps.store.update((d) => {
        // a name asked for twice, as a button pressed twice does, gets a number
        const names = Object.values(d.characters).map((c) => c.name);
        d.characters[id] = {
          id, islandId: p.islandId, cell: p.cell ?? placeOnIsland(d, p.islandId, undefined, this.deps.log),
          name: uniqueName(names, p.name ?? randomName(new Set(names))),
          portrait: randomPortrait(new Set(Object.values(d.characters).map((c) => c.portrait))),
          note: '', instructions: '', ...(p.agentProfile && { agentProfile: p.agentProfile }), ...(p.run && { worktree: true as const }), cwd, panePath, context: [],
          tmux: { windowId: w.windowId, paneId: w.paneId },
          shell: { lastOutputAt: Date.now() }, unread: false,
        };
        // a hidden island comes back to take the character, as one placed there for it does
        if (p.cell && d.islands[p.islandId].collapsed) unfold(d, p.islandId, this.deps.log);
      });
      if (p.command) await this.deps.tmux.sendLine(w.paneId, this.launchLine(id, withAddDirs(p.command, this.deps.store.state.islands[p.islandId].context), prompt), true);
    } catch (e) {
      // the island filled up while the window was being created, or the start command never reached the
      // pane: neither an orphan window nor a half-created character survives
      if (prompt) fs.rmSync(this.promptFile(id), { force: true });
      this.deps.store.update((d) => { delete d.characters[id]; });
      await this.deps.tmux.killWindow(w.windowId);
      throw e;
    }
    refreshLinks(this.deps.store, this.deps.config, id).catch((e) => this.deps.log.error(`links ${id}: ${String(e)}`));
    if (!p.run) return this.char(id);
    const timeoutMs = this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    let runSent = await this.prompts.waitForAgent(id, timeoutMs);
    // an agent has its prompt already, and submits it once it is up
    if (prompt) return { ...this.char(id), runSent: true };
    if (runSent) {
      // the window can die between the agent attaching and the send; the character stays, without its prompt
      try { await this.run(id, p.run, true); } catch { runSent = false; }
    }
    // Claude Code asks whether an unfamiliar directory is trusted before it starts, and reports in only
    // once answered: the whole wait passes with the pane sitting on the question, which is worth a line
    if (!runSent) this.deps.log.error(`character ${id}: no agent reported in within ${timeoutMs}ms, prompt not sent`);
    return { ...this.char(id), runSent };
  }

  private charEnv(id: string, extra: Record<string, string> = {}): Record<string, string> {
    return { ...characterKeyEnv(this.deps.paths.env), SVALL_CHAR_ID: id, SVALL_HOME: this.deps.paths.home, ...this.opencodeEnv(), ...extra };
  }

  private opencodeEnv(): Record<string, string> {
    const o = opencodePaths();
    // only where OpenCode is, as for the plugin: a config folder made here would pass for an install
    if (!(this.deps.config.integrations?.includes('opencode') ?? true) || !(this.deps.agentsFound?.includes('opencode') || fs.existsSync(o.dir))) return {};
    const { opencodeConfig, opencodeReplaced } = this.deps.paths;
    try {
      for (const f of linkOpencodeConfig(opencodeConfig, o, opencodeReplaced)) this.deps.log.error(`opencode config: ${f}`);
      return { OPENCODE_CONFIG_DIR: opencodeConfig };
    } catch (e) {
      this.deps.log.error(`opencode config: ${(e as Error).message}`);
      return {};
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

  // the cell before the islandId, or the character's stale cell would count as occupied on the target island
  private placeOn(d: FleetState, id: string, islandId: string): void {
    const cell = placeOnIsland(d, islandId, id, this.deps.log);
    d.characters[id].islandId = islandId;
    d.characters[id].cell = cell;
  }

  /** A profile renamed in its folder takes the characters that use it along. */
  renameAgentProfile(from: string, to: string): void {
    this.deps.store.update((d) => { for (const c of Object.values(d.characters)) if (c.agentProfile === from) c.agentProfile = to; });
  }

  updateCharacter(id: string, patch: {
    name?: string; note?: string; instructions?: string; agentProfile?: string; islandId?: string; context?: ContextItem[]; portrait?: Portrait; robot?: number;
  }): Character {
    const current = this.char(id);
    if (patch.islandId) this.island(patch.islandId);
    if (patch.agentProfile) this.checkAgentProfile(patch.agentProfile);
    // names resolve without regard to case, so a twin would leave both characters unreachable by name
    const clash = patch.name !== undefined && Object.values(this.deps.store.state.characters)
      .find((c) => c.id !== id && c.name.toLowerCase() === patch.name!.toLowerCase());
    if (clash) throw new Invalid(`another character is already called ${clash.name}`);
    const context = patch.context && settleItems(patch.context, current.context);
    this.deps.store.update((d) => {
      const c = d.characters[id];
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.portrait !== undefined) c.portrait = patch.portrait;
      if (patch.robot !== undefined) c.robot = patch.robot;
      if (patch.note !== undefined) setNote(c, patch.note);
      if (patch.instructions !== undefined) c.instructions = patch.instructions;
      if (patch.agentProfile) c.agentProfile = patch.agentProfile;
      else if (patch.agentProfile === '') delete c.agentProfile;
      if (context) c.context = context;
      if (patch.islandId && patch.islandId !== c.islandId) this.placeOn(d, id, patch.islandId);
    });
    return this.char(id);
  }

  // one store update: a swap must never be observed half done
  moveCharacter(id: string, islandId: string, cell?: Cell): Character {
    this.char(id);   // whichever path runs, the character has to exist
    const island = this.island(islandId);
    // without a cell the fleet picks one and grows the island to fit, even on the island the character already stands on
    if (!cell) {
      this.deps.store.update((d) => this.placeOn(d, id, islandId));
      return this.char(id);
    }
    this.checkCell(island, cell);
    const state = this.deps.store.state;
    const occupant = Object.values(state.characters).find((o) => o.id !== id && o.islandId === islandId && cellKey(o.cell) === cellKey(cell));
    if (!occupant && blockedCells(state, islandId, id).has(cellKey(cell))) throw new Invalid(`cell ${cellKey(cell)} touches another character`);
    this.deps.store.update((d) => {
      const c = d.characters[id];
      const other = occupant ? d.characters[occupant.id] : undefined;
      if (other) { other.islandId = c.islandId; other.cell = c.cell; }
      c.islandId = islandId;
      c.cell = cell;
      if (d.islands[islandId].collapsed) unfold(d, islandId, this.deps.log);
    });
    return this.char(id);
  }

  // a cell asked for by name is one of mission control's slots, or land on any other island
  private checkCell(island: Island, cell: Cell): void {
    if (island.kind === 'home' && !isHomeSlot(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not a home slot`);
    if (!isLand(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not land`);
  }

  // A sidebar drop inserts into the target crew in one update. On another island it first
  // makes room there; within one island it rotates only the occupied cells between the rows.
  reorderCharacter(id: string, targetId: string, after: boolean): Character {
    const moving = this.char(id);
    const target = this.char(targetId);
    if (id === targetId) return moving;
    this.deps.store.update((d) => {
      if (moving.islandId !== target.islandId) this.placeOn(d, id, target.islandId);
      const crew = crewOf(d, target.islandId).map((charId) => d.characters[charId]);
      const cells = crew.map((c) => c.cell);
      const order = crew.map((c) => c.id).filter((c) => c !== id);
      order.splice(order.indexOf(targetId) + Number(after), 0, id);
      order.forEach((charId, index) => { d.characters[charId].cell = cells[index]; });
    });
    return this.char(id);
  }

  // without a target the star goes first; every starred character is numbered anew in one update
  starCharacter(id: string, targetId?: string, after = false): Character {
    this.char(id);
    if (targetId !== undefined && this.char(targetId).star === undefined) throw new Invalid(`${this.char(targetId).name} is not starred`);
    if (id === targetId) return this.char(id);
    const order = starredOf(this.deps.store.state).map((c) => c.id).filter((x) => x !== id);
    order.splice(targetId === undefined ? 0 : order.indexOf(targetId) + Number(after), 0, id);
    this.deps.store.update((d) => { order.forEach((x, n) => { d.characters[x].star = n; }); });
    return this.char(id);
  }

  unstarCharacter(id: string): Character {
    this.char(id);
    this.deps.store.update((d) => { delete d.characters[id].star; });
    return this.char(id);
  }

  async closeCharacter(id: string): Promise<void> {
    // out of the state before any await, so a revive or second terminal opening meanwhile kills its own window
    const c = this.char(id);
    this.deps.store.update((d) => { delete d.characters[id]; });
    if (c.tmux) await this.deps.tmux.killWindow(c.tmux.windowId);
    if (c.second) await this.deps.tmux.killWindow(c.second.tmux.windowId);
    // nothing the fleet keeps outside the state outlives the character
    this.seen.delete(id);
    for (const m of [this.link, this.poll, this.agentEvents, this.prompts, this.scribe]) m.forget(id);
    removeDocs(this.deps.paths.docs, 'character', id, this.deps.log);
  }

  /** Revives every character whose agent a quit, reboot or crash ended mid-turn; called once hooks can reach the fleet. */
  async resumeInterrupted(): Promise<void> {
    const ids = Object.values(this.deps.store.state.characters).filter((c) => c.revive?.interrupted).map((c) => c.id);
    await Promise.all(ids.map((id) => this.reviveCharacter(id).catch((e) => this.deps.log.error(`resume ${id}: ${String(e)}`))));
  }

  // concurrent revives would each spawn a window and orphan all but the last.
  reviveCharacter(id: string, prompt?: string): Promise<Character> {
    // a page still open on a character that the stop has just put to sleep would wake it again
    if (this.stopped) return Promise.reject(new Invalid('the fleet is stopping'));
    const inFlight = this.reviving.get(id);
    if (inFlight) return inFlight;
    const p = this.doRevive(id, prompt).finally(() => this.reviving.delete(id));
    this.reviving.set(id, p);
    return p;
  }

  private async doRevive(id: string, prompt?: string): Promise<Character> {
    // a window still closing for idleness is not one to go back to
    await this.ending.get(id);
    const c = this.char(id);
    if (c.tmux) return c;
    // a character marked dormant while its window lived goes back to that window; a new one would run the resume twice
    const alive = (await this.deps.tmux.listWindows()).find((w) => w.name === id && !w.dead);
    if (alive) {
      this.deps.store.update((d) => {
        const cur = d.characters[id];
        if (cur) { cur.tmux = { windowId: alive.windowId, paneId: alive.paneId }; delete cur.revive; }
      });
      if (prompt) await this.run(id, prompt, true);
      return this.char(id);
    }
    const w = await this.deps.tmux.newWindow(id, c.cwd, this.charEnv(id));
    if (!this.deps.store.state.characters[id]) {
      await this.deps.tmux.killWindow(w.windowId);
      throw new NotFound(`no character ${id}`);
    }
    const island = this.deps.store.state.islands[c.islandId];
    if (c.revive?.interrupted) prompt = prompt ? `${RESUME_NOTE}\n\n${prompt}` : RESUME_NOTE;
    const command = this.launchLine(id, withAddDirs(withoutV1Flags(c.revive?.command ?? ''), [...(island?.context ?? []), ...c.context]), prompt);
    this.deps.store.update((d) => {
      const cur = d.characters[id];
      cur.tmux = { windowId: w.windowId, paneId: w.paneId };
      delete cur.revive;
      // a resumed session keeps its old agent record; its stale status must not answer the next wait,
      // nor its old activity have it ended again as idle before it is up
      if (cur.agent) { settle(cur.agent, 'idle'); cur.agent.lastActivityAt = Date.now(); cur.unread = false; }
    });
    if (command) await this.deps.tmux.sendLine(w.paneId, command, true);
    return this.char(id);
  }

  // concurrent opens would each spawn a window and orphan all but the last.
  openSecond(id: string): Promise<Character> {
    const inFlight = this.openingSecond.get(id);
    if (inFlight) return inFlight;
    const p = this.doOpenSecond(id).finally(() => this.openingSecond.delete(id));
    this.openingSecond.set(id, p);
    return p;
  }

  private async doOpenSecond(id: string): Promise<Character> {
    const c = this.char(id);
    if (c.second) return c;
    const w = await this.deps.tmux.newWindow(secondName(id), c.cwd, this.charEnv(id, { SVALL_TERM: '2' }));
    if (!this.deps.store.state.characters[id]) {
      await this.deps.tmux.killWindow(w.windowId);
      throw new NotFound(`no character ${id}`);
    }
    this.deps.store.update((d) => { d.characters[id].second = { tmux: { windowId: w.windowId, paneId: w.paneId }, unread: false }; });
    return this.char(id);
  }

  // only the terminal the viewer is looking at: a surface that cannot show the second one must not clear it
  markSeen(id: string, term?: 2): Character {
    this.char(id);
    if (term !== 2) this.seen.set(id, Date.now());
    this.deps.store.update((d) => {
      if (term === 2) {
        const second = d.characters[id].second;
        if (second) d.characters[id].second = markSeenPure(second);
        return;
      }
      d.characters[id] = markSeenPure(d.characters[id]);
    });
    return this.char(id);
  }

  openTab(id: string, url: string, tab?: string): BrowserTab {
    return openTab(this.deps.store, this.char(id), url, tab);
  }

  closeTab(id: string, tab: string): void {
    closeTab(this.deps.store, this.char(id), tab);
  }

  activateTab(id: string, tab: string): void {
    activateTab(this.deps.store, this.char(id), tab);
  }

  updateTab(id: string, tab: string, patch: { url?: string; title?: string }): void {
    updateTab(this.deps.store, this.char(id), tab, patch);
  }

  run(id: string, text: string, enter: boolean, term?: 2): Promise<void> {
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
    const c = this.char(id);
    const agent = term === 2 ? c.second?.agent : c.agent;
    if (!agent) throw new Invalid(`${c.name} has no agent${term === 2 ? ' in its second terminal' : ''}`);
    if (!agent.transcriptPath) return '';
    return condenseTurns(agent.kind, readTail(agent.transcriptPath, 4 * 1024 * 1024), turns);
  }

  readPrompts(id: string, limit: number): string[] {
    const c = this.char(id);
    if (!c.agent) return [];
    const text = c.agent.transcriptPath ? readTail(c.agent.transcriptPath, 4 * 1024 * 1024) : '';
    return userPrompts(c.agent.kind, text, limit, c.agent.lastPrompt);
  }

  waitFor(id: string, until: AgentStatus[], timeoutMs: number, signal?: AbortSignal, term?: 2): Promise<WaitResult> {
    return this.prompts.waitFor(id, until, timeoutMs, signal, term);
  }

  onSocketEvent(e: SocketEvent): string | undefined {
    return this.agentEvents.apply(e);
  }
}
