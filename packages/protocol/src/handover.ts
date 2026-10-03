import { z } from 'zod';
import { isProfileName } from './names.js';
import { AgentKind, DEFAULT_CWD, FleetState, Home } from './state.js';

// names such as `trift` and `local` route and present; only these ids decide ownership, so renaming
// a host leaves every record alone
export const MachineId = z.guid().brand<'MachineId'>();
export type MachineId = z.infer<typeof MachineId>;
export const FleetId = z.guid().brand<'FleetId'>();
export type FleetId = z.infer<typeof FleetId>;

/** A sha256 digest as lowercase hex: what names a transfer manifest on the wire. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hex digest');

/**
 * A handover in flight: at most one per fleet, and the gateway is the only writer. The freeze and the
 * digest arrive together, and are what a `ready-to-commit` transaction was granted on.
 */
export const TransactionRecord = z.object({
  id: z.string().min(1),
  fromMachineId: MachineId,
  toMachineId: MachineId,
  phase: z.enum(['preparing', 'ready-to-commit', 'committed']),
  startedAt: z.number(),
  sourceFrozenAt: z.number().optional(),
  preparedDigest: Sha256.optional(),
});
export type TransactionRecord = z.infer<typeof TransactionRecord>;

/** The version of the ownership records a machine writes and reads. */
export const AUTHORITY_SCHEMA_VERSION = 1;

/** Which machine may run a fleet, at which generation. The gateway swaps it on generation and owner. */
export const OwnerRecord = z.object({
  fleetId: FleetId,
  generation: z.number().int().nonnegative(),
  ownerMachineId: MachineId,
  transaction: TransactionRecord.optional(),
});
export type OwnerRecord = z.infer<typeof OwnerRecord>;

/** A path a command can be built from: an absolute one, naming itself and nothing else. */
export const MachinePath = z.string()
  .regex(/^\/[^\0\n]*$/, 'an absolute path with no NUL or newline')
  .refine((p) => !p.split('/').includes('..'), 'an absolute path that climbs nowhere');

/** A Git object by its full name, SHA-1 or SHA-256, which git never reads as an option. */
export const ObjectName = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'a full hex object name');

/**
 * One machine in the controller's registry. A machine reached directly has no `ssh`.
 *
 * An ssh destination becomes an argument of the controller's own ssh command, so it is held to a
 * token that cannot read as an option. A path holds whatever a filesystem holds, spaces and all;
 * what keeps it out of a remote shell's hands is the quoting where the command is built.
 */
export const MachineRecord = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, starting with a letter'),
  ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/, 'an ssh destination, starting with a letter or a digit').optional(),
  platform: z.enum(['darwin', 'linux']),
  arch: z.string(),
  home: MachinePath,
  svallBase: MachinePath,
  gateway: z.boolean(),
});
export type MachineRecord = z.infer<typeof MachineRecord>;

/** fleet.json: everything that travels with the fleet when it moves to another machine. */
export const FleetConfig = z.object({
  id: FleetId,
  // what the app and `svall <name>` call the fleet; absent, its directory names it
  name: z.string().refine(isProfileName, 'use lowercase letters, digits and dashes, starting with a letter, and no svall command or dev name, which Svall Dev keeps').optional(),
  gatewayMachineId: MachineId.optional(),
  // with no command, the crew starts the main agent's crewCommand
  home: Home.extend({ command: z.string().optional() }).prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the agent the scribe, mission control's crew and `svall char new --run` use by default; absent, the private fleet's, else
  // the only one installed, else claude
  mainAgent: AgentKind.optional(),
  // which plan a scribe pass spends; absent, the main agent's. model names a model of scribe.agent's CLI, else of claude's
  scribe: z.object({ agent: AgentKind.optional(), model: z.string().optional() }).prefault({}),
  linear: z.object({ workspace: z.string(), teamKeys: z.array(z.string()) }).optional(),
  mobile: z.object({
    // the tailnet logins that may drive the fleet and get its pushes; empty lets in only the Mac's own login
    logins: z.array(z.string()).default([]),
    // page origins allowed to open a socket, beyond the one svalld itself served
    origins: z.array(z.string()).default([]),
    // who a push service may contact about this sender: Apple refuses a push without one; unset, the served page
    pushContact: z.string().regex(/^(https:\/\/|mailto:)./, 'an https: url or mailto: address').optional(),
  }).prefault({}),
  // `exclude` adds to the default list; `excludeDefaults: false` is the explicit way to replace it
  handover: z.object({
    enabled: z.boolean().default(false),
    exclude: z.array(z.string()).default([]),
    excludeDefaults: z.boolean().default(true),
    transferFleetEnv: z.boolean().default(false),
  }).prefault({}),
});
export type FleetConfig = z.infer<typeof FleetConfig>;

