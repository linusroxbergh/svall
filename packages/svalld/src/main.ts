import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MachineId, OwnerRecord, type ParsedParams, type Robot } from '@svall/protocol';
import { installCodexHooks, readCodexHooks } from './agent-hooks.js';
import { systemInfo } from './api/methods.js';
import { startApi } from './api/server.js';
import { findAgents } from './agents.js';
import { codexPaths } from './codex/install.js';
import { recordedTrust } from './codex/trust.js';
import { configRelinked, fleetMainAgent, keptPorts, loadConfig, namedGateway, peekConfig, saveConfig, setGateway } from './config.js';
import { liftRobotDocs } from './docs.js';
import { Fleet } from './fleet.js';
import { fleetControl, realFleetDeps } from './fleets.js';
import { fleetAuthority } from './gateway/client.js';
import { openJournal } from './handover/journal.js';
import { bootId } from './handover/processes.js';
import { HandoverService } from './handover/service.js';
import { agentProber, realProbeDeps } from './handover/sessions/registry.js';
import type { Authority } from './handover/source.js';
import { adoptAtStart, enterStartupMode, startupMode, watchGateway } from './handover/startup.js';
import { startHookReceiver } from './hooks/receiver.js';
import { HomeLinks, sshTransport, UnknownEvent } from './link/home.js';
import { HomeConnection } from './link/worker.js';
import { lingerState, realRun } from './linux/service.js';
import { handoverGit } from './links/git.js';
import { createLogger, rotateLog, type Logger } from './log.js';
import { configDir, copiedRemedy, machineId, machineIdentity, machineIdFailure, readRegistry, rebindMachine, type HardwareReader } from './machine.js';
import { mobileControl, phoneKey, realDeps, watchServed } from './mobile.js';
import { installOpencodePlugin, opencodePaths } from './opencode/install.js';
import { OwnershipState } from './ownership/state.js';
import { claudePaths, fleetKeys, resolvePaths, type Paths } from './paths.js';
import { Phones } from './phones.js';
import { Placement } from './placement/move.js';
import { HomeDocs, WorkerDocs, noteConflict } from './placement/docs-sync.js';
import { Mirror, mirrorCalls } from './placement/mirror.js';
import { PrepareService } from './placement/prepare.js';
import { homeRootOf } from './placement/repo-key.js';
import { Replay } from './placement/replay.js';
import { Router, forgetRobot, workerCalls } from './placement/router.js';
import { DEFAULT_PORT, isProfileName, PRIVATE, profileHome, profileOf, variantOf } from './profile.js';
import { releaseVersion } from './release.js';
import { runtimeVersion, variant } from './runtime.js';
import { startPusher, webPushSender } from './push/pusher.js';
import { PushStore } from './push/store.js';
import { readOrCreateVapid } from './push/vapid.js';
import { workspaceRoot } from './resources/scan.js';
import { readOrUndefined } from './settings-file.js';
import { installHookScripts } from './setup.js';
import { Store } from './store.js';
import { TerminalHub } from './terminals.js';
import { tmuxConfText, tmuxTooOld } from './tmux/conf.js';
import { servingTmux, Tmux } from './tmux/tmux.js';
import { LoadSampler } from './load/sampler.js';
import { readProcs } from './load/procs.js';
import { cachedUsage, fleetUsage, usageFetcher } from './usage/usage.js';
import { workerOptions, workerStubs, type Off } from './worker/mode.js';
import { WorkerMutations } from './worker/mutations.js';
import { Outbox } from './worker/outbox.js';
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

// macOS's O_EXLOCK, which node names no constant for
const O_EXLOCK = 0x20;

export class AlreadyRunning extends Error {}
const alreadyRunning = (home: string): Error => new AlreadyRunning(`svalld is already running for ${home}`);

// a kernel lock: it holds until it is let go or the daemon dies, however it dies
function lockHome(home: string): Promise<() => void> {
  return process.platform === 'linux' ? lockSocket(home) : Promise.resolve(lockFile(home));
}

function lockFile(home: string): () => void {
  const { O_RDWR, O_CREAT, O_NONBLOCK } = fs.constants;
  try {
    let fd = fs.openSync(path.join(home, 'daemon.lock'), O_RDWR | O_CREAT | O_NONBLOCK | O_EXLOCK, 0o600);
    // once only: by a second close the number may name another open file
    return () => { if (fd >= 0) fs.closeSync(fd); fd = -1; };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EAGAIN') throw alreadyRunning(home);
    throw e;
  }
}

