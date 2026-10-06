import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DORMANT_AFTER_HOURS, isSessionId, type Agent, type AgentKind, type Character } from '@svall/protocol';
import { running, settle } from './agent/reducer.js';
import type { Logger } from './log.js';
import type { Store } from './store.js';
import { shq } from './text.js';
import type { Tmux } from './tmux/tmux.js';

const exec = promisify(execFile);

// flags are the launch flags to resume with, already quoted
export function reviveCommand(c: Character, flags: string[] = []): string {
  if (!c.agent || !isSessionId(c.agent.sessionId)) return '';
  // a codex character's cwd follows its commands into worktrees; resumed from one, codex would stop to ask which directory
  const words = c.agent.kind === 'codex' ? ['codex', 'resume', '-c', 'tui.resume_cwd=session', ...flags]
    : c.agent.kind === 'opencode' ? ['opencode', ...flags, '-s'] : ['claude', ...flags, '--resume'];
  return [...words, c.agent.sessionId].join(' ');
}

// a resumed session sits at its prompt, and its subagents, background agents and commands died with the process
export const RESUME_NOTE = 'A restart ended this session mid-turn. Subagents, background agents and background commands '
  + 'you had running were stopped and will not report back. Check what they finished, rerun what is still needed, '
  + 'and carry on with the task.';

export function markDormant(c: Character, flags?: string[]): void {
  delete c.tmux;
  delete c.hint;
  c.revive = { command: reviveCommand(c, flags) };
  // nothing runs until the revive, so no question is left open and no turn goes on; a finished result stays
  if (c.agent && (c.agent.status === 'blocked' || c.agent.status === 'working')) {
    if (c.revive.command) c.revive.interrupted = true;
    settle(c.agent, 'idle');
    delete c.agent.asking;
  }
}

// an agent resting this long, since its last turn or the user's last look, with nothing running for it and nothing
// the user has yet to see. A failed turn keeps its error, and one a usage limit stopped carries on once it resets
export function drowsy(c: Character, now: number, afterMs: number, seenAt = 0): boolean {
  const a = c.agent;
  if (!c.tmux || !a || c.unread || a.background || a.prompt || !isSessionId(a.sessionId)) return false;
  return (a.status === 'idle' || a.status === 'done') && now - Math.max(a.lastActivityAt, seenAt) >= afterMs;
}

// the launch flags a resume needs again, and those it reads past: Claude restores its model, agent and permission
// mode itself, bar a bypass; the --add-dir flags come back from the context; a prompt, a worktree to make or a
// session to resume described the start. Any other flag may be one the resume would lose, so it leaves the agent be
const FLAGS: Record<AgentKind, { kept: string[]; keptSwitches: string[]; dropped: string[]; droppedSwitches: string[] }> = {
  claude: {
    kept: ['--effort'],
    keptSwitches: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    dropped: ['-w', '--worktree', '--add-dir', '-r', '--resume', '--model', '--agent', '-n', '--name', '--permission-mode'],
    droppedSwitches: ['-c', '--continue', '--fork-session', '--verbose', '--ide'],
  },
  codex: {
    kept: ['-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--local-provider'],
    keptSwitches: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--oss', '--approve-for-me', '--dangerously-bypass-hook-trust'],
    dropped: ['-c', '--config', '-C', '--cd', '--add-dir'],
    droppedSwitches: [],
  },
  opencode: {
    kept: [],
    keptSwitches: ['--auto'],
    dropped: ['-s', '--session', '--prompt'],
    droppedSwitches: ['-c', '--continue', '--standalone'],
  },
};
// the flags whose value may be left out
const OPTIONAL = ['-w', '--worktree', '-r', '--resume'];
// a value is typed into a shell on revive, so only a plain word is carried
const PLAIN = /^[\w.:@/[\]-]+$/;

/** The flags a resume needs again from `args`, the command line ps prints for the agent's pid, quoted for a shell;
 * undefined when that process is not the agent or its launch can't be repeated. */