/** node.json: what belongs to this machine and stays behind when the fleet moves. */
export const NodeConfig = z.object({
  port: z.number().int().default(47800),
  host: z.string().default('127.0.0.1'),
  shell: z.string().optional(),
  // the agents whose hooks setup installs; absent, every agent found
  integrations: z.array(AgentKind).optional(),
  mobile: z.object({
    // the https port this fleet is reached on, which svalld saves once it serves there
    httpsPort: z.number().int().min(1).max(65535).optional(),
  }).prefault({}),
});
export type NodeConfig = z.infer<typeof NodeConfig>;

export const Generation = z.number().int().nonnegative();
export const TransactionId = z.string().min(1);

/** What a blocker, a warning or a progress report is about. */
export const HandoverEntityKind = z.enum(['character', 'root', 'session', 'git']);
export type HandoverEntityKind = z.infer<typeof HandoverEntityKind>;
export const HandoverEntity = z.object({ kind: HandoverEntityKind, id: z.string().min(1) });
export type HandoverEntity = z.infer<typeof HandoverEntity>;

/** The steps of the state machine, in order, and the end an abort leaves behind. */
export const HANDOVER_PHASES = ['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete', 'aborted'] as const;
export const HandoverPhase = z.enum(HANDOVER_PHASES);
export type HandoverPhase = z.infer<typeof HandoverPhase>;

// one code per way preflight or freeze refuses, plus the heuristics that only advise
export const HandoverIssueCode = z.enum([
  'identity_mismatch', 'generation_mismatch', 'transaction_open',
  'incompatible_release', 'incompatible_protocol', 'incompatible_schema', 'incompatible_adapter',
  'agent_cli_missing', 'agent_logged_out', 'agent_hooks_missing',
  'home_mismatch', 'parent_missing', 'character_pinned', 'shell_busy', 'agent_working', 'agent_blocked', 'agent_unsettled',
  'worktree_unresolved', 'destination_diverged', 'destination_occupied', 'destination_no_space', 'path_collision', 'path_unsupported', 'path_symlinked', 'mission_control_shared',
  'transcript_missing', 'ssh_interactive', 'platform_unsupported', 'platform_heuristic', 'env_file', 'credential_file', 'external_writer', 'rsync_unsupported',
  'git_mismatch', 'worktree_unused', 'remote_local', 'git_extension', 'codex_trust', 'claude_trust', 'claude_bypass', 'config_difference', 'symlink_dangling', 'manifest_too_large',
  'too_many_files',
]);
export type HandoverIssueCode = z.infer<typeof HandoverIssueCode>;

/** One reason a handover cannot start or continue. */
export const Blocker = z.object({ code: HandoverIssueCode, message: z.string(), entity: HandoverEntity.optional() });
export type Blocker = z.infer<typeof Blocker>;
/** One condition the user should know about that does not stop the handover. */
export const Warning = Blocker;
export type Warning = z.infer<typeof Warning>;

