import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentKind, Repo, type AgentAdapter, type MachineId, type MoveSheet, type Refusal, type Robot, type SystemInfo } from '@svall/protocol';
import { AGENTS, compareVersions } from '../agents.js';
import type { Config } from '../config.js';
import { NotFound } from '../errors.js';
import { must } from '../handover/git-graph.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate } from '../handover/relocate.js';
import type { Classified } from '../handover/rest.js';
import type { AgentProbe, AgentProber } from '../handover/sessions/registry.js';
import type { HomeLinks, WorkerLink } from '../link/home.js';
import { remoteGit, webUrl, type GitRunner } from '../links/git.js';
import type { Store } from '../store.js';
import { BundleTooLarge, buildBundle, trackedCredentials, type BundleManifest } from './bundle.js';
import { refuseUncarried, WORKTREES, worktreeSlug } from './convert.js';
import { destinationPaths, sessionLanding, type Homes } from './paths.js';

/** What a move does, as its checks found it: where the robot lands on the worker and what its bundle builds on. */
export const MovePlan = z.object({
  // the clone's path on the worker; empty for a robot in no repository
  clone: z.string(),
  paths: z.object({
    root: z.string(), cwd: z.string(), second: z.string().optional(), transcriptPath: z.string().optional(),
    secondTranscriptPath: z.string().optional(), panePath: z.string().optional(), repo: Repo.optional(),
  }),
  // the main checkout that becomes the robot's worktree `slug` before the bundle is built
  convert: z.object({ main: z.string(), slug: z.string() }).optional(),
  // what the worker clones from when it holds no clone
  remote: z.string().optional(),
  // the shas the worker's clone's refs name, which the bundle's commits build on
  have: z.array(z.string()),
  // the credential files ticked to travel
  carry: z.array(z.string()),
  interruptAfterMs: z.number().int().nonnegative().optional(),
});
export type MovePlan = z.infer<typeof MovePlan>;

// MovePlan.parse keeps every field destinationPaths answers, as each type has it
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Landing = ReturnType<typeof destinationPaths>;
true satisfies Same<MovePlan['paths'], Landing> & Same<keyof MovePlan['paths'], keyof Landing>;

export type CheckResult = { ok: true; sheet: MoveSheet; plan: MovePlan } | { ok: false; refusal: Refusal };

/** What the worker holds at a path, and with nothing there whether it can read the remote. */
export type RepoProbe = { state: 'clone' | 'other' | 'none'; remote?: string; rootCommit?: string; refs: string[]; reachable?: boolean };
export const RepoProbeParams = z.object({ path: z.string().startsWith('/'), remote: z.string().regex(/^[^-]/).optional() });

export type CheckDeps = {
  store: Pick<Store, 'state'>;
  me: MachineId;
  links: { for(machine: MachineId): Pick<WorkerLink, 'connected' | 'hello'> | undefined; call: HomeLinks['call'] };
  git: GitRunner;
  agents: AgentProber;
  config: Pick<Config, 'gatewayMachineId'>;
  release: string;
  homedir: string;
  /** This Mac's terminals that still hold a process, as rest reads them. */
  terminals: () => Promise<Pick<Classified, 'robotId' | 'term' | 'class'>[]>;
};

type Failure = Omit<Refusal, 'details'> & { details?: string[] };

const originOf = async (dir: string, git: GitRunner): Promise<string | undefined> => {
  const r = await git(['remote', 'get-url', 'origin'], dir);
  return (r.code === 0 && r.stdout.trim()) || undefined;
};

// a remote without the token an http URL may carry as its user or password, so the worker reads it with its own
// credentials; an ssh URL keeps its user, and an scp-style one is no URL
function withoutToken(remote: string): string {
  let u: URL;
  try { u = new URL(remote); } catch { return remote; }
  const http = /^https?:$/.test(u.protocol);
  if (!u.password && !(http && u.username)) return remote;
  u.password = '';
  if (http) u.username = '';
  return u.href;
}

// the oldest root commit HEAD reaches, which every clone of a repository shares
const rootOf = async (dir: string, git: GitRunner): Promise<string | undefined> => {
  const r = await git(['rev-list', '--max-parents=0', 'HEAD'], dir);
  return (r.code === 0 && r.stdout.trim().split('\n').at(-1)) || undefined;
};

// a remote as any of its spellings, scp or url, with or without .git, names it
const remoteKey = (r?: string): string | undefined => r && (webUrl(r) ?? r);

