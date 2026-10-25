import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Robot } from '@svall/protocol';
import type { Client } from '../src/client.js';
import { agentFor, robotCommands, termOf } from '../src/commands/robot.js';
import { statusCommand } from '../src/commands/status.js';
import { contextOf, stateOf } from '../src/render.js';

const base: Robot = {
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/r', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false,
};
const agent = (status: 'working' | 'idle' | 'blocked' | 'done') => ({ kind: 'claude' as const, sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 1 });

describe('stateOf', () => {
  it('reads as before with one terminal', () => {
    expect(stateOf(base)).toBe('shell');
    expect(stateOf({ ...base, agent: agent('done'), unread: true })).toBe('done*');
  });
  it('names the second session after the main one', () => {
    const second = { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    expect(stateOf({ ...base, agent: agent('working'), second })).toBe('working +shell');
    expect(stateOf({ ...base, second: { ...second, agent: agent('done'), unread: true } })).toBe('shell +done*');
    expect(stateOf({ ...base, second: { cwd: '/tmp', unread: false, revive: { command: '' } } })).toBe('shell +dormant');
  });
});

describe('contextOf', () => {
  const withPct = (contextPct: number) => ({ ...agent('working'), contextPct });
  it('is empty without a context, and shows the fuller of the two sessions', () => {
    expect(contextOf(base)).toBe('');
    expect(contextOf({ ...base, agent: withPct(12) })).toBe('12%');
    expect(contextOf({ ...base, agent: withPct(12), second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: withPct(80) } })).toBe('80%');
    expect(contextOf({ ...base, agent: withPct(80), second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: withPct(12) } })).toBe('80%');
    expect(contextOf({ ...base, second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: withPct(30) } })).toBe('30%');
  });
});

describe('termOf', () => {
  it('takes 1, 2 or nothing', () => {
    expect(termOf(undefined)).toBeUndefined();
    expect(termOf('1')).toBeUndefined();
    expect(termOf('2')).toBe(2);
    expect(() => termOf('3')).toThrow(/--term/);
  });
});

describe('agentFor', () => {
  it('starts the main agent for --run alone and a bare --agent, and a named one otherwise', () => {
    expect(agentFor({ run: 'hi' }, 'codex')).toBe('codex');
    expect(agentFor({ agent: true }, 'codex')).toBe('codex');
    expect(agentFor({ agent: 'claude', run: 'hi' }, 'codex')).toBe('claude');
    expect(agentFor({ codex: true }, 'claude')).toBe('codex');
    expect(agentFor({ claude: true }, 'codex')).toBe('claude');
    expect(agentFor({ run: 'hi', command: 'node x.mjs' }, 'codex')).toBeUndefined();
    expect(agentFor({}, 'codex')).toBeUndefined();
  });
  it('starts opencode for --opencode', () => {
    expect(agentFor({ opencode: true }, 'claude')).toBe('opencode');
    expect(agentFor({ agent: 'opencode' }, 'claude')).toBe('opencode');
  });
});

describe('robot new', () => {
  it('refuses two agents, or an agent and a command, rather than drop one', async () => {
    const cmd = robotCommands(async () => { throw new Error('connected'); }, () => false);
    cmd.commands.find((c) => c.name() === 'new')!.exitOverride().configureOutput({ writeErr: () => {} });
    for (const flags of [['--claude', '--codex'], ['--agent', 'codex', '--command', 'x'], ['--codex', '--command', 'x'], ['--agent', '--claude']]) {
      await expect(cmd.parseAsync(['node', 'robot', 'new', '--island', 'i', '--cwd', '/tmp', ...flags]), flags.join(' ')).rejects.toThrow(/cannot be used with/);
    }
  });
});

