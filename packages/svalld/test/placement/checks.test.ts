import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, emptyState, type AgentAdapter, type FleetState, type MachineId, type Robot } from '@svall/protocol';
import { AGENTS } from '../../src/agents.js';
import type { AgentProbe } from '../../src/sessions/registry.js';
import type { CliRun } from '../../src/sessions/types.js';
import { hooklessGit } from '../../src/links/git.js';
import { BUNDLE_MAX } from '../../src/placement/bundle.js';
import { moveChecks, probeRepo, type CheckDeps, type RepoProbe } from '../../src/placement/checks.js';
import { git, hasGit } from '../git-fixture.js';
import { makeHome } from '../helpers.js';
import { H, W, island, robot, stopWorlds, world } from './world.js';

afterEach(stopWorlds);

const VAULT = 'linus-vault';
const CLAUDE = '2.1.300';
const ID = '0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0';

const put = (root: string, rel: string, data: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

// a Mac home and a worker home side by side, whose repositories the fixture's git makes with an empty global configuration
function machines() {
  const base = fs.realpathSync(makeHome());
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  const [mac, far] = [path.join(base, 'Users/ada'), path.join(base, 'home/ada')];
  for (const d of [mac, far]) fs.mkdirSync(d, { recursive: true });
  const g = (cwd: string, ...args: string[]): string => git(base, cwd, ...args);
  const origin = (name: string): string => path.join(base, 'origins', `${name}.git`);
  // a repository under the Mac home with two committed files, and an origin that holds them unless `origin` is false
  const repo = (rel: string, o: { origin?: boolean } = {}): string => {
    const root = path.join(mac, rel);
    g(base, 'init', '-q', root);
    put(root, 'a.txt', 'one\n');
    put(root, 'b.txt', 'two\n');
    g(root, 'add', '.');
    g(root, 'commit', '-qm', 'base');
    if (o.origin !== false) {
      g(base, 'clone', '-q', '--bare', root, origin(path.basename(root)));
      g(root, 'remote', 'add', 'origin', origin(path.basename(root)));
      g(root, 'fetch', '-q', 'origin');
      g(root, 'remote', 'set-head', 'origin', 'main');
    }
    return root;
  };
  return { base, mac, far, g, origin, repo };
}
type Machines = ReturnType<typeof machines>;

type Opts = {
  reachable?: boolean; mismatch?: boolean; release?: string; mine?: string; local?: AgentProbe[]; far?: AgentAdapter[];
  probe?: (p: { path: string; remote?: string }) => Promise<RepoProbe>; terminals?: Awaited<ReturnType<CheckDeps['terminals']>>; cli?: CliRun;
};

// the home's view of the fleet and of linus-vault, which answers system.info as faked and repo.probe from its real folder
function depsOf(t: Machines, robots: Robot[], o: Opts = {}): CheckDeps & { asked: { method: string; params: unknown }[] } {
  const asked: { method: string; params: unknown }[] = [];
  const state: FleetState = {
    ...emptyState(),
    islands: { i_1: island, i_home: { ...island, id: 'i_home', kind: 'home' } },
    robots: Object.fromEntries(robots.map((r) => [r.id, r])),
    machines: { [W]: { name: VAULT, reachable: o.reachable !== false, since: 0, release: o.release ?? '0.17.0' } },
  };
  const hello = {
    t: 'hello' as const, workerMachineId: W, bootId: 'b', release: o.release ?? '0.17.0', home: t.far,
    agentHomes: { claude: `${t.far}/.claude`, codex: `${t.far}/.codex`, opencode: `${t.far}/.config/opencode` },
  };
  const far: AgentAdapter[] = o.far ?? [{ kind: 'claude', version: CLAUDE, adapter: 1, home: `${t.far}/.claude`, loggedIn: true, hooks: true }];
  return {
    asked,
    store: { state },
    me: H,
    git: hooklessGit,
    release: o.mine ?? '0.17.0',
    homedir: t.mac,
    agents: async () => o.local ?? [{ kind: 'claude', version: CLAUDE, home: `${t.mac}/.claude`, loggedIn: true, hooks: true }],
    terminals: async () => o.terminals ?? [],
    ...(o.cli && { cli: o.cli }),
    links: {
      for: (m) => {
        if (m !== W || o.reachable === false) return undefined;
        return o.mismatch ? { connected: () => false, hello: () => undefined, mismatch: () => hello } : { connected: () => true, hello: () => hello, mismatch: () => undefined };
      },
      call: async <T>(_m: MachineId, method: string, params: unknown): Promise<T> => {
        asked.push({ method, params });
        if (method === 'system.info') return { agentAdapters: far } as T;
        if (method === 'repo.probe') return (await (o.probe ?? ((p) => probeRepo(p, hooklessGit)))(params as { path: string })) as T;
        throw new Error(`${method} is not faked`);
      },
    },
  };
}

const claude = (status: 'idle' | 'working' | 'blocked' = 'idle', transcriptPath?: string): Robot['agent'] =>
  ({ kind: 'claude', sessionId: ID, status, lastActivityAt: 0, ...(transcriptPath && { transcriptPath }) });

// robot c_1, named kanban, standing at `root` of the repository whose main checkout is `main`
const on = (root: string, o: Partial<Robot> & { main?: string; branch?: string } = {}): Robot => {
  const { main = root, branch = 'main', ...rest } = o;
  return robot({ id: 'c_1', name: 'kanban', cwd: root, repo: { root, mainRoot: main, branch, isWorktree: root !== main }, ...rest });
};

// a shell robot in a folder of the Mac home that is no repository
const shellIn = (t: Machines, o: Partial<Robot> = {}): Robot => {
  fs.mkdirSync(path.join(t.mac, 'notes'), { recursive: true });
  return robot({ id: 'c_1', name: 'kanban', cwd: path.join(t.mac, 'notes'), ...o });
};

const refusal = async (d: CheckDeps, o: Parameters<typeof moveChecks>[3] = {}) => {
  const r = await moveChecks(d, 'c_1', W, o);
  if (r.ok) throw new Error(`moved with ${JSON.stringify(r.sheet)}`);
  return r.refusal;
};
const sheet = async (d: CheckDeps, o: Parameters<typeof moveChecks>[3] = {}) => {
  const r = await moveChecks(d, 'c_1', W, o);
  if (!r.ok) throw new Error(`refused: ${r.refusal.reason}; ${r.refusal.action}`);
  return r;
};

describe.skipIf(!hasGit)('moveChecks', () => {
  it('a robot on main gets a sheet with converts and no refusal', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    put(root, 'a.txt', 'one\nedited\n');
    put(root, 'b.txt', 'two\nstaged\n');
    t.g(root, 'add', 'b.txt');
    put(root, 'new.txt', 'new\n');
    const c = on(root, { cwd: `${root}/src` });

    const { sheet: s, plan } = await sheet(depsOf(t, [c]));
    const clone = `${t.far}/code/svall`;
    const wt = `${clone}/.claude/worktrees/kanban`;
    const head = t.g(root, 'rev-parse', 'HEAD');
    expect(s).toEqual({
      sessionBytes: 0, branch: 'kanban', commits: 0, changedFiles: 2, untrackedFiles: 1, clone: 'clone', credentialFiles: [], stays: [],
      interrupts: false, question: false, converts: { main: root, branch: 'kanban', changed: 3 }, notInRepo: false,
    });
    expect(plan).toEqual({
      clone, paths: { root: wt, cwd: `${wt}/src`, repo: { root: wt, mainRoot: clone, branch: 'kanban', isWorktree: true } },
      convert: { main: root, slug: 'kanban' }, remote: t.origin('svall'), have: [head], carry: [],
    });
  });

  it('a repo with no remote refuses "push svall-notes to a remote first"; one the worker cannot read refuses "linus-vault cannot read github.com/…; log gh in there" with a run', async () => {
    const t = machines();
    const root = t.repo('code/svall-notes', { origin: false });
    expect(await refusal(depsOf(t, [on(root)]))).toEqual({ reason: 'svall-notes has no remote', action: 'push svall-notes to a remote first', details: [] });

    t.g(root, 'remote', 'add', 'origin', 'git@github.com:linus/svall-notes.git');
    const d = depsOf(t, [on(root)], { probe: async () => ({ state: 'none', refs: [], reachable: false }) });
    expect(await refusal(d)).toEqual({
      reason: 'linus-vault cannot read github.com/linus/svall-notes', action: 'log gh in there', run: 'gh auth login', details: [],
    });
    expect(d.asked.find((a) => a.method === 'repo.probe')?.params).toEqual({ path: `${t.far}/code/svall-notes`, remote: 'git@github.com:linus/svall-notes.git', branch: 'kanban' });
  });

  it('an origin carrying a token reaches the worker and the plan without it; an ssh user and an scp-style remote stay', async () => {
    const t = machines();
    const root = t.repo('code/svall', { origin: false });
    t.g(root, 'remote', 'add', 'origin', 'https://example.invalid/linus/svall.git');
    const cases = [
      ['https://linus:ghp_secret@example.invalid/linus/svall.git', 'https://example.invalid/linus/svall.git'],
      ['https://ghp_secret@example.invalid/linus/svall.git', 'https://example.invalid/linus/svall.git'],
      ['ssh://git:pw@example.invalid/linus/svall.git', 'ssh://git@example.invalid/linus/svall.git'],
      ['git@example.invalid:linus/svall.git', 'git@example.invalid:linus/svall.git'],
    ];
    for (const [origin, sent] of cases) {
      t.g(root, 'remote', 'set-url', 'origin', origin);
      const d = depsOf(t, [on(root)], { probe: async () => ({ state: 'none', refs: [], reachable: true }) });
      const { plan } = await sheet(d);
      expect(d.asked.find((a) => a.method === 'repo.probe')?.params).toEqual({ path: `${t.far}/code/svall`, remote: sent, branch: 'kanban' });
      expect(plan.remote).toBe(sent);
    }
  });

  it('the first failing check is the reason and the others follow in more, each with its action and command; their details behind the first', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    t.g(root, 'checkout', '-q', '--detach');
    const c = on(root, { branch: 'HEAD', islandId: 'i_home', agent: claude('working'), tmux: { windowId: '@1', paneId: '%1' } });
    const d = depsOf(t, [c], { reachable: false, terminals: [{ robotId: 'c_1', class: 'agent-working' }, { robotId: 'c_1', class: 'foreground' }] });
    expect(await refusal(d)).toEqual({
      reason: 'mission control stays on this Mac',
      action: 'move a robot from another island',
      details: ['wait for it'],
      more: [
        { reason: 'linus-vault is not reachable', action: 'try again when it is awake' },
        { reason: 'kanban is on a detached HEAD', action: 'check out a branch first' },
        { reason: 'kanban is working', action: 'interrupt it now' },
        { reason: 'a command is running', action: 'move anyway and it ends' },
      ],
    });
  });

  it('a worker on an older release is asked about its agents too, so the upgrade and the agent update show at once; one that cannot answer adds nothing', async () => {
    const t = machines();
    const c = shellIn(t, { agent: claude('idle') });
    const older = depsOf(t, [c], { release: '0.16.0', far: [{ kind: 'claude', version: '0.1.0', adapter: 1, home: `${t.far}/.claude`, loggedIn: true }] });
    expect(await refusal(older)).toEqual({
      reason: 'linus-vault runs 0.16.0, this Mac 0.17.0', action: 'upgrade it under Machines', details: [],
      more: [{ reason: `linus-vault runs claude 0.1.0, this Mac ${CLAUDE}`, action: 'update claude on linus-vault', run: 'claude update' }],
    });
    expect(older.asked.map((a) => a.method)).toEqual(['system.info']);
    const mute = depsOf(t, [c], { release: '0.16.0' });
    mute.links.call = () => Promise.reject(new Error('unknown method system.info'));
    expect(await refusal(mute)).toEqual({ reason: 'linus-vault runs 0.16.0, this Mac 0.17.0', action: 'upgrade it under Machines', details: [] });
  });

  it('a worker that gives no answer in time is named, with what to do, and not the call it left unanswered', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    for (const method of ['system.info', 'repo.probe']) {
      const d = depsOf(t, [on(root)]);
      const call = d.links.call;
      d.links.call = (m, asked, params) => (asked === method ? Promise.reject(new ApiError('timeout', `${method} got no reply in 30000 ms`)) : call(m, asked, params));
      expect(await refusal(d)).toEqual({ reason: 'linus-vault did not answer', action: 'try again; if it keeps happening, Check it under Machines', details: [] });
    }
    // any other failure is shown as it is
    const d = depsOf(t, [on(root)]);
    d.links.call = () => Promise.reject(new ApiError('not_reachable', 'the link closed: reset'));
    expect(await refusal(d)).toEqual({ reason: 'the link closed: reset', action: 'try again when it is awake', details: [] });
  });

  it('a blocked agent is not refused: question is true and interrupts follows the choice', async () => {
    const t = machines();
    const terminals = [{ robotId: 'c_1', class: 'agent-blocked' as const }];
    const d = depsOf(t, [shellIn(t, { agent: claude('blocked') })], { terminals });

    const idle = await sheet(d);
    expect(idle.sheet).toMatchObject({ question: true, interrupts: false });
    // a blocked agent is interrupted at once, so it resumes idle and asks again
    expect(idle.plan.interruptAfterMs).toBe(0);

    const chosen = await sheet(d, { interruptAfterMs: 5000 });
    expect(chosen.sheet).toMatchObject({ question: true, interrupts: true });
    expect(chosen.plan.interruptAfterMs).toBe(5000);
  });

  it('refuses mission control, and not a robot on an island', async () => {
    const t = machines();
    expect(await refusal(depsOf(t, [shellIn(t, { islandId: 'i_home' })])))
      .toEqual({ reason: 'mission control stays on this Mac', action: 'move a robot from another island', details: [] });
    await sheet(depsOf(t, [shellIn(t)]));
  });

  it('passes an OpenCode robot, whose session counts its log and the export its OpenCode writes of it, as the move would', async () => {
    const t = machines();
    const sid = 'ses_0123456789abAbCdEfGhIjKlMn';
    const log = path.join(t.mac, '.svall/transcripts/opencode', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, '{"kind":"agent"}\n');
    const agent = { kind: 'opencode' as const, sessionId: sid, transcriptPath: log, status: 'idle' as const, lastActivityAt: 0 };
    const local: AgentProbe[] = [{ kind: 'opencode', version: '2.1.4', home: path.dirname(log), loggedIn: true, hooks: true }];
    const far: AgentAdapter[] = [{ kind: 'opencode', version: '2.1.4', adapter: 1, home: `${t.far}/.svall/transcripts/opencode`, loggedIn: true, hooks: true }];
    const exported: string[][] = [];
    const cli: CliRun = async (_cmd, args, o = {}) => {
      exported.push(args);
      fs.writeFileSync(o.stdout!, JSON.stringify({ info: { id: sid }, messages: [{ id: 'msg_1' }] }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const size = 17 + JSON.stringify({ info: { id: sid }, messages: [{ id: 'msg_1' }] }).length;
    expect((await sheet(depsOf(t, [shellIn(t, { agent })], { local, far, cli }))).sheet).toMatchObject({ sessionBytes: size });
    expect(exported).toEqual([['session', 'export', '--standalone', sid]]);
    expect(fs.readdirSync(path.dirname(log))).toEqual([`${sid}.jsonl`]);
  });

  it('refuses a robot already moving, naming where to', async () => {
    const t = machines();
    const moving = { id: 'mv_0123456789', to: W, phase: 'bundle' as const };
    expect(await refusal(depsOf(t, [shellIn(t, { moving })])))
      .toEqual({ reason: 'moving to linus-vault', action: 'wait for the move to finish', details: [] });
  });

  it('check 1: refuses a worker out of reach, one older to upgrade and one newer to catch this Mac up with, and passes one on this release', async () => {
    const t = machines();
    const down = depsOf(t, [shellIn(t)], { reachable: false });
    expect(await refusal(down)).toEqual({ reason: 'linus-vault is not reachable', action: 'try again when it is awake', details: [] });
    // nothing is asked of a worker that cannot be reached
    expect(down.asked).toEqual([]);
    expect(await refusal(depsOf(t, [shellIn(t)], { release: '0.16.0' })))
      .toEqual({ reason: 'linus-vault runs 0.16.0, this Mac 0.17.0', action: 'upgrade it under Machines', details: [] });
    expect(await refusal(depsOf(t, [shellIn(t)], { release: '0.18.0' })))
      .toEqual({ reason: 'linus-vault runs 0.18.0, this Mac 0.17.0', action: 'update svall on this Mac', details: [] });
    await sheet(depsOf(t, [shellIn(t)]));
  });

  it('check 1 compares the release svall version names on each machine: two builds of one release pass, as do two dev builds, and a dev Mac refuses a release', async () => {
    const t = machines();
    await sheet(depsOf(t, [shellIn(t)], { mine: 'v0.17.1', release: 'v0.17.1' }));
    await sheet(depsOf(t, [shellIn(t)], { mine: 'dev', release: 'dev' }));
    expect(await refusal(depsOf(t, [shellIn(t)], { mine: 'dev', release: 'v0.17.1' })))
      .toEqual({ reason: 'linus-vault runs v0.17.1, this Mac dev', action: 'upgrade it under Machines', details: [] });
  });

  it('check 2: refuses an agent missing, older or logged out there, and passes one the same or newer', async () => {
    const t = machines();
    const c = shellIn(t, { agent: claude() });
    const there = (o: Partial<AgentAdapter>): AgentAdapter[] => [{ kind: 'claude', version: CLAUDE, adapter: 1, home: `${t.far}/.claude`, loggedIn: true, hooks: true, ...o }];
    expect(await refusal(depsOf(t, [c], { far: [] })))
      .toEqual({ reason: 'claude is not installed on linus-vault', action: 'install claude on linus-vault', run: AGENTS.claude.installCommand, details: [] });
    expect(await refusal(depsOf(t, [c], { far: there({ version: '2.1.299' }) })))
      .toEqual({ reason: 'linus-vault runs claude 2.1.299, this Mac 2.1.300', action: 'update claude on linus-vault', run: 'claude update', details: [] });
    expect(await refusal(depsOf(t, [c], { far: there({ loggedIn: false }) })))
      .toEqual({ reason: 'claude is not logged in on linus-vault', action: 'log claude in there', run: 'claude auth login', details: [] });
    await sheet(depsOf(t, [c], { far: there({ version: '2.2.0' }) }));
    // a shell robot needs no agent there
    await sheet(depsOf(t, [shellIn(t)], { far: [] }));
  });

  it('check 3: refuses two robots in one main checkout, a main checkout mid-merge and a detached HEAD; a worktree robot does not convert', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const other = on(root, { id: 'c_2', name: 'board' });
    expect(await refusal(depsOf(t, [on(root), other])))
      .toEqual({ reason: "two robots share svall's main checkout", action: 'give it its own worktree', details: [] });

    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), `${t.g(root, 'rev-parse', 'HEAD')}\n`);
    expect(await refusal(depsOf(t, [on(root)]))).toEqual({ reason: `${root} is in the middle of a merge`, action: 'finish or abort it first', details: [] });
    fs.rmSync(path.join(root, '.git/MERGE_HEAD'));

    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '--detach', wt);
    expect(await refusal(depsOf(t, [on(wt, { main: root, branch: 'HEAD' })])))
      .toEqual({ reason: 'kanban is on a detached HEAD', action: 'check out a branch first', details: [] });

    t.g(wt, 'checkout', '-q', '-b', 'kb');
    const { sheet: s, plan } = await sheet(depsOf(t, [on(wt, { main: root, branch: 'kb' })]));
    expect(s.converts).toBeUndefined();
    expect(s.branch).toBe('kb');
    expect(plan.convert).toBeUndefined();
    expect(plan.paths.root).toBe(`${t.far}/code/svall/.claude/worktrees/kb`);
  });

  it('check 3: refuses a worktree robot mid-merge, mid-rebase, mid-cherry-pick or with an assume-unchanged file, whose bundle would carry none of it', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    t.g(root, 'checkout', '-q', '-b', 'side');
    put(root, 'a.txt', 'side\n');
    t.g(root, 'commit', '-qam', 'side');
    put(root, 'c.txt', 'three\n');
    t.g(root, 'add', 'c.txt');
    t.g(root, 'commit', '-qm', 'side two');
    t.g(root, 'checkout', '-q', 'main');
    const c = on(wt, { main: root, branch: 'kb' });

    // main's merge stays in main
    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), `${t.g(root, 'rev-parse', 'HEAD')}\n`);
    await sheet(depsOf(t, [c]));
    fs.rmSync(path.join(root, '.git/MERGE_HEAD'));

    t.g(wt, 'merge', '-q', '--no-commit', '--no-ff', 'side');
    expect(await refusal(depsOf(t, [c]))).toEqual({ reason: `${wt} is in the middle of a merge`, action: 'finish or abort it first', details: [] });
    // its own worktree keeps only a main checkout's operation
    expect(await refusal(depsOf(t, [c]), { ownWorktree: true })).toMatchObject({ reason: `${wt} is in the middle of a merge` });
    t.g(wt, 'merge', '--abort');

    put(wt, 'a.txt', 'kb\n');
    t.g(wt, 'commit', '-qam', 'kb');
    expect(() => t.g(wt, 'rebase', '-q', 'side')).toThrow();
    // the rebase's detached HEAD is refused too, behind the rebase
    expect(await refusal(depsOf(t, [on(wt, { main: root, branch: 'HEAD' })]))).toEqual({
      reason: `${wt} is in the middle of a rebase`, action: 'finish or abort it first', details: [], more: [{ reason: 'kanban is on a detached HEAD', action: 'check out a branch first' }],
    });
    t.g(wt, 'rebase', '--abort');

    // a pick of two whose first conflict was resolved and committed holds only the sequencer, with the second to come
    expect(() => t.g(wt, 'cherry-pick', 'side~1', 'side')).toThrow();
    put(wt, 'a.txt', 'kb\nside\n');
    t.g(wt, 'commit', '-qam', 'resolved');
    expect(await refusal(depsOf(t, [c]))).toEqual({ reason: `${wt} is in the middle of a cherry-pick or revert`, action: 'finish or abort it first', details: [] });
    t.g(wt, 'cherry-pick', '--quit');

    t.g(wt, 'update-index', '--assume-unchanged', 'b.txt');
    put(wt, 'b.txt', 'hidden\n');
    expect(await refusal(depsOf(t, [c]))).toEqual({
      reason: `b.txt in ${wt} is marked assume-unchanged, so its edits would be lost`, action: 'run git update-index --no-assume-unchanged on it first', details: [],
    });
    t.g(wt, 'update-index', '--no-assume-unchanged', 'b.txt');

    // core.ignoreStat marks each file git adds, so the refusal clears them all at once
    t.g(wt, 'config', 'core.ignoreStat', 'true');
    put(wt, 'd.txt', 'four\n');
    t.g(wt, 'add', 'd.txt');
    expect(await refusal(depsOf(t, [c]))).toEqual({
      reason: `${wt} sets core.ignoreStat, which marks each file git adds assume-unchanged, so their edits would be lost`,
      action: 'run git config core.ignoreStat false && git ls-files -z | xargs -0 git update-index --no-assume-unchanged there first', details: [],
    });
    t.g(wt, 'config', 'core.ignoreStat', 'false');
    t.g(wt, 'update-index', '--no-assume-unchanged', 'd.txt');
    expect((await sheet(depsOf(t, [c]))).sheet.changedFiles).toBe(2);
  });

  it('check 3: a robot sharing a main checkout given its own worktree travels on a new branch at HEAD with HEAD\'s commits alone, and main keeps the rest', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    // a tracked .env on origin, a commit origin lacks, and changes of every kind that neither robot can claim
    put(root, '.env', 'KEY=1\n');
    t.g(root, 'add', '-f', '.env');
    t.g(root, 'commit', '-qm', 'env');
    t.g(root, 'push', '-q', 'origin', 'main');
    put(root, 'src/c.txt', 'three\n');
    t.g(root, 'add', 'src/c.txt');
    t.g(root, 'commit', '-qm', 'three');
    put(root, 'a.txt', 'one\nedited\n');
    put(root, 'b.txt', 'two\nstaged\n');
    t.g(root, 'add', 'b.txt');
    put(root, 'new.txt', 'new\n');
    put(root, '.env', 'KEY=2\n');
    put(root, '.env.local', 'KEY=3\n');
    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), `${t.g(root, 'rev-parse', 'HEAD')}\n`);
    const robots = [on(root, { cwd: `${root}/src` }), on(root, { id: 'c_2', name: 'board' })];

    const { sheet: s, plan } = await sheet(depsOf(t, robots), { ownWorktree: true });
    const wt = `${t.far}/code/svall/.claude/worktrees/kanban`;
    expect(s).toEqual({
      sessionBytes: 0, branch: 'kanban', commits: 1, changedFiles: 0, untrackedFiles: 0, clone: 'clone', credentialFiles: [], stays: [".env.local stays in svall's main checkout"],
      interrupts: false, question: false, converts: { main: root, branch: 'kanban', changed: 5, keep: true }, notInRepo: false,
    });
    expect(plan.convert).toEqual({ main: root, slug: 'kanban', head: t.g(root, 'rev-parse', 'HEAD') });
    expect(plan.paths).toEqual({ root: wt, cwd: `${wt}/src`, repo: { root: wt, mainRoot: `${t.far}/code/svall`, branch: 'kanban', isWorktree: true } });
    expect(plan.carry).toEqual([]);
  });

  it('check 3: a robot alone on main given its own worktree leaves main its changes too, and is refused a credential an unpushed commit carries', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    put(root, 'a.txt', 'one\nedited\n');
    const { sheet: s, plan } = await sheet(depsOf(t, [on(root)]), { ownWorktree: true });
    expect(s).toMatchObject({ changedFiles: 0, converts: { main: root, branch: 'kanban', changed: 1, keep: true } });
    expect(plan.convert).toEqual({ main: root, slug: 'kanban', head: t.g(root, 'rev-parse', 'HEAD') });

    put(root, '.env', 'KEY=1\n');
    t.g(root, 'add', '-f', '.env');
    t.g(root, 'commit', '-qm', 'env');
    expect(await refusal(depsOf(t, [on(root)]), { ownWorktree: true }))
      .toEqual({ reason: '.env is in commits that would travel with the branch', action: 'rewrite them without .env first', details: [] });
  });

  it('check 6: its own worktree changes nothing for a robot in a worktree: its changes travel, and a changed tracked .env refuses', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    // on origin, so only the change to it would travel
    put(wt, '.env', 'KEY=1\n');
    t.g(wt, 'add', '-f', '.env');
    t.g(wt, 'commit', '-qm', 'env');
    t.g(wt, 'push', '-q', 'origin', 'kb');
    put(wt, '.env', 'KEY=2\n');
    put(wt, 'a.txt', 'one\nedited\n');
    const c = on(wt, { main: root, branch: 'kb' });
    expect(await refusal(depsOf(t, [c]), { ownWorktree: true }))
      .toEqual({ reason: '.env is tracked and would travel with the branch', action: 'untrack or revert .env first', details: [] });

    t.g(wt, 'checkout', '-q', '--', '.env');
    const { sheet: s, plan } = await sheet(depsOf(t, [c]), { ownWorktree: true });
    expect(s).toMatchObject({ branch: 'kb', changedFiles: 1 });
    expect(s.converts).toBeUndefined();
    expect(plan.convert).toBeUndefined();
  });

  it('check 3: its own worktree is refused while another robot moves out of that main checkout, and for a folder its last commit lacks', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const leaving = on(root, { id: 'c_2', name: 'board', moving: { id: 'mv_0123456789', to: W, phase: 'rest' } });
    expect(await refusal(depsOf(t, [on(root), leaving]), { ownWorktree: true }))
      .toEqual({ reason: "board is moving out of svall's main checkout", action: 'wait for the move to finish', details: [] });

    put(root, 'new/todo.md', 'todo\n');
    const other = on(root, { id: 'c_2', name: 'board' });
    expect(await refusal(depsOf(t, [on(root, { second: { cwd: `${root}/new`, unread: false } }), other]), { ownWorktree: true }))
      .toEqual({ reason: "new is not in svall's last commit", action: 'commit it first', details: [] });
  });

  it('check 4: a clone of the same repository is warm and builds on its refs; a folder or another repository there is in the way', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const base = t.g(root, 'rev-parse', 'HEAD');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    put(wt, 'c.txt', 'three\n');
    t.g(wt, 'add', 'c.txt');
    t.g(wt, 'commit', '-qm', 'more');
    const c = on(wt, { main: root, branch: 'kb' });
    const clone = `${t.far}/code/svall`;
    const inTheWay = { reason: `${clone} on linus-vault is not a clone of svall`, action: 'move it out of the way there first', details: [] };

    put(clone, 'notes.txt', 'mine\n');
    expect(await refusal(depsOf(t, [c]))).toEqual(inTheWay);
    fs.rmSync(clone, { recursive: true });

    t.g(t.base, 'init', '-q', clone);
    put(clone, 'x.txt', 'another\n');
    t.g(clone, 'add', '.');
    t.g(clone, 'commit', '-qm', 'another');
    expect(await refusal(depsOf(t, [c]))).toEqual(inTheWay);
    fs.rmSync(clone, { recursive: true });

    t.g(t.base, 'clone', '-q', t.origin('svall'), clone);
    const { sheet: s, plan } = await sheet(depsOf(t, [c]));
    expect(s).toMatchObject({ clone: 'warm', commits: 1, branch: 'kb' });
    expect(plan).toMatchObject({ clone, have: [base] });
    expect(plan.remote).toBeUndefined();
  });

  it('check 4: refuses a shallow clone with the command that fetches its history, a first move too, and names no clone there in the way', async () => {
    const t = machines();
    const full = t.repo('code/svall');
    put(full, 'c.txt', 'three\n');
    t.g(full, 'add', 'c.txt');
    t.g(full, 'commit', '-qm', 'more');
    t.g(full, 'push', '-q', 'origin', 'main');
    fs.rmSync(full, { recursive: true });
    t.g(t.base, 'clone', '-q', '--depth', '1', `file://${t.origin('svall')}`, full);
    t.g(full, 'remote', 'set-url', 'origin', t.origin('svall'));
    const wt = `${full}/.claude/worktrees/kb`;
    t.g(full, 'worktree', 'add', '-q', '-b', 'kb', wt);
    const c = on(wt, { main: full, branch: 'kb' });
    const shallow = { reason: 'svall is a shallow clone', action: `git -C '${full}' fetch --unshallow`, details: [] };

    expect(await refusal(depsOf(t, [c]))).toEqual(shallow);
    t.g(t.base, 'clone', '-q', t.origin('svall'), `${t.far}/code/svall`);
    expect(await refusal(depsOf(t, [c]))).toEqual(shallow);
    t.g(full, 'fetch', '-q', '--unshallow');
    expect((await sheet(depsOf(t, [c]))).sheet).toMatchObject({ clone: 'warm' });
  });

  it('check 4: a first clone builds on the remote\'s branches, which the clone will hold, though the Mac knows no origin/HEAD', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    t.g(root, 'remote', 'set-head', 'origin', '--delete');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    put(wt, 'c.txt', 'three\n');
    t.g(wt, 'add', 'c.txt');
    t.g(wt, 'commit', '-qm', 'more');
    const { sheet: s, plan } = await sheet(depsOf(t, [on(wt, { main: root, branch: 'kb' })]));
    expect(s).toMatchObject({ clone: 'clone', commits: 1 });
    expect(plan.have).toEqual([t.g(root, 'rev-parse', 'main')]);
  });

  it('check 4: a first clone carries only the branch\'s own commits though origin\'s main moved on since the fork, and an orphan branch whole', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    t.g(root, 'remote', 'set-head', 'origin', '--delete');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    put(wt, 'c.txt', 'three\n');
    t.g(wt, 'add', 'c.txt');
    t.g(wt, 'commit', '-qm', 'more');
    put(root, 'd.txt', 'four\n');
    t.g(root, 'add', 'd.txt');
    t.g(root, 'commit', '-qm', 'later on main');
    t.g(root, 'push', '-q', 'origin', 'main');
    expect((await sheet(depsOf(t, [on(wt, { main: root, branch: 'kb' })]))).sheet).toMatchObject({ clone: 'clone', commits: 1 });

    const solo = `${root}/.claude/worktrees/solo`;
    t.g(root, 'worktree', 'add', '-q', '--detach', solo);
    t.g(solo, 'checkout', '-q', '--orphan', 'solo');
    t.g(solo, 'rm', '-rqf', '.');
    put(solo, 'e.txt', 'five\n');
    t.g(solo, 'add', 'e.txt');
    t.g(solo, 'commit', '-qm', 'apart');
    expect((await sheet(depsOf(t, [on(solo, { main: root, branch: 'solo' })]))).sheet).toMatchObject({ clone: 'clone', commits: 1 });
  });

  it('check 5: refuses a branch another robot is on, on any machine, the one a main checkout converts to included, and passes a branch of its own', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    const c = on(wt, { main: root, branch: 'kb' });
    const clone = `${t.far}/code/svall`;
    const there = (branch: string): Robot => robot({
      id: 'c_2', name: 'board', machine: W, placement: { generation: 1 }, cwd: `${clone}/.claude/worktrees/b`,
      repo: { root: `${clone}/.claude/worktrees/b`, mainRoot: clone, branch, isWorktree: true },
    });
    const taken = { reason: 'board is on kb too', action: 'put one of them on another branch first', details: [] };
    expect(await refusal(depsOf(t, [c, there('kb')]))).toEqual(taken);
    expect(await refusal(depsOf(t, [c, on(wt, { id: 'c_2', name: 'board', main: root, branch: 'kb' })]))).toEqual(taken);
    await sheet(depsOf(t, [c, there('board')]));

    // a main checkout travels on the branch it converts to
    expect(await refusal(depsOf(t, [on(root), there('kanban')])))
      .toEqual({ reason: 'board is on kanban too', action: 'put one of them on another branch first', details: [] });
  });

  it('check 6: refuses a tracked credential file that would travel, a path tar cannot hold and a bundle past BUNDLE_MAX; an untracked one stays unless ticked; node_modules is named', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    const c = on(wt, { main: root, branch: 'kb' });

    put(wt, '.env', 'KEY=1\n');
    put(wt, '.gitignore', 'node_modules/\n');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    const { sheet: s, plan } = await sheet(depsOf(t, [c]));
    expect(s).toMatchObject({ credentialFiles: ['.env'], stays: ['.env stays here', 'node_modules is not carried'], untrackedFiles: 1 });
    expect(plan.carry).toEqual([]);
    const ticked = await sheet(depsOf(t, [c]), { carry: ['.env'] });
    expect(ticked.sheet).toMatchObject({ credentialFiles: ['.env'], stays: ['node_modules is not carried'], untrackedFiles: 2 });
    expect(ticked.plan.carry).toEqual(['.env']);

    t.g(wt, 'add', '-f', '.env');
    t.g(wt, 'commit', '-qm', 'env');
    put(wt, '.env', 'KEY=2\n');
    expect(await refusal(depsOf(t, [c]))).toEqual({
      reason: '.env is in commits that would travel with the branch', action: 'rewrite them without .env first', details: [],
      more: [{ reason: '.env is tracked and would travel with the branch', action: 'untrack or revert .env first' }],
    });
    t.g(wt, 'reset', '-q', '--soft', 'HEAD~1');
    t.g(wt, 'rm', '-q', '--cached', '-f', '.env');
    expect((await sheet(depsOf(t, [c]))).sheet).toMatchObject({ credentialFiles: ['.env'], stays: ['.env stays here', 'node_modules is not carried'] });
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('KEY=2\n');

    const long = `notes/${'x'.repeat(101)}`;
    put(wt, long, 'x\n');
    expect(await refusal(depsOf(t, [c]))).toEqual({ reason: `${long} has a path too long for a move to carry`, action: 'rename or ignore it first', details: [] });
    fs.rmSync(path.join(wt, long));

    // sparse, so the test writes almost nothing to disk
    const big = fs.openSync(path.join(wt, 'big.bin'), 'w');
    fs.ftruncateSync(big, BUNDLE_MAX + 1024 * 1024);
    fs.closeSync(big);
    const r = await refusal(depsOf(t, [c]));
    expect(r.reason).toContain('101.0 MB, over the 100 MB a move carries');
    expect(r.action).toBe('push its commits or ignore its large files first');
  });

  it('check 6: a carried commit that untracks a .env, or edits a tracked .env template, moves', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    put(root, '.env', 'KEY=1\n');
    put(root, '.env.example', 'KEY=\n');
    t.g(root, 'add', '-f', '.env', '.env.example');
    t.g(root, 'commit', '-qm', 'env');
    t.g(root, 'push', '-q', 'origin', 'main');
    const wt = `${root}/.claude/worktrees/kb`;
    t.g(root, 'worktree', 'add', '-q', '-b', 'kb', wt);
    const c = on(wt, { main: root, branch: 'kb' });

    t.g(wt, 'rm', '-q', '--cached', '.env');
    put(wt, '.env.example', 'KEY=\nOTHER=\n');
    t.g(wt, 'commit', '-qam', 'untrack .env');
    put(wt, '.env.example', 'KEY=\nOTHER=\nMORE=\n');
    const { sheet: s } = await sheet(depsOf(t, [c]));
    expect(s).toMatchObject({ commits: 1, changedFiles: 1, credentialFiles: ['.env'], stays: ['.env stays here'] });
  });

  it('check 1: a worker linked on a build whose state or link this Mac cannot read names its release, or a different build of the same one', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    expect(await refusal(depsOf(t, [on(root)], { mismatch: true, release: '0.16.0' }))).toMatchObject({ reason: 'linus-vault runs 0.16.0, this Mac 0.17.0', action: 'upgrade it under Machines' });
    expect(await refusal(depsOf(t, [on(root)], { mismatch: true }))).toMatchObject({ reason: 'linus-vault runs a different build', action: 'upgrade it under Machines' });
  });

  it('check 7: refuses a working agent or a running command unless interrupt is chosen, and an idle robot moves as it is', async () => {
    const t = machines();
    const c = shellIn(t, { agent: claude('working') });
    const working = depsOf(t, [c], { terminals: [{ robotId: 'c_1', class: 'agent-working' }, { robotId: 'c_9', class: 'foreground' }] });
    expect(await refusal(working)).toEqual({ reason: 'kanban is working', action: 'interrupt it now', details: [] });
    const moved = await sheet(working, { interruptAfterMs: 60_000 });
    expect(moved.sheet).toMatchObject({ interrupts: true, question: false });
    expect(moved.plan.interruptAfterMs).toBe(60_000);

    const running = depsOf(t, [shellIn(t)], { terminals: [{ robotId: 'c_1', term: 2, class: 'foreground' }] });
    expect(await refusal(running)).toEqual({ reason: 'a command is running', action: 'move anyway and it ends', details: ['wait for it'] });
    expect((await sheet(running, { interruptAfterMs: 0 })).sheet.interrupts).toBe(true);
    // a later failure follows in more, its details behind the first's sentence
    const both = depsOf(t, [c], { terminals: [{ robotId: 'c_1', class: 'agent-working' }, { robotId: 'c_1', term: 2, class: 'foreground' }] });
    expect(await refusal(both)).toEqual({
      reason: 'kanban is working', action: 'interrupt it now', details: ['wait for it'], more: [{ reason: 'a command is running', action: 'move anyway and it ends' }],
    });

    const idle = await sheet(depsOf(t, [c], { terminals: [{ robotId: 'c_1', class: 'agent-ready' }] }), { interruptAfterMs: 0 });
    expect(idle.sheet).toMatchObject({ interrupts: false, question: false });
  });

  it('a robot in no repository moves with its session only: no probe, and its folders relocated by home', async () => {
    const t = machines();
    const d = depsOf(t, [shellIn(t)]);
    const { sheet: s, plan } = await sheet(d);
    expect(s).toEqual({
      sessionBytes: 0, branch: '', commits: 0, changedFiles: 0, untrackedFiles: 0, clone: 'warm', credentialFiles: [], stays: [],
      interrupts: false, question: false, notInRepo: true,
    });
    expect(plan).toEqual({ clone: '', paths: { root: `${t.far}/notes`, cwd: `${t.far}/notes` }, have: [], carry: [] });
    expect(d.asked.map((a) => a.method)).toEqual(['system.info']);
  });

  it('sessionBytes counts the session files that travel, which land under the worker\'s agent home; a session with no transcript is refused', async () => {
    const t = machines();
    const transcript = `${t.mac}/.claude/projects/-p/${ID}.jsonl`;
    put(path.dirname(transcript), `${ID}.jsonl`, 'x'.repeat(1234));
    put(path.dirname(transcript), `${ID}/subagents/a.jsonl`, 'y'.repeat(100));
    const { sheet: s, plan } = await sheet(depsOf(t, [shellIn(t, { agent: claude('idle', transcript) })]));
    expect(s.sessionBytes).toBe(1334);
    expect(plan.paths.transcriptPath).toBe(`${t.far}/.claude/projects/-p/${ID}.jsonl`);

    const gone = `${t.mac}/.claude/projects/-p/${ID.replace('0b', '1b')}.jsonl`;
    const r = await refusal(depsOf(t, [shellIn(t, { agent: { ...claude('idle', gone)!, sessionId: ID.replace('0b', '1b') } })]));
    expect(r.action).toBe('start it fresh first');
  });
});

