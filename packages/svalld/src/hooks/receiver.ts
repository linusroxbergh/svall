import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AgentKind, isSessionId } from '@svall/protocol';
import type { Logger } from '../log.js';

// Claude Code ends a turn an API error cut short with StopFailure, in place of Stop. PermissionRequest,
// SubagentStart and SubagentStop only say which subagent asked, and when one starts and is gone. A tool that has run,
// or failed, was answered if it asked, which is the first word that a picked choice gives
export const CLAUDE_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd'] as const;
// codex asks permission through an event of its own, where Claude Code sends a notification, and says
// when the tool it asked about has run, which is the only word that the wait is over. An Esc ends its turn with Interrupt
export const CODEX_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop', 'SessionEnd'] as const;
// Svall's OpenCode plugin names OpenCode's events after these hooks: an Esc ends a turn with Interrupt, an error with StopFailure,
// and a child session's run is a subagent's. It sends no SessionEnd, so a quit OpenCode is gone once its pane is back at a shell
export const OPENCODE_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'StopFailure', 'Interrupt', 'SubagentStart', 'SubagentStop'] as const;
export type HookName = (typeof CLAUDE_HOOKS)[number] | (typeof CODEX_HOOKS)[number] | (typeof OPENCODE_HOOKS)[number];

const HOOKS: Record<AgentKind, readonly HookName[]> = { claude: CLAUDE_HOOKS, codex: CODEX_HOOKS, opencode: OPENCODE_HOOKS };
export const hooksFor = (backend: AgentKind): readonly HookName[] => HOOKS[backend];

const MAX_LINE = 256 * 1024;

export type HookEvent = {
  robotId: string;
  backend: AgentKind;
  name: HookName;
  sessionId?: string;
  transcriptPath?: string;
  notificationType?: string;
  message?: string;
  model?: string;
  prompt?: { id: string; text: string };
  backgroundTasks?: number;
  // the background agents and workflows among them, the only ones that can ask a question
  backgroundAgents?: number;
  // their ids, which are the subagents' own
  backgroundAgentIds?: string[];
  // the task ids of the background shells among them, which take in the session's monitors
  backgroundShells?: string[];
  // the task a Monitor tool call started, or the shell OpenCode sent to the background, its only way to watch
  monitor?: string;
  // the subagent the event came from, or the one any agent says started or stopped
  agentId?: string;
  // the tool a tool or permission event is about
  toolName?: string;
  cwd?: string;
  // 2 when the event comes from the robot's second terminal
  term?: 2;
  // the agent process that ran the hook
  pid?: number;
};

// what Claude Code hands its statusLine command, forwarded by claude-status.mjs
export type StatusEvent = {
  robotId: string;
  sessionId?: string;
  contextPct: number;
  model?: string;
  // 2 when the event comes from the robot's second terminal
  term?: 2;
};

