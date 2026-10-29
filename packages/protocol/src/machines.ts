import { z } from 'zod';
import { isProfileName } from './names.js';
import { FleetId, MachineId, MachinePath } from './ids.js';
import { AgentKind, DEFAULT_CWD, Home } from './state.js';

// records name machines and fleets by these ids, not by names such as `trift`, so renaming a host leaves every record alone
export { FleetId, MachineId, ObjectName, Sha256 } from './ids.js';

/**
 * One machine in the controller's registry; one reached directly has no `ssh`. `ssh` is held to a token that cannot read
 * as an ssh option; paths may hold anything, and are quoted where a remote command is built.
 */
export const MachineRecord = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, starting with a letter'),
  ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/, 'an ssh destination, starting with a letter or a digit').optional(),
  platform: z.enum(['darwin', 'linux']),
  arch: z.string(),
  home: MachinePath,
  svallBase: MachinePath,
});
export type MachineRecord = z.infer<typeof MachineRecord>;

// a model for each CLI it names, picked in Settings or written here
const ModelPicks = z.partialRecord(AgentKind, z.string());

/** fleet.json: the fleet's own settings. */
export const FleetConfig = z.object({
  id: FleetId,
  // what the app and `svall <name>` call the fleet; absent, its directory names it
  name: z.string().refine(isProfileName, 'use lowercase letters, digits and dashes, starting with a letter, and no svall command or dev name, which Svall Dev keeps').optional(),
  // with no command, the crew starts the main agent's crewCommand on that CLI's model in home.model; offered names the
  // buttons svalld has offered once, with their rules in the crew's settings, so one the user deletes stays deleted
  home: Home.extend({ command: z.string().optional(), model: ModelPicks.optional(), offered: z.array(z.string()).optional() }).prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the agent the scribe, mission control's crew and `svall robot new --run` use by default; absent, the private fleet's, else
  // claude, unless only other agents are installed
  mainAgent: AgentKind.optional(),
  // which plan a scribe pass spends; absent, the main agent's. model is one per CLI, or one of scribe.agent's CLI, else of claude's
  scribe: z.object({ agent: AgentKind.optional(), model: z.union([z.string(), ModelPicks]).optional() }).prefault({}),
  linear: z.object({ workspace: z.string(), teamKeys: z.array(z.string()) }).optional(),
  // what a retro leaves out (repos by path, islands by id or name), the repos whose sessions no fleet recorded it reads,
  // the models it reads, judges and verifies with on each CLI, and the skills it reads as reviews beside those named for one
  retro: z.object({
    exclude: z.object({ repos: z.array(z.string()).default([]), islands: z.array(z.string()).default([]) }).prefault({}),
    unrecorded: z.array(z.string()).default([]),
    model: z.partialRecord(AgentKind, z.object({ read: z.string().optional(), judge: z.string().optional(), verify: z.string().optional() })).optional(),
    reviewSkills: z.array(z.string()).optional(),
  }).prefault({}),
  mobile: z.object({
    // the tailnet logins that may drive the fleet and get its pushes; empty lets in only the Mac's own login
    logins: z.array(z.string()).default([]),
    // page origins allowed to open a socket, beyond the one svalld itself served
    origins: z.array(z.string()).default([]),
    // who a push service may contact about this sender: Apple refuses a push without one; unset, the served page
    pushContact: z.string().regex(/^(https:\/\/|mailto:)./, 'an https: url or mailto: address').optional(),
  }).prefault({}),
});
export type FleetConfig = z.infer<typeof FleetConfig>;

/** node.json: what belongs to this machine. */
export const NodeConfig = z.object({
  port: z.number().int().default(47800),
  host: z.string().default('127.0.0.1'),
  shell: z.string().optional(),
  // the agents setup turned off; any other agent found is on
  agentsOff: z.array(AgentKind).optional(),
  // the agents whose hooks setup installs; absent, every agent found. Read from agentsOff, else from an integrations list
  integrations: z.array(AgentKind).optional(),
  mobile: z.object({
    // the https port this fleet is reached on, which svalld saves once it serves there
    httpsPort: z.number().int().min(1).max(65535).optional(),
  }).prefault({}),
});
export type NodeConfig = z.infer<typeof NodeConfig>;

/** An agent CLI as a machine finds it: no `version` means not installed; `sandbox`, why it cannot sandbox its agent's commands, with the fix. */
export const AgentAdapter = z.object({
  kind: AgentKind, version: z.string().optional(), adapter: z.number().int().nonnegative(), home: z.string().optional(),
  loggedIn: z.boolean().optional(), hooks: z.boolean().optional(), sandbox: z.string().optional(),
});
export type AgentAdapter = z.infer<typeof AgentAdapter>;

/** What a machine is, and every version the machines of a fleet have to agree on. */
export const SystemInfo = z.object({
  machineId: MachineId,
  release: z.string(),
  protocol: z.number().int(),
  stateSchema: z.number().int(),
  platform: z.enum(['darwin', 'linux']),
  arch: z.string(),
  agentAdapters: z.array(AgentAdapter),
  // `git --version`'s number; absent where git cannot run
  git: z.string().optional(),
  // whether a Linux account's services run while no one is logged in; absent on a Mac, or where loginctl cannot say
  linger: z.object({ user: z.string(), on: z.boolean() }).optional(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;
