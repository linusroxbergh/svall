import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from '@svall/protocol';
import { HOOK_GUARD } from '../paths.js';
import { isShellCommand } from '../tmux/tmux.js';

const exec = promisify(execFile);

/** One process as `ps` printed it. */
export type Proc = { pid: number; ppid: number; pgid: number; tpgid: number; stat: string; args: string };

/** The agent holding a terminal, and the tool commands it runs off that terminal. */
export type AgentProcess = { kind: AgentKind; pid: number; commands: Proc[] };

/** What holds a pane's terminal: the foreground process group, its processes, and the agent among them. */
export type PaneProcesses = { group: number; foreground: Proc[]; agent?: AgentProcess };

// the same columns on macOS and procps; args goes last because it is the one with spaces in it
const PS_ARGV = ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,args='];
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)(?:\s+(.*))?$/;

/** Reads `ps -o pid=,ppid=,pgid=,tpgid=,stat=,args=` as macOS and procps print it, skipping any line that is not a row. */
export function parsePs(stdout: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = ROW.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), stat: m[5], args: (m[6] ?? '').trim() });
  }
  return rows;
}

const AGENTS = new Set<string>(['claude', 'codex']);
const zombie = (p: Proc): boolean => p.stat.startsWith('Z');
const launcher = (p: Proc): boolean => path.basename(p.args.split(' ')[0]) === 'node';

// what a process runs: argv[0] without a login shell's dash, or the script a node launcher runs
function program(p: Proc): string {
  const [bin, script] = p.args.split(' ');
  const name = path.basename(bin).replace(/^-/, '');
  return name === 'node' && script ? path.basename(script).replace(/\.[cm]?js$/, '') : name;
}

/**
 * A snapshot of this machine's processes, read one tmux pane at a time. `scripts` are the hook and
 * statusline scripts setup installed, whose processes run beside an agent rather than as its work.
 */
export class ProcessTable {
  private byPid = new Map<number, Proc>();
  private children = new Map<number, Proc[]>();

  constructor(rows: Proc[], private scripts: readonly string[] = []) {
    for (const p of rows) {
      this.byPid.set(p.pid, p);
      const siblings = this.children.get(p.ppid) ?? [];
      siblings.push(p);
      this.children.set(p.ppid, siblings);
    }
  }

  static async read(o: { signal?: AbortSignal; scripts?: readonly string[] } = {}): Promise<ProcessTable> {
    const { stdout } = await exec('ps', PS_ARGV, { maxBuffer: 64 * 1024 * 1024, signal: o.signal });
    return new ProcessTable(parsePs(stdout), o.scripts);
  }

  /** Whether any process of the group is still running. */
  alive(group: number): boolean {
    for (const p of this.byPid.values()) if (p.pgid === group && !zombie(p)) return true;
    return false;
  }

  /** The terminal of the pane whose process tmux started as `panePid`; undefined once that process is gone. */
  pane(panePid: number): PaneProcesses | undefined {
    const root = this.byPid.get(panePid);
    if (!root || zombie(root)) return undefined;
    const group = root.tpgid;
    // a shell holding its own terminal is at its prompt; anything else holding it is a job
    const holds = (p: Proc) => p.pgid === group && !zombie(p) && !(p === root && isShellCommand(program(p)));
    const foreground = [root, ...this.descendants(panePid)].filter(holds);
    const agent = this.agent(foreground.find((p) => p.pid === group));
    return { group, foreground, ...(agent && { agent }) };
  }

  // the job's leader when it is claude or codex; behind a node launcher such as npm's, the same program it started
  private agent(leader: Proc | undefined): AgentProcess | undefined {
    const kind = leader ? program(leader) : '';
    if (!leader || !AGENTS.has(kind)) return undefined;
    const group = leader.pgid;
    // a node-run `claude mcp serve` beside a node-run Claude is one of its MCP servers
    const inner = launcher(leader)
      ? (this.children.get(leader.pid) ?? []).find((c) => c.pgid === group && !zombie(c) && !launcher(c) && program(c) === kind)
      : undefined;
    const agent = inner ?? leader;
    // a tool command leaves the terminal; an MCP server in a group of its own stays on it
    const commands = (this.children.get(agent.pid) ?? []).filter((c) => c.tpgid !== group && !zombie(c) && !this.installed(c));
    return { kind: kind as AgentKind, pid: agent.pid, commands };
  }

  // exactly what setup installed: a shell running the guarded hook command, or a process running one of its scripts
  private installed(p: Proc): boolean {
    const [bin, arg] = p.args.split(' ');
    if (arg === '-c') return isShellCommand(path.basename(bin)) && p.args.slice(bin.length + 4).startsWith(HOOK_GUARD);
    return this.scripts.includes(arg);
  }

  /** These processes and every live one under them, whatever group or session each went to. */
  tree(roots: Proc[]): Proc[] {
    const found = new Map<number, Proc>();
    for (const queue = [...roots]; queue.length;) {
      const p = queue.shift()!;
      if (found.has(p.pid) || zombie(p)) continue;
      found.set(p.pid, p);
      queue.push(...(this.children.get(p.pid) ?? []));
    }
    return [...found.values()];
  }

  private descendants(pid: number): Proc[] {
    const out: Proc[] = [];
    for (let queue = [pid]; queue.length;) {
      for (const child of this.children.get(queue.shift()!) ?? []) { out.push(child); queue.push(child.pid); }
    }
    return out;
  }
}

/** Signals a whole foreground job. A group of 1 or less would reach init, this daemon's own group or every process. */
export function killGroup(group: number, signal: NodeJS.Signals): void {
  if (group <= 1) throw new Error(`refusing to signal process group ${group}`);
  try {
    process.kill(-group, signal);
  } catch (e) {
    // a job gone already is at rest; one this user may not signal, such as sudo's, stays and is reported as not at rest
    if (!['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  }
}