describe.skipIf(!hasGit)('repo.probe', () => {
  it('answers none, other, or clone with its origin, root commit and refs; with nothing there, whether the remote can be read', async () => {
    const t = machines();
    const root = t.repo('code/svall');
    const clone = `${t.far}/code/svall`;
    const head = t.g(root, 'rev-parse', 'HEAD');
    expect(await probeRepo({ path: clone, remote: t.origin('svall') }, hooklessGit)).toEqual({ state: 'none', refs: [head], reachable: true });
    expect(await probeRepo({ path: clone, remote: `${t.base}/origins/gone.git` }, hooklessGit)).toEqual({ state: 'none', refs: [], reachable: false });
    expect(await probeRepo({ path: clone }, hooklessGit)).toEqual({ state: 'none', refs: [] });

    put(clone, 'notes.txt', 'mine\n');
    expect(await probeRepo({ path: clone }, hooklessGit)).toEqual({ state: 'other', refs: [] });
    expect(await probeRepo({ path: `${clone}/notes.txt` }, hooklessGit)).toEqual({ state: 'other', refs: [] });
    fs.rmSync(clone, { recursive: true });

    t.g(t.base, 'clone', '-q', t.origin('svall'), clone);
    expect(await probeRepo({ path: clone }, hooklessGit)).toEqual({ state: 'clone', remote: t.origin('svall'), rootCommit: head, refs: [head] });
    // a folder inside a clone is not one
    fs.mkdirSync(`${clone}/src`);
    expect((await probeRepo({ path: `${clone}/src` }, hooklessGit)).state).toBe('other');
  });

  it('the worker answers repo.probe over the link, and refuses params it cannot read', async () => {
    const w = world({});
    await w.link();
    expect(await w.home.links.call(W, 'repo.probe', { path: '/nonexistent/svall' })).toEqual({ state: 'none', refs: [] });
    await expect(w.home.links.call(W, 'repo.probe', { path: 'svall' })).rejects.toSatisfy((e) => e instanceof ApiError && e.code === 'invalid_params');
  });
});
