import { describe, expect, it } from 'vitest';
import type { FromShell, ToShell } from '../src/bridge.js';
import type { HandoverEvent } from '../src/handover.js';
import { followHandoverNotices } from '../src/handoverNotice.js';
import { createAppStore } from '../src/store/index.js';

const changed = (phase: 'begin' | 'freeze' | 'transfer'): HandoverEvent => ({ event: 'handover.changed', data: { transactionId: 'tx', phase } });
const result = (data: Extract<HandoverEvent, { event: 'handover.result' }>['data']): HandoverEvent => ({ event: 'handover.result', data });

function world(o: { active?: boolean; on?: boolean } = {}) {
  const store = createAppStore();
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, handoverEnabled: true, gateway: 'studio' });
  store.getState().setSettings({ notifications: { on: o.on ?? true, sound: false, statuses: ['blocked', 'done'] } });
  store.getState().setNotifyPermission('granted');
  store.getState().setActive(o.active ?? false);
  const sent: ToShell[] = [];
  let handler: (m: FromShell) => void = () => {};
  const stop = followHandoverNotices({ store, bridge: { send: (m) => { sent.push(m); }, onMessage: (h) => { handler = h; return () => {}; } } });
  const posted = () => sent.filter((m) => m.type === 'notify.post');
  return { store, sent, posted, stop, click: (key: string) => handler({ type: 'notify.open', key }) };
}

describe('banners for a handover while the app is in the background', () => {
  it('posts one when the run waits for a decision, when the checks clear the move, and when it completes', () => {
    const w = world();
    w.store.getState().handoverFollow('studio');
    w.store.getState().handoverEvent(changed('begin'));
    w.store.getState().handoverEvent(changed('freeze'));
    expect(w.posted()).toEqual([]);
    w.store.getState().handoverEvent({ event: 'handover.blocked', data: { transactionId: 'tx', phase: 'freeze', blockers: [{ code: 'agent_working', message: 'ada is still working' }] } });
    // the same decision again posts nothing more
    w.store.getState().handoverEvent({ event: 'handover.entity', data: { transactionId: 'tx', kind: 'character', id: 'c1', phase: 'freeze' } });
    w.store.getState().handoverEvent(result({ status: 'complete', transactionId: 'tx', generation: 2, characters: [] }));
    expect(w.posted()).toEqual([
      { type: 'notify.post', key: 'handover', title: 'Handover waits for you', subtitle: '', body: 'One thing to decide before the fleet goes on.', sound: false, actions: false },
      { type: 'notify.post', key: 'handover', title: 'Handover done', subtitle: '', body: 'The fleet runs on studio now.', sound: false, actions: false },
    ]);

    w.store.getState().handoverFollow('studio');
    w.store.getState().handoverEvent(result({ status: 'ready' }));
    expect(w.posted().at(-1)).toMatchObject({ title: 'Handover is ready to move', body: 'Nothing stops the move to studio, and nothing has moved yet.' });
  });

  it('posts one when the run stops, by its result or a helper that ended with an error', () => {
    const w = world();
    w.store.getState().handoverFollow('studio');
    w.store.getState().handoverEvent(changed('transfer'));
    w.store.getState().handoverEvent(result({ status: 'interrupted', transactionId: 'tx', phase: 'transfer', error: 'ssh to studio closed', safe: ['resume', 'abort'] }));
    w.store.getState().handoverFollow('studio');
    w.store.getState().handoverExit(1, 'svall exited');
    expect(w.posted().map((m) => m.type === 'notify.post' && [m.title, m.body])).toEqual([
      ['Handover stopped', 'Stopped at Transferring files and sessions: ssh to studio closed'],
      ['Handover stopped', 'The helper did not run: svall exited'],
    ]);
  });

  it('posts nothing in front, with banners off, or for a run read back at launch', () => {
    for (const w of [world({ active: true }), world({ on: false })]) {
      w.store.getState().handoverFollow('studio');
      w.store.getState().handoverEvent(result({ status: 'complete', transactionId: 'tx', generation: 2, characters: [] }));
      expect(w.posted()).toEqual([]);
    }
    const w = world();
    w.store.getState().handoverFollow();
    w.store.getState().handoverReplay([changed('transfer'), result({ status: 'interrupted', transactionId: 'tx', phase: 'transfer', error: 'closed', safe: ['resume'] })]);
    expect(w.posted()).toEqual([]);
  });

  it('opens the sheet when its banner is clicked', () => {
    const w = world();
    w.click('c1');
    expect(w.store.getState().handoverOpen).toBe(false);
    w.click('handover');
    expect(w.store.getState().handoverOpen).toBe(true);
    w.stop();
  });
});