/** What the worker holds at `path`: a clone with its origin, root commit and ref shas, something else, or nothing. */
export async function probeRepo(p: z.infer<typeof RepoProbeParams>, git: GitRunner): Promise<RepoProbe> {
  const st = fs.lstatSync(p.path, { throwIfNoEntry: false });
  if (!st) return { state: 'none', refs: [], ...(p.remote && { reachable: (await remoteGit(['ls-remote', p.remote, 'HEAD'], os.homedir())).code === 0 }) };
  if (!st.isDirectory()) return { state: 'other', refs: [] };
  const top = await git(['rev-parse', '--show-toplevel'], p.path);
  if (top.code !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(p.path)) return { state: 'other', refs: [] };
  const [remote, rootCommit, refs] = await Promise.all([originOf(p.path, git), rootOf(p.path, git), git(['for-each-ref', '--format=%(objectname)'], p.path)]);
  return { state: 'clone', ...(remote && { remote }), ...(rootCommit && { rootCommit }), refs: [...new Set(refs.stdout.split('\n').filter(Boolean))] };
}

// each agent's home as both machines' CLIs name it, else the user's
export function homesOf(from: string, to: string, local: { kind: AgentKind; home?: string }[], far: { kind: AgentKind; home?: string }[]): Homes {
  const user = { from, to };
  const agent = Object.fromEntries(AgentKind.options.map((k) => {
    const [here, there] = [local.find((p) => p.kind === k)?.home, far.find((a) => a.kind === k)?.home];
    return [k, here && there ? { from: here, to: there } : user];
  })) as Homes['agent'];
  return { user, agent };
}

function agentFailures(c: Robot, local: AgentProbe[], far: AgentAdapter[], name: string): Failure[] {
  const kinds = new Set([c.agent?.kind, c.second?.agent?.kind].filter((k) => k !== undefined));
  return [...kinds].flatMap((kind): Failure[] => {
    const { bin, installCommand, updateCommand, loginHint } = AGENTS[kind];
    const [here, there] = [local.find((p) => p.kind === kind), far.find((a) => a.kind === kind)];
    if (!there?.version) return [{ reason: `${bin} is not installed on ${name}`, action: `install ${bin} on ${name}`, run: installCommand }];
    if (here?.version && compareVersions(there.version, here.version) === -1) {
      return [{ reason: `${name} runs ${bin} ${there.version}, this Mac ${here.version}`, action: `update ${bin} on ${name}`, run: updateCommand }];
    }
    // an OpenCode logged in on neither machine runs on a model that needs no login
    if (!there.loggedIn && !(kind === 'opencode' && here?.loggedIn === false)) return [{ reason: `${bin} is not logged in on ${name}`, action: `log ${bin} in there`, run: loginHint }];
    return [];
  });
}

async function sessionBytes(c: Robot): Promise<number> {
  const { sourceHome, files } = await sessionLanding(c);
  const sizes = await Promise.all(files.map(async (f) => (await fs.promises.lstat(path.join(sourceHome, f))).size));
  return sizes.reduce((n, s) => n + s, 0);
}

async function changedFiles(root: string, git: GitRunner): Promise<number> {
  const names = await Promise.all([['diff', '--cached'], ['diff']].map(async (a) => (await must(git, [...a, '--name-only', '-z', '--no-renames'], root)).split('\0')));
  return new Set(names.flat().filter(Boolean)).size;
}

// the robot as converting its main checkout leaves it: in the worktree `slug` on that branch, its folders in main moved there
export function converted(c: Robot, repo: Repo, slug: string): Robot {
  const main = clean(repo.mainRoot);
  const root = path.posix.join(main, WORKTREES, slug);
  const into = (p: string): string => (holds(main, clean(p)) ? path.posix.join(root, path.posix.relative(main, clean(p))) : p);
  return {
    ...c, cwd: into(c.cwd), ...(c.panePath && { panePath: into(c.panePath) }), ...(c.second && { second: { ...c.second, cwd: into(c.second.cwd) } }),
    repo: { ...repo, root, branch: slug, isWorktree: true },
  };
}

// "<reason>; <action>", as convert's refusals read
const split = (message: string): Failure => {
  const at = message.indexOf('; ');
  return at < 0 ? { reason: message, action: 'fix it on this Mac first' } : { reason: message.slice(0, at), action: message.slice(at + 2) };
};

/**
 * Whether robot `robotId` can move from this Mac to `to`, with the sentence and action of the first check that fails
 * and the rest behind details; when all pass, the sheet of what travels and the plan the move follows.
 */
