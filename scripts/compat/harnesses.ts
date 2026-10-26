import { execFileSync } from 'node:child_process';
import type { AgentKind } from '@svall/protocol';
import { CLAUDE_HOOKS, CODEX_HOOKS } from '../../packages/svalld/src/hooks/receiver.js';
import { hasKey, newest, quotedTypes, rustEnumTags, rustStructFields, tsConstStrings, tsTypeProps } from './extract.js';

/** Vendor files by path; undefined is a file the release no longer has. */
export type Files = Record<string, string | undefined>;
/** `missing`: what Svall reads that the release no longer declares. `events`: every hook or event the release has. */
export type Result = { missing: string[]; events: string[] };
export type Harness = {
  // the release to check and the version a fresh install gets; `note` says why they differ from the newest, and
  // `problem` what about the releases needs a look
  latest(): Promise<Release>;
  files(version: string): Promise<Files>;
  check(files: Files): Result;
};

export type Release = { version: string; fresh: string; note?: string; problem?: string };

/** A vendor source that couldn't be reached, as opposed to one that answered without the file. */
export class Unreachable extends Error {}

// `ms` bounds the body's download too
async function fetchOk(url: string, ms = 30_000): Promise<Response | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'svall-compat' }, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new Unreachable(`${url}: ${(e as Error).message}`);
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Unreachable(`${url}: HTTP ${res.status}`);
  return res;
}
const text = async (url: string) => (await fetchOk(url))?.text();
async function json<T>(url: string): Promise<T> {
  const t = await text(url);
  if (t === undefined) throw new Unreachable(`${url}: 404`);
  return JSON.parse(t) as T;
}
const raw = (repo: string, ref: string, file: string) => text(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`);
async function rawAll(repo: string, ref: string, paths: string[]): Promise<Files> {
  return Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await raw(repo, ref, p)] as const)));
}

/** A file of an npm tarball, or undefined when the tarball or the file is gone. */
async function untar(url: string | undefined, file: string, ms?: number): Promise<Buffer | undefined> {
  const tgz = url === undefined ? undefined : await fetchOk(url, ms);
  if (!tgz) return undefined;
  const input = Buffer.from(await tgz.arrayBuffer());
  try {
    return execFileSync('tar', ['-xzOf', '-', `package/${file}`], { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    // tar fails when the tarball no longer holds the file
    return undefined;
  }
}

/** Each word that a file of `words` no longer holds, as `<label> <word>`; a file that is gone is left to the caller. */
const lost = (f: Files, words: Record<string, string[]>, label: string): string[] =>
  Object.entries(words).flatMap(([p, ws]) => (f[p] === undefined ? [] : ws.filter((w) => !f[p]!.includes(w)).map((w) => `${label} ${w}`)));

// hook fields Svall keeps (agent-hook.mjs KEEP) or reads before keeping, on every event and per event
const HOOK_COMMON = ['hook_event_name', 'session_id', 'transcript_path', 'cwd'];
export const CLAUDE_FIELDS: Record<(typeof CLAUDE_HOOKS)[number], string[]> = {
  SessionStart: ['model'],
  UserPromptSubmit: ['prompt', 'prompt_id'],
  PreToolUse: ['tool_name', 'agent_id'],
  PostToolUse: ['tool_name', 'tool_response', 'agent_id'],
  PostToolUseFailure: ['tool_name', 'agent_id'],
  PermissionRequest: ['tool_name', 'tool_input', 'agent_id'],
  Notification: ['notification_type', 'message'],
  Stop: ['background_tasks'],
  StopFailure: ['error', 'last_assistant_message'],
  SubagentStart: ['agent_id'],
  SubagentStop: ['agent_id'],
  SessionEnd: [],
};
export const CODEX_FIELDS: Record<(typeof CODEX_HOOKS)[number], string[]> = {
  SessionStart: ['model'],
  UserPromptSubmit: ['prompt', 'turn_id'],
  PreToolUse: ['tool_name', 'turn_id', 'agent_id'],
  PermissionRequest: ['tool_name', 'tool_input', 'turn_id', 'agent_id'],
  PostToolUse: ['tool_name', 'turn_id', 'agent_id'],
  Stop: ['turn_id'],
  Interrupt: ['turn_id'],
  SubagentStart: ['agent_id'],
  SubagentStop: ['agent_id'],
  SessionEnd: [],
};

// Claude Code's own source isn't public; the Agent SDK, released with each version, types every hook's payload
type SdkDoc = { versions: Record<string, { claudeCodeVersion?: string; dist: { tarball: string } }> };
let sdkDoc: Promise<SdkDoc> | undefined;
const sdk = () => (sdkDoc ??= json<SdkDoc>('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk'));
const SDK_TYPES = 'sdk.d.ts';
// no SDK holds Claude Code's config keys or session paths; its native binary, published with each release, holds its JS as plain text
const CLAUDE_BIN = 'claude';
const binTarball = (version: string) => `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-${version}.tgz`;
// what the session adapter (src/handover/sessions/claude.ts) reads: projects/<slug>/<id>.jsonl, by the minified joins that
// build it, and the config and settings keys that trust a folder and accept bypass mode
const CLAUDE_STRINGS = [',"projects")', '}.jsonl`', '.claude.json', '.config.json', 'settings.local.json',
  'hasTrustDialogAccepted', 'bypassPermissionsModeAccepted', 'skipDangerousModePermissionPrompt'];

