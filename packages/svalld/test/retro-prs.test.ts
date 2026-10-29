import { describe, expect, it } from 'vitest';
import type { Outline, SkillRun } from '../src/retro/outline.js';
import { joinRun, prThread, revisionAt, type PrThread } from '../src/retro/prs.js';

const URL = 'https://github.com/o/r/pull/7';
const at = (t: string) => Date.parse(`2026-10-20T${t}Z`);

// a PR by `me` with a conversation comment each, a review, three inline comments (one a reply) and four commits
function gh(calls: string[][]) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pr') {
      return JSON.stringify({
        author: { login: 'me' },
        comments: [
          { id: 'IC_1', author: { login: 'me' }, body: 'my own note', createdAt: '2026-10-20T10:00:00Z' },
          { id: 'IC_2', author: { login: 'kim' }, body: `${'x'.repeat(1490)} TOKEN="${'q'.repeat(500)}"`, createdAt: '2026-10-20T12:00:00Z' },
        ],
        reviews: [
          { id: 'PRR_1', author: { login: 'kim' }, body: '', submittedAt: '2026-10-20T09:30:00Z' },
          { id: 'PRR_2', author: { login: 'kim' }, body: 'token ghp_abcdefghijklmnopqrstuvwx', submittedAt: '2026-10-20T11:00:00Z', commit: { oid: 'c2' } },
        ],
        commits: [
          { oid: 'c1', committedDate: '2026-10-20T08:00:00Z' }, { oid: 'c2', committedDate: '2026-10-20T09:00:00Z' },
          { oid: 'c3', committedDate: '2026-10-20T13:00:00Z' }, { oid: 'c4', committedDate: '2026-10-20T14:00:00Z' },
        ],
      });
    }
    if (args[3] === 'repos/o/r/pulls/7/comments') {
      return JSON.stringify([[
        { id: 11, user: { login: 'kim', type: 'User' }, body: 'no test for the retry', created_at: '2026-10-20T10:30:00Z', path: 'src/a.ts', diff_hunk: `@@ -1,3 +1,4 @@\n${'+x\n'.repeat(600)}+retry()`, original_commit_id: 'c2' },
        { id: 12, in_reply_to_id: 11, user: { login: 'me', type: 'User' }, body: 'fixed in c3', created_at: '2026-10-20T13:05:00Z', path: 'src/a.ts', diff_hunk: '@@', original_commit_id: 'c2' },
        { id: 13, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'consider a guard', created_at: '2026-10-20T10:40:00Z', path: 'src/b.ts', diff_hunk: '@@ b', original_commit_id: 'c2' },
      ]]);
    }
    const sha = /commits\/(\w+)$/.exec(args[3])?.[1];
    return JSON.stringify(sha === 'c3' ? ['src/a.ts'] : ['README.md']);
  };
}

