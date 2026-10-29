import { z } from 'zod';
import { Portrait } from './portraits.js';
import { MachineId } from './ids.js';
import { LeftBehind, MachineLink, Moving, Placement } from './placement.js';

export const AgentStatus = z.enum(['working', 'idle', 'blocked', 'done']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const PrState = z.enum(['draft', 'open', 'approved', 'changes', 'merged', 'closed']);
export type PrState = z.infer<typeof PrState>;

export const LinkKind = z.enum([
  'pr', 'issue', 'github', 'gitlab', 'linear', 'jira', 'confluence', 'notion', 'slack',
  'figma', 'sentry', 'datadog', 'vercel', 'gdocs', 'gdrive', 'npm', 'loom',
  'trello', 'asana', 'discord', 'youtube', 'stackoverflow', 'miro', 'dropbox', 'mentimeter', 'claude', 'other',
]);
export type LinkKind = z.infer<typeof LinkKind>;

export const ContextKind = z.enum([...LinkKind.options, 'file', 'folder']);
export type ContextKind = z.infer<typeof ContextKind>;

export const ContextItem = z.object({
  kind: ContextKind,
  ref: z.string(),
  label: z.string(),
  // auto items come from the branch and are rebuilt with it; scribe items come from the transcript
  source: z.enum(['manual', 'auto', 'scribe']),
  pinned: z.literal(true).optional(),
  prState: PrState.optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

// a revive types the session id into a shell, so only the id shapes the agents make are trusted: Claude Code's and
// Codex's UUIDs, OpenCode's ses_ ids
export const isSessionId = (v: string): boolean =>
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[0-9a-f]{12}[0-9A-Za-z]{14})$/i.test(v);

export const AgentKind = z.enum(['claude', 'codex', 'opencode']);
export type AgentKind = z.infer<typeof AgentKind>;

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
/** Each agent CLI's own update to its latest release, however it was installed; it runs unattended. */
export const AGENT_UPDATE: Record<AgentKind, string> = { claude: 'claude update', codex: 'codex update', opencode: 'opencode upgrade' };
/** The agents `run` updates, as their updates joined by &&; none for any other command. */
export function updatesIn(run: string): AgentKind[] | undefined {
  const kinds = run.split(' && ').map((c) => AgentKind.options.find((k) => AGENT_UPDATE[k] === c));
  return kinds.every((k) => k !== undefined) ? kinds : undefined;
}
/** What a check's sentence says before the agent updates it leaves to this Mac, each joined by `, then `. */
export const ON_THIS_MAC = 'on this Mac, run ';
/** The agents a check's sentence leaves to update on this Mac. */
export function updatesHere(said: string): AgentKind[] | undefined {
  const at = said.lastIndexOf(ON_THIS_MAC);
  return at < 0 ? undefined : updatesIn(said.slice(at + ON_THIS_MAC.length).split(';')[0].split(', then ').join(' && '));
}
// the models each CLI's --model takes, that Settings offers; OpenCode's are a provider's, left to its config
export const MODELS: Record<AgentKind, string[]> = { claude: ['haiku', 'sonnet', 'opus', 'fable'], codex: ['gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol'], opencode: [] };

// where a session a fresh start left behind stays: its transcript, or OpenCode's own store, which Svall's log only mirrors
export const keptSession = (a: { kind: AgentKind; sessionId: string; transcriptPath?: string }): string =>
  `old session ${a.sessionId} kept ${a.kind === 'opencode' || !a.transcriptPath ? `in ${AGENT_LABEL[a.kind]}` : `at ${a.transcriptPath}`}`;

export const Agent = z.object({
  kind: AgentKind,
  sessionId: z.string(),
  // codex names its rollout only once the file exists, so a session can start without one
  transcriptPath: z.string().optional(),
  status: AgentStatus,
  contextPct: z.number().optional(),
  model: z.string().optional(),
  brief: z.string().optional(),
  // what a blocked agent asked, from the notification that blocked it, or why an API error ended its turn
  prompt: z.string().optional(),
  // names the question a blocked agent is on, so an answer meant for an earlier one is refused
  promptId: z.string().optional(),
  // the turn ended with background agents or shells still running; the agent works on until they report back
  background: z.literal(true).optional(),
  // the background work is shells alone, a server or a watcher that may never end
  shellsOnly: z.literal(true).optional(),
  // task ids of the monitors the session started (Claude Code's Monitor, OpenCode's background shells), which are listed as
  // background shells but watch on without a turn
  monitors: z.array(z.string()).optional(),
  // subagents with a permission request open; Claude Code's notification that blocks never says whose it is
  asking: z.array(z.string()).optional(),
  // the subagents running, by id
  subagents: z.array(z.string()).optional(),
  // the tool the main thread last asked permission for, whose run alone answers the question
  askedTool: z.string().optional(),
  // the newest prompt Claude Code accepted, from its UserPromptSubmit hook; the transcript lands after it, so the last
  // command reads this until then
  lastPrompt: z.object({ id: z.string(), text: z.string(), at: z.number() }).optional(),
  lastActivityAt: z.number(),
  // the agent process the session runs in; a `claude -p` nested inside it shares the robot, not the process
  pid: z.number().int().optional(),
  // the launch flags a resume repeats, as ps showed the process at its start; what a dormancy without ps resumes with
  flags: z.array(z.string()).optional(),
});
export type Agent = z.infer<typeof Agent>;

export const Repo = z.object({
  root: z.string(),
  mainRoot: z.string(),
  branch: z.string(),
  isWorktree: z.boolean(),
});
export type Repo = z.infer<typeof Repo>;

export const BrowserTab = z.object({ id: z.string().min(1), url: z.string(), title: z.string() });
export type BrowserTab = z.infer<typeof BrowserTab>;

// the tabs of a robot's browser, kept here so they outlive the app; active is the one on screen
export const Browser = z.object({ tabs: z.array(BrowserTab), active: z.string().optional() });
export type Browser = z.infer<typeof Browser>;

export const Cell = z.object({ x: z.number().int(), y: z.number().int() });
export type Cell = z.infer<typeof Cell>;
export const Size = z.object({ w: z.number().int().min(4), h: z.number().int().min(3) });
export type Size = z.infer<typeof Size>;

export const Island = z.object({
  id: z.string(), name: z.string(), description: z.string(), instructions: z.string(), context: z.array(ContextItem),
  // the bare urls of scribe links a person took off, which the scribe leaves off until one is added by hand
  removedLinks: z.array(z.string()).optional(),
  position: Cell, size: Size, seed: z.number().int(),
  // a folded island is off the map and holds no ground; a folded mission control keeps its row
  collapsed: z.boolean().optional(),
  kind: z.literal('home').optional(),
  // set by a person's edit; absent, the scribe may rewrite it
  descriptionSource: z.literal('manual').optional(),
  // its place in the list, set by a sidebar drag or a rename; islands without one follow, by name
  order: z.number().int().optional(),
});
export type Island = z.infer<typeof Island>;

// the order islands are listed in; home sorts last so the next-island key reaches it after every other island
export const byIslandOrder = (a: Island, b: Island): number =>
  Number(a.kind === 'home') - Number(b.kind === 'home') || (a.order ?? Infinity) - (b.order ?? Infinity)
  || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export const HomeAction = z.object({ label: z.string().min(1), prompt: z.string().min(1) });
export type HomeAction = z.infer<typeof HomeAction>;

// where a new robot starts when it has no robot beside it to take a directory from
export const DEFAULT_CWD = '~';

// the home island's crew cwd, the command a button types to start an agent, its model, and the buttons themselves
export const Home = z.object({
  cwd: z.string().default('~/.svall/home'),
  command: z.string().default('claude --model opus'),
  // the model the crew runs; absent, the CLI picks its own
  model: z.string().optional(),
  actions: z.array(HomeAction).default([
    { label: 'update info', prompt: '/svall-update-info' },
    { label: 'status', prompt: '/svall-status' },
    { label: 'retro', prompt: '/svall-retro' },
  ]),
});
export type Home = z.infer<typeof Home>;
export const defaultHome = (): Home => Home.parse({});

// why a resume could not bring a terminal back, kept while it lies dormant and cleared once it next comes up
const ResumeError = z.string().optional();

// one terminal of a robot: its directory, its live tmux ids while it has a window, and the
// command that brings its session back once it has none
export const TerminalSlot = z.object({
  cwd: z.string(),
  tmux: z.object({ windowId: z.string(), paneId: z.string() }).optional(),
  agent: Agent.optional(),
  unread: z.boolean(),
  // interrupted: the agent was ended mid-turn or on a question, so it resumes as the fleet starts and is told what was lost
  revive: z.object({ command: z.string(), interrupted: z.literal(true).optional() }).optional(),
  resumeError: ResumeError,
});
export type TerminalSlot = z.infer<typeof TerminalSlot>;

// a robot is its main terminal and all it knows beside it; its second terminal is a side shell beside the main one
export const Robot = TerminalSlot.extend({
  id: z.string(),
  islandId: z.string(),
  cell: Cell,
  name: z.string(),
  note: z.string(),
  // set by a person's edit; absent, the scribe may rewrite it
  noteSource: z.literal('manual').optional(),
  portrait: Portrait,
  // the id of its board column; absent, or naming a column since deleted, it sits in the first
  column: z.string().optional(),
  // set by a hand move; absent, the scribe may place it
  columnSource: z.literal('manual').optional(),
  // the number of its robot-NN.svg in the desktop app's public/robots; absent, its portrait picks one
  figure: z.number().int().min(1).optional(),
  instructions: z.string(),
  // a file's name, without .md, in the fleet's agent-profiles folder; its text rides in the brief
  agentProfile: z.string().optional(),
  // the tmux pane's own path when last read; cwd moves with it only when it changes, so a restart keeps where the hooks put it
  panePath: z.string().optional(),
  repo: Repo.optional(),
  context: z.array(ContextItem),
  // the bare urls of scribe and branch links a person took off, which neither adds back until one is added by hand
  removedLinks: z.array(z.string()).optional(),
  // the pane's last output, kept current only while the robot has no agent
  shell: z.object({ lastOutputAt: z.number() }),
  // the window runs codex and no hook has come from it: codex skips a hook until it is trusted, without a word
  hint: z.enum(['codex-silent']).optional(),
  // that codex runs on Codex's shared server, whose hooks carry whichever terminal started it and are dropped
  codexDaemon: z.literal(true).optional(),
  browser: Browser.optional(),
  second: TerminalSlot.optional(),
  // the machine running it; absent, the one holding the state
  machine: MachineId.optional(),
  placement: Placement.optional(),
  moving: Moving.optional(),
  left: LeftBehind.optional(),
  // its place among the starred, lowest first; absent, it is not starred
  star: z.number().int().optional(),
});
export type Robot = z.infer<typeof Robot>;

// a column of the board the whole fleet shares; its id outlives a rename
export const Column = z.object({ id: z.string().min(1), name: z.string().min(1) });
export type Column = z.infer<typeof Column>;

export const defaultColumns = (): Column[] => [
  { id: 'todo', name: 'To do' }, { id: 'doing', name: 'In progress' }, { id: 'review', name: 'In review' }, { id: 'done', name: 'Done' },
];

// a retro run's stage; kept here rather than in retro.ts, which imports from this module
export const RetroStage = z.enum(['planned', 'reading', 'judging', 'done', 'failed', 'interrupted']);
export type RetroStage = z.infer<typeof RetroStage>;

/** The state.json schema this release reads and writes, which a worker's link has to share with its home. */
export const STATE_SCHEMA_VERSION = 12;

export const FleetState = z.object({
  version: z.literal(STATE_SCHEMA_VERSION),
  // the name fleet.json gives the fleet; absent, its directory names it
  name: z.string().optional(),
  islands: z.record(z.string(), Island),
  robots: z.record(z.string(), Robot),
  machines: z.record(MachineId, MachineLink).optional(),
  home: Home.prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the scribe is switched off: no automatic pass runs and a sweep is refused
  scribeOff: z.literal(true).optional(),
  // a new fleet's automatic passes wait until the user turns the scribe on or off
  scribeAsk: z.literal(true).optional(),
  // the board's columns, left to right; never empty
  columns: z.array(Column).min(1).default(defaultColumns),
  // the scribe's passes place no robot on the board
  placingOff: z.literal(true).optional(),
  // a fleet's passes place no robot until the user turns placing on or off
  placingAsk: z.literal(true).optional(),
  // the last automatic or swept pass that failed, cleared by the next one that succeeds
  scribeError: z.object({ message: z.string(), at: z.number() }).optional(),
  // no robot is told to work in a worktree
  worktreesOff: z.literal(true).optional(),
  // an agent idle this many hours is ended and its robot left dormant, to be resumed on revive;
  // 0 keeps every agent running, and absent is DORMANT_AFTER_HOURS
  dormantAfterHours: z.number().int().min(0).optional(),
  // the agent mission control's crew and `svall robot new --run` start by default
  mainAgent: AgentKind.optional(),
  // the agent CLIs svalld finds on its PATH
  agentsFound: z.array(AgentKind).optional(),
  // the agent the scribe runs: fleet.json's scribe.agent, else the main agent
  scribeAgent: AgentKind.optional(),
  // the model the scribe runs; absent, the CLI picks its own
  scribeModel: z.string().optional(),
  // the retro svalld is running or just ran, and the robot whose card shows its stage
  retro: z.object({ run: z.string(), stage: RetroStage, done: z.number().int(), total: z.number().int(), robot: z.string().optional() }).optional(),
});
export type FleetState = z.infer<typeof FleetState>;

export const starredOf = (f: FleetState): Robot[] =>
  Object.values(f.robots).filter((c) => c.star !== undefined).sort((a, b) => a.star! - b.star!);

export const columnOf = (f: Pick<FleetState, 'columns'>, c: Pick<Robot, 'column'>): Column =>
  f.columns.find((k) => k.id === c.column) ?? f.columns[0];

// placing rides the scribe's passes and, like the scribe, waits on the user's first answer
export const placingOn = (f: Pick<FleetState, 'placingOff' | 'placingAsk'>): boolean => !f.placingOff && !f.placingAsk;

export const DORMANT_AFTER_HOURS = 12;

export const emptyState = (): FleetState => ({ version: STATE_SCHEMA_VERSION, islands: {}, robots: {}, home: defaultHome(), defaultCwd: DEFAULT_CWD, scribeAsk: true, columns: defaultColumns(), placingAsk: true });
