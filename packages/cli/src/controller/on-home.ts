import crypto from 'node:crypto';
import path from 'node:path';
import { farFleet, FleetMismatch, MachineMismatch } from '@svall/svalld/link/connection-info';
import { SshError } from '@svall/svalld/link/ssh';
import { resolvePaths, fleetHomeOfSocket } from '@svall/svalld/paths';
import { svallExe } from '@svall/svalld/release';
import { isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import { shq } from '@svall/svalld/text';
import { uploadArchive, wantedCompanion } from './install.js';
import type { MachineRegistry } from './registry.js';
import type { SshMaster } from './ssh.js';

/** The home a fleet dials, and how to reach this fleet there. */
export type FarHome = { name: string; ssh: string; svallBase: string; fleetHome: string; machine: string; fleetId: string };

const IDENTITY_MS = 30_000;

/** The home this fleet's own worker.json has it dial; none for a fleet that is its home, or that its home dials, or whose file cannot be read, which what needs it says. */
export function farHomeOf(fleetHome: string): FarHome | undefined {
  const paths = resolvePaths(fleetHome);
  if (!isWorker(paths)) return undefined;
  let w: ReturnType<typeof readWorkerFile>;
  try { w = readWorkerFile(paths); } catch { return undefined; }
  if (!w.homeSsh || !w.homeSocket || !w.homeSvallBase) return undefined;
  return { name: w.homeName, ssh: w.homeSsh, svallBase: w.homeSvallBase, fleetHome: fleetHomeOfSocket(w.homeSocket), machine: w.homeMachineId, fleetId: w.fleetId };
}

/** The home that acts on `name`, a name or a machine's id, for this fleet: any machine but that home itself and this one, which this machine drives. */
export function relayFor(fleetHome: string, registry: MachineRegistry, name?: string): FarHome | undefined {
  const home = farHomeOf(fleetHome);
  if (!home || name === undefined) return home;
  const id = registry.get(name)?.id ?? name;
  return id === home.machine || id === registry.localId ? undefined : home;
}

type Far = Pick<SshMaster, 'run' | 'stream' | 'close'>;

/** What a person does on the machine, from here: by way of the home, as only the home need reach it. */
export const byHome = (home: Pick<FarHome, 'ssh'>, action: string): string => (action.startsWith('ssh ') ? `ssh ${home.ssh}, then ${action}` : action);

function throughHome(line: string, home: FarHome): string {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return line; }
  if (typeof v !== 'object' || v === null) return line;
  const o = v as { step?: unknown; action?: unknown; actions?: unknown };
  if (typeof o.action === 'string' && typeof o.step === 'string') return JSON.stringify({ ...o, action: byHome(home, o.action) });
  if (Array.isArray(o.actions)) return JSON.stringify({ ...o, actions: o.actions.map((a) => (typeof a === 'string' ? byHome(home, a) : a)) });
  return line;
}

/** Where a relay leaves an archive it copied for a far run, which that run removes as it ends. */
export const carriedDir = (fleetHome: string): string => path.posix.join(fleetHome, 'cache', 'carried');

/** What a far command printed as one document, past whatever a login shell said first. */
export function farDocument(text: string): unknown {
  const at = text.search(/^[[{]/m);
  return JSON.parse(at < 0 ? text : text.slice(at));
}

const parsed = (line: string): { step?: unknown; status?: unknown; detail?: unknown } | undefined => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? v : undefined;
  } catch { return undefined; }
};

/**
 * Runs `svall <args> --relayed` for this fleet on its home, once that home has answered as the machine and fleet this fleet's
 * worker.json names, handing on each line it prints as it comes, and answers its exit code. A home that does not answer, a
 * connection that goes away, or a far death with nothing said ends on a failed step of its own. `carried`: the archive this CLI
 * holds for a platform, and its release, which it copies to a home of that release that has none and runs again with.
 */
