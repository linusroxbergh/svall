import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentKind, FleetConfig, FleetId, NodeConfig, RESERVED, type MachineId } from '@svall/protocol';
import { createDurable, writeDurable } from './handover/durable.js';
import { resolvePaths, type Paths } from './paths.js';
import { HOME_CWD, PRIVATE, profileHome, profileHomeCwd, profileOf, variantOf } from './profile.js';
import { variant } from './runtime.js';

const newFleetId = (): FleetId => FleetId.parse(crypto.randomUUID());

// Svall Dev keeps a port and a mission control folder of its own beside the release's
const FleetFile = FleetConfig.extend({ home: FleetConfig.shape.home.unwrap().extend({ cwd: z.string().default(HOME_CWD) }).prefault({}) });
// absent, DEFAULT_PORT, or a free port while another program holds that
export const NodeFile = NodeConfig.extend({ port: z.number().int().optional() });

type Raw = Record<string, unknown>;

// a config.json may name its fleet with a word svall has since kept for a command: that name is read as none, so the
// fleet goes by its default one
function unreserved(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !RESERVED.includes((raw as Raw).name as string)) return raw;
  const rest = { ...(raw as Raw) };
  delete rest.name;
  return rest;
}

/**
 * Every setting a running fleet reads, portable and machine-local side by side. It is also the shape
 * of the config.json the two files are split out of.
 */
export const Config = z.preprocess(unreserved, FleetFile.omit({ mobile: true })
  .merge(NodeFile.omit({ mobile: true }))
  .extend({
    id: FleetId.default(newFleetId),
    mobile: FleetConfig.shape.mobile.unwrap().merge(NodeConfig.shape.mobile.unwrap()).prefault({}),
  }));
export type Config = z.infer<typeof Config>;

/** The model fleet.json picks for each CLI of the crew or the scribe; a single scribe.model is scribe.agent's CLI's, else claude's. */
export function modelPicks(config: Pick<Config, 'home' | 'scribe'>, of: 'scribe' | 'home'): Partial<Record<AgentKind, string>> {
  if (of === 'home') return config.home.model ?? {};
  const { agent, model } = config.scribe;
  return typeof model === 'string' ? { [agent ?? 'claude']: model } : model ?? {};
}

export class InvalidConfig extends Error {}

// an integrations list in config.json leaves any agent but these on
const LISTED: AgentKind[] = ['claude', 'codex'];

/** The main agent of the fleet at `home`, whose own config names `own`: absent, the private fleet's, which setup switches
 *  when the user turns one off. */
export function fleetMainAgent(home: string, own: AgentKind | undefined): AgentKind | undefined {
  if (own || profileOf(home) === PRIVATE) return own;
  // a private config that does not parse is the private fleet's to report
  try { return configuredMainAgent(resolvePaths(profileHome(PRIVATE))); } catch { return undefined; }
}

// the agents left on: those agentsOff leaves out, else an integrations list's and any it never listed
const withIntegrations = <T extends Pick<Config, 'agentsOff' | 'integrations'>>(c: T): T => ({
  ...c,
  integrations: c.agentsOff ? AgentKind.options.filter((k) => !c.agentsOff!.includes(k))
    : c.integrations && AgentKind.options.filter((k) => c.integrations!.includes(k) || !LISTED.includes(k)),
});

export const mergeConfig = (fleet: FleetConfig, node: z.infer<typeof NodeFile>): Config =>
  withIntegrations({ ...fleet, ...node, mobile: { ...fleet.mobile, ...node.mobile } });

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

const readLegacy = (file: string): Config => withIntegrations(read(file, Config));

const only = (from: Raw, keys: string[]): Raw => Object.fromEntries(Object.entries(from).filter(([k]) => keys.includes(k)));

// each key the file held goes to the file whose schema knows it, and a key neither knows is dropped; what the file
// left out is left to the defaults as the new files are read
function splitLegacy(file: string): { fleet: Raw; node: Raw } {
  const text = fs.readFileSync(file, 'utf8');
  const { id } = parseConfig(text, file, Config);
  const raw = unreserved(JSON.parse(text)) as Raw;
  const mobile = (raw.mobile ?? {}) as Raw;
  const fleetMobile = only(mobile, Object.keys(FleetConfig.shape.mobile.unwrap().shape));
  const nodeMobile = only(mobile, Object.keys(NodeConfig.shape.mobile.unwrap().shape));
  return {
    fleet: { ...only(raw, Object.keys(FleetConfig.shape).filter((k) => k !== 'mobile')), id, ...(Object.keys(fleetMobile).length && { mobile: fleetMobile }) },
    node: { ...only(raw, Object.keys(NodeConfig.shape).filter((k) => k !== 'mobile')), ...(Object.keys(nodeMobile).length && { mobile: nodeMobile }) },
  };
}

