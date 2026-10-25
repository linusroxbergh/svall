import v8 from 'node:v8';
import { z, type ZodTypeAny } from 'zod';
import { ApiError, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, TRANSFER_SCHEMA_VERSION, methods, type LoadSnapshot, type MachineId, type MethodName, type ParsedParams, type Request, type Response, type Result, type SystemInfo } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { Fleets } from '../fleets.js';
import { gitVersion } from '../handover/git-extensions.js';
import type { HandoverService } from '../handover/service.js';
import type { HomeLinks } from '../link/home.js';
import type { Mobile } from '../mobile.js';
import type { PushStore } from '../push/store.js';
import type { CodexPaths } from '../codex/install.js';
import { errorFrame } from '../errors.js';
import type { ClaudePaths } from '../paths.js';
import { listsDeletable, rootIdOf, scanResources } from '../resources/scan.js';
import type { OwnershipState } from '../ownership/state.js';
import { classification, guardMethod } from '../ownership/guard.js';
import type { Placement } from '../placement/move.js';
import type { Router } from '../placement/router.js';
import { releaseVersion } from '../release.js';
import type { Store } from '../store.js';
import type { TerminalHub, Viewer } from '../terminals.js';
import type { FetchUsage } from '../usage/usage.js';
import { WorkspaceError } from '../workspace/errors.js';
import type { Workspace } from '../workspace/workspace.js';

export type Ctx = { store: Store; fleet: Fleet; fleets: Fleets; handover: HandoverService; terminals: TerminalHub; workspace: Workspace; usage: FetchUsage; load: () => Promise<LoadSnapshot>; mobile: Mobile; push: PushStore; vapidPublicKey: string; viewer: Viewer; claude: ClaudePaths; codex?: CodexPaths; docs?: string; agentProfiles?: string; ownership: OwnershipState; router?: Router; placement?: Placement; links?: Pick<HomeLinks, 'refresh'>; signal?: AbortSignal };

// what starts launchd agents and names fleets stays with the Mac
const DESKTOP_ONLY = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start', 'fleet.rename', 'fleet.stop'] satisfies MethodName[]);
// the fleets beside this one are a Mac's: a gateway's daemon has no launchd to start them with
const MAC_ONLY = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start'] satisfies MethodName[]);

type Handlers = { [M in MethodName]: (p: ParsedParams<M>, ctx: Ctx) => Promise<Result<M>> | Result<M> };

// moves are the home's: a worker sends them on before they reach a handler
const placementOf = ({ placement }: Ctx): Placement => {
  if (!placement) throw new ApiError('not_on_worker', 'not on a worker');
  return placement;
};

// svalld runs on the two platforms a handover can compare; nothing else gets this far
const platform = (): 'darwin' | 'linux' => (process.platform === 'linux' ? 'linux' : 'darwin');

