import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gb, Limits, LIMITS_WHY, type LimitsReport, type MachineSize } from '@svall/protocol';
import { peekConfig, saveLimits } from '../config.js';
import { writeDurable } from '../durable.js';
import { Invalid } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { tryLock } from '../kernel-lock.js';
import { resolvePaths } from '../paths.js';
import { readOrUndefined } from '../settings-file.js';
import { daemonReload, unitCgroup, type Run } from './service.js';
import { svalldUnitName, unitLimits } from './setup.js';

const MIB = 1024 * 1024;
// the least memory limit there is, and the least a machine keeps for itself beside it
const LEAST_MB = 512;
const KEEP_MB = 256;

const machineSize = (): MachineSize => ({ cores: os.availableParallelism(), memoryMb: Math.floor(os.totalmem() / MIB) });

/** All but one core and 1 GiB, never under half of a small machine's memory nor 512 MiB; no memory where that leaves the machine under 256 MiB. */
const defaultLimits = (size: MachineSize): Limits => ({
  cpus: Math.max(1, size.cores - 1),
  ...(size.memoryMb >= LEAST_MB + KEEP_MB && { memoryMb: Math.max(LEAST_MB, size.memoryMb - 1024, Math.floor(size.memoryMb / 2)) }),
});

export { gb };

export const limitsWords = (limits: Limits, size: MachineSize): string => [
  limits.cpus ? `${limits.cpus} of ${size.cores} cores` : 'every core',
  limits.memoryMb ? `${gb(limits.memoryMb)} of ${gb(size.memoryMb)}` : 'all its memory',
].join(' and ');

/** Where the kernel's files are; a test names its own. */
type Kernel = { cgroup: string; proc: string };
const KERNEL: Kernel = { cgroup: '/sys/fs/cgroup', proc: '/proc' };

const read = (file: string): string | undefined => readOrUndefined(file)?.trim();
// a `name value` line of a cgroup's stat or events file
const field = (text: string | undefined, name: string): number => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(text ?? '')?.[1]);
const unlimited = (max: string | undefined): boolean => max === undefined || max.startsWith('max');

// the account's manager, whose controllers are all a unit under it can be given
function delegated(k: Kernel, group: string): string[] | undefined {
  const parts = group.split('/');
  const at = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
  return at < 0 ? undefined : read(path.join(k.cgroup, ...parts.slice(0, at + 1), 'cgroup.controllers'))?.split(/\s+/);
}

const groupOf = (k: Kernel, pid: number): string | undefined => /^0::(.*)$/m.exec(read(path.join(k.proc, String(pid), 'cgroup')) ?? '')?.[1];

type Probe = { run: Run; unit: string; kernel?: Kernel; tmuxPid?: () => Promise<number | undefined> };

/** Whether the unit's cgroup holds `limits` and no other limit, and the memory its processes hold. */
async function limitsState(limits: Limits, o: Probe): Promise<Pick<LimitsReport, 'state' | 'heldMb'> & { lacks?: ('cpu' | 'memory')[] }> {
  const k = o.kernel ?? KERNEL;
  const group = await unitCgroup(o.run, o.unit);
  if (group === undefined) return { state: limits.cpus || limits.memoryMb ? 'pending' : 'none' };
  const dir = path.join(k.cgroup, group);
  const stat = read(path.join(dir, 'memory.stat'));
  // anonymous and shared memory, which with no swap the kernel cannot take back
  const kept = field(stat, 'anon') + (field(stat, 'shmem') || 0);
  const can = delegated(k, group);
  const lacks = can && (['cpu', 'memory'] as const).filter((c) => !can.includes(c));
  const held = { ...(Number.isFinite(kept) && { heldMb: Math.round(kept / MIB) }), ...(lacks?.length && { lacks }) };
  const cpu = read(path.join(dir, 'cpu.max'));
  const [quota, period] = (cpu ?? '').split(' ').map(Number);
  const memory = read(path.join(dir, 'memory.max'));
  // a kernel with no swap accounting has no such file, and no swap to give
  const swap = read(path.join(dir, 'memory.swap.max'));
  const holds = (limits.memoryMb ? Number(memory) === limits.memoryMb * MIB && (swap === undefined || swap === '0') : unlimited(memory))
    && (limits.cpus ? quota / period === limits.cpus : unlimited(cpu));
  if (!limits.cpus && !limits.memoryMb) return { state: holds ? 'none' : 'unapplied', ...held };
  if (limits.memoryMb && can && !can.includes('memory')) return { state: 'no_memory', ...held };
  if (limits.cpus && can && !can.includes('cpu')) return { state: 'no_cpu', ...held };
  if (!holds) return { state: 'unapplied', ...held };
  const tmux = await o.tmuxPid?.();
  const theirs = tmux === undefined ? undefined : groupOf(k, tmux);
  return { state: theirs !== undefined && theirs !== group ? 'outside' : 'applied', ...held };
}

export type LimitsTarget = { fleet: string; home: string; unitDir: string; run: Run; kernel?: Kernel; tmuxPid?: () => Promise<number | undefined>; size?: MachineSize };

