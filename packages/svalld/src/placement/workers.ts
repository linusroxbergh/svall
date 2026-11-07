import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { MachineId } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { readRegistry } from '../machine.js';
import type { Paths } from '../paths.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';

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

/** What a home runs on a worker over its own ssh to make it this fleet's, the token on its stdin. */
export const enrollArgv = (o: { svallBase: string; profile?: string; home: MachineId; homeName: string; fleetId: string; homePlatform: string }): string[] => [
  shq(svallExe(o.svallBase)), ...(o.profile ? ['-p', shq(o.profile)] : []), 'worker', 'enroll', '--home-machine', shq(o.home), '--home-name', shq(o.homeName), '--fleet-id', shq(o.fleetId), '--home-platform', shq(o.homePlatform),
];

/** What makes this machine a key if it has none, and copies it to `ssh`, whose prompt also takes the host key. */
export const keyLine = (ssh: string): string => `test -f ~/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519; ssh-copy-id ${shq(ssh)}`;

/** The fix for a machine `here` cannot log in to. */
export const noLoginFix = (here: string, ssh: string): string => `on ${here}, run ${keyLine(ssh)}, then try again; a machine that takes keys alone gets the public half by hand: ssh ${here} cat .ssh/id_ed25519.pub | ssh ${ssh} 'cat >> .ssh/authorized_keys'`;

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

/** Those of them the registry lists, as only those link; all of them where the registry cannot be read. */
export function listedWorkerIds(paths: Paths): string[] {
  let listed: Set<string> | undefined;
  try { listed = new Set(readRegistry().map((m) => m.id)); } catch { /* every token counts */ }
  return workerIds(paths).filter((id) => !listed || listed.has(id));
}

/** Takes back the token of a machine that is no longer a worker; a home that holds none is left as it is. */
export function dropToken(paths: Paths, machine: MachineId): void {
  const { [machine]: gone, ...rest } = read(paths);
  if (gone) writeDurable(paths.workersFile, rest, { mode: 0o600 });
}
