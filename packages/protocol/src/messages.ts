import type { Operation } from 'fast-json-patch';
import { z } from 'zod';
import {
  Blocker, Generation, HandoverChoices, HandoverEntityKind, HandoverMachines, HandoverPhase, HandoverTransactionStatus, LandedRoot, MachineId,
  CommitAt, KeptCommit, ManifestSummary, OwnerRecord, OwnershipInfo, MachinePath, ReceivedGraph, ReplicaCheck, ReplicaRootSpec, ResumeFolder, RootClaim, RootProbe, Sha256, SystemInfo, TransactionId, TransferManifestV1,
  TransferRoot, Warning,
} from './handover.js';
import { Portrait } from './portraits.js';
import { AgentKind, AgentStatus, BrowserTab, Cell, Character, ContextItem, FleetState, Island, Size } from './state.js';

const Id = z.object({ id: z.string() });
const TermSize = z.object({ cols: z.number().int().min(2), rows: z.number().int().min(1) });
// which of a character's terminals a call means; absent, the main one
export const Term = z.literal(2).optional();
export type Term = z.infer<typeof Term>;

// what a request may ask for; the state keeps what it holds, so an island or a tab stored larger still loads
export const MAX_SIDE = 200;
export const MAX_URL = 1024 * 1024;
const NewSize = z.object({ w: Size.shape.w.max(MAX_SIDE), h: Size.shape.h.max(MAX_SIDE) });
const Url = z.string().max(MAX_URL);
// the brief cuts instructions here, so a request may not store more
export const INSTRUCTIONS_MAX = 2_000;
const Instructions = z.string().max(INSTRUCTIONS_MAX);