/** What preflight counts in the manifest it built. */
export const ManifestSummary = z.object({
  digest: Sha256,
  roots: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type ManifestSummary = z.infer<typeof ManifestSummary>;

/** What the user or `svall` chose about terminals that are not at rest. `terminateShells` may name characters. */
export const HandoverChoices = z.object({
  interruptAfterMs: z.number().int().nonnegative().optional(),
  terminateShells: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  archiveRoots: z.array(z.string().min(1)).optional(),
});
export type HandoverChoices = z.infer<typeof HandoverChoices>;

/** The version of the transfer manifest a machine writes and reads. */
export const TRANSFER_SCHEMA_VERSION = 1;

/** One file of a transfer as the source scanned it, by its path under its root. A link is carried as its text, never followed. */
export const TransferFile = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'), path: z.string(),
    mode: z.number().int().nonnegative(), size: z.number().int().nonnegative(), mtimeMs: z.number().int(), sha256: Sha256,
    // a Git index by its staged entries alone, so a refresh of its stat data changes nothing
    gitIndex: Sha256.optional(),
  }),
  z.object({ type: z.literal('symlink'), path: z.string(), target: z.string() }),
]);
export type TransferFile = z.infer<typeof TransferFile>;

/**
 * One filesystem root of the transfer, at the path it has on both machines. A folded root lies inside a root
 * that carries its files, and stays listed so the Git import still checks a worktree among them.
 */
export const TransferRoot = z.object({
  id: z.string().min(1),
  // `gitdir` is a common Git directory outside any checkout it serves, which no exclude reaches into; `docs` and
  // `profiles` are the entity docs and agent profiles in the fleet home
  kind: z.enum(['repo', 'worktree', 'gitdir', 'cwd', 'home', 'context', 'env', 'docs', 'profiles']),
  entry: z.enum(['dir', 'file']),
  path: z.string(),
  foldedInto: z.string().min(1).optional(),
  files: z.array(TransferFile),
});
export type TransferRoot = z.infer<typeof TransferRoot>;

/** One agent session, copied exactly: the transcript its terminal recorded and the files its adapter found with it. */
export const TransferSession = z.object({
  characterId: z.string().min(1),
  term: z.literal(2).optional(),
  agent: AgentKind,
  sessionId: z.string().min(1),
  sourcePath: z.string(),
  // the transcript on the destination: the same path under that machine's agent home
  destinationPath: z.string().optional(),
  // the agent home each machine keeps the session under, and the adapter that reads it; `files` are named under the source home
  sourceHome: z.string().optional(),
  destinationHome: z.string().optional(),
  adapter: z.number().int().positive().optional(),
  files: z.array(TransferFile),
});
export type TransferSession = z.infer<typeof TransferSession>;

/**
 * A checkout of a carried repository graph as the source read it, by its source path. `head` is null on
 * an unborn branch and `branch` null on a detached HEAD; `locked` holds the lock's reason, '' for none.
 */
export const GitCheckout = z.object({
  path: z.string(),
  gitDir: z.string(),
  head: ObjectName.nullable(),
  branch: z.string().nullable(),
  locked: z.string().optional(),
  // porcelain v2 entries for tracked paths, and the digest of every staged entry
  status: z.array(z.string()),
  index: Sha256,
  characters: z.array(z.string()),
});
export type GitCheckout = z.infer<typeof GitCheckout>;

/** A registered worktree no character uses. Its branch travels in the common directory; its registration does not. */
export const GitRegistration = z.object({
  path: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  locked: z.string().optional(),
  prunable: z.boolean(),
});
export type GitRegistration = z.infer<typeof GitRegistration>;

/** One repository graph: its common Git directory, its main checkout unless it is bare, and the linked worktrees the fleet uses. */
export const GitGraph = z.object({
  id: z.string().min(1),
  commonDir: z.string(),
  main: GitCheckout.optional(),
  worktrees: z.array(GitCheckout),
  unused: z.array(GitRegistration),
  // stash entries, newest first
  stash: z.array(ObjectName),
  // the object every ref names, and so every commit the copy of its objects holds reachable
  tips: z.array(ObjectName).optional(),
});
export type GitGraph = z.infer<typeof GitGraph>;