export function startFlags(args: string, kind: AgentKind): string[] | undefined {
  const { kept, keptSwitches, dropped, droppedSwitches } = FLAGS[kind];
  const words = args.trim().split(/\s+/);
  if (!runsAgent(args, kind)) return undefined;
  let i = path.basename(words[0]) === 'node' ? 2 : 1;
  const resume = kind === 'codex' && words[i] === 'resume';
  if (resume) i++;
  const out: string[] = [];
  // ps joins argv with spaces, so a prompt's words can pass for flags and one value can pass for several words: the
  // options end at `--` or the first bare word, past which no word may look like a flag
  for (; i < words.length; i++) {
    const w = words[i];
    // svalld puts an OpenCode prompt last, and its words can pass for flags
    if (w === '--' || (kind === 'opencode' && w === '--prompt')) return out;
    // codex resume takes its session as a word among the options
    if (resume && isSessionId(w)) continue;
    if (!w.startsWith('-')) return words.slice(i).some((x) => x.startsWith('-')) ? undefined : out;
    if (keptSwitches.includes(w)) { out.push(w); continue; }
    if (droppedSwitches.includes(w)) continue;
    const eq = w.indexOf('=');
    const flag = eq > 0 ? w.slice(0, eq) : w;
    if (!kept.includes(flag) && !dropped.includes(flag)) return undefined;
    const next = words[i + 1];
    const value = eq > 0 ? w.slice(eq + 1) : next !== undefined && !next.startsWith('-') ? words[++i] : undefined;
    if (value === undefined) {
      if (OPTIONAL.includes(flag)) continue;
      return undefined;
    }
    if (!kept.includes(flag) && !(flag === '--permission-mode' && value === 'bypassPermissions')) continue;
    if (!PLAIN.test(value)) return undefined;
    out.push(flag, shq(value));
  }
  return out;
}

/** Whether `args`, as ps prints them, run the agent: its own binary, or node running Claude Code's script. */
export function runsAgent(args: string, kind: AgentKind): boolean {
  const words = args.trim().split(/\s+/);
  const script = kind === 'claude' && path.basename(words[0]) === 'node' && (!!words[1]?.endsWith('/claude-code/cli.js') || path.basename(words[1] ?? '') === 'claude');
  // npm installs OpenCode's binary as opencode.exe
  const bin = path.basename(words[0]);
  return bin === kind || (kind === 'opencode' && bin === 'opencode.exe') || script;
}

export type Proc = { pid: number; ppid: number; pgid: number; args: string };

/** Every process, as ps lists them; empty when ps fails. */
export async function processes(): Promise<Proc[]> {
  try {
    const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,args='], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] }] : [];
    });
  } catch { return []; }
}

// the Bash tool starts each command in a process group of its own, while MCP servers share the agent's: a descendant
// outside the agent's group is a background shell, monitor or server it still runs. OpenCode's TUI runs its private
// server, which runs the tools, in a group of its own
export function runsInBackground(pid: number, procs: Proc[]): boolean {
  const own = new Set([procs.find((p) => p.pid === pid)?.pgid]);
  const below = [pid];
  for (let i = 0; i < below.length; i++) {
    for (const p of procs) {
      if (p.ppid !== below[i]) continue;
      if (!own.has(p.pgid)) {
        if (below[i] !== pid || !runsAgent(p.args, 'opencode') || !/\sserve\s+--stdio(\s|$)/.test(p.args)) return true;
        own.add(p.pgid);
      }
      below.push(p.pid);
    }
  }
  return false;
}