// one plan rate-limit window: the five-hour session, the week, or a model the week is scoped by
export const UsageWindow = z.object({
  key: z.string(),
  label: z.string(),
  pct: z.number(),
  resetsAt: z.string().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

// available is false for the logins plan limits do not cover: an API key, Bedrock, Vertex
// idle is a fleet with no agent running, which is when no plan is asked about
export const UsageSnapshot = z.object({
  available: z.boolean(),
  idle: z.boolean().optional(),
  windows: z.array(UsageWindow),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

// a phone socket the proxy vouched for, one row per login, timed from the earliest socket that login holds
export const PhoneSession = z.object({ login: z.string(), since: z.number() });
export type PhoneSession = z.infer<typeof PhoneSession>;

// the phone link as the desktop panel drives it: an environment the link cannot be made in
// (no tailscale, signed out, daemon not running) comes back as error rather than a failed call
export const MobileStatus = z.object({
  serving: z.boolean(),
  url: z.string(),
  port: z.number(),
  logins: z.array(z.string()),
  // the phones on the page right now: a serve mapping stands whether or not anyone is on the other end
  phones: z.array(PhoneSession),
  // the mapping points at a checkout with no phone page built, so the phone would get nothing
  pageMissing: z.literal(true).optional(),
  qr: z.string().optional(),
  error: z.string().optional(),
});
export type MobileStatus = z.infer<typeof MobileStatus>;

// how long the daemon waits for a fresh agent to attach before it answers char.create with a run
export const RUN_TIMEOUT_MS = 30_000;

// how long enabling the phone link may take, since a checkout with no phone bundle builds one first
const MOBILE_SET_TIMEOUT_MS = 3 * 60_000;

// how long a sweep of the whole fleet may take before the caller gives up on it
const SWEEP_TIMEOUT_MS = 15 * 60_000;

// how long starting another fleet may take: its daemon gets 15 s to answer, after its home is set up
const FLEET_START_TIMEOUT_MS = 20_000;

// how long char.wait waits when not told, and the most it may: past 2^31-1 ms a timer fires at once, and a client waits a little longer
const WAIT_DEFAULT_MS = 600_000;
const WAIT_MAX_MS = 2_000_000_000;
// how long a source may take to hash its fleet for preflight, or a destination to read its roots against their records
export const PREFLIGHT_TIMEOUT_MS = 10 * 60_000;
// how long a source may take to rest every terminal (a three-minute wait, the gateway over ssh, the fleet hashed
// twice), a destination to prove and take its roots, to write or start a whole fleet, and each side to seal its roots.
// the controller's rsync passes are not daemon calls and have no budget here
export const FREEZE_TIMEOUT_MS = 15 * 60_000;
export const CLAIM_TIMEOUT_MS = 15 * 60_000;
export const PREPARE_TIMEOUT_MS = 10 * 60_000;
export const ACTIVATE_TIMEOUT_MS = 10 * 60_000;
export const COMPLETE_TIMEOUT_MS = 2 * 60_000;
// how long taking a forced record may take, since the machine it names reopens the terminals its handover rested
export const ADOPT_TIMEOUT_MS = 2 * 60_000;

// how long the daemon holds a call before it answers: char.wait blocks for its timeout, char.create with a run until the agent attaches
export const serverWait = (method: MethodName, params: unknown): number => {
  if (method === 'char.wait') return (params as { timeoutMs?: number }).timeoutMs ?? WAIT_DEFAULT_MS;
  if (method === 'char.create' && (params as { run?: string }).run) return RUN_TIMEOUT_MS;
  if (method === 'scribe.sweep') return SWEEP_TIMEOUT_MS;
  if (method === 'mobile.set') return MOBILE_SET_TIMEOUT_MS;
  if (method === 'fleets.create' || method === 'fleets.start') return FLEET_START_TIMEOUT_MS;
  if (method === 'handover.preflight' || method === 'handover.inspect' || method === 'handover.reaches') return PREFLIGHT_TIMEOUT_MS;
  if (method === 'handover.freeze') return FREEZE_TIMEOUT_MS + ((params as { choices?: { interruptAfterMs?: number } }).choices?.interruptAfterMs ?? 0);
  if (method === 'handover.claim') return CLAIM_TIMEOUT_MS;
  if (method === 'handover.prepare') return PREPARE_TIMEOUT_MS;
  if (method === 'handover.activate') return ACTIVATE_TIMEOUT_MS;
  if (method === 'handover.complete') return COMPLETE_TIMEOUT_MS;
  if (method === 'ownership.adopt') return ADOPT_TIMEOUT_MS;
  return 0;
};

// the two turns a device may ask to hear about
export const PUSH_STATUSES = ['blocked', 'done'] as const;
export const PushStatus = z.enum(PUSH_STATUSES);
export type PushStatus = z.infer<typeof PushStatus>;
const PushKeys = z.object({ p256dh: z.string(), auth: z.string() });

export const DiffBase = z.enum(['head', 'main']);
export type DiffBase = z.infer<typeof DiffBase>;
export const FsEntry = z.object({ name: z.string(), kind: z.enum(['file', 'dir']), ignored: z.boolean().optional() });
export type FsEntry = z.infer<typeof FsEntry>;
// from is the old path of a rename
export const ChangedFile = z.object({ path: z.string(), status: z.enum(['A', 'M', 'D', 'R', '?']), from: z.string().optional() });
export type ChangedFile = z.infer<typeof ChangedFile>;
const RootPath = z.object({ id: z.string(), path: z.string() });
export const ResourceKind = z.enum(['docs', 'agentProfiles', 'instructions', 'skills', 'agents', 'commands', 'plugins', 'mcp', 'hooks', 'settings', 'autoMemory']);
export type ResourceKind = z.infer<typeof ResourceKind>;
// rootId and path are what fs.read takes; find is text to put the cursor on, folder what a skill's row unfolds to
const ResourceOpen = z.object({ rootId: z.string(), path: z.string(), find: z.string().optional(), folder: z.string().optional() });
// id names one row inside its source; rows of a kind can share a file, so the file cannot name them.
// tag is the agent folder a row came from, on a kind that several agents keep side by side
export const ResourceItem = z.object({
  id: z.string(), name: z.string(), detail: z.string().optional(), off: z.literal(true).optional(), error: z.string().optional(), tag: z.string().optional(),
  reveal: z.string(), target: z.enum(['file', 'folder']), open: ResourceOpen.optional(),
});
export type ResourceItem = z.infer<typeof ResourceItem>;
/** Whether resources.delete takes a row: a skill's folder, an agent, a command or a memory file other than the MEMORY.md every session loads. */
export const deletable = (kind: string, item: Pick<ResourceItem, 'name' | 'open'>): boolean =>
  item.open !== undefined && (kind === 'skills' || kind === 'agents' || kind === 'commands' || (kind === 'autoMemory' && item.name !== 'MEMORY.md'));
export const ResourceGroup = z.object({ kind: ResourceKind, items: z.array(ResourceItem) });
export type ResourceGroup = z.infer<typeof ResourceGroup>;
export const ResourceTier = z.enum(['global', 'fleet', 'repo', 'island', 'character']);
// docs is the root id a new doc goes to, agentProfiles the one a new agent profile goes to; a global source has neither
export const ResourceSource = z.object({
  rootId: z.string(), root: z.string(), name: z.string(), tier: ResourceTier, docs: z.string().optional(), agentProfiles: z.string().optional(),
  islandIds: z.array(z.string()), characterIds: z.array(z.string()), groups: z.array(ResourceGroup),
});
export type ResourceSource = z.infer<typeof ResourceSource>;

// a fleet on this Mac: running when its daemon answers, windowOpen when an app instance shows it
export const FleetEntry = z.object({ home: z.string(), name: z.string(), current: z.boolean(), running: z.boolean(), windowOpen: z.boolean() });
export type FleetEntry = z.infer<typeof FleetEntry>;

export const methods = {
  'state.get': { params: z.object({}), result: FleetState },
  'island.create': {
    params: z.object({ name: z.string(), position: Cell.optional(), size: NewSize.optional(), seed: z.number().int().optional(), description: z.string().optional(), context: z.array(ContextItem).optional(), instructions: Instructions.optional() }),
    result: Island,
  },
  'island.update': {
    params: z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional(), context: z.array(ContextItem).optional(), instructions: Instructions.optional(), position: Cell.optional(), size: NewSize.optional(), collapsed: z.boolean().optional() }),
    result: Island,
  },
  'island.delete': { params: Id, result: z.object({}) },
  // aspect is the shape of the window the fleet should fill, width over height; homeRoom the widest mission control, in cells, it has room for
  'island.arrange': { params: z.object({ aspect: z.number().min(0.01).max(100).optional(), homeRoom: z.number().int().min(0).max(10_000).optional() }), result: z.object({}) },
  'island.show': { params: Id, result: z.object({ text: z.string() }) },
  'island.reorder': { params: z.object({ id: z.string(), targetId: z.string(), after: z.boolean() }), result: Island },
  'char.create': {
    params: z.object({
      islandId: z.string(), cwd: z.string(), name: z.string().optional(),
      command: z.string().optional(), cell: Cell.optional(),
      run: z.string().optional(), agentProfile: z.string().optional(),
    }),
    result: Character.extend({ runSent: z.boolean().optional() }),
  },
  'char.update': {
    params: z.object({
      id: z.string(), name: z.string().optional(), note: z.string().optional(),
      islandId: z.string().optional(), context: z.array(ContextItem).optional(), instructions: Instructions.optional(),
      // '' clears it
      agentProfile: z.string().optional(), portrait: Portrait.optional(), keepHere: z.boolean().optional(),
    }),
    result: Character,
  },
  'char.move': { params: z.object({ id: z.string(), islandId: z.string(), cell: Cell.optional() }), result: Character },
  'char.reorder': { params: z.object({ id: z.string(), targetId: z.string(), after: z.boolean() }), result: Character },
  // without a target the character goes first among the starred
  'char.star': { params: z.object({ id: z.string(), targetId: z.string().optional(), after: z.boolean().optional() }), result: Character },
  'char.unstar': { params: Id, result: Character },
  'char.close': { params: Id, result: z.object({}) },
  'char.revive': { params: Id, result: Character },
  'char.seen': { params: Id.extend({ term: Term }), result: Character },
  // starts the character's second terminal when it has none
  'char.second': { params: Id, result: Character },
  'char.run': { params: z.object({ id: z.string(), text: z.string(), enter: z.boolean().default(true), term: Term }), result: z.object({}) },
  'char.read': {
    params: z.object({ id: z.string(), source: z.enum(['screen', 'transcript']).default('screen'), lines: z.number().int().min(1).default(50), term: Term }),
    result: z.object({ text: z.string() }),
  },
  'char.prompts': {
    params: z.object({ id: z.string(), limit: z.number().int().min(1).max(200).default(20) }),
    result: z.object({ prompts: z.array(z.string()) }),
  },
  'char.show': { params: Id, result: z.object({ text: z.string() }) },
  'char.wait': {
    params: z.object({ id: z.string(), until: z.array(AgentStatus).min(1), timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).default(WAIT_DEFAULT_MS), term: Term }),
    result: z.object({ status: z.union([AgentStatus, z.enum(['timeout', 'gone'])]) }),
  },
  // Enter takes the permission dialog's highlighted "Yes"; Esc is its "No". promptId is the agent's promptId the answer was
  // shown with; a newer question is not answered by it
  'char.answer': { params: z.object({ id: z.string(), answer: z.enum(['approve', 'deny']), promptId: z.string().optional() }), result: z.object({}) },
  // names writes only names; islands runs only the island descriptions
  'scribe.sweep': {
    params: z.object({ names: z.boolean().optional(), islands: z.boolean().optional() }),
    result: z.object({ lines: z.array(z.string()) }),
  },
  'scribe.set': { params: z.object({ enabled: z.boolean() }), result: z.object({}) },
  'worktrees.set': { params: z.object({ enabled: z.boolean() }), result: z.object({}) },
  'dormancy.set': { params: z.object({ hours: z.number().int().min(0) }), result: z.object({}) },
  'mainAgent.set': { params: z.object({ agent: AgentKind }), result: z.object({}) },
  // the fleets beside this one; a phone is refused them
  'fleets.list': { params: z.object({}), result: z.object({ fleets: z.array(FleetEntry) }) },
  'fleets.create': { params: z.object({ name: z.string() }), result: z.object({ home: z.string() }) },
  'fleets.start': { params: z.object({ home: z.string() }), result: z.object({ home: z.string() }) },
  'fleet.rename': { params: z.object({ name: z.string() }), result: z.object({}) },
  // the app quitting: every terminal ends, each character resumes when opened, and the daemon exits once it has answered
  'fleet.stop': { params: z.object({}), result: z.object({}) },
  'usage.get': { params: z.object({}), result: UsageSnapshot },
  'mobile.get': { params: z.object({}), result: MobileStatus },
  'mobile.set': { params: z.object({ enabled: z.boolean() }), result: MobileStatus },
  'resources.get': { params: z.object({}), result: z.object({ sources: z.array(ResourceSource) }) },
  // paths are relative to the character's root: repo.root, else cwd
  'fs.list': { params: RootPath, result: z.object({ entries: z.array(FsEntry) }) },
  // root is the folder the path was read under, which moves with the character
  'fs.read': { params: RootPath, result: z.object({ text: z.string(), mtimeMs: z.number(), root: z.string() }) },
  // mtimeMs is the one fs.read gave, 0 for no file; a file changed or gone since is left alone and answered with conflict and
  // the disk's mtime, 0 when it is gone. root is the one fs.read gave, and a write after the character moved away is refused
  'fs.write': { params: RootPath.extend({ text: z.string(), mtimeMs: z.number(), root: z.string().optional() }), result: z.object({ mtimeMs: z.number(), conflict: z.literal(true).optional() }) },
  // a docs folder's own .md files; every other root stays read and write
  'docs.create': { params: RootPath.extend({ text: z.string() }), result: z.object({ mtimeMs: z.number() }) },
  'docs.rename': { params: RootPath.extend({ to: z.string() }), result: z.object({}) },
  'docs.delete': { params: RootPath, result: z.object({}) },
  // a row deletable() takes, by its open path or a skill's folder, set aside until resources.restore puts it back or svalld restarts
  'resources.delete': { params: RootPath, result: z.object({ token: z.string() }) },
  'resources.restore': { params: z.object({ token: z.string() }), result: z.object({}) },
  'repo.status': {
    params: z.object({ id: z.string(), base: DiffBase.default('head') }),
    result: z.object({ branch: z.string().optional(), files: z.array(ChangedFile) }),
  },
  'repo.file': {
    params: RootPath.extend({ base: DiffBase.default('head'), from: z.string().optional() }),
    result: z.object({ before: z.string().optional(), after: z.string().optional(), binary: z.literal(true).optional() }),
  },
  'repo.watch': { params: Id, result: z.object({}) },
  'repo.unwatch': { params: Id, result: z.object({}) },
  'push.key': { params: z.object({}), result: z.object({ publicKey: z.string() }) },
  // a device sends its push endpoint and keys once; sending them again with new statuses replaces its choice
  'push.subscribe': { params: z.object({ endpoint: z.string().url(), keys: PushKeys, statuses: z.array(PushStatus) }), result: z.object({}) },
  'push.unsubscribe': { params: z.object({ endpoint: z.string() }), result: z.object({}) },
  'push.get': { params: z.object({ endpoint: z.string() }), result: z.object({ statuses: z.array(PushStatus).optional() }) },
  // tab is the id the page or the shell already gave the view; absent, svalld mints one
  'browser.open': { params: z.object({ id: z.string(), url: Url, tab: z.string().min(1).optional() }), result: BrowserTab },
  'browser.close': { params: z.object({ id: z.string(), tab: z.string() }), result: z.object({}) },
  'browser.activate': { params: z.object({ id: z.string(), tab: z.string() }), result: z.object({}) },
  'browser.update': { params: z.object({ id: z.string(), tab: z.string(), url: Url.optional(), title: z.string().optional() }), result: z.object({}) },
  // lines of scrollback the first screen carries; a phone opening cold wants more than one screenful
  'term.open': { params: Id.merge(TermSize).extend({ lines: z.number().int().min(0).max(10_000).default(2000) }), result: z.object({ screen: z.string() }) },
  'term.input': { params: z.object({ id: z.string(), data: z.string().base64() }), result: z.object({}) },
  'term.resize': { params: Id.merge(TermSize), result: z.object({}) },
  'term.close': { params: Id, result: z.object({}) },
  'term.attach': { params: Id.extend({ term: Term }), result: z.object({ socket: z.string(), session: z.string() }) },
  'system.info': { params: z.object({}), result: SystemInfo },
  'ownership.get': { params: z.object({}), result: OwnershipInfo },
  // token-only: the gateway's record as `svall fleet recover` relays it after a forced write, and the gateway that holds it now
  'ownership.adopt': {
    params: z.object({ record: OwnerRecord, gatewayMachineId: MachineId }),
    result: z.object({ adopted: z.boolean(), superseded: TransactionId.optional(), ownership: OwnershipInfo }),
  },
  // read-only: it builds the manifest and reports what would stop the move, before any terminal is touched
  'handover.preflight': {
    params: z.object({ toMachineId: MachineId, choices: HandoverChoices.default({}) }).merge(HandoverMachines),
    result: z.object({ manifestSummary: ManifestSummary, blockers: z.array(Blocker), warnings: z.array(Warning), manifest: TransferManifestV1 }),
  },
  // read-only, on the destination: whether each root could be claimed there, what each of `folders` is good for, and which of `links` is not there.
  // A root's `files` are what the handover brings to it, which a root no handover left may already hold exactly, and a copy another handover was
  // let go with may hold in part
  'handover.inspect': {
    params: z.object({
      roots: z.array(ReplicaRootSpec.extend({ files: TransferRoot.shape.files.optional() })), excludes: z.array(z.string()), folders: z.array(MachinePath), links: z.array(z.string()).optional(),
      git: z.array(ReceivedGraph).optional(), resumes: z.array(ResumeFolder).optional(),
    }),
    result: z.object({
      roots: z.array(z.object({ id: z.string(), check: ReplicaCheck })), folders: z.record(z.string(), RootProbe), missing: z.array(z.string()).optional(),
      // the worktrees of the graphs `git` names that stay here, at commits only the source can say it holds
      unproven: z.array(KeptCommit).optional(),
      // the folders of `resumes` whose agent here asks whether to trust them before it resumes there
      untrusted: z.array(ResumeFolder.pick({ kind: true, cwd: true })).optional(),
      // the folders of `resumes` asking for bypass mode whose agent here warns about that mode before it resumes there
      bypassWarned: z.array(ResumeFolder.pick({ kind: true, cwd: true })).optional(),
    }),
  },
  'handover.freeze': {
    params: z.object({ transactionId: TransactionId, generation: Generation, choices: HandoverChoices.default({}) }).merge(HandoverMachines),
    result: z.object({ manifest: TransferManifestV1.extend({ transactionId: TransactionId }) }),
  },
  // the destination takes each root the manifest carries before anything is written into it, archiving one `archive` names
  // when it cannot otherwise be taken; `landed` is what this handover's transfer has verified so far, which its copy may hold
  'handover.claim': {
    params: z.object({
      transactionId: TransactionId, generation: Generation,
      manifest: TransferManifestV1.extend({ transactionId: TransactionId }), manifestDigest: Sha256, archive: z.array(z.string().min(1)).optional(),
      landed: z.array(LandedRoot).optional(),
    }),
    result: z.object({ roots: z.array(RootClaim), unproven: z.array(KeptCommit).optional() }),
  },
  // the destination names the generation it prepares for, g + 1, here, in activate, in complete and in its abort. It
  // prepares the state it would run from the manifest's snapshot; `preparedDigest` is what owner.ready is granted on
  'handover.prepare': {
    params: z.object({
      transactionId: TransactionId, generation: Generation,
      manifest: TransferManifestV1.extend({ transactionId: TransactionId }), manifestDigest: Sha256,
      landed: z.array(LandedRoot),
    }),
    result: z.object({ preparedDigest: Sha256 }),
  },
  // `notice` is what a character that came up still waits on in its terminal
  'handover.activate': {
    params: z.object({ transactionId: TransactionId, generation: Generation }),
    result: z.object({ characters: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional(), notice: z.string().optional() })) }),
  },
  // each side seals the roots it holds at g + 1 and closes its journal; the source seals what the transfer verified, `landed`
  'handover.complete': {
    params: z.object({ transactionId: TransactionId, generation: Generation, landed: z.array(LandedRoot).optional() }),
    result: z.object({}),
  },
  'handover.abort': { params: z.object({ transactionId: TransactionId, generation: Generation }), result: z.object({}) },
  // read-only, on the source, frozen or not: which of these commits no ref of its repository reaches, the ones it lacks included
  'handover.reaches': { params: z.object({ commits: z.array(CommitAt) }), result: z.object({ unreached: z.array(CommitAt) }) },
  // `quarantined`: where a journal this daemon could not read was moved, which leaves it unable to say how far a handover got
  'handover.status': {
    params: z.object({}),
    result: z.object({
      transaction: HandoverTransactionStatus.optional(), quarantined: z.string().optional(),
    }),
  },
} as const;

