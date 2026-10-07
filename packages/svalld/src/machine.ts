import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MachineId } from '@svall/protocol';
import { createDurable } from './handover/durable.js';

const Machine = z.object({ id: MachineId });

/** Where this installation keeps what belongs to the machine rather than to a fleet. */
export function configDir(): string {
  return process.env.SVALL_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'svall');
}

function read(file: string): MachineId {
  try {
    return Machine.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).id;
  } catch (err) {
    throw new Error(`invalid machine file ${file}: ${String(err)}; delete the file to mint a new machine id, or restore it from backup`);
  }
}

/** Writes a new id whole, or reads back the one another process wrote first: the file is never replaced. */
export function mintMachineId(dir: string): MachineId {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'machine.json');
  const id = MachineId.parse(crypto.randomUUID());
  try {
    createDurable(file, { id }, { mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return read(file);
  }
  return id;
}

/** This installation's id, made on the first call and read back on every later one. */
export function machineId(dir: string = configDir()): MachineId {
  const file = path.join(dir, 'machine.json');
  return fs.existsSync(file) ? read(file) : mintMachineId(dir);
}
