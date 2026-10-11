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
