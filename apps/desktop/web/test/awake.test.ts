import type { Agent, AgentStatus, Character, FleetState, MobileStatus } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAKE_WINDOW_MS, awakeHold, followAwake, needOf, type Need } from '../src/awake.js';
import type { ToShell } from '../src/bridge.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const T0 = 1_000_000_000;
const agent = (status: AgentStatus, extra: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: 's', status, lastActivityAt: 0, ...extra });
const patch = (f: FleetState, id: string, p: Partial<Character>): FleetState =>
  ({ ...f, characters: { ...f.characters, [id]: { ...f.characters[id]!, ...p } } });
const second = (status: AgentStatus, extra: Partial<Agent> = {}): Character['second'] => ({ cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, agent: agent(status, extra), unread: false });
const phone = (login: string, since = 1) => ({ login, since });
const need = (o: Partial<Need> = {}): Need => ({ working: 0, shells: 0, waiting: 0, phones: 0, since: 0, ...o });
const mobile = (phones: { login: string; since: number }[]): MobileStatus => ({ serving: true, url: '', port: 1, logins: [], phones });

describe('needOf', () => {
  it('counts every agent at work, a second terminal\'s too, but not one whose window is gone', () => {
    let f = patch(fleet(), 'c0', { agent: agent('working'), second: second('working') });
    f = patch(f, 'c1', { agent: agent('working'), tmux: undefined });
    expect(needOf(f, [])).toMatchObject({ working: 2, shells: 0, waiting: 0, phones: 0 });
  });

  it('counts an agent whose turn left only shells running apart from the agents at work', () => {
    let f = patch(fleet(), 'c0', { agent: agent('working', { background: true, shellsOnly: true }) });
    f = patch(f, 'c1', { agent: agent('working', { background: true }) });
    expect(needOf(f, [])).toMatchObject({ working: 1, shells: 1 });
  });

  it('counts the characters blocked or done and unread, and the phones on the fleet', () => {
    let f = patch(fleet(), 'c0', { agent: agent('blocked') });
    f = patch(f, 'c1', { agent: agent('done'), unread: true });
    f = patch(f, 'c2', { agent: agent('done') });
    expect(needOf(f, [phone('me')])).toMatchObject({ working: 0, waiting: 2, phones: 1 });
  });

  it('dates the need from the newest activity of any agent, in either terminal, or the newest phone', () => {
    let f = patch(fleet(), 'c0', { agent: agent('blocked', { lastActivityAt: 100 }) });
    f = patch(f, 'c1', { agent: agent('idle', { lastActivityAt: 200 }), second: second('idle', { lastActivityAt: 300 }) });
    expect(needOf(f, [phone('me', 250)]).since).toBe(300);
    expect(needOf(f, [phone('me', 250), phone('you', 400)]).since).toBe(400);
  });
});

describe('awakeHold', () => {
  it('holds while agents work, named by how many, with no end', () => {
    expect(awakeHold(need({ working: 3 }), { mode: 'needs', now: T0 })).toEqual({ reason: '3 agents working' });
    expect(awakeHold(need({ working: 1, waiting: 2 }), { mode: 'working', now: T0 })).toEqual({ reason: '1 agent working' });
  });

  it('holds nothing when off, whatever the fleet needs', () => {
    expect(awakeHold(need({ working: 3, waiting: 1, shells: 1 }), { mode: 'off', now: T0 })).toBeUndefined();
  });

  it('holds a shell left running for the window in either mode, and a wait or a phone only while set to need you', () => {
    const until = T0 + AWAKE_WINDOW_MS;
    expect(awakeHold(need({ shells: 1, since: T0 }), { mode: 'working', now: T0 })).toEqual({ reason: '1 agent with a shell running', until });
    expect(awakeHold(need({ waiting: 2, shells: 1, phones: 1, since: T0 }), { mode: 'needs', now: T0 })).toEqual({ reason: '2 characters waiting on you', until });
    expect(awakeHold(need({ phones: 1, since: T0 }), { mode: 'needs', now: T0 })).toEqual({ reason: '1 phone connected', until });
    expect(awakeHold(need({ waiting: 1, phones: 1, since: T0 }), { mode: 'working', now: T0 })).toBeUndefined();
    expect(awakeHold(need({ since: T0 }), { mode: 'needs', now: T0 })).toBeUndefined();
  });

  it('lets go once the window after the last activity is over', () => {
    expect(awakeHold(need({ waiting: 1, shells: 1, since: T0 }), { mode: 'needs', now: T0 + AWAKE_WINDOW_MS })).toBeUndefined();
  });
});

