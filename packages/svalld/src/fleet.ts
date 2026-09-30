import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DORMANT_AFTER_HOURS, HOME_ISLAND, HOME_SEED, RUN_TIMEOUT_MS, cellKey, fleetNameProblem, homeSizeFor, isHomeSlot, isLand, randomPortrait, type Agent, type AgentKind, type AgentStatus, type BrowserTab, type Cell, type Character, type ContextItem, type Island, type Portrait } from '@svall/protocol';
import { AGENTS, mainAgent } from './agents.js';
import { listAgentProfiles, readAgentProfile, seedAgentProfiles } from './agent-profiles.js';
import { lastTokenCount } from './agent/codex-transcript.js';
import { followRollout, type RolloutMark } from './agent/codex-workdir.js';
import { applyHook, applyStatus, markSeen as markSeenPure, type Slot } from './agent/reducer.js';
import { condenseTurns, readTail, userPrompts } from './agent/transcript.js';
import { characterKeyEnv } from './claude.js';
import { saveConfig, scribeModel, type Config } from './config.js';
import { briefReply, renderBrief } from './context/brief.js';
import { takesPrompt, withAddDirs, withPromptFile } from './context/launch.js';
import { settleItems } from './context/items.js';
import { docFolders, removeDocs } from './docs.js';
import { drowsy, exited, processes, runsInBackground, startFlags, type Proc } from './dormancy.js';
import { Dormant, Invalid, NotFound } from './errors.js';
import { takenNames } from './fleets.js';
import type { SocketEvent } from './hooks/receiver.js';
import { newId } from './ids.js';
import { arrangeIslands, createIsland, deleteIsland, reorderIsland, updateIsland, type IslandPatch, type NewIsland } from './islands.js';
import { blockedCells, defaultPosition, freePosition, occupiedCells, settleHome } from './layout.js';
import { resolveRepo } from './links/git.js';
import { refreshLinks, refreshMany, slice, type Deps as LinkDeps } from './links/refresh.js';
import type { Logger } from './log.js';
import { randomName } from './names.js';
import { expandHome, type Paths } from './paths.js';
import { markDormant, placeOnIsland, reconcile, secondName } from './reconcile.js';
import { codexRunner } from './scribe/codex.js';
import { claudeRunner, perPass, type RunScribe } from './scribe/run.js';
import { Scribe, type SweepOptions } from './scribe/scribe.js';
import { installHomeTemplate } from './setup.js';
import type { Store } from './store.js';
import { activateTab, closeTab, openTab, updateTab } from './tabs.js';
import type { ControlClient } from './tmux/control.js';
import { isShellCommand, type Tmux } from './tmux/tmux.js';

type Events = {
  output: [charId: string, data: Buffer];
  pause: [charId: string];
  continue: [charId: string];
  'control-reset': [];
};

// text a person writes stays theirs until they clear it; cleared, the scribe may write it again
function setNote(c: Character, note: string): void {
  c.note = note;
  if (note) c.noteSource = 'manual'; else delete c.noteSource;
}

export { Dormant, Invalid, NotFound };

type Deps = { store: Store; tmux: Tmux; paths: Paths; config: Config; log: Logger; pollMs?: number; staleSessionMs?: number; runTimeoutMs?: number; runScribe?: RunScribe; linkDeps?: Partial<LinkDeps>; processes?: () => Promise<Proc[]>; agentsFound?: AgentKind[] };
type LiveCharacter = Character & { tmux: NonNullable<Character['tmux']> };
export type WaitResult = AgentStatus | 'timeout' | 'gone';

// the ticks between looks for agents idle long enough to end
const DORMANCY_EVERY = 20;

