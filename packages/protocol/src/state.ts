import { z } from 'zod';
import { Portrait } from './portraits.js';

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

// a revive types the session id into a shell, so only the id shape Claude Code and Codex both use is trusted
export const isSessionId = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export const AgentKind = z.enum(['claude', 'codex']);
export type AgentKind = z.infer<typeof AgentKind>;

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

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
  // the turn ended with background agents still running; the agent works on until they report back
  background: z.literal(true).optional(),
  // Claude Code subagents with a permission request open; the notification that blocks never says whose it is
  asking: z.array(z.string()).optional(),
  // the tool Claude Code's main thread last asked permission for, whose run alone answers the question
  askedTool: z.string().optional(),
  // the newest prompt Claude Code accepted, as its UserPromptSubmit hook reported it. The transcript
  // is written after that hook, so this is what the last command reads until the entry lands.
  lastPrompt: z.object({ id: z.string(), text: z.string(), at: z.number() }).optional(),
  lastActivityAt: z.number(),
  // the agent process the session runs in; a `claude -p` nested inside it shares the character, not the process
  pid: z.number().int().optional(),
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

// the tabs of a character's browser, kept here so they outlive the app; active is the one on screen
export const Browser = z.object({ tabs: z.array(BrowserTab), active: z.string().optional() });
export type Browser = z.infer<typeof Browser>;

export const Cell = z.object({ x: z.number().int(), y: z.number().int() });
export type Cell = z.infer<typeof Cell>;
export const Size = z.object({ w: z.number().int().min(4), h: z.number().int().min(3) });
export type Size = z.infer<typeof Size>;

export const Island = z.object({
  id: z.string(), name: z.string(), description: z.string(), instructions: z.string(), context: z.array(ContextItem),
  position: Cell, size: Size, seed: z.number().int(),
  // a folded island is drawn as its label alone, and holds only that much ground
  collapsed: z.boolean().optional(),
  kind: z.literal('home').optional(),
  // set by a person's edit; absent, the scribe may rewrite it
  descriptionSource: z.literal('manual').optional(),
  // its place in the list, set by a sidebar drag; islands without one follow, by name
  order: z.number().int().optional(),
});
export type Island = z.infer<typeof Island>;

// the order islands are listed in; home sorts last so the next-island key reaches it after every other island
export const byIslandOrder = (a: Island, b: Island): number =>
  Number(a.kind === 'home') - Number(b.kind === 'home') || (a.order ?? Infinity) - (b.order ?? Infinity)
  || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export const HomeAction = z.object({ label: z.string().min(1), prompt: z.string().min(1) });
export type HomeAction = z.infer<typeof HomeAction>;

// where a new character starts when it has no character beside it to take a directory from
export const DEFAULT_CWD = '~';

// the home island's crew cwd, the command a button types to start an agent, and the buttons themselves
export const Home = z.object({
  cwd: z.string().default('~/.svall/home'),
  command: z.string().default('claude --model sonnet'),
  actions: z.array(HomeAction).default([
    { label: 'update info', prompt: '/svall-update-info' },
    { label: 'status', prompt: '/svall-status' },
  ]),
});
export type Home = z.infer<typeof Home>;
export const defaultHome = (): Home => Home.parse({});

// a character's second terminal: a plain shell beside the main one. It is never dormant: when its
// tmux window is gone, so is this record
export const Second = z.object({
  tmux: z.object({ windowId: z.string(), paneId: z.string() }),
  agent: Agent.optional(),
  unread: z.boolean(),
});
export type Second = z.infer<typeof Second>;

export const Character = z.object({
  id: z.string(),
  islandId: z.string(),
  cell: Cell,
  name: z.string(),
  note: z.string(),
  // set by a person's edit; absent, the scribe may rewrite it
  noteSource: z.literal('manual').optional(),
  portrait: Portrait,
  instructions: z.string(),
  // a file's name, without .md, in the fleet's agent-profiles folder; its text rides in the brief
  agentProfile: z.string().optional(),
  cwd: z.string(),
  // the tmux pane's own path when last read; cwd moves with it only when it changes, so a restart keeps where the hooks put it
  panePath: z.string().optional(),
  repo: Repo.optional(),
  context: z.array(ContextItem),
  tmux: z.object({ windowId: z.string(), paneId: z.string() }).optional(),
  // the pane's last output, kept current only while the character has no agent
  shell: z.object({ lastOutputAt: z.number() }),
  agent: Agent.optional(),
  unread: z.boolean(),
  // the window runs codex and no hook has come from it: codex skips a hook until it is trusted, without a word
  hint: z.enum(['codex-silent']).optional(),
  revive: z.object({ command: z.string() }).optional(),
  browser: Browser.optional(),
  second: Second.optional(),
});
export type Character = z.infer<typeof Character>;

export const FleetState = z.object({
  version: z.literal(7),
  // the name config.json gives the fleet; absent, its directory names it
  name: z.string().optional(),
  islands: z.record(z.string(), Island),
  characters: z.record(z.string(), Character),
  home: Home.prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the scribe is switched off: no automatic pass runs and a sweep is refused
  scribeOff: z.literal(true).optional(),
  // a new fleet's automatic passes wait until the user turns the scribe on or off
  scribeAsk: z.literal(true).optional(),
  // the last automatic or swept pass that failed, cleared by the next one that succeeds
  scribeError: z.object({ message: z.string(), at: z.number() }).optional(),
  // an agent idle this many hours is ended and its character left dormant, to be resumed on revive;
  // 0 keeps every agent running, and absent is DORMANT_AFTER_HOURS
  dormantAfterHours: z.number().int().min(0).optional(),
  // the agent the scribe, mission control's crew and `svall char new --run` use by default, the CLIs svalld finds, and the one the scribe uses
  mainAgent: AgentKind.optional(),
  agentsFound: z.array(AgentKind).optional(),
  scribeAgent: AgentKind.optional(),
});
export type FleetState = z.infer<typeof FleetState>;

export const DORMANT_AFTER_HOURS = 12;

export const emptyState = (): FleetState => ({ version: 7, islands: {}, characters: {}, home: defaultHome(), defaultCwd: DEFAULT_CWD, scribeAsk: true });