// Linux ignores O_EXLOCK; there the lock is an abstract unix socket named after the home's real path, whose name the
// kernel keeps only while the socket is open
function lockSocket(home: string): Promise<() => void> {
  const name = `\0svall-svalld-${crypto.createHash('sha256').update(fs.realpathSync(home)).digest('hex')}`;
  const server = net.createServer((s) => s.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? alreadyRunning(home) : e));
    server.listen(name, () => {
      server.unref();
      resolve(() => { if (server.listening) server.close(); });
    });
  });
}

/**
 * `authority` stands in for the fleet's gateway, which is otherwise asked over its socket or ssh; `gatewayEveryMs`, how
 * often a running daemon asks it again; `hardware`, for the reader of this machine's hardware id; `worker`, to run as a
 * worker of the home worker.json names.
 */
type Options = { home: string; port?: number; host?: string; log?: Logger; authority?: Authority; gatewayEveryMs?: number; hardware?: HardwareReader; worker?: true };

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

// a fleet no gateway holds needs no machine id of its own: without one it runs as its owner record's, or as a new one
// that record keeps for the next start. A machine.json made on other hardware is another machine's id: `copied` names it
// while a gateway holds this fleet, and it becomes this machine's once no fleet here names a gateway
function fleetMachineId(paths: Paths, gateway: MachineId | undefined, log: Logger, hardware?: HardwareReader): { id: MachineId; copied?: string } {
  let identity: ReturnType<typeof machineIdentity>;
  try {
    identity = machineIdentity(configDir(), hardware);
  } catch (e) {
    if (gateway) throw new Error(machineIdFailure(e), { cause: e });
    let id: MachineId;
    try { id = OwnerRecord.parse(JSON.parse(fs.readFileSync(paths.owner, 'utf8'))).ownerMachineId; } catch { id = MachineId.parse(crypto.randomUUID()); }
    log.error(`${machineIdFailure(e)}; no gateway holds this fleet, so it runs as ${id}`);
    return { id };
  }
  const { id, hardware: seen } = identity;
  if (!seen) return { id };
  const file = path.join(configDir(), 'machine.json');
  const made = `${file} was made on hardware ${seen.stored}, and this machine is ${seen.actual}`;
  if (gateway) {
    log.error(`${made}, so this fleet is read-only here: ${copiedRemedy(file)}; \`svall doctor\` checks it`);
    return { id, copied: file };
  }
  // a fleet that cannot be read may name one
  const gatewayed = fleetHomes(paths.home).some((h) => { try { return !!peekConfig(resolvePaths(h)).gatewayMachineId; } catch { return true; } });
  if (gatewayed) {
    log.error(`${made}, and another fleet here names a gateway: ${copiedRemedy(file)}`);
    return { id };
  }
  try {
    rebindMachine(seen.actual);
    log.error(`${made}; no fleet here names a gateway, so the file is this machine's from now on`);
  } catch (e) {
    log.error(`${made}; no fleet here names a gateway, and the file could not be bound to this machine: ${(e as Error).message}`);
  }
  return { id };
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

  // a server an earlier release started, such as one on Ubuntu's own tmux before an upgrade, keeps its tmux until it ends
  const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf, await servingTmux(paths.tmuxSock, readOrUndefined(path.join(paths.home, 'tmux-binary'))));
  // the conf leaves out what this tmux would refuse, so the version is read before it is written
  const tmuxVersion = await tmux.version();
  fs.writeFileSync(paths.tmuxConf, tmuxConfText(config, { tmuxVersion }));
  if (tmuxTooOld(tmuxVersion)) log.error(`${tmuxVersion} is older than 3.5: Shift+Enter will not reach Claude Code; ${process.platform === 'linux' ? 'Ubuntu 24.04 ships 3.4' : 'brew upgrade tmux'}`);
  // the app attaches its terminals with this tmux, which an app opened from Finder may not find on its own PATH
  fs.writeFileSync(path.join(paths.home, 'tmux-binary'), tmux.binary);
  fs.writeFileSync(path.join(paths.home, 'version'), `${runtimeVersion()}\n${process.pid}\n`);
  // without a gateway no other machine can hold this fleet, so a record this one cannot read is repaired
  const gateway = off.has('gateway') ? undefined : config.gatewayMachineId;
  const { id: me, copied }: { id: MachineId; copied?: string } = worker ? { id: workerMachineId(opts.hardware) } : fleetMachineId(paths, gateway, log, opts.hardware);
  const ownership = OwnershipState.load({ paths, fleetId: config.id, machineId: me, log, standalone: !gateway, copied });
  // a handover reads state.json back from disk, so a frozen, held or replica fleet writes each change at once
  store.batchWritesWhile(() => ownership.writable());
  // the home's links to its workers, or a worker's to its home, for the fleet to route through; each starts once the
  // fleet it carries is served, the API that answers what a worker sends on included, and stops before any of it
  let answer: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  // rises across restarts, so no worker holds a version newer than the home's next
  let version = Date.now();
  const homeDocs = worker ? undefined : new HomeDocs(paths.docs, log, (m) => store.state.machines?.[m]?.name ?? m);
  // what a worker did while this Mac slept, applied once each
  const replay = worker ? undefined : new Replay({ store, paths, log });
  const links = worker ? undefined : new HomeLinks({
    paths, store, log, release: releaseVersion(), machines: () => readRegistry(), connect: sshTransport({ profile, log }),
    onReport: (r, machine) => { applyReport(store, r, machine); },
    onEvent: async (kind, data, machine) => {
      if (replay && kind === 'mutation') return replay.prepare(data, machine);
      if (!homeDocs || (kind !== 'docs.write' && kind !== 'docs.delete')) throw new UnknownEvent();
      const conflict = homeDocs.apply(kind, data, machine);
      return conflict && { change: () => noteConflict(store, machine, conflict, os.homedir()), docs: true as const };
    },
    onInventory: (inv, machine) => router.reconcileWorker(inv, machine),
    onCall: (method, params) => answer!(method, params),
    snapshot: () => ({ version: ++version, state: store.state, agentHomes: { claude: claude.dir, codex: codex.dir, opencode: opencode.dir }, home: os.homedir() }),
    mirror: new Mirror({ claudeDir: claudePaths().dir, codexDir: codexPaths().dir, homedir: os.homedir(), agentProfiles: paths.agentProfiles, log }),
    ...(homeDocs && { docs: homeDocs }),
  });
  const calls: Record<string, (params: unknown) => Promise<unknown>> = {};
  const outbox = worker && Outbox.open(paths);
  const connection = worker && outbox && new HomeConnection({
    paths, worker: worker.worker, me, store, outbox, log, release: releaseVersion(), bootId: bootId() ?? crypto.randomUUID(), handlers: calls,
    onAcked: (dropped) => mutations?.acked(dropped),
  });
  const workerDocs = connection ? new WorkerDocs({ dir: paths.docs, file: paths.docsSynced, stage: paths.cache, connection, log }) : undefined;
  const router = new Router({
    store, me, log, links, ...(replay && { replay, homedir: os.homedir() }), ...(worker && connection && { home: { id: worker.worker.homeMachineId, connection } }),
  });
  const fleet = new Fleet({
    store, tmux, paths, config, log, ownership, agentsFound, remote: router,
    // a worker names a clone as the home does once a snapshot has said where the home's user folder is
    repoRoot: (c) => homeRootOf(c, store.state.machines, worker ? store.state.machines?.[worker.worker.homeMachineId]?.home : os.homedir()),
    ...(connection && { report: (r: RobotSync) => connection.report(r), created: (c: Robot, p: ParsedParams<'robot.create'>) => mutations?.created(c, p) }),
  });
  // what the CLI in a worker's panes starts there, and changes there while its home is away
  const mutations = connection && outbox && new WorkerMutations({
    store, fleet, connection, outbox, me, paths, log, forget: (id) => forgetRobot({ fleet, store, me, log }, id),
  });
  const terminals = new TerminalHub(fleet, tmux, store, log, links && { router, links });
  // what each machine's agent CLIs are: a handover and a move read them
  const agents = agentProber(realProbeDeps(paths.env));
  if (connection && worker && workerDocs) {
    const prepare = new PrepareService({
      store, fleet, tmux, viewers: terminals, connection, me, fleetId: config.id, homeName: worker.worker.homeName, paths, git: handoverGit, agents, log,
    });
    const mirror = mirrorCalls({
      claudeDir: claudePaths().dir, codexDir: codexPaths().dir, homedir: os.homedir(), agentProfiles: paths.agentProfiles, overrides: paths.mirrorOverrides,
      stage: paths.cache, connection, log,
    });
    Object.assign(calls, workerCalls({ fleet, store, me, log, terminals }), prepare.handlers, mirror, workerDocs.handlers);
  }
  // the gateway is the one fleet.json names at each call: `svall host enable` or a recovery can name another while the daemon runs
  const gatewayNow = (): MachineId | undefined => {
    try { return namedGateway(paths); } catch { return config.gatewayMachineId; }
  };
  const placement = links && new Placement({
    store, fleet, links, me, fleetId: config.id, paths, git: handoverGit, agents, gateway: gatewayNow, release: releaseVersion(), homedir: os.homedir(), tmux, viewers: terminals, log,
  });
  const authority = (): Authority | undefined => {
    if (off.has('gateway')) return undefined;
    const named = gatewayNow();
    return named ? opts.authority ?? { get: (id) => fleetAuthority({ gatewayMachineId: named, machineId: me }).get(id) } : undefined;
  };
  const handover = new HandoverService({
    ownership, journal: openJournal(paths), agents, fleet, setGateway: (id) => setGateway(paths, config, id),
    ...(process.platform === 'linux' && { linger: () => lingerState(realRun, os.userInfo().username).then((l) => ({ user: l.user, on: l.linger })) }),
    authorityFor: (id) => opts.authority ?? { get: (fleetId) => fleetAuthority({ gatewayMachineId: id, machineId: me }).get(fleetId) },
    source: {
      paths, store, fleet, tmux, viewers: terminals, log,
      authority,
    },
    destination: {
      paths, config, store, fleet, tmux, log, authority,
      // Svall's hooks run the private fleet's script, whichever fleet sets them up
      codexTrust: (codexHome) => recordedTrust(codexHome, resolvePaths(profileHome(PRIVATE)).hookScript),
    },
  });
  // what a worker's agent CLIs are, which the home reads before it moves a robot there
  if (connection) calls['system.info'] = () => systemInfo({ ownership, handover });
  const journal = handover.journalState();
  await enterStartupMode(startupMode({ ownership, journal, config }), { ownership, journal, log, standalone: !gateway });
  // a machine that shares another's id takes no record from the gateway: one naming that id may mean the other machine
  const asked = (): Authority | undefined => (copied ? undefined : authority());
  const answered = await adoptAtStart({ handover, authority: asked(), fleetId: config.id, log });
  const claude = claudePaths();
  const codex = codexPaths();
  // looked up on every call, so a fleet made while this one runs is kept out too; any folder named like a fleet home
  // counts, set up or not
  const homes = () => fleetHomes(paths.home);
  const refused = () => [claude.json, path.join(claude.dir, '.credentials.json'), path.join(codex.dir, 'auth.json'),
    path.join(opencode.data, 'auth.json'), path.join(opencode.data, 'mcp-auth.json'),
    ...homes().flatMap((h) => fleetKeys(resolvePaths(h)))];
  const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude, codex, paths.docs, paths.agentProfiles, (c) => router.runsHere(c)), log, refused, [paths.docs, paths.agentProfiles], paths.trash);
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
  const stop = () => (stopping ??= (async () => { for (const fn of teardown.splice(0).reverse()) await fn(); })());
  try {
    await fleet.start();
    if (!off.has('push')) teardown.push(startPusher({ store, push, send: webPushSender(vapid), log, logins: mobile.logins, served: mobile.served, contact: config.mobile.pushContact }));
    // a running server keeps its old options if the new conf has a line this tmux rejects; a replica
    // has no server to source into
    if (ownership.writable()) await tmux.sourceConf().catch((e: Error) => log.error(`tmux source-file: ${e.message}`));
    const port = opts.port ?? config.port;
    const listen = (at: number) => startApi({
      host: opts.host ?? config.host, port: at, token, store, fleet, fleets: off.has('fleets') ? workerStubs.fleets : fleetControl(paths.home, realFleetDeps()), terminals, workspace, usage, load: () => load.get(), mobileControl: mobile, log,
      origins: () => config.mobile.origins, logins: mobile.logins, key: key.get, pass, push, vapidPublicKey: vapid.publicKey, phones, claude, codex, docs: paths.docs, agentProfiles: paths.agentProfiles, ownership, handover,
      fleetName: () => store.state.name ?? (profile !== PRIVATE && isProfileName(profile) ? profile : undefined), router, placement, links,
      ...(mutations && { mutations }),
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
    // a record the gateway took while this daemon ran that names another owner, as a recovery that could not reach it writes, lets the fleet go here
    if (!off.has('gateway')) teardown.push(watchGateway({ handover, authority: asked, fleetId: config.id, machineId: me, log, everyMs: opts.gatewayEveryMs, answered }));
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