describe('followAwake', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(f?: FleetState) {
    const store = createAppStore();
    if (f) store.getState().setFleet(f);
    const sent: ToShell[] = [];
    const stop = followAwake({ store, bridge: { send: (m) => { sent.push(m); } } });
    const holds = () => sent.filter((m) => m.type === 'awake').map((m) => m.reason ?? null);
    return { store, sent, holds, stop };
  }

  it('lets go of any hold first, then holds only while the daemon is in reach', () => {
    const { store, holds, stop } = setup(patch(fleet(), 'c0', { agent: agent('working', { lastActivityAt: T0 }) }));
    expect(holds()).toEqual([null]);
    store.getState().setStatus('online');
    store.getState().setStatus('offline');
    expect(holds()).toEqual([null, '1 agent working', null]);
    stop();
  });

  it('holds nothing while the fleet runs on another machine, which goes on while this Mac sleeps', () => {
    const { store, holds, stop } = setup(patch(fleet(), 'c0', { agent: agent('working', { lastActivityAt: T0 }) }));
    store.getState().setConnectionState({ state: 'online', owner: 'trift' });
    store.getState().setStatus('online');
    expect(holds()).toEqual([null]);
    store.getState().setConnectionState({ state: 'online', owner: 'local' });
    expect(holds()).toEqual([null, '1 agent working']);
    store.getState().setConnectionState({ state: 'owner-changed', owner: 'trift' });
    expect(holds()).toEqual([null, '1 agent working', null]);
    stop();
  });

  it('holds for the window after work ends in a wait, counted from the fleet, so a reload does not start it again', () => {
    const { store, holds, stop } = setup();
    store.getState().setStatus('online');
    store.getState().setFleet(patch(fleet(), 'c0', { agent: agent('working', { lastActivityAt: T0 }) }));
    vi.advanceTimersByTime(10 * 60_000);
    const done = patch(fleet(), 'c0', { agent: agent('done', { lastActivityAt: Date.now() }), unread: true });
    store.getState().setFleet(done);
    vi.advanceTimersByTime(20 * 60_000);
    const reloaded = setup(done);
    reloaded.store.getState().setStatus('online');
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(holds()).toEqual([null, '1 agent working', '1 character waiting on you']);
    expect(reloaded.holds()).toEqual([null, '1 character waiting on you']);
    vi.advanceTimersByTime(1);
    expect(holds()).toEqual([null, '1 agent working', '1 character waiting on you', null]);
    expect(reloaded.holds()).toEqual([null, '1 character waiting on you', null]);
    stop();
    reloaded.stop();
  });

  it('holds for a server an agent left running only for the window, and for a phone that comes on, until turned off', () => {
    const { store, holds, stop } = setup(patch(fleet(), 'c0', { agent: agent('working', { background: true, shellsOnly: true, lastActivityAt: T0 }) }));
    store.getState().setStatus('online');
    vi.advanceTimersByTime(AWAKE_WINDOW_MS);
    expect(holds()).toEqual([null, '1 agent with a shell running', null]);
    store.getState().setMobile(mobile([phone('me', Date.now())]));
    vi.advanceTimersByTime(AWAKE_WINDOW_MS - 1);
    store.getState().setSettings({ keepAwake: 'off' });
    expect(holds()).toEqual([null, '1 agent with a shell running', null, '1 agent with a shell running', null]);
    stop();
  });

  it('holds while the page follows a handover it has heard from, whatever the daemon or the owner, on battery too, until turned off', () => {
    const { store, sent, holds, stop } = setup();
    store.getState().setConnectionState({ state: 'connecting', owner: 'trift' });
    // attaching on load hears nothing from a helper before the replay, so it holds nothing
    store.getState().handoverFollow();
    store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } }]);
    expect(holds()).toEqual([null]);
    store.getState().handoverFollow('trift');
    expect(holds()).toEqual([null]);
    store.getState().handoverEvent({ event: 'handover.changed', data: { transactionId: 'tx', phase: 'transfer' } });
    expect(sent.at(-1)).toEqual({ type: 'awake', reason: 'handing the fleet over', battery: true });
    store.getState().handoverExit(1);
    expect(holds()).toEqual([null, 'handing the fleet over', null]);
    store.getState().handoverFollow('trift');
    store.getState().handoverEvent({ event: 'handover.changed', data: { transactionId: 'tx', phase: 'transfer' } });
    store.getState().setSettings({ keepAwake: 'off' });
    expect(holds()).toEqual([null, 'handing the fleet over', null, 'handing the fleet over', null]);
    stop();
  });

  it('holds nothing for a journal read back with no helper running, as after a relaunch', () => {
    const { store, holds, stop } = setup();
    store.getState().handoverFollow();
    store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'committed', journals: {}, action: 'finish', safe: ['resume'], reason: 'committed', transactionId: 'tx' } }]);
    expect(holds()).toEqual([null]);
    stop();
  });

  it('follows a handover that went on without this window again, and holds while it runs', () => {
    const { store, sent, holds, stop } = setup();
    store.getState().handoverFollow('trift');
    store.getState().handoverEvent({ event: 'handover.changed', data: { transactionId: 'tx', phase: 'commit' } });
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'detached', transactionId: 'tx' } });
    store.getState().handoverExit(0);
    expect(sent.filter((m) => m.type === 'handover.attach')).toEqual([{ type: 'handover.attach' }]);
    expect(store.getState().handover).toMatchObject({ to: 'trift', following: true });
    store.getState().handoverEvent({ event: 'handover.status', data: { standing: 'committed', journals: {}, action: 'none', safe: [], reason: 'under way', transactionId: 'tx' } });
    expect(holds().at(-1)).toBe('handing the fleet over');
    stop();
  });

  it('looks again each minute, so a hold whose end passed while its timer stalled goes within a minute', () => {
    const { store, holds, stop } = setup(patch(fleet(), 'c0', { agent: agent('blocked', { lastActivityAt: T0 }) }));
    store.getState().setStatus('online');
    vi.setSystemTime(T0 + AWAKE_WINDOW_MS + 60 * 60_000);
    expect(holds()).toEqual([null, '1 character waiting on you']);
    vi.advanceTimersByTime(60_000);
    expect(holds()).toEqual([null, '1 character waiting on you', null]);
    stop();
  });
});