export const handlers: Handlers = {
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
  'robot.prompts': (p, { fleet }) => ({ prompts: fleet.readPrompts(p.id, p.limit) }),
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
  'scribe.sweep': async (p, { fleet }) => ({ lines: await fleet.sweep(p) }),
  'scribe.set': (p, { fleet }) => { fleet.setScribe(p.enabled); return {}; },
  'worktrees.set': (p, { fleet }) => { fleet.setWorktrees(p.enabled); return {}; },
  'dormancy.set': (p, { fleet }) => { fleet.setDormancy(p.hours); return {}; },
  'mainAgent.set': (p, { fleet }) => { fleet.setMainAgent(p.agent); return {}; },
  'model.set': (p, { fleet }) => { fleet.setModel(p.of, p.agent, p.model); return {}; },
  'fleets.list': async (_p, { fleets }) => ({ fleets: await fleets.list() }),
  'fleets.create': async (p, { fleets }) => ({ home: await fleets.create(p.name) }),
  'fleets.start': async (p, { fleets }) => ({ home: await fleets.start(p.home) }),
  'fleet.rename': (p, { fleet }) => { fleet.renameFleet(p.name); return {}; },
  'fleet.stop': async (_p, { fleet }) => { await fleet.stopAll(); return {}; },
  'usage.get': (_p, { usage }) => usage(),
  'load.get': (_p, { load }) => load(),
  'mobile.get': (_p, { mobile }) => mobile.get(),
  // an off revokes every device, even one tailscale refused, since the key has turned over: one that asks again has to reach the page first
  'mobile.set': async (p, { mobile, push }) => {
    const status = await mobile.set(p.enabled);
    if (!p.enabled) push.clear();
    return status;
  },
  'resources.get': (_p, { store, claude, codex, docs, agentProfiles }) => ({ sources: scanResources(store.state, claude, codex, docs, agentProfiles) }),
  'fs.list': async (p, { workspace }) => ({ entries: await workspace.list(p.id, p.path) }),
  'fs.read': (p, { workspace }) => workspace.read(p.id, p.path),
  'fs.write': (p, { workspace }) => workspace.write(p.id, p.path, p.text, p.mtimeMs, p.root),
  'docs.create': (p, { workspace }) => workspace.create(p.id, p.path, p.text),
  'docs.rename': (p, { workspace, fleet, agentProfiles }) => {
    workspace.rename(p.id, p.path, p.to);
    if (agentProfiles !== undefined && p.id === rootIdOf(agentProfiles)) fleet.renameAgentProfile(p.path.slice(0, -3), p.to.slice(0, -3));
    return {};
  },
  'docs.delete': (p, { workspace }) => { workspace.remove(p.id, p.path); return {}; },
  'resources.delete': (p, { store, claude, codex, docs, agentProfiles, workspace }) => {
    if (!listsDeletable(scanResources(store.state, claude, codex, docs, agentProfiles), p.id, p.path)) throw new WorkspaceError('invalid', `${p.path} is not a skill, agent, command or memory file the shelf lists`);
    return { token: workspace.setAside(p.id, p.path) };
  },
  'resources.restore': (p, { workspace }) => { workspace.putBack(p.token); return {}; },
  'repo.status': (p, { workspace }) => workspace.status(p.id, p.base),
  'repo.file': (p, { workspace }) => workspace.file(p.id, p.path, p.base, p.from),
  'repo.watch': (p, { workspace, viewer }) => { workspace.watch(p.id, viewer); return {}; },
  'repo.unwatch': (p, { workspace, viewer }) => { workspace.unwatch(p.id, viewer); return {}; },
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
  'term.attach': (p, { terminals }) => terminals.attach(p.id, p.term),
  'system.info': (_p, ctx) => systemInfo(ctx),
  'ownership.get': (_p, { handover }) => handover.ownershipInfo(),
  'ownership.adopt': (p, { handover }) => handover.relay(p),
  'handover.preflight': (p, { handover }) => handover.preflight(p),
  'handover.inspect': (p, { handover }) => handover.inspect(p),
  'handover.freeze': (p, { handover }) => handover.freeze(p),
  'handover.claim': (p, { handover }) => handover.claim(p),
  'handover.prepare': (p, { handover }) => handover.prepare(p),
  'handover.activate': (p, { handover }) => handover.activate(p),
  'handover.complete': (p, { handover }) => handover.complete(p),
  'handover.abort': (p, { handover }) => handover.abort(p),
  'handover.status': (_p, { handover }) => handover.status(),
  'handover.reaches': (p, { handover }) => handover.reaches(p),
};

/** What this machine is and runs, as system.info answers here and a worker answers its home. */
export async function systemInfo({ ownership, handover }: Pick<Ctx, 'ownership' | 'handover'>): Promise<SystemInfo> {
  const git = await gitVersion();
  const linger = await handover.linger();
  return {
    machineId: ownership.machineId, release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION,
    transferSchema: TRANSFER_SCHEMA_VERSION, platform: platform(), arch: process.arch, agentAdapters: await handover.agentAdapters(), ...(git && { git }),
    heapLimit: v8.getHeapStatistics().heap_size_limit, ...(linger && { linger }),
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
    // ahead of parsing: what this machine may not do, it may not do with any parameters
    guardMethod(ctx.ownership, req.method as MethodName, ctx.viewer?.kind, ctx.router?.onWorker);
    const parsed = def.params.safeParse(req.params ?? {});
    if (!parsed.success) return { id: req.id, error: { code: 'invalid_params', message: z.prettifyError(parsed.error) } };
    if (homeAnswers(ctx, req.method as MethodName, parsed.data)) return { id: req.id, result: await ctx.router!.toHome(req.method as MethodName, parsed.data, ctx.signal) };
    const handler = handlers[req.method as MethodName] as (p: unknown, ctx: Ctx) => unknown;
    return { id: req.id, result: await handler(parsed.data, ctx) };
  } catch (e) {
    return { id: req.id, error: errorFrame(e) };
  }
}

// what a worker sends on from a CLI in one of its panes: never a handover, a record, the fleets beside this one or the phone link
const FROM_WORKER = new Set(['state', 'island', 'robot', 'browser', 'scribe']);

/** The result of a call a worker sends on, or its error thrown as the client would read it. */
export async function answer(method: string, params: unknown, ctx: Ctx): Promise<unknown> {
  if (!FROM_WORKER.has(method.split('.')[0])) throw new ApiError('unauthorized', `${method} is not taken from a worker`);
  const res = await dispatch({ id: 0, method, params }, ctx);
  if ('error' in res) throw new ApiError(res.error.code, res.error.message, res.error.data);
  return res.result;
}
