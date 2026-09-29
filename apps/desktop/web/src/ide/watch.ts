import type { Api } from '../api.js';

export type RepoWatch = {
  /** Starts watching the character's root; the returned function stops this listener's share of it. */
  watch(id: string): () => void;
  on(id: string, fn: () => void): () => void;
  emit(id: string): void;
  /** svalld forgets its viewers with the socket; a new socket says them again, and the listeners look at the disk afresh. */
  resend(): void;
};

export function createRepoWatch(api: Pick<Api, 'fire'>): RepoWatch {
  const counts = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const emit = (id: string) => { for (const fn of listeners.get(id) ?? []) fn(); };
  return {
    watch: (id) => {
      const n = counts.get(id) ?? 0;
      counts.set(id, n + 1);
      if (n === 0) api.fire('repo.watch', { id });
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const left = (counts.get(id) ?? 1) - 1;
        if (left > 0) { counts.set(id, left); return; }
        counts.delete(id);
        api.fire('repo.unwatch', { id });
      };
    },
    on: (id, fn) => {
      let set = listeners.get(id);
      if (!set) { set = new Set(); listeners.set(id, set); }
      set.add(fn);
      return () => { set.delete(fn); };
    },
    emit,
    resend: () => { for (const id of counts.keys()) { api.fire('repo.watch', { id }); emit(id); } },
  };
}
