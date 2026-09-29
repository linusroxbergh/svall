import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { FleetConfig, FleetId, NodeConfig, type AgentKind, type MachineId } from '@archipelago/protocol';
import { writeJsonAtomic } from './atomic.js';
import { writeDurable } from './handover/durable.js';
import type { Paths } from './paths.js';

const newFleetId = (): FleetId => FleetId.parse(crypto.randomUUID());

/**
 * Every setting a running fleet reads, portable and machine-local side by side. It is also the shape
 * of the config.json the two files are split out of.
 */
export const Config = FleetConfig.omit({ mobile: true })
  .merge(NodeConfig.omit({ mobile: true }))
  .extend({
    id: FleetId.default(newFleetId),
    mobile: FleetConfig.shape.mobile.unwrap().merge(NodeConfig.shape.mobile.unwrap()).prefault({}),
  });
export type Config = z.infer<typeof Config>;

export const scribeModel = (s: Config['scribe'], agent: AgentKind): string | undefined =>
  ((s.agent ?? 'claude') === agent ? s.model : undefined);

export class InvalidConfig extends Error {}

export const mergeConfig = (fleet: FleetConfig, node: NodeConfig): Config =>
  ({ ...fleet, ...node, mobile: { ...fleet.mobile, ...node.mobile } });

/** What `text` holds under `schema`; throws an InvalidConfig that says, on one line, what in `file` is wrong. */
export function parseConfig<T extends z.ZodTypeAny>(text: string, file: string, schema: T): z.infer<T> {
  try {
    return schema.parse(JSON.parse(text));
  } catch (err) {
    const why = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.') || 'the whole file'}: ${i.message}`).join('; ')
      : (err as Error).message;
    throw new InvalidConfig(`invalid config ${file}: ${why}`);
  }
}

const read = <T extends z.ZodTypeAny>(file: string, schema: T): z.infer<T> => parseConfig(fs.readFileSync(file, 'utf8'), file, schema);

type Raw = Record<string, unknown>;
const only = (from: Raw, keys: string[]): Raw => Object.fromEntries(Object.entries(from).filter(([k]) => keys.includes(k)));

// each key the file held goes to the file whose schema knows it, and a key neither knows is dropped; what the file
// left out is left to the defaults as the new files are read
function splitLegacy(file: string): { fleet: Raw; node: Raw } {
  const text = fs.readFileSync(file, 'utf8');
  const { id } = parseConfig(text, file, Config);
  const raw = JSON.parse(text) as Raw;
  const mobile = (raw.mobile ?? {}) as Raw;
  const fleetMobile = only(mobile, Object.keys(FleetConfig.shape.mobile.unwrap().shape));
  const nodeMobile = only(mobile, Object.keys(NodeConfig.shape.mobile.unwrap().shape));
  return {
    fleet: { ...only(raw, Object.keys(FleetConfig.shape).filter((k) => k !== 'mobile')), id, ...(Object.keys(fleetMobile).length && { mobile: fleetMobile }) },
    node: { ...only(raw, Object.keys(NodeConfig.shape).filter((k) => k !== 'mobile')), ...(Object.keys(nodeMobile).length && { mobile: nodeMobile }) },
  };
}

/** Why the config files that `has` finds are no layout a fleet can start on, before any of them is read. */
export function configRefusal(paths: Pick<Paths, 'legacyConfig' | 'fleetConfig' | 'nodeConfig'>, has: (file: string) => boolean): string | undefined {
  if (!has(paths.legacyConfig)) return undefined;
  if (has(paths.fleetConfig)) {
    return `${paths.legacyConfig} is not read any more: this fleet's settings are in ${paths.fleetConfig} and ${paths.nodeConfig}. Move anything you still want from it into them and delete it.`;
  }
  const backup = `${paths.legacyConfig}.bak`;
  if (has(backup)) return `${backup} is in the way of putting ${paths.legacyConfig} beside the new files. Keep whichever of the two you want, delete the other, and start again.`;
  return undefined;
}