/** The Claude Code release to check: the newest, or while its Agent SDK isn't out yet, the newest one an SDK types. */
const DAY = 24 * 60 * 60 * 1000;

/** The Claude Code release to check: the newest, or while its Agent SDK isn't out yet, the newest one an SDK types.
 * The SDK follows within minutes to hours, so one missing for two days is a problem. */
export function claudeRelease(latest: string, typed: string[], publishedAt: string, now = Date.now()): Release {
  if (typed.includes(latest)) return { version: latest, fresh: latest };
  const version = newest(typed);
  if (!version) throw new Unreachable('no Agent SDK names a Claude Code version');
  const days = Math.floor((now - Date.parse(publishedAt)) / DAY);
  if (days < 2) return { version, fresh: latest, note: `no Agent SDK for ${latest} yet` };
  return { version, fresh: latest, problem: `Claude Code ${latest} has had no Agent SDK for ${days} days, so its hooks go unchecked` };
}

const claude: Harness = {
  async latest() {
    const doc = await json<{ 'dist-tags': { latest: string }; time: Record<string, string> }>('https://registry.npmjs.org/@anthropic-ai/claude-code');
    const latest = doc['dist-tags'].latest;
    return claudeRelease(latest, Object.values((await sdk()).versions).flatMap((v) => v.claudeCodeVersion ?? []), doc.time[latest]);
  },
  async files(version) {
    const pkg = Object.values((await sdk()).versions).find((v) => v.claudeCodeVersion === version);
    // the binary runs to a hundred megabytes and more
    const [types, bin] = await Promise.all([untar(pkg?.dist.tarball, SDK_TYPES), untar(binTarball(version), CLAUDE_BIN, 10 * 60_000)]);
    return { [SDK_TYPES]: types?.toString('utf8'), [CLAUDE_BIN]: bin?.toString('latin1') };
  },
  check(f) {
    const bin = f[CLAUDE_BIN];
    const sessions = bin === undefined ? ["Claude Code's native binary"] : CLAUDE_STRINGS.filter((w) => !bin.includes(w)).map((w) => `session ${w}`);
    const src = f[SDK_TYPES];
    if (src === undefined) return { missing: [`the Agent SDK's ${SDK_TYPES}`, ...sessions], events: [] };
    const base = tsTypeProps(src, 'BaseHookInput') ?? [];
    const missing = CLAUDE_HOOKS.flatMap((e) => {
      const own = tsTypeProps(src, `${e}HookInput`);
      if (!own) return [`hook ${e}`];
      return [...HOOK_COMMON, ...CLAUDE_FIELDS[e]].filter((k) => !base.includes(k) && !own.includes(k)).map((k) => `${e}.${k}`);
    });
    const events = tsConstStrings(src, 'HOOK_EVENTS');
    return { missing: [...missing, ...(events ? [] : ['HOOK_EVENTS']), ...sessions], events: events ?? [] };
  },
};

