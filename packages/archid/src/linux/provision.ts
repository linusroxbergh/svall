import fs from 'node:fs';
import path from 'node:path';
import { FleetConfig, type FleetId, type MachineId } from '@archipelago/protocol';
import { writeJsonAtomic } from '../atomic.js';
import { resolvePaths, type Paths } from '../paths.js';
import { PRIVATE } from '../profile.js';
import { writeAtomic } from '../jsonfile.js';
import { setupFleetHome } from '../setup.js';
import { daemonReload, enableUnit, stopUnit, type Run } from './service.js';
import { archidUnit, type UnitOptions } from './setup.js';

export type Provision = UnitOptions & {
  profile: string;
  home: string;
  fleetId: FleetId;
  gatewayMachineId: MachineId;
  unitDir: string;
  run: Run;
  tmuxVersion?: string;
};

/** `created`: there was no fleet home; `held`: it already held this fleet, now brought to a running unit; `rekeyed`: it held one only `host add` had made. */
export type Provisioned = { outcome: 'created' | 'held' | 'rekeyed'; home: string; unit: string };

/** A fleet home that holds another fleet in use, which is not this machine's to replace. */
export class ProvisionRefused extends Error {}

type Read = { value?: Record<string, unknown>; broken?: true };

function readJson(file: string): Read {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { broken: true };
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { broken: true };
  } catch {
    return { broken: true };
  }
}

/** Why a fleet home is more than `host add` left it, or nothing when it holds no work, no handover and no ownership beyond generation 0. */
function inUse(paths: Paths): string | undefined {
  if (fs.existsSync(paths.journal)) return 'it holds a handover journal';
  const owner = readJson(paths.owner);
  if (owner.broken) return `its ${paths.owner} cannot be read`;
  const tx = owner.value?.transaction as { id?: unknown } | undefined;
  if (tx) return `it is in handover ${String(tx.id)}`;
  const generation = owner.value?.generation;
  if (typeof generation === 'number' && generation > 0) return `it has been handed over, to generation ${generation}`;
  const state = readJson(paths.state);
  if (state.broken) return `its ${paths.state} cannot be read`;
  const n = Object.keys((state.value?.characters as object | undefined) ?? {}).length;
  return n ? `it holds ${n} ${n === 1 ? 'character' : 'characters'}` : undefined;
}

// the unit is written only when it is not already what it should be, and systemd reads it again only then
async function ensureUnit(o: Provision): Promise<string> {
  const unit = archidUnit({ ...o, fleet: o.profile });
  const file = path.join(o.unitDir, unit.name);
  let held: string | undefined;
  try { held = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  if (held !== unit.text) {
    fs.mkdirSync(o.unitDir, { recursive: true });
    fs.mkdirSync(path.join(o.prefix, 'log'), { recursive: true });
    writeAtomic(file, unit.text, { perProcess: true });
    await daemonReload(o.run);
  }
  return unit.name;
}

/**
 * Gives this machine its copy of a fleet another machine names it the gateway of, under the profile the controller
 * reaches it by. An absent home is made and started; one that holds this fleet keeps it and is brought to a running
 * unit, finishing what an earlier run left undone; one that holds a fleet nothing has used yet takes this fleet's id
 * and gateway and owns nothing until the gateway names its owner.
 */
export async function provisionFleet(o: Provision): Promise<Provisioned> {
  const paths = resolvePaths(o.home);
  // what a home holding this fleet needs to run it; each step changes nothing already right, so a run cut short is finished by the next
  const run = async (): Promise<string> => {
    setupFleetHome({ ...o, port: o.profile === PRIVATE ? undefined : 0 });
    const unit = await ensureUnit(o);
    await enableUnit(o.run, unit);
    return unit;
  };
  const absent = ![paths.fleetConfig, paths.legacyConfig, paths.state, paths.owner, paths.journal].some((f) => fs.existsSync(f));
  if (absent) {
    fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
    writeJsonAtomic(paths.fleetConfig, FleetConfig.parse({ id: o.fleetId, gatewayMachineId: o.gatewayMachineId }));
    return { outcome: 'created', home: o.home, unit: await run() };
  }
  const fleet = readJson(paths.fleetConfig);
  const parsed = FleetConfig.safeParse(fleet.value);
  if (!parsed.success) throw new ProvisionRefused(`${o.home} holds a fleet whose ${paths.fleetConfig} cannot be read`);
  const held = parsed.data.id;
  if (held === o.fleetId) return { outcome: 'held', home: o.home, unit: await run() };
  const why = inUse(paths);
  if (why) throw new ProvisionRefused(`${o.home} holds fleet ${held}, and ${why}, so it is not this fleet's to replace`);
  const unit = await ensureUnit(o);
  await stopUnit(o.run, unit);
  writeJsonAtomic(paths.fleetConfig, { ...parsed.data, id: o.fleetId, gatewayMachineId: o.gatewayMachineId });
  fs.rmSync(paths.owner, { force: true });
  await enableUnit(o.run, unit);
  return { outcome: 'rekeyed', home: o.home, unit };
}
