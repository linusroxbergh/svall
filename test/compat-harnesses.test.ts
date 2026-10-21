import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CLAUDE_HOOKS, CODEX_HOOKS } from '../packages/svalld/src/hooks/receiver.js';
import { CLAUDE_FIELDS, CODEX_CONFIG, CODEX_FIELDS, CODEX_LOG, HARNESSES, HELP, OPENCODE_EVENTS, type Files } from '../scripts/compat/harnesses.js';

const ROOT = path.join(import.meta.dirname, '..');

// vendor files holding exactly what Svall reads, to take one thing out of
const claudeSdk = (drop?: string) => [
  "export declare const HOOK_EVENTS: readonly ['PreToolUse', 'Stop'];",
  'export declare type BaseHookInput = {\n    session_id: string;\n    transcript_path: string;\n    cwd: string;\n};',
  ...CLAUDE_HOOKS.map((e) => `export declare type ${e}HookInput = BaseHookInput & {\n${['hook_event_name', ...CLAUDE_FIELDS[e]].filter((k) => `${e}.${k}` !== drop).map((k) => `    ${k}: string;`).join('\n')}\n};`),
].join('\n');
// what the session adapter reads out of Claude Code's binary, as its bundled JS spells it
const claudeBin = 'function gg(){return S(Me(),"projects")}let o=S(xb(a),`${e}.jsonl`);S(n,".claude.json");S(n,".config.json");'
  + 'S(d,".claude","settings.local.json");var zhe={hasTrustDialogAccepted:!1};ue().bypassPermissionsModeAccepted;skipDangerousModePermissionPrompt:x()';
const claudeFiles = (sdk = claudeSdk()): Files => ({ 'sdk.d.ts': sdk, claude: claudeBin });

const codexFiles = (): Files => {
  const files: Files = { 'codex-rs/hooks/schema/generated/': 'stop.command.input.schema.json\nsubagent-start.command.input.schema.json\nstop.command.output.schema.json' };
  for (const e of CODEX_HOOKS) {
    const props = Object.fromEntries(['hook_event_name', 'session_id', 'transcript_path', 'cwd', ...CODEX_FIELDS[e]].map((k) => [k, {}]));
    files[`codex-rs/hooks/schema/generated/${e.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()}.command.input.schema.json`] = JSON.stringify({ properties: props });
  }
  for (const [file, kind, name, names] of [...CODEX_LOG, ...CODEX_CONFIG]) {
    const item = kind === 'enum'
      ? `#[serde(tag = "type"${/^[a-z]/.test(names[0]) ? ', rename_all = "snake_case"' : ''})]\npub enum ${name} {\n${names.map((n) => `    ${n.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}(X),`).join('\n')}\n}`
      : `pub struct ${name} {\n${names.map((n) => `    pub ${n}: X,`).join('\n')}\n}`;
    files[file] = `${files[file] ?? ''}\n${item}`;
  }
  files['codex-rs/rollout/src/lib.rs'] = 'pub const SESSIONS_SUBDIR: &str = "sessions";';
  files['codex-rs/rollout/src/recorder.rs'] = ['dir.push(SESSIONS_SUBDIR);', 'dir.push(timestamp.year().to_string());',
    'dir.push(format!("{:02}", u8::from(timestamp.month())));', 'dir.push(format!("{:02}", timestamp.day()));'].join('\n');
  files['codex-rs/rollout/src/rollout_file_name.rs'] = 'format_description!("[year]-[month]-[day]T[hour]-[minute]-[second]");\nformat!("rollout-{timestamp}-{}.jsonl", self.thread_id)';
  return files;
};