/** Whether config.json is a link to the file config.json.bak is, as a dotfile manager (stow, home-manager) puts back
 *  the link the split moved aside: it is not read, and refuses nothing. */
export function configRelinked(paths: Pick<Paths, 'legacyConfig'>): boolean {
  try {
    return fs.lstatSync(paths.legacyConfig).isSymbolicLink() && fs.realpathSync(paths.legacyConfig) === fs.realpathSync(`${paths.legacyConfig}.bak`);
  } catch {
    return false;
  }
}

/** Why the config files that `has` finds are no layout a fleet can start on, before any of them is read. */
export function configRefusal(paths: Pick<Paths, 'legacyConfig' | 'fleetConfig'>, has: (file: string) => boolean): string | undefined {
  if (!has(paths.legacyConfig) || has(paths.fleetConfig) || configRelinked(paths)) return undefined;
  const backup = `${paths.legacyConfig}.bak`;
  if (has(backup)) return `${backup} is in the way of putting ${paths.legacyConfig} beside the new files. Keep whichever of the two you want, delete the other, and start again.`;
  return undefined;
}

/** Whether a config.json lies beside fleet.json, as an older release's setup writes one, for the next split to move aside unread. */
export const configStray = (paths: Pick<Paths, 'legacyConfig' | 'fleetConfig'>, has: (file: string) => boolean): boolean =>
  has(paths.legacyConfig) && has(paths.fleetConfig) && !configRelinked(paths);

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Writes whichever of the two config files this fleet is missing, out of its config.json when it
 * still has one, and returns the files written. An unreadable config.json stops it before any write.
 * A config.json beside fleet.json is moved aside unread, and `say` told where.
 */
export function initConfig(paths: Paths, seed: Partial<NodeConfig> = {}, say: (line: string) => void = () => {}): string[] {
  const has = (file: string): boolean => fs.existsSync(file);
  const backup = `${paths.legacyConfig}.bak`;
  // a config.json is put beside the new files byte-exact before anything is read out of it, so the
  // only file the split ever reads is one nothing edits any more; one another start moves first is that start's to split
  if (configStray(paths, has)) {
    const aside = `${paths.legacyConfig}.unread-${Date.now()}`;
    try {
      fs.renameSync(paths.legacyConfig, aside);
      say(`${paths.legacyConfig} moved to ${aside} unread: this fleet's settings are in ${paths.fleetConfig} and ${paths.nodeConfig}; copy anything you still want from it into them`);
    } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
  } else if (has(paths.legacyConfig) && !configRelinked(paths)) {
    const refused = configRefusal(paths, has);
    // the backup another start has just made is no refusal
    if (refused && has(paths.legacyConfig)) throw new InvalidConfig(refused);
    try {
      read(paths.legacyConfig, Config); // one the schema rejects is left where its owner put it
      fs.renameSync(paths.legacyConfig, backup);
    } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
  }
  const wrote: string[] = [];
  const split = has(backup) && !has(paths.fleetConfig) ? splitLegacy(backup) : undefined;
  if (split || !has(paths.nodeConfig)) {
    writeDurable(paths.nodeConfig, split?.node ?? seed);
    wrote.push(paths.nodeConfig);
  }
  // last, so a fleet.json is only ever there once the split behind it is whole; and never replaced, so two starts run on one id
  if (!has(paths.fleetConfig)) {
    // a profile that has never run gets a mission control folder of its own; one that has keeps the folder its crew is in
    const cwd = has(paths.state) ? undefined : profileHomeCwd(paths.home);
    try {
      createDurable(paths.fleetConfig, split?.fleet ?? { id: newFleetId(), ...(cwd && { home: { cwd } }) }, { mode: 0o600 });
      wrote.push(paths.fleetConfig);
    } catch (e) { if (errno(e) !== 'EEXIST') throw e; }
  }
  return wrote;
}

export function loadConfig(paths: Paths, say?: (line: string) => void): Config {
  if (!fs.existsSync(paths.home)) return Config.parse({});
  initConfig(paths, {}, say);
  return mergeConfig(read(paths.fleetConfig, FleetFile), read(paths.nodeConfig, NodeFile));
}

/** What fleet.json and node.json hold, or the config.json they are still to be split out of; nothing is split or written. */
export function peekConfig(paths: Paths): Config {
  if (!fs.existsSync(paths.fleetConfig)) return fs.existsSync(paths.legacyConfig) ? readLegacy(paths.legacyConfig) : Config.parse({});
  return mergeConfig(read(paths.fleetConfig, FleetFile), fs.existsSync(paths.nodeConfig) ? read(paths.nodeConfig, NodeFile) : NodeFile.parse({}));
}

