import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MachineId, OwnerRecord } from '@svall/protocol';
import { writeJsonAtomic } from '@svall/svalld/atomic';
import { resolvePaths } from '@svall/svalld/paths';

/** The last owner the gateway named, and the generation a daemon must still report for it to be used. */
export const CachedRoute = z.object({
  ownerMachineId: MachineId,
  generation: z.number().int().nonnegative(),
  at: z.string(),
});
export type CachedRoute = z.infer<typeof CachedRoute>;

const routeFile = (fleetHome: string): string => path.join(fleetHome, 'controller', 'route.json');

export function readRoute(fleetHome: string): CachedRoute | undefined {
  try {
    return CachedRoute.parse(JSON.parse(fs.readFileSync(routeFile(fleetHome), 'utf8')));
  } catch {
    // a route that cannot be read is a route we do not have
    return undefined;
  }
}

export function writeRoute(fleetHome: string, route: CachedRoute): void {
  writeJsonAtomic(routeFile(fleetHome), route);
}

/** The record this machine's daemon holds: what a cached local route is checked against. */
export function cachedOwner(fleetHome: string): OwnerRecord | undefined {
  try {
    return OwnerRecord.parse(JSON.parse(fs.readFileSync(resolvePaths(fleetHome).owner, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Keeps the owner the gateway just named, for commands to route by while the gateway cannot answer. */
export function rememberOwner(fleetHome: string, record: Pick<OwnerRecord, 'ownerMachineId' | 'generation'>, now: Date = new Date()): void {
  try {
    writeRoute(fleetHome, { ownerMachineId: record.ownerMachineId, generation: record.generation, at: now.toISOString() });
  } catch {
    // the cached route only stands in while the gateway cannot answer
  }
}
