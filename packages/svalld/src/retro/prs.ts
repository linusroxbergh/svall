import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLIP, clip } from './outline.js';
import { redact } from './redact.js';

const execP = promisify(execFile);

/** A comment on a PR: a conversation comment, a review's body, or an inline comment on `path`. */
export type PrComment = { author: string; at: number; body: string; path?: string };

type Gh = (args: string[], cwd?: string) => Promise<string>;

const run: Gh = async (args, cwd) =>
  (await execP('gh', args, { cwd, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })).stdout;

type Said = { author?: { login?: string } | null; body?: string; createdAt?: string; submittedAt?: string };
type Inline = { user?: { login?: string } | null; body?: string; created_at?: string; path?: string };

export async function ghReady(gh: Gh = run): Promise<boolean> {
  try { await gh(['auth', 'status']); return true; } catch { return false; }
}

/** What others than its author said on a PR, oldest first, each body redacted and clipped to 1,500; rejects when gh fails. */
export async function prThread(url: string, gh: Gh = run): Promise<PrComment[]> {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a PR: ${url}`);
  const [, host, owner, repo, n] = m;
  const pr = JSON.parse(await gh(['pr', 'view', url, '--json', 'author,comments,reviews'])) as { author?: { login?: string }; comments?: Said[]; reviews?: Said[] };
  const pages = JSON.parse(await gh(['api', '--hostname', host, `repos/${owner}/${repo}/pulls/${n}/comments`, '--paginate', '--slurp'])) as Inline[][];
  const all: { author?: string; at?: string; body?: string; path?: string }[] = [
    ...[...(pr.comments ?? []), ...(pr.reviews ?? [])].map((c) => ({ author: c.author?.login, at: c.createdAt ?? c.submittedAt, body: c.body })),
    ...pages.flat().map((c) => ({ author: c.user?.login, at: c.created_at, body: c.body, path: c.path })),
  ];
  return all.flatMap((c): PrComment[] => {
    const body = c.body?.trim();
    if (!body || c.author === pr.author?.login) return [];
    return [{ author: c.author ?? 'ghost', at: Date.parse(c.at ?? ''), body: clip(redact(body), CLIP.text), ...(c.path && { path: c.path }) }];
  }).sort((a, b) => a.at - b.at);
}

/** The PR of `branch` in the checkout at `repo`, open or not; undefined when it has none, a rejection when gh fails. */
export async function prForBranch(repo: string, branch: string, gh: Gh = run): Promise<string | undefined> {
  const prs = JSON.parse(await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--limit', '1'], repo)) as { url: string }[];
  return prs[0]?.url;
}
