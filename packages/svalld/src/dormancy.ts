import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSessionId, type AgentKind, type Character } from '@svall/protocol';
import { running } from './agent/reducer.js';
import { shq } from './text.js';

const exec = promisify(execFile);

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
  // the agent's own binary, or node running Claude Code's script
  const script = kind === 'claude' && path.basename(words[0]) === 'node' && (!!words[1]?.endsWith('/claude-code/cli.js') || path.basename(words[1] ?? '') === 'claude');
  if (path.basename(words[0]) !== kind && !script) return undefined;
  let i = script ? 2 : 1;
  const resume = kind === 'codex' && words[i] === 'resume';
  if (resume) i++;
  const out: string[] = [];
  // ps joins argv with spaces, so a prompt's words can pass for flags and one value can pass for several words: the
  // options end at `--` or the first bare word, past which no word may look like a flag
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') return out;
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
// outside the agent's group is a background shell, monitor or server it still runs
export function runsInBackground(pid: number, procs: Proc[]): boolean {
  const own = procs.find((p) => p.pid === pid)?.pgid;
  const below = [pid];
  for (let i = 0; i < below.length; i++) {
    for (const p of procs) {
      if (p.ppid !== below[i]) continue;
      if (p.pgid !== own) return true;
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