const CODEX = 'openai/codex';
const HOOK_DIR = 'codex-rs/hooks/schema/generated';
const HOOK_LIST = `${HOOK_DIR}/`;
const kebab = (e: string) => e.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase();
const pascal = (k: string) => k.replace(/(?:^|-)([a-z])/g, (_, c: string) => c.toUpperCase());
const hookSchema = (e: string) => `${HOOK_DIR}/${kebab(e)}.command.input.schema.json`;
const ROLLOUT = 'codex-rs/history/src/rollout_payload.rs';
const PROTOCOL = 'codex-rs/protocol/src/protocol.rs';
const ITEMS = 'codex-rs/protocol/src/items.rs';
const MODELS = 'codex-rs/protocol/src/models.rs';
// the rollout records Svall reads, for prompt history and turns, the working directory, context % and the usage panel
export const CODEX_LOG: [file: string, kind: 'enum' | 'struct', name: string, names: string[]][] = [
  [ROLLOUT, 'enum', 'RolloutItemWire', ['response_item', 'event_msg']],
  [PROTOCOL, 'enum', 'EventMsg', ['token_count', 'user_message', 'agent_message', 'item_completed']],
  [PROTOCOL, 'struct', 'TokenCountEvent', ['info', 'rate_limits']],
  [PROTOCOL, 'struct', 'TokenUsageInfo', ['last_token_usage', 'model_context_window']],
  [PROTOCOL, 'struct', 'TokenUsage', ['total_tokens']],
  [PROTOCOL, 'struct', 'RateLimitSnapshot', ['primary', 'secondary']],
  [PROTOCOL, 'struct', 'RateLimitWindow', ['used_percent', 'window_minutes', 'resets_at']],
  [ITEMS, 'enum', 'TurnItem', ['UserMessage', 'AgentMessage', 'CommandExecution']],
  [ITEMS, 'struct', 'UserMessageItem', ['content']],
  [ITEMS, 'struct', 'AgentMessageItem', ['content']],
  [ITEMS, 'struct', 'CommandExecutionItem', ['cwd']],
  [MODELS, 'enum', 'ResponseItem', ['function_call', 'custom_tool_call']],
];
const CONFIG_TOML = 'codex-rs/config/src/config_toml.rs';
const CONFIG_TYPES = 'codex-rs/config/src/types.rs';
// the config.toml keys the session adapter reads to trust a folder, and the -c tui.resume_cwd=session a revive passes
export const CODEX_CONFIG: typeof CODEX_LOG = [
  [CONFIG_TOML, 'struct', 'ConfigToml', ['projects', 'tui']],
  [CONFIG_TOML, 'struct', 'ProjectConfig', ['trust_level']],
  ['codex-rs/protocol/src/config_types.rs', 'enum', 'TrustLevel', ['trusted']],
  [CONFIG_TYPES, 'struct', 'Tui', ['resume_cwd']],
  [CONFIG_TYPES, 'enum', 'ResumeCwdMode', ['session']],
];
// where the session adapter (src/handover/sessions/codex.ts) finds a rollout: sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl
const CODEX_PATHS: Record<string, string[]> = {
  'codex-rs/rollout/src/lib.rs': ['SESSIONS_SUBDIR: &str = "sessions"'],
  'codex-rs/rollout/src/recorder.rs': ['push(SESSIONS_SUBDIR)', 'push(timestamp.year().to_string())', '"{:02}", u8::from(timestamp.month())', '"{:02}", timestamp.day()'],
  'codex-rs/rollout/src/rollout_file_name.rs': ['"[year]-[month]-[day]T[hour]-[minute]-[second]"', '"rollout-{timestamp}-{}.jsonl"'],
};

