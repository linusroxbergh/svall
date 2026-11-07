import { z } from 'zod';
import type { FleetId, HomeReach, HomeWorker, MachineId } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { homePoint } from '../failpoints.js';
import { homeMoveLock } from '../kernel-lock.js';
import { classifyExit, SshError, SshMaster } from '../link/ssh.js';
import type { Logger } from '../log.js';
import type { MachineEntry } from '../machine.js';
import type { Paths } from '../paths.js';
import { enrollArgv, tokenFor, workerProfile } from '../placement/workers.js';
import { PRIVATE } from '../profile.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { owedWorkers, readWorkersOwed } from './home-move.js';

type Far = Pick<SshMaster, 'run' | 'close'>;
const openMaster = (destination: string): Promise<Far> => SshMaster.open({ destination });

const FIRST_MS = 5_000;
const LAST_MS = 5 * 60_000;
const PROBE_MS = 30_000;
const ENROL_MS = 120_000;
// how long a link has to greet with the token just enrolled, before that worker is enrolled again
const GREET_MS = 60_000;

const Version = z.object({ machineId: z.string(), release: z.string(), worker: z.object({ fleetId: z.string() }).optional() });

const farKind = (e: unknown): HomeReach['kind'] => {
  const kind = e instanceof SshError ? e.kind : undefined;
  return kind === 'auth' || kind === 'host_key' || kind === 'unreachable' ? kind : 'other';
};

async function reachOne(w: HomeWorker, o: { fleetId: string; release: string; held: MachineEntry[]; open: (destination: string) => Promise<Far> }): Promise<HomeReach> {
  const ssh = o.held.find((h) => h.id === w.id)?.record.ssh ?? w.record.ssh ?? '';
  const name = w.record.name;
  if (o.held.some((h) => h.id !== w.id && h.record.name === name)) return { ok: false, ssh, kind: 'name', why: `another machine goes by ${name} there` };
  let master: Far;
  try { master = await o.open(ssh); } catch (e) { return { ok: false, ssh, kind: farKind(e), why: (e as Error).message }; }
  try {
    const flags = w.profile && w.profile !== PRIVATE ? ['-p', shq(w.profile)] : [];
    const r = await master.run([shq(svallExe(w.record.svallBase)), ...flags, 'version', '--json'], { timeoutMs: PROBE_MS });
    if (r.code !== 0) {
      const kind = classifyExit(r, 'other');
      return { ok: false, ssh, kind: kind === 'auth' || kind === 'host_key' || kind === 'unreachable' ? kind : 'other', why: `svall version exited ${r.code ?? r.signal}: ${r.stderr.trim().slice(0, 200) || 'no output'}` };
    }
    let v: z.infer<typeof Version>;
    try { v = Version.parse(JSON.parse(r.stdout)); } catch { return { ok: false, ssh, kind: 'other', why: 'svall version --json did not answer what it should' }; }
    if (v.machineId !== w.id) return { ok: false, ssh, kind: 'machine', why: `${ssh} reaches another machine` };
    if (v.worker?.fleetId !== o.fleetId) return { ok: false, ssh, kind: 'fleet', why: `${name} does not serve this fleet` };
    if (v.release !== o.release) return { ok: false, ssh, kind: 'release', why: `it runs ${v.release}, and the fleet ${o.release}` };
    return { ok: true, ssh };
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
 * workers.json holds, until its link greets with it. A refused login is not tried again by itself: a daemon's start or `again` does.
 */
export function startRejoins(o: {
  paths: Paths; me: MachineId; name: () => string; platform: string; fleetId: () => FleetId | string; log: Pick<Logger, 'error' | 'info'>; records: () => MachineEntry[]; refresh: () => void;
  open?: (destination: string) => Promise<Far>; firstMs?: number; lastMs?: number;
}): Rejoins {
  const first = o.firstMs ?? FIRST_MS;
  const last = o.lastMs ?? LAST_MS;
  const open = o.open ?? openMaster;
  const refused = new Set<string>();
  const enrolled = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let ms = first;
  let stopped = false;
  let running = false;

  const failed = (machine: string, why: string): void => {
    changeOwed(o.paths, machine, { why });
    o.log.error(`${machine} has not joined this home yet: ${why}`);
  };

  async function enrol(machine: MachineId, token: string, entry: MachineEntry): Promise<boolean> {
    let master: Far;
    try { master = await open(entry.record.ssh!); } catch (e) {
      if (farKind(e) === 'auth' || farKind(e) === 'host_key') refused.add(machine);
      failed(machine, (e as Error).message);
      return false;
    }
    try {
      homePoint('rejoin.enrolling');
      const r = await master.run(enrollArgv({ svallBase: entry.record.svallBase, profile: profileFlag(o.paths, machine), home: o.me, homeName: o.name(), fleetId: String(o.fleetId()), homePlatform: o.platform }), { input: token, timeoutMs: ENROL_MS });
      if (r.code !== 0) {
        const kind = classifyExit(r, 'other');
        if (kind === 'auth' || kind === 'host_key') refused.add(machine);
        failed(machine, `svall worker enroll exited ${r.code ?? r.signal}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 300) || 'no output'}`);
        return false;
      }
      homePoint('rejoin.enrolled');
      enrolled.set(machine, Date.now());
      changeOwed(o.paths, machine, {});
      o.refresh();
      return true;
    } finally { await master.close().catch(() => undefined); }
  }

  const round = async (): Promise<boolean> => {
    let fine = true;
    for (const machine of Object.keys(owedWorkers(o.paths)) as MachineId[]) {
      if (stopped) break;
      if (refused.has(machine)) continue;
      if (Date.now() - (enrolled.get(machine) ?? -Infinity) < GREET_MS) { fine = false; continue; }
      const entry = o.records().find((r) => r.id === machine);
      const token = tokenFor(o.paths, machine);
      // removed from the fleet since: a person took it back
      if (!token || !entry?.record.ssh) { settleOwed(o.paths, machine); continue; }
      const unlock = await homeMoveLock(o.paths.home);
      if (!unlock) { fine = false; continue; }
      try { fine = await enrol(machine, tokenFor(o.paths, machine) ?? token, entry) && fine; } finally { unlock(); }
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
    try { fine = await round(); } catch (e) { o.log.error(`a worker was not enrolled: ${(e as Error).message}`); }
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

const profileFlag = (p: Paths, machine: string): string | undefined => {
  const held = workerProfile(p, machine);
  return held === PRIVATE ? undefined : held;
};
