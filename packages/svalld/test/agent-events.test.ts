import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Robot } from '@svall/protocol';
import { Config } from '../src/config.js';
import type { Proc } from '../src/dormancy.js';
import { AgentEvents } from '../src/fleet/agent-events.js';
import type { HookEvent } from '../src/hooks/receiver.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const DAEMON = '/u/.codex/bin/codex app-server --listen unix:// --managed-daemon';
const SID = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
const SERVER = 900_001;

// the events of a fleet that is never started land in the store alone, with ps as the test lists it at the time
function events(procs: Proc[], delayMs = 20, failures = 0) {
  const paths = resolvePaths(makeHome());
  const store = Store.load(paths.state, () => {});
  const c: Robot = {
    id: 'c_a', islandId: 'home', cell: { x: 1, y: 1 }, name: 'a', portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [],
    shell: { lastOutputAt: 0 }, unread: false,
  };
  store.update((d) => { d.robots.c_a = c; });
  const log = { info: (m: string) => said.push(m), error: () => {} };
  const said: string[] = [];
  let reads = 0;
  const processes = async () => {
    reads++;
    const listed = [...procs];
    await new Promise((r) => setTimeout(r, delayMs));
    if (failures-- > 0) throw new Error('ps timed out');
    return listed;
  };
  const ev = new AgentEvents({
    store, config: Config.parse({}), log, render: () => '', processes, refreshLinks: async () => {}, track: () => {},
    sessions: paths.retroSessions,
  });
  const hook = (name: HookEvent['name'], pid: number, o: Partial<HookEvent> = {}) => ev.apply({ hook: { robotId: 'c_a', backend: 'codex', name, sessionId: SID, pid, ...o } });
  const sessions = () => (fs.existsSync(paths.retroSessions) ? fs.readFileSync(paths.retroSessions, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as object) : []);
  return { store, hook, said, reads: () => reads, ev, sessions, paths };
}

describe('AgentEvents and the shared codex server', () => {
  it('reads the process list once for the events that arrive together, and says once whose hooks it drops', async () => {
    const { store, hook, said, reads } = events([{ pid: SERVER, ppid: 1, pgid: SERVER, args: DAEMON }]);
    await Promise.all([hook('SessionStart', SERVER), hook('UserPromptSubmit', SERVER), hook('PreToolUse', SERVER)]);
    expect(reads()).toBe(1);
    expect(store.state.robots.c_a.agent).toBeUndefined();
    expect(said).toEqual([`hooks from Codex's shared server (pid ${SERVER}) ignored: they name no terminal of their own`]);
    // the verdict holds without another look
    await hook('Stop', SERVER);
    expect(reads()).toBe(1);
    expect(said).toHaveLength(1);
  });

  it('looks again for a pid the shared listing lacks, which started after it', async () => {
    const procs: Proc[] = [{ pid: SERVER, ppid: 1, pgid: SERVER, args: DAEMON }];
    const { store, hook, reads } = events(procs);
    const first = hook('SessionStart', SERVER);
    procs.push({ pid: 900_002, ppid: SERVER, pgid: 900_002, args: 'claude -p' });
    await Promise.all([first, hook('SessionStart', 900_002, { backend: 'claude', sessionId: '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d' })]);
    expect(reads()).toBe(2);
    expect(store.state.robots.c_a.agent).toBeUndefined();
  });

  it('applies a robot\'s events in arrival order while one of them waits on ps', async () => {
    const { store, hook, reads } = events([{ pid: 300, ppid: 1, pgid: 300, args: 'codex --no-daemon' }]);
    store.update((d) => {
      d.robots.c_a.tmux = { windowId: '@1', paneId: '%1' };
      d.robots.c_a.agent = { kind: 'codex', sessionId: SID, status: 'done', lastActivityAt: 1, pid: 100, contextPct: 42, lastPrompt: { id: 'p', text: 'go', at: 1 } };
    });
    await hook('Stop', 100);
    // a revive resumed the session in a new process, and the old one's end comes while the new pid is looked up
    const started = hook('SessionStart', 300);
    const ended = hook('SessionEnd', 100);
    await Promise.all([started, ended]);
    expect(reads()).toBe(2);
    expect(store.state.robots.c_a.agent).toMatchObject({ sessionId: SID, pid: 300, contextPct: 42, lastPrompt: { text: 'go' } });
  });

  it('asks ps again after a read that failed, rather than drop the pid\'s events until the verdict would expire', async () => {
    const { store, hook, reads } = events([{ pid: 500, ppid: 1, pgid: 500, args: 'codex --no-daemon' }], 20, 1);
    await expect(hook('SessionStart', 500)).rejects.toThrow('ps timed out');
    await hook('SessionStart', 500);
    expect(reads()).toBe(2);
    expect(store.state.robots.c_a.agent).toMatchObject({ kind: 'codex', sessionId: SID, pid: 500 });
  });

  it('hears a codex on a server of its own, and spends no read on an event without a pid', async () => {
    const { store, hook, reads } = events([{ pid: 500, ppid: 1, pgid: 500, args: 'codex --no-daemon' }]);
    await hook('SessionStart', 500);
    expect(store.state.robots.c_a.agent).toMatchObject({ kind: 'codex', sessionId: SID, pid: 500 });
    await hook('Stop', 0);
    expect(reads()).toBe(1);
    expect(store.state.robots.c_a.agent?.status).toBe('done');
  });
});

describe('AgentEvents and the retro\'s record of sessions', () => {
  it('appends a line when a session takes the slot, and an end when it goes', async () => {
    const { store, hook, sessions } = events([]);
    store.update((d) => { d.robots.c_a.tmux = { windowId: '@1', paneId: '%1' }; });
    await hook('SessionStart', 0, { model: 'gpt-6-luna' });
    await hook('UserPromptSubmit', 0);
    await hook('SessionEnd', 0);
    expect(sessions()).toEqual([
      { at: expect.any(Number), session: SID, robot: 'c_a', island: 'home', cwd: '/tmp', agent: 'codex', model: 'gpt-6-luna' },
      { at: expect.any(Number), session: SID, end: expect.any(Number) },
    ]);
  });

  it('records each session held now once, on the first start that keeps the record', async () => {
    const { store, ev, sessions, paths } = events([]);
    store.update((d) => { d.robots.c_a.agent = { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 1 }; });
    ev.recordCurrent();
    ev.recordCurrent();
    expect(sessions()).toEqual([expect.objectContaining({ session: SID, robot: 'c_a', agent: 'claude' })]);
    expect(path.dirname(paths.retroSessions)).toBe(paths.retro);
  });
});