const codex: Harness = {
  async latest() {
    const { version } = await json<{ version: string }>('https://registry.npmjs.org/@openai/codex/latest');
    return { version, fresh: version };
  },
  async files(version) {
    const ref = `rust-v${version}`;
    const listing = await fetchOk(`https://api.github.com/repos/${CODEX}/contents/${HOOK_DIR}?ref=${ref}`);
    const names = listing && ((await listing.json()) as { name: string }[]).map((x) => x.name).join('\n');
    const paths = [...CODEX_HOOKS.map(hookSchema), ...new Set([...CODEX_LOG, ...CODEX_CONFIG].map(([file]) => file)), ...Object.keys(CODEX_PATHS)];
    return { [HOOK_LIST]: names, ...(await rawAll(CODEX, ref, paths)) };
  },
  check(f) {
    const missing: string[] = [];
    for (const e of CODEX_HOOKS) {
      const schema = f[hookSchema(e)];
      if (schema === undefined) { missing.push(`hook ${e}`); continue; }
      const props = Object.keys((JSON.parse(schema) as { properties?: object }).properties ?? {});
      missing.push(...[...HOOK_COMMON, ...CODEX_FIELDS[e]].filter((k) => !props.includes(k)).map((k) => `${e}.${k}`));
    }
    for (const [file, kind, name, names] of [...CODEX_LOG, ...CODEX_CONFIG]) {
      const src = f[file];
      const have = src === undefined ? undefined : kind === 'enum' ? rustEnumTags(src, name) : rustStructFields(src, name);
      if (!have) { missing.push(`${kind} ${name}`); continue; }
      missing.push(...names.filter((n) => !have.includes(n)).map((n) => `${name}.${n}`));
    }
    missing.push(...Object.keys(CODEX_PATHS).filter((p) => f[p] === undefined), ...lost(f, CODEX_PATHS, 'session'));
    const events = (f[HOOK_LIST] ?? '').split('\n').flatMap((n) => /^(.+)\.command\.input\.schema\.json$/.exec(n)?.[1] ?? []).map(pascal);
    return { missing: f[HOOK_LIST] === undefined ? [...missing, HOOK_LIST] : missing, events };
  },
};

const OPENCODE = 'anomalyco/opencode';
const SCHEMA = ['packages/schema/src/session-event.ts', 'packages/schema/src/permission.ts', 'packages/schema/src/form.ts', 'packages/schema/src/shell.ts'];
// the plugin API calls hooks/opencode-plugin.js makes, what it reads of the shell tool's result and an MCP server's form, and
// the tool it takes away, by the file that declares them
const PLUGIN_API: Record<string, string[]> = {
  'packages/plugin/src/promise/session.ts': ['"prompt"', '"context"'],
  'packages/plugin/src/promise/tool.ts': ['"execute.before"', '"execute.after"', 'transform', 'remove('],
  'packages/plugin/src/promise/event.ts': ['subscribe'],
  'packages/core/src/tool/plugin/shell.ts': ['status: output.status', 'shellID: output.shellID', 'status: "running"'],
  'packages/core/src/tool/plugin/opencode.ts': ['name: "worktree_create"', 'namespace: "opencode"'],
  'packages/core/src/mcp/index.ts': ['kind: "mcp-elicitation"', 'message: params.message'],
};
// what the session adapter (src/handover/sessions/opencode.ts) reads: an export's message ids, pending undo and folder, and
// what export, import and a session it does not hold print
const SESSION_API: Record<string, string[]> = {
  'packages/cli/src/commands/handlers/session/export.ts': ['process.stdout.write(JSON.stringify(data'],
  'packages/cli/src/commands/handlers/session/import.ts': ['`Imported session: ${', 'Session already exists'],
  'packages/server/src/handlers/session-error.ts': ['`Session not found: '],
  'packages/schema/src/session-transfer.ts': ['info: Session.Info', 'messages: Schema.Array(SessionMessage.Info)'],
  'packages/schema/src/session.ts': ['location: Location.Ref', 'revert: Revert'],
  'packages/schema/src/location.ts': ['directory: AbsolutePath'],
  'packages/schema/src/session-message.ts': ['id: ID'],
};
// the JSON `auth list --format json` writes, which the login probe counts providers in
const LOGIN_API: Record<string, string[]> = {
  'packages/cli/src/commands/handlers/auth/list.ts': ['input.format === "json"', 'id: integration.id', 'name: integration.name', 'connections: integration.connections'],
};
const OPENCODE_FILES = [...SCHEMA, ...Object.keys(PLUGIN_API), ...Object.keys(SESSION_API), ...Object.keys(LOGIN_API)];
// the events hooks/opencode-plugin.js handles, and the payload fields it reads
export const OPENCODE_EVENTS = ['session.created', 'session.model.selected', 'session.step.started', 'session.step.ended', 'session.text.ended',
  'permission.asked', 'form.created', 'permission.replied', 'form.replied', 'form.cancelled',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted',
  'session.moved', 'shell.exited', 'shell.deleted'];
