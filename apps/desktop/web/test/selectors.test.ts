import { describe, expect, it } from 'vitest';
import { emptyState } from '@svall/protocol';
import { boardIsland, boardViewed, charactersByPriority, charactersOf, contextPctOf, countsByStatus, DISPLAY_STATUSES, firstOfNextIsland, homeIsland, islandStatus, islandsSorted, isUnread, isVeiled, neighbor, selectedOf, slotStatus, statusOf, stripOrder, wantsUser } from '../src/selectors.js';
import { chr, fleet } from './fixtures.js';

describe('selectors', () => {
  it('orders islands by name and characters by slot', () => {
    expect(islandsSorted(fleet()).map((i) => i.id)).toEqual(['i_a', 'i_b', 'i_e', 'home']);
    expect(charactersOf(fleet(), 'i_b').map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(stripOrder(fleet()).map((c) => c.id)).toEqual(['c2', 'c0', 'c1']);
  });
  it('puts islands a drag has ordered first, and the rest after them by name', () => {
    const f = fleet();
    f.islands.i_e.order = 0;
    f.islands.i_b.order = 1;
    expect(islandsSorted(f).map((i) => i.id)).toEqual(['i_e', 'i_b', 'i_a', 'home']);
    expect(stripOrder(f).map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });
  it('works out a crew and the strip once per fleet', () => {
    const f = fleet();
    expect(charactersOf(f, 'i_b')).toBe(charactersOf(f, 'i_b'));
    expect(stripOrder(f)).toBe(stripOrder(f));
    expect(charactersOf({ ...f }, 'i_b')).not.toBe(charactersOf(f, 'i_b'));
  });
  it('walks neighbours across the fleet in strip order with wrap-around', () => {
    expect(neighbor(fleet(), 'c1', 1)?.id).toBe('c2');
    expect(neighbor(fleet(), 'c0', -1)?.id).toBe('c2');
    expect(neighbor(fleet(), 'c2', 1)?.id).toBe('c0');
    expect(neighbor(fleet(), 'c2', -1)?.id).toBe('c1');
    expect(neighbor(fleet(), undefined, 1)?.id).toBe('c2');
    expect(neighbor(emptyState(), undefined, 1)).toBeUndefined();
  });
  it('jumps to the first character of the next non-empty island', () => {
    expect(firstOfNextIsland(fleet(), 'c2')?.id).toBe('c0');
    expect(firstOfNextIsland(fleet(), 'c1')?.id).toBe('c2');
    expect(firstOfNextIsland(fleet(), undefined)?.id).toBe('c2');
  });
  it('skips collapsed islands when walking and jumping', () => {
    const f = fleet();
    f.islands.i_b.collapsed = true;
    expect(neighbor(f, 'c2', 1)?.id).toBe('c2');
    expect(neighbor(f, 'c0', 1)?.id).toBe('c2');
    expect(firstOfNextIsland(f, 'c2')?.id).toBe('c2');
    expect(firstOfNextIsland(f, 'c0')?.id).toBe('c2');
    f.islands.i_a.collapsed = true;
    expect(neighbor(f, 'c2', -1)).toBeUndefined();
    expect(firstOfNextIsland(f, undefined)).toBeUndefined();
  });
  it('derives a display status', () => {
    expect(statusOf(chr('x', 'i', { x: 0, y: 0 }))).toBe('shell');
    expect(statusOf(chr('x', 'i', { x: 0, y: 0 }, { tmux: undefined, agent: { kind: 'claude', sessionId: 's', transcriptPath: 't', status: 'done', lastActivityAt: 0 } }))).toBe('done');
    expect(statusOf(chr('x', 'i', { x: 0, y: 0 }, { agent: { kind: 'claude', sessionId: 's', transcriptPath: 't', status: 'blocked', lastActivityAt: 0 } }))).toBe('blocked');
  });
  it('shows a character with no window as idle, whatever turn or question its agent was left on', () => {
    for (const status of ['working', 'blocked'] as const) {
      expect(statusOf(chr('x', 'i', { x: 0, y: 0 }, { tmux: undefined, agent: { kind: 'claude', sessionId: 's', transcriptPath: 't', status, lastActivityAt: 0 } }))).toBe('idle');
    }
  });
  it('anything the page spreads over a surface hides it first', () => {
    const base = { namingCharacter: false, missionPrompt: false, closingCharacter: undefined, keysOpen: false, resourcesOpen: false, fleet: fleet() };
    expect(isVeiled(base)).toBe(false);
    expect(isVeiled({ ...base, missionPrompt: true })).toBe(true);
    expect(isVeiled({ ...base, namingCharacter: true })).toBe(true);
    expect(isVeiled({ ...base, closingCharacter: 'c0' })).toBe(true);
    expect(isVeiled({ ...base, deletingIsland: 'i_e' })).toBe(true);
    expect(isVeiled({ ...base, keysOpen: true })).toBe(true);
    expect(isVeiled({ ...base, fleet: { ...fleet(), scribeAsk: true } })).toBe(true);
  });
  it('veils while the resources shelf is open', () => {
    expect(isVeiled({ namingCharacter: false, missionPrompt: false, keysOpen: false, resourcesOpen: true, fleet: fleet() })).toBe(true);
  });
});

describe('selectedOf', () => {
  it('falls back from the selection to the focus to the first character', () => {
    const f = fleet();
    expect(selectedOf({ fleet: f, selectedId: 'c1', focusedId: 'c0' })).toBe('c1');
    expect(selectedOf({ fleet: f, selectedId: 'gone', focusedId: 'c0' })).toBe('c0');
    expect(selectedOf({ fleet: f, selectedId: undefined, focusedId: undefined })).toBe('c2');
    expect(selectedOf({ fleet: emptyState(), selectedId: undefined, focusedId: undefined })).toBeUndefined();
  });
});

describe('board', () => {
  const agent = (status: 'working' | 'idle' | 'blocked' | 'done') => ({ kind: 'claude' as const, sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 0 });
  const busy = () => {
    const f = fleet();
    f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { agent: agent('idle') });
    f.characters.c1 = chr('c1', 'i_b', { x: 2, y: 1 }, { agent: agent('done'), unread: true });
    f.characters.c3 = chr('c3', 'i_b', { x: 3, y: 1 }, { agent: agent('done') });
    f.characters.c4 = chr('c4', 'i_a', { x: 2, y: 1 }, { agent: agent('blocked') });
    f.characters.c5 = chr('c5', 'i_a', { x: 3, y: 1 }, { tmux: undefined });
    return f;
  };
  it('orders characters by priority: blocked, done unread, working, idle, done seen, shell; ties in strip order', () => {
    expect(charactersByPriority(busy()).map((c) => c.id)).toEqual(['c4', 'c1', 'c0', 'c3', 'c2', 'c5']);
  });
  it('gives an island the status of its most pressing character', () => {
    const f = busy();
    expect(islandStatus(f, 'i_a')).toBe('blocked');
    expect(islandStatus(f, 'i_b')).toBe('done');
    expect(islandStatus(f, 'i_e')).toBeUndefined();
  });
  it('views the selection; a selected island views its focused or first character, an empty one nothing', () => {
    const f = fleet();
    expect(boardViewed({ fleet: f, selectedId: 'c1', selectedIslandId: undefined })).toBe('c1');
    expect(boardViewed({ fleet: f, focusedId: 'c0', selectedIslandId: 'i_e' })).toBeUndefined();
    expect(boardViewed({ fleet: f, focusedId: 'c0', selectedIslandId: 'gone' })).toBe('c0');
    expect(boardViewed({ fleet: f, focusedId: 'c1', selectedIslandId: 'i_b' })).toBe('c1');
    expect(boardViewed({ fleet: f, focusedId: 'c2', selectedIslandId: 'i_b' })).toBe('c0');
    expect(boardViewed({ fleet: f, selectedIslandId: 'i_a' })).toBe('c2');
    expect(boardIsland({ fleet: f, selectedId: 'c1' })?.id).toBe('i_b');
    expect(boardIsland({ fleet: f, selectedIslandId: 'i_e' })?.id).toBe('i_e');
    expect(boardIsland({ fleet: emptyState() })).toBeUndefined();
  });
});

describe('countsByStatus', () => {
  it('lists every display status in a fixed order', () => {
    expect(DISPLAY_STATUSES).toEqual(['working', 'idle', 'blocked', 'done', 'shell']);
  });

  it('counts the fixture fleet as three shells', () => {
    expect(countsByStatus(fleet())).toEqual({ working: 0, idle: 0, blocked: 0, done: 0, shell: 3 });
  });

  it('counts agents by agent status, a dormant one\'s too', () => {
    const agent = { kind: 'claude' as const, sessionId: 's', transcriptPath: '/t', status: 'working' as const, lastActivityAt: 0 };
    const f = fleet();
    f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { agent });
    f.characters.c1 = chr('c1', 'i_b', { x: 2, y: 1 }, { agent: { ...agent, status: 'blocked' } });
    f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { tmux: undefined, agent: { ...agent, status: 'idle' } });
    expect(countsByStatus(f)).toEqual({ working: 1, idle: 1, blocked: 1, done: 0, shell: 0 });
  });
});

