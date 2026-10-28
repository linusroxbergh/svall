import os from 'node:os';
import { z, type ZodTypeAny } from 'zod';
import { ApiError, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, methods, serverWait, type LoadSnapshot, type MachineId, type MethodName, type ParsedParams, type Request, type Response, type Result, type SetupRow, type SystemInfo } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { Fleets } from '../fleets.js';
import { gitVersion } from '../links/git.js';
import { askWorkers, type HomeLinks } from '../link/home.js';
import type { Mobile } from '../mobile.js';
import type { PushStore } from '../push/store.js';
import type { CodexPaths } from '../codex/install.js';
import { envValueFault } from '../env-file.js';
import { errorFrame } from '../errors.js';
import type { ClaudePaths } from '../paths.js';
import { mergeSources } from '../resources/merge.js';
import { listsDeletable, rootHere, rootIdOf, scanResources } from '../resources/scan.js';
import type { RemoteWatches } from '../placement/far-viewers.js';
import type { Mirror } from '../placement/mirror.js';
import type { Placement } from '../placement/move.js';
import type { Router } from '../placement/router.js';
import { releaseVersion } from '../release.js';
import type { Retro } from '../retro/service.js';
import { agentAdapters, type AgentProber } from '../sessions/registry.js';
import type { Store } from '../store.js';
import type { TerminalHub, Viewer } from '../terminals.js';
import { mergeUsage } from '../usage/merge.js';
import type { FetchUsage } from '../usage/usage.js';
import type { WorkerMutations } from '../worker/mutations.js';
import { WorkspaceError } from '../workspace/errors.js';
import type { Workspace } from '../workspace/workspace.js';
import { classification } from './classify.js';

export type Ctx = { store: Store; fleet: Fleet; fleets: Fleets; systemInfo: () => Promise<SystemInfo>; terminals: TerminalHub; workspace: Workspace; usage: FetchUsage; load: () => Promise<LoadSnapshot>; mobile: Mobile; push: PushStore; vapidPublicKey: string; viewer: Viewer; claude: ClaudePaths; codex?: CodexPaths; docs?: string; agentProfiles?: string; router?: Router; placement?: Placement; links?: Pick<HomeLinks, 'refresh' | 'call' | 'connectedWorkers' | 'for'>; mirror?: Mirror; fleetFlag?: string; mutations?: WorkerMutations; remoteWatches?: RemoteWatches; retro?: Retro; signal?: AbortSignal };

// what starts launchd agents and names fleets stays with the Mac
const DESKTOP_ONLY = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start', 'fleet.rename', 'fleet.stop', 'machines.setup', 'machines.consent', 'machines.updateAgents', 'machines.setVar'] satisfies MethodName[]);
// the fleets beside this one are a Mac's: a Linux daemon has no launchd to start them with
const MAC_ONLY = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start'] satisfies MethodName[]);

type Handlers = { [M in MethodName]: (p: ParsedParams<M>, ctx: Ctx) => Promise<Result<M>> | Result<M> };

// moves are the home's: a worker sends them on before they reach a handler
const placementOf = ({ placement }: Ctx): Placement => {
  if (!placement) throw new ApiError('not_on_worker', 'not on a worker');
  return placement;
};

// the retro reads the agents' stores where the fleet runs
const retroOf = ({ retro }: Ctx): Retro => {
  if (!retro) throw new ApiError('not_on_worker', 'the retro runs on the fleet\'s home');
  return retro;
};

// the agent configuration a worker takes is its home's
const mirrorOf = ({ mirror }: Ctx): Mirror => {
  if (!mirror) throw new ApiError('not_on_worker', 'not on a worker');
  return mirror;
};

// the setup rows of `machine`, asked of its worker once the link is up or `waitMs` has passed
async function setupOf(ctx: Ctx, machine: MachineId, waitMs: number, robot?: string): Promise<{ rows: SetupRow[] }> {
  const mirror = mirrorOf(ctx);
  if (robot !== undefined && !Object.hasOwn(ctx.store.state.robots, robot)) throw new ApiError('not_found', `no robot ${robot}`);
  const link = ctx.links?.for(machine);
  await link?.linked(waitMs);
  const { machines, robots } = ctx.store.state;
  const c = robot === undefined ? undefined : robots[robot];
  // a robot's folders, where it runs on a worker, under that worker's home
  const far = c?.machine && machines?.[c.machine]?.home;
  const only = c && {
    agents: [c.agent?.kind, c.second?.agent?.kind].filter((k) => k !== undefined), folders: [c.cwd, c.repo?.mainRoot, c.second?.cwd].filter((f) => f !== undefined),
    ...(far && { home: far }),
  };
  return { rows: await mirror.report(link, machine, { name: machines?.[machine]?.name ?? machine, fleetFlag: ctx.fleetFlag ?? '', ...(only && { robot: only }) }) };
}

