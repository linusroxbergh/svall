import type { FleetId, HomeReach, HomeWorker, MachineId, MachineRecord } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { homePoint } from '../failpoints.js';
import { enrolLock } from '../kernel-lock.js';
import { farFleet, FleetMismatch, MachineMismatch } from '../link/connection-info.js';
import { classifyExit, inFull, SshError, SshMaster } from '../link/ssh.js';
import type { Logger } from '../log.js';
import type { MachineEntry } from '../machine.js';
import type { Paths } from '../paths.js';
import { enrollArgv, tokenFor, workerProfile } from '../placement/workers.js';
import { PRIVATE } from '../profile.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { owedWhy, owedWorkers, readMarker, readWorkersOwed, type WorkersOwed } from './home-move.js';

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

const notReached = (e: unknown, ssh: string): HomeReach => {
  const raw = e instanceof SshError ? e.raw : undefined;
  return { ok: false, ssh, kind: farKind(e), why: (e as Error).message, ...(raw && { raw }) };
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

function changeOwed(p: Pick<Paths, 'workersOwed'>, machine: string, entry?: Omit<WorkersOwed['workers'][string], 'tried'>): void {
  const owed = readWorkersOwed(p);
  if (!owed?.workers[machine]) return;
  const { [machine]: _gone, ...rest } = owed.workers;
  const workers = entry ? { ...owed.workers, [machine]: entry } : rest;
  writeDurable(p.workersOwed, { id: owed.id, workers }, { mode: 0o600 });
}

// a check that set a try off reads by this that it ended, however it went
function triedOwed(p: Pick<Paths, 'workersOwed'>, machine: string): void {
  const owed = readWorkersOwed(p);
  const entry = owed?.workers[machine];
  if (!owed || !entry) return;
  writeDurable(p.workersOwed, { id: owed.id, workers: { ...owed.workers, [machine]: { ...entry, tried: Date.now() } } }, { mode: 0o600 });
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

  // a cause goes on the row and in the log once, however often it comes back, what a tool said behind it on the row
  const failed = (machine: string, name: string, entry: Omit<WorkersOwed['workers'][string], 'tried' | 'raw'>, raw?: string): false => {
    const why = owedWhy(entry, name);
    const cause = raw ? `${why}: ${raw}` : why;
    if (said.get(machine) === cause) return false;
    said.set(machine, cause);
    changeOwed(o.paths, machine, { ...entry, ...(raw && { raw }) });
    o.log.error(`${machine} has not joined this home yet: ${cause}`);
    return false;
  };

  async function enrol(machine: MachineId, entry: MachineEntry): Promise<boolean> {
    const ssh = entry.record.ssh!;
    const name = entry.record.name;
    // `opening`: ssh's own failure to reach it, said as this home not reaching it, ssh's words behind
    const notTaken = (e: unknown, opening = false): false => {
      const kind = farKind(e);
      if (STOPS.includes(kind)) refused.add(machine);
      const { message } = e as Error;
      const raw = e instanceof SshError ? e.raw : undefined;
      if (kind === 'auth' || kind === 'host_key') return failed(machine, name, { login: ssh }, raw);
      if (opening) return failed(machine, name, { unreached: /\bwithin \d|did not open a control master/.test(message) ? 'timeout' : 'unreachable' }, raw ?? message);
      return failed(machine, name, { why: message }, raw);
    };
    const profile = workerProfile(o.paths, machine);
    let master: Far;
    try { master = await open(ssh); } catch (e) { return notTaken(e, true); }
    try {
      try {
        await farFleet(master, { svall: svallOn(entry.record, profile), name, ssh, machine, fleetId: String(o.fleetId()), as: 'worker', timeoutMs: PROBE_MS });
      } catch (e) { return notTaken(e); }
      // the token goes under the lock a person's enrol and a forget hold too, so it is the one that stands when it arrives
      const unlock = await enrolLock(o.paths.home);
      if (!unlock) return false;
      try {
        const token = tokenFor(o.paths, machine);
        if (!token) { settleOwed(o.paths, machine); return true; }
        homePoint('rejoin.enrolling');
        const r = await master.run(enrollArgv({ svallBase: entry.record.svallBase, profile: profile === PRIVATE ? undefined : profile, home: o.me, homeName: o.name(), fleetId: String(o.fleetId()), homePlatform: o.platform }), { input: token, timeoutMs: ENROL_MS });
        if (r.code !== 0) {
          const raw = `svall worker enroll exited ${r.code ?? r.signal}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 300) || 'no output'}`;
          return notTaken(new SshError(classifyExit(r, 'other'), `${name} did not take the enrolment`, raw));
        }
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
      if (!entry?.record.ssh) fine = failed(machine, entry?.record.name ?? machine, { why: 'this home has no ssh route to it; svall host add it again with --ssh <its destination>' });
      else fine = await enrol(machine, entry) && fine;
      triedOwed(o.paths, machine);
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
      if (threw !== (e as Error).message) o.log.error(`a worker was not enrolled: ${inFull(e)}`);
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
