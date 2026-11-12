import os from 'node:os';
import path from 'node:path';
import { Limits, type LimitsReport, type MachineSize } from '@svall/protocol';
import { peekConfig, saveLimits } from '../config.js';
import { writeDurable } from '../durable.js';
import { Invalid } from '../errors.js';
import { resolvePaths } from '../paths.js';
import { readOrUndefined } from '../settings-file.js';
import { daemonReload, unitCgroup, type Run } from './service.js';
import { svalldUnitName, unitLimits } from './setup.js';

const MIB = 1024 * 1024;

export const machineSize = (): MachineSize => ({ cores: os.cpus().length, memoryMb: Math.floor(os.totalmem() / MIB) });

/** All but one core and 1 GiB, and never under half of a small machine's memory. */
export const defaultLimits = (size: MachineSize): Required<Limits> => ({
  cpus: Math.max(1, size.cores - 1),
  memoryMb: Math.max(size.memoryMb - 1024, Math.floor(size.memoryMb / 2)),
});

export const gb = (mb: number): string => `${Math.round(mb / 102.4) / 10} GB`;

export const limitsWords = (limits: Limits, size: MachineSize): string => [
  limits.cpus ? `${limits.cpus} of ${size.cores} cores` : 'every core',
  limits.memoryMb ? `${gb(limits.memoryMb)} of ${gb(size.memoryMb)}` : 'all its memory',
].join(' and ');

/** Where the kernel's files are; a test names its own. */
export type Kernel = { cgroup: string; proc: string };
export const KERNEL: Kernel = { cgroup: '/sys/fs/cgroup', proc: '/proc' };

const read = (file: string): string | undefined => readOrUndefined(file)?.trim();

// the account's manager, whose controllers are all a unit under it can be given
function delegated(k: Kernel, group: string): string[] | undefined {
  const parts = group.split('/');
  const at = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
  return at < 0 ? undefined : read(path.join(k.cgroup, ...parts.slice(0, at + 1), 'cgroup.controllers'))?.split(/\s+/);
}

const groupOf = (k: Kernel, pid: number): string | undefined => /^0::(.*)$/m.exec(read(path.join(k.proc, String(pid), 'cgroup')) ?? '')?.[1];

type Probe = { run: Run; unit: string; kernel?: Kernel; tmuxPid?: () => Promise<number | undefined> };

/** Whether the unit's cgroup holds `limits`, and the memory its processes hold. */
export async function limitsState(limits: Limits, o: Probe): Promise<Pick<LimitsReport, 'state' | 'heldMb'> & { lacks?: ('cpu' | 'memory')[] }> {
  const k = o.kernel ?? KERNEL;
  const group = await unitCgroup(o.run, o.unit);
  if (group === undefined) return { state: limits.cpus || limits.memoryMb ? 'pending' : 'none' };
  const dir = path.join(k.cgroup, group);
  const anon = Number(/^anon (\d+)$/m.exec(read(path.join(dir, 'memory.stat')) ?? '')?.[1]);
  const can = delegated(k, group);
  const lacks = can && (['cpu', 'memory'] as const).filter((c) => !can.includes(c));
  const held = { ...(Number.isFinite(anon) && { heldMb: Math.round(anon / MIB) }), ...(lacks?.length && { lacks }) };
  if (!limits.cpus && !limits.memoryMb) return { state: 'none', ...held };
  if (limits.memoryMb && can && !can.includes('memory')) return { state: 'no_memory', ...held };
  if (limits.cpus && can && !can.includes('cpu')) return { state: 'no_cpu', ...held };
  const [quota, period] = (read(path.join(dir, 'cpu.max')) ?? '').split(' ').map(Number);
  // a kernel with no swap accounting has no such file, and no swap to give
  const swap = read(path.join(dir, 'memory.swap.max'));
  const holds = (!limits.memoryMb || (Number(read(path.join(dir, 'memory.max'))) === limits.memoryMb * MIB && (swap === undefined || swap === '0')))
    && (!limits.cpus || quota / period === limits.cpus);
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
  return { size, suggested: { ...(!lacks?.includes('cpu') && { cpus }), ...(!lacks?.includes('memory') && { memoryMb }) }, limits, ...state };
}

/** A rendered unit's text with `limits` for its limit lines. */
export const withLimits = (unit: string, limits: Limits): string =>
  unit.replace(/(\nOOMPolicy=continue)(\nCPUQuota=[^\n]*)?(\nMemoryMax=[^\n]*)?(\nMemorySwapMax=[^\n]*)?/, (_, at: string) => `${at}${unitLimits(limits)}`);

export const WHY: Record<LimitsReport['state'], string | undefined> = {
  none: undefined,
  applied: undefined,
  pending: 'it holds once the fleet\'s daemon starts',
  unapplied: 'systemd did not put it on the fleet\'s unit',
  no_cpu: 'this account is given no control of cores: as root, put Delegate=cpu cpuset io memory pids under [Service] in /etc/systemd/system/user@.service.d/delegate.conf and reboot',
  no_memory: 'this account is given no control of memory',
  outside: 'the fleet\'s terminals run outside its unit, on a tmux Svall did not bring, until every robot there is closed and the daemon restarts',
};

/** Sets what the fleet may use here, on its unit as it runs, restarting nothing; a limit that does not take hold is taken back. */
export async function setLimits(wanted: Limits, o: LimitsTarget): Promise<LimitsReport> {
  if (process.platform !== 'linux' && !o.kernel) throw new Invalid('a limit is for a Linux machine');
  const limits = Limits.parse(wanted);
  const before = await readLimits(o);
  const { size } = before;
  if (limits.cpus && limits.cpus > size.cores) throw new Invalid(`this machine has ${size.cores} cores`);
  if (limits.memoryMb && limits.memoryMb > size.memoryMb) throw new Invalid(`this machine has ${gb(size.memoryMb)} of memory`);
  if (limits.memoryMb && before.heldMb !== undefined && before.heldMb > limits.memoryMb) {
    throw new Invalid(`the fleet holds ${gb(before.heldMb)} here now; stop a robot or allow more`);
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
  } catch (e) {
    await apply(before.limits).catch(() => undefined);
    throw e;
  }
  const after = await readLimits(o);
  if (after.state === 'none' || after.state === 'applied' || after.state === 'pending' || after.state === 'outside') return after;
  await apply(before.limits);
  throw new Invalid(`the limit was not set: ${WHY[after.state]}`);
}

/** Counts the times the kernel stopped a process of the daemon's own cgroup for memory, from now on. */
export function watchMemoryHits(o: { kernel?: Kernel; pid?: number; onHit?: (hits: number) => void; everyMs?: number }): { hits(): { hits: number; lastHit?: number }; stop(): void } {
  const k = o.kernel ?? KERNEL;
  const group = groupOf(k, o.pid ?? process.pid);
  const count = (): number | undefined => {
    const n = Number(/^oom_kill (\d+)$/m.exec((group && read(path.join(k.cgroup, group, 'memory.events'))) || '')?.[1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const start = count();
  let hits = 0;
  let lastHit: number | undefined;
  const timer = start === undefined ? undefined : setInterval(() => {
    const now = (count() ?? start) - start;
    if (now <= hits) return;
    hits = now;
    lastHit = Date.now();
    o.onHit?.(hits);
  }, o.everyMs ?? 5000);
  timer?.unref();
  return { hits: () => ({ hits, ...(lastHit !== undefined && { lastHit }) }), stop: () => clearInterval(timer) };
}
