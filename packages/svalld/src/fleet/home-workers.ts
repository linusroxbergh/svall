import type { FleetId, HomeReach, HomeWorker, MachineId, MachineRecord } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { homePoint } from '../failpoints.js';
import { enrolLock } from '../kernel-lock.js';
import { farFleet, FleetMismatch, MachineMismatch } from '../link/connection-info.js';
import { classifyExit, SshError, SshMaster } from '../link/ssh.js';
import type { Logger } from '../log.js';
import type { MachineEntry } from '../machine.js';
import type { Paths } from '../paths.js';
import { enrollArgv, noLoginFix, tokenFor, workerProfile } from '../placement/workers.js';
import { PRIVATE } from '../profile.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { owedWorkers, readMarker, readWorkersOwed } from './home-move.js';

type Far = Pick<SshMaster, 'run' | 'close'>;
const openMaster = (destination: string): Promise<Far> => SshMaster.open({ destination });

const FIRST_MS = 5_000;
const LAST_MS = 5 * 60_000;
const PROBE_MS = 30_000;
const ENROL_MS = 120_000;
// how long a link has to greet with the token just enrolled, before that worker is enrolled again
const GREET_MS = 60_000;

const farKind = (e: unknown): NonNullable<HomeReach['kind']> => {
  if (e instanceof MachineMismatch) return 'machine';
  if (e instanceof FleetMismatch) return 'fleet';
  const kind = e instanceof SshError ? e.kind : undefined;
  return kind === 'auth' || kind === 'host_key' || kind === 'unreachable' ? kind : 'other';
};

// what ssh said of a refused login, past its "could not reach" and its advice of a terminal here, which the fix replaces
const loginSaid = (why: string): string => why.replace(/^ssh could not reach \S+: /, '').replace(/; run ssh \S+ once in a terminal, then try again$/, '').replace(/\.$/, '');

const notReached = (e: unknown, ssh: string): HomeReach => {
  const kind = farKind(e);
  const why = (e as Error).message;
  return { ok: false, ssh, kind, why: kind === 'auth' || kind === 'host_key' ? loginSaid(why) : why };
};

// what asks a person, and is not tried again by itself
const STOPS = ['auth', 'host_key', 'machine', 'fleet'];

const svallOn = (record: MachineRecord, profile?: string): string[] => [shq(svallExe(record.svallBase)), ...(profile && profile !== PRIVATE ? ['-p', shq(profile)] : [])];

async function reachOne(w: HomeWorker, o: { fleetId: string; release: string; held: MachineEntry[]; open: (destination: string) => Promise<Far> }): Promise<HomeReach> {
  const record = o.held.find((h) => h.id === w.id)?.record ?? w.record;
  const ssh = record.ssh ?? '';
  const name = w.record.name;
  if (o.held.some((h) => h.id !== w.id && h.record.name === name)) return { ok: false, ssh, kind: 'name', why: `another machine goes by ${name} there` };
  if (!ssh) return { ok: false, ssh, kind: 'other', why: `there is no ssh route to ${name} there` };
  let master: Far;
  try { master = await o.open(ssh); } catch (e) { return notReached(e, ssh); }
  try {
    const v = await farFleet(master, { svall: svallOn(record, w.profile), name, ssh, machine: w.id, fleetId: o.fleetId, as: 'worker', timeoutMs: PROBE_MS });
    if (v.release !== o.release) return { ok: false, ssh, kind: 'release', why: `it runs ${v.release}, and the fleet ${o.release}` };
    return { ok: true, ssh };
  } catch (e) {
    return notReached(e, ssh);
  } finally { await master.close().catch(() => undefined); }
}

/** What this machine finds of each worker over its own ssh: what its daemon, which would dial them, can and cannot do. */
export async function reachWorkers(workers: HomeWorker[], o: { fleetId: string; release: string; held: MachineEntry[]; open?: (destination: string) => Promise<Far> }): Promise<Record<string, HomeReach>> {
  const answers = await Promise.all(workers.map(async (w) => [w.id, await reachOne(w, { ...o, open: o.open ?? openMaster })] as const));
  return Object.fromEntries(answers);
}

/** The workers a move owes an enrolment, for its install to carry in. */
export const writeOwed = (p: Pick<Paths, 'workersOwed'>, id: string, workers: string[]): void => writeDurable(p.workersOwed, { id, workers: Object.fromEntries(workers.map((w) => [w, {}])) }, { mode: 0o600 });

function changeOwed(p: Pick<Paths, 'workersOwed'>, machine: string, entry?: { why?: string }): void {
  const owed = readWorkersOwed(p);
  if (!owed?.workers[machine]) return;
  const { [machine]: _gone, ...rest } = owed.workers;
  const workers = entry ? { ...owed.workers, [machine]: entry } : rest;
  writeDurable(p.workersOwed, { id: owed.id, workers }, { mode: 0o600 });
}

/** The worker greeted this home, and so took the token it holds: only this ends what the home owes it. */
export function settleOwed(p: Pick<Paths, 'workersOwed'>, machine: string): void {
  if (!readWorkersOwed(p)?.workers[machine]) return;
  changeOwed(p, machine);
  homePoint('rejoin.done');
}

