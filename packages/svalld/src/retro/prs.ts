import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ellipsis } from '@svall/protocol';
import { CLIP, type Outline, type SkillRun } from './outline.js';
import { redact } from './redact.js';

const execP = promisify(execFile);

/** A comment on a PR: a conversation comment, a review's body, or an inline comment on `path` with its hunk, the commit it
 *  was made on and the comment it replies to. */
export type PrComment = {
  id: string; kind: 'inline' | 'review' | 'conversation'; author: string; bot: boolean; at: number; body: string;
  path?: string; hunk?: string; commit?: string; replyTo?: string;
};
/** A PR's comments oldest first, its author's among them, and its commits, with the files of those after `since`. */
export type PrThread = { url: string; author: string; comments: PrComment[]; commits: { sha: string; at: number; files?: string[] }[]; truncated: boolean };

type Gh = (args: string[], cwd?: string) => Promise<string>;

const run: Gh = async (args, cwd) =>
  (await execP('gh', args, { cwd, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })).stdout;

type Said = { id?: string; author?: { login?: string } | null; body?: string; createdAt?: string; submittedAt?: string; commit?: { oid?: string } | null };
type Inline = {
  id?: number; in_reply_to_id?: number; user?: { login?: string; type?: string } | null; body?: string; created_at?: string;
  path?: string; diff_hunk?: string; original_commit_id?: string;
};

// the files of at most this many commits after a review are read, one call each
const COMMITS = 30, HUNK = 1_500;

export async function ghReady(gh: Gh = run): Promise<boolean> {
  try { await gh(['auth', 'status']); return true; } catch { return false; }
}

/** Every comment on a PR, each body redacted and clipped and each hunk kept to its end; rejects when gh fails. */
export async function prThread(url: string, o: { since?: number; gh?: Gh } = {}): Promise<PrThread> {
  const gh = o.gh ?? run;
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a PR: ${url}`);
  const [, host, owner, repo, n] = m;
  const pr = JSON.parse(await gh(['pr', 'view', url, '--json', 'author,comments,reviews,commits'])) as {
    author?: { login?: string }; comments?: Said[]; reviews?: Said[]; commits?: { oid?: string; committedDate?: string }[];
  };
  const pages = JSON.parse(await gh(['api', '--hostname', host, `repos/${owner}/${repo}/pulls/${n}/comments`, '--paginate', '--slurp'])) as Inline[][];
  const bot = (login: string, type?: string) => login.endsWith('[bot]') || type === 'Bot';
  const said = (kind: 'review' | 'conversation') => (c: Said): PrComment[] => {
    const body = c.body?.trim();
    const author = c.author?.login ?? 'ghost';
    const commit = c.commit?.oid;
    return body ? [{ id: c.id ?? '', kind, author, bot: bot(author), at: Date.parse(c.createdAt ?? c.submittedAt ?? ''), body: ellipsis(redact(body), CLIP.agent), ...(commit && { commit }) }] : [];
  };
  const inline = pages.flat().flatMap((c): PrComment[] => {
    const body = c.body?.trim();
    const author = c.user?.login ?? 'ghost';
    const hunk = c.diff_hunk && redact(c.diff_hunk);
    return body ? [{
      id: String(c.id ?? ''), kind: 'inline', author, bot: bot(author, c.user?.type), at: Date.parse(c.created_at ?? ''), body: ellipsis(redact(body), CLIP.agent),
      ...(c.path && { path: c.path }), ...(hunk && { hunk: hunk.length > HUNK ? `…${hunk.slice(-(HUNK - 1))}` : hunk }),
      ...(c.original_commit_id && { commit: c.original_commit_id }), ...(c.in_reply_to_id !== undefined && { replyTo: String(c.in_reply_to_id) }),
    }] : [];
  });
  const comments = [...(pr.comments ?? []).flatMap(said('conversation')), ...(pr.reviews ?? []).flatMap(said('review')), ...inline].sort((a, b) => a.at - b.at);
  const commits: PrThread['commits'] = (pr.commits ?? []).flatMap((c) => (c.oid ? [{ sha: c.oid, at: Date.parse(c.committedDate ?? '') }] : [])).sort((a, b) => a.at - b.at);
  const after = o.since === undefined ? [] : commits.filter((c) => c.at > o.since!);
  for (const c of after.slice(0, COMMITS)) {
    c.files = JSON.parse(await gh(['api', '--hostname', host, `repos/${owner}/${repo}/commits/${c.sha}`, '--jq', '[.files[].filename]'])) as string[];
  }
  return { url, author: pr.author?.login ?? 'ghost', comments, commits, truncated: after.length > COMMITS };
}

/** The PR of `branch` in the checkout at `repo`, open or not; undefined when it has none, a rejection when gh fails. */
export async function prForBranch(repo: string, branch: string, gh: Gh = run): Promise<string | undefined> {
  const prs = JSON.parse(await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--limit', '1'], repo)) as { url: string }[];
  return prs[0]?.url;
}

/** The PR a review run reviewed, or why none: one it links to while it runs, else the newest the session linked before it,
 *  else its branch's; a run that links two is ambiguous. */
export type Join = { pr: string } | { failed: 'ambiguous' | 'none' };

export function joinRun(o: Pick<Outline, 'prs'>, r: SkillRun, branchPr?: string): Join {
  const inside = new Set(o.prs.filter((p) => p.at >= r.at && p.at <= r.end).map((p) => p.url));
  if (inside.size > 1) return { failed: 'ambiguous' };
  if (inside.size === 1) return { pr: [...inside][0] };
  const before = o.prs.filter((p) => p.at < r.at).reduce<Outline['prs'][number] | undefined>((a, p) => (!a || p.at >= a.at ? p : a), undefined);
  if (before) return { pr: before.url };
  return branchPr ? { pr: branchPr } : { failed: 'none' };
}

/** The commit a review read: the PR's last at or before `at`. */
export const revisionAt = (t: Pick<PrThread, 'commits'>, at: number): string | undefined => t.commits.filter((c) => c.at <= at).at(-1)?.sha;
