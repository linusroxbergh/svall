import type { Operation } from 'fast-json-patch';
import { z } from 'zod';
import { MachineId, SystemInfo } from './machines.js';
import { MoveId, MoveSheet, Refusal, SetupRow } from './placement.js';
import { DismissReason, RetroPlan, RetroReport, RetroSpan, RetroStatus } from './retro.js';
import { AgentKind, AgentStatus, BrowserTab, Cell, Column, Robot, ContextItem, FleetState, Island, Size } from './state.js';

const Id = z.object({ id: z.string() });
const TermSize = z.object({ cols: z.number().int().min(2), rows: z.number().int().min(1) });
// which of a robot's terminals a call means; absent, the main one
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

// one plan rate-limit window: the five-hour session, the week, or a model the week is scoped by;
// at is when the agent reported a window read off its transcript, in ms, and a window read live has none
export const UsageWindow = z.object({
  key: z.string(),
  label: z.string(),
  pct: z.number(),
  resetsAt: z.string().optional(),
  at: z.number().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

// available is false for logins plan limits do not cover (API key, Bedrock, Vertex); idle, no agent running so no plan
// is asked; account, the login(s) the windows belong to, when known
export const UsageSnapshot = z.object({
  available: z.boolean(),
  idle: z.boolean().optional(),
  account: z.string().optional(),
  windows: z.array(UsageWindow),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

// cpu is a percent of one core; mem is bytes
export const LoadUsage = z.object({ cpu: z.number(), mem: z.number(), procs: z.number() });
export type LoadUsage = z.infer<typeof LoadUsage>;
export const LoadRobot = LoadUsage.extend({ shellOnly: z.boolean(), sleepable: z.boolean() });
export type LoadRobot = z.infer<typeof LoadRobot>;
// cores is the machine's logical cores
export const LoadSnapshot = z.object({ at: z.number(), cores: z.number(), total: LoadUsage, app: LoadUsage, codex: LoadUsage.optional(), robots: z.record(z.string(), LoadRobot) });
export type LoadSnapshot = z.infer<typeof LoadSnapshot>;

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
  // the address with the pass in its fragment, which the QR encodes: a phone pairs by opening it
  pair: z.string().optional(),
  qr: z.string().optional(),
  error: z.string().optional(),
});
export type MobileStatus = z.infer<typeof MobileStatus>;

// how long the daemon waits for a fresh agent to attach before it answers robot.create with a run
export const RUN_TIMEOUT_MS = 30_000;

// how long enabling the phone link may take, since a checkout with no phone bundle builds one first
const MOBILE_SET_TIMEOUT_MS = 3 * 60_000;

const SWEEP_TIMEOUT_MS = 15 * 60_000;

// how long a retro plan may take to index a month of transcripts and fetch the PR threads its reviews join
const RETRO_PLAN_TIMEOUT_MS = 10 * 60_000;

// how long starting another fleet may take: its daemon gets 15 s to answer, after its home is set up
const FLEET_START_TIMEOUT_MS = 20_000;

// how long robot.wait waits when not told, and the most it may: past 2^31-1 ms a timer fires at once, and a client waits a little longer
const WAIT_DEFAULT_MS = 600_000;
const WAIT_MAX_MS = 2_000_000_000;
// how long a move may take to rest, carry and commit a robot, past the interrupt it was asked to wait for
const MOVE_TIMEOUT_MS = 15 * 60_000;
// a check asks the worker its agents and probes its clone (an ls-remote of up to 20 s), and builds the bundle to size it
const MOVE_CHECK_TIMEOUT_MS = 3 * 60_000;
// a retry waits for the worker to take the snapshot (60 s), to start the robot (two minutes) and for the release
const MOVE_RETRY_TIMEOUT_MS = 5 * 60_000;
// how long the home waits for each of a worker's answers about its agent configuration while it builds the setup rows
export const REPORT_MS = 10_000;
// the setup rows past the wait for the link: the worker's two answers
const SETUP_REPORT_MS = 2 * REPORT_MS;
// a tick waits for the push already under way and its own, each of up to the 200 MB tree, then for the setup rows
const CONSENT_TIMEOUT_MS = 15 * 60_000;
// an agent's own update downloads its release
export const AGENT_UPDATE_MS = 5 * 60_000;

// how long the daemon may hold a call before it answers, which a client adds to its own timeout
export const serverWait = (method: MethodName, params: unknown): number => {
  if (method === 'robot.wait') return (params as { timeoutMs?: number }).timeoutMs ?? WAIT_DEFAULT_MS;
  if (method === 'robot.create' && (params as { run?: string }).run) return RUN_TIMEOUT_MS;
  if (method === 'scribe.sweep') return SWEEP_TIMEOUT_MS;
  if (method === 'retro.plan') return RETRO_PLAN_TIMEOUT_MS;
  // each fix may start a robot, which waits for its agent as robot.create with a run does
  if (method === 'retro.mark') return ((params as { marks?: { action?: string }[] }).marks ?? []).filter((m) => m.action === 'fix').length * RUN_TIMEOUT_MS;
  if (method === 'mobile.set') return MOBILE_SET_TIMEOUT_MS;
  if (method === 'fleets.create' || method === 'fleets.start') return FLEET_START_TIMEOUT_MS;
  if (method === 'robot.moveTo') return MOVE_TIMEOUT_MS + ((params as { interruptAfterMs?: number }).interruptAfterMs ?? 0);
  if (method === 'robot.moveCheck') return MOVE_CHECK_TIMEOUT_MS;
  if (method === 'robot.moveRetry') return MOVE_RETRY_TIMEOUT_MS;
  if (method === 'machines.setup') return ((params as { waitMs?: number }).waitMs ?? 0) + SETUP_REPORT_MS;
  if (method === 'machines.consent' || method === 'machines.setVar') return CONSENT_TIMEOUT_MS;
  // the worker runs each update in turn, and the link takes 30 s beside them
  if (method === 'machines.updateAgents') return ((params as { kinds?: unknown[] }).kinds ?? []).length * AGENT_UPDATE_MS + 30_000;
  return 0;
};

// the two turns a device may ask to hear about
export const PUSH_STATUSES = ['blocked', 'done'] as const;
export const PushStatus = z.enum(PUSH_STATUSES);
export type PushStatus = z.infer<typeof PushStatus>;
const PushKeys = z.object({ p256dh: z.string(), auth: z.string() });

export const DiffBase = z.enum(['head', 'main']);
export type DiffBase = z.infer<typeof DiffBase>;
export const Delivery = z.enum(['delivered', 'queued']);
export type Delivery = z.infer<typeof Delivery>;
export const FsEntry = z.object({ name: z.string(), kind: z.enum(['file', 'dir']), ignored: z.boolean().optional() });
export type FsEntry = z.infer<typeof FsEntry>;
// from is the old path of a rename
export const ChangedFile = z.object({ path: z.string(), status: z.enum(['A', 'M', 'D', 'R', '?']), from: z.string().optional() });
export type ChangedFile = z.infer<typeof ChangedFile>;
const RootPath = z.object({ id: z.string(), path: z.string() });
// carry names the credential files ticked to travel; interruptAfterMs, how long a working agent has before it is interrupted;
// ownWorktree, that a robot on a main checkout moves into a new worktree of its own at HEAD, and the checkout keeps its changes
const MoveParams = z.object({ id: z.string(), machine: MachineId, carry: z.array(z.string()).optional(), interruptAfterMs: z.number().int().nonnegative().optional(), ownWorktree: z.boolean().optional() });
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
export const ResourceTier = z.enum(['global', 'fleet', 'repo', 'island', 'robot', 'profiles']);
// docs is the root id a new doc goes to, agentProfiles the one a new agent profile goes to; a global source has neither
export const ResourceSource = z.object({
  rootId: z.string(), root: z.string(), name: z.string(), tier: ResourceTier, docs: z.string().optional(), agentProfiles: z.string().optional(),
  islandIds: z.array(z.string()), robotIds: z.array(z.string()), groups: z.array(ResourceGroup),
});
export type ResourceSource = z.infer<typeof ResourceSource>;

export const PaneKind = z.enum(['terminal', 'browser', 'files', 'changes']);
export type PaneKind = z.infer<typeof PaneKind>;
// what an app showing the fleet is asked to show; a field left out stays as the app has it
export const AppShow = z.object({
  id: z.string().optional(),
  left: PaneKind.optional(),
  right: z.union([PaneKind, z.literal('none')]).optional(),
  ratio: z.number().min(0.25).max(0.75).optional(),
  // a path as a terminal link gives it, opened in the robot's Files; preview shows a markdown file formatted
  file: z.string().min(1).optional(),
  preview: z.boolean().optional(),
  tree: z.boolean().optional(),
  card: z.enum(['half', 'full', 'closed']).optional(),
  sidebar: z.boolean().optional(),
  sideCard: z.boolean().optional(),
  view: z.enum(['map', 'board']).optional(),
  panel: z.enum(['phone', 'usage', 'load', 'none']).optional(),
  // the window's content size in points
  size: z.object({ w: z.number().int().min(400).max(10_000), h: z.number().int().min(300).max(10_000) }).optional(),
  // for a screenshot: the phone panel hides its link and logins and shows this QR instead, until it closes
  redact: z.object({ qr: z.string().max(64 * 1024).regex(/^data:image\/png;base64,/) }).optional(),
});
export type AppShow = z.infer<typeof AppShow>;

/** A worker clone's root id on the home's shelf: the worker and the folder on its disk, as two workers may hold one path. */
export const farRootId = (machine: MachineId, root: string): string => `r:${machine}:${root}`;
const FAR_ROOT = /^r:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i;
/** The worker and folder a root id names, undefined for a root on this machine. */
export function farRootOf(id: string): { machine: MachineId; root: string } | undefined {
  const m = FAR_ROOT.exec(id);
  const machine = m ? MachineId.safeParse(m[1]) : undefined;
  return m && machine?.success ? { machine: machine.data, root: m[2] } : undefined;
}

// a fleet on this Mac: windowOpen when an app instance shows it
export const FleetEntry = z.object({ home: z.string(), name: z.string(), current: z.boolean(), windowOpen: z.boolean() });
export type FleetEntry = z.infer<typeof FleetEntry>;

export const methods = {
  'state.get': { params: z.object({}), result: FleetState },
  'island.create': {
    params: z.object({ name: z.string(), position: Cell.optional(), size: NewSize.optional(), seed: z.number().int().optional(), description: z.string().optional(), context: z.array(ContextItem).optional(), instructions: Instructions.optional() }),
    result: Island,
  },
  'island.update': {
    // removed: the refs a person took off context, which the scribe leaves off until they are added again
    params: z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional(), context: z.array(ContextItem).optional(), removed: z.array(z.string()).optional(), instructions: Instructions.optional(), position: Cell.optional(), size: NewSize.optional(), collapsed: z.boolean().optional() }),
    result: Island,
  },
  'island.delete': { params: Id, result: z.object({}) },
  // aspect is the shape of the window the fleet should fill, width over height; homeRoom the widest mission control, in cells, it has room for
  'island.arrange': { params: z.object({ aspect: z.number().min(0.01).max(100).optional(), homeRoom: z.number().int().min(0).max(10_000).optional() }), result: z.object({}) },
  'island.show': { params: Id, result: z.object({ text: z.string() }) },
  'island.reorder': { params: z.object({ id: z.string(), targetId: z.string(), after: z.boolean() }), result: Island },
  'robot.create': {
    params: z.object({
      islandId: z.string(), cwd: z.string(), name: z.string().optional(),
      command: z.string().optional(), cell: Cell.optional(),
      run: z.string().optional(), agentProfile: z.string().optional(),
    }),
    result: Robot.extend({ runSent: z.boolean().optional() }),
  },
  'robot.update': {
    params: z.object({
      id: z.string(), name: z.string().optional(), note: z.string().optional(),
      islandId: z.string().optional(), context: z.array(ContextItem).optional(), instructions: Instructions.optional(),
      // the refs a person took off context, which the scribe and the branch lookup leave off until they are added again
      removed: z.array(z.string()).optional(),
      // '' clears it
      agentProfile: z.string().optional(), figure: z.number().int().min(1).optional()
    }),
    result: Robot,
  },
  'robot.move': { params: z.object({ id: z.string(), islandId: z.string(), cell: Cell.optional() }), result: Robot },
  'robot.reorder': { params: z.object({ id: z.string(), targetId: z.string(), after: z.boolean() }), result: Robot },
  // without a target the robot goes first among the starred
  'robot.star': { params: z.object({ id: z.string(), targetId: z.string().optional(), after: z.boolean().optional() }), result: Robot },
  'robot.unstar': { params: Id, result: Robot },
  // a robot placed by hand stays in its column until robot.release lets the scribe place it again
  'robot.place': { params: z.object({ id: z.string(), columnId: z.string() }), result: Robot },
  'robot.release': { params: Id, result: Robot },
  'robot.close': { params: Id, result: z.object({}) },
  'robot.sleep': { params: Id, result: z.object({}) },
  'robot.revive': { params: Id, result: Robot },
  // starts a dormant terminal's agent in a new session, its first prompt a summary of the one it could not resume
  'robot.fresh': { params: Id.extend({ term: Term }), result: Robot },
  'robot.seen': { params: Id.extend({ term: Term }), result: Robot },
  // starts the robot's second terminal when it has none
  'robot.second': { params: Id, result: Robot },
  // an agent waiting on an answer refuses the text with `blocked`; one with a draft or a dialog on screen holds it, queued
  'robot.run': { params: z.object({ id: z.string(), text: z.string(), enter: z.boolean().default(true), term: Term }), result: z.object({ delivery: Delivery }) },
  // robot `from`'s message, typed as robot.run types it after a line naming the sender (robotMessage)
  'robot.send': { params: z.object({ id: z.string(), from: z.string(), text: z.string() }), result: z.object({ delivery: Delivery }) },
  'robot.read': {
    params: z.object({ id: z.string(), source: z.enum(['screen', 'transcript', 'last']).default('screen'), lines: z.number().int().min(1).default(50), term: Term }),
    result: z.object({ text: z.string() }),
  },
  'robot.prompts': {
    params: z.object({ id: z.string(), limit: z.number().int().min(1).max(200).default(20) }),
    result: z.object({ prompts: z.array(z.string()) }),
  },
  'robot.show': { params: Id, result: z.object({ text: z.string() }) },
  'robot.wait': {
    params: z.object({ id: z.string(), until: z.array(AgentStatus).min(1), timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).default(WAIT_DEFAULT_MS), term: Term }),
    result: z.object({ status: z.union([AgentStatus, z.enum(['timeout', 'gone'])]) }),
  },
  // Enter takes the permission dialog's highlighted "Yes"; Esc is its "No". promptId is the agent's promptId the answer was
  // shown with; a newer question is not answered by it
  'robot.answer': { params: z.object({ id: z.string(), answer: z.enum(['approve', 'deny']), promptId: z.string().optional() }), result: z.object({}) },
  // what a move to `machine` carries, or the first check that stops it; the home's own id asks about the way back
  'robot.moveCheck': {
    params: MoveParams,
    result: z.union([z.object({ ok: z.literal(true), sheet: MoveSheet }), z.object({ ok: z.literal(false), refusal: Refusal })]),
  },
  // answers once the move has run past its commit; a refusal comes back as `refused`, the refusal in its data
  'robot.moveTo': { params: MoveParams, result: z.object({ moveId: MoveId }) },
  // runs a committed move on from the step it stopped at
  'robot.moveRetry': { params: z.object({ moveId: MoveId }), result: z.object({}) },
  'machines.list': {
    params: z.object({}),
    result: z.object({ machines: z.array(z.object({ id: MachineId, name: z.string(), reachable: z.boolean(), release: z.string().optional(), robots: z.number() })) }),
  },
  // links each machine `svall host add` or `host upgrade` enrolled while the daemon ran
  'machines.refresh': { params: z.object({}), result: z.object({}) },
  // the setup rows of a machine's agent configuration, once its link is up or waitMs has passed; with robot, those its agents use
  'machines.setup': {
    params: z.object({ machine: MachineId, waitMs: z.number().int().min(0).max(60_000).optional(), robot: z.string().optional() }),
    result: z.object({ rows: z.array(SetupRow) }),
  },
  // ticks `fields` of `item` for `machine`, or unticks all of them, pushes the change there and answers the setup rows
  'machines.consent': {
    params: z.object({ machine: MachineId, item: z.string(), fields: z.array(z.string()), on: z.boolean() }),
    result: z.object({ rows: z.array(SetupRow) }),
  },
  // runs each agent's own update on `machine`, or on this Mac without one, one after another, and answers once all have ended
  'machines.updateAgents': { params: z.object({ machine: MachineId.optional(), kinds: z.array(AgentKind).min(1) }), result: z.object({}) },
  // sets a variable for the fleet's robots on `machine`, from `value` or, with fromMac, from this Mac's own; answers the setup rows
  'machines.setVar': {
    params: z.object({ machine: MachineId, name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().min(1).max(4096).optional(), fromMac: z.literal(true).optional() }),
    result: z.object({ rows: z.array(SetupRow) }),
  },
  // each answers the board's columns, left to right. A name is trimmed and unlike every other column's in any case;
  // without afterId the column goes last, and a deleted column's robots go to moveTo
  'column.add': { params: z.object({ name: z.string(), afterId: z.string().optional() }), result: z.array(Column) },
  'column.rename': { params: z.object({ id: z.string(), name: z.string() }), result: z.array(Column) },
  'column.reorder': { params: z.object({ id: z.string(), targetId: z.string(), after: z.boolean() }), result: z.array(Column) },
  'column.delete': { params: z.object({ id: z.string(), moveTo: z.string() }), result: z.array(Column) },
  // names writes only names; columns only moves robots to their columns, Auto-place on or off; islands runs only the island descriptions
  'scribe.sweep': {
    params: z.object({ names: z.boolean().optional(), columns: z.boolean().optional(), islands: z.boolean().optional() }),
    result: z.object({ lines: z.array(z.string()) }),
  },
  'scribe.set': { params: z.object({ enabled: z.boolean() }), result: z.object({}) },
  'placing.set': { params: z.object({ enabled: z.boolean() }), result: z.object({}) },
  'worktrees.set': { params: z.object({ enabled: z.boolean() }), result: z.object({}) },
  'dormancy.set': { params: z.object({ hours: z.number().int().min(0) }), result: z.object({}) },
  'mainAgent.set': { params: z.object({ agent: AgentKind }), result: z.object({}) },
  // the model the scribe or mission control's crew runs on `agent`'s CLI; with none, that CLI's default
  'model.set': { params: z.object({ of: z.enum(['scribe', 'home']), agent: AgentKind, model: z.string().min(1).optional() }), result: z.object({}) },
  // a retro over what the agents here did: plan reads the stores and sends nothing to a model; given exclusions or picks
  // are saved to fleet.json. run cards the plan's sessions and judges them under the approved budget; mark and apply act on findings
  'retro.plan': {
    params: z.object({
      span: RetroSpan.default('last'),
      exclude: z.object({ repos: z.array(z.string()).optional(), islands: z.array(z.string()).optional() }).optional(),
      unrecorded: z.array(z.string()).optional(),
    }),
    result: RetroPlan,
  },
  // preset is balanced where the plan has it, else its first, when none is named; budget is the tokens the user approved,
  // the preset's upper estimate when none is given; robot is the crew member whose card shows the run
  'retro.run': { params: z.object({ plan: z.string(), preset: z.string().optional(), budget: z.number().int().positive().optional(), robot: z.string().optional() }), result: z.object({ run: z.string() }) },
  'retro.status': { params: z.object({ run: z.string().optional() }), result: RetroStatus },
  'retro.findings': { params: z.object({ run: z.string().optional() }), result: RetroReport },
  // finding n's section of a run's report.md, as numbered in its findings
  'retro.show': { params: z.object({ n: z.number().int().positive(), run: z.string().optional() }), result: z.object({ text: z.string() }) },
  'retro.mark': {
    params: z.object({
      marks: z.array(z.object({ id: z.string(), action: z.enum(['fix', 'dismiss', 'later']), reason: DismissReason.optional() })
        .refine((m) => m.action !== 'dismiss' || m.reason, { message: 'a dismissal says whether it was wrong or not worth it', path: ['reason'] })).min(1),
    }),
    result: z.object({
      results: z.array(z.object({
        // fixed: a robot took the finding before, so none is started again
        id: z.string(), outcome: z.enum(['robot', 'apply', 'proposal', 'dismissed', 'later', 'fixed']),
        robot: z.string().optional(), path: z.string().optional(), diff: z.string().optional(),
      })),
    }),
  },
  'retro.apply': { params: z.object({ id: z.string() }), result: z.object({ path: z.string(), backup: z.string() }) },
  // the fleets beside this one; a phone is refused them
  'fleets.list': { params: z.object({}), result: z.object({ fleets: z.array(FleetEntry) }) },
  'fleets.create': { params: z.object({ name: z.string() }), result: z.object({ home: z.string() }) },
  'fleets.start': { params: z.object({ home: z.string() }), result: z.object({ home: z.string() }) },
  'fleet.rename': { params: z.object({ name: z.string() }), result: z.object({}) },
  // the app quitting: every terminal ends, each robot resumes when opened, and the daemon exits once it has answered
  'fleet.stop': { params: z.object({}), result: z.object({}) },
  'usage.get': { params: z.object({}), result: UsageSnapshot },
  'load.get': { params: z.object({}), result: LoadSnapshot },
  'mobile.get': { params: z.object({}), result: MobileStatus },
  'mobile.set': { params: z.object({ enabled: z.boolean() }), result: MobileStatus },
  'resources.get': { params: z.object({}), result: z.object({ sources: z.array(ResourceSource) }) },
  // paths are relative to the robot's root: repo.root, else cwd; an absolute one names a file anywhere
  'fs.list': { params: RootPath, result: z.object({ entries: z.array(FsEntry) }) },
  // root is the folder the path was read under, which moves with the robot; the disk's for an absolute path
  'fs.read': { params: RootPath, result: z.object({ text: z.string(), mtimeMs: z.number(), root: z.string() }) },
  // mtimeMs is the one fs.read gave, 0 for no file; a file changed or gone since is left alone and answered with conflict and
  // the disk's mtime, 0 when it is gone. root is the one fs.read gave, and a write after the robot moved away is refused
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
  // the last lines a placed robot's worker sent of its pane, and when; empty for one the home has none of
  'term.lastScreen': { params: Id, result: z.object({ text: z.string(), at: z.number().optional() }) },
  // `tmux`: the binary that serves the socket, which a terminal attaching from another machine runs there; `via`, for a robot
  // placed on another machine, the ssh destination and master socket that reach it
  'term.attach': {
    params: Id.extend({ term: Term }),
    result: z.object({ socket: z.string(), session: z.string(), tmux: z.string(), via: z.object({ ssh: z.string(), controlSocket: z.string() }).optional() }),
  },
  'system.info': { params: z.object({}), result: SystemInfo },
  'feedback.preview': { params: z.object({}), result: z.object({ text: z.string() }) },
  // apps is how many app windows on the fleet were told
  'app.show': { params: AppShow, result: z.object({ apps: z.number().int() }) },
} as const;

