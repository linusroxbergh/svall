import webpush from 'web-push';
import { isNews, isPushStatus, sessionsOf, type MachineId, type PushStatus, type Robot } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import type { PushStore, Subscription } from './store.js';
import type { Vapid } from './vapid.js';

// term 2 marks the robot's second session, which the phone cannot answer, so its notification carries no buttons.
// promptId goes back with the answer, so a late one does not answer a newer question; machine names the worker that sent it
export type PushPayload = { id: string; name: string; status: PushStatus; term?: 2; prompt?: string; promptId?: string; machine?: MachineId };
// subject is who the push service may contact about the sender
export type Send = (sub: Subscription, payload: PushPayload, subject: string) => Promise<void>;

/**
 * Tells every device of an accepted login when an agent of a robot it `owns` turns blocked or done, while the phone link is
 * served; a robot it would not have owned as it was before, as one that arrived by a move, tells nothing of the state it
 * came in. `machine`, on a worker, goes in each push. The returned function stops it.
 */
export function startPusher(o: {
  store: Store; push: Pick<PushStore, 'list' | 'remove'>; send: Send; log: Logger; logins: () => string[]; served: () => string | undefined; contact?: () => string | undefined;
  owns?: (c: Robot) => boolean; machine?: MachineId;
}): () => void {
  const owns = (c: Robot): boolean => o.owns?.(c) ?? true;
  // ownership is judged now, of the robot as it is and as it was, so ownership that turns with no change to the store moves nothing
  let before = o.store.state;
  let last = sessionsOf(before);
  return o.store.subscribe(() => {
    const f = o.store.state;
    const next = sessionsOf(f);
    const url = o.served();
    for (const [key, { robotId, term, agent }] of next) {
      const status = agent?.status;
      const c = f.robots[robotId];
      const was = Object.hasOwn(before.robots, robotId) ? before.robots[robotId] : undefined;
      if (url === undefined || !isPushStatus(status) || !isNews(last.get(key)?.agent, agent) || !owns(c) || (was && !owns(was))) continue;
      const payload: PushPayload = {
        id: robotId, name: c.name, status, ...(term ? { term } : {}), ...(agent?.prompt ? { prompt: agent.prompt } : {}), ...(agent?.promptId ? { promptId: agent.promptId } : {}),
        ...(o.machine && { machine: o.machine }),
      };
      for (const sub of o.push.list()) {
        if (!sub.statuses.includes(status) || !o.logins().includes(sub.login)) continue;
        o.send(sub, payload, o.contact?.() ?? url).catch((e: Error & { statusCode?: number }) => {
          // the push service says the device is gone for good
          if (e.statusCode === 404 || e.statusCode === 410) { o.push.remove(sub.endpoint); return; }
          o.log.error(`push: ${e.message}`);
        });
      }
    }
    before = f;
    last = next;
  });
}

export const webPushSender = (vapid: Vapid): Send => (sub, payload, subject) =>
  webpush.sendNotification(
    { endpoint: sub.endpoint, keys: sub.keys },
    JSON.stringify(payload),
    { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 600, urgency: 'high' },
  ).then(() => undefined);
