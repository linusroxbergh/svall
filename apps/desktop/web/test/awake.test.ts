import type { Agent, AgentStatus, Character, FleetState, MobileStatus } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAKE_WINDOW_MS, awakeHold, followAwake, needOf, type Need } from '../src/awake.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const agent = (status: AgentStatus): Agent => ({ kind: 'claude', sessionId: 's', status, lastActivityAt: 0 });
const patch = (f: FleetState, id: string, p: Partial<Character>): FleetState =>
  ({ ...f, characters: { ...f.characters, [id]: { ...f.characters[id]!, ...p } } });
const second = (status: AgentStatus): Character['second'] => ({ tmux: { windowId: '@2', paneId: '%2' }, agent: agent(status), unread: false });
const phone = (login: string, since = 1) => ({ login, since });
const need = (o: Partial<Need> = {}): Need => ({ working: 0, waiting: 0, phones: 0, key: '', ...o });
const AC = { mode: 'needs' as const, battery: false, changedAt: 0, now: 0 };

describe('needOf', () => {
  it('counts every agent at work, a second terminal\'s too, but not one whose window is gone', () => {
    let f = patch(fleet(), 'c0', { agent: agent('working'), second: second('working') });
    f = patch(f, 'c1', { agent: agent('working'), tmux: undefined });
    expect(needOf(f, [])).toMatchObject({ working: 2, waiting: 0, phones: 0 });
  });

  it('counts the characters blocked or done and unread, and the phones on the fleet', () => {
    let f = patch(fleet(), 'c0', { agent: agent('blocked') });
    f = patch(f, 'c1', { agent: agent('done'), unread: true });
    f = patch(f, 'c2', { agent: agent('done') });
    expect(needOf(f, [phone('me')])).toMatchObject({ working: 0, waiting: 2, phones: 1 });
  });

  it('changes its key when work starts or stops, a character starts or stops waiting, or a phone comes or goes', () => {
    const base = needOf(fleet(), []).key;
    const working = patch(fleet(), 'c0', { agent: agent('working') });
    const done = patch(fleet(), 'c0', { agent: agent('done'), unread: true });
    const keys = [base, needOf(working, []).key, needOf(done, []).key, needOf(fleet(), [phone('me')]).key, needOf(fleet(), [phone('me', 2)]).key];
    expect(new Set(keys).size).toBe(keys.length);
    // a character that is read and idle is no change
    expect(needOf(patch(fleet(), 'c0', { agent: agent('done') }), []).key).toBe(base);
  });
});

describe('awakeHold', () => {
  it('holds while agents work, named by how many', () => {
    expect(awakeHold(need({ working: 3 }), AC)).toEqual({ reason: '3 agents working' });
    expect(awakeHold(need({ working: 1, waiting: 2 }), { ...AC, mode: 'working' })).toEqual({ reason: '1 agent working' });
  });

  it('holds nothing on battery or when off, whatever the fleet needs', () => {
    expect(awakeHold(need({ working: 3 }), { ...AC, battery: true })).toBeUndefined();
    expect(awakeHold(need({ working: 3 }), { ...AC, mode: 'off' })).toBeUndefined();
    expect(awakeHold(need({ waiting: 1 }), { ...AC, battery: true })).toBeUndefined();
  });

  it('holds for the window after the last change while a character waits or a phone is on, then lets go', () => {
    const changedAt = 1000;
    expect(awakeHold(need({ waiting: 2, phones: 1 }), { ...AC, changedAt, now: changedAt + 60_000 }))
      .toEqual({ reason: '2 characters waiting on you', until: changedAt + AWAKE_WINDOW_MS });
    expect(awakeHold(need({ phones: 1 }), { ...AC, changedAt, now: changedAt })).toEqual({ reason: '1 phone connected', until: changedAt + AWAKE_WINDOW_MS });
    expect(awakeHold(need({ waiting: 2 }), { ...AC, changedAt, now: changedAt + AWAKE_WINDOW_MS })).toBeUndefined();
  });

  it('holds nothing when nothing works or waits, or for a wait while set to working only', () => {
    expect(awakeHold(need(), AC)).toBeUndefined();
    expect(awakeHold(need({ waiting: 1, phones: 1 }), { ...AC, mode: 'working' })).toBeUndefined();
  });
});

describe('followAwake', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const store = createAppStore();
    const sent: ToShell[] = [];
    const handlers = new Set<(m: FromShell) => void>();
    const bridge = { send: (m: ToShell) => { sent.push(m); }, onMessage: (h: (m: FromShell) => void) => { handlers.add(h); return () => { handlers.delete(h); }; } };
    const stop = followAwake({ store, bridge });
    const power = (battery: boolean) => { for (const h of handlers) h({ type: 'power', battery }); };
    const holds = () => sent.map((m) => (m.type === 'awake' ? m.reason ?? null : '?'));
    return { store, power, holds, stop };
  }

  it('holds nothing until the shell says what the Mac runs on, and lets go while the daemon is out of reach', () => {
    const { store, power, holds, stop } = setup();
    store.getState().setFleet(patch(fleet(), 'c0', { agent: agent('working') }));
    store.getState().setStatus('online');
    expect(holds()).toEqual([]);
    power(false);
    store.getState().setStatus('offline');
    expect(holds()).toEqual(['1 agent working', null]);
    stop();
  });

  it('keeps holding for the window once work ends in a character waiting, then lets go', () => {
    const { store, power, holds, stop } = setup();
    store.getState().setStatus('online');
    power(false);
    store.getState().setFleet(patch(fleet(), 'c0', { agent: agent('working') }));
    vi.advanceTimersByTime(10 * 60_000);
    store.getState().setFleet(patch(fleet(), 'c0', { agent: agent('done'), unread: true }));
    vi.advanceTimersByTime(AWAKE_WINDOW_MS - 1);
    expect(holds()).toEqual(['1 agent working', '1 character waiting on you']);
    vi.advanceTimersByTime(1);
    expect(holds()).toEqual(['1 agent working', '1 character waiting on you', null]);
    stop();
  });

  it('starts the window again when a phone comes on, and lets go on battery or when turned off', () => {
    const { store, power, holds, stop } = setup();
    const done = patch(fleet(), 'c0', { agent: agent('done'), unread: true });
    store.getState().setStatus('online');
    store.getState().setFleet(done);
    power(false);
    vi.advanceTimersByTime(AWAKE_WINDOW_MS - 1000);
    store.getState().setMobile({ serving: true, url: '', port: 1, logins: [], phones: [phone('me')] } satisfies MobileStatus);
    vi.advanceTimersByTime(AWAKE_WINDOW_MS - 1000);
    expect(holds()).toEqual(['1 character waiting on you']);
    power(true);
    power(false);
    store.getState().setSettings({ keepAwake: 'off' });
    expect(holds()).toEqual(['1 character waiting on you', null, '1 character waiting on you', null]);
    stop();
  });
});
