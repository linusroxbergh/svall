import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MachineId, OwnerRecord } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/durable';
import { OwnerCache } from '@svall/svalld/ownership/state';
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
  writeDurable(routeFile(fleetHome), route);
}

/** The record this machine's daemon holds: what a cached local route is checked against. */
export function cachedOwner(fleetHome: string): OwnerRecord | undefined {
  try {
    return OwnerRecord.parse(JSON.parse(fs.readFileSync(resolvePaths(fleetHome).owner, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Whether this machine's daemon holds the fleet with nothing under way: its record names `localId` and carries no
 * freeze, surrender or transaction but the committed one that brought the fleet here, no handover journal is open here,
 * and the gateway's last answer names no other machine at that generation or above.
 */
export function heldHere(fleetHome: string, localId: MachineId): boolean {
  const paths = resolvePaths(fleetHome);
  if (fs.existsSync(paths.journal)) return false;
  let held: OwnerCache;
  try {
    held = OwnerCache.parse(JSON.parse(fs.readFileSync(paths.owner, 'utf8')));
  } catch {
    return false;
  }
  const tx = held.transaction;
  const route = readRoute(fleetHome);
  return held.ownerMachineId === localId && !held.frozen && !held.surrendered
    && (!tx || (tx.phase === 'committed' && tx.toMachineId === localId))
    && !(route && route.ownerMachineId !== localId && route.generation >= held.generation);
}

/** Keeps the owner the gateway just named, for commands to route by while the gateway cannot answer. */
export function rememberOwner(fleetHome: string, record: Pick<OwnerRecord, 'ownerMachineId' | 'generation'>, now: Date = new Date()): void {
  try {
    writeRoute(fleetHome, { ownerMachineId: record.ownerMachineId, generation: record.generation, at: now.toISOString() });
  } catch {
    // the cached route only stands in while the gateway cannot answer
  }
}
