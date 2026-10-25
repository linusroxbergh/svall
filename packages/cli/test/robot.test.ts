import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MoveSheet, type Refusal, type Robot } from '@svall/protocol';
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

describe('a robot command that stops on an error', () => {
  it('closes its connection to the fleet', async () => {
    const close = vi.fn();
    const client = { call: async () => ({ version: 11, islands: {}, robots: { c_a: base } }), close };
    await expect(robotCommands(async () => client as unknown as Client, () => false).parseAsync(['node', 'robot', 'show', 'nobody'])).rejects.toThrow('no robot "nobody"');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('robot wait', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
  const wait = async (ref: string, robots: Record<string, Robot>, flags: string[] = []) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const calls: string[] = [];
    const client = { call: async (m: string) => { calls.push(m); return m === 'state.get' ? { version: 11, islands: {}, robots } : { status: 'gone' }; }, close() {} };
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

describe('robot move to a machine', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
  const VAULT = '7b9e3c1a-0d2f-4e5a-8b6c-9d0e1f2a3b4c';
  const kanban: Robot = {
    ...base, id: 'c_1', name: 'kanban',
    repo: { root: '/Users/ada/code/svall/.claude/worktrees/kanban-board', mainRoot: '/Users/ada/code/svall', branch: 'kanban-board', isWorktree: true },
  };
  const state = { version: 11, islands: { i_1: { id: 'i_1', name: 'work' } }, robots: { c_1: kanban }, machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } };
  const sheet: MoveSheet = {
    sessionBytes: 4_200_000, branch: 'kanban-board', commits: 2, changedFiles: 2, untrackedFiles: 1, clone: 'clone', credentialFiles: ['.env'], stays: ['.env stays here'],
    interrupts: false, question: false, notInRepo: false,
  };
  const refusal: Refusal = { reason: 'linus-vault is not reachable', action: 'try again when it is awake', details: ['kanban is working; interrupt after this turn'] };

  function daemon(o: { check?: unknown; moveTo?: () => unknown } = {}) {
    const calls: [string, unknown][] = [];
    const client = {
      call: async (method: string, params: unknown) => {
        if (method === 'state.get') return state;
        calls.push([method, params]);
        if (method === 'robot.moveCheck') return o.check ?? { ok: true, sheet };
        return o.moveTo ? o.moveTo() : { moveId: 'mv_0123456789' };
      },
      close: () => undefined,
    };
    return { calls, connect: async () => client as unknown as Client };
  }
  const run = async (d: ReturnType<typeof daemon>, argv: string[], json = false) => {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += String(s); return true; });
    await robotCommands(d.connect, () => json).parseAsync(['move', ...argv], { from: 'user' });
    vi.restoreAllMocks();
    return { out, err };
  };

  it('svall robot move c_1 --machine linus-vault prints the sheet and the move id; a refusal exits 2 with reason and action', async () => {
    const d = daemon();
    expect(await run(d, ['c_1', '--machine', 'linus-vault'])).toEqual({
      out: 'session 4 MB · branch kanban-board: 2 commits not on origin, 3 changed files · svall on linus-vault: will clone (first time) · .env stays here\nmv_0123456789\n',
      err: '',
    });
    expect(d.calls).toEqual([['robot.moveCheck', { id: 'c_1', machine: VAULT }], ['robot.moveTo', { id: 'c_1', machine: VAULT }]]);
    expect(process.exitCode).toBeFalsy();

    const refused = daemon({ check: { ok: false, refusal } });
    expect(await run(refused, ['kanban', '--machine', VAULT])).toEqual({ out: '', err: 'refused: linus-vault is not reachable\n  → try again when it is awake\n' });
    expect(refused.calls.map(([m]) => m)).toEqual(['robot.moveCheck']);
    expect(process.exitCode).toBe(2);
  });

  it('says a refusal the move itself answers as the checks do, and gives either as one JSON object with --json', async () => {
    const late = () => { throw new ApiError('refused', 'kanban is working; interrupt after this turn', { refusal: { reason: 'kanban is working', action: 'interrupt after this turn', details: [] } }); };
    expect((await run(daemon({ moveTo: late }), ['c_1', '--machine', 'linus-vault'])).err).toBe('refused: kanban is working\n  → interrupt after this turn\n');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;

    expect(JSON.parse((await run(daemon(), ['c_1', '--machine', 'linus-vault'], true)).out)).toEqual({ ok: true, sheet, moveId: 'mv_0123456789' });
    expect(process.exitCode).toBeFalsy();
    expect(JSON.parse((await run(daemon({ check: { ok: false, refusal } }), ['c_1', '--machine', 'linus-vault'], true)).out)).toEqual({ ok: false, refusal });
    expect(process.exitCode).toBe(2);
  });

  it('sends the interrupt and the credential files chosen, and phrases what else the sheet says', async () => {
    const d = daemon({
      check: { ok: true, sheet: { ...sheet, sessionBytes: 0, branch: 'kanban', commits: 1, changedFiles: 0, untrackedFiles: 0, clone: 'warm', stays: [], interrupts: true, question: true, converts: { main: '/Users/ada/code/svall', branch: 'kanban', changed: 1 } } },
    });
    const { out } = await run(d, ['c_1', '--machine', 'linus-vault', '--interrupt-after', '30s', '--carry', '.env', '--carry', 'id_rsa']);
    expect(out.split('\n')[0]).toBe('branch kanban: 1 commit not on origin · svall on linus-vault: cloned already · your 1 changed file in svall\'s main checkout moves to a new branch kanban · its open question is dropped; it asks again · what still runs is interrupted');
    expect(d.calls[0]).toEqual(['robot.moveCheck', { id: 'c_1', machine: VAULT, carry: ['.env', 'id_rsa'], interruptAfterMs: 30_000 }]);
    expect(d.calls[1]).toEqual(['robot.moveTo', { id: 'c_1', machine: VAULT, carry: ['.env', 'id_rsa'], interruptAfterMs: 30_000 }]);

    const clean = daemon({ check: { ok: true, sheet: { ...sheet, sessionBytes: 0, branch: 'kanban', commits: 0, changedFiles: 0, untrackedFiles: 0, stays: [], converts: { main: '/Users/ada/code/svall', branch: 'kanban', changed: 0 } } } });
    expect((await run(clean, ['c_1', '--machine', 'linus-vault'])).out.split('\n')[0]).toBe("branch kanban · svall on linus-vault: will clone (first time) · it leaves svall's main checkout for a new branch kanban");

    const shell = daemon({ check: { ok: true, sheet: { ...sheet, branch: '', commits: 0, changedFiles: 0, untrackedFiles: 0, stays: [], credentialFiles: [], notInRepo: true } } });
    expect((await run(shell, ['c_1', '--machine', 'linus-vault'])).out.split('\n')[0]).toBe('session 4 MB · in no repository: it moves with its session only');
  });

  it('takes one of --island and --machine, and names a machine the fleet does not have', async () => {
    await expect(run(daemon(), ['c_1'])).rejects.toThrow('name one of --island and --machine');
    const cmd = robotCommands(daemon().connect, () => false);
    cmd.commands.find((c) => c.name() === 'move')!.exitOverride().configureOutput({ writeErr: () => {} });
    for (const flags of [['--island', 'work', '--machine', 'linus-vault'], ['--island', 'work', '--carry', '.env'], ['--machine', 'linus-vault', '--cell', '1,1']]) {
      await expect(cmd.parseAsync(['move', 'c_1', ...flags], { from: 'user' }), flags.join(' ')).rejects.toThrow(/cannot be used with/);
    }
    await expect(run(daemon(), ['c_1', '--machine', 'trift'])).rejects.toThrow('no machine "trift"');
  });
});
