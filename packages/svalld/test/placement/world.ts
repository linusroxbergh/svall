import crypto from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { vi } from 'vitest';
import { MachineId, emptyState, type Event, type FleetState, type Island, type Robot } from '@svall/protocol';
import { answer, type Ctx } from '../../src/api/methods.js';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { HomeLinks, type Transport } from '../../src/link/home.js';
import { HomeConnection } from '../../src/link/worker.js';
import { silentLogger, type Logger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { resolvePaths, type Paths } from '../../src/paths.js';
import { HomeDocs, WorkerDocs, noteConflict } from '../../src/placement/docs-sync.js';
import { FarViewers, RemoteWatches, ViewerNotice } from '../../src/placement/far-viewers.js';
import { Mirror, mirrorCalls, type MirrorHomes } from '../../src/placement/mirror.js';
import { homeRootOf } from '../../src/placement/repo-key.js';
import { Replay } from '../../src/placement/replay.js';
import { Router, fileCalls, forgetRobot, workerCalls } from '../../src/placement/router.js';
import { issueToken } from '../../src/placement/workers.js';
import type { RunScribe } from '../../src/scribe/run.js';
import { rootHere, scanResources, workspaceRoot } from '../../src/resources/scan.js';
import { Store } from '../../src/store.js';
import { TerminalHub } from '../../src/terminals.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { fleetUsage, type FetchUsage } from '../../src/usage/usage.js';
import { WorkerMutations } from '../../src/worker/mutations.js';
import { Workspace } from '../../src/workspace/workspace.js';
import { Outbox } from '../../src/worker/outbox.js';
import { applyReport } from '../../src/worker/snapshot.js';
import { makeHome } from '../helpers.js';

export const W = MachineId.parse(crypto.randomUUID());
export const H = MachineId.parse(crypto.randomUUID());
const entry: MachineEntry = { id: W, record: { name: 'w1', ssh: 'w1', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall', gateway: false } };
const agentHomes = { claude: '/Users/ada/.claude', codex: '/Users/ada/.codex', opencode: '/Users/ada/.config/opencode' };
const via = { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' };

export const island: Island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
export const robot = (o: Partial<Robot> & { id: string }): Robot => ({
  islandId: 'i_1', cell: { x: 0, y: 0 }, name: o.id, note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
});
export const placed = (o: Partial<Robot> & { id: string }): Robot => robot({ machine: W, placement: { generation: 1 }, ...o });

// real sockets under a loaded run
export const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 50 });

// a tmux any call to which fails the test: the home never touches one for a robot placed elsewhere
const untouchable = new Proxy({}, { get: (_t, k) => () => { throw new Error(`tmux.${String(k)} was called`); } }) as Tmux;

// a unix socket onto the worker's link.sock, as the far `svall worker link` would be
const socketTo = (sock: string): Transport => async () => {
  const stream = net.connect(sock);
  await once(stream, 'connect');
  return { stream, via };
};

const viewer: Ctx['viewer'] = { kind: 'app', send: () => {}, backlog: () => 0 };

function storeWith(paths: Paths, state: Partial<FleetState>): Store {
  const store = Store.load(paths.state, () => {});
  store.update((d) => { Object.assign(d, { ...emptyState(), islands: { i_1: island }, ...structuredClone(state) }); });
  return store;
}

// the parts of the API context the calls under test read
const ctxOf = (store: Store, fleet: Fleet, ownership: OwnershipState, router: Router, more: Partial<Ctx>): Ctx => ({ store, fleet, ownership, router, viewer, ...more }) as unknown as Ctx;

type Handlers = Record<string, (p: unknown) => Promise<unknown>>;

/**
 * A home and its worker w1, each with its store, fleet, router and API context, linked over the worker's real
 * link.sock; `far` stands in for what the worker answers the home with, `connect` for reaching it; `docs` syncs the
 * fleet's docs as main.ts does, each watcher quiet for 100 ms, `mirror` names each side's agent homes for the mirror,
 * and the home's replay, router and docs log to `homeLog`; each side reads its robots' usage as main.ts does, its
 * Claude login answering with `usage.claude` and each rollout with its text in `usage.tails`; `scribe` answers each
 * side's scribe passes, and the worker's scribe is off as main.ts has it. Each side reads its own robots' files, the
 * home a placed robot's through the worker, and each has a Claude dir of its own under its home.
 */
export function world(o: {
  home?: Partial<FleetState>; worker?: Partial<FleetState>; far?: Handlers; connect?: Transport; tmux?: Partial<Tmux>; docs?: true;
  mirror?: { home: MirrorHomes; worker: MirrorHomes & { overrides: string } }; homeLog?: Logger;
  usage?: { claude?: FetchUsage; tails?: Record<string, string> }; scribe?: { home?: RunScribe; worker?: RunScribe };
}) {
  const config = Config.parse({});
  const stops: (() => unknown)[] = [];
  const usageOf = (store: Store, router: Router): FetchUsage => fleetUsage({
    state: () => store.state, claude: o.usage?.claude ?? (async () => ({ available: false, windows: [] })),
    readTail: (file) => o.usage?.tails?.[file] ?? '', runsHere: (c) => router.runsHere(c),
  });

  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  workerPaths.docs = path.join(workerPaths.cache, 'docs');
  const token = issueToken(homePaths, W);
  const homeStore = storeWith(homePaths, o.home ?? {});
  const homeOwnership = OwnershipState.load({ paths: homePaths, fleetId: config.id, machineId: H, log: silentLogger, standalone: true });
  let version = 100;
  const homeLog = o.homeLog ?? silentLogger;
  const homeDocs = o.docs && new HomeDocs(homePaths.docs, homeLog, (m) => homeStore.state.machines?.[m]?.name ?? m, 100);
  // while `hold` holds, the next mutation waits
  let held: Promise<void> | undefined;
  const links: HomeLinks = new HomeLinks({
    paths: homePaths, store: homeStore, log: silentLogger, release: '1.2.3', machines: () => [entry], connect: o.connect ?? socketTo(workerPaths.linkSock),
    onReport: (r, machine) => { applyReport(homeStore, r, machine); },
    onEvent: async (kind, data, machine) => {
      if (kind === 'mutation') {
        await held;
        return replay.prepare(data, machine);
      }
      if (!homeDocs || (kind !== 'docs.write' && kind !== 'docs.delete')) throw new Error(`no ${kind}`);
      const conflict = homeDocs.apply(kind, data, machine);
      return conflict && { change: () => noteConflict(homeStore, machine, conflict, '/Users/ada'), docs: true as const };
    },
    onInventory: (inv, machine) => homeRouter.reconcileWorker(inv, machine),
    onCall: (method, params) => answer(method, params, homeCtx),
    onNotify: (kind, data) => {
      if (kind !== 'viewer') return;
      const { key, ev } = ViewerNotice.parse(data);
      remoteWatches.farEvent(key, ev as Event);
    },
    onSynced: (machine) => { void remoteWatches.reopen(machine); },
    snapshot: () => ({ version: ++version, state: homeStore.state, agentHomes, home: '/Users/ada' }),
    ...(homeDocs && { docs: homeDocs }),
    ...(o.mirror && { mirror: new Mirror({ ...o.mirror.home, log: silentLogger }) }),
  });
  const replay = new Replay({ store: homeStore, paths: homePaths, log: homeLog });
  const homeRouter = new Router({ store: homeStore, me: H, log: homeLog, links, replay, homedir: '/Users/ada' });
  const homeDocsRoot = (c: Robot) => homeRootOf(c, homeStore.state.machines, '/Users/ada');
  const homeFleet = new Fleet({
    store: homeStore, tmux: untouchable, paths: homePaths, config, log: silentLogger, ownership: homeOwnership, remote: homeRouter,
    repoRoot: homeDocsRoot, runScribe: o.scribe?.home,
  });
  const homeUsage = usageOf(homeStore, homeRouter);
  const homeClaude = { dir: path.join(homePaths.home, 'claude'), json: path.join(homePaths.home, 'claude.json') };
  const homeRoots = rootHere((c) => homeRouter.runsHere(c));
  const homeWorkspace = new Workspace(
    (id) => workspaceRoot(id, homeStore.state, homeClaude, undefined, homePaths.docs, homePaths.agentProfiles, (c) => homeRouter.runsHere(c), homeRoots, homeDocsRoot),
    silentLogger, () => [], [homePaths.docs, homePaths.agentProfiles],
  );
  const remoteWatches = new RemoteWatches({ links, router: homeRouter });
  const homeCtx = ctxOf(homeStore, homeFleet, homeOwnership, homeRouter, {
    usage: homeUsage, links, workspace: homeWorkspace, remoteWatches, claude: homeClaude, docs: homePaths.docs, agentProfiles: homePaths.agentProfiles,
  });

  const workerStore = storeWith(workerPaths, o.worker ?? {});
  workerStore.update((d) => { d.scribeOff = true; });
  const workerOwnership = OwnershipState.load({ paths: workerPaths, fleetId: config.id, machineId: W, log: silentLogger, standalone: true });
  const handlers: Handlers = {};
  const outbox = Outbox.open(workerPaths);
  const connection = new HomeConnection({
    paths: workerPaths, worker: { homeMachineId: H, fleetId: config.id, token, homeName: 'mac' }, me: W, store: workerStore, outbox,
    log: silentLogger, release: '1.2.3', bootId: 'boot-1', handlers, onAcked: (dropped) => mutations.acked(dropped),
    onLink: (live) => { if (!live) for (const v of farViewers.dropAll()) workerWorkspace.unwatchAll(v); },
  });
  const farViewers = new FarViewers({ connection });
  const workerRouter = new Router({ store: workerStore, me: W, log: silentLogger, home: { id: H, connection } });
  const workerTmux = { ...o.tmux } as Tmux;
  const workerDocsRoot = (c: Robot) => homeRootOf(c, workerStore.state.machines, workerStore.state.machines?.[H]?.home);
  const workerFleet = new Fleet({
    store: workerStore, tmux: workerTmux, paths: workerPaths, config, log: silentLogger, ownership: workerOwnership, remote: workerRouter,
    report: (r) => connection.report(r), readProcs: async () => [], processes: async () => [], refreshLinks: async () => {},
    created: (c, p) => mutations.created(c, p), repoRoot: workerDocsRoot,
    runScribe: o.scribe?.worker,
  });
  const forget = (id: string) => forgetRobot({ fleet: workerFleet, store: workerStore, me: W, log: silentLogger }, id);
  const mutations = new WorkerMutations({ store: workerStore, fleet: workerFleet, connection, outbox, me: W, paths: workerPaths, log: silentLogger, forget });
  const terminals = new TerminalHub(workerFleet, workerTmux, workerStore, silentLogger);
  const workerUsage = usageOf(workerStore, workerRouter);
  const workerClaude = { dir: path.join(workerPaths.home, 'claude'), json: path.join(workerPaths.home, 'claude.json') };
  const workerRoots = rootHere((c) => workerRouter.runsHere(c));
  const workerWorkspace = new Workspace(
    (id) => workspaceRoot(id, workerStore.state, workerClaude, undefined, workerPaths.docs, workerPaths.agentProfiles, (c) => workerRouter.runsHere(c), workerRoots, workerDocsRoot),
    silentLogger, () => [], [workerPaths.docs, workerPaths.agentProfiles],
  );
  const workerResources = () => scanResources(workerStore.state, workerClaude, undefined, workerPaths.docs, workerPaths.agentProfiles, workerRoots);
  const workerDocs = o.docs && new WorkerDocs({
    dir: workerPaths.docs, file: workerPaths.docsSynced, stage: workerPaths.cache, connection, log: silentLogger, quietMs: 100,
  });
  Object.assign(
    handlers, o.far ?? {
      ...workerCalls({ fleet: workerFleet, store: workerStore, me: W, log: silentLogger, terminals }),
      ...fileCalls({ workspace: workerWorkspace, viewers: farViewers, resources: workerResources }), 'usage.get': () => workerUsage(),
    }, workerDocs?.handlers,
    o.mirror && mirrorCalls({ ...o.mirror.worker, stage: workerPaths.cache, connection, log: silentLogger }),
  );
  const workerCtx = ctxOf(workerStore, workerFleet, workerOwnership, workerRouter, { mutations, usage: workerUsage, workspace: workerWorkspace });

  for (const [store, workspace] of [[homeStore, homeWorkspace], [workerStore, workerWorkspace]] as const) stops.push(store.subscribe(() => workspace.retarget()), () => workspace.close());
  stops.push(() => connection.stop(), () => links.stop(), () => workerDocs?.stop());
  return {
    home: {
      paths: homePaths, store: homeStore, fleet: homeFleet, router: homeRouter, links, ctx: homeCtx, docs: homeDocs, replay, usage: homeUsage,
      /** Holds the mutations the home takes from here on, until the function it returns is called. */
      hold(): () => void {
        let release!: () => void;
        held = new Promise((r) => { release = r; });
        return () => { held = undefined; release(); };
      },
    },
    worker: { paths: workerPaths, store: workerStore, fleet: workerFleet, router: workerRouter, connection, ctx: workerCtx, docs: workerDocs, outbox, tmux: workerTmux, mutations, usage: workerUsage, handlers },
    /** Both ends up, and the worker synced. */
    async link(): Promise<void> {
      workerDocs?.start();
      await connection.start();
      links.start();
      await until(() => { if (!links.for(W)?.synced) throw new Error('w1 is not synced yet'); });
    },
    async stop(): Promise<void> { for (const s of stops.splice(0).reverse()) await s(); },
  };
}
