import type { LiveProc } from './procs.js';

export type Kill = (pid: number, signal: NodeJS.Signals) => void;

/** Terminates `victims`, then kills those still running after a grace period. */
export async function endProcs(victims: LiveProc[], read: () => Promise<LiveProc[]>, o: { graceMs?: number; kill?: Kill; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  if (!victims.length) return;
  const kill = o.kill ?? ((pid, sig) => { process.kill(pid, sig); });
  const send = (pid: number, sig: NodeJS.Signals): void => { try { kill(pid, sig); } catch { /* already gone */ } };
  for (const v of victims) send(v.pid, 'SIGTERM');
  await (o.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(o.graceMs ?? 3000);
  const now = new Map((await read()).map((p) => [p.pid, p]));
  for (const v of victims) {
    const p = now.get(v.pid);
    // ps rows carry no start time, so a zero start matches any
    if (p && (p.start === 0 || v.start === 0 || p.start === v.start)) send(v.pid, 'SIGKILL');
  }
}