export type MethodName = keyof typeof methods;
export type Params<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type ParsedParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

export const Request = z.object({ id: z.number(), method: z.string(), params: z.unknown().optional() });
export type Request = z.infer<typeof Request>;

export class ApiError extends Error {
  constructor(public code: string, message: string, public data?: Record<string, unknown>) { super(message); }
}

/** The raw bytes of a request each part carries, before base64; one part stays well under the daemon's 8 MiB message cap. */
export const PART_BYTES = 4 * 1024 * 1024;
/** The most a request sent in parts may come to, and an answer a client reads. */
export const MAX_REQUEST_BYTES = 256 * 1024 * 1024;

/** One slice of a request too large for one socket message: the parts of one request arrive in order, and the whole is answered once. */
export const RequestPart = z.object({
  part: z.object({ id: z.number().int(), index: z.number().int().nonnegative(), count: z.number().int().positive(), data: z.string() }),
});
export type RequestPart = z.infer<typeof RequestPart>;

// data carries the structured half of an error: a refused move's refusal, the end of what a failed child printed
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
  | { event: 'app.show'; data: AppShow };

export const Hello = z.object({ token: z.string() });
export const HelloResult = z.object({ ok: z.literal(true), protocol: z.number().int() });
export type HelloResult = z.infer<typeof HelloResult>;
// the daemon's answer to a socket it admits, which a client checks the protocol by
export const HelloReply = z.object({ id: z.literal(0), result: HelloResult });
export type HelloReply = z.infer<typeof HelloReply>;
// the close code for a socket the proxy brought from a tailnet login the fleet does not accept
export const LOGIN_REFUSED = 4403;
// the close code for a phone socket that carries no pass cookie: the page has to be opened from the QR code again
export const UNPAIRED = 4402;

// bump on any change an older app or daemon would misread; the handshake reply carries it
export const PROTOCOL_VERSION = 35;
