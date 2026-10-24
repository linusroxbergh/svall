import type { Bridge } from './bridge.js';
import { decisionPending, destinationName, destinationOf, goesOnByItself, headline, type HandoverRun } from './handover.js';
import type { AppStore } from './store/index.js';

// one banner for the handover, which the next replaces
const KEY = 'handover';

/** What a banner says as the run the page follows comes to want the user: a decision or the move the checks cleared, its end, or a stop. */
function handoverNotice(prev: HandoverRun | undefined, next: HandoverRun | undefined, destination: string): { title: string; body: string } | undefined {
  if (!next) return undefined;
  const body = headline(next, destination);
  if (decisionPending(next) && !decisionPending(prev)) return { title: 'Handover waits for you', body };
  const r = next.result;
  // a run read back at launch is no longer followed, and says nothing new
  if (r && next.following && !prev?.result) {
    if (r.status === 'complete') return { title: 'Handover done', body };
    if (r.status === 'ready') return { title: 'Handover is ready to move', body };
    if (r.status === 'blocked' && r.phase === 'begin') return { title: 'Handover checks need you', body };
    // past the commit, the sheet resumes once by itself when the helper has gone
    if (goesOnByItself({ ...next, following: false })) return undefined;
    if (r.status === 'blocked' || r.status === 'aborted' || r.status === 'interrupted') return { title: 'Handover stopped', body };
    return undefined;
  }
  return next.error && !prev?.error && prev?.following ? { title: 'Handover stopped', body } : undefined;
}

/** Posts the handover's banners while the app is in the background and banners are on, and opens the sheet from one. */
export function followHandoverNotices({ store, bridge }: { store: AppStore; bridge: Pick<Bridge, 'send' | 'onMessage'> }): () => void {
  const offStore = store.subscribe((s, prev) => {
    const n = s.settings.notifications;
    if (s.handover === prev.handover || !s.handover || s.active || !n.on || s.notifyPermission !== 'granted') return;
    const notice = handoverNotice(prev.handover, s.handover, destinationName(destinationOf(s.handover, s.connection?.owner, s.shell?.gateway)));
    if (notice) bridge.send({ type: 'notify.post', key: KEY, ...notice, sound: n.sound, actions: false });
  });
  const offShell = bridge.onMessage((m) => { if (m.type === 'notify.open' && m.key === KEY) store.getState().toggleHandover(true); });
  return () => { offStore(); offShell(); };
}
