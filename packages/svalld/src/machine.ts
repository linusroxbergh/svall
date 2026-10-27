import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MachineId, MachineRecord } from '@svall/protocol';
import { createDurable, writeDurable } from './durable.js';

// the hardware the id was made on, which a copy of the file to another machine no longer matches
const Machine = z.object({ id: MachineId, hardwareId: z.string().min(1).optional() });
type Machine = z.infer<typeof Machine>;

/** Reads this machine's hardware id, or none where it cannot be read. */
export type HardwareReader = () => string | undefined;

/** Where this installation keeps what belongs to the machine rather than to a fleet. */
export function configDir(): string {
  return process.env.SVALL_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'svall');
}

/** The controller's machines.json: every machine it reaches, by id, no two under one name. */
export const Registry = z.object({
  machines: z.record(MachineId, MachineRecord).refine(
    (machines) => new Set(Object.values(machines).map((m) => m?.name)).size === Object.keys(machines).length,
    'two machines share a name',
  ),
});

export const registryFile = (dir: string = configDir()): string => path.join(dir, 'machines.json');

export type MachineEntry = { id: MachineId; record: MachineRecord };

/** Every machine in the registry; none while it has no file. */
export function readRegistry(dir: string = configDir()): MachineEntry[] {
  const file = registryFile(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  try {
    return Object.entries(Registry.parse(JSON.parse(text)).machines).map(([id, record]) => ({ id: id as MachineId, record: record as MachineRecord }));
  } catch (e) {
    throw new Error(`invalid machine registry ${file}: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * The Mac's IOPlatformUUID, or Linux's machine-id, keyed for svall as machine-id(5) asks, so the id itself is never
 * kept. `ioreg` is named outright: launchd starts svalld on a PATH without /usr/sbin.
 */
export function hardwareId(platform: NodeJS.Platform = process.platform, ioreg = '/usr/sbin/ioreg'): string | undefined {
  const keyed = (id: string | undefined): string | undefined => id && crypto.createHmac('sha256', id).update('svall').digest('hex');
  if (platform === 'darwin') {
    try { return keyed(/"IOPlatformUUID" = "([^"]+)"/.exec(execFileSync(ioreg, ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }))?.[1]); } catch { return undefined; }
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const id = fs.readFileSync(file, 'utf8').trim(); if (id) return keyed(id); } catch { /* the next one */ }
  }
  return undefined;
}

function read(file: string): Machine {
  try {
    return Machine.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`invalid machine file ${file}: ${String(err)}; delete the file to mint a new machine id, or restore it from backup`);
  }
}

/** Writes a new id whole, beside this machine's hardware id, or reads back the one another process wrote first: the file is never replaced. */
export function mintMachineId(dir: string, hardware: HardwareReader = hardwareId): MachineId {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'machine.json');
  const id = MachineId.parse(crypto.randomUUID());
  const actual = hardware();
  try {
    createDurable(file, { id, ...(actual && { hardwareId: actual }) }, { mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return read(file).id;
  }
  return id;
}

/** The file, made on the first call; one that names no hardware gets this machine's written beside its id. */
function machine(dir: string, hardware: HardwareReader): Machine {
  const file = path.join(dir, 'machine.json');
  if (!fs.existsSync(file)) mintMachineId(dir, hardware);
  const m = read(file);
  const actual = m.hardwareId ? undefined : hardware();
  if (!actual) return m;
  // the id stands without it, so a file that cannot be written now is bound on a later read
  try { writeDurable(file, { ...m, hardwareId: actual }, { mode: 0o600 }); } catch { return m; }
  return { ...m, hardwareId: actual };
}

/** Why `machineId()` threw, with the fix when ~/.config is not this account's to write. */
export function machineIdFailure(err: unknown): string {
  const dir = configDir();
  const code = (err as NodeJS.ErrnoException).code;
  const fix = code === 'EACCES' ? `; fix it with: sudo chown -R $USER ${path.dirname(dir)}`
    : code === 'ENOTDIR' ? `; a file is in the way of the folder ${dir}: move it aside`
    : '';
  return `${(err as Error).message}${fix}`;
}

/** This installation's id, made on the first call and read back on every later one. */
export function machineId(dir: string = configDir(), hardware: HardwareReader = hardwareId): MachineId {
  return machine(dir, hardware).id;
}

/** This installation's id, and when the file was made on other hardware, as a copy of another machine's is, both hardware ids. */
export function machineIdentity(dir: string = configDir(), hardware: HardwareReader = hardwareId): { id: MachineId; hardware?: { stored: string; actual: string } } {
  const { id, hardwareId: stored } = machine(dir, hardware);
  const actual = stored && hardware();
  return actual && actual !== stored ? { id, hardware: { stored, actual } } : { id };
}

/** Binds the file to `hardwareId`, keeping the id it holds. */
export function rebindMachine(hardwareId: string, dir: string = configDir()): void {
  const file = path.join(dir, 'machine.json');
  writeDurable(file, { ...read(file), hardwareId }, { mode: 0o600 });
}

/** The machine id `svall version --json` names in `stdout`, past whatever a login shell printed around it; undefined when it names none. */
export function versionMachineId(stdout: string): string | undefined {
  return /^\s*"machineId":\s*"([^"]+)"/m.exec(stdout)?.[1];
}

/** What a machine that shares another's id does to get its own. */
export const copiedRemedy = (file: string): string =>
  `this machine shares another machine's id; move ${file} aside and restart svalld so this machine mints its own id, then \`svall host add\` each worker again; if it is the machine the file was made on, with new hardware, \`svall doctor --rebind\` keeps its id`;