/**
 * Writes whichever of the two config files this fleet is missing, out of its config.json when it
 * still has one, and returns the files written. An unreadable config.json stops it before any write.
 */
export function initConfig(paths: Paths, seed: Partial<NodeConfig> = {}): string[] {
  const has = (file: string): boolean => fs.existsSync(file);
  const backup = `${paths.legacyConfig}.bak`;
  // a config.json is put beside the new files byte-exact before anything is read out of it, so the
  // only file the split ever reads is one nothing edits any more
  if (has(paths.legacyConfig)) {
    const refused = configRefusal(paths, has);
    if (refused) throw new InvalidConfig(refused);
    read(paths.legacyConfig, Config); // one the schema rejects is left where its owner put it
    fs.renameSync(paths.legacyConfig, backup);
  }
  const wrote: string[] = [];
  const split = has(backup) && !has(paths.fleetConfig) ? splitLegacy(backup) : undefined;
  if (split || !has(paths.nodeConfig)) {
    writeJsonAtomic(paths.nodeConfig, split?.node ?? seed);
    wrote.push(paths.nodeConfig);
  }
  // last, so a fleet.json is only ever there once the split behind it is whole
  if (!has(paths.fleetConfig)) {
    writeJsonAtomic(paths.fleetConfig, split?.fleet ?? { id: newFleetId() });
    wrote.push(paths.fleetConfig);
  }
  return wrote;
}

export function loadConfig(paths: Paths): Config {
  if (!fs.existsSync(paths.home)) return Config.parse({});
  initConfig(paths);
  return mergeConfig(read(paths.fleetConfig, FleetConfig), read(paths.nodeConfig, NodeConfig));
}

/** The main agent fleet.json names, or the config.json it is still to be split out of; nothing is split or written. */
export function configuredMainAgent(paths: Paths): AgentKind | undefined {
  if (fs.existsSync(paths.fleetConfig)) return read(paths.fleetConfig, FleetConfig).mainAgent;
  return fs.existsSync(paths.legacyConfig) ? read(paths.legacyConfig, Config).mainAgent : undefined;
}

/**
 * Sets the keys `patch` names in a fleet.json, drops those it names as undefined, and keeps every other key as the file
 * held it. A file that does not parse, or would not after the change, is refused, not replaced. A linked file (stow,
 * home-manager) is written where it points, with the mode it had.
 */
export function patchFleetConfig(file: string, patch: Record<string, unknown>): void {
  const text = fs.readFileSync(file, 'utf8');
  parseConfig(text, file, FleetConfig);
  const next = JSON.stringify({ ...(JSON.parse(text) as object), ...patch }, null, 2);
  parseConfig(next, file, FleetConfig);
  const real = fs.realpathSync(file);
  const mode = fs.statSync(real).mode & 0o777;
  writeDurable(real, Buffer.from(`${next}\n`), { mode });
  // the umask narrows the mode a file is created with
  fs.chmodSync(real, mode);
}

/** Sets mainAgent in fleet.json, split out first if need be, as `patchFleetConfig` does. */
export function saveMainAgent(paths: Paths, agent: AgentKind): void {
  initConfig(paths);
  patchFleetConfig(paths.fleetConfig, { mainAgent: agent });
}

/** fleet.json as it stands now; an InvalidConfig says what in it is wrong. */
export function readFleetConfig(paths: Pick<Paths, 'fleetConfig'>): FleetConfig {
  return read(paths.fleetConfig, FleetConfig);
}

/** The gateway fleet.json names now: `archi host enable` names one, and `archi host remove` drops it, while the daemon runs. */
export function namedGateway(paths: Paths): MachineId | undefined {
  return readFleetConfig(paths).gatewayMachineId;
}

/** Names `id` this fleet's gateway in fleet.json and in the running config, which others hold by reference. */
export function setGateway(paths: Paths, config: Config, id: MachineId): void {
  if (config.gatewayMachineId === id) return;
  patchFleetConfig(paths.fleetConfig, { gatewayMachineId: id });
  config.gatewayMachineId = id;
}
