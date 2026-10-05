import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCodexHooks, readCodexHooks } from './agent-hooks.js';
import { startApi } from './api/server.js';
import { findAgents } from './agents.js';
import { codexPaths } from './codex/install.js';
import { fleetMainAgent, keptPorts, loadConfig, saveConfig } from './config.js';
import { Fleet } from './fleet.js';
import { fleetControl, realFleetDeps } from './fleets.js';
import { startHookReceiver } from './hooks/receiver.js';
import { createLogger, rotateLog, type Logger } from './log.js';
import { mobileControl, phoneKey, realDeps, watchServed } from './mobile.js';
import { claudePaths, fleetKeys, resolvePaths } from './paths.js';
import { Phones } from './phones.js';
import { DEFAULT_PORT, isProfileName, PRIVATE, profileOf, variantOf } from './profile.js';
import { runtimeVersion, variant } from './runtime.js';
import { startPusher, webPushSender } from './push/pusher.js';
import { PushStore } from './push/store.js';
import { readOrCreateVapid } from './push/vapid.js';
import { workspaceRoot } from './resources/scan.js';
import { installHookScripts } from './setup.js';
import { Store } from './store.js';
import { TerminalHub } from './terminals.js';
import { tmuxConfText, tmuxTooOld } from './tmux/conf.js';
import { Tmux } from './tmux/tmux.js';
import { cachedUsage, fleetUsage, usageFetcher } from './usage/usage.js';
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

// a kernel lock: it holds until the file is closed or the daemon dies, however it dies
function lockHome(home: string): () => void {
  const { O_RDWR, O_CREAT, O_NONBLOCK } = fs.constants;
  try {
    let fd = fs.openSync(path.join(home, 'daemon.lock'), O_RDWR | O_CREAT | O_NONBLOCK | O_EXLOCK, 0o600);
    // once only: by a second close the number may name another open file
    return () => { if (fd >= 0) fs.closeSync(fd); fd = -1; };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EAGAIN') throw new Error(`svalld is already running for ${home}`);
    throw e;
  }
}

type Options = { home: string; port?: number; host?: string; log?: Logger };

export class OtherBuildHome extends Error {}

// the lock comes before anything in the home is read or written, so a second start leaves the running one be
export async function startDaemon(opts: Options): Promise<Daemon> {
  // a checkout's daemon on the release's home, or the reverse, would run it on the other build's ports and folders
  const owner = variantOf(opts.home);
  if (owner && owner !== variant) throw new OtherBuildHome(`${opts.home} belongs to ${owner === 'dev' ? 'Svall Dev' : 'Svall'}, not to this build`);
  fs.mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  const unlock = lockHome(opts.home);
  const daemon = await start(opts).catch((e: unknown) => { unlock(); throw e; });
  return { ...daemon, stop: async () => { await daemon.stop(); unlock(); } };
}

