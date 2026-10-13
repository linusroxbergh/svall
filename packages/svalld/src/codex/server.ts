import { execFileSync } from 'node:child_process';
import { runsAgent, type Proc } from '../dormancy.js';

/** Whether `args`, as ps prints them, run Codex's app-server: the shared one a plain `codex` attaches to, or an IDE's. */
export const isCodexServer = (args: string): boolean => /(^|\/)codex\s+app-server(\s|$)/.test(args);

// what runs a TUI's session inside the TUI rather than on the shared server, as codex 0.162.1 decides
const OWN_SERVER = /\s(--no-daemon|--remote|-c|--config|-p|--profile|--oss|--dangerously-bypass-hook-trust)(\s|=|$)/;

/** Whether the codex under the pane whose shell is `panePid` runs on Codex's shared server, where its hooks carry the
 *  environment of whichever terminal started that server. */
export function onSharedServer(panePid: number, procs: Proc[]): boolean {
  if (!procs.some((p) => isCodexServer(p.args) && /\s--managed-daemon(\s|$)/.test(p.args))) return false;
  const below = [panePid];
  for (let i = 0; i < below.length; i++) {
    for (const p of procs) {
      if (p.ppid !== below[i]) continue;
      // the first TUI to start the server is its parent
      if (runsAgent(p.args, 'codex') && !isCodexServer(p.args)) return !OWN_SERVER.test(p.args);
      below.push(p.pid);
    }
  }
  return false;
}

/** The command line `pid` runs, as ps prints it; undefined once it has exited. */
export function argsOf(pid: number): string | undefined {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim() || undefined; } catch { return undefined; }
}
