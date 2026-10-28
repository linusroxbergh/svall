import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineId, type ParsedParams, type Robot } from '@svall/protocol';
import { installCodexHooks, readCodexHooks } from './agent-hooks.js';
import { systemInfo } from './api/methods.js';
import { startApi } from './api/server.js';
import { findAgents } from './agents.js';
import { codexPaths } from './codex/install.js';
import { configRelinked, fleetMainAgent, keptPorts, loadConfig, readFleetConfig, saveConfig } from './config.js';
import { liftRobotDocs } from './docs.js';
import { Fleet } from './fleet.js';
import { fleetControl, realFleetDeps } from './fleets.js';
import { bootId } from './processes.js';
import { agentProber, realProbeDeps } from './sessions/registry.js';
import { startHookReceiver } from './hooks/receiver.js';
import { HomeLinks, sshTransport, UnknownEvent } from './link/home.js';
import { tryLock } from './kernel-lock.js';
import { HomeConnection } from './link/worker.js';
import { lingerState, realRun } from './linux/service.js';
import { hooklessGit } from './links/git.js';
import { createLogger, rotateLog, type Logger } from './log.js';
import { configDir, machineId, machineIdentity, machineIdFailure, readRegistry, rebindMachine, type HardwareReader } from './machine.js';
import { mobileControl, phoneKey, realDeps, watchServed } from './mobile.js';
import { installOpencodePlugin, opencodePaths } from './opencode/install.js';
import { claudePaths, fleetKeys, resolvePaths } from './paths.js';
import { Phones } from './phones.js';
import { Placement } from './placement/move.js';
import { HomeDocs, WorkerDocs, noteConflict } from './placement/docs-sync.js';
import { FarViewers, RemoteWatches, ViewerNotice } from './placement/far-viewers.js';
import { Mirror, mirrorCalls } from './placement/mirror.js';
import { readMirrorVars } from './placement/mirror-config.js';
import { PrepareService } from './placement/prepare.js';
import { homeRootOf } from './placement/repo-key.js';
import { Replay } from './placement/replay.js';
import { Router, fileCalls, forgetRobot, workerCalls } from './placement/router.js';
import { DEFAULT_PORT, isProfileName, PRIVATE, profileOf, variantOf } from './profile.js';
import { releaseVersion } from './release.js';
import { Retro } from './retro/service.js';
import { runtimeVersion, variant } from './runtime.js';
import { startPusher, webPushSender } from './push/pusher.js';
import { PushStore } from './push/store.js';
import { readOrCreateVapid } from './push/vapid.js';
import { repoSources, rootHere, workspaceRoot } from './resources/scan.js';
import { readOrUndefined } from './settings-file.js';
import { installHookScripts } from './setup.js';
import { Store } from './store.js';
import { TerminalHub } from './terminals.js';
import { shq } from './text.js';
import { tmuxConfText, tmuxTooOld } from './tmux/conf.js';
import { resolveTmux, servingTmux, Tmux } from './tmux/tmux.js';
import { LoadSampler } from './load/sampler.js';
import { readProcs } from './load/procs.js';
import { cachedUsage, fleetUsage, usageFetcher } from './usage/usage.js';
import { workerOptions, workerStubs, type Off } from './worker/mode.js';
import { WorkerMutations } from './worker/mutations.js';
import { Outbox } from './worker/outbox.js';
import { ScreenNotice, ScreenTails } from './worker/screens.js';
import { applyReport, type RobotSync } from './worker/snapshot.js';
import { Workspace } from './workspace/workspace.js';

export type Daemon = { port: number; token: string; store: Store; fleet: Fleet; stop(): Promise<void> };

// how long a usage reading stands before the panel's next open pays for another
const USAGE_TTL_MS = 60_000;
const LOOK_AGAIN_MS = 30_000;

