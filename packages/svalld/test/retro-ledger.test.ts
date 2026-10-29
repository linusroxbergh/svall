import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '@svall/protocol';
import { dismissedCategories, findingId, mark, readLedger, recordFindings, writeLedger } from '../src/retro/ledger.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const finding = (id: string, category: Finding['category'] = 'correction'): Finding => ({
  id, category, title: `t ${id}`, problem: 'p', fix: 'f', evidence: [], sessions: 3, prs: 0,
  change: { kind: 'proposal', summary: 's', text: 't' }, target: null,
  value: { badge: 'Med', score: 7, n: 3, m: 10, impact: 2, confidence: 1, reason: '3 of 10 sessions' }, effort: 'rule line',
  verdict: { claim: 'holds', change: 'ok', reason: 'r' }, groups: [{ kind: 'correction', key: 'report-style' }], kind: 'pattern',
  measure: { keys: [{ kind: 'correction', key: 'report-style' }], before: { count: 3, of: 10 }, after: null },
});

describe('the ledger', () => {
  it('keeps the same id for the same issue across runs, and a new one for another file or category', () => {
    expect(findingId('correction', '/s/CLAUDE.md', 'reports')).toBe(findingId('correction', '/s/CLAUDE.md', 'reports'));
    expect(findingId('correction', '/s/CLAUDE.md', 'reports')).not.toBe(findingId('correction', '/t/CLAUDE.md', 'reports'));
    expect(findingId('correction', '/s/CLAUDE.md', 'reports')).not.toBe(findingId('rule-missed', '/s/CLAUDE.md', 'reports'));
    expect(findingId('correction', '/s/CLAUDE.md', 'reports')).toMatch(/^[0-9a-f]{10}$/);
  });

  it('opens a new finding, keeps the status of one seen again, and writes and reads back', () => {
    let l = recordFindings({}, [finding('a')], 1);
    l = mark(l, 'a', 'later', { at: 2 });
    l = recordFindings(l, [finding('a'), finding('b')], 3);
    expect(l.a).toMatchObject({ status: 'later', firstSeen: 1, lastSeen: 3 });
    expect(l.b).toMatchObject({ status: 'open', firstSeen: 3, category: 'correction', measure: finding('b').measure });
    const file = path.join(makeHome(), 'ledger.v2.json');
    writeLedger(file, l);
    expect(readLedger(file)).toEqual(l);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, JSON.stringify({ a: l.a, junk: { id: 1 } }));
    expect(Object.keys(readLedger(file))).toEqual(['a']);
    expect(readLedger('/nonexistent/ledger.v2.json')).toEqual({});
  });

  it('records a fix date and a dismissal reason, and lists dismissed categories once', () => {
    let l = recordFindings({}, [finding('a'), finding('b'), finding('c', 'noise')], 1);
    l = mark(l, 'a', 'fixed', { at: 5 });
    l = mark(l, 'b', 'dismissed', { at: 6, reason: 'wrong' });
    expect(l.a).toMatchObject({ status: 'fixed', fixedAt: 5 });
    expect(l.b).toMatchObject({ status: 'dismissed', reason: 'wrong' });
    expect(l.b).not.toHaveProperty('fixedAt');
    expect(dismissedCategories(mark(l, 'c', 'dismissed', { at: 7, reason: 'not-worth-it' }))).toEqual([
      { category: 'correction', reason: 'wrong' }, { category: 'noise', reason: 'not-worth-it' },
    ]);
  });
});