const OPENCODE_FIELDS = ['sessionID', 'parentID', 'model', 'tokens', 'text', 'id', 'action', 'resources', 'requestID', 'form', 'error', 'fields', 'description', 'metadata'];

/** The OpenCode release to check, from its v2 and v3 tag refs and the version a fresh install gets. A 3.x tag is a
 * problem: the plugin and this check are written against OpenCode 2. */
export function opencodeRelease(v2: string[], v3: string[], fresh: string): Release {
  const version = newest(v2);
  if (!version) throw new Unreachable(`${OPENCODE}: no v2 tags`);
  const next = newest(v3);
  const release: Release = { version, fresh };
  return next ? { ...release, problem: `OpenCode ${next} is out, and Svall and this check cover 2.x only` } : release;
}

const opencode: Harness = {
  async latest() {
    // OpenCode 2 has v2.x tags but no GitHub releases, which are 1.x; opencode.ai/v2/install fetches the version here
    const refs = (major: number) => json<{ ref: string }[]>(`https://api.github.com/repos/${OPENCODE}/git/matching-refs/tags/v${major}.`);
    const [v2, v3, fresh] = await Promise.all([refs(2), refs(3), json<{ version: string }>('https://opencode.ai/update/api/latest/cli/npm')]);
    return opencodeRelease(v2.map((t) => t.ref), v3.map((t) => t.ref), fresh.version);
  },
  files: (version) => rawAll(OPENCODE, `v${version}`, OPENCODE_FILES),
  check(f) {
    const gone = OPENCODE_FILES.filter((p) => f[p] === undefined);
    const schema = SCHEMA.map((p) => f[p] ?? '').join('\n');
    const events = quotedTypes(schema);
    const missing = [
      ...gone,
      ...OPENCODE_EVENTS.filter((e) => !events.includes(e)).map((e) => `event ${e}`),
      ...OPENCODE_FIELDS.filter((k) => !hasKey(schema, k)).map((k) => `field ${k}`),
      ...lost(f, PLUGIN_API, 'plugin API'),
      ...lost(f, SESSION_API, 'session'),
      ...lost(f, LOGIN_API, 'login'),
    ];
    return { missing, events };
  },
};

export const HARNESSES: Record<AgentKind, Harness> = { claude, codex, opencode };

/** Per CLI, the help screens to read on the installed binary and the flags or subcommands Svall passes that each must list. */
export const HELP: Record<AgentKind, [argv: string[], words: string[]][]> = {
  claude: [
    [['--help'], ['-p', '--print', '--model', '--add-dir', '--resume', '--tools', '--setting-sources', '--strict-mcp-config',
      '--no-session-persistence', '--input-format', '--output-format', '--verbose', '--system-prompt']],
    [['auth', 'status', '--help'], ['--json']],
  ],
  codex: [
    [['--help'], ['resume', 'exec', 'app-server', 'login', '-m']],
    [['resume', '--help'], ['-c', '--config']],
    [['exec', '--help'], ['--json', '-m', '-c', '--sandbox', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o']],
    [['login', '--help'], ['status']],
  ],
  opencode: [
    [['--help'], ['--standalone', '-s', '--prompt']],
    [['run', '--help'], ['--standalone', '--format', '--agent', '-m']],
    [['session', 'export', '--help'], ['--standalone']],
    [['session', 'import', '--help'], ['--standalone', '--directory']],
    [['session', 'delete', '--help'], ['--standalone']],
    [['auth', 'list', '--help'], ['--standalone', '--format']],
  ],
};