export type MethodName = keyof typeof methods;
export type Params<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type ParsedParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

export const Request = z.object({ id: z.number(), method: z.string(), params: z.unknown().optional() });
export type Request = z.infer<typeof Request>;

// what a failed call names its failure by; anything else a handler throws answers internal
export const ERROR_CODES = ['unknown_method', 'forbidden', 'invalid_params', 'internal', 'invalid', 'not_found', 'dormant', 'gone', 'exists', 'too_large', 'binary', 'no_repo'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ApiError extends Error {
  constructor(public code: string, message: string, public data?: Record<string, unknown>) { super(message); }
}

/** The raw bytes of a request each part carries, before base64; one part stays well under the daemon's 8 MiB message cap. */
export const PART_BYTES = 4 * 1024 * 1024;
/** The most a request sent in parts may come to, and an answer a client reads. */
export const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
/** The most a transfer manifest may come to: claim and prepare carry it and, in what landed, its carried roots' files again, in one request. */
export const MAX_MANIFEST_BYTES = MAX_REQUEST_BYTES / 2;

/** One slice of a request too large for one socket message: the parts of one request arrive in order, and the whole is answered once. */
export const RequestPart = z.object({
  part: z.object({ id: z.number().int(), index: z.number().int().nonnegative(), count: z.number().int().positive(), data: z.string() }),
});
export type RequestPart = z.infer<typeof RequestPart>;

// data carries the structured half of an error: the blockers of a refused handover, the generations of a mismatch
export const ErrorFrame = z.object({ code: z.string(), message: z.string(), data: z.record(z.string(), z.unknown()).optional() });
export type ErrorFrame = z.infer<typeof ErrorFrame>;

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: ErrorFrame };

