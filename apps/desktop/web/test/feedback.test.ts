import { expect, test, vi } from 'vitest';
import { FEEDBACK_DIAGNOSTICS_MAX } from '@svall/protocol';
import { connectDiagnostics, sendFeedback } from '../src/feedback.js';

test('sendFeedback posts JSON to the endpoint and leaves diagnostics out when absent', async () => {
  const f = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
  await sendFeedback({ kind: 'idea', text: 'x' }, f);
  expect(f).toHaveBeenCalledWith('https://svall.dev/api/feedback', expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ kind: 'idea', text: 'x' });
});

test('sendFeedback posts the diagnostics when given', async () => {
  const f = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
  await sendFeedback({ kind: 'bug', text: 'x', diagnostics: 'd' }, f);
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ kind: 'bug', text: 'x', diagnostics: 'd' });
});

test("sendFeedback rejects with the Worker's error", () =>
  expect(sendFeedback({ kind: 'bug', text: 'x' }, async () => new Response('{"error":"slow down"}', { status: 429 }))).rejects.toThrow('slow down'));

test('sendFeedback rejects with the status when the body has no error', () =>
  expect(sendFeedback({ kind: 'bug', text: 'x' }, async () => new Response('nope', { status: 502 }))).rejects.toThrow("Couldn't send: 502"));

test('sendFeedback rejects offline with "Couldn\'t send:"', () =>
  expect(sendFeedback({ kind: 'bug', text: 'x' }, async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow("Couldn't send: Failed to fetch"));

test('connectDiagnostics masks the user home under /Users/<name> and keeps the last 200 lines', () => {
  const log = Array.from({ length: 250 }, (_, i) => `l${i} /Users/ann/.svall`);
  const t = connectDiagnostics({ home: '/Users/ann/.svall', log, op: false });
  expect(t.split('\n')[0]).toBe('svall (svalld not running)');
  expect(t).toContain('svalld.log, last 200 lines');
  expect(t).toContain('l249 ~/.svall');
  expect(t).not.toContain('l49 ');
  expect(t).not.toContain('/Users/ann');
});

test('connectDiagnostics masks nothing when the home is not under /Users', () => {
  expect(connectDiagnostics({ home: '/root/.svall', log: ['at /root/.svall'], op: false })).toContain('at /root/.svall');
});

test('connectDiagnostics drops the oldest lines to fit, then cuts a lone oversized line', () => {
  const big = connectDiagnostics({ home: '/Users/ann/.svall', log: ['old', 'x'.repeat(30_000), 'y'.repeat(30_000)], op: false });
  expect(big.length).toBeLessThanOrEqual(FEEDBACK_DIAGNOSTICS_MAX);
  expect(big).not.toContain('old');
  expect(big).toContain('y'.repeat(100));
  const lone = connectDiagnostics({ home: '/Users/ann/.svall', log: ['z'.repeat(60_000)], op: false });
  expect(lone.length).toBe(FEEDBACK_DIAGNOSTICS_MAX);
  expect(lone.startsWith('svall (svalld not running)\n\nsvalld.log, last 200 lines\n')).toBe(true);
});