describe('home island', () => {
  it('sorts last whatever its name, and is found by kind', () => {
    const f = fleet();
    expect(islandsSorted(f).map((i) => i.id)).toEqual(['i_a', 'i_b', 'i_e', 'home']);
    expect(homeIsland(f)?.id).toBe('home');
  });
  it('is the last stop of the island cycle', () => {
    const f = fleet();
    f.characters.c9 = chr('c9', 'home', { x: 1, y: 1 });
    expect(firstOfNextIsland(f, 'c1')?.id).toBe('c9');
    expect(firstOfNextIsland(f, 'c9')?.id).toBe('c2');
  });
});

describe('a character with two sessions', () => {
  const agent = (status: 'working' | 'idle' | 'blocked' | 'done', contextPct?: number) =>
    ({ kind: 'claude' as const, sessionId: 's', transcriptPath: '/t', status, contextPct, lastActivityAt: 1 });
  const second = (a?: ReturnType<typeof agent>, unread = false) => ({ tmux: { windowId: '@2', paneId: '%2' }, agent: a, unread });
  const at = { x: 0, y: 0 };

  it('shows the most urgent of the two: blocked, working, done, idle, shell', () => {
    expect(statusOf(chr('c', 'i', at, { agent: agent('idle'), second: second(agent('working')) }))).toBe('working');
    expect(statusOf(chr('c', 'i', at, { agent: agent('working'), second: second(agent('blocked')) }))).toBe('blocked');
    expect(statusOf(chr('c', 'i', at, { agent: agent('done'), second: second(agent('working')) }))).toBe('working');
    expect(statusOf(chr('c', 'i', at, { agent: agent('idle'), second: second() }))).toBe('idle');
    expect(statusOf(chr('c', 'i', at, { tmux: undefined, second: second() }))).toBe('shell');
  });
  it('still tells the two apart', () => {
    const c = chr('c', 'i', at, { agent: agent('idle'), second: second(agent('working')) });
    expect(slotStatus(c, 1)).toBe('idle');
    expect(slotStatus(c, 2)).toBe('working');
  });
  it('reads the fuller context and either unread flag', () => {
    const c = chr('c', 'i', at, { agent: agent('idle', 20), second: second(agent('done', 71), true) });
    expect(contextPctOf(c)).toBe(71);
    expect(contextPctOf(chr('c', 'i', at))).toBeUndefined();
    expect(isUnread(c)).toBe(true);
    expect(wantsUser(c)).toBe(true);
  });
});