const opencodeFiles = (): Files => ({
  'packages/schema/src/session-event.ts': OPENCODE_EVENTS.map((e) => `x({ type: "${e}", schema: {} })`).join('\n')
    + '\nconst f = { sessionID: 1, parentID: 1, model: 1, tokens: 1, text: 1, id: 1, action: 1, resources: 1, requestID: 1, form: 1, error: 1, fields: 1, description: 1, metadata: 1 }',
  'packages/schema/src/permission.ts': '',
  'packages/schema/src/form.ts': '',
  'packages/schema/src/shell.ts': '',
  'packages/plugin/src/promise/session.ts': 'hook("prompt") hook("context")',
  'packages/plugin/src/promise/tool.ts': 'hook("execute.before") hook("execute.after") transform remove(id)',
  'packages/plugin/src/promise/event.ts': 'Pick<EventApi, "subscribe">',
  'packages/core/src/tool/plugin/shell.ts': 'metadata: { status: output.status, shellID: output.shellID } status: "running"',
  'packages/core/src/tool/plugin/opencode.ts': 'name: "worktree_create" options: { namespace: "opencode" }',
  'packages/cli/src/commands/handlers/session/export.ts': 'process.stdout.write(JSON.stringify(data, null, 2) + EOL)',
  'packages/cli/src/commands/handlers/session/import.ts': 'stderr.write(`Session already exists${EOL}`) stdout.write(`Imported session: ${imported.data.id}${EOL}`)',
  'packages/server/src/handlers/session-error.ts': 'message: `Session not found: ${error.sessionID}`',
  'packages/schema/src/session-transfer.ts': 'Schema.Struct({ info: Session.Info, messages: Schema.Array(SessionMessage.Info) })',
  'packages/schema/src/session.ts': 'Schema.Struct({ id: ID, location: Location.Ref, revert: Revert.pipe(optional) })',
  'packages/schema/src/location.ts': 'Ref = Schema.Struct({ directory: AbsolutePath })',
  'packages/schema/src/session-message.ts': 'const Base = { id: ID, time: Schema.Struct({}) }',
});

describe('checks', () => {
  test('Claude: a release with everything passes, and one that drops a field Svall reads names it', () => {
    expect(HARNESSES.claude.check(claudeFiles())).toEqual({ missing: [], events: ['PreToolUse', 'Stop'] });
    expect(HARNESSES.claude.check(claudeFiles(claudeSdk('Notification.notification_type'))).missing).toEqual(['Notification.notification_type']);
    expect(HARNESSES.claude.check(claudeFiles(claudeSdk().replace('export declare type StopHookInput', 'export declare type Gone'))).missing).toEqual(['hook Stop']);
    expect(HARNESSES.claude.check({ ...claudeFiles(), 'sdk.d.ts': undefined }).missing).toEqual(["the Agent SDK's sdk.d.ts"]);
  });

  test('Claude: where a session lies and the keys that trust a folder and accept bypass mode are read from its binary', () => {
    const f = claudeFiles();
    f.claude = f.claude!.replace('`${e}.jsonl`', '`${e}.json`').replace('hasTrustDialogAccepted', 'trustAccepted');
    expect(HARNESSES.claude.check(f).missing).toEqual(['session }.jsonl`', 'session hasTrustDialogAccepted']);
    expect(HARNESSES.claude.check({ ...claudeFiles(), claude: undefined }).missing).toEqual(["Claude Code's native binary"]);
  });

  test('Codex: hooks and rollout records Svall reads are checked, and the hook list read', () => {
    expect(HARNESSES.codex.check(codexFiles())).toEqual({ missing: [], events: ['Stop', 'SubagentStart'] });
    const f = codexFiles();
    f['codex-rs/protocol/src/protocol.rs'] = f['codex-rs/protocol/src/protocol.rs']!.replace('TokenCount(X),', '').replace('pub total_tokens: X,', '');
    f['codex-rs/hooks/schema/generated/permission-request.command.input.schema.json'] = undefined;
    expect(HARNESSES.codex.check(f).missing).toEqual(['hook PermissionRequest', 'EventMsg.token_count', 'TokenUsage.total_tokens']);
  });

  test('Codex: where a rollout lies, the key that trusts a folder and the resume_cwd a revive passes are checked', () => {
    const f = codexFiles();
    f['codex-rs/config/src/types.rs'] = f['codex-rs/config/src/types.rs']!.replace('pub resume_cwd: X,', '');
    f['codex-rs/protocol/src/config_types.rs'] = f['codex-rs/protocol/src/config_types.rs']!.replace('Trusted(X),', 'Allowed(X),');
    f['codex-rs/rollout/src/recorder.rs'] = f['codex-rs/rollout/src/recorder.rs']!.replace('timestamp.day()', 'timestamp.ordinal()');
    f['codex-rs/rollout/src/rollout_file_name.rs'] = undefined;
    expect(HARNESSES.codex.check(f).missing).toEqual(['TrustLevel.trusted', 'Tui.resume_cwd', 'codex-rs/rollout/src/rollout_file_name.rs', 'session "{:02}", timestamp.day()']);
  });

  test('OpenCode: events, fields and plugin API are checked', () => {
    expect(HARNESSES.opencode.check(opencodeFiles()).missing).toEqual([]);
    const f = opencodeFiles();
    f['packages/schema/src/session-event.ts'] = f['packages/schema/src/session-event.ts']!.replace('"session.step.ended"', '"session.step.done"').replace('tokens: 1, ', '');
    f['packages/plugin/src/promise/tool.ts'] = 'hook("execute.before") transform remove(id)';
    f['packages/schema/src/form.ts'] = undefined;
    expect(HARNESSES.opencode.check(f).missing).toEqual(['packages/schema/src/form.ts', 'event session.step.ended', 'field tokens', 'plugin API "execute.after"']);
  });

  test('OpenCode: what the session adapter reads of an export, and of what import prints, is checked', () => {
    const f = opencodeFiles();
    f['packages/cli/src/commands/handlers/session/import.ts'] = 'Session already exists stdout.write(`Imported ${imported.data.id}${EOL}`)';
    f['packages/schema/src/session.ts'] = 'Schema.Struct({ id: ID, location: Location.Ref })';
    f['packages/schema/src/session-transfer.ts'] = undefined;
    expect(HARNESSES.opencode.check(f).missing).toEqual(['packages/schema/src/session-transfer.ts', 'session `Imported session: ${', 'session revert: Revert']);
  });
});