export type Rejoins = { stop(): void; again(): void };

/**
 * Enrols each worker a move left this home owing, once the move stands, over this machine's own ssh and with the token
 * workers.json holds, until its link greets with it. Anything but the machine and fleet it was gets no token. A refused login,
 * or one of those, is not tried again by itself: a daemon's start or `again` does. A home on its way out enrols no one.
 */
export function startRejoins(o: {
  paths: Paths; me: MachineId; name: () => string; platform: string; fleetId: () => FleetId | string; log: Pick<Logger, 'error' | 'info'>; records: () => MachineEntry[]; refresh: () => void;
  frozen: () => boolean; open?: (destination: string) => Promise<Far>; firstMs?: number; lastMs?: number;
}): Rejoins {
  const first = o.firstMs ?? FIRST_MS;
  const last = o.lastMs ?? LAST_MS;
  const open = o.open ?? openMaster;
  const refused = new Set<string>();
  const enrolled = new Map<string, number>();
  const said = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let ms = first;
  let stopped = false;
  let running = false;
  let threw: string | undefined;

  // a cause goes on the row and in the log once, however often it comes back
  const failed = (machine: string, why: string): false => {
    if (said.get(machine) === why) return false;
    said.set(machine, why);
    changeOwed(o.paths, machine, { why });
    o.log.error(`${machine} has not joined this home yet: ${why}`);
    return false;
  };

  const notTaken = (machine: string, kind: string, why: string, ssh: string): false => {
    if (STOPS.includes(kind)) refused.add(machine);
    return failed(machine, kind === 'auth' || kind === 'host_key' ? `${loginSaid(why)}; ${noLoginFix(o.name(), ssh)}` : why);
  };

  async function enrol(machine: MachineId, entry: MachineEntry): Promise<boolean> {
    const ssh = entry.record.ssh!;
    const profile = workerProfile(o.paths, machine);
    let master: Far;
    try { master = await open(ssh); } catch (e) { return notTaken(machine, farKind(e), (e as Error).message, ssh); }
    try {
      try {
        await farFleet(master, { svall: svallOn(entry.record, profile), name: entry.record.name, ssh, machine, fleetId: String(o.fleetId()), as: 'worker', timeoutMs: PROBE_MS });
      } catch (e) { return notTaken(machine, farKind(e), (e as Error).message, ssh); }
      // the token goes under the lock a person's enrol and a forget hold too, so it is the one that stands when it arrives
      const unlock = await enrolLock(o.paths.home);
      if (!unlock) return false;
      try {
        const token = tokenFor(o.paths, machine);
        if (!token) { settleOwed(o.paths, machine); return true; }
        homePoint('rejoin.enrolling');
        const r = await master.run(enrollArgv({ svallBase: entry.record.svallBase, profile: profile === PRIVATE ? undefined : profile, home: o.me, homeName: o.name(), fleetId: String(o.fleetId()), homePlatform: o.platform }), { input: token, timeoutMs: ENROL_MS });
        if (r.code !== 0) return notTaken(machine, classifyExit(r, 'other'), `svall worker enroll exited ${r.code ?? r.signal}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 300) || 'no output'}`, ssh);
      } finally { unlock(); }
      homePoint('rejoin.enrolled');
      enrolled.set(machine, Date.now());
      said.delete(machine);
      changeOwed(o.paths, machine, {});
      o.refresh();
      return true;
    } finally { await master.close().catch(() => undefined); }
  }

  const round = async (): Promise<boolean> => {
    let fine = true;
    for (const machine of Object.keys(owedWorkers(o.paths)) as MachineId[]) {
      if (stopped || o.frozen() || readMarker(o.paths)) break;
      // only a person's remove takes a token back
      if (!tokenFor(o.paths, machine)) { settleOwed(o.paths, machine); continue; }
      if (refused.has(machine)) continue;
      if (Date.now() - (enrolled.get(machine) ?? -Infinity) < GREET_MS) { fine = false; continue; }
      const entry = o.records().find((r) => r.id === machine);
      if (!entry?.record.ssh) { fine = failed(machine, 'this home has no ssh route to it; svall host add it again with --ssh <its destination>'); continue; }
      fine = await enrol(machine, entry) && fine;
    }
    return fine;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    running = true;
    let fine = false;
    try {
      fine = await round();
      threw = undefined;
    } catch (e) {
      // once per cause, as a failed enrol is
      if (threw !== (e as Error).message) o.log.error(`a worker was not enrolled: ${(e as Error).message}`);
      threw = (e as Error).message;
    }
    running = false;
    ms = fine ? first : Math.min(ms * 2, last);
    schedule();
  };

  schedule();
  return {
    stop: () => { stopped = true; clearTimeout(timer); },
    again: () => {
      refused.clear();
      enrolled.clear();
      ms = first;
      if (stopped || running) return;
      clearTimeout(timer);
      schedule();
    },
  };
}