// the folders a scan here lists are those of the robots that run here
const roots = ({ router }: Pick<Ctx, 'router'>) => router && rootHere((c) => router.runsHere(c));

// a placed robot's files are read where it runs and changed in its terminal there
function refuseRemote({ router, store }: Pick<Ctx, 'router' | 'store'>, id: string, rel: string): void {
  const at = router?.rootPlacedAt(id);
  if (at) throw new ApiError('read_only', `${rel} is on ${store.state.machines?.[at]?.name ?? at}; edit it in the robot's terminal`);
}

// svalld runs on macOS and Linux alone; nothing else gets this far
const platform = (): 'darwin' | 'linux' => (process.platform === 'linux' ? 'linux' : 'darwin');

const handlers: Handlers = {
  'state.get': (_p, { store }) => store.state,
  'island.create': (p, { fleet }) => fleet.createIsland(p),
  'island.update': (p, { fleet }) => fleet.updateIsland(p.id, p),
  'island.delete': (p, { fleet }) => { fleet.deleteIsland(p.id); return {}; },
  'island.arrange': (p, { fleet }) => { fleet.arrangeIslands(p.aspect, p.homeRoom); return {}; },
  'island.show': (p, { fleet }) => ({ text: fleet.islandBrief(p.id) }),
  'island.reorder': (p, { fleet }) => fleet.reorderIsland(p.id, p.targetId, p.after),
  'robot.create': (p, { fleet }) => fleet.createRobot(p),
  'robot.update': (p, { fleet }) => fleet.updateRobot(p.id, p),
  'robot.move': (p, { fleet }) => fleet.moveRobot(p.id, p.islandId, p.cell),
  'robot.reorder': (p, { fleet }) => fleet.reorderRobot(p.id, p.targetId, p.after),
  'robot.star': (p, { fleet }) => fleet.starRobot(p.id, p.targetId, p.after),
  'robot.unstar': (p, { fleet }) => fleet.unstarRobot(p.id),
  'robot.place': (p, { fleet }) => fleet.placeRobot(p.id, p.columnId),
  'robot.release': (p, { fleet }) => fleet.releaseRobot(p.id),
  'robot.close': async (p, { fleet }) => { await fleet.closeRobot(p.id); return {}; },
  'robot.sleep': async (p, { fleet }) => { await fleet.sleepRobot(p.id); return {}; },
  'robot.revive': (p, { fleet }) => fleet.reviveRobot(p.id),
  'robot.fresh': (p, { fleet }) => fleet.startFresh(p.id, p.term),
  // `unread` is the machine's the robot runs on
  'robot.seen': (p, { fleet, router }) => router?.forward(p.id, 'robot.seen', p) ?? fleet.markSeen(p.id, p.term),
  'robot.second': (p, { fleet }) => fleet.openSecond(p.id),
  'robot.run': async (p, { fleet }) => ({ delivery: await fleet.run(p.id, p.text, p.enter, p.term) }),
  // a placed robot's transcript is on the machine it runs on
  'robot.read': async (p, { fleet, router }) => router?.forward(p.id, 'robot.read', p) ?? {
    text: p.source === 'screen' ? await fleet.readScreen(p.id, p.lines, p.term) : fleet.readTranscript(p.id, p.lines, p.term),
  },
  'robot.prompts': (p, { fleet, router }) => router?.forward(p.id, 'robot.prompts', p) ?? { prompts: fleet.readPrompts(p.id, p.limit) },
  'robot.show': (p, { fleet }) => ({ text: fleet.brief(p.id) }),
  'robot.wait': async (p, { fleet, signal }) => ({ status: await fleet.waitFor(p.id, p.until, p.timeoutMs, signal, p.term) }),
  'robot.answer': async (p, { fleet }) => { await fleet.answerPrompt(p.id, p.answer, p.promptId); return {}; },
  // the plan stays with the move that builds it
  'robot.moveCheck': async (p, ctx) => {
    const r = await placementOf(ctx).check(p.id, p.machine, p);
    return r.ok ? { ok: true, sheet: r.sheet } : { ok: false, refusal: r.refusal };
  },
  'robot.moveTo': async (p, ctx) => ({ moveId: await placementOf(ctx).start(p.id, p.machine, p) }),
  'robot.moveRetry': async (p, ctx) => { await placementOf(ctx).retry(p.moveId); return {}; },
  'machines.list': (_p, { store }) => ({
    machines: Object.entries(store.state.machines ?? {}).map(([id, m]) => ({
      id: id as MachineId, name: m.name, reachable: m.reachable, release: m.release,
      robots: Object.values(store.state.robots).filter((r) => r.machine === id).length,
    })),
  }),
  'machines.refresh': (_p, { links }) => { links?.refresh(); return {}; },
  'machines.setup': (p, ctx) => setupOf(ctx, p.machine, p.waitMs ?? 0, p.robot),
  // the push goes after any under way and carries only what changed; one that fails leaves the tick saved for the next
  'machines.consent': async (p, ctx) => {
    const mirror = mirrorOf(ctx);
    const name = ctx.store.state.machines?.[p.machine]?.name;
    if (name === undefined) throw new ApiError('not_found', `no machine ${p.machine}`);
    mirror.consent(p.machine, p.item, p.fields, p.on);
    const link = ctx.links?.for(p.machine);
    if (link?.connected()) {
      await mirror.push(link).catch((e: Error) => { throw new ApiError('not_mirrored', `the change is saved, but ${name} did not take it: ${e.message}`); });
    }
    // the worker keeps the item as the mirror last wrote it while this Mac cannot read it
    const unread = mirror.unreadFile(p.item);
    if (unread) throw new ApiError('not_mirrored', `${unread} on this Mac cannot be read; the copy stays on ${name} until it can`);
    return setupOf(ctx, p.machine, 0);
  },
  'machines.updateAgents': async (p, { store, links }) => {
    if (!store.state.machines?.[p.machine]) throw new ApiError('not_found', `no machine ${p.machine}`);
    if (!links) throw new ApiError('not_on_worker', 'not on a worker');
    await links.call(p.machine, 'agents.update', { kinds: p.kinds }, { timeoutMs: serverWait('machines.updateAgents', p) });
    return {};
  },
  // the value goes to the worker's .env and nowhere on this Mac; no error names it
  'machines.setVar': async (p, ctx) => {
    const name = ctx.store.state.machines?.[p.machine]?.name;
    if (name === undefined) throw new ApiError('not_found', `no machine ${p.machine}`);
    if (!ctx.links) throw new ApiError('not_on_worker', 'not on a worker');
    const value = p.fromMac ? mirrorOf(ctx).hereValue(p.name) : p.value;
    if (!value) throw new ApiError('invalid_params', p.fromMac ? `this Mac has no ${p.name}` : 'no value given');
    const fault = envValueFault(value);
    if (fault) throw new ApiError('invalid_params', fault);
    await ctx.links.call(p.machine, 'env.set', { name: p.name, value }, { timeoutMs: serverWait('machines.setVar', p) }).catch((e: Error) => {
      if (e instanceof ApiError && e.code === 'unknown_method') throw new ApiError('not_mirrored', `${name} runs a release that cannot take a variable from here; upgrade it under Machines`);
      throw e;
    });
    return setupOf(ctx, p.machine, 0);
  },
  'column.add': (p, { fleet }) => fleet.addColumn(p.name, p.afterId),
  'column.rename': (p, { fleet }) => fleet.renameColumn(p.id, p.name),
  'column.reorder': (p, { fleet }) => fleet.reorderColumn(p.id, p.targetId, p.after),
  'column.delete': (p, { fleet }) => fleet.deleteColumn(p.id, p.moveTo),
  'scribe.sweep': async (p, { fleet }) => ({ lines: await fleet.sweep(p) }),
  'scribe.set': (p, { fleet }) => { fleet.setScribe(p.enabled); return {}; },
  'retro.plan': (p, ctx) => retroOf(ctx).plan(p),
  'retro.run': (p, ctx) => retroOf(ctx).run(p),
  'retro.status': (p, ctx) => retroOf(ctx).status(p.run),
  'retro.findings': (p, ctx) => retroOf(ctx).findings(p.run),
  'retro.mark': (p, ctx) => retroOf(ctx).mark(p),
  'retro.apply': (p, ctx) => retroOf(ctx).apply(p.id),
  'placing.set': (p, { fleet }) => { fleet.setPlacing(p.enabled); return {}; },
  'worktrees.set': (p, { fleet }) => { fleet.setWorktrees(p.enabled); return {}; },
  'dormancy.set': (p, { fleet }) => { fleet.setDormancy(p.hours); return {}; },
  'mainAgent.set': (p, { fleet }) => { fleet.setMainAgent(p.agent); return {}; },
  'model.set': (p, { fleet }) => { fleet.setModel(p.of, p.agent, p.model); return {}; },
  'fleets.list': async (_p, { fleets }) => ({ fleets: await fleets.list() }),
  'fleets.create': async (p, { fleets }) => ({ home: await fleets.create(p.name) }),
  'fleets.start': async (p, { fleets }) => ({ home: await fleets.start(p.home) }),
  'fleet.rename': (p, { fleet }) => { fleet.renameFleet(p.name); return {}; },
  'fleet.stop': async (_p, { fleet }) => { await fleet.stopAll(); return {}; },
  // each worker reads its own robots' usage, where their transcripts are
  'usage.get': async (_p, { usage, links }) => {
    if (!links) return usage();
    const [home, workers] = await Promise.all([usage(), askWorkers(links, 'usage.get')]);
    return mergeUsage(home, workers.map((w) => w.answer));
  },
  'load.get': (_p, { load }) => load(),
  'mobile.get': (_p, { mobile }) => mobile.get(),
  // an off revokes every device, even one tailscale refused, since the key has turned over: one that asks again has to reach the page first
  'mobile.set': async (p, { mobile, push }) => {
    const status = await mobile.set(p.enabled);
    if (!p.enabled) push.clear();
    return status;
  },
  // each worker lists the clones its robots work in, read there
  'resources.get': async (_p, ctx) => {
    const { store, claude, codex, docs, agentProfiles, links, router } = ctx;
    const sources = scanResources(store.state, claude, codex, docs, agentProfiles, roots(ctx));
    if (!links || docs === undefined) return { sources };
    const far = (await askWorkers(links, 'resources.get')).map((w) => ({ machine: w.machine, sources: w.answer.sources }));
    return { sources: mergeSources(sources, far, { docs, machines: store.state.machines, homedir: router?.homedir ?? os.homedir() }) };
  },
  'fs.list': async (p, { workspace, router, signal }) => router?.forwardRoot(p.id, 'fs.list', p, signal) ?? { entries: await workspace.list(p.id, p.path) },
  'fs.read': (p, { workspace, router, signal }) => router?.forwardRoot(p.id, 'fs.read', p, signal) ?? workspace.read(p.id, p.path),
  'fs.write': (p, ctx) => { refuseRemote(ctx, p.id, p.path); return ctx.workspace.write(p.id, p.path, p.text, p.mtimeMs, p.root); },
  'docs.create': (p, { workspace }) => workspace.create(p.id, p.path, p.text),
  'docs.rename': (p, { workspace, fleet, agentProfiles }) => {
    workspace.rename(p.id, p.path, p.to);
    if (agentProfiles !== undefined && p.id === rootIdOf(agentProfiles)) fleet.renameAgentProfile(p.path.slice(0, -3), p.to.slice(0, -3));
    return {};
  },
  'docs.delete': (p, { workspace }) => { workspace.remove(p.id, p.path); return {}; },
  'resources.delete': (p, ctx) => {
    const { store, claude, codex, docs, agentProfiles, workspace } = ctx;
    refuseRemote(ctx, p.id, p.path);
    if (!listsDeletable(scanResources(store.state, claude, codex, docs, agentProfiles, roots(ctx)), p.id, p.path)) throw new WorkspaceError('invalid', `${p.path} is not a skill, agent, command or memory file the shelf lists`);
    return { token: workspace.setAside(p.id, p.path) };
  },
  'resources.restore': (p, { workspace }) => { workspace.putBack(p.token); return {}; },
  'repo.status': (p, { workspace, router, signal }) => router?.forwardRoot(p.id, 'repo.status', p, signal) ?? workspace.status(p.id, p.base),
  'repo.file': (p, { workspace, router, signal }) => router?.forwardRoot(p.id, 'repo.file', p, signal) ?? workspace.file(p.id, p.path, p.base, p.from),
  'repo.watch': async (p, { workspace, viewer, router, remoteWatches }) => {
    if (remoteWatches && router?.rootPlacedAt(p.id)) await remoteWatches.watch(p.id, viewer);
    else workspace.watch(p.id, viewer);
    return {};
  },
  // a robot moved since its watch began may hold it on either side
  'repo.unwatch': async (p, { workspace, viewer, remoteWatches }) => { workspace.unwatch(p.id, viewer); await remoteWatches?.unwatch(p.id, viewer); return {}; },
  'push.key': (_p, { vapidPublicKey }) => ({ publicKey: vapidPublicKey }),
  'push.subscribe': (p, { push, viewer }) => { push.upsert({ ...p, login: viewer.login ?? 'local', addedAt: Date.now() }); return {}; },
  'push.unsubscribe': (p, { push }) => { push.remove(p.endpoint); return {}; },
  'push.get': (p, { push }) => ({ statuses: push.get(p.endpoint)?.statuses }),
  'browser.open': (p, { fleet }) => fleet.openTab(p.id, p.url, p.tab),
  'browser.close': (p, { fleet }) => { fleet.closeTab(p.id, p.tab); return {}; },
  'browser.activate': (p, { fleet }) => { fleet.activateTab(p.id, p.tab); return {}; },
  'browser.update': (p, { fleet }) => { fleet.updateTab(p.id, p.tab, { url: p.url, title: p.title }); return {}; },
  'term.open': async (p, { terminals, viewer }) => ({ screen: await terminals.open(p.id, p.cols, p.rows, p.lines, viewer) }),
  'term.input': async (p, { terminals }) => { await terminals.input(p.id, Buffer.from(p.data, 'base64')); return {}; },
  'term.resize': async (p, { terminals, viewer }) => { await terminals.resize(p.id, p.cols, p.rows, viewer); return {}; },
  'term.close': (p, { terminals, viewer }) => { terminals.close(p.id, viewer); return {}; },
  'term.lastScreen': (p, { terminals }) => terminals.lastScreen(p.id) ?? { text: '' },
  'term.attach': (p, { terminals }) => terminals.attach(p.id, p.term),
  'system.info': (_p, { systemInfo }) => systemInfo(),
};