export async function relay(home: FarHome, args: string[], o: { open(destination: string): Promise<Far>; line(line: string): void; carried?(platform: string): { archive: string; release: string } | undefined }): Promise<number> {
  const stop = (detail: string, action?: string): number => {
    o.line(JSON.stringify({ step: 'relay', status: 'fail', detail, ...(action && { action }) }));
    o.line(JSON.stringify({ result: 'actions', actions: [action ?? detail], stopped: 'relay' }));
    return 1;
  };
  const noSvall = (): number => stop(`${home.name} has no Svall at ${svallExe(home.svallBase)}`, `upgrade ${home.name} under Machines`);
  let master: Far;
  try { master = await o.open(home.ssh); } catch (e) { return stop(`${home.name} did not answer: ${(e as Error).message}`, 'try again once it answers'); }
  try {
    const svall = ['env', shq(`SVALL_HOME=${home.fleetHome}`), shq(svallExe(home.svallBase))];
    let release: string;
    try {
      ({ release } = await farFleet(master, { svall, name: home.name, ssh: home.ssh, machine: home.machine, fleetId: home.fleetId, as: 'home', timeoutMs: IDENTITY_MS }));
    } catch (e) {
      if (e instanceof MachineMismatch || e instanceof FleetMismatch) return stop(e.message, `check where ${home.ssh} leads and which machine holds this fleet, then try again`);
      if (e instanceof SshError && e.kind === 'version') return noSvall();
      return stop(`${home.name} did not answer: ${(e as Error).message}`, 'try again once it answers');
    }
    // the steps a first run ended as they stand, which a run again with the archive repeats
    const ended = new Set<string>();
    const run = async (extra: string[]) => {
      const { stream, exited } = master.stream([...svall, '--json', ...[...args, ...extra, '--relayed'].map(shq)]);
      let said = false;
      let started = false;
      let left = '';
      let wants: { platform: string; archive: string; release: string } | undefined;
      const take = (line: string) => {
        if (wants) return;
        const opens = /^[[{]/.test(line);
        // what a login shell says comes before anything of the command's
        if (!line.trim() || (!started && !opens)) return;
        started = true;
        const v = parsed(line);
        // past a failed step or a document, the run has said how it ended
        if (opens && (!v || typeof v.step !== 'string' || v.status === 'fail')) said = true;
        const platform = v && extra.length === 0 ? wantedCompanion(v) : undefined;
        const held = platform && o.carried?.(platform);
        // a CLI that carries none leaves the home's own refusal, which names --release
        if (held) { wants = { platform: platform!, ...held }; return; }
        if (v && typeof v.step === 'string' && extra.length) {
          if (ended.has(v.step)) return;
        } else if (v && typeof v.step === 'string' && v.status !== 'start') ended.add(v.step);
        o.line(throughHome(line, home));
      };
      // ssh's stdin closing as the far command ends reads as an early close; its exit says how it went
      stream.on('error', () => undefined);
      try {
        for await (const chunk of stream) {
          left += String(chunk);
          const lines = left.split('\n');
          left = lines.pop() ?? '';
          lines.forEach(take);
        }
      } catch { /* its exit says */ }
      take(left);
      return { ...await exited, said, wants };
    };
    let ran = await run([]);
    if (ran.wants) {
      const { platform, ...held } = ran.wants;
      if (held.release !== release) return stop(`${home.name} runs ${release}, and this CLI ${held.release}: the archive it carries for ${platform} is of its own release`, `bring them to one release: upgrade ${home.name} under Machines, or update Svall here`);
      // a name of its own, whole before it is named, so no other relay's copy is touched
      const remote = path.posix.join(carriedDir(home.fleetHome), `${crypto.randomUUID()}-${path.basename(held.archive)}`);
      const part = `${remote}.part`;
      o.line(JSON.stringify({ step: 'relay', status: 'start' }));
      try {
        await uploadArchive(master, { archive: held.archive, remote: part });
        const moved = await master.run(['mv', '--', shq(part), shq(remote)]);
        if (moved.code !== 0) throw new Error(moved.stderr.trim() || `mv exited ${moved.code}`);
      } catch (e) {
        await master.run(['rm', '-f', '--', shq(part)]).catch(() => undefined);
        return stop(`${home.name} did not take the archive this CLI carries for ${platform}: ${(e as Error).message}`, 'try again once it answers');
      }
      o.line(JSON.stringify({ step: 'relay', status: 'ok', detail: `the archive this CLI carries for ${platform} is on ${home.name}` }));
      ran = await run(['--release', remote]);
    }
    const { code, signal, stderr, said } = ran;
    if (code === 255 || code === null || signal) return stop(`the connection to ${home.name} went away; what it was doing may still finish there`, 'try again once it answers');
    if (code === 126 || code === 127) return noSvall();
    if (code !== 0 && !said) return stop(`svall ${args.slice(0, 2).join(' ')} there exited ${code}: ${stderr.trim().replace(/^svall: /, '').slice(-400) || 'no output'}`);
    return code;
  } finally {
    await master.close().catch(() => undefined);
  }
}