const probeOf = (o: LimitsTarget): Probe => ({ run: o.run, unit: svalldUnitName(o.fleet), kernel: o.kernel, tmuxPid: o.tmuxPid });

export async function readLimits(o: LimitsTarget): Promise<LimitsReport> {
  const limits = peekConfig(resolvePaths(o.home)).limits ?? {};
  const size = o.size ?? machineSize();
  const { lacks, ...state } = await limitsState(limits, probeOf(o));
  const { cpus, memoryMb } = defaultLimits(size);
  // only what this account can be held to is offered
  return { size, suggested: { ...(!lacks?.includes('cpu') && { cpus }), ...(memoryMb !== undefined && !lacks?.includes('memory') && { memoryMb }) }, limits, ...state };
}

/** A rendered unit's text with `limits` for its limit lines. */
const withLimits = (unit: string, limits: Limits): string =>
  unit.replace(/(\nOOMPolicy=continue)(\nCPUQuota=[^\n]*)?(\nMemoryMax=[^\n]*)?(\nMemorySwapMax=[^\n]*)?/, (_, at: string) => `${at}${unitLimits(limits)}`);

export const WHY = LIMITS_WHY;

// held by the daemon and a `svall fleet limits set` alike, waiting while the other holds it
async function lockLimits(home: string): Promise<() => void> {
  fs.mkdirSync(home, { recursive: true });
  const name = `svall-limits-${sha256Hex(fs.realpathSync(home))}`;
  for (;;) {
    const unlock = await tryLock(path.join(home, 'limits.lock'), name);
    if (unlock) return unlock;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Sets what the fleet may use here, on its unit as it runs, restarting nothing, one set at a time; a limit that does not take hold is taken back. */
export async function setLimits(wanted: Limits, o: LimitsTarget): Promise<LimitsReport> {
  if (process.platform !== 'linux' && !o.kernel) throw new Invalid('a limit is for a Linux machine');
  const limits = Limits.parse(wanted);
  const unlock = await lockLimits(o.home);
  try {
    const before = await readLimits(o);
    const { size } = before;
    if (limits.cpus && limits.cpus > size.cores) throw new Invalid(`this machine has ${size.cores} cores`);
    if (limits.memoryMb && limits.memoryMb > size.memoryMb) throw new Invalid(`this machine has ${gb(size.memoryMb)} of memory`);
    if (limits.memoryMb && before.heldMb !== undefined && before.heldMb > limits.memoryMb) {
      throw new Invalid(`${gb(before.heldMb)} is in use now; stop a robot or allow at least ${Math.ceil(before.heldMb / 1024)} GB`);
    }
    const paths = resolvePaths(o.home);
    const apply = async (l: Limits): Promise<void> => {
      saveLimits(paths, l);
      const file = path.join(o.unitDir, svalldUnitName(o.fleet));
      const text = readOrUndefined(file);
      // only these lines change, so the unit stays what setup renders and its next run restarts nothing
      if (text !== undefined) writeDurable(file, Buffer.from(withLimits(text, l)), { mode: 0o644 });
      await daemonReload(o.run);
    };
    try {
      await apply(limits);
      const after = await readLimits(o);
      if (after.state === 'none' || after.state === 'applied' || after.state === 'pending' || after.state === 'outside') return after;
      throw new Invalid(`the limit was not set: ${WHY[after.state]}`);
    } catch (e) {
      await apply(before.limits).catch(() => undefined);
      throw e;
    }
  } finally {
    unlock();
  }
}

/** Counts the times the kernel stopped a process of the daemon's own cgroup, the unit's, at the unit's memory limit, from now on. */
export function watchMemoryHits(o: { kernel?: Kernel; pid?: number; onHit?: (hits: number) => void; everyMs?: number }): { hits(): { hits: number; lastHit?: number }; stop(): void } {
  const k = o.kernel ?? KERNEL;
  const group = groupOf(k, o.pid ?? process.pid);
  // `oom` counts the cgroup reaching its own limit, never the machine running out of memory; `oom_kill` each process stopped for either
  const count = (): { oom: number; kills: number } | undefined => {
    const events = group && read(path.join(k.cgroup, group, 'memory.events'));
    const at = { oom: field(events, 'oom'), kills: field(events, 'oom_kill') };
    return Number.isFinite(at.oom) && Number.isFinite(at.kills) ? at : undefined;
  };
  const start = count();
  let hits = 0;
  let lastHit: number | undefined;
  const timer = start === undefined ? undefined : setInterval(() => {
    const at = count() ?? start;
    // kills past the times the limit was reached were the machine running out, not the fleet's limit
    const now = Math.min(at.oom - start.oom, at.kills - start.kills);
    if (now <= hits) return;
    hits = now;
    lastHit = Date.now();
    o.onHit?.(hits);
  }, o.everyMs ?? 5000);
  timer?.unref();
  return { hits: () => ({ hits, ...(lastHit !== undefined && { lastHit }) }), stop: () => clearInterval(timer) };
}
