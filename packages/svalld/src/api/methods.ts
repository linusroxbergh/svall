import { z, type ZodTypeAny } from 'zod';
import { ERROR_CODES, methods, type ErrorCode, type MethodName, type ParsedParams, type Request, type Response, type Result } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { Fleets } from '../fleets.js';
import type { Mobile } from '../mobile.js';
import type { PushStore } from '../push/store.js';
import type { CodexPaths } from '../codex/install.js';
import type { ClaudePaths } from '../paths.js';
import { rootIdOf, scanResources } from '../resources/scan.js';
import type { Store } from '../store.js';
import type { TerminalHub, Viewer } from '../terminals.js';
import type { FetchUsage } from '../usage/usage.js';
import type { Workspace } from '../workspace/workspace.js';

export type Ctx = { store: Store; fleet: Fleet; fleets: Fleets; terminals: TerminalHub; workspace: Workspace; usage: FetchUsage; mobile: Mobile; push: PushStore; vapidPublicKey: string; viewer: Viewer; claude: ClaudePaths; codex?: CodexPaths; docs?: string; agentProfiles?: string; signal?: AbortSignal };

// what starts launchd agents and names fleets stays with the Mac
const DESKTOP_ONLY = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start', 'fleet.rename', 'fleet.stop'] satisfies MethodName[]);

type Handlers = { [M in MethodName]: (p: ParsedParams<M>, ctx: Ctx) => Promise<Result<M>> | Result<M> };

const handlers: Handlers = {
  'state.get': (_p, { store }) => store.state,
  'island.create': (p, { fleet }) => fleet.createIsland(p),
  'island.update': (p, { fleet }) => fleet.updateIsland(p.id, p),
  'island.delete': (p, { fleet }) => { fleet.deleteIsland(p.id); return {}; },
  'island.arrange': (p, { fleet }) => { fleet.arrangeIslands(p.aspect, p.homeRoom); return {}; },
  'island.show': (p, { fleet }) => ({ text: fleet.islandBrief(p.id) }),
  'island.reorder': (p, { fleet }) => fleet.reorderIsland(p.id, p.targetId, p.after),
  'char.create': (p, { fleet }) => fleet.createCharacter(p),
  'char.update': (p, { fleet }) => fleet.updateCharacter(p.id, p),
  'char.move': (p, { fleet }) => fleet.moveCharacter(p.id, p.islandId, p.cell),
  'char.reorder': (p, { fleet }) => fleet.reorderCharacter(p.id, p.targetId, p.after),
  'char.close': async (p, { fleet }) => { await fleet.closeCharacter(p.id); return {}; },
  'char.revive': (p, { fleet }) => fleet.reviveCharacter(p.id),
  'char.seen': (p, { fleet }) => fleet.markSeen(p.id, p.term),
  'char.second': (p, { fleet }) => fleet.openSecond(p.id),
  'char.run': async (p, { fleet }) => { await fleet.run(p.id, p.text, p.enter, p.term); return {}; },
  'char.read': async (p, { fleet }) => ({
    text: p.source === 'screen' ? await fleet.readScreen(p.id, p.lines, p.term) : fleet.readTranscript(p.id, p.lines, p.term),
  }),
  'char.prompts': (p, { fleet }) => ({ prompts: fleet.readPrompts(p.id, p.limit) }),
  'char.show': (p, { fleet }) => ({ text: fleet.brief(p.id) }),
  'char.wait': async (p, { fleet, signal }) => ({ status: await fleet.waitFor(p.id, p.until, p.timeoutMs, signal, p.term) }),
  'char.answer': async (p, { fleet }) => { await fleet.answerPrompt(p.id, p.answer, p.promptId); return {}; },
  'scribe.sweep': async (p, { fleet }) => ({ lines: await fleet.sweep(p) }),
  'scribe.set': (p, { fleet }) => { fleet.setScribe(p.enabled); return {}; },
  'dormancy.set': (p, { fleet }) => { fleet.setDormancy(p.hours); return {}; },
  'mainAgent.set': (p, { fleet }) => { fleet.setMainAgent(p.agent); return {}; },
  'fleets.list': async (_p, { fleets }) => ({ fleets: await fleets.list() }),
  'fleets.create': async (p, { fleets }) => ({ home: await fleets.create(p.name) }),
  'fleets.start': async (p, { fleets }) => ({ home: await fleets.start(p.home) }),
  'fleet.rename': (p, { fleet }) => { fleet.renameFleet(p.name); return {}; },
  'fleet.stop': async (_p, { fleet }) => { await fleet.stopAll(); return {}; },
  'usage.get': (_p, { usage }) => usage(),
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
};

export async function dispatch(req: Request, ctx: Ctx): Promise<Response> {
  const def = Object.hasOwn(methods, req.method) ? (methods as Record<string, { params: ZodTypeAny }>)[req.method] : undefined;
  if (!def) return { id: req.id, error: { code: 'unknown_method', message: `unknown method ${req.method}` } };
  if (DESKTOP_ONLY.has(req.method) && ctx.viewer.kind === 'phone') return { id: req.id, error: { code: 'forbidden', message: `${req.method} is not open to a phone` } };
  const parsed = def.params.safeParse(req.params ?? {});
  if (!parsed.success) return { id: req.id, error: { code: 'invalid_params', message: z.prettifyError(parsed.error) } };
  try {
    const handler = handlers[req.method as MethodName] as (p: unknown, ctx: Ctx) => unknown;
    return { id: req.id, result: await handler(parsed.data, ctx) };
  } catch (e) {
    const err = e as Error & { code?: unknown };
    const code = (ERROR_CODES as readonly unknown[]).includes(err.code) ? err.code as ErrorCode : 'internal';
    return { id: req.id, error: { code, message: err.message } };
  }
}
