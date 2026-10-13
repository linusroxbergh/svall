import { execFileSync } from 'node:child_process';
import { runsAgent, type Proc } from '../dormancy.js';

/** Whether `args`, as ps prints them, run Codex's app-server: the shared one a plain `codex` attaches to, or an IDE's.
 *  Only the command counts, never a word of a shell's script. */
export const isCodexServer = (args: string): boolean => /^(\S*\/)?codex\s+app-server(\s|$)/.test(args);

// what runs a TUI's session inside the TUI rather than on the shared server, as codex 0.162.1 decides
const OWN_SERVER = /\s(--no-daemon|-c|--config|-p|--profile|--oss|--dangerously-bypass-hook-trust)(\s|=|$)/;

/** Whether the codex under the pane whose shell is `panePid` runs on a server, where its hooks carry the environment of
 *  whoever started that server: the shared one, or one `--remote` names. */
export function onSharedServer(panePid: number, procs: Proc[]): boolean {
  const below = [panePid];
  for (let i = 0; i < below.length; i++) {
    for (const p of procs) {
      if (p.ppid !== below[i]) continue;
      // the first TUI to start the server is its parent
      if (runsAgent(p.args, 'codex') && !isCodexServer(p.args)) {
        if (/\s--remote(\s|=|$)/.test(p.args)) return true;
        return !OWN_SERVER.test(p.args) && procs.some((s) => isCodexServer(s.args) && /\s--managed-daemon(\s|$)/.test(s.args));
      }
      below.push(p.pid);
    }
  }
  return false;
}

/** Whether `pid` is a Codex app-server or runs under one, as a `claude -p` a session on the server starts does: either
 *  carries the environment of whichever terminal started the server. */
export function underCodexServer(pid: number): boolean {
  for (let p = pid, hops = 0; p > 1 && hops < 32; hops++) {
    let row: RegExpExecArray | null;
    try { row = /^\s*(\d+)\s+(.*)$/.exec(execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(p)], { encoding: 'utf8', timeout: 1000 }).trim()); } catch { return false; }
    if (!row) return false;
    if (isCodexServer(row[2])) return true;
    p = Number(row[1]);
  }
  return false;
}