export function readOrCreateToken(file: string): string {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (existing) { fs.chmodSync(file, 0o600); return existing; }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export class AlreadyRunning extends Error {}
const alreadyRunning = (home: string): Error => new AlreadyRunning(`svalld is already running for ${home}`);

// a kernel lock, on Linux named after the home's real path
async function lockHome(home: string): Promise<() => void> {
  const unlock = await tryLock(path.join(home, 'daemon.lock'), `svall-svalld-${crypto.createHash('sha256').update(fs.realpathSync(home)).digest('hex')}`);
  if (!unlock) throw alreadyRunning(home);
  return unlock;
}

/** `hardware`, for the reader of this machine's hardware id; `worker`, to run as a worker of the home worker.json names. */
type Options = { home: string; port?: number; host?: string; log?: Logger; hardware?: HardwareReader; worker?: true };

export class OtherBuildHome extends Error {}

// the lock comes before anything in the home is read or written, so a second start leaves the running one be
export async function startDaemon(opts: Options): Promise<Daemon> {
  // a checkout's daemon on the release's home, or the reverse, would run it on the other build's ports and folders
  const owner = variantOf(opts.home);
  if (owner && owner !== variant) throw new OtherBuildHome(`${opts.home} belongs to ${owner === 'dev' ? 'Svall Dev' : 'Svall'}, not to this build`);
  fs.mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  const unlock = await lockHome(opts.home);
  const daemon = await start(opts).catch((e: unknown) => { unlock(); throw e; });
  return { ...daemon, stop: async () => { await daemon.stop(); unlock(); } };
}

// every fleet home in this account's home, set up or not
const fleetHomes = (home: string): string[] => [home, ...fs.readdirSync(os.homedir()).filter((f) => f.startsWith('.svall')).map((f) => path.join(os.homedir(), f))];

// each worker, a machine reached over ssh, knows a home by its id, so one that cannot be read stops svalld while any
// worker is listed, and with none it runs as a fresh id. A machine.json made on other hardware becomes this machine's
function ownMachineId(log: Logger, hardware?: HardwareReader): MachineId {
  let identity: ReturnType<typeof machineIdentity>;
  try {
    identity = machineIdentity(configDir(), hardware);
  } catch (e) {
    let listed: boolean;
    try { listed = readRegistry().some((m) => m.record.ssh !== undefined); } catch { listed = true; }
    if (listed) throw new Error(machineIdFailure(e, { workers: true }), { cause: e });
    const id = MachineId.parse(crypto.randomUUID());
    log.error(`${machineIdFailure(e)}; no worker knows this Mac, so it runs as ${id}`);
    return id;
  }
  const { id, hardware: seen } = identity;
  if (!seen) return id;
  const made = `${path.join(configDir(), 'machine.json')} was made on hardware ${seen.stored}, and this machine is ${seen.actual}`;
  try {
    rebindMachine(seen.actual);
    log.error(`${made}; the file is this machine's from now on`);
  } catch (e) {
    log.error(`${made}; the file could not be bound to this machine: ${(e as Error).message}`);
  }
  return id;
}

// the home knows a worker by this id, so one that cannot be read stops the worker rather than start it as another machine
function workerMachineId(hardware?: HardwareReader): MachineId {
  try {
    return machineId(configDir(), hardware);
  } catch (e) {
    throw new Error(machineIdFailure(e), { cause: e });
  }
}

async function start(opts: Options): Promise<Daemon> {
  const paths = resolvePaths(opts.home);
  fs.chmodSync(paths.home, 0o700);
  rotateLog(paths.log);
  const log = opts.log ?? createLogger();
  const config = loadConfig(paths, log.info);
  if (configRelinked(paths)) log.info(`${paths.legacyConfig} is not read: it links to the file ${paths.legacyConfig}.bak does, which ${paths.fleetConfig} and ${paths.nodeConfig} were split out of; link those instead`);
  const worker = opts.worker ? workerOptions(paths) : undefined;
  // a worker's docs are its home's, as the home last sent them
  if (worker) paths.docs = path.join(paths.cache, 'docs');
  const off = new Set<Off>(worker?.off ?? []);
  // a state.json this svalld refuses stops it before the hooks, tmux.conf and Codex's trust are touched
  const store = Store.load(paths.state, log.error);
  if (off.has('scribe')) store.update((d) => { d.scribeOff = true; });
  liftRobotDocs(paths.docs, log);
  installHookScripts(paths);
  const token = readOrCreateToken(paths.token);
  const key = phoneKey(paths.mobileKey, readOrCreateToken(paths.mobileKey));
  // what a phone proves itself by, handed over in the QR code and never in a command line
  const pass = readOrCreateToken(paths.mobilePass);
  const push = new PushStore(paths.push, log.error);
  const vapid = readOrCreateVapid(paths.vapid);
  const profile = profileOf(paths.home);
  config.mainAgent = fleetMainAgent(paths.home, config.mainAgent);
  // launchd's PATH, which setup built to include where the shell found claude and codex
  const agentsFound = findAgents(process.env.PATH ?? '');
  // a Codex installed after `svall setup` still gets its hooks. Only the private fleet writes them:
  // the command names this fleet's script, and a second fleet rewriting it would reset its trust
  if (profile === PRIVATE && (config.integrations?.includes('codex') ?? true)) {
    const codex = codexPaths();
    try { for (const line of installCodexHooks(paths.hookScript, readCodexHooks(codex, agentsFound.includes('codex') || fs.existsSync(codex.dir)))) log.info(line); }
    catch (e) { log.error(`codex hooks: ${(e as Error).message}`); }
  }
  // an OpenCode installed after `svall setup` still gets the plugin; only the private fleet writes it, as it serves every fleet
  const opencode = opencodePaths();
  if (profile === PRIVATE && (config.integrations?.includes('opencode') ?? true) && (agentsFound.includes('opencode') || fs.existsSync(opencode.dir))) {
    try { for (const line of installOpencodePlugin(opencode)) log.info(line); }
    catch (e) { log.error(`opencode plugin: ${(e as Error).message}`); }
  }

  // a server an earlier release started, such as one on Ubuntu's own tmux before an upgrade, is reached with a client of
  // its version; with no robot in it, it starts over on this release's, as an older companion's sends the Mac no copy
  const own = resolveTmux();
  const serving = new Tmux(paths.tmuxSock, paths.tmuxConf, await servingTmux(paths.tmuxSock, readOrUndefined(path.join(paths.home, 'tmux-binary')), own));
  const stale = await serving.startOverStale(own);
  const tmux = stale && !stale.kept ? new Tmux(paths.tmuxSock, paths.tmuxConf, own) : serving;
  if (stale?.kept) {
    const why = { robots: 'runs the robots here', unlisted: 'did not list its windows' }[stale.kept];
    log.error(`tmux ${stale.running}, not this release's, ${why}, so a copy or link in a robot's terminal may not reach the Mac; it starts over on ${own} at a daemon start with no robot here`);
  }
  // the conf leaves out what this tmux would refuse, so the version is read before it is written
  const tmuxVersion = await tmux.version();
  fs.writeFileSync(paths.tmuxConf, tmuxConfText(config, { tmuxVersion }));
  if (tmuxTooOld(tmuxVersion)) log.error(`${tmuxVersion} is older than 3.5: Shift+Enter will not reach Claude Code; ${process.platform === 'linux' ? 'Ubuntu 24.04 ships 3.4' : 'brew upgrade tmux'}`);
  // the app attaches its terminals with this tmux, which an app opened from Finder may not find on its own PATH
  fs.writeFileSync(path.join(paths.home, 'tmux-binary'), tmux.binary);
  fs.writeFileSync(path.join(paths.home, 'version'), `${runtimeVersion()}\n${process.pid}\n`);
  const me = worker ? workerMachineId(opts.hardware) : ownMachineId(log, opts.hardware);
  store.batchWrites();
  // the home's links to its workers, or a worker's to its home, for the fleet to route through; each starts once the
  // fleet it carries is served, the API that answers what a worker sends on included, and stops before any of it
  let answer: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  // rises across restarts, so no worker holds a version newer than the home's next
  let version = Date.now();
  const homeDocs = worker ? undefined : new HomeDocs(paths.docs, log, (m) => store.state.machines?.[m]?.name ?? m, (id) => Object.hasOwn(store.state.robots, id));
  // what a worker did while this Mac slept, applied once each
  const replay = worker ? undefined : new Replay({ store, paths, log, synced: (m): boolean => links?.for(m)?.synced === true, homedir: os.homedir() });
  // the home's agent configuration, which each worker takes
  const homeMirror = worker ? undefined : new Mirror({
    claudeDir: claudePaths().dir, codexDir: codexPaths().dir, homedir: os.homedir(), claudeJson: claudePaths().json, opencodeDir: opencodePaths().dir, agentProfiles: paths.agentProfiles,
    consent: paths.mirrorConsent, log,
    // a worker runs the release, whose fleet homes are ~/.svall and ~/.svall-<name>
    overridesThere: `~/${profile === PRIVATE ? '.svall' : `.svall-${profile}`}/mirror-overrides`,
  });
  const links = worker ? undefined : new HomeLinks({
    paths, store, log, release: releaseVersion(), machines: () => readRegistry(), connect: sshTransport({ profile, log }),
    onReport: (r, machine) => { if (applyReport(store, r, machine) === 'applied') replay?.reported(r.robotId); },
    onEvent: async (kind, data, machine) => {
      if (replay && kind === 'mutation') return replay.prepare(data, machine);
      if (!homeDocs || (kind !== 'docs.write' && kind !== 'docs.delete')) throw new UnknownEvent();
      const conflict = homeDocs.apply(kind, data, machine);
      return conflict && { change: () => noteConflict(store, machine, conflict, os.homedir()), docs: true as const };
    },
    onInventory: (inv, machine) => router.reconcileWorker(inv, machine),
    onCall: (method, params) => answer!(method, params),
    onNotify: (kind, data, machine) => {
      if (kind === 'screen') {
        const s = ScreenNotice.parse(data);
        return terminals.sawScreen(s.id, s.text, s.at, machine);
      }
      if (kind !== 'viewer') return;
      const { key, ev } = ViewerNotice.parse(data);
      if (ev.event === 'repo.changed') remoteWatches?.farEvent(key, ev, machine);
      else terminals.farEvent(key, ev, machine);
    },
    // a worker linked anew holds none of the home's watches and terminals
    onSynced: (machine) => {
      for (const again of [remoteWatches?.reopen(machine), terminals.reopen(machine)]) again?.catch((e: Error) => log.error(`${machine}: ${e.message}`));
    },
    onLost: (machine) => terminals.lostMachine(machine),
    snapshot: () => ({ version: ++version, state: store.state, agentHomes: { claude: claude.dir, codex: codex.dir, opencode: opencode.dir }, home: os.homedir() }),
    mirror: homeMirror,
    ...(homeDocs && { docs: homeDocs }),
  });
  const calls: Record<string, (params: unknown) => Promise<unknown>> = {};
  const outbox = worker && Outbox.open(paths);
  const connection = worker && outbox && new HomeConnection({
    paths, worker: worker.worker, me, store, outbox, log, release: releaseVersion(), bootId: bootId() ?? crypto.randomUUID(), handlers: calls,
    onAcked: (dropped) => mutations?.acked(dropped),
    // the home's viewers watch and hold terminals here only while it is linked, and the mirror it sent waits for no other link
    onLink: (live) => {
      if (live) return;
      for (const v of farViewers?.dropAll() ?? []) { workspace.unwatchAll(v); terminals.closeAll(v); }
      workerMirror?.linkLost();
    },
  });
  const farViewers = connection && new FarViewers({ connection });
  const workerMirror = connection && mirrorCalls({
    claudeDir: claudePaths().dir, codexDir: codexPaths().dir, homedir: os.homedir(), claudeJson: claudePaths().json, opencodeDir: opencodePaths().dir,
    agentProfiles: paths.agentProfiles, overrides: paths.mirrorOverrides,
    stage: paths.cache, stateFile: paths.mirrorState, varsFile: paths.mirrorVars, envFile: paths.env, connection, log,
  });
  const workerDocs = connection ? new WorkerDocs({ dir: paths.docs, file: paths.docsSynced, stage: paths.cache, connection, log }) : undefined;
  const router = new Router({
    store, me, log, links, ...(replay && { replay, homedir: os.homedir() }), ...(worker && connection && { home: { id: worker.worker.homeMachineId, connection } }),
  });
  const remoteWatches = links && new RemoteWatches({ links, router });
  // a worker names a clone as the home does once a snapshot has said where the home's user folder is
  const docsRoot = (c: Robot) => homeRootOf(c, store.state.machines, worker ? store.state.machines?.[worker.worker.homeMachineId]?.home : os.homedir());
  const fleet = new Fleet({
    store, tmux, paths, config, log, agentsFound, remote: router, repoRoot: docsRoot,
    ...(worker && { extraKeys: () => readMirrorVars(paths.mirrorVars) }),
    ...(connection && { report: (r: RobotSync) => connection.report(r), created: (c: Robot, p: ParsedParams<'robot.create'>) => mutations?.created(c, p) }),
  });
  // what the CLI in a worker's panes starts there, and changes there while its home is away
  const mutations = connection && outbox && new WorkerMutations({
    store, fleet, connection, outbox, me, paths, log, forget: (id) => forgetRobot({ fleet, store, me, log }, id),
  });
  const terminals = new TerminalHub(fleet, tmux, store, log, links && { router, links });
  // the last lines of each robot's pane here, which the home shows while this worker is out of its reach
  const screens = connection && new ScreenTails({ fleet, store, tmux, connection, me });
  // what this machine's agent CLIs are: a move and system.info read them
  const agents = agentProber(realProbeDeps(paths.env));
  if (connection && worker && workerDocs && farViewers && workerMirror) {
    const prepare = new PrepareService({
      store, fleet, tmux, viewers: terminals, connection, me, homeName: worker.worker.homeName, paths, git: hooklessGit, agents, homedir: os.homedir(), log,
    });
    Object.assign(calls, workerCalls({ fleet, store, me, log, terminals, viewers: farViewers }), prepare.handlers, workerMirror.calls, workerDocs.handlers);
  }
  const placement = links && new Placement({
    store, fleet, links, me, paths, git: hooklessGit, agents, release: releaseVersion(), homedir: os.homedir(), tmux, viewers: terminals, log,
  });
  const info = () => systemInfo({
    machineId: me, agents, ...(process.platform === 'linux' && { linger: () => lingerState(realRun, os.userInfo().username).then((l) => ({ user: l.user, on: l.linger })) }),
  });
  // what a worker's agent CLIs are, which the home reads before it moves a robot there
  if (connection) calls['system.info'] = info;
  const claude = claudePaths();
  const codex = codexPaths();
  // looked up on every call, so a fleet made while this one runs is kept out too; any folder named like a fleet home
  // counts, set up or not
  const homes = () => fleetHomes(paths.home);
  const refused = () => [claude.json, path.join(claude.dir, '.credentials.json'), path.join(codex.dir, 'auth.json'),
    path.join(opencode.data, 'auth.json'), path.join(opencode.data, 'mcp-auth.json'),
    ...homes().flatMap((h) => fleetKeys(resolvePaths(h)))];
  // a robot's folders are on the machine it runs on
  const rootOf = rootHere((c) => router.runsHere(c));
  const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude, codex, paths.docs, paths.agentProfiles, (c) => router.runsHere(c), rootOf, docsRoot), log, refused, [paths.docs, paths.agentProfiles], paths.trash);
  if (farViewers) Object.assign(calls, fileCalls({ workspace, viewers: farViewers, terminals, resources: () => repoSources(store.state, claude, paths.docs, rootOf) }));
  const phones = new Phones();
  const mobile = off.has('mobile') ? workerStubs.mobile : mobileControl(realDeps(), {
    home: paths.home, profile, logins: () => config.mobile.logins, phones, httpsPort: config.mobile.httpsPort, rotateKey: key.rotate, pass,
    kept: () => keptPorts(homes().filter((h) => h !== paths.home)),
    savePort: (httpsPort) => {
      try { saveConfig(paths, { mobile: { httpsPort } }, log.info); return true; } catch (e) { log.error(`phone port ${httpsPort} not saved: ${(e as Error).message}`); return false; }
    },
  });
  const usage = fleetUsage({ state: () => store.state, claude: cachedUsage(usageFetcher({ cwd: path.join(paths.home, 'usage'), envFile: paths.env }), USAGE_TTL_MS), runsHere: (c) => router.runsHere(c) });
  // the home's usage panel counts a worker's robots as the worker reads them
  if (connection) calls['usage.get'] = () => usage();

  const load = new LoadSampler({
    read: () => readProcs(fs.existsSync(paths.hookHelper) ? paths.hookHelper : undefined),
    scope: (p) => fleet.loadScope(p),
    sleepable: (id, p) => fleet.sleepable(id, p),
  });

  // run in reverse on stop, and on a failed start for whatever had already started
  const teardown: (() => unknown)[] = [() => load.stop(), () => fleet.stop(), store.subscribe(() => workspace.retarget()), () => workspace.close()];
  // a second stop, as a second signal sends, waits for the first to have the fleet on disk
  let stopping: Promise<void> | undefined;
  // the retro reads this machine's agent stores for the fleet it owns; fleet.json is read at each call
  const retro = worker ? undefined : new Retro({
    paths, store, log, claudeDir: claude.dir, codexDir: codexPaths().dir, homedir: os.homedir(),
    config: () => { try { return readFleetConfig(paths); } catch { return config; } },
    createRobot: (p) => fleet.createRobot(p),
  });
  if (retro) teardown.push(() => retro.stop());
  const stop = () => (stopping ??= (async () => { for (const fn of teardown.splice(0).reverse()) await fn(); })());
  try {
    await fleet.start();
    retro?.start();
    if (!off.has('push')) teardown.push(startPusher({ store, push, send: webPushSender(vapid), log, logins: mobile.logins, served: mobile.served, contact: config.mobile.pushContact }));
    // a running server keeps its old options if the new conf has a line this tmux rejects
    await tmux.sourceConf().catch((e: Error) => log.error(`tmux source-file: ${e.message}`));
    const port = opts.port ?? config.port;
    const listen = (at: number) => startApi({
      host: opts.host ?? config.host, port: at, token, store, fleet, fleets: off.has('fleets') ? workerStubs.fleets : fleetControl(paths.home, realFleetDeps()), terminals, workspace, usage, load: () => load.get(), mobileControl: mobile, log,
      origins: () => config.mobile.origins, logins: mobile.logins, key: key.get, pass, push, vapidPublicKey: vapid.publicKey, phones, claude, codex, docs: paths.docs, agentProfiles: paths.agentProfiles, systemInfo: info,
      fleetName: () => store.state.name ?? (profile !== PRIVATE && isProfileName(profile) ? profile : undefined), router, placement, links, remoteWatches,
      mirror: homeMirror, fleetFlag: profile === PRIVATE ? '' : `-p ${isProfileName(profile) ? profile : shq(profile)} `,
      ...(mutations && { mutations }), ...(retro && { retro }),
    });
    // clients find the daemon by its port file, so one that names no port takes a free one while its default is held
    const api = await listen(port ?? DEFAULT_PORT).catch((e: NodeJS.ErrnoException) => {
      if (port !== undefined || e.code !== 'EADDRINUSE') throw e;
      log.info(`port ${DEFAULT_PORT} is taken: listening on a free one`);
      return listen(0);
    });
    teardown.push(() => api.close());
    answer = api.answer;
    const hooks = await startHookReceiver(paths.hooksSock, (e) => fleet.onSocketEvent(e), log);
    teardown.push(() => hooks.close());
    await fleet.resumeInterrupted();
    fs.writeFileSync(paths.port, String(api.port));
    // gone last: whoever waits for it to go may read state.json next
    teardown.unshift(() => fs.rmSync(paths.port, { force: true }));
    // pushes go out only over a link seen served: it is looked at once the port it proxies to is known,
    // and again while a device waits and tailscale has not answered
    if (!off.has('mobile')) teardown.push(watchServed(mobile, () => push.list().length > 0, LOOK_AGAIN_MS));
    if (connection) {
      await connection.start();
      teardown.push(() => connection.stop());
    }
    if (screens) {
      screens.start();
      teardown.push(() => screens.stop());
    }
    if (workerDocs) {
      workerDocs.start();
      teardown.push(() => workerDocs.stop());
    }
    if (links && placement) {
      links.start();
      teardown.push(() => links.stop(), () => placement.stop());
      // a move a stop left unfinished: undone before its commit, run on after it; one whose worker is down waits for it
      await placement.recoverMoves().catch((e: Error) => log.error(`moves: ${e.message}`));
    }
    log.info(`svalld started: home=${paths.home} port=${api.port}`);
    return {
      port: api.port, token, store, fleet,
      stop: async () => { await stop(); log.info('svalld stopped'); },
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