describe('what Svall reads stays listed', () => {
  test('every flag the OpenCode session adapter passes is looked for in its session command\'s help', () => {
    const adapter = fs.readFileSync(path.join(ROOT, 'packages/svalld/src/handover/sessions/opencode.ts'), 'utf8');
    const passed = Array.from(adapter.matchAll(/\['session', '(\w+)', ([^\]]*)\]/g), (m) => [m[1], Array.from(m[2].matchAll(/'(--[\w-]+)'/g), (x) => x[1])] as const);
    expect(new Set(passed.map(([sub]) => sub))).toEqual(new Set(['export', 'import', 'delete']));
    for (const [sub, flags] of passed) {
      expect(HELP.opencode.find(([argv]) => argv.join(' ') === `session ${sub} --help`)?.[1], sub).toEqual(expect.arrayContaining(flags));
    }
  });

  test('the OpenCode events checked are the ones the plugin handles', () => {
    const plugin = fs.readFileSync(path.join(ROOT, 'packages/svalld/hooks/opencode-plugin.js'), 'utf8');
    const handled = Array.from(plugin.matchAll(/case '([a-z.]+)':/g), (m) => m[1]);
    expect([...OPENCODE_EVENTS].sort()).toEqual([...new Set(handled)].sort());
  });

  test('every hook field the hook script keeps is checked for Claude Code or Codex', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'packages/svalld/hooks/agent-hook.mjs'), 'utf8');
    const keep = Array.from(/const KEEP = \[([^\]]*)\]/.exec(hook)![1].matchAll(/'([^']+)'/g), (m) => m[1]);
    const checked = new Set(['hook_event_name', 'session_id', 'transcript_path', 'cwd', ...Object.values(CLAUDE_FIELDS).flat(), ...Object.values(CODEX_FIELDS).flat()]);
    // task_id is set by the hook itself, from a Monitor's tool_response
    expect(keep.filter((k) => !checked.has(k) && k !== 'task_id')).toEqual([]);
  });
});
