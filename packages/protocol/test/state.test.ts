import { describe, expect, it } from 'vitest';
import { Agent, Character, ContextItem, DEFAULT_CWD, FleetState, Home, Island, STATE_SCHEMA_VERSION, defaultHome, emptyState } from '../src/index.js';

describe('state schemas', () => {
  it('accepts an empty fleet', () => {
    expect(FleetState.parse(emptyState())).toEqual({
      version: 8, islands: {}, characters: {},
      home: {
        cwd: '~/.svall/home', command: 'claude --model sonnet',
        actions: [
          { label: 'update info', prompt: '/svall-update-info' }, { label: 'status', prompt: '/svall-status' },
        ],
      },
      defaultCwd: DEFAULT_CWD,
      scribeAsk: true,
    });
  });

  it('fills home from defaults when a state file has none', () => {
    const s = FleetState.parse({ version: 8, islands: {}, characters: {} });
    expect(s.home.command).toBe('claude --model sonnet');
    expect(s.defaultCwd).toBe(DEFAULT_CWD);
    expect(s.home.actions.map((a) => a.label)).toEqual(['update info', 'status']);
    expect(Home.parse({ cwd: '/x' })).toEqual({ cwd: '/x', command: 'claude --model sonnet', actions: defaultHome().actions });
  });

  it('accepts a home island and rejects other kinds', () => {
    const base = { id: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 4 }, seed: 7 };
    expect(Island.parse({ ...base, kind: 'home' }).kind).toBe('home');
    expect(Island.parse(base).kind).toBeUndefined();
    expect(() => Island.parse({ ...base, kind: 'boat' })).toThrow();
  });

  it('accepts a plain-shell character without agent or tmux', () => {
    const c = Character.parse({
      id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'shell', portrait: 'owl', description: '', note: '', instructions: '',
      cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
    });
    expect(c.agent).toBeUndefined();
    expect(c.tmux).toBeUndefined();
  });

  it('rejects an unknown agent status', () => {
    expect(() => Character.parse({
      id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'x', portrait: 'owl', description: '', note: '', instructions: '', cwd: '/tmp', context: [],
      shell: { lastOutputAt: 0 }, unread: false,
      agent: { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'sleeping', lastActivityAt: 0 },
    })).toThrow();
  });

  it('accepts a context item that is a pinned folder and an island with instructions', () => {
    const item = { kind: 'folder', ref: '/Users/x/notes', label: '', source: 'manual', pinned: true };
    expect(ContextItem.parse(item)).toEqual(item);
    expect(Island.parse({ id: 'i', name: 'n', description: '', instructions: 'never touch src/legacy', context: [item], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 }).instructions)
      .toBe('never touch src/legacy');
    expect(emptyState().version).toBe(8);
    expect(STATE_SCHEMA_VERSION).toBe(8);
  });

  it('keeps both terminals of an imported state that carries no tmux ids', () => {
    const c = Character.parse({
      id: 'c', islandId: 'i', cell: { x: 1, y: 1 }, name: 'n', portrait: 'fox', note: '', instructions: '', context: [],
      cwd: '/work', shell: { lastOutputAt: 0 }, unread: false, revive: { command: 'claude --resume a' },
      second: { cwd: '/work/side', unread: false, revive: { command: 'codex resume b' } },
    });
    const s = FleetState.parse({ version: 8, islands: {}, characters: { c } });
    expect(s.characters.c.revive).toEqual({ command: 'claude --resume a' });
    expect(s.characters.c.second).toEqual({ cwd: '/work/side', unread: false, revive: { command: 'codex resume b' } });
  });

  it('a character may carry browser tabs and which one is active', () => {
    const base = { id: 'c', islandId: 'i', cell: { x: 1, y: 1 }, name: 'n', portrait: 'fox', note: '', instructions: '', context: [], cwd: '/tmp', shell: { lastOutputAt: 0 }, unread: false };
    expect(Character.parse(base).browser).toBeUndefined();
    const c = Character.parse({ ...base, browser: { tabs: [{ id: 't_abcd1234', url: 'https://example.com/', title: 'Example' }], active: 't_abcd1234' } });
    expect(c.browser?.tabs[0].title).toBe('Example');
    expect(() => Character.parse({ ...base, browser: { tabs: [{ id: '', url: 'x', title: '' }] } })).toThrow();
  });
});

describe('Agent', () => {
  it('accepts a codex agent', () => {
    expect(Agent.safeParse({ kind: 'codex', sessionId: 'a', transcriptPath: '/x.jsonl', status: 'idle', lastActivityAt: 1 }).success).toBe(true);
  });

  it('accepts an agent with no transcript path yet', () => {
    expect(Agent.safeParse({ kind: 'codex', sessionId: 'a', status: 'idle', lastActivityAt: 1 }).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(Agent.safeParse({ kind: 'cursor', sessionId: 'a', status: 'idle', lastActivityAt: 1 }).success).toBe(false);
  });
});