export class Fleet extends EventEmitter<Events> {
  private control?: ControlClient;
  private poll?: NodeJS.Timeout;
  private ticks = 0;
  private shellStreak = new Map<string, number>();
  private codexStreak = new Map<string, number>();
  private hookCwd = new Map<string, string>();
  private rolloutMark = new Map<string, RolloutMark>();
  private reviving = new Map<string, Promise<Character>>();
  // the windows of agents ended for idleness, until tmux has closed them and the agent has exited
  private ending = new Map<string, Promise<void>>();
  // when the user last looked at each character's main terminal
  private seen = new Map<string, number>();
  // one link sweep at a time, so the cap on characters out asking holds across ticks; the characters a
  // tick found moved wait in `pendingLinks` for the sweep that follows the one running
  private sweeping = false;
  private pendingLinks = new Set<string>();
  private openingSecond = new Map<string, Promise<Character>>();
  // the question each character's answer is being typed for, kept when the fleet could not be written after it,
  // so a second answer to it is refused rather than typed too
  private answering = new Map<string, string | undefined>();
  // tmux stops reading a pane's pty once every client has it off, which freezes the pane;
  // output is filtered here instead.
  private streaming = new Set<string>();
  private stopped = false;

  private scribe: Scribe;

  constructor(private deps: Deps) {
    super();
    const { store, log, config, paths } = deps;
    const cwd = path.join(paths.home, 'scribe');
    const run = deps.runScribe ?? perPass({
      claude: claudeRunner({ model: scribeModel(config.scribe, 'claude') ?? 'sonnet', cwd, envFile: paths.env }),
      codex: codexRunner({ model: scribeModel(config.scribe, 'codex'), cwd }),
    }, () => store.state.scribeAgent ?? 'claude');
    this.scribe = new Scribe({ store, log, run, brief: (island, c) => this.render(island, c) });
  }

  async start(): Promise<void> {
    await this.deps.tmux.ensureServer();
    await this.reconcileNow();
    this.ensureHome();
    this.syncAgents();
    this.deps.store.update((d) => { if (this.deps.config.name) d.name = this.deps.config.name; else delete d.name; });
    try { if (seedAgentProfiles(this.deps.paths.agentProfiles)) this.deps.log.info(`agent profiles -> ${this.deps.paths.agentProfiles}`); }
    catch (e) { this.deps.log.error(`agent profiles: ${String(e)}`); }
    await this.attachControl();
    this.poll = setInterval(() => {
      this.tick().catch((e) => this.deps.log.error(`poll: ${String(e)}`));
    }, this.deps.pollMs ?? 3000);
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.control?.stop();
  }

  // ---- lookups

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
    return renderBrief(island, c, docFolders(this.deps.paths.docs, island, c), p && !('error' in p) ? p : undefined);
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

  private charByPane(paneId: string): string | undefined {
    return Object.values(this.deps.store.state.characters).find((c) => c.tmux?.paneId === paneId)?.id;
  }

  private charByWindow(windowId: string): string | undefined {
    return Object.values(this.deps.store.state.characters).find((c) => c.tmux?.windowId === windowId)?.id;
  }

  // ---- control client

  private async attachControl(): Promise<void> {
    const c = this.deps.tmux.connect();
    c.on('output', (paneId, data) => { const id = this.charByPane(paneId); if (id && this.streaming.has(id)) this.emit('output', id, data); });
    c.on('pause', (paneId) => { const id = this.charByPane(paneId); if (id) this.emit('pause', id); });
    c.on('continue', (paneId) => { const id = this.charByPane(paneId); if (id) this.emit('continue', id); });
    c.on('window-close', (windowId) => { void this.windowClosed(windowId); });
    // a client that exits before it is ready fails start, and the caller's retry is the one recovery
    let ready = false;
    c.once('ready', () => { ready = true; });
    c.on('exit', (reason) => {
      this.deps.log.error(`control client lost: ${reason}`);
      this.control = undefined;
      if (ready && !this.stopped) setTimeout(() => this.recover(), 1000);
    });
    await c.start();
    c.send('refresh-client -f pause-after=3');
    this.control = c;
  }

  // tmux also reports a close when a viewer session holding a linked window goes away
  private async windowClosed(windowId: string): Promise<void> {
    if (await this.deps.tmux.hasWindow(windowId)) return;
    const id = this.charByWindow(windowId);
    if (id) { this.deps.store.update((d) => { const ch = d.characters[id]; if (ch) markDormant(ch); }); return; }
    const owner = Object.values(this.deps.store.state.characters).find((ch) => ch.second?.tmux.windowId === windowId)?.id;
    if (owner) this.deps.store.update((d) => { delete d.characters[owner]?.second; });
  }