describe('prThread', () => {
  it('keeps every comment and reply with its id, path, hunk and commit, the author\'s included, oldest first, redacted and clipped', async () => {
    const calls: string[][] = [];
    const t = await prThread(URL, { since: at('10:00:00'), gh: gh(calls) });
    expect(calls.slice(0, 2)).toEqual([
      ['pr', 'view', URL, '--json', 'author,comments,reviews,commits'],
      ['api', '--hostname', 'github.com', 'repos/o/r/pulls/7/comments', '--paginate', '--slurp'],
    ]);
    expect(t.author).toBe('me');
    expect(t.comments.map((c) => [c.id, c.kind, c.author, c.bot, c.replyTo, c.path, c.commit])).toEqual([
      ['IC_1', 'conversation', 'me', false, undefined, undefined, undefined],
      ['11', 'inline', 'kim', false, undefined, 'src/a.ts', 'c2'],
      ['13', 'inline', 'coderabbitai[bot]', true, undefined, 'src/b.ts', 'c2'],
      ['PRR_2', 'review', 'kim', false, undefined, undefined, 'c2'],
      ['IC_2', 'conversation', 'kim', false, undefined, undefined, undefined],
      ['12', 'inline', 'me', false, '11', 'src/a.ts', 'c2'],
    ]);
    const [, inline, , review, long] = t.comments;
    expect(review.body).toBe('token [redacted]');
    // masked whole, then clipped, so the clip leaves none of a secret it cuts
    expect(long.body).toHaveLength(1500);
    expect(long.body).not.toContain('q');
    // a hunk keeps its end, the line commented on
    expect(inline.hunk!.length).toBeLessThanOrEqual(1500);
    expect(inline.hunk!.endsWith('+retry()')).toBe(true);
  });

  it('reads the files of the commits after `since` only, at most 30, and says when it cut', async () => {
    const calls: string[][] = [];
    const t = await prThread(URL, { since: at('10:00:00'), gh: gh(calls) });
    expect(t.commits).toEqual([
      { sha: 'c1', at: at('08:00:00') }, { sha: 'c2', at: at('09:00:00') },
      { sha: 'c3', at: at('13:00:00'), files: ['src/a.ts'] }, { sha: 'c4', at: at('14:00:00'), files: ['README.md'] },
    ]);
    expect(t.truncated).toBe(false);
    expect(calls.slice(2).map((c) => c[3])).toEqual(['repos/o/r/commits/c3', 'repos/o/r/commits/c4']);

    const many = async (args: string[]) => (args[0] === 'pr'
      ? JSON.stringify({ author: { login: 'me' }, comments: [], reviews: [], commits: Array.from({ length: 40 }, (_, i) => ({ oid: `s${i}`, committedDate: new Date(at('11:00:00') + i * 1000).toISOString() })) })
      : args[3].endsWith('/comments') ? '[[]]' : '["x"]');
    const cut = await prThread(URL, { since: at('10:00:00'), gh: many });
    expect(cut.commits.filter((c) => c.files)).toHaveLength(30);
    expect(cut.truncated).toBe(true);
  });

  it('rejects a link that is no PR', async () => {
    await expect(prThread('https://github.com/o/r/issues/7', { gh: gh([]) })).rejects.toThrow('not a PR');
  });
});

describe('joinRun', () => {
  const run: SkillRun = { name: 'work-review', id: 'L5.0', line: 5, at: at('10:00:00'), end: at('11:00:00') };
  const outline = (prs: Outline['prs']) => ({ prs }) as Outline;

  it('joins a run to the PR linked inside it, else the nearest before it, else the branch\'s', () => {
    expect(joinRun(outline([{ url: 'p1', at: at('09:00:00') }, { url: 'p2', at: at('10:30:00') }, { url: 'p2', at: at('10:40:00') }]), run)).toEqual({ pr: 'p2' });
    expect(joinRun(outline([{ url: 'p1', at: at('08:00:00') }, { url: 'p3', at: at('09:00:00') }, { url: 'p4', at: at('12:00:00') }]), run)).toEqual({ pr: 'p3' });
    expect(joinRun(outline([{ url: 'p4', at: at('12:00:00') }]), run, 'branch-pr')).toEqual({ pr: 'branch-pr' });
    expect(joinRun(outline([]), run)).toEqual({ failed: 'none' });
  });

  it('reports a run naming two PRs as ambiguous', () => {
    expect(joinRun(outline([{ url: 'p1', at: at('10:10:00') }, { url: 'p2', at: at('10:20:00') }]), run, 'branch-pr')).toEqual({ failed: 'ambiguous' });
  });

  it('takes the reviewed revision as the last commit at or before a time', () => {
    const t = { commits: [{ sha: 'c1', at: at('08:00:00') }, { sha: 'c2', at: at('09:00:00') }, { sha: 'c3', at: at('13:00:00') }] } as PrThread;
    expect(revisionAt(t, at('11:00:00'))).toBe('c2');
    expect(revisionAt(t, at('09:00:00'))).toBe('c2');
    expect(revisionAt(t, at('07:00:00'))).toBeUndefined();
  });
});