/** The immutable inventory a handover copies from, and the state that describes it. A preflight's names no transaction. */
export const TransferManifestV1 = z.object({
  version: z.literal(TRANSFER_SCHEMA_VERSION),
  transactionId: TransactionId.optional(),
  generation: Generation,
  fromMachineId: MachineId,
  toMachineId: MachineId,
  // the home path both machines share
  home: MachinePath,
  fleet: FleetConfig,
  snapshot: FleetState,
  excludes: z.array(z.string()),
  roots: z.array(TransferRoot),
  sessions: z.array(TransferSession),
  git: z.array(GitGraph).optional(),
});
export type TransferManifestV1 = z.infer<typeof TransferManifestV1>;

/** A graph a manifest carries as the machine it goes to reads it: its common directory there, the registrations the manifest carries, and every commit its copy holds reachable. */
export const ReceivedGraph = z.object({ id: z.string().min(1), commonDir: MachinePath, carried: z.array(z.string()), tips: z.array(ObjectName) });
export type ReceivedGraph = z.infer<typeof ReceivedGraph>;

/**
 * The folder a carried session's agent resumes in on the destination, the main checkout of the repository holding it, the
 * top of the checkout it is in, and whether its resume starts the agent in bypass mode.
 */
export const ResumeFolder = z.object({ kind: AgentKind, cwd: z.string(), repo: z.string().optional(), root: z.string().optional(), bypass: z.boolean().optional() });
export type ResumeFolder = z.infer<typeof ResumeFolder>;

/** A worktree that stays on the destination, at a commit that machine cannot prove the copy coming back holds. */
export const KeptCommit = z.object({ graph: z.string().min(1), path: z.string(), commit: ObjectName });
export type KeptCommit = z.infer<typeof KeptCommit>;

/** A commit, and the common directory on the source whose refs may reach it. */
export const CommitAt = z.object({ commonDir: MachinePath, commit: ObjectName });
export type CommitAt = z.infer<typeof CommitAt>;

/** A carried root as the destination sees it: `path` is where it lies there. */
export const ReplicaRootSpec = z.object({ id: z.string().min(1), kind: TransferRoot.shape.kind, entry: TransferRoot.shape.entry, path: z.string() });
export type ReplicaRootSpec = z.infer<typeof ReplicaRootSpec>;

/** Whether a transaction may write a root, and where: the only path rsync may write it at, `--delete` included. */
export const ReplicaCheck = z.union([
  z.object({ ok: z.literal(true), path: z.string(), kind: z.enum(['absent', 'resume', 'replica']) }),
  z.object({ ok: z.literal(false), path: z.string(), blocker: Blocker }),
]);
export type ReplicaCheck = z.infer<typeof ReplicaCheck>;

/**
 * The destination's claim on one root, and the excludes it proved the root under, which are the ones rsync runs with.
 * `keep` names the folders under the root that stay as they are here, the registrations of worktrees that stay on this machine.
 */
export const RootClaim = z.object({
  id: z.string().min(1), excludes: z.array(z.string()), check: ReplicaCheck, archivedTo: z.string().optional(), keep: z.array(z.string()).optional(),
});
export type RootClaim = z.infer<typeof RootClaim>;

/** What one destination folder is good for: somewhere to write, how much room, and whether names that differ by case fold together. */
export const RootProbe = z.object({
  exists: z.boolean(), writable: z.boolean(), caseInsensitive: z.boolean(), freeBytes: z.number().nonnegative(),
});
export type RootProbe = z.infer<typeof RootProbe>;

/** What the controller's transfer verified in one carried root, by root id: its files as they landed. */
export const LandedRoot = z.object({ id: z.string().min(1), files: z.array(TransferFile) });
export type LandedRoot = z.infer<typeof LandedRoot>;

