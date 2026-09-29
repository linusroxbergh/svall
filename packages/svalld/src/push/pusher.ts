import webpush from 'web-push';
import { PUSH_STATUSES, type Agent, type AgentStatus, type FleetState, type PushStatus } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import { secondName } from '../reconcile.js';
import type { PushStore, Subscription } from './store.js';
import type { Vapid } from './vapid.js';

// term 2 marks the character's second session, which the phone cannot answer, so its notification carries no buttons.
// promptId goes back with the answer, so a late one does not answer a newer question
export type PushPayload = { id: string; name: string; status: PushStatus; term?: 2; prompt?: string; promptId?: string };
// subject is who the push service may contact about the sender
export type Send = (sub: Subscription, payload: PushPayload, subject: string) => Promise<void>;

const isPushStatus = (s: AgentStatus | undefined): s is PushStatus => (PUSH_STATUSES as readonly string[]).includes(s ?? '');
type Session = { charId: string; term?: 2; agent?: Agent };
// one entry per session: a character's second terminal is told apart by its key, and reported under the character
const sessions = (f: FleetState): Map<string, Session> =>
  new Map(Object.values(f.characters).flatMap((c): [string, Session][] => [
    [c.id, { charId: c.id, agent: c.agent }],
    ...(c.second ? [[secondName(c.id), { charId: c.id, term: 2, agent: c.second.agent }] as [string, Session]] : []),
  ]));

/** Tells every device of an accepted login when an agent turns blocked or done, while the phone link is served. The returned function stops it. */
export function startPusher(o: { store: Store; push: PushStore; send: Send; log: Logger; logins: () => string[]; served: () => string | undefined; contact?: string }): () => void {
  let last = sessions(o.store.state);
  return o.store.subscribe(() => {
    const f = o.store.state;
    const next = sessions(f);
    const url = o.served();
    for (const [key, { charId, term, agent }] of next) {
      const status = agent?.status;
      const was = last.get(key)?.agent;
      // a new question while the agent stays blocked is news too
      if (url === undefined || (status === was?.status && agent?.promptId === was?.promptId) || !isPushStatus(status)) continue;
      const c = f.characters[charId];
      const payload: PushPayload = {
        id: charId, name: c.name, status, ...(term ? { term } : {}), ...(agent?.prompt ? { prompt: agent.prompt } : {}), ...(agent?.promptId ? { promptId: agent.promptId } : {}),
      };
      for (const sub of o.push.list()) {
        if (!sub.statuses.includes(status) || !o.logins().includes(sub.login)) continue;
        o.send(sub, payload, o.contact ?? url).catch((e: Error & { statusCode?: number }) => {
          // the push service says the device is gone for good
          if (e.statusCode === 404 || e.statusCode === 410) { o.push.remove(sub.endpoint); return; }
          o.log.error(`push: ${e.message}`);
        });
      }
    }
    last = next;
  });
}

/** Sends through the device's push service, signed with the fleet's pair. */
export const webPushSender = (vapid: Vapid): Send => (sub, payload, subject) =>
  webpush.sendNotification(
    { endpoint: sub.endpoint, keys: sub.keys },
    JSON.stringify(payload),
    { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 600, urgency: 'high' },
  ).then(() => undefined);
