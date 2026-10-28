import { sameStart, type LiveProc } from './procs.js';

export type Kill = (pid: number, signal: NodeJS.Signals) => void;

/** Terminates `victims`, then kills those still running after a grace period. */
export async function endProcs(victims: LiveProc[], read: () => Promise<LiveProc[]>, o: { graceMs?: number; kill?: Kill; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  if (!victims.length) return;
  const kill = o.kill ?? ((pid, sig) => { process.kill(pid, sig); });
  const send = (pid: number, sig: NodeJS.Signals): boolean => { try { kill(pid, sig); return true; } catch { return false; } };
  const termed = victims.filter((v) => send(v.pid, 'SIGTERM'));
  if (!termed.length) return;
  await (o.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(o.graceMs ?? 3000);
  const now = new Map((await read()).map((p) => [p.pid, p]));
  for (const v of victims) {
    const p = now.get(v.pid);
    if (p && sameStart(p, v)) send(v.pid, 'SIGKILL');
  }
}
