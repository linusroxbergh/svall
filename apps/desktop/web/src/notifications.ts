import { PUSH_STATUSES, type AgentStatus, type FleetState, type PushStatus } from '@svall/protocol';
import type { Api } from './api.js';
import type { Bridge, NotifyPermission, ToShell } from './bridge.js';
import type { NotifySettings } from './settings.js';
import type { App, AppStore } from './store/index.js';
import { charOfSurface, secondKey, viewedId } from './terminals.js';

// what a banner says; its key is the session's terminal surface key
export type Notice = Omit<Extract<ToShell, { type: 'notify.post' }>, 'type'>;
export type NoticeView = { fleet: FleetState; loaded: boolean; active: boolean; viewed?: string; settings: NotifySettings; permission: NotifyPermission };
// the status each banner still up announced, by session key
export type Posted = Map<string, PushStatus>;

type Session = { key: string; charId: string; second: boolean; status?: AgentStatus; unread: boolean; prompt?: string; promptId?: string };

const isPushStatus = (s: AgentStatus | undefined): s is PushStatus => (PUSH_STATUSES as readonly string[]).includes(s ?? '');

// how long an answer waits for the daemon to come back online before giving up
const ANSWER_WAIT_MS = 5000;

// a character's main terminal, and its second one when that runs an agent, as the pusher counts them
const sessionsOf = (f: FleetState): Map<string, Session> =>
  new Map(Object.values(f.characters).flatMap((c): [string, Session][] => [
    [c.id, { key: c.id, charId: c.id, second: false, status: c.agent?.status, unread: c.unread, prompt: c.agent?.prompt, promptId: c.agent?.promptId }],
    ...(c.second ? [[secondKey(c.id), { key: secondKey(c.id), charId: c.id, second: true, status: c.second.agent?.status, unread: c.second.unread, prompt: c.second.agent?.prompt, promptId: c.second.agent?.promptId }] as [string, Session]] : []),
  ]));

function noticeFor(v: NoticeView, s: Session, status: PushStatus): Notice {
  const c = v.fleet.characters[s.charId]!;
  const blocked = status === 'blocked';
  // an answer reaches the main terminal only, as on the phone, and names the question the banner showed
  const actions = blocked && !s.second;
  return {
    key: s.key,
    title: blocked ? `${c.name} needs you` : `${c.name} is done`,
    subtitle: v.fleet.islands[c.islandId]?.name ?? '',
    // a blocked agent's question, or the API error that ended a turn
    body: s.prompt ?? '',
    sound: v.settings.sound,
    actions,
    ...(actions && s.promptId ? { promptId: s.promptId } : {}),
  };
}

/** Which banners go up and which come down between two looks at the page. The first snapshot posts nothing. */
export function decide(prev: NoticeView, next: NoticeView, posted: Posted): { post: Notice[]; remove: string[]; posted: Posted } {
  const live = next.settings.on && next.permission === 'granted';
  const now = sessionsOf(next.fleet);
  const inView = (charId: string) => next.active && next.viewed === charId;
  const out: Posted = new Map(posted);
  const remove: string[] = [];
  for (const [key, status] of posted) {
    const s = now.get(key);
    if (live && s && s.status === status && next.settings.statuses.includes(status) && (status === 'blocked' || s.unread) && !inView(s.charId)) continue;
    remove.push(key);
    out.delete(key);
  }
  const post: Notice[] = [];
  if (!live || !prev.loaded) return { post, remove, posted: out };
  const before = sessionsOf(prev.fleet);
  for (const s of now.values()) {
    const status = s.status;
    const was = before.get(s.key);
    // a new question while the agent stays blocked replaces the banner
    if (!isPushStatus(status) || (status === was?.status && s.promptId === was?.promptId) || !next.settings.statuses.includes(status)) continue;
    if (inView(s.charId) || (status === 'done' && !s.unread)) continue;
    post.push(noticeFor(next, s, status));
    out.set(s.key, status);
  }
  return { post, remove, posted: out };
}

export const answerFailed = (name: string, key: string, sound: boolean): Notice =>
  ({ key, title: `${name}: answer didn't send`, subtitle: '', body: '', sound, actions: false });

const viewOf = (s: App): NoticeView =>
  ({ fleet: s.fleet, loaded: s.loaded, active: s.active, viewed: viewedId(s), settings: s.settings.notifications, permission: s.notifyPermission });
// the store changes on every terminal move; only these can change a decision
const same = (a: App, b: App): boolean =>
  a.fleet === b.fleet && a.loaded === b.loaded && a.active === b.active && viewedId(a) === viewedId(b)
  && a.settings.notifications === b.settings.notifications && a.notifyPermission === b.notifyPermission;

/** Posts and takes down the fleet's banners as the page changes, and acts on the shell's clicks and answers. */
export function followNotifications(o: { store: AppStore; bridge: Bridge; api(): Api | undefined }): () => void {
  let posted: Posted = new Map();
  const offStore = o.store.subscribe((s, prev) => {
    if (same(s, prev)) return;
    const d = decide(viewOf(prev), viewOf(s), posted);
    posted = d.posted;
    for (const key of d.remove) o.bridge.send({ type: 'notify.remove', key });
    for (const n of d.post) o.bridge.send({ type: 'notify.post', ...n });
  });
  // waits for the daemon to be reachable, up to ANSWER_WAIT_MS; a reachable daemon resolves at once
  const waitOnline = (): Promise<Api | undefined> => {
    const ready = () => (o.store.getState().status === 'online' ? o.api() : undefined);
    const api = ready();
    if (api) return Promise.resolve(api);
    return new Promise((resolve) => {
      const off = o.store.subscribe(() => {
        const api = ready();
        if (!api) return;
        clearTimeout(timer);
        off();
        resolve(api);
      });
      const timer = setTimeout(() => { off(); resolve(undefined); }, ANSWER_WAIT_MS);
    });
  };
  // only a main terminal's banner has buttons, so the key is the character's id
  const answer = async (key: string, action: 'approve' | 'deny', promptId?: string) => {
    const c = o.store.getState().fleet.characters[key];
    if (!c) return;
    try {
      const api = await waitOnline();
      if (!api) throw new Error('svalld not connected');
      await api.call('char.answer', { id: key, answer: action, promptId });
    } catch {
      // a newer question's banner is up under the same key, and stays
      const now = o.store.getState().fleet.characters[key]?.agent;
      if (now?.status === 'blocked' && now.promptId !== promptId) return;
      o.bridge.send({ type: 'notify.post', ...answerFailed(c.name, key, o.store.getState().settings.notifications.sound) });
    }
  };
  // on, but macOS has not been asked under this app id: ask once, as every answer comes back as notify.permission
  let permissionAsked = false;
  const offShell = o.bridge.onMessage((m) => {
    if (m.type === 'notify.permission') {
      o.store.getState().setNotifyPermission(m.state);
      if (m.state === 'unknown' && o.store.getState().settings.notifications.on && !permissionAsked) {
        permissionAsked = true;
        o.bridge.send({ type: 'notify.enable' });
      }
    } else if (m.type === 'notify.open') {
      const id = charOfSurface(m.key);
      if (o.store.getState().fleet.characters[id]) o.store.getState().focus(id);
    } else if (m.type === 'notify.action') void answer(m.key, m.action, m.promptId || undefined);
  });
  return () => { offStore(); offShell(); };
}
