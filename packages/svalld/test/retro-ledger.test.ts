import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '@svall/protocol';
import { dismissedCategories, findingId, mark, measure, readLedger, recordFindings, writeLedger } from '../src/retro/ledger.js';
import type { Outline, SkillRun } from '../src/retro/outline.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const finding = (id: string, category = 'skipped-step'): Finding => ({
  id, focus: 'skill-tweaks', category, title: `t ${id}`, claim: 'c', evidence: [], sessions: 3, prs: 0,
  change: { kind: 'proposal', summary: 's', text: 't' }, target: null,
  measure: { kind: 'followups-after-skill', subject: 'publish', name: 'interrupts after /publish', before: { count: 9, of: 20 }, after: null }, rank: 1,
});

const session = (id: string, skills: Partial<SkillRun>[], at = 1000): Outline => ({
  agent: 'claude', session: id, file: `/t/${id}.jsonl`, start: at, end: at + 500, turns: [], prompts: [],
  skills: skills.map((s) => ({ name: 'publish', line: 1, at: at + 10, end: at + 20, ...s })),
  tools: 0, errors: 0, interrupts: 0, rejected: 0, prs: [], commands: [], hookErrors: 0, work: { wrote: {}, ran: {} },
});

describe('the ledger', () => {
  it('keeps the same id for the same issue across runs, and a new one for another file', () => {
    expect(findingId('skill-tweaks', 'skipped-step', '/s/SKILL.md', 'publish')).toBe(findingId('skill-tweaks', 'skipped-step', '/s/SKILL.md', 'publish'));
    expect(findingId('skill-tweaks', 'skipped-step', '/s/SKILL.md', 'publish')).not.toBe(findingId('skill-tweaks', 'skipped-step', '/t/SKILL.md', 'publish'));
    expect(findingId('skill-tweaks', 'skipped-step', '/s/SKILL.md', 'publish')).toMatch(/^[0-9a-f]{10}$/);
  });

  it('opens a new finding, keeps the status of one seen again, and writes and reads back', () => {
    let l = recordFindings({}, [finding('a')], 1);
    l = mark(l, 'a', 'later', { at: 2 });
    l = recordFindings(l, [finding('a'), finding('b')], 3);
    expect(l.a).toMatchObject({ status: 'later', firstSeen: 1, lastSeen: 3 });
    expect(l.b).toMatchObject({ status: 'open', firstSeen: 3 });
    const file = path.join(makeHome(), 'ledger.json');
    writeLedger(file, l);
    expect(readLedger(file)).toEqual(l);
    fs.writeFileSync(file, JSON.stringify({ a: l.a, junk: { id: 1 } }));
    expect(Object.keys(readLedger(file))).toEqual(['a']);
    expect(readLedger('/nonexistent/ledger.json')).toEqual({});
  });

  it('records a fix date and a dismissal reason, and lists dismissed categories once', () => {
    let l = recordFindings({}, [finding('a'), finding('b'), finding('c', 'redone')], 1);
    l = mark(l, 'a', 'fixed', { at: 5 });
    l = mark(l, 'b', 'dismissed', { at: 6, reason: 'wrong' });
    expect(l.a).toMatchObject({ status: 'fixed', fixedAt: 5 });
    expect(l.b).toMatchObject({ status: 'dismissed', reason: 'wrong' });
    expect(l.b).not.toHaveProperty('fixedAt');
    expect(dismissedCategories(mark(l, 'c', 'dismissed', { at: 7, reason: 'not-worth-it' }))).toEqual([
      { focus: 'skill-tweaks', category: 'skipped-step', reason: 'wrong' },
      { focus: 'skill-tweaks', category: 'redone', reason: 'not-worth-it' },
    ]);
  });
});

describe('measure', () => {
  const span = { from: 0, to: 10_000 };

  it('counts follow-ups after a skill over its runs', () => {
    const outlines = [session('s1', [{ next: 'interrupt' }, {}]), session('s2', [{ next: 'reply' }]), session('s3', [{ name: 'other', next: 'rejected' }])];
    expect(measure({ kind: 'followups-after-skill', subject: 'publish' }, { outlines, span })).toEqual({ count: 2, of: 3 });
  });

  it('counts the sessions a skill ran in', () => {
    const outlines = [session('s1', [{}]), session('s2', []), session('s3', [{ name: 'other' }])];
    expect(measure({ kind: 'runs-of-skill', subject: 'publish' }, { outlines, span })).toEqual({ count: 1, of: 3 });
  });

  it('counts review runs whose PR took a comment after the run', () => {
    const outlines = [session('s1', [{ name: 'work-review' }]), session('s2', [{ name: 'work-review' }]), session('s3', [{ name: 'work-review' }])];
    const prOf = new Map([['s1', 'pr1'], ['s2', 'pr2']]);
    const comments = new Map([['pr1', [{ at: 5000 }]], ['pr2', [{ at: 1005 }]]]);
    expect(measure({ kind: 'later-comments-after-review', subject: 'work-review' }, { outlines, span, prOf, comments })).toEqual({ count: 1, of: 2 });
  });

  it('has no rate for a kind without a count, or with nothing to count over', () => {
    expect(measure({ kind: 'none', subject: null }, { outlines: [session('s1', [{}])], span })).toBeNull();
    expect(measure({ kind: 'followups-after-skill', subject: 'publish' }, { outlines: [], span })).toBeNull();
  });
});
