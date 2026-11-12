import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MachineId } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/durable';

const LastCheck = z.object({ at: z.number(), failed: z.number(), warned: z.number(), release: z.string().optional() });
/** What the last `host doctor`, add, upgrade or rollback here found: when, how many checks failed and warned, and the release the machine runs. */
export type LastCheck = z.infer<typeof LastCheck>;

// beside the registry, by machine id, so a renamed machine keeps its check
const checksFile = (dir: string): string => path.join(dir, 'checks.json');

/** Every machine's last check; a file that cannot be read holds none. */
export function lastChecks(dir: string): Record<string, LastCheck> {
  try { return z.record(z.string(), LastCheck).parse(JSON.parse(fs.readFileSync(checksFile(dir), 'utf8'))); } catch { return {}; }
}

export function recordCheck(dir: string, id: MachineId, check: LastCheck): void {
  writeDurable(checksFile(dir), { ...lastChecks(dir), [id]: check });
}

/** Drops a machine's last check, as it leaves the registry; the file goes with the last one. */
export function forgetCheck(dir: string, id: string): void {
  const { [id]: gone, ...rest } = lastChecks(dir);
  if (!gone) return;
  if (Object.keys(rest).length) writeDurable(checksFile(dir), rest);
  else fs.rmSync(checksFile(dir), { force: true });
}

/** What a join found of a home this Mac never checked, kept as its last check: the release it runs, `same` as this Mac's or not. */
export function keepJoined(dir: string, home: MachineId, release: string, same: boolean): void {
  if (lastChecks(dir)[home]) return;
  recordCheck(dir, home, { at: Date.now(), failed: same ? 0 : 1, warned: 0, release });
}