async function start(opts: Options): Promise<Daemon> {
  const paths = resolvePaths(opts.home);
  fs.chmodSync(paths.home, 0o700);
  rotateLog(paths.log);
  const log = opts.log ?? createLogger();
  const config = loadConfig(paths.config);
  // a state.json this svalld refuses stops it before the hooks, tmux.conf and Codex's trust are touched
  const store = Store.load(paths.state, log.error);
  installHookScripts(paths);
  fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
  const token = readOrCreateToken(paths.token);
  const key = phoneKey(paths.mobileKey, readOrCreateToken(paths.mobileKey));
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

  const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
  const tmuxVersion = await tmux.version();
  if (tmuxTooOld(tmuxVersion)) log.error(`${tmuxVersion} is older than 3.5: Shift+Enter will not reach Claude Code; brew upgrade tmux`);
  // the app attaches its terminals with this tmux, which an app opened from Finder may not find on its own PATH
  fs.writeFileSync(path.join(paths.home, 'tmux-binary'), tmux.binary);
  fs.writeFileSync(path.join(paths.home, 'version'), `${runtimeVersion()}\n${process.pid}\n`);
  const fleet = new Fleet({ store, tmux, paths, config, log, agentsFound });
  const terminals = new TerminalHub(fleet, tmux, store, log);
  const claude = claudePaths();
  const codex = codexPaths();
  // looked up on every call, so a fleet made while this one runs is kept out too; any folder named like a fleet home
  // counts, set up or not
  const homes = () => [paths.home, ...fs.readdirSync(os.homedir()).filter((f) => f.startsWith('.svall')).map((f) => path.join(os.homedir(), f))];
  const refused = () => [claude.json, path.join(claude.dir, '.credentials.json'), path.join(codex.dir, 'auth.json'),
    ...homes().flatMap((h) => fleetKeys(resolvePaths(h)))];
  const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude, codex, paths.docs, paths.agentProfiles), log, refused, [paths.docs, paths.agentProfiles], paths.trash);
  const phones = new Phones();
  const mobile = mobileControl(realDeps(), {
    home: paths.home, profile, logins: config.mobile.logins, phones, httpsPort: config.mobile.httpsPort, rotateKey: key.rotate,
    kept: () => keptPorts(homes().filter((h) => h !== paths.home)),
    savePort: (httpsPort) => {
      try { saveConfig(paths.config, { mobile: { httpsPort } }); return true; } catch (e) { log.error(`phone port ${httpsPort} not saved: ${(e as Error).message}`); return false; }
    },
  });
  const usage = fleetUsage({ state: () => store.state, claude: cachedUsage(usageFetcher({ cwd: path.join(paths.home, 'usage'), envFile: paths.env }), USAGE_TTL_MS) });

  // run in reverse on stop, and on a failed start for whatever had already started
  const teardown: (() => unknown)[] = [() => fleet.stop(), store.subscribe(() => workspace.retarget()), () => workspace.close()];
  // a second stop, as a second signal sends, waits for the first to have the fleet on disk
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= (async () => { for (const fn of teardown.splice(0).reverse()) await fn(); })());
  try {
    await fleet.start();
    teardown.push(startPusher({ store, push, send: webPushSender(vapid), log, logins: mobile.logins, served: mobile.served, contact: config.mobile.pushContact }));
    // a running server keeps its old options if the new conf has a line this tmux rejects
    await tmux.sourceConf().catch((e: Error) => log.error(`tmux source-file: ${e.message}`));
    const port = opts.port ?? config.port;
    const listen = (at: number) => startApi({
      host: opts.host ?? config.host, port: at, token, store, fleet, fleets: fleetControl(paths.home, realFleetDeps()), terminals, workspace, usage, mobileControl: mobile, log,
      origins: config.mobile.origins, logins: mobile.logins, key: key.get, push, vapidPublicKey: vapid.publicKey, phones, claude, codex, docs: paths.docs, agentProfiles: paths.agentProfiles,
      fleetName: () => store.state.name ?? (profile !== PRIVATE && isProfileName(profile) ? profile : undefined),
    });
    // clients find the daemon by its port file, so one that names no port takes a free one while its default is held
    const api = await listen(port ?? DEFAULT_PORT).catch((e: NodeJS.ErrnoException) => {
      if (port !== undefined || e.code !== 'EADDRINUSE') throw e;
      log.info(`port ${DEFAULT_PORT} is taken: listening on a free one`);
      return listen(0);
    });
    teardown.push(() => api.close());
    const hooks = await startHookReceiver(paths.hooksSock, (e) => fleet.onSocketEvent(e), log);
    teardown.push(() => hooks.close());
    await fleet.resumeInterrupted();
    fs.writeFileSync(paths.port, String(api.port));
    // gone last: whoever waits for it to go may read state.json next
    teardown.unshift(() => fs.rmSync(paths.port, { force: true }));
    // pushes go out only over a link seen served: it is looked at once the port it proxies to is known,
    // and again while a device waits and tailscale has not answered
    teardown.push(watchServed(mobile, () => push.list().length > 0, LOOK_AGAIN_MS));
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