// a hung-up agent runs its SessionEnd hooks, for at most a minute, before it exits; a resume started meanwhile would
// write to the same session
export async function exited(pid: number, waitMs = 60_000): Promise<void> {
  for (let n = 0; n < waitMs / 100 && running(pid); n++) await new Promise((r) => setTimeout(r, 100));
  if (running(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

/** What dormancy acts on: the fleet, its tmux server, what ps shows, and the windows of agents ended for idleness,
 *  until tmux has closed them and the agent has exited. */
export type Sleep = { store: Store; tmux: Tmux; log: Logger; processes: () => Promise<Proc[]>; ending: Map<string, Promise<void>> };

// an agent idle past the fleet's limit is ended to free what it holds; its character goes dormant, and a revive
// resumes the session with the launch flags it still needs. `seen` is when the user last looked at each character
export async function endIdleAgents(o: Sleep, seen: ReadonlyMap<string, number>, stopped: () => boolean): Promise<void> {
  const hours = o.store.state.dormantAfterHours ?? DORMANT_AFTER_HOURS;
  if (!hours) return;
  const afterMs = hours * 3_600_000;
  const due = (c: Character) => drowsy(c, Date.now(), afterMs, seen.get(c.id));
  const idle = Object.values(o.store.state.characters).filter(due);
  if (!idle.length) return;
  const procs = await o.processes();
  for (const c of idle) {
    // the fleet stopped while ps ran or the last agent exited
    if (stopped()) return;
    const a = c.agent!;
    // a pid gone or moved on to another program, a launch the resume can't repeat, work going on in the background,
    // or no transcript to resume from leaves the agent be
    const proc = procs.find((p) => p.pid === a.pid);
    const flags = proc && startFlags(proc.args, a.kind);
    if (!proc || !flags || runsInBackground(proc.pid, procs) || !a.transcriptPath || !fs.existsSync(a.transcriptPath)) continue;
    // a prompt, a close or a revive while ps ran leaves it be
    const cur = o.store.state.characters[c.id];
    if (!cur?.tmux || cur.tmux.windowId !== c.tmux?.windowId || !due(cur)) continue;
    // dormant before the kill: the SessionEnd the kill sends then finds no live character to clear
    o.store.update((d) => { markDormant(d.characters[c.id], flags); });
    const closing = o.tmux.killWindow(cur.tmux.windowId).then(
      () => exited(proc.pid).then(() => o.log.info(`${cur.name} dormant after ${hours} h idle`)),
      (e) => o.log.error(`dormant ${c.id}: ${String(e)}`),
    );
    o.ending.set(c.id, closing);
    await closing;
    o.ending.delete(c.id);
  }
}

// the quit's own work: every character dormant with the revive that resumes it, then the tmux server gone
export async function endAll(o: Sleep, reviving: ReadonlyMap<string, Promise<unknown>>): Promise<void> {
  // an agent ended for idleness can take a minute to exit, and the server's end reaches it anyway
  const settled = Promise.all([...o.ending.values(), ...reviving.values()].map((p) => p.catch(() => {})));
  await Promise.race([settled, new Promise((r) => setTimeout(r, 2000))]);
  const procs = await o.processes();
  // only a pid still running its agent is waited on, and killed if it outstays the wait
  const agentProc = (a?: Agent) => a && procs.find((p) => p.pid === a.pid && runsAgent(p.args, a.kind));
  const pids: number[] = [];
  // dormant before the kill: the SessionEnd the kill sends then finds no live character to clear
  o.store.update((d) => {
    for (const c of Object.values(d.characters)) {
      const second = agentProc(c.second?.agent);
      if (second) pids.push(second.pid);
      delete c.second;
      if (!c.tmux) continue;
      const proc = agentProc(c.agent);
      if (proc) pids.push(proc.pid);
      markDormant(c, proc ? startFlags(proc.args, c.agent!.kind) : undefined);
    }
  });
  // written now: what the quit has left to do can take seconds, and the daemon may not outlive them
  o.store.flush();
  await o.tmux.killServer();
  // a resume opened right after must not write to a session still ending
  await Promise.all(pids.map((pid) => exited(pid, 5000)));
}
