import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContextItem, PrState } from '@svall/protocol';

const execP = promisify(execFile);
// how long a reading stands, give or take SPREAD: each entry gets its own deadline, so the
// characters that filled the cache together do not all go back to the network together
const TTL = 300_000;
const SPREAD = 0.4;
// a lookup that failed is asked again this much later, not at every refresh
const RETRY = 60_000;
const cache = new Map<string, { until: number; link?: ContextItem; failed?: unknown }>();
// characters that share a checkout and branch miss together, and wait on the one lookup
const inflight = new Map<string, Promise<ContextItem | undefined>>();

type GhPr = { url: string; number: number; state: string; isDraft: boolean; reviewDecision: string };
type Deps = { exec: (cwd: string) => Promise<string>; now: () => number; rand?: () => number };

const defaultDeps: Deps = {
  exec: async (cwd) => (await execP('gh', ['pr', 'view', '--json', 'url,number,state,isDraft,reviewDecision'], { cwd, timeout: 10_000, killSignal: 'SIGKILL' })).stdout,
  now: Date.now,
};

const life = (rand: () => number): number => TTL * (1 - SPREAD / 2 + SPREAD * rand());

// gh's own word that there is no PR to find: for the branch, in a repository with no remote or none on GitHub
const NONE = /no pull requests found|no git remotes|none of the git remotes/;

export function prState(d: Pick<GhPr, 'state' | 'isDraft' | 'reviewDecision'>): PrState {
  if (d.state === 'MERGED') return 'merged';
  if (d.state === 'CLOSED') return 'closed';
  if (d.isDraft) return 'draft';
  if (d.reviewDecision === 'APPROVED') return 'approved';
  if (d.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  return 'open';
}

/** The branch's PR, undefined when there is none or no gh, and a rejection when the lookup failed (offline, logged out, timed out). */
export async function lookupPr(cwd: string, branch: string, deps: Deps = defaultDeps): Promise<ContextItem | undefined> {
  const key = `${cwd}#${branch}`;
  const hit = cache.get(key);
  const now = deps.now();
  if (hit && now < hit.until) {
    if (hit.failed) throw hit.failed;
    return hit.link;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const lookup = readPr(key, cwd, now, deps).finally(() => inflight.delete(key));
  inflight.set(key, lookup);
  return lookup;
}

async function readPr(key: string, cwd: string, now: number, deps: Deps): Promise<ContextItem | undefined> {
  // a character that is gone leaves its reading behind, so every miss sweeps the readings that have run out
  for (const [k, v] of cache) if (now >= v.until) cache.delete(k);
  let link: ContextItem | undefined;
  try {
    const d = JSON.parse(await deps.exec(cwd)) as GhPr;
    link = { kind: 'pr', ref: d.url, label: `#${d.number}`, source: 'auto', prState: prState(d) };
  } catch (e) {
    const { code, stderr } = e as { code?: unknown; stderr?: unknown };
    if (code !== 'ENOENT' && !NONE.test(String(stderr))) {
      cache.set(key, { until: now + RETRY, failed: e });
      throw e;
    }
    link = undefined;
  }
  cache.set(key, { until: now + life(deps.rand ?? Math.random), link });
  return link;
}
