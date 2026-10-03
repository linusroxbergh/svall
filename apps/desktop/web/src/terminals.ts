import { ApiError, charOfKey } from '@svall/protocol';
import type { Api } from './api.js';
import type { Attach, Bridge, Rect } from './bridge.js';
import { boardViewed, panesOf, type BoardSelection } from './selectors.js';
import type { AppStore, View } from './store/index.js';

export type TerminalManager = {
  show(id: string, rect: Rect, opacity?: number, takeFocus?: boolean): Promise<void>;
  move(id: string, rect: Rect): void;
  hide(id: string): void;
};

type Opts = { reshowDelayMs?: number };

// the map shows the character in the card; the board shows the one it has selected
export const viewedId = (s: BoardSelection & { view: View; card?: string }): string | undefined =>
  s.view === 'map' ? s.card : boardViewed(s);

// a second terminal's surface; the shell treats surface ids as opaque
export { secondKey } from '@svall/protocol';
const target = (key: string): { id: string; term?: 2 } => { const id = charOfKey(key); return id === key ? { id } : { id, term: 2 }; };

export function createTerminalManager(api: Api, bridge: Bridge, store: AppStore, opts: Opts = {}): TerminalManager {
  const attaching = new Map<string, Promise<Attach>>();
  // an attach that failed while svalld was away; retried when it is back
  const retry = new Map<string, { rect: Rect; opacity?: number }>();
  const reshowDelayMs = opts.reshowDelayMs ?? 500;
  const state = () => store.getState();

  const close = (id: string) => {
    if (state().terminals[id]) bridge.send({ type: 'term.close', id });
    state().termGone(id);
    state().termRetry(id);
    lastOpacity.delete(id);
  };
  const focus = (id?: string) => bridge.send({ type: 'term.focus', id });
  const seen = (id: string, term?: 2) => { api.call('char.seen', { id, ...(term ? { term } : {}) }).catch(() => {}); };
  const live = (key: string) => { const { id, term } = target(key); const c = state().fleet.characters[id]; return Boolean(term ? c?.second : c?.tmux); };
  const inView = (key: string) => viewedId(state()) === target(key).id;
  const lastOpacity = new Map<string, number | undefined>();
  // the surfaces a pane is showing now, and whether its latest show takes the keys; one whose pane was hidden or
  // veiled during its attach stays hidden
  const wanted = new Map<string, boolean>();

  async function show(id: string, rect: Rect, opacity?: number, takeFocus = true): Promise<void> {
    wanted.set(id, takeFocus);
    lastOpacity.set(id, opacity);
    const alpha = opacity !== undefined ? { opacity } : {};
    if (state().terminals[id]) {
      bridge.send({ type: 'term.show', id, rect, ...alpha });
      state().termMoved(id, rect);
      if (takeFocus) focus(id);
      return;
    }
    let p = attaching.get(id);
    if (!p) {
      p = api.call('term.attach', target(id)).finally(() => attaching.delete(id));
      attaching.set(id, p);
    }
    let attach: Attach;
    try {
      attach = await p;
    } catch (e) {
      // the window died under the attach: the character is dormant, and Revive answers that better than a tmux error
      if (!live(id)) throw e;
      // svalld refused: the user decides when to try again; svalld away: retried on its own
      if (e instanceof ApiError) state().termFailed(id, e.message); else retry.set(id, { rect, opacity });
      throw e;
    }
    bridge.send({ type: 'term.show', id, rect, ...alpha, attach });
    state().termOpened(id, rect);
    if (!wanted.has(id) || !inView(id)) bridge.send({ type: 'term.hide', id });
    else if (wanted.get(id)) focus(id);
  }

  bridge.onMessage((m) => {
    if (m.type === 'term.exited') {
      const t = state().terminals[m.id];
      state().termGone(m.id);
      // the tmux client died; if the window is still alive (client detached by hand) the terminal comes back
      if (t) setTimeout(() => { if (wanted.has(m.id) && inView(m.id) && live(m.id) && !state().terminals[m.id]) show(m.id, t.rect, lastOpacity.get(m.id), wanted.get(m.id)).catch(() => {}); }, reshowDelayMs);
    }
    if (m.type === 'term.failed') {
      state().termGone(m.id);
      state().termFailed(m.id, m.reason);
    }
    if (m.type === 'term.focused' && state().focusedId !== target(m.id).id) state().focus(target(m.id).id);
  });

  store.subscribe((s, prev) => {
    if (s.status === 'online' && prev.status !== 'online') {
      for (const [id, r] of retry) {
        retry.delete(id);
        if (wanted.has(id) && inView(id) && live(id) && !s.terminals[id]) show(id, r.rect, r.opacity, wanted.get(id)).catch(() => {});
      }
    }
    if (s.fleet !== prev.fleet) {
      for (const key of [...Object.keys(s.terminals), ...Object.keys(s.terminalErrors)]) {
        if (!live(key)) close(key);
      }
    }
    const id = viewedId(s);
    if (!id || !s.active || !s.fleet.characters[id]) return;
    const cameIntoView = id !== viewedId(prev) || !prev.active;
    const now = s.fleet.characters[id];
    const was = prev.fleet.characters[id];
    const turned = (next: boolean, before: boolean | undefined) => s.fleet !== prev.fleet && next && !before;
    if (cameIntoView || turned(now.unread, was?.unread)) seen(id);
    const panes = panesOf(s, id);
    if (panes.left === 'terminal2' || panes.right === 'terminal2') {
      if (cameIntoView || turned(!!now.second?.unread, was?.second?.unread)) seen(id, 2);
    }
  });

  return {
    show,
    move(id, rect) {
      if (!state().terminals[id]) return;
      bridge.send({ type: 'term.move', id, rect });
      state().termMoved(id, rect);
    },
    hide(id) {
      wanted.delete(id);
      if (state().terminals[id]) bridge.send({ type: 'term.hide', id });
    },
  };
}
