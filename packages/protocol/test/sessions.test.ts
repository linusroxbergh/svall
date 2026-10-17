import { describe, expect, it } from 'vitest';
import { charOfKey, contextPctOf, emptyState, isNews, isPushStatus, secondKey, sessionsOf, type Agent, type Character } from '../src/index.js';

const agent = (status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: 's', status, lastActivityAt: 0, ...extra });
const char = (id: string, extra: Partial<Character> = {}): Character =>
  ({ id, islandId: 'i', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', context: [], cwd: '/tmp', shell: { lastOutputAt: 0 }, unread: false, ...extra });

describe('sessions', () => {
  it('keys a second terminal by its character, and reads the character back off either key', () => {
    expect(secondKey('c_1')).toBe('c_1-2');
    expect(charOfKey(secondKey('c_1'))).toBe('c_1');
    expect(charOfKey('c_1')).toBe('c_1');
  });

  it('lists a session per terminal, the second under its own key', () => {
    const f = { ...emptyState(), characters: {
      a: char('a', { agent: agent('working') }),
      b: char('b', { unread: true, second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: agent('blocked') } }),
    } };
    expect([...sessionsOf(f).values()]).toEqual([
      { key: 'a', charId: 'a', agent: agent('working'), unread: false },
      { key: 'b', charId: 'b', agent: undefined, unread: true },
      { key: 'b-2', charId: 'b', term: 2, agent: agent('blocked'), unread: false },
    ]);
  });

  it('counts a turn to blocked or done as one a device hears of, and a new question as news', () => {
    expect((['blocked', 'done', 'working', 'idle', undefined] as const).map(isPushStatus)).toEqual([true, true, false, false, false]);
    expect(isNews(agent('working'), agent('blocked'))).toBe(true);
    expect(isNews(undefined, agent('done'))).toBe(true);
    expect(isNews(agent('blocked', { promptId: 'p1' }), agent('blocked', { promptId: 'p1' }))).toBe(false);
    expect(isNews(agent('blocked', { promptId: 'p1' }), agent('blocked', { promptId: 'p2' }))).toBe(true);
  });

  it('takes the fuller of the two contexts', () => {
    const second = { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: agent('idle', { contextPct: 80 }) };
    expect(contextPctOf(char('a'))).toBeUndefined();
    expect(contextPctOf(char('a', { agent: agent('idle', { contextPct: 12 }), second }))).toBe(80);
  });
});
