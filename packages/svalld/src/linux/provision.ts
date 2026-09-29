import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetConfig, defaultHome, type FleetId, type MachineId } from '@svall/protocol';
import { seedAgentProfiles } from '../agent-profiles.js';
import { writeJsonAtomic } from '../atomic.js';
import { DurableJson } from '../handover/durable.js';
import { OwnerCache } from '../ownership/state.js';
import { resolvePaths, type Paths } from '../paths.js';
import { PRIVATE } from '../profile.js';
import { installHomeTemplate, setupFleetHome } from '../setup.js';
import { fleetHomes } from '../uninstall.js';
import { daemonReload, enableUnit, restartUnit, stopUnit, type Run } from './service.js';
import { agentHomesEnv, svalldUnitName, writeUnits, type UnitOptions } from './setup.js';

export type Provision = UnitOptions & {
  profile: string;
  home: string;
  fleetId: FleetId;
  gatewayMachineId: MachineId;
  unitDir: string;
  run: Run;
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
  const owner = new DurableJson(OwnerCache, paths.owner).read();
  if (!owner.ok && owner.reason === 'malformed') return `its ${paths.owner} cannot be read`;
  const record = owner.ok ? owner.value : undefined;
  if (record?.transaction) return `it is in handover ${record.transaction.id}`;
  if (record && record.generation > 0) return `it has been handed over, to generation ${record.generation}`;
  const state = readJson(paths.state);
  if (state.broken) return `its ${paths.state} cannot be read`;
  const n = Object.keys((state.value?.characters as object | undefined) ?? {}).length;
  return n ? `it holds ${n} ${n === 1 ? 'character' : 'characters'}` : undefined;
}

// whether two paths hold the same names, each a folder or a file with the same bytes
function sameTree(a: string, b: string): boolean {
  const [at, bt] = [a, b].map((p) => fs.lstatSync(p, { throwIfNoEntry: false }));
  if (at?.isDirectory() && bt?.isDirectory()) {
    const names = fs.readdirSync(a).sort();
    return names.join('\0') === fs.readdirSync(b).sort().join('\0') && names.every((n) => sameTree(path.join(a, n), path.join(b, n)));
  }
  return !!at?.isFile() && !!bt?.isFile() && fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Removes mission control's folder and the agent profiles a standalone start seeded, each only while it holds exactly
 * what the seed writes: left there, they would meet the fleet's own copies as occupied folders. A mission control
 * folder another fleet home here names is that fleet's too, and stays.
 */
function unseed(o: Provision, paths: Paths, homeCwd: string): void {
  const expand = (p: string): string => path.resolve(p === '~' || p.startsWith('~/') ? path.join(o.homedir, p.slice(1)) : p);
  const cwd = expand(homeCwd);
  const shared = fleetHomes(o.homedir).filter((h) => path.resolve(h) !== path.resolve(o.home)).some((h) => {
    const fleet = FleetConfig.safeParse(readJson(resolvePaths(h).fleetConfig).value);
    return expand(fleet.success ? fleet.data.home.cwd : defaultHome().cwd) === cwd;
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-seed-'));
  try {
    const seeds: [string, (dir: string) => unknown][] = [[paths.agentProfiles, (dir) => seedAgentProfiles(dir)]];
    if (!shared) seeds.push([cwd, (dir) => installHomeTemplate(dir, { replaceSettings: false })]);
    for (const [i, [at, seed]] of seeds.entries()) {
      const fresh = path.join(scratch, String(i));
      seed(fresh);
      if (sameTree(at, fresh)) fs.rmSync(at, { recursive: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// the unit is written only when it is not already what it should be, and systemd reads it again only then;
// `rewritten`: a unit file that was there changed, and a daemon already running still runs the old one
async function ensureUnit(o: Provision): Promise<{ unit: string; rewritten: boolean }> {
  const unit = svalldUnitName(o.profile);
  const had = fs.existsSync(path.join(o.unitDir, unit));
  const env = o.env ?? await agentHomesEnv(o.run);
  const wrote = writeUnits({ ...o, fleet: o.profile, env }, true).length > 0;
  if (wrote) await daemonReload(o.run);
  return { unit, rewritten: had && wrote };
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
    const { unit, rewritten } = await ensureUnit(o);
    if (rewritten) await restartUnit(o.run, unit);
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
  // stopped here and started by enable, the daemon runs the unit as written with no restart as the old fleet
  const { unit } = await ensureUnit(o);
  await stopUnit(o.run, unit);
  unseed(o, paths, parsed.data.home.cwd);
  writeJsonAtomic(paths.fleetConfig, { ...parsed.data, id: o.fleetId, gatewayMachineId: o.gatewayMachineId });
  fs.rmSync(paths.owner, { force: true });
  await enableUnit(o.run, unit);
  return { outcome: 'rekeyed', home: o.home, unit };
}
