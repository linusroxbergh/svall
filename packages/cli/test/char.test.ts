import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@svall/protocol';
import type { Client } from '../src/client.js';
import { agentFor, charCommands, termOf } from '../src/commands/char.js';
import { contextOf, stateOf } from '../src/render.js';

const base: Character = {
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
});

describe('char new', () => {
  it('refuses two agents, or an agent and a command, rather than drop one', async () => {
    const cmd = charCommands(async () => { throw new Error('connected'); }, () => false);
    cmd.commands.find((c) => c.name() === 'new')!.exitOverride().configureOutput({ writeErr: () => {} });
    for (const flags of [['--claude', '--codex'], ['--agent', 'codex', '--command', 'x'], ['--codex', '--command', 'x'], ['--agent', '--claude']]) {
      await expect(cmd.parseAsync(['node', 'char', 'new', '--island', 'i', '--cwd', '/tmp', ...flags]), flags.join(' ')).rejects.toThrow(/cannot be used with/);
    }
  });
});

describe('a char command that stops on an error', () => {
  it('closes its connection to the fleet', async () => {
    const close = vi.fn();
    const client = { call: async () => ({ version: 7, islands: {}, characters: { c_a: base } }), close };
    await expect(charCommands(async () => client as unknown as Client, () => false).parseAsync(['node', 'char', 'show', 'nobody'])).rejects.toThrow('no character "nobody"');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('char wait', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
  const wait = async (ref: string, characters: Record<string, Character>, flags: string[] = []) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const calls: string[] = [];
    const client = { call: async (m: string) => { calls.push(m); return m === 'state.get' ? { version: 7, islands: {}, characters } : { status: 'gone' }; }, close() {} };
    await charCommands(async () => client as unknown as Client, () => false).parseAsync(['node', 'char', 'wait', ref, '--until', 'idle', ...flags]);
    return calls;
  };

  it('exits 3 for a character that is already closed, and says the ref matched none', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await wait('c_closed', { c_a: base });
    expect(process.exitCode).toBe(3);
    expect(stderr).toHaveBeenCalledWith('svall: no character "c_closed"\n');
  });

  it('checks its flags before it looks the character up', async () => {
    await expect(wait('c_closed', { c_a: base }, ['--timeout', 'soon'])).rejects.toThrow(/--timeout/);
    await expect(wait('c_closed', { c_a: base }, ['--term', '3'])).rejects.toThrow(/--term/);
  });

  it('refuses a name two characters share', async () => {
    await expect(wait('a', { c_a: base, c_b: { ...base, id: 'c_b' } })).rejects.toThrow(/matches/);
  });
});

describe('Keep on this machine', () => {
  const ada: Character = { ...base, id: 'c_ada', name: 'ada', keepHere: true };
  const bo: Character = { ...base, id: 'c_bo', name: 'bo' };

  function daemon() {
    const updates: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === 'state.get') return { characters: { c_ada: ada, c_bo: bo }, islands: { i_1: { id: 'i_1', name: 'home' } } };
        if (method === 'char.update') { updates.push(params); return { ...ada, ...params }; }
        if (method === 'char.show') return { text: 'the brief' };
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
      await charCommands(connect, () => false).parseAsync(argv, { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    return out.join('');
  }

  it('is set and cleared through char.update, and left alone otherwise', async () => {
    const d = daemon();
    await svall(d.connect, 'update', 'bo', '--keep-here');
    await svall(d.connect, 'update', 'ada', '--no-keep-here');
    await svall(d.connect, 'update', 'ada', '--name', 'ada2');
    expect(d.updates.map((u) => u.keepHere)).toEqual([true, false, undefined]);
    expect(d.updates.map((u) => u.id)).toEqual(['c_bo', 'c_ada', 'c_ada']);
  });

  it('marks a kept character where char list and char show name it', async () => {
    const d = daemon();
    const list = await svall(d.connect, 'list');
    expect(list).toMatch(/ada \(kept here\)/);
    expect(list).not.toMatch(/bo \(kept here\)/);
    expect(await svall(d.connect, 'show', 'ada')).toMatch(/^ada is kept on this machine, so a handover is blocked until that is cleared\n/);
    expect(await svall(d.connect, 'show', 'bo')).toBe('the brief\n');
  });
});
