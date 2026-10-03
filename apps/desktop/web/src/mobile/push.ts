import { PUSH_STATUSES, type PushStatus } from '@svall/protocol';
import type { Api } from '../api.js';
import { decode } from './term.js';

export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'install' }
  | { kind: 'denied' }
  | { kind: 'off'; publicKey: string }
  | { kind: 'on'; endpoint: string; statuses: PushStatus[] };

// the daemon's key comes base64url; PushManager wants the raw point
export const keyBytes = (b64url: string): Uint8Array =>
  decode(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '='));

type Nav = { userAgent: string; standalone?: boolean; maxTouchPoints?: number };
// iOS delivers push only to a page on the Home Screen, and an iPad's Safari names itself a Mac; elsewhere a tab will do
export const needsInstall = (nav: Nav): boolean =>
  (/iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1)) && nav.standalone !== true;

// a subscription made against a different VAPID key signs for nobody; an unreadable key is trusted as none
export function sameApplicationServerKey(current: ArrayBufferLike | null | undefined, publicKey: string): boolean {
  if (!current) return false;
  const want = keyBytes(publicKey);
  const got = new Uint8Array(current);
  return got.length === want.length && got.every((b, i) => b === want[i]);
}

type Sub = { toJSON(): { endpoint?: string; keys?: Record<string, string> } };
export function subscriptionParams(sub: Sub, statuses: PushStatus[]): { endpoint: string; keys: { p256dh: string; auth: string }; statuses: PushStatus[] } {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error('the browser gave an incomplete subscription');
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, statuses };
}

const worker = () => navigator.serviceWorker.ready;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// the key is fetched ahead, so turning push on asks for permission before the tap's activation runs out
const off = async (api: Api): Promise<PushState> => ({ kind: 'off', publicKey: (await api.call('push.key', {})).publicKey });

export async function readPush(api: Api): Promise<PushState> {
  if (!supported()) return needsInstall(navigator as unknown as Nav) ? { kind: 'install' } : { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const sub = await (await worker()).pushManager.getSubscription();
  if (!sub) return off(api);
  const { statuses } = await api.call('push.get', { endpoint: sub.endpoint });
  // the daemon no longer has it (a fresh home): the browser's copy alone tells nobody anything
  return statuses ? { kind: 'on', endpoint: sub.endpoint, statuses } : off(api);
}

/** Runs from a tap only: the permission prompt is refused otherwise. */
export async function enablePush(api: Api, publicKey: string, statuses: PushStatus[] = [...PUSH_STATUSES]): Promise<PushState> {
  const reg = await worker();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameApplicationServerKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  await api.call('push.subscribe', subscriptionParams(sub, statuses));
  return { kind: 'on', endpoint: sub.endpoint, statuses };
}

export async function setPushStatuses(api: Api, statuses: PushStatus[]): Promise<PushState> {
  const sub = await (await worker()).pushManager.getSubscription();
  if (!sub) return off(api);
  await api.call('push.subscribe', subscriptionParams(sub, statuses));
  return { kind: 'on', endpoint: sub.endpoint, statuses };
}

export async function disablePush(api: Api): Promise<PushState> {
  // the key first, so a failed read leaves the subscription as it was rather than gone behind an error
  const next = await off(api);
  const sub = await (await worker()).pushManager.getSubscription();
  if (sub) {
    await api.call('push.unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return next;
}
