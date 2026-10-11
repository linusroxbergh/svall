import { expect, test } from 'vitest';
import { helpHas, newest, quotedTypes, rustEnumTags, rustStructFields, tsConstStrings, tsTypeProps } from '../scripts/compat/extract.js';

test('reads a type\'s own properties, not those of an object nested in it', () => {
  const src = 'export declare type A = B & {\n    a: string;\n    b?: {\n        inner: number;\n    };\n    readonly c: 1;\n};\nexport declare type D = { d: 1; };';
  expect(tsTypeProps(src, 'A')).toEqual(['a', 'b', 'c']);
  expect(tsTypeProps(src, 'Gone')).toBeUndefined();
});

test('a type with no body of its own has no properties, rather than those of the next one', () => {
  expect(tsTypeProps('export declare type A = B | C;\nexport declare type D = {\n    d: 1;\n};', 'A')).toBeUndefined();
});

test('reads a const string tuple', () => {
  expect(tsConstStrings("export declare const HOOK_EVENTS: readonly ['PreToolUse', 'Stop'];", 'HOOK_EVENTS')).toEqual(['PreToolUse', 'Stop']);
});

test('reads the tags a Rust enum serializes to', () => {
  const src = [
    '/// a doc comment naming enum EventMsg',
    '#[derive(Serialize)]',
    '#[serde(tag = "type", rename_all = "snake_case")]',
    'pub(super) enum EventMsg<\'a> {',
    '    /// done',
    '    TokenCount(TokenCountEvent),',
    '    #[serde(rename = "task_complete", alias = "turn_complete")]',
    '    TurnComplete(TurnCompleteEvent),',
    '    ResponseItem {',
    '        payload: Cow<\'a, ResponseItem>,',
    '    },',
    '}',
    '#[serde(tag = "type")]',
    'pub enum TurnItem {',
    '    UserMessage(UserMessageItem),',
    '    Text { text: String },',
    '}',
  ].join('\n');
  expect(rustEnumTags(src, 'EventMsg')).toEqual(['token_count', 'task_complete', 'response_item']);
  expect(rustEnumTags(src, 'TurnItem')).toEqual(['UserMessage', 'Text']);
  expect(rustEnumTags(src, 'Gone')).toBeUndefined();
});

test('reads a Rust struct\'s field names', () => {
  const src = 'pub struct TokenUsageInfo {\n    pub last_token_usage: TokenUsage,\n    #[serde(default)]\n    model_context_window: Option<i64>,\n}\npub struct TokenUsage {\n    pub total_tokens: i64,\n}';
  expect(rustStructFields(src, 'TokenUsageInfo')).toEqual(['last_token_usage', 'model_context_window']);
  expect(rustStructFields(src, 'TokenUsage')).toEqual(['total_tokens']);
});

test('a Rust struct\'s fields are read as serde writes them: skipped ones left out, renames applied', () => {
  const src = [
    '#[serde(rename_all = "camelCase")]',
    'pub struct Item {',
    '    pub call_id: String,',
    '    #[serde(skip)]',
    '    pub sandbox_type: X,',
    '    #[serde(default, skip_serializing_if = "Option::is_none")]',
    '    pub exit_code: Option<i32>,',
    '    /// where it ran',
    '    #[serde(rename = "cwdPath")]',
    '    pub cwd: PathUri,',
    '}',
  ].join('\n');
  expect(rustStructFields(src, 'Item')).toEqual(['callId', 'exitCode', 'cwdPath']);
});

test('a skipped Rust enum variant has no tag', () => {
  expect(rustEnumTags('#[serde(tag = "type", rename_all = "snake_case")]\npub enum E {\n    TokenCount(X),\n    #[serde(skip)]\n    Internal(Y),\n}', 'E')).toEqual(['token_count']);
});

test('a flag only mentioned in another entry\'s description is not listed', () => {
  const help = 'Usage: codex resume [OPTIONS]\nOptions:\n  -p, --print  Print\n      --json   JSON out\n  --mcp-config <c>  add --strict-mcp-config to skip\n          Include sessions in the --last selection';
  for (const w of ['-p', '--print', '--json', '--mcp-config']) expect(helpHas(help, w)).toBe(true);
  // OpenCode 2 names the short alias after the flag
  for (const w of ['--session', '-s']) expect(helpHas('  --session, -s string    Session ID to continue', w)).toBe(true);
  for (const w of ['--strict-mcp-config', '--last', 'resume']) expect(helpHas(help, w)).toBe(false);
});

test('reads OpenCode event names', () => {
  expect(quotedTypes('Event.durable({ type: "session.step.ended", schema })\nephemeral({ type: "form.created" })')).toEqual(['session.step.ended', 'form.created']);
});

test('finds a flag or subcommand in help text, and not one that only starts the same', () => {
  const help = 'Usage: x [options]\n  -s, --session <id>  resume\n  --model=<m>\n  resume   Resume a session\n  --models-list';
  for (const w of ['-s', '--session', '--model', 'resume']) expect(helpHas(help, w)).toBe(true);
  expect(helpHas(help, '--models')).toBe(false);
  expect(helpHas(help, '--prompt')).toBe(false);
});

test('picks the highest release, by number and not by text, past any pre-release', () => {
  expect(newest(['refs/tags/v2.0.9', 'refs/tags/v2.0.10', 'refs/tags/v2.1.0-beta.1'])).toBe('2.0.10');
  expect(newest([])).toBeUndefined();
});