export type Event =
  | { event: 'state.patch'; data: { ops: Operation[] } }
  | { event: 'term.output'; data: { id: string; data: string } }
  | { event: 'term.resync'; data: { id: string; screen: string } }
  | { event: 'repo.changed'; data: { id: string } }
  | { event: 'mobile.phones'; data: { phones: PhoneSession[] } }
  | { event: 'ownership.changed'; data: { generation: number; ownerMachineId: MachineId } }
  | { event: 'handover.changed'; data: { transactionId: string; phase: HandoverPhase } }
  // counts and phases only: a manifest travels as the freeze result, never as an event
  | { event: 'handover.entity'; data: { transactionId: string; kind: HandoverEntityKind; id: string; phase: HandoverPhase; done?: number; total?: number; error?: string; notice?: string } };

export const Hello = z.object({ token: z.string() });
/** The reply to the handshake: the daemon's protocol version. */
export const HelloResult = z.object({ ok: z.literal(true), protocol: z.number().int() });
export type HelloResult = z.infer<typeof HelloResult>;
// the daemon's answer to a socket it admits, which a client checks the protocol by
export const HelloReply = z.object({ id: z.literal(0), result: HelloResult });
export type HelloReply = z.infer<typeof HelloReply>;
// the close code for a socket the proxy brought from a tailnet login the fleet does not accept
export const LOGIN_REFUSED = 4403;

// bump on any change an older app or daemon would misread; the handshake reply carries it
export const PROTOCOL_VERSION = 21;
