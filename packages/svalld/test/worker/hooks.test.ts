import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineId, emptyState, type Agent, type FleetState, type Island, type Robot } from '@svall/protocol';
import { Config } from '../../src/config.js';
import { docsDir } from '../../src/docs.js';
import { Fleet } from '../../src/fleet.js';
import type { HookEvent } from '../../src/hooks/receiver.js';
import { silentLogger } from '../../src/log.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { resolvePaths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { mergeSnapshot, type RobotSync } from '../../src/worker/snapshot.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const W = MachineId.parse(crypto.randomUUID());
const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const agentHomes = { claude: '/Users/ada/.claude', codex: '/Users/ada/.codex', opencode: '/Users/ada/.config/opencode' };
const island = (instructions: string): Island => ({ id: 'i_1', name: 'kanban', description: '', instructions, context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 });
const agent = (o: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 1, ...o });
const robot = (o: Partial<Robot> = {}): Robot => ({
  id: 'c_w', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'w', note: '', portrait: 'owl', instructions: '', cwd: '/srv/kanban', context: [],
  shell: { lastOutputAt: 0 }, unread: false, machine: W, placement: { generation: 1 }, ...o,
});
// the fleet as the home holds it: its own copy of c_w's agent carries the brief the home last saw
const homeState = (instructions: string): FleetState => ({
  ...emptyState(), worktreesOff: true, islands: { i_1: island(instructions) }, robots: { c_w: robot({ agent: agent({ brief: 'what the home last saw' }) }) },
});

/** A worker's fleet, never started, over a store that holds c_w live here and has taken the home's snapshot. */
function worker() {
  const paths = resolvePaths(makeHome());
  const store = Store.load(paths.state, () => {});
  store.update((d) => { Object.assign(d, { ...emptyState(), islands: { i_1: island('') }, robots: { c_w: robot({ tmux: { windowId: '@1', paneId: '%1' }, agent: agent() }) } }); });
  const snapshot = (instructions: string) => mergeSnapshot(store, { version: 1, state: homeState(instructions), agentHomes, home: '/Users/ada' }, W);
  snapshot('ship the board');
  // a note the docs mirror holds on this machine
  const notes = docsDir(paths.docs, 'island', 'i_1');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'deploy.md'), '---\ndescription: how the board deploys\n---\nsteps\n');
  const reports: RobotSync[] = [];
  const config = Config.parse({});
  const fleet = new Fleet({
    store, tmux: {} as Tmux, paths, config, log: silentLogger, report: (r) => reports.push(r),
    ownership: OwnershipState.load({ paths, fleetId: config.id, machineId: W, log: silentLogger, standalone: true }),
  });
  const hook = (name: HookEvent['name']) => fleet.onSocketEvent({ hook: { robotId: 'c_w', backend: 'claude', name, sessionId: SID } });
  return { paths, store, reports, snapshot, hook };
}

describe('a worker answering its robots\' hooks', () => {
  it('a SessionStart on the worker is answered with the brief rendered from the snapshot, and agent.brief is reported, not taken from the home', async () => {
    const w = worker();
    const brief = await w.hook('SessionStart');
    expect(brief).toContain('Island instructions: ship the board');
    expect(brief).toContain(`deploy — "how the board deploys" (${path.join(docsDir(w.paths.docs, 'island', 'i_1'), 'deploy.md')})`);
    // the fleet's worktree rule is the snapshot's, which turns it off
    expect(brief).toContain('You are Svall robot c_w');
    expect(brief).not.toContain('new worktree');
    expect(w.store.state.robots.c_w.agent?.brief).toBe(brief);
    expect(w.reports).toHaveLength(1);
    expect(w.reports[0]).toMatchObject({ robotId: 'c_w', generation: 1, fields: { tmux: { windowId: '@1', paneId: '%1' }, agent: { sessionId: SID, brief } } });
  });

  it('the next UserPromptSubmit diff is against the brief the worker delivered', async () => {
    const w = worker();
    await w.hook('SessionStart');
    // the home changes the island, and its copy of the agent still holds the brief it last saw
    w.snapshot('ship the board, then the map');
    const diff = await w.hook('UserPromptSubmit');
    expect(diff).toBe('# Svall context changed\n- Island instructions: ship the board\n+ Island instructions: ship the board, then the map');
    expect(w.reports.at(-1)?.fields.agent?.brief).toContain('Island instructions: ship the board, then the map');
    expect(w.store.state.robots.c_w.agent?.brief).toBe(w.reports.at(-1)?.fields.agent?.brief);
  });
});