/** The main agent fleet.json names, or the config.json it is still to be split out of; nothing is split or written. */
export function configuredMainAgent(paths: Paths): AgentKind | undefined {
  if (fs.existsSync(paths.fleetConfig)) return read(paths.fleetConfig, FleetConfig).mainAgent;
  return fs.existsSync(paths.legacyConfig) ? read(paths.legacyConfig, Config).mainAgent : undefined;
}

/** The phone ports the fleets at `homes` keep in their config. */
export const keptPorts = (homes: string[]): number[] => homes.flatMap((h) => {
  try { const p = peekConfig(resolvePaths(h)).mobile.httpsPort; return p ? [p] : []; } catch { return []; }
});

/**
 * Each fleet home in `homedir` whose config.json, or the backup its split left, named the fleet with a word svall now
 * keeps for a command, while its fleet.json names it nothing else.
 */
export function reservedFleetNames(homedir: string): { home: string; name: string }[] {
  const json = (file: string): Raw | undefined => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Raw; } catch { return undefined; } };
  let entries: string[];
  try { entries = fs.readdirSync(homedir).sort(); } catch { return []; }
  return entries.filter((f) => variantOf(f) === variant).flatMap((f) => {
    const p = resolvePaths(path.join(homedir, f));
    const name = (json(p.legacyConfig) ?? json(`${p.legacyConfig}.bak`))?.name;
    return typeof name === 'string' && RESERVED.includes(name) && json(p.fleetConfig)?.name === undefined ? [{ home: p.home, name }] : [];
  });
}

/**
 * Sets the keys `patch` names in `file`, drops those it names as undefined, merges an object a level down, and keeps every
 * other key as the file held it. A file that does not parse, or would not after the change, is refused, not replaced.
 * A linked file (stow, home-manager) is written where it points, with the mode it had.
 */
function patchConfigFile(file: string, schema: z.ZodTypeAny, patch: Raw): void {
  const text = fs.readFileSync(file, 'utf8');
  parseConfig(text, file, schema);
  const json = JSON.parse(text) as Raw;
  const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
  const merged = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, isObject(v) && isObject(json[k]) ? { ...json[k], ...v } : v]));
  const next = JSON.stringify({ ...json, ...merged }, null, 2);
  parseConfig(next, file, schema);
  const real = fs.realpathSync(file);
  const mode = fs.statSync(real).mode & 0o777;
  writeDurable(real, Buffer.from(`${next}\n`), { mode });
  // the umask narrows the mode a file is created with
  fs.chmodSync(real, mode);
}

/** Sets the keys `patch` names in a fleet.json, as `patchConfigFile` does. */
export const patchFleetConfig = (file: string, patch: Raw): void => patchConfigFile(file, FleetConfig, patch);

export type ConfigPatch = Partial<Pick<Config, 'mainAgent' | 'name' | 'integrations' | 'defaultCwd'>>
  & { mobile?: Pick<Config['mobile'], 'httpsPort'>; home?: Pick<Config['home'], 'model'>; scribe?: Pick<Config['scribe'], 'model'> };

/** Sets each key of `patch` in fleet.json or node.json, whichever holds it, split out first if need be; `say` as for `initConfig`. */
export function saveConfig(paths: Paths, patch: ConfigPatch, say?: (line: string) => void): void {
  fs.mkdirSync(paths.home, { recursive: true });
  initConfig(paths, {}, say);
  const { integrations, mobile, ...fleet } = patch;
  if (Object.keys(fleet).length) patchFleetConfig(paths.fleetConfig, fleet);
  // integrations are saved as agentsOff, which replaces an integrations list
  const off = integrations && AgentKind.options.filter((k) => !integrations.includes(k));
  const node = { ...('integrations' in patch && { integrations: undefined, agentsOff: off }), ...(mobile && { mobile }) };
  if (Object.keys(node).length) patchConfigFile(paths.nodeConfig, NodeConfig, node);
}

/** Sets mainAgent in fleet.json, split out first if need be. */
export function saveMainAgent(paths: Paths, agent: AgentKind, say?: (line: string) => void): void {
  saveConfig(paths, { mainAgent: agent }, say);
}

/** fleet.json as it stands now; an InvalidConfig says what in it is wrong. */
export function readFleetConfig(paths: Pick<Paths, 'fleetConfig'>): FleetConfig {
  return read(paths.fleetConfig, FleetConfig);
}

/** The gateway fleet.json names now: `svall host enable` names one, and `svall host remove` drops it, while the daemon runs. */
export function namedGateway(paths: Paths): MachineId | undefined {
  return readFleetConfig(paths).gatewayMachineId;
}

/** Names `id` this fleet's gateway, or with none no gateway, in fleet.json and in the running config, which others hold by reference. */
export function setGateway(paths: Paths, config: Config, id: MachineId | undefined): void {
  if (config.gatewayMachineId === id) return;
  patchFleetConfig(paths.fleetConfig, { gatewayMachineId: id });
  config.gatewayMachineId = id;
}
