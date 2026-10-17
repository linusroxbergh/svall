import { isCodexServer } from '../codex/server.js';
import type { LiveProc } from './procs.js';

/** `panes`: character id → its windows' pane pids, every character in the state included; `own`: svalld's pid and the fleet tmux server's. */
export type Scope = { home: string; panes: Map<string, number[]>; appPid?: number; own: number[] };
export type Owners = { chars: Map<string, LiveProc[]>; app: LiveProc[]; codex: LiveProc[] };

export function attribute(procs: LiveProc[], scope: Scope): Owners {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, LiveProc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);

  const claimed = new Set<number>();
  // claims `root` and what runs under it, leaving out subtrees already owned
  const claim = (root: LiveProc | undefined, into: LiveProc[]): void => {
    if (!root || claimed.has(root.pid)) return;
    const stack = [root];
    for (let p = stack.pop(); p; p = stack.pop()) {
      if (claimed.has(p.pid)) continue;
      claimed.add(p.pid);
      into.push(p);
      stack.push(...(children.get(p.pid) ?? []));
    }
  };

  const owners: Owners = { chars: new Map([...scope.panes.keys()].map((c) => [c, []])), app: [], codex: [] };

  for (const p of procs) if (isCodexServer(p.args)) claim(p, owners.codex);

  for (const [char, panePids] of scope.panes) for (const pid of panePids) claim(byPid.get(pid), owners.chars.get(char)!);

  const inApp = (p: LiveProc): boolean => {
    const seen = new Set<number>();
    for (let q: LiveProc | undefined = p; q && q.pid > 1 && !seen.has(q.pid); q = byPid.get(q.ppid)) {
      if (q.path.includes('.app/')) return true;
      seen.add(q.pid);
    }
    return false;
  };
  for (const p of procs) {
    if (claimed.has(p.pid) || p.home !== scope.home || !p.char) continue;
    const mine = owners.chars.get(p.char);
    if (!mine || inApp(p)) continue;
    claimed.add(p.pid);
    mine.push(p);
  }

  claim(scope.appPid === undefined ? undefined : byPid.get(scope.appPid), owners.app);
  for (const p of procs) if (p.resp !== undefined && p.resp === scope.appPid && !claimed.has(p.pid)) { claimed.add(p.pid); owners.app.push(p); }
  for (const pid of scope.own) claim(byPid.get(pid), owners.app);

  return owners;
}
