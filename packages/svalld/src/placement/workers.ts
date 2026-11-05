import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { MachineId } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import type { Paths } from '../paths.js';

// `profile`: the fleet's on that worker, where it is named apart from this one's
const Workers = z.record(MachineId, z.object({ token: z.string().min(32), addedAt: z.number(), profile: z.string().optional() }));
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
  const held = read(paths);
  writeDurable(paths.workersFile, { ...held, [machine]: { ...held[machine], token, addedAt: Date.now() } }, { mode: 0o600 });
  return token;
}

/** The fleet's profile on worker `machine`, where it is named apart from this one's. */
export function workerProfile(paths: Paths, machine: string): string | undefined {
  try { return read(paths)[machine as MachineId]?.profile; } catch { return undefined; }
}

export function tokenFor(paths: Paths, machine: MachineId): string | undefined {
  return read(paths)[machine]?.token;
}

/** The machines this home holds a token for. */
export const workerIds = (paths: Paths): string[] => Object.keys(read(paths));

/** Takes back the token of a machine that is no longer a worker; a home that holds none is left as it is. */
export function dropToken(paths: Paths, machine: MachineId): void {
  const { [machine]: gone, ...rest } = read(paths);
  if (gone) writeDurable(paths.workersFile, rest, { mode: 0o600 });
}
