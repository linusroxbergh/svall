import { expect, test } from 'vitest';
import { issueOf, parseReport } from '../src/report.js';
import { FEEDBACK_DIAGNOSTICS_MAX, FEEDBACK_TEXT_MAX } from '../../../packages/protocol/src/feedback.js';

test('a valid report parses with text trimmed', () =>
  expect(parseReport({ kind: 'idea', text: '  hi  ' })).toEqual({ kind: 'idea', text: 'hi' }));
test.each([
  [{ kind: 'rant', text: 'x' }], [{ kind: 'bug', text: '   ' }], [{ kind: 'bug', text: 'x'.repeat(10_001) }],
  [{ kind: 'bug', text: 'x', diagnostics: 'd'.repeat(50_001) }], [{ kind: 'bug', text: 'x', diagnostics: 5 }], ['nope'],
])('rejects %j', (b) => expect(parseReport(b)).toHaveProperty('error'));
test('title is the first line, cut to 80 characters with an ellipsis', () => {
  expect(issueOf({ kind: 'bug', text: 'a'.repeat(100) + '\nmore' }).title).toBe('a'.repeat(79) + '…');
  expect(issueOf({ kind: 'bug', text: 'Map froze\nafter lid' }).title).toBe('Map froze');
});
test('labels are the kind', () => expect(issueOf({ kind: 'idea', text: 'x' }).labels).toEqual(['idea']));
test('diagnostics sit in a collapsed block whose fence outlasts any backtick run inside', () => {
  const { body } = issueOf({ kind: 'bug', text: 'see ```x``` </details>', diagnostics: 'log ````` end' });
  expect(body.startsWith('see ```x``` </details>\n')).toBe(true);
  expect(body).toMatch(/<details><summary>Diagnostics<\/summary>\n\n`{6,}text\nlog ````` end\n`{6,}\n\n<\/details>$/);
});
test('no diagnostics, no block', () => expect(issueOf({ kind: 'idea', text: 'x' }).body).toBe('x'));

test('the limits are the client\'s', () => {
  const ok = { kind: 'bug' as const, text: 'x'.repeat(FEEDBACK_TEXT_MAX), diagnostics: 'd'.repeat(FEEDBACK_DIAGNOSTICS_MAX) };
  expect(parseReport(ok)).not.toHaveProperty('error');
  expect(parseReport({ ...ok, text: ok.text + 'x' })).toHaveProperty('error');
  expect(parseReport({ ...ok, diagnostics: ok.diagnostics + 'd' })).toHaveProperty('error');
});
