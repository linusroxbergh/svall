import { isCodexServer } from '../codex/server.js';
import type { LiveProc } from './procs.js';

/** `panes`: robot id → its windows' pane pids, every robot in the state included; `own`: svalld's pid and the fleet tmux server's. */
export type Scope = { home: string; panes: Map<string, number[]>; appPid?: number; own: number[] };
export type Owners = { robots: Map<string, LiveProc[]>; app: LiveProc[]; codex: LiveProc[] };

/** Whether `path` lies in an app bundle; an app a framework bundles, as Python.framework's Python.app, is none. */
const isApp = (path: string): boolean => {
  const app = path.indexOf('.app/');
  return app >= 0 && !path.slice(0, app).includes('.framework/');
};

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

  const owners: Owners = { robots: new Map([...scope.panes.keys()].map((c) => [c, []])), app: [], codex: [] };

  for (const p of procs) if (isCodexServer(p.args)) claim(p, owners.codex);

  for (const [robot, panePids] of scope.panes) for (const pid of panePids) claim(byPid.get(pid), owners.robots.get(robot)!);

  // what svalld, its tmux server or the app runs is theirs, and what runs in an app the user's, whatever marks it carries
  const theirs = new Set([...scope.own, ...(scope.appPid === undefined ? [] : [scope.appPid])]);
  const marksCount = (p: LiveProc): boolean => {
    const seen = new Set<number>();
    for (let q: LiveProc | undefined = p; q && q.pid > 1 && !seen.has(q.pid); q = byPid.get(q.ppid)) {
      if (theirs.has(q.pid) || isApp(q.path)) return false;
      seen.add(q.pid);
    }
    return true;
  };
  // a session on codex's shared server starts what it runs with the marks of the robot that started the server
  const codexMarks = new Set(procs.filter((p) => isCodexServer(p.args) && p.robot).map((p) => `${p.robot}\n${p.home}`));
  for (const p of procs) {
    if (claimed.has(p.pid) || p.home !== scope.home || !p.robot || codexMarks.has(`${p.robot}\n${p.home}`)) continue;
    const mine = owners.robots.get(p.robot);
    if (!mine || !marksCount(p)) continue;
    claimed.add(p.pid);
    mine.push(p);
  }

  claim(scope.appPid === undefined ? undefined : byPid.get(scope.appPid), owners.app);
  for (const p of procs) if (p.resp !== undefined && p.resp === scope.appPid && !claimed.has(p.pid)) { claimed.add(p.pid); owners.app.push(p); }
  for (const pid of scope.own) claim(byPid.get(pid), owners.app);

  return owners;
}
