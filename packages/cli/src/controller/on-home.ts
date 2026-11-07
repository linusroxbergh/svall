import { resolvePaths, fleetHomeOfSocket } from '@svall/svalld/paths';
import { svallExe } from '@svall/svalld/release';
import { isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import { shq } from '@svall/svalld/text';
import type { MachineRegistry } from './registry.js';
import type { SshMaster } from './ssh.js';

/** The home a fleet dials, and how to reach this fleet there. */
export type FarHome = { name: string; ssh: string; svallBase: string; fleetHome: string; machine?: string };

/** The home this fleet's own worker.json has it dial; none for a fleet that is its home, or that its home dials. */
export function farHomeOf(fleetHome: string): FarHome | undefined {
  const paths = resolvePaths(fleetHome);
  if (!isWorker(paths)) return undefined;
  const w = readWorkerFile(paths);
  if (!w.homeSsh || !w.homeSocket || !w.homeSvallBase) return undefined;
  return { name: w.homeName, ssh: w.homeSsh, svallBase: w.homeSvallBase, fleetHome: fleetHomeOfSocket(w.homeSocket), machine: w.homeMachineId };
}

/** The home that acts on `name` for this fleet: any machine but that home itself and this one, which this machine drives. */
export function relayFor(fleetHome: string, registry: MachineRegistry, name?: string): FarHome | undefined {
  const home = farHomeOf(fleetHome);
  if (!home || name === undefined) return home;
  const id = registry.get(name)?.id;
  return id === home.machine || id === registry.localId ? undefined : home;
}

type Far = Pick<SshMaster, 'stream' | 'close'>;

// what a person does on the machine goes by way of the home, as only the home need reach it
const byHome = (home: string, action: string): string => (action.startsWith('ssh ') ? `ssh ${home}, then ${action}` : action);

function throughHome(line: string, home: string): string {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return line; }
  if (typeof v !== 'object' || v === null) return line;
  const o = v as { step?: unknown; action?: unknown; actions?: unknown };
  if (typeof o.action === 'string' && typeof o.step === 'string') return JSON.stringify({ ...o, action: byHome(home, o.action) });
  if (Array.isArray(o.actions)) return JSON.stringify({ ...o, actions: o.actions.map((a) => (typeof a === 'string' ? byHome(home, a) : a)) });
  return line;
}

/**
 * Runs `svall <args> --relayed` for this fleet on its home, handing on each line it prints as it comes, and answers its exit
 * code. A home that does not answer, or a connection that goes away, ends on a failed step of its own.
 */
export async function relay(home: FarHome, args: string[], o: { open(destination: string): Promise<Far>; line(line: string): void }): Promise<number> {
  const stop = (detail: string, action?: string): number => {
    o.line(JSON.stringify({ step: 'relay', status: 'fail', detail, ...(action && { action }) }));
    o.line(JSON.stringify({ result: 'actions', actions: [action ?? detail], stopped: 'relay' }));
    return 1;
  };
  let master: Far;
  try { master = await o.open(home.ssh); } catch (e) { return stop(`${home.name} did not answer: ${(e as Error).message}`, 'try again once it answers'); }
  try {
    const { stream, exited } = master.stream(['env', shq(`SVALL_HOME=${home.fleetHome}`), shq(svallExe(home.svallBase)), '--json', ...[...args, '--relayed'].map(shq)]);
    let said = false;
    let left = '';
    const take = (line: string) => { if (line.trim()) { said = true; o.line(throughHome(line, home.name)); } };
    for await (const chunk of stream) {
      left += String(chunk);
      const lines = left.split('\n');
      left = lines.pop() ?? '';
      lines.forEach(take);
    }
    take(left);
    const { code, signal, stderr } = await exited;
    if (code === 255 || code === null || signal) return stop(`the connection to ${home.name} went away; what it was doing stopped`, 'try again once it answers');
    if (code === 126 || code === 127) return stop(`${home.name} has no Svall at ${svallExe(home.svallBase)}`, `upgrade ${home.name} under Machines`);
    if (code !== 0 && !said) return stop(`svall ${args.slice(0, 2).join(' ')} there exited ${code}: ${stderr.trim().replace(/^svall: /, '').slice(0, 400) || 'no output'}`);
    return code;
  } finally {
    await master.close().catch(() => undefined);
  }
}