/** The open transaction as the journals see it: the gateway's record at the controller's phase. */
export const HandoverTransactionStatus = TransactionRecord.extend({ phase: HandoverPhase });
export type HandoverTransactionStatus = z.infer<typeof HandoverTransactionStatus>;

/** A handover journal a machine holds open; `generation` is the one the handover moves the fleet to. */
export const JournalInfo = z.object({
  role: z.enum(['source', 'destination']),
  transactionId: TransactionId,
  generation: Generation,
  phase: HandoverPhase,
});
export type JournalInfo = z.infer<typeof JournalInfo>;

/** Which machine holds the fleet, at which generation, and whether it still accepts mutations. */
export const OwnershipInfo = z.object({
  fleetId: FleetId,
  generation: Generation,
  ownerMachineId: MachineId,
  frozen: z.boolean(),
  transaction: TransactionRecord.optional(),
  surrendered: z.boolean().optional(),
  journal: JournalInfo.optional(),
});
export type OwnershipInfo = z.infer<typeof OwnershipInfo>;

/**
 * An installed agent CLI, the session adapter that reads its files, where it keeps them, and whether it is
 * logged in with Svall's hooks in. A missing `version` is a CLI that is not installed.
 */
export const AgentAdapter = z.object({
  kind: AgentKind, version: z.string().optional(), adapter: z.number().int().nonnegative(), home: z.string().optional(),
  loggedIn: z.boolean().optional(), hooks: z.boolean().optional(),
});
export type AgentAdapter = z.infer<typeof AgentAdapter>;

/** What a machine is, and every version a handover has to agree on. */
export const SystemInfo = z.object({
  machineId: MachineId,
  release: z.string(),
  protocol: z.number().int(),
  stateSchema: z.number().int(),
  transferSchema: z.number().int(),
  platform: z.enum(['darwin', 'linux']),
  arch: z.string(),
  agentAdapters: z.array(AgentAdapter),
  // `git --version`'s number; absent where git cannot run
  git: z.string().optional(),
  // the daemon's V8 heap_size_limit in bytes, which bounds the files a handover may carry
  heapLimit: z.number().int().positive().optional(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

/**
 * What the controller knows of a handover's two machines and a source daemon cannot: each machine's home from
 * its registry, the destination's fleet home, and what the destination said of itself.
 */
export const HandoverMachines = z.object({
  source: z.object({ home: MachinePath }),
  destination: z.object({ info: SystemInfo, home: MachinePath, fleetHome: MachinePath }),
});
export type HandoverMachines = z.infer<typeof HandoverMachines>;

/** Why the daemon refused a handover call. */
export const HandoverError = z.discriminatedUnion('code', [
  z.object({ code: z.literal('not_owner'), message: z.string(), ownerMachineId: MachineId, generation: Generation }),
  z.object({ code: z.literal('frozen'), message: z.string(), transactionId: TransactionId.optional() }),
  z.object({ code: z.literal('handover_committed'), message: z.string(), transactionId: TransactionId, generation: Generation }),
  z.object({ code: z.literal('not_ready'), message: z.string() }),
  z.object({ code: z.literal('generation_mismatch'), message: z.string(), expected: Generation, actual: Generation }),
  z.object({ code: z.literal('transaction_mismatch'), message: z.string(), expected: TransactionId.optional(), actual: TransactionId.optional() }),
  z.object({ code: z.literal('blocked'), message: z.string(), blockers: z.array(Blocker) }),
  // the gateway could not be asked, so nothing that needs its word was done
  z.object({ code: z.literal('authority_unreachable'), message: z.string() }),
]);
export type HandoverError = z.infer<typeof HandoverError>;

/** A `HandoverError` as something a handler throws: the code and the fields beyond `message` survive as the error frame's `data`. */
export const handoverError = (e: HandoverError): Error & { code: string; data: Record<string, unknown> } => {
  const { code, message, ...data } = e;
  return Object.assign(new Error(message), { code, data: data as Record<string, unknown> });
};
