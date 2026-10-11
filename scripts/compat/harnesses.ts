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

async function fetchOk(url: string): Promise<Response | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'svall-compat' }, signal: AbortSignal.timeout(30_000) });
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
  SessionEnd: [],
};

// Claude Code's own source isn't public; the Agent SDK, released with each version, types every hook's payload
type SdkDoc = { versions: Record<string, { claudeCodeVersion?: string; dist: { tarball: string } }> };
let sdkDoc: Promise<SdkDoc> | undefined;
const sdk = () => (sdkDoc ??= json<SdkDoc>('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk'));
const SDK_TYPES = 'sdk.d.ts';

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
    const tgz = pkg && (await fetchOk(pkg.dist.tarball));
    if (!tgz) return { [SDK_TYPES]: undefined };
    const input = Buffer.from(await tgz.arrayBuffer());
    try {
      return { [SDK_TYPES]: execFileSync('tar', ['-xzOf', '-', `package/${SDK_TYPES}`], { input, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) };
    } catch {
      // tar fails when the tarball no longer holds the file
      return { [SDK_TYPES]: undefined };
    }
  },
  check(f) {
    const src = f[SDK_TYPES];
    if (src === undefined) return { missing: [`the Agent SDK's ${SDK_TYPES}`], events: [] };
    const base = tsTypeProps(src, 'BaseHookInput') ?? [];
    const missing = CLAUDE_HOOKS.flatMap((e) => {
      const own = tsTypeProps(src, `${e}HookInput`);
      if (!own) return [`hook ${e}`];
      return [...HOOK_COMMON, ...CLAUDE_FIELDS[e]].filter((k) => !base.includes(k) && !own.includes(k)).map((k) => `${e}.${k}`);
    });
    const events = tsConstStrings(src, 'HOOK_EVENTS');
    return { missing: events ? missing : [...missing, 'HOOK_EVENTS'], events: events ?? [] };
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

const codex: Harness = {
  async latest() {
    const { version } = await json<{ version: string }>('https://registry.npmjs.org/@openai/codex/latest');
    return { version, fresh: version };
  },
  async files(version) {
    const ref = `rust-v${version}`;
    const listing = await fetchOk(`https://api.github.com/repos/${CODEX}/contents/${HOOK_DIR}?ref=${ref}`);
    const names = listing && ((await listing.json()) as { name: string }[]).map((x) => x.name).join('\n');
    const paths = [...CODEX_HOOKS.map(hookSchema), ...new Set(CODEX_LOG.map(([file]) => file))];
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
    for (const [file, kind, name, names] of CODEX_LOG) {
      const src = f[file];
      const have = src === undefined ? undefined : kind === 'enum' ? rustEnumTags(src, name) : rustStructFields(src, name);
      if (!have) { missing.push(`${kind} ${name}`); continue; }
      missing.push(...names.filter((n) => !have.includes(n)).map((n) => `${name}.${n}`));
    }
    const events = (f[HOOK_LIST] ?? '').split('\n').flatMap((n) => /^(.+)\.command\.input\.schema\.json$/.exec(n)?.[1] ?? []).map(pascal);
    return { missing: f[HOOK_LIST] === undefined ? [...missing, HOOK_LIST] : missing, events };
  },
};

const OPENCODE = 'anomalyco/opencode';
const SCHEMA = ['packages/schema/src/session-event.ts', 'packages/schema/src/permission.ts', 'packages/schema/src/form.ts'];
// the plugin API calls hooks/opencode-plugin.js makes, by the file that declares them
const PLUGIN_API: Record<string, string[]> = {
  'packages/plugin/src/promise/session.ts': ['"prompt"', '"context"'],
  'packages/plugin/src/promise/tool.ts': ['"execute.before"', '"execute.after"'],
  'packages/plugin/src/promise/event.ts': ['subscribe'],
};
// the events hooks/opencode-plugin.js handles, and the payload fields it reads
export const OPENCODE_EVENTS = ['session.created', 'session.model.selected', 'session.step.started', 'session.step.ended', 'session.text.ended',
  'permission.asked', 'form.created', 'permission.replied', 'form.replied', 'form.cancelled',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'];
const OPENCODE_FIELDS = ['sessionID', 'parentID', 'model', 'tokens', 'text', 'id', 'action', 'resources', 'requestID', 'form', 'error', 'fields', 'description', 'metadata'];

/** The OpenCode release to check, from its v2 and v3 tag refs and the tag of GitHub's latest release. A 3.x tag is a
 * problem: the plugin and this check are written against OpenCode 2. */
export function opencodeRelease(v2: string[], v3: string[], latestRelease: string): Release {
  const version = newest(v2);
  if (!version) throw new Unreachable(`${OPENCODE}: no v2 tags`);
  const next = newest(v3);
  const release: Release = { version, fresh: latestRelease.replace(/^v/, '') };
  return next ? { ...release, problem: `OpenCode ${next} is out, and Svall and this check cover 2.x only` } : release;
}

const opencode: Harness = {
  async latest() {
    // OpenCode 2 ships through the anomalyco/tap Homebrew tap and v2.x tags; GitHub's latest release, which
    // opencode.ai/install fetches, can be a 1.x one
    const refs = (major: number) => json<{ ref: string }[]>(`https://api.github.com/repos/${OPENCODE}/git/matching-refs/tags/v${major}.`);
    const [v2, v3, release] = await Promise.all([refs(2), refs(3), json<{ tag_name: string }>(`https://api.github.com/repos/${OPENCODE}/releases/latest`)]);
    return opencodeRelease(v2.map((t) => t.ref), v3.map((t) => t.ref), release.tag_name);
  },
  files: (version) => rawAll(OPENCODE, `v${version}`, [...SCHEMA, ...Object.keys(PLUGIN_API)]),
  check(f) {
    const gone = [...SCHEMA, ...Object.keys(PLUGIN_API)].filter((p) => f[p] === undefined);
    const schema = SCHEMA.map((p) => f[p] ?? '').join('\n');
    const events = quotedTypes(schema);
    const missing = [
      ...gone,
      ...OPENCODE_EVENTS.filter((e) => !events.includes(e)).map((e) => `event ${e}`),
      ...OPENCODE_FIELDS.filter((k) => !hasKey(schema, k)).map((k) => `field ${k}`),
      ...Object.entries(PLUGIN_API).flatMap(([p, words]) => (f[p] === undefined ? [] : words.filter((w) => !f[p]!.includes(w)).map((w) => `plugin API ${w}`))),
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
    [['--help'], ['resume', 'exec', 'app-server', 'login']],
    [['resume', '--help'], ['-c', '--config']],
    [['exec', '--help'], ['--json', '-m', '-c', '--sandbox', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o']],
    [['login', '--help'], ['status']],
  ],
  opencode: [
    [['--help'], ['--standalone', '-s', '--prompt']],
    [['run', '--help'], ['--standalone', '--format', '--agent', '-m']],
    [['session', 'delete', '--help'], ['--standalone']],
    [['auth', 'list', '--help'], ['--standalone']],
  ],
};