export type SocketEvent = { hook: HookEvent } | { status: StatusEvent };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const sessionId = (v: unknown): string | undefined => {
  const s = str(v);
  return s && isSessionId(s) ? s : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// the daemon reads this path back out over the API, so a hook must not be able to name an arbitrary file,
// nor one longer than macOS lets a path be
const MAX_PATH = 1024;
const transcript = (v: unknown): string | undefined => {
  const s = str(v);
  return s?.startsWith('/') && s.endsWith('.jsonl') && s.length <= MAX_PATH ? s : undefined;
};

// Claude's SessionStart on a resume from another folder names that folder's project, which holds no file of the
// session; its transcript is then the newest one another project of the same projects folder holds under its id
export function claudeTranscript(file: string, id: string | undefined): string {
  const projects = path.dirname(path.dirname(file));
  if (!id || path.basename(file) !== `${id}.jsonl` || path.basename(projects) !== 'projects' || fs.existsSync(file)) return file;
  let names: string[];
  try { names = fs.readdirSync(projects); } catch { return file; }
  let found: { file: string; at: number } | undefined;
  for (const name of names) {
    const f = path.join(projects, name, `${id}.jsonl`);
    // most folders hold no file of the session, which stat answers without throwing; a file among them still throws
    let at: number | undefined;
    try { at = fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs; } catch { continue; }
    if (at !== undefined && (!found || at > found.at)) found = { file: f, at };
  }
  return found?.file ?? file;
}

// a pasted prompt runs to megabytes; only its head is ever shown. The id pairs the hook with the
// transcript entry Claude Code writes for it afterwards; Codex names the turn the prompt opened instead.
export const MAX_PROMPT = 4000;
// the harness re-invokes a session through the same hook when a background agent finishes, when a peer
// hands back, and when a usage limit resets, carrying its own report as the prompt. Nobody typed those.
const INJECTED = ['<task-notification>', 'Another Claude session sent a message:', '<agent-message', '<cross-session-message', 'Your claude.ai usage limit has reset.'];
const prompt = (h: Record<string, unknown>): { id: string; text: string } | undefined => {
  const id = (str(h.prompt_id) ?? str(h.turn_id))?.slice(0, 200);
  const text = str(h.prompt)?.trim().slice(0, MAX_PROMPT);
  if (text && INJECTED.some((p) => text.startsWith(p))) return undefined;
  return id && text ? { id, text } : undefined;
};

// a finished background agent, workflow or shell re-invokes the session; a monitor watches on and rarely ends.
// A list with none of them says none is left, which no list at all does not
const AGENT_TASKS = new Set(['subagent', 'workflow']);
const WORKING_TASKS = new Set([...AGENT_TASKS, 'shell']);
const count = (v: unknown, types: Set<string>): number | undefined =>
  Array.isArray(v) ? v.filter((t) => types.has((t as { type?: unknown } | null)?.type as string)).length : undefined;
const taskIds = (v: unknown, types: Set<string>): string[] | undefined => Array.isArray(v)
  ? v.flatMap((t) => { const { type, id } = (t ?? {}) as { type?: unknown; id?: unknown }; return types.has(type as string) && typeof id === 'string' ? [id.slice(0, 64)] : []; })
  : undefined;
const SHELL_TASKS = new Set(['shell']);

export function normalizeStatus(raw: unknown): StatusEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // an OpenCode plugin loaded by an older svalld names its robot charId
  const { robotId = (raw as { charId?: unknown }).charId, status, term } = raw as { robotId?: unknown; status?: unknown; term?: unknown };
  if (typeof robotId !== 'string' || !status || typeof status !== 'object') return undefined;
  const s = status as Record<string, unknown>;
  const contextPct = num(s.contextPct);
  if (contextPct === undefined) return undefined;
  const ev: StatusEvent = { robotId, contextPct: Math.max(0, Math.min(100, contextPct)) };
  if (term === 2) ev.term = 2;
  const id = sessionId(s.sessionId);
  const model = str(s.model);
  if (id) ev.sessionId = id;
  if (model) ev.model = model;
  return ev;
}

// the events kept from a subagent, named by it: those that ask, and answer, its own question. A Codex subagent shares
// its parent's session and dialog
const FROM_SUBAGENT: Record<AgentKind, Set<unknown>> = {
  claude: new Set(['PreToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop']),
  codex: new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop']),
  opencode: new Set(['SubagentStart', 'SubagentStop']),
};
const SUBAGENT_LIFE = new Set<unknown>(['SubagentStart', 'SubagentStop']);
const AGENT_ID = /^[\w-]{1,64}$/;

export function normalizeHook(raw: unknown): HookEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { robotId = (raw as { charId?: unknown }).charId, backend, hook, term, pid } = raw as { robotId?: unknown; backend?: unknown; hook?: unknown; term?: unknown; pid?: unknown };
  if (typeof robotId !== 'string' || !hook || typeof hook !== 'object') return undefined;
  // a script that names no backend is Claude Code's
  const kind = AgentKind.safeParse(backend ?? 'claude');
  if (!kind.success) return undefined;
  const h = hook as Record<string, unknown>;
  const name = h.hook_event_name;
  if (!(hooksFor(kind.data) as readonly unknown[]).includes(name)) return undefined;
  // a subagent's hooks are not the robot's turn
  const subagent = typeof h.agent_id === 'string' && AGENT_ID.test(h.agent_id) ? h.agent_id : undefined;
  if (h.agent_id && !(FROM_SUBAGENT[kind.data].has(name) && subagent)) return undefined;
  if (SUBAGENT_LIFE.has(name) && !subagent) return undefined;
  const ev: HookEvent = { robotId, backend: kind.data, name: name as HookName };
  if (subagent) ev.agentId = subagent;
  if (term === 2) ev.term = 2;
  if (Number.isInteger(pid) && (pid as number) > 0) ev.pid = pid as number;
  const id = sessionId(h.session_id);
  // a codex subagent's events name its own rollout
  const named = h.agent_id ? undefined : transcript(h.transcript_path);
  const transcriptPath = named && kind.data === 'claude' && name === 'SessionStart' ? transcript(claudeTranscript(named, id)) : named;
  const notificationType = str(h.notification_type);
  const message = str(h.message);
  const tasks = count(h.background_tasks, WORKING_TASKS);
  const agents = count(h.background_tasks, AGENT_TASKS);
  if (id) ev.sessionId = id;
  if (transcriptPath) ev.transcriptPath = transcriptPath;
  if (notificationType) ev.notificationType = notificationType;
  if (message) ev.message = message.slice(0, 500);
  const model = str(h.model);
  if (model) ev.model = model.slice(0, 100);
  const toolName = str(h.tool_name);
  if (toolName) ev.toolName = toolName.slice(0, 200);
  if (tasks !== undefined) ev.backgroundTasks = tasks;
  if (agents !== undefined) ev.backgroundAgents = agents;
  const agentIds = taskIds(h.background_tasks, AGENT_TASKS);
  if (agentIds) ev.backgroundAgentIds = agentIds;
  const shells = taskIds(h.background_tasks, SHELL_TASKS);
  if (shells) ev.backgroundShells = shells;
  const watcher = toolName === (kind.data === 'opencode' ? 'shell' : 'Monitor');
  const monitor = ev.name === 'PostToolUse' && watcher ? str(h.task_id) : undefined;
  if (monitor) ev.monitor = monitor.slice(0, 64);
  if (ev.name === 'UserPromptSubmit') {
    const submitted = prompt(h);
    if (submitted) ev.prompt = submitted;
  }
  const cwd = str(h.cwd);
  if (cwd?.startsWith('/')) ev.cwd = cwd;
  return ev;
}