  private async recover(delayMs = 1000): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deps.tmux.ensureServer();
      await this.reconcileNow();
      await this.attachControl();
      this.emit('control-reset');
    } catch (e) {
      this.deps.log.error(`recover failed: ${String(e)}`);
      setTimeout(() => this.recover(Math.min(delayMs * 2, 30_000)), delayMs);
    }
  }

  setPaneOutput(id: string, on: boolean): void {
    if (on) this.streaming.add(id); else this.streaming.delete(id);
  }

  continuePane(id: string): void {
    const c = this.deps.store.state.characters[id];
    if (c?.tmux) this.control?.send(`refresh-client -A '${c.tmux.paneId}:continue'`);
  }

  // ---- reconciliation and polling

  async reconcileNow(): Promise<void> {
    const windowOf = new Map(Object.values(this.deps.store.state.characters).map((c) => [c.id, c.tmux?.windowId]));
    const hadSecond = new Set(Object.values(this.deps.store.state.characters).filter((c) => c.second).map((c) => c.id));
    const ending = new Set(this.ending.keys());
    // a window still closing for idleness is not one to take back
    const live = (await this.deps.tmux.listWindows()).filter((w) => !ending.has(w.name) && !this.ending.has(w.name));
    // as in the poll, a character created or revived during the await is not known to the listing
    const known = new Set(Object.values(this.deps.store.state.characters).filter((c) => windowOf.get(c.id) === c.tmux?.windowId).map((c) => c.id));
    const { mutate, renames, unplaced } = reconcile(this.deps.store.state, live, Date.now(), known, hadSecond);
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
  }

  private async tick(): Promise<void> {
    // a create or revive during the await makes a window the listing lacks: only a character still on the
    // window it had before is marked dormant
    const windowOf = new Map(Object.values(this.deps.store.state.characters).map((c) => [c.id, c.tmux?.windowId]));
    // a second terminal opened during the await is absent from the listing and must not be dropped
    const hadSecond = new Set(Object.values(this.deps.store.state.characters).filter((c) => c.second).map((c) => c.id));
    const ending = new Set(this.ending.keys());
    const live = await this.deps.tmux.listWindows();
    const byName = new Map(live.map((w) => [w.name, w]));
    const cwdChanged: string[] = [];
    // an agent whose pane is back at a shell prompt for two polls has ended without a SessionEnd
    const settleAgent = (key: string, slot: { agent?: Agent }, command: string) => {
      if (slot.agent && isShellCommand(command)) {
        const n = (this.shellStreak.get(key) ?? 0) + 1;
        this.shellStreak.set(key, n);
        if (n >= 2) { delete slot.agent; this.shellStreak.delete(key); }
      } else {
        this.shellStreak.delete(key);
      }
    };
    this.deps.store.update((d) => {
      for (const c of Object.values(d.characters)) {
        const w2 = byName.get(secondName(c.id));
        if (w2 && !w2.dead) {
          c.second = { unread: false, ...c.second, tmux: { windowId: w2.windowId, paneId: w2.paneId } };
          settleAgent(secondName(c.id), c.second, w2.command);
        } else if (hadSecond.has(c.id)) {
          delete c.second;
        }
        const w = byName.get(c.id);
        if (!w || w.dead) {
          if (c.tmux && windowOf.get(c.id) === c.tmux.windowId) markDormant(c);
          continue;
        }
        // a live window for a dormant character means the dormancy was spurious: re-attach. One made dormant
        // during the listing, or ended while it was taken, is still closing the window the listing saw
        if (!c.tmux) {
          if (windowOf.get(c.id) || ending.has(c.id) || this.ending.has(c.id)) continue;
          c.tmux = { windowId: w.windowId, paneId: w.paneId };
          delete c.revive;
        }
        // the pane's path moves only when the agent process itself changes directory; between moves the hooks may have placed it.
        // tmux reports no path while a setuid program such as sudo runs in the pane
        if (w.path && c.panePath !== w.path) {
          c.panePath = w.path;
          if (c.cwd !== w.path) { c.cwd = w.path; cwdChanged.push(c.id); }
        }
        settleAgent(c.id, c, w.command);
        // shown only where there is no agent's own activity to show
        if (!c.agent) c.shell.lastOutputAt = w.activity;
        // Codex should report promptly; three polls without an event means delivery needs attention.
        if (!c.agent && w.command === 'codex') {
          const n = (this.codexStreak.get(c.id) ?? 0) + 1;
          this.codexStreak.set(c.id, n);
          if (n >= 3) c.hint = 'codex-silent';
        } else {
          this.codexStreak.delete(c.id);
          delete c.hint;
        }
      }
    });
    this.ticks++;
    // the fleet's links are looked at a slice per tick, so the whole crew never spawns git and gh in the same breath
    const awake = Object.values(this.deps.store.state.characters).filter((c) => c.tmux).map((c) => c.id);
    for (const id of cwdChanged) this.pendingLinks.add(id);
    if (!this.sweeping) {
      const toRefresh = [...new Set([...this.pendingLinks, ...slice(awake, this.ticks)])];
      this.pendingLinks.clear();
      this.sweeping = true;
      void refreshMany(this.deps.store, this.deps.config, toRefresh, this.deps.linkDeps)
        .catch((e) => this.deps.log.error(`links: ${String(e)}`))
        .finally(() => { this.sweeping = false; });
    }
    this.scribe.tick();
    if (this.ticks % 10 === 0) await this.sweepViewerSessions();
    if (this.ticks % DORMANCY_EVERY === 0) await this.endIdleAgents();
  }

  // an agent idle past the fleet's limit is ended to free what it holds; its character goes dormant, and a revive
  // resumes the session with the launch flags it still needs
  private async endIdleAgents(): Promise<void> {
    const hours = this.deps.store.state.dormantAfterHours ?? DORMANT_AFTER_HOURS;
    if (!hours) return;
    const afterMs = hours * 3_600_000;
    const due = (c: Character) => drowsy(c, Date.now(), afterMs, this.seen.get(c.id));
    const idle = Object.values(this.deps.store.state.characters).filter(due);
    if (!idle.length) return;
    const procs = await (this.deps.processes ?? processes)();
    for (const c of idle) {
      const a = c.agent!;
      // a pid gone or moved on to another program, a launch the resume can't repeat, work going on in the background,
      // or no transcript to resume from leaves the agent be
      const proc = procs.find((p) => p.pid === a.pid);
      const flags = proc && startFlags(proc.args, a.kind);
      if (!proc || !flags || runsInBackground(proc.pid, procs) || !a.transcriptPath || !fs.existsSync(a.transcriptPath)) continue;
      // a prompt, a close or a revive while ps ran leaves it be
      const cur = this.deps.store.state.characters[c.id];
      if (!cur?.tmux || cur.tmux.windowId !== c.tmux?.windowId || !due(cur)) continue;
      // dormant before the kill: the SessionEnd the kill sends then finds no live character to clear
      this.deps.store.update((d) => { markDormant(d.characters[c.id], flags); });
      const closing = this.deps.tmux.killWindow(cur.tmux.windowId).then(
        () => exited(proc.pid).then(() => this.deps.log.info(`${cur.name} dormant after ${hours} h idle`)),
        (e) => this.deps.log.error(`dormant ${c.id}: ${String(e)}`),
      );
      this.ending.set(c.id, closing);
      await closing;
      this.ending.delete(c.id);
    }
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
      throw new Invalid(`svalld doesn't find ${AGENTS[agent].bin}; install ${AGENTS[agent].label}, then run svall setup`);
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

  // a desktop terminal that never attached leaves its v-<charId> session behind
  private async sweepViewerSessions(): Promise<void> {
    const staleMs = this.deps.staleSessionMs ?? 60_000;
    for (const s of await this.deps.tmux.listSessions()) {
      if (s.name.startsWith('v-') && s.attached === 0 && Date.now() - s.created > staleMs) await this.deps.tmux.killSession(s.name);
    }
  }

  // ---- islands

  createIsland(p: NewIsland): Island {
    return createIsland(this.deps, p);
  }

  updateIsland(id: string, patch: IslandPatch): Island {
    return updateIsland(this.deps, id, patch);
  }

  arrangeIslands(aspect?: number): void {
    arrangeIslands(this.deps, aspect);
  }

  reorderIsland(id: string, targetId: string, after: boolean): Island {
    return reorderIsland(this.deps, id, targetId, after);
  }

  deleteIsland(id: string): void {
    deleteIsland(this.deps, id);
  }

  // ---- characters

  async createCharacter(p: { islandId: string; cwd: string; name?: string; command?: string; cell?: Cell; run?: string; agentProfile?: string }): Promise<Character & { runSent?: boolean }> {
    if (p.run && !p.command) throw new Invalid('run needs a command to start the agent');
    this.island(p.islandId);
    if (p.agentProfile) this.checkAgentProfile(p.agentProfile);
    if (p.cell) {
      if (this.deps.store.state.islands[p.islandId].kind === 'home' && !isHomeSlot(this.deps.store.state.islands[p.islandId], p.cell)) throw new Invalid(`cell ${cellKey(p.cell)} is not a home slot`);
      if (!isLand(this.deps.store.state.islands[p.islandId], p.cell)) throw new Invalid(`cell ${cellKey(p.cell)} is not land`);
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
    // typed into claude's composer while it boots, a long prompt can arrive in pieces that swallow the Enter
    const prompt = p.command && takesPrompt(p.command) ? p.run : undefined;
    const promptFile = path.join(this.deps.paths.home, `${id}.prompt`);
    const w = await this.deps.tmux.newWindow(id, cwd, { ...characterKeyEnv(this.deps.paths.env), SVALL_CHAR_ID: id, SVALL_HOME: this.deps.paths.home });
    try {
      this.deps.store.update((d) => {
        // names resolve without regard to case, so a name asked for twice, as a button pressed twice does, gets a number
        const taken = new Set(Object.values(d.characters).map((c) => c.name.toLowerCase()));
        const base = p.name ?? randomName(new Set(Object.values(d.characters).map((c) => c.name)));
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
        d.characters[id] = {
          id, islandId: p.islandId, cell: p.cell ?? placeOnIsland(d, p.islandId),
          name,
          portrait: randomPortrait(new Set(Object.values(d.characters).map((c) => c.portrait))),
          note: '', instructions: '', ...(p.agentProfile && { agentProfile: p.agentProfile }), cwd, context: [],
          tmux: { windowId: w.windowId, paneId: w.paneId },
          shell: { lastOutputAt: Date.now() }, unread: false,
        };
      });
      if (p.command) {
        const command = withAddDirs(p.command, this.deps.store.state.islands[p.islandId].context);
        if (prompt) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
        await this.deps.tmux.sendLine(w.paneId, prompt ? withPromptFile(command, promptFile) : command, true);
      }
    } catch (e) {
      // the island filled up while the window was being created, or the start command never reached the
      // pane: neither an orphan window nor a half-created character survives
      if (prompt) fs.rmSync(promptFile, { force: true });
      this.deps.store.update((d) => { delete d.characters[id]; });
      await this.deps.tmux.killWindow(w.windowId);
      throw e;
    }
    void refreshLinks(this.deps.store, this.deps.config, id);
    if (!p.run) return this.char(id);
    const timeoutMs = this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    let runSent = await this.waitForAgent(id, timeoutMs);
    // claude and codex have their prompt already, and submit it once they are up
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

  // true once the SessionStart hook has attached an agent; false when the window dies or the wait runs out
  private waitForAgent(id: string, timeoutMs: number): Promise<boolean> {
    const check = (): boolean | undefined => {
      const c = this.deps.store.state.characters[id];
      if (!c || !c.tmux) return false;
      return c.agent ? true : undefined;
    };
    const now = check();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve) => {
      const finish = (v: boolean) => { unsub(); clearTimeout(timer); resolve(v); };
      const unsub = this.deps.store.subscribe(() => { const r = check(); if (r !== undefined) finish(r); });
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /** A profile renamed in its folder takes the characters that use it along. */
  renameAgentProfile(from: string, to: string): void {
    this.deps.store.update((d) => { for (const c of Object.values(d.characters)) if (c.agentProfile === from) c.agentProfile = to; });
  }

  updateCharacter(id: string, patch: {
    name?: string; note?: string; instructions?: string; agentProfile?: string; islandId?: string; context?: ContextItem[]; portrait?: Portrait;
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
      if (patch.note !== undefined) setNote(c, patch.note);
      if (patch.instructions !== undefined) c.instructions = patch.instructions;
      if (patch.agentProfile) c.agentProfile = patch.agentProfile;
      else if (patch.agentProfile === '') delete c.agentProfile;
      if (context) c.context = context;
      if (patch.islandId && patch.islandId !== c.islandId) {
        // compute the new cell before reassigning islandId, or the character's stale cell would count as occupied on the target island
        const cell = placeOnIsland(d, patch.islandId);
        c.islandId = patch.islandId;
        c.cell = cell;
      }
    });
    return this.char(id);
  }

  // one store update: a swap must never be observed half done
  moveCharacter(id: string, islandId: string, cell?: Cell): Character {
    this.char(id);   // whichever path runs, the character has to exist
    const island = this.island(islandId);
    // without a cell the fleet picks one and grows the island to fit, even on the island the character already stands on
    if (!cell) {
      this.deps.store.update((d) => {
        const c = d.characters[id];
        // the cell before the islandId, or the character's stale cell would count as occupied on the target island
        const placed = placeOnIsland(d, islandId, id);
        c.islandId = islandId;
        c.cell = placed;
      });
      return this.char(id);
    }
    if (island.kind === 'home' && !isHomeSlot(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not a home slot`);
    if (!isLand(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not land`);
    const state = this.deps.store.state;
    const occupant = Object.values(state.characters).find((o) => o.id !== id && o.islandId === islandId && cellKey(o.cell) === cellKey(cell));
    if (!occupant && blockedCells(state, islandId, id).has(cellKey(cell))) throw new Invalid(`cell ${cellKey(cell)} touches another character`);
    this.deps.store.update((d) => {
      const c = d.characters[id];
      const other = occupant ? d.characters[occupant.id] : undefined;
      if (other) { other.islandId = c.islandId; other.cell = c.cell; }
      c.islandId = islandId;
      c.cell = cell;
    });
    return this.char(id);
  }

  // A sidebar drop inserts into the target crew in one update. On another island it first
  // makes room there; within one island it rotates only the occupied cells between the rows.
  reorderCharacter(id: string, targetId: string, after: boolean): Character {
    const moving = this.char(id);
    const target = this.char(targetId);
    if (id === targetId) return moving;
    this.deps.store.update((d) => {
      if (moving.islandId !== target.islandId) {
        const placed = placeOnIsland(d, target.islandId, id);
        d.characters[id].islandId = target.islandId;
        d.characters[id].cell = placed;
      }
      const crew = Object.values(d.characters)
        .filter((c) => c.islandId === target.islandId)
        .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x || a.id.localeCompare(b.id));
      const cells = crew.map((c) => c.cell);
      const order = crew.map((c) => c.id).filter((c) => c !== id);
      order.splice(order.indexOf(targetId) + Number(after), 0, id);
      order.forEach((charId, index) => { d.characters[charId].cell = cells[index]; });
    });
    return this.char(id);
  }

  async closeCharacter(id: string): Promise<void> {
    // out of the state before any await, so a revive or second terminal opening meanwhile kills its own window
    const c = this.char(id);
    this.deps.store.update((d) => { delete d.characters[id]; });
    if (c.tmux) await this.deps.tmux.killWindow(c.tmux.windowId);
    if (c.second) await this.deps.tmux.killWindow(c.second.tmux.windowId);
    // nothing the daemon keeps outside the state outlives the character
    for (const m of [this.shellStreak, this.codexStreak, this.hookCwd, this.rolloutMark, this.answering]) m.delete(id);
    this.shellStreak.delete(secondName(id));
    this.scribe.forget(id);
    removeDocs(this.deps.paths.docs, 'character', id, this.deps.log);
  }

  // concurrent revives would each spawn a window and orphan all but the last.
  reviveCharacter(id: string, prompt?: string): Promise<Character> {
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
    const w = await this.deps.tmux.newWindow(id, c.cwd, { ...characterKeyEnv(this.deps.paths.env), SVALL_CHAR_ID: id, SVALL_HOME: this.deps.paths.home });
    if (!this.deps.store.state.characters[id]) {
      await this.deps.tmux.killWindow(w.windowId);
      throw new NotFound(`no character ${id}`);
    }
    const island = this.deps.store.state.islands[c.islandId];
    const resume = withAddDirs(c.revive?.command ?? '', [...(island?.context ?? []), ...c.context]);
    const promptFile = path.join(this.deps.paths.home, `${id}.prompt`);
    const withPrompt = !!prompt && takesPrompt(resume);
    if (withPrompt) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const command = withPrompt ? withPromptFile(resume, promptFile) : resume;
    this.deps.store.update((d) => {
      const cur = d.characters[id];
      cur.tmux = { windowId: w.windowId, paneId: w.paneId };
      delete cur.revive;
      // a resumed session keeps its old agent record; its stale status must not answer the next wait,
      // nor its old activity have it ended again as idle before it is up
      if (cur.agent) { cur.agent.status = 'idle'; cur.agent.lastActivityAt = Date.now(); delete cur.agent.prompt; delete cur.agent.promptId; delete cur.agent.background; cur.unread = false; }
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
    const w = await this.deps.tmux.newWindow(secondName(id), c.cwd, { ...characterKeyEnv(this.deps.paths.env), SVALL_CHAR_ID: id, SVALL_HOME: this.deps.paths.home, SVALL_TERM: '2' });
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

  // ---- browser tabs

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

  async run(id: string, text: string, enter: boolean, term?: 2): Promise<void> {
    const c = this.char(id);
    // a dormant claude or codex wakes with the text as its launch prompt; typed while it boots, a prompt can lose its Enter
    if (!term && enter && !c.tmux && !this.reviving.has(id) && takesPrompt(c.revive?.command ?? '')) {
      await this.reviveCharacter(id, text);
      return;
    }
    const t = this.terminal(id, term);
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
        a.status = 'working';
        delete a.prompt;
        delete a.promptId;
        delete a.background;
        slot.unread = false;
      });
    }
  }

  async answerPrompt(id: string, answer: 'approve' | 'deny', promptId?: string): Promise<void> {
    const c = this.live(id);
    const asked = c.agent?.promptId;
    if (c.agent?.status !== 'blocked') throw new Invalid(`${c.name} is not waiting on an answer`);
    if (promptId !== undefined && promptId !== asked) throw new Invalid(`${c.name} has moved on from that question`);
    if (this.answering.has(id) && this.answering.get(id) === asked) throw new Invalid(`${c.name}'s answer is already in`);
    this.answering.set(id, asked);
    // an answer to a newer question may have been typed meanwhile; its hold stays
    const release = () => { if (this.answering.get(id) === asked) this.answering.delete(id); };
    try { await this.deps.tmux.sendBytes(c.tmux.paneId, Buffer.from(answer === 'approve' ? '\r' : '\x1b')); }
    catch (e) { release(); throw e; }
    try {
      this.settleAnswer(id, asked, answer);
      release();
    } catch (e) {
      // the key is in, so the answer stands
      this.deps.log.error(`answer for ${id} was typed, but not written down: ${String(e)}`);
    }
  }

  // Enter typed into the terminal takes the question's highlighted option and Esc or ^C turns it down, as the
  // keys answerPrompt sends do; only the keys a viewer sends through the daemon are seen here
  typedAnswer(id: string, data: Buffer, asked: string | undefined): void {
    const key = data.toString('latin1');
    const answer = key === '\r' ? 'approve' : key === '\x1b' || key === '\x03' ? 'deny' : undefined;
    if (answer && asked) this.settleAnswer(id, asked, answer);
  }

  // Claude Code fires no hook when Esc ends the turn, though Esc on a question asked while background agents
  // run ends no turn; a hook that moved the agent on while the key was sent wins
  private settleAnswer(id: string, asked: string | undefined, answer: 'approve' | 'deny'): void {
    this.deps.store.update((d) => {
      const a = d.characters[id]?.agent;
      if (a?.status !== 'blocked' || a.promptId !== asked) return;
      a.status = answer === 'approve' || a.background ? 'working' : 'idle';
      delete a.prompt;
      delete a.promptId;
    });
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
    const check = (): WaitResult | undefined => {
      const c = this.deps.store.state.characters[id];
      const t = term === 2 ? c?.second : c;
      // a terminal whose tmux window died will never reach the awaited status.
      if (!t?.tmux) return 'gone';
      if (t.agent && until.includes(t.agent.status)) return t.agent.status;
      return undefined;
    };
    const now = check();
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => { unsub(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
      const onAbort = () => finish(() => reject(new Error('wait cancelled')));
      const unsub = this.deps.store.subscribe(() => { const r = check(); if (r) finish(() => resolve(r)); });
      const timer = setTimeout(() => finish(() => resolve('timeout')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  onSocketEvent(e: SocketEvent): string | undefined {
    const ev = 'hook' in e ? e.hook : e.status;
    let reply: string | undefined;
    this.deps.store.update((d) => {
      const c = d.characters[ev.charId];
      if (!Object.hasOwn(d.characters, ev.charId)) return;
      const apply = <T extends Slot>(slot: T): T => {
        let next = 'hook' in e ? applyHook(slot, e.hook, Date.now()) : applyStatus(slot, e.status);
        // codex has no statusline to push its context reading, so each hook reads it off the tail of the rollout
        if ('hook' in e && next.agent?.kind === 'codex' && next.agent.transcriptPath) {
          const t = lastTokenCount(readTail(next.agent.transcriptPath, 64 * 1024));
          if (t) next = applyStatus(next, { charId: ev.charId, sessionId: next.agent.sessionId, contextPct: t.pct });
        }
        // the brief is the agent's own: a run nested inside it neither gets it nor takes its changes
        if ('hook' in e && next.agent && (e.hook.name === 'SessionStart' || e.hook.name === 'UserPromptSubmit')
          && (!e.hook.sessionId || e.hook.sessionId === next.agent.sessionId)) {
          const island = d.islands[c.islandId];
          const r = briefReply(e.hook.name, island ? this.render(island, c) : '', next.agent.brief);
          if (r.delivered !== undefined) next.agent.brief = r.delivered;
          reply = r.reply;
        }
        return next;
      };
      // an event from a second terminal that has already gone has nowhere to land
      if (ev.term === 2) { if (c.second) c.second = apply(c.second); }
      else {
        // a dormant character keeps the agent its revive resumes; the end its closing window sends does not clear it
        if (!c.tmux && 'hook' in e && e.hook.name === 'SessionEnd') return;
        const next = apply(c);
        if (next.agent) delete next.hint;
        d.characters[ev.charId] = next;
      }
    });
    // the second terminal is a side shell, and a run nested inside the agent or a subagent works where it likes; none moves the character
    const agent = this.deps.store.state.characters[ev.charId]?.agent;
    const nested = 'hook' in e && !!agent && !!e.hook.sessionId && e.hook.sessionId !== agent.sessionId;
    if ('hook' in e && e.hook.cwd && e.hook.term !== 2 && !nested && !e.hook.agentId) {
      void this.followCwd(ev.charId, agent?.kind === 'codex' ? this.codexCwd(ev.charId, agent.transcriptPath, e.hook.cwd) : e.hook.cwd);
    }
    return reply;
  }

  // codex runs each command in the directory its call names and tells its hooks only the one the session began in;
  // the newest command that ran elsewhere says where the agent works, until that directory is gone
  private codexCwd(charId: string, transcript: string | undefined, home: string): string {
    if (!transcript) return home;
    const mark = followRollout(transcript, home, this.rolloutMark.get(charId));
    this.rolloutMark.set(charId, mark);
    return mark.dir && fs.existsSync(mark.dir) ? mark.dir : home;
  }

  // an agent that cds into another checkout from its shell leaves the pane's path behind; its hooks say where it went
  private async followCwd(charId: string, cwd: string): Promise<void> {
    if (this.hookCwd.get(charId) === cwd) return;
    this.hookCwd.set(charId, cwd);
    const from = this.deps.store.state.characters[charId]?.cwd;
    if (!from) return;
    const [to, now] = await Promise.all([resolveRepo(cwd), resolveRepo(from)]);
    if (!to || to.root === now?.root) return;
    try { this.deps.store.update((d) => { if (d.characters[charId]) d.characters[charId].cwd = to.root; }); }
    // a write that fails leaves the directory for the next hook that reports it
    catch (e) { this.hookCwd.delete(charId); throw e; }
    await refreshLinks(this.deps.store, this.deps.config, charId);
  }
}
