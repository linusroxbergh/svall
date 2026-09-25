import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { FleetConfig, FleetId, NodeConfig, type AgentKind, type MachineId } from '@archipelago/protocol';
import { writeJsonAtomic } from './atomic.js';
import { writeAtomic } from './jsonfile.js';
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

function splitLegacy(file: string): { fleet: FleetConfig; node: NodeConfig } {
  const { id, host, port, shell, mobile, ...portable } = read(file, Config);
  return {
    fleet: FleetConfig.parse({ ...portable, id, mobile }),
    node: NodeConfig.parse({ host, port, shell, mobile }),
  };
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
    if (has(paths.fleetConfig)) {
      throw new Error(`${paths.legacyConfig} is not read any more: this fleet's settings are in ${paths.fleetConfig} and ${paths.nodeConfig}. Move anything you still want from it into them and delete it.`);
    }
    if (has(backup)) {
      throw new Error(`${backup} is in the way of putting ${paths.legacyConfig} beside the new files. Keep whichever of the two you want, delete the other, and start again.`);
    }
    read(paths.legacyConfig, Config); // one the schema rejects is left where its owner put it
    fs.renameSync(paths.legacyConfig, backup);
  }
  const wrote: string[] = [];
  const split = has(backup) && !has(paths.fleetConfig) ? splitLegacy(backup) : undefined;
  if (split || !has(paths.nodeConfig)) {
    writeJsonAtomic(paths.nodeConfig, split?.node ?? NodeConfig.parse(seed));
    wrote.push(paths.nodeConfig);
  }
  // last, so a fleet.json is only ever there once the split behind it is whole
  if (!has(paths.fleetConfig)) {
    writeJsonAtomic(paths.fleetConfig, split?.fleet ?? FleetConfig.parse({ id: newFleetId() }));
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

/** Sets mainAgent in fleet.json, split out first if need be, and keeps every other key; a file that does not parse
 *  is refused, not replaced. A linked file (stow, home-manager) is written where it points, with the mode it had. */
export function saveMainAgent(paths: Paths, agent: AgentKind): void {
  initConfig(paths);
  const file = paths.fleetConfig;
  const text = fs.readFileSync(file, 'utf8');
  parseConfig(text, file, FleetConfig);
  const real = fs.realpathSync(file);
  const mode = fs.statSync(real).mode & 0o777;
  writeAtomic(real, JSON.stringify({ ...(JSON.parse(text) as object), mainAgent: agent }, null, 2) + '\n', { mode, perProcess: true });
  // the umask narrows the mode a file is created with
  fs.chmodSync(real, mode);
}

/** The gateway fleet.json names now: `archi host enable` names one, and `archi host remove` drops it, while the daemon runs. */
export function namedGateway(paths: Paths): MachineId | undefined {
  return read(paths.fleetConfig, FleetConfig).gatewayMachineId;
}

/** Names `id` this fleet's gateway in fleet.json and in the running config, which others hold by reference. */
export function setGateway(paths: Paths, config: Config, id: MachineId): void {
  if (config.gatewayMachineId === id) return;
  writeJsonAtomic(paths.fleetConfig, { ...read(paths.fleetConfig, FleetConfig), gatewayMachineId: id });
  config.gatewayMachineId = id;
}