// hooks Claude Code waits on for a reply; every other event and every status update gets none
const REPLIES = new Set<HookName>(['SessionStart', 'UserPromptSubmit']);

// A crashed daemon can leave a socket file behind. Only remove it when nothing answers there;
// an active receiver belongs to another daemon and must keep serving its robots.
async function clearStaleSocket(sockPath: string): Promise<void> {
  let before: fs.Stats;
  try { before = fs.lstatSync(sockPath); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  if (!before.isSocket()) throw new Error(`hook receiver path is not a socket: ${sockPath}`);
  const active = await new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(sockPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') resolve(false);
      else reject(e);
    });
  });
  if (active) throw new Error(`hook receiver already running at ${sockPath}`);
  try {
    const current = fs.lstatSync(sockPath);
    if (current.dev === before.dev && current.ino === before.ino) fs.rmSync(sockPath);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}

export async function startHookReceiver(
  sockPath: string,
  onEvent: (e: SocketEvent) => string | undefined | void | Promise<string | undefined | void>,
  log: Logger,
): Promise<{ close(): Promise<void> }> {
  await clearStaleSocket(sockPath);
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    // the rest of a line already given up on for its length
    let dropping = false;
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (dropping || line.length > MAX_LINE) {
          if (!dropping) log.error(`hook line dropped: over the ${MAX_LINE} byte cap`);
          dropping = false;
          continue;
        }
        let hook: HookEvent | undefined;
        // a hook waiting on its reply gets one whatever became of the event, or it waits out its safety timer
        const answer = (reply: string | undefined | void) => {
          if (hook && REPLIES.has(hook.name)) conn.write(JSON.stringify({ additionalContext: reply ?? '' }) + '\n');
        };
        const failed = (err: unknown) => { log.error(`hook line ignored: ${String(err)}`); answer(undefined); };
        try {
          const raw: unknown = JSON.parse(line);
          hook = normalizeHook(raw);
          const status = hook ? undefined : normalizeStatus(raw);
          if (!hook && !status) continue;
          Promise.resolve(hook ? onEvent({ hook }) : onEvent({ status: status! })).then(answer, failed);
        } catch (err) {
          failed(err);
        }
      }
      // one line too long is given up on, up to and including its newline; the socket keeps reading
      if (buf.length > MAX_LINE) {
        if (!dropping) log.error(`hook line dropped: over the ${MAX_LINE} byte cap`);
        buf = '';
        dropping = true;
      }
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      fs.chmodSync(sockPath, 0o600);
      server.off('error', reject);
      server.on('error', (e) => log.error(`hook receiver: ${String(e)}`));
      const owned = fs.statSync(sockPath);
      resolve({
        close: () => new Promise((r) => {
          for (const c of conns) c.destroy();
          server.close(() => {
            // A later receiver may have replaced this pathname; only remove our own socket.
            try {
              const current = fs.statSync(sockPath);
              if (current.dev === owned.dev && current.ino === owned.ino) fs.rmSync(sockPath);
            } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`hook receiver cleanup: ${String(e)}`); }
            r();
          });
        }),
      });
    });
  });
}