export async function moveChecks(d: CheckDeps, robotId: string, to: MachineId, o: { carry?: string[]; interruptAfterMs?: number } = {}): Promise<CheckResult> {
  const s = d.store.state;
  if (!Object.hasOwn(s.robots, robotId)) throw new NotFound(`no robot ${robotId}`);
  const c = s.robots[robotId];
  const named = (m: MachineId): string => s.machines?.[m]?.name ?? m;
  const name = named(to);
  const failed: Failure[] = [];
  const fail = (f: Failure): void => { failed.push(f); };
  // a worker that does not answer is as one out of reach
  const ask = async <T>(method: string, params: unknown): Promise<T | undefined> => {
    try {
      return await d.links.call<T>(to, method, params);
    } catch (e) {
      fail({ reason: (e as Error).message, action: 'try again when it is awake' });
      return undefined;
    }
  };

  if (d.config.gatewayMachineId) fail({ reason: 'this fleet has a gateway', action: 'remove the gateway in Settings › Machines first' });
  if (s.islands[c.islandId]?.kind === 'home') fail({ reason: 'mission control stays on this Mac', action: 'move a robot from another island' });
  if (c.moving) fail({ reason: `moving to ${named(c.moving.to)}`, action: 'wait for the move to finish' });
  if ([c.agent?.kind, c.second?.agent?.kind].includes('opencode')) fail({ reason: 'OpenCode robots cannot move yet', action: 'wait for a later release' });

  // 1: reachable, on this release
  const link = d.links.for(to);
  const hello = link?.connected() ? link.hello() : undefined;
  if (!hello) fail({ reason: `${name} is not reachable`, action: 'try again when it is awake' });
  else if (hello.release !== d.release) {
    const action = compareVersions(hello.release, d.release) === 1 ? 'update svall on this Mac' : 'upgrade it under Machines';
    fail({ reason: `${name} runs ${hello.release}, this Mac ${d.release}`, action });
  }
  const linked = hello?.release === d.release ? hello : undefined;

  // 2: the robot's agents installed and logged in there, none older
  const local = await d.agents();
  const info = linked && await ask<SystemInfo>('system.info', {});
  if (info) for (const f of agentFailures(c, local, info.agentAdapters, name)) fail(f);
  const homes = linked && info ? homesOf(d.homedir, linked.home, local, info.agentAdapters) : undefined;
  let session = 0;
  try {
    session = await sessionBytes(c);
  } catch (e) {
    fail({ reason: (e as Error).message, action: 'start it fresh first' });
  }

  const { repo } = c;
  let clone = '';
  let mode: MoveSheet['clone'] = 'warm';
  let remote: string | undefined;
  let have: string[] = [];
  let convert: MovePlan['convert'];
  let bundle: { manifest: BundleManifest; changed: number } | undefined;
  if (repo) {
    const repoName = path.posix.basename(clean(repo.mainRoot));
    const detached = repo.branch === 'HEAD';
    const onMain = !repo.isWorktree;

    // 3: a worktree on a branch, or a main checkout of this robot's alone that converts
    if (onMain) {
      const sharing = Object.values(s.robots).some((r) => r.id !== c.id && (r.machine ?? d.me) === d.me && r.repo && !r.repo.isWorktree && clean(r.repo.root) === clean(repo.root));
      if (sharing) fail({ reason: `two robots share ${repoName}'s main checkout`, action: 'give one its own worktree first' });
    }
    if (detached) fail({ reason: `${c.name} is on a detached HEAD`, action: 'check out a branch first' });
    if (onMain) {
      try {
        await refuseUncarried(repo.mainRoot, d.git);
      } catch (e) {
        fail(split((e as Error).message));
      }
      convert = { main: repo.mainRoot, slug: await worktreeSlug(c.name, repo.branch, { main: repo.mainRoot, git: d.git }) };
    }

    // 4: a clone of this repository at the main checkout's place there, or nothing there and a remote it reads
    if (homes) {
      clone = relocate(repo.mainRoot, homes.user);
      const origin = await originOf(repo.mainRoot, d.git);
      remote = origin && withoutToken(origin);
      const probe = await ask<RepoProbe>('repo.probe', { path: clone, ...(remote && { remote }) });
      const inTheWay: Failure = { reason: `${clone} on ${name} is not a clone of ${repoName}`, action: 'move it out of the way there first' };
      if (probe?.state === 'clone') {
        if (remoteKey(probe.remote) === remoteKey(remote) && probe.rootCommit === await rootOf(repo.mainRoot, d.git)) have = probe.refs;
        else fail(inTheWay);
      } else if (probe?.state === 'other') fail(inTheWay);
      else if (probe && !remote) fail({ reason: `${repoName} has no remote`, action: `push ${repoName} to a remote first` });
      else if (probe && remote && !probe.reachable) {
        fail({ reason: `${name} cannot read ${webUrl(remote)?.replace(/^https:\/\//, '') ?? remote}`, action: 'log gh in there', run: 'gh auth login' });
      } else if (probe) mode = 'clone';
    }

    // 5: no other robot, on any machine, on the branch that travels, which for a main checkout is the one it converts to
    const branch = convert?.slug ?? (detached ? undefined : repo.branch);
    if (branch) {
      const places = new Set([clean(repo.mainRoot), ...(clone ? [clean(clone)] : [])]);
      const other = Object.values(s.robots).find((r) => r.id !== c.id && r.repo?.branch === branch && places.has(clean(r.repo.mainRoot)));
      if (other) fail({ reason: `${other.name} is on ${branch} too`, action: 'put one of them on another branch first' });
    }

    // 6: the bundle fits, and carries no tracked credential file; built here to know both, and built again by the move
    if (!detached) {
      const into = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-check-'));
      try {
        const manifest = await buildBundle(repo.root, { git: d.git, into, have, carry: o.carry ?? [] });
        const tracked = await trackedCredentials(repo.root, d.git, manifest);
        if (tracked.length) {
          const list = tracked.join(', ');
          fail({ reason: `${list} ${tracked.length > 1 ? 'are' : 'is'} tracked and would travel with the branch`, action: `commit or revert ${list} first` });
        }
        bundle = { manifest, changed: await changedFiles(repo.root, d.git) };
      } catch (e) {
        if (e instanceof BundleTooLarge) fail({ reason: e.message, action: 'push its commits or ignore its large files first' });
        else fail(split((e as Error).message.trim().split('\n').at(-1) ?? ''));
      } finally {
        fs.rmSync(into, { recursive: true, force: true });
      }
    }
  }

  // 7: the agent idle, or an interrupt chosen; a robot waiting on a question moves and asks again
  const mine = (await d.terminals()).filter((t) => t.robotId === c.id);
  const chosen = o.interruptAfterMs !== undefined;
  const question = mine.some((t) => t.class === 'agent-blocked');
  if (!chosen && mine.some((t) => t.class === 'agent-working')) fail({ reason: `${c.name} is working`, action: 'interrupt after this turn' });
  if (!chosen && mine.some((t) => t.class === 'foreground')) fail({ reason: 'a command is running', action: 'move anyway and it ends', details: ['wait for it'] });

  // a worker out of reach has failed a check, so no homes means a refusal
  if (failed.length || !homes) {
    const [first, ...rest] = failed;
    return {
      ok: false,
      refusal: { reason: first.reason, action: first.action, ...(first.run && { run: first.run }), details: [...first.details ?? [], ...rest.flatMap((f) => [`${f.reason}; ${f.action}`, ...f.details ?? []])] },
    };
  }
  const credentialFiles = bundle?.manifest.credentialFiles ?? [];
  const carry = credentialFiles.filter((f) => o.carry?.includes(f));
  const stays = [
    ...credentialFiles.filter((f) => !carry.includes(f)).map((f) => `${f} stays here`),
    ...(repo && fs.existsSync(path.join(repo.root, 'node_modules')) ? ['node_modules is not carried'] : []),
  ];
  const [changed, untracked] = [bundle?.changed ?? 0, bundle?.manifest.untracked.length ?? 0];
  const sheet: MoveSheet = {
    sessionBytes: session, branch: convert?.slug ?? repo?.branch ?? '', commits: bundle?.manifest.commits?.count ?? 0, changedFiles: changed, untrackedFiles: untracked,
    clone: mode, credentialFiles, stays, interrupts: chosen && mine.some((t) => t.class !== 'agent-ready' && t.class !== 'shell-ready'), question,
    ...(convert && { converts: { main: convert.main, branch: convert.slug, changed: changed + untracked } }), notInRepo: !repo,
  };
  // a question is cut at once: the agent resumes idle and asks again
  const interruptAfterMs = o.interruptAfterMs ?? (question ? 0 : undefined);
  const plan: MovePlan = {
    clone, paths: destinationPaths(repo && convert ? converted(c, repo, convert.slug) : c, clone, homes),
    ...(convert && { convert }), ...(mode === 'clone' && remote && { remote }), have, carry, ...(interruptAfterMs !== undefined && { interruptAfterMs }),
  };
  return { ok: true, sheet, plan };
}
