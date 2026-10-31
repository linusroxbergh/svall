import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { AgentKind, FleetState, HomeAction } from '@svall/protocol';
import { Config } from '../src/config.js';
import type { Proc } from '../src/dormancy.js';
import { Fleet } from '../src/fleet.js';
import { startHookReceiver } from '../src/hooks/receiver.js';
import type { Deps as LinkDeps } from '../src/links/refresh.js';
import { silentLogger, type Logger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import type { LiveProc } from '../src/load/procs.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { parseScreen, Tmux } from '../src/tmux/tmux.js';
import { makeHome } from './helpers.js';

export const OSID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
export const SID = '9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e';
// a pane of a real agent CLI as `Tmux.screen` reads it
export const pane = (name: string) => parseScreen(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/composer', `${name}.txt`), 'utf8'));

export const cleanup: (() => Promise<void>)[] = [];

export async function stopFleets(): Promise<void> {
  for (const f of cleanup.splice(0)) await f();
}

export async function boot(extra: { pollMs?: number; runTimeoutMs?: number; resumeMs?: number; homeCwd?: string; homeCommand?: string; linkDeps?: Partial<LinkDeps>; log?: Logger; agentsFound?: AgentKind[]; mainAgent?: AgentKind; name?: string; scribe?: { agent?: AgentKind; model?: string }; state?: FleetState; fleetHome?: { actions?: HomeAction[]; offered?: string[] }; opening?: boolean; platform?: NodeJS.Platform; shell?: string; processes?: () => Promise<Proc[]>; readProcs?: () => Promise<LiveProc[]>; endOpts?: NonNullable<ConstructorParameters<typeof Fleet>[0]['endOpts']> } = {}) {
  const { homeCwd, homeCommand, mainAgent, name, scribe, state, fleetHome, opening, shell = '/bin/sh', ...deps } = extra;
  // what ps shows the dormancy sweep
  const procs: Proc[] = [];
  const home = makeHome();
  const paths = resolvePaths(home);
  // the fleet an earlier run left on disk
  if (state) fs.writeFileSync(paths.state, JSON.stringify(state));
  const config = Config.parse({ shell, home: { cwd: homeCwd ?? path.join(home, 'mc'), ...(homeCommand ? { command: homeCommand } : {}), ...fleetHome }, ...(mainAgent ? { mainAgent } : {}), ...(name ? { name } : {}), ...(scribe ? { scribe } : {}) });
  if (fleetHome) fs.writeFileSync(paths.fleetConfig, JSON.stringify({ id: config.id, home: fleetHome }));
  fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
  const store = Store.load(paths.state, () => {});
  const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
  const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 150, processes: async () => procs, readProcs: async () => [], ...deps });
  const started = fleet.start();
  cleanup.push(async () => { await started.catch(() => {}); await fleet.stop(); await tmux.killServer(); });
  await started;
  // a test lays out from mission control alone unless it asks for the island and shell a new fleet opens with
  if (!opening) {
    for (const c of Object.values(store.state.robots)) if (store.state.islands[c.islandId]?.kind !== 'home') await fleet.closeRobot(c.id);
    for (const i of Object.values(store.state.islands)) if (i.kind !== 'home') fleet.deleteIsland(i.id);
  }
  // a spawned stand-in agent reaches the fleet the way a real one does: over the hooks socket
  const hooks = await startHookReceiver(paths.hooksSock, (e) => fleet.onSocketEvent(e), silentLogger);
  cleanup.push(() => hooks.close());
  return { fleet, store, tmux, home, procs };
}

// the next listing tmux gives is handed back only once released
export function holdListing(tmux: Tmux) {
  const real = tmux.listWindows.bind(tmux);
  let taken!: () => void;
  let release!: () => void;
  const listed = new Promise<void>((r) => { taken = r; });
  const held = new Promise<void>((r) => { release = r; });
  vi.spyOn(tmux, 'listWindows').mockImplementationOnce(async () => { const r = await real(); taken(); await held; return r; });
  return { listed, release };
}

// a robot whose pane shell stands in for its agent: the sweep reads it as `args`, and it exits with its window
export async function withAgent(b: Awaited<ReturnType<typeof boot>>, args = 'claude', command = 'sleep 600', backend: AgentKind = 'claude') {
  const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command });
  const pid = Number((await b.tmux.run('display', '-p', '-t', c.tmux!.paneId, '#{pane_pid}')).trim());
  const transcriptPath = path.join(b.home, `${SID}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend, name: 'SessionStart', sessionId: SID, pid, transcriptPath } });
  b.procs.push({ pid, ppid: 1, pgid: pid, args });
  return { c, pid, transcriptPath };
}