describe('robot new --run', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
  const create = async (runSent: boolean, json = false) => {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += String(s); return true; });
    const client = { call: async (m: string) => (m === 'state.get' ? { islands: { i_1: { id: 'i_1', name: 'home' } }, robots: {} } : { ...base, id: 'c_new', runSent }), close() {} };
    await robotCommands(async () => client as unknown as Client, () => json).parseAsync(['new', '--island', 'i_1', '--cwd', '/tmp', '--run', 'go'], { from: 'user' });
    return { out, err };
  };

  it('prints the bare id, says on stderr the prompt was not sent, and exits 2', async () => {
    const { out, err } = await create(false);
    expect(out).toBe('c_new\n');
    expect(err).toBe('prompt not sent; svall robot run c_new "<prompt>" sends it\n');
    expect(process.exitCode).toBe(2);
  });

  it('keeps the JSON, which carries runSent, and exits 2 with --json', async () => {
    const { out } = await create(false, true);
    expect(JSON.parse(out)).toMatchObject({ id: 'c_new', runSent: false });
    expect(process.exitCode).toBe(2);
  });

  it('exits 0 once the prompt is sent', async () => {
    expect(await create(true)).toEqual({ out: 'c_new\n', err: '' });
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('a robot command that stops on an error', () => {
  it('closes its connection to the fleet', async () => {
    const close = vi.fn();
    const client = { call: async () => ({ version: 10, islands: {}, robots: { c_a: base } }), close };
    await expect(robotCommands(async () => client as unknown as Client, () => false).parseAsync(['node', 'robot', 'show', 'nobody'])).rejects.toThrow('no robot "nobody"');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('robot wait', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
  const wait = async (ref: string, robots: Record<string, Robot>, flags: string[] = []) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const calls: string[] = [];
    const client = { call: async (m: string) => { calls.push(m); return m === 'state.get' ? { version: 10, islands: {}, robots } : { status: 'gone' }; }, close() {} };
    await robotCommands(async () => client as unknown as Client, () => false).parseAsync(['node', 'robot', 'wait', ref, '--until', 'idle', ...flags]);
    return calls;
  };

  it('exits 3 for a robot that is already closed, and says the ref matched none', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await wait('c_closed', { c_a: base });
    expect(process.exitCode).toBe(3);
    expect(stderr).toHaveBeenCalledWith('svall: no robot "c_closed"\n');
  });

  it('checks its flags before it looks the robot up', async () => {
    await expect(wait('c_closed', { c_a: base }, ['--timeout', 'soon'])).rejects.toThrow(/--timeout/);
    await expect(wait('c_closed', { c_a: base }, ['--term', '3'])).rejects.toThrow(/--term/);
  });

  it('refuses a name two robots share', async () => {
    await expect(wait('a', { c_a: base, c_b: { ...base, id: 'c_b' } })).rejects.toThrow(/matches/);
  });
});

describe('Keep on this machine', () => {
  const ada: Robot = { ...base, id: 'c_ada', name: 'ada', keepHere: true };
  const bo: Robot = { ...base, id: 'c_bo', name: 'bo' };

  function daemon() {
    const updates: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === 'state.get') return { robots: { c_ada: ada, c_bo: bo }, islands: { i_1: { id: 'i_1', name: 'home' } } };
        if (method === 'robot.update') { updates.push(params); return { ...ada, ...params }; }
        if (method === 'robot.show') return { text: 'the brief' };
        return {};
      },
      close: () => undefined,
    };
    return { updates, connect: async () => client as unknown as Client };
  }

  async function svall(connect: () => Promise<Client>, ...argv: string[]): Promise<string> {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    try {
      await robotCommands(connect, () => false).parseAsync(argv, { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    return out.join('');
  }

  it('is set and cleared through robot.update, and left alone otherwise', async () => {
    const d = daemon();
    await svall(d.connect, 'update', 'bo', '--keep-here');
    await svall(d.connect, 'update', 'ada', '--no-keep-here');
    await svall(d.connect, 'update', 'ada', '--name', 'ada2');
    expect(d.updates.map((u) => u.keepHere)).toEqual([true, false, undefined]);
    expect(d.updates.map((u) => u.id)).toEqual(['c_bo', 'c_ada', 'c_ada']);
  });

  it('marks a kept robot where robot list and robot show name it', async () => {
    const d = daemon();
    const list = await svall(d.connect, 'list');
    expect(list).toMatch(/ada \(kept here\)/);
    expect(list).not.toMatch(/bo \(kept here\)/);
    expect(await svall(d.connect, 'show', 'ada')).toMatch(/^ada is kept on this machine, so a handover is blocked until that is cleared\n/);
    expect(await svall(d.connect, 'show', 'bo')).toBe('the brief\n');
  });
});

describe('a resume that failed', () => {
  const error = "ada's terminal resumed claude session s, but claude exited back to its shell, so it is dormant again with that session; revive it to see";
  const dormant = { tmux: undefined, revive: { command: 'claude --resume s' } };
  const ada: Robot = { ...base, id: 'c_ada', name: 'ada', agent: agent('idle'), ...dormant, resumeError: error };
  const bo: Robot = { ...base, id: 'c_bo', name: 'bo', second: { cwd: '/r', unread: false, agent: agent('idle'), revive: { command: 'claude --resume s' }, resumeError: 'gone' } };
  // a terminal open again keeps no failure worth naming
  const cy: Robot = { ...base, id: 'c_cy', name: 'cy', resumeError: 'stale' };
  const client = {
    via: 'trift',
    call: async (method: string) => (method === 'state.get' ? { robots: { c_ada: ada, c_bo: bo, c_cy: cy }, islands: { i_1: { id: 'i_1', name: 'home' } } } : {}),
    close: () => undefined,
  } as unknown as Client;

  async function print(command: Command, ...argv: string[]): Promise<string> {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    try {
      await command.parseAsync(argv, { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    return out.join('');
  }

  it('is named under svall status and robot list, for each dormant terminal that holds one', async () => {
    const lines = [`ada: resume failed: ${error}`, 'bo (second terminal): resume failed: gone'];
    for (const out of [await print(statusCommand(async () => client, () => false, () => '/h')), await print(robotCommands(async () => client, () => false), 'list')]) {
      expect(out.trimEnd().split('\n').slice(-2)).toEqual(lines);
      expect(out).not.toMatch(/stale/);
    }
  });
});

describe('robot revive', () => {
  const ada: Robot = { ...base, id: 'c_ada', name: 'ada', tmux: undefined };
  function daemon(held = ada) {
    const calls: [string, Record<string, unknown>][] = [];
    const client = {
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === 'state.get') return { robots: { c_ada: held }, islands: { i_1: { id: 'i_1', name: 'home' } } };
        calls.push([method, params]);
        return ada;
      },
      close: () => undefined,
    };
    return { calls, connect: async () => client as unknown as Client };
  }
  const run = async (d: ReturnType<typeof daemon>, ...argv: string[]) => {
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
    try { await robotCommands(d.connect, () => false).parseAsync(['revive', 'ada', ...argv], { from: 'user' }); } finally { spy.mockRestore(); }
    return out;
  };

  it('resumes the session, or with --fresh starts a new one from a summary of it, in either terminal', async () => {
    const d = daemon();
    await run(d);
    await run(d, '--fresh');
    await run(d, '--fresh', '--term', '2');
    expect(d.calls).toEqual([['robot.revive', { id: 'c_ada' }], ['robot.fresh', { id: 'c_ada' }], ['robot.fresh', { id: 'c_ada', term: 2 }]]);
    await expect(run(d, '--term', '2')).rejects.toThrow(/--term goes with --fresh/);
  });

  it('says where the old session stays once a fresh one has started', async () => {
    const old = { kind: 'codex' as const, sessionId: 'old-1', transcriptPath: '/h/.codex/sessions/r.jsonl', status: 'idle' as const, lastActivityAt: 0 };
    const d = daemon({ ...ada, agent: old, second: { cwd: '/r', unread: false, agent: { ...old, kind: 'opencode', sessionId: 'ses_old' } } });
    expect(await run(d, '--fresh')).toBe('c_ada dormant; old session old-1 kept at /h/.codex/sessions/r.jsonl\n');
    expect(await run(d, '--fresh', '--term', '2')).toBe('c_ada dormant; old session ses_old kept in OpenCode\n');
  });
});
