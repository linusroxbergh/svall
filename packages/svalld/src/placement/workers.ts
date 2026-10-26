import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { MachineId } from '@svall/protocol';
import { writeDurable } from '../handover/durable.js';
import type { Paths } from '../paths.js';

const Workers = z.record(MachineId, z.object({ token: z.string().min(32), addedAt: z.number() }));
type Workers = z.infer<typeof Workers>;

function read(paths: Paths): Workers {
  let text: string;
  try {
    text = fs.readFileSync(paths.workersFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    return Workers.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`invalid ${paths.workersFile}: ${(e as Error).message}`, { cause: e });
  }
}

/** A new token for `machine` to accept this home by, in place of any it held. */
export function issueToken(paths: Paths, machine: MachineId): string {
  const token = crypto.randomBytes(24).toString('hex');
  writeDurable(paths.workersFile, { ...read(paths), [machine]: { token, addedAt: Date.now() } }, { mode: 0o600 });
  return token;
}

export function tokenFor(paths: Paths, machine: MachineId): string | undefined {
  return read(paths)[machine]?.token;
}
