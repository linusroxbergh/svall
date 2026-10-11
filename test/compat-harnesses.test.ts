import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CLAUDE_HOOKS, CODEX_HOOKS } from '../packages/svalld/src/hooks/receiver.js';
import { CLAUDE_FIELDS, CODEX_FIELDS, CODEX_LOG, HARNESSES, OPENCODE_EVENTS, type Files } from '../scripts/compat/harnesses.js';

const ROOT = path.join(import.meta.dirname, '..');

// vendor files holding exactly what Svall reads, to take one thing out of
const claudeSdk = (drop?: string) => [
  "export declare const HOOK_EVENTS: readonly ['PreToolUse', 'Stop'];",
  'export declare type BaseHookInput = {\n    session_id: string;\n    transcript_path: string;\n    cwd: string;\n};',
  ...CLAUDE_HOOKS.map((e) => `export declare type ${e}HookInput = BaseHookInput & {\n${['hook_event_name', ...CLAUDE_FIELDS[e]].filter((k) => `${e}.${k}` !== drop).map((k) => `    ${k}: string;`).join('\n')}\n};`),
].join('\n');

const codexFiles = (): Files => {
  const files: Files = { 'codex-rs/hooks/schema/generated/': 'stop.command.input.schema.json\nsubagent-start.command.input.schema.json\nstop.command.output.schema.json' };
  for (const e of CODEX_HOOKS) {
    const props = Object.fromEntries(['hook_event_name', 'session_id', 'transcript_path', 'cwd', ...CODEX_FIELDS[e]].map((k) => [k, {}]));
    files[`codex-rs/hooks/schema/generated/${e.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()}.command.input.schema.json`] = JSON.stringify({ properties: props });
  }
  for (const [file, kind, name, names] of CODEX_LOG) {
    const item = kind === 'enum'
      ? `#[serde(tag = "type"${/^[a-z]/.test(names[0]) ? ', rename_all = "snake_case"' : ''})]\npub enum ${name} {\n${names.map((n) => `    ${n.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}(X),`).join('\n')}\n}`
      : `pub struct ${name} {\n${names.map((n) => `    pub ${n}: X,`).join('\n')}\n}`;
    files[file] = `${files[file] ?? ''}\n${item}`;
  }
  return files;
};

const opencodeFiles = (): Files => ({
  'packages/schema/src/session-event.ts': OPENCODE_EVENTS.map((e) => `x({ type: "${e}", schema: {} })`).join('\n')
    + '\nconst f = { sessionID: 1, parentID: 1, model: 1, tokens: 1, text: 1, id: 1, action: 1, resources: 1, requestID: 1, form: 1, error: 1, fields: 1, description: 1, metadata: 1 }',
  'packages/schema/src/permission.ts': '',
  'packages/schema/src/form.ts': '',
  'packages/plugin/src/promise/session.ts': 'hook("prompt") hook("context")',
  'packages/plugin/src/promise/tool.ts': 'hook("execute.before") hook("execute.after")',
  'packages/plugin/src/promise/event.ts': 'Pick<EventApi, "subscribe">',
});

describe('checks', () => {
  test('Claude: a release with everything passes, and one that drops a field Svall reads names it', () => {
    expect(HARNESSES.claude.check({ 'sdk.d.ts': claudeSdk() })).toEqual({ missing: [], events: ['PreToolUse', 'Stop'] });
    expect(HARNESSES.claude.check({ 'sdk.d.ts': claudeSdk('Notification.notification_type') }).missing).toEqual(['Notification.notification_type']);
    expect(HARNESSES.claude.check({ 'sdk.d.ts': claudeSdk().replace('export declare type StopHookInput', 'export declare type Gone') }).missing).toEqual(['hook Stop']);
    expect(HARNESSES.claude.check({ 'sdk.d.ts': undefined }).missing).toEqual(["the Agent SDK's sdk.d.ts"]);
  });

  test('Codex: hooks and rollout records Svall reads are checked, and the hook list read', () => {
    expect(HARNESSES.codex.check(codexFiles())).toEqual({ missing: [], events: ['Stop', 'SubagentStart'] });
    const f = codexFiles();
    f['codex-rs/protocol/src/protocol.rs'] = f['codex-rs/protocol/src/protocol.rs']!.replace('TokenCount(X),', '').replace('pub total_tokens: X,', '');
    f['codex-rs/hooks/schema/generated/permission-request.command.input.schema.json'] = undefined;
    expect(HARNESSES.codex.check(f).missing).toEqual(['hook PermissionRequest', 'EventMsg.token_count', 'TokenUsage.total_tokens']);
  });

  test('OpenCode: events, fields and plugin API are checked', () => {
    expect(HARNESSES.opencode.check(opencodeFiles()).missing).toEqual([]);
    const f = opencodeFiles();
    f['packages/schema/src/session-event.ts'] = f['packages/schema/src/session-event.ts']!.replace('"session.step.ended"', '"session.step.done"').replace('tokens: 1, ', '');
    f['packages/plugin/src/promise/tool.ts'] = 'hook("execute.before")';
    f['packages/schema/src/form.ts'] = undefined;
    expect(HARNESSES.opencode.check(f).missing).toEqual(['packages/schema/src/form.ts', 'event session.step.ended', 'field tokens', 'plugin API "execute.after"']);
  });
});

describe('what Svall reads stays listed', () => {
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