/** What this machine is and runs, as system.info answers here and a worker answers its home. */
export async function systemInfo(o: { machineId: MachineId; agents: AgentProber; linger?: () => Promise<NonNullable<SystemInfo['linger']>> }): Promise<SystemInfo> {
  const git = await gitVersion();
  const linger = await o.linger?.().catch(() => undefined);
  return {
    machineId: o.machineId, release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION,
    platform: platform(), arch: process.arch, agentAdapters: agentAdapters(await o.agents(true)), ...(git && { git }), ...(linger && { linger }),
  };
}

// a worker answers a read of the fleet, or of a robot placed on it, from its mirror; any other call is its home's
function homeAnswers(ctx: Ctx, method: MethodName, params: unknown): boolean {
  if (!ctx.router?.onWorker) return false;
  const id = (params as { id?: unknown }).id;
  return classification[method] !== 'read' || (typeof id === 'string' && ctx.router.placedAt(id) !== undefined);
}

export async function dispatch(req: Request, ctx: Ctx): Promise<Response> {
  const def = Object.hasOwn(methods, req.method) ? (methods as Record<string, { params: ZodTypeAny }>)[req.method] : undefined;
  if (!def) return { id: req.id, error: { code: 'unknown_method', message: `unknown method ${req.method}` } };
  if (DESKTOP_ONLY.has(req.method) && ctx.viewer.kind === 'phone') return { id: req.id, error: { code: 'forbidden', message: `${req.method} is not open to a phone` } };
  if (MAC_ONLY.has(req.method) && process.platform !== 'darwin') return { id: req.id, error: { code: 'forbidden', message: `${req.method} answers only on a Mac` } };
  try {
    const parsed = def.params.safeParse(req.params ?? {});
    if (!parsed.success) return { id: req.id, error: { code: 'invalid_params', message: z.prettifyError(parsed.error) } };
    if (ctx.mutations?.serves(req.method as MethodName, parsed.data)) return { id: req.id, result: await ctx.mutations.serve(req.method as MethodName, parsed.data as ParsedParams<MethodName>) };
    if (homeAnswers(ctx, req.method as MethodName, parsed.data)) return { id: req.id, result: await ctx.router!.toHome(req.method as MethodName, parsed.data, ctx.signal) };
    const handler = handlers[req.method as MethodName] as (p: unknown, ctx: Ctx) => unknown;
    return { id: req.id, result: await handler(parsed.data, ctx) };
  } catch (e) {
    return { id: req.id, error: errorFrame(e) };
  }
}

// what a worker sends on from a CLI in one of its panes: never the machines, the fleets beside this one or the phone link
const FROM_WORKER = new Set(['state', 'island', 'robot', 'browser', 'scribe']);

/** The result of a call a worker sends on, or its error thrown as the client would read it. */
export async function answer(method: string, params: unknown, ctx: Ctx): Promise<unknown> {
  if (!FROM_WORKER.has(method.split('.')[0])) throw new ApiError('unauthorized', `${method} is not taken from a worker`);
  const res = await dispatch({ id: 0, method, params }, ctx);
  if ('error' in res) throw new ApiError(res.error.code, res.error.message, res.error.data);
  return res.result;
}
