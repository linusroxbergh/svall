import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetState, INTERRUPT_ACTIONS, moveSummary } from '@svall/protocol';
import { RESUME_NOTE } from '../../src/dormancy.js';
import { armFailpoints, type Edge, type Failpoint } from '../../src/failpoints.js';
import { hooklessGit, type GitRunner } from '../../src/links/git.js';
import { fingerprintOf } from '../../src/placement/bundle.js';
import { hasGit } from '../git-fixture.js';
import { cleanHomes, waitForPolls } from '../helpers.js';
import { Crash, OSID, SID, listed, moveWorld, state, until, type MoveWorld } from './move-world.js';
import { H, W } from './world.js';

const worlds: MoveWorld[] = [];
let disarm: (() => void) | undefined;
afterEach(async () => {
  disarm?.();
  disarm = undefined;
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});
const open = (o: Parameters<typeof moveWorld>[0] = {}): MoveWorld => { const w = moveWorld(o); worlds.push(w); return w; };

// Claude's question to trust its folder, as the robot's pane on the worker shows it
const TRUST_DIALOG = [' Quick safety check: Is this a project you created or one you trust?', '', ' ❯ 1. No, exit', '   2. Yes, I trust this folder'];

const SID3 = '2d3e4f50-6172-4384-95a6-c7d8e9f0a1b2';

/**
 * A robot w1's fleet started in a new worktree `slug` of its clone, with a Claude session, which worked on there: a commit,
 * staged, unstaged and untracked changes. Its paths as the worker's home spells them, which this test's HOME, under macOS's
 * /tmp, spells otherwise than git.
 */
async function bornThere(w: MoveWorld, slug: string): Promise<{ id: string; far: string; mac: string; transcript: string }> {
  if (!fs.existsSync(w.clone)) w.g(w.base, 'clone', '-q', w.origin, w.clone);
  const far = path.join(w.clone, '.claude/worktrees', slug);
  w.g(w.clone, 'worktree', 'add', '-q', '-b', slug, far);
  fs.writeFileSync(path.join(far, `${slug}.txt`), `${slug}\n`);
  w.g(far, 'add', '.');
  w.g(far, 'commit', '-qm', `${slug} work`);
  fs.appendFileSync(path.join(far, 'a.txt'), 'staged\n');
  w.g(far, 'add', 'a.txt');
  fs.appendFileSync(path.join(far, 'b.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(far, 'notes.md'), 'untracked\n');
  const transcript = `projects/-${slug}/${SID3}.jsonl`;
  fs.mkdirSync(path.dirname(path.join(w.farClaude, transcript)), { recursive: true });
  fs.writeFileSync(path.join(w.farClaude, transcript), `${JSON.stringify({ type: 'user', cwd: far, sessionId: SID3 })}\n`);
  const { id } = await w.worker.fleet.createRobot({ islandId: 'i_1', cwd: far });
  await until(() => { expect(w.home.store.state.robots[id]?.repo).toBeDefined(); });
  for (const s of [w.worker.store, w.home.store]) {
    s.update((d) => {
      Object.assign(d.robots[id], {
        cwd: far, panePath: far, repo: { root: far, mainRoot: w.clone, branch: slug, isWorktree: true },
        agent: { kind: 'claude', sessionId: SID3, transcriptPath: path.join(w.farClaude, transcript), status: 'idle', lastActivityAt: 0 },
      });
    });
  }
  return { id, far, mac: path.join(w.main, '.claude/worktrees', slug), transcript };
}

// lib: an origin, this Mac's clone and w1's, and a worktree tidy there that robot c_1 goes on in
function libThere(w: MoveWorld): { mac: string; farWt: string } {
  const origin = path.join(w.base, 'origins/lib.git');
  const [mac, far] = [path.join(w.mac, 'code/lib'), path.join(w.far, 'code/lib')];
  w.g(w.base, 'init', '-q', '--bare', origin);
  w.g(w.base, 'clone', '-q', origin, mac);
  w.g(mac, 'commit', '-q', '--allow-empty', '-m', 'lib');
  w.g(mac, 'push', '-q', 'origin', 'HEAD');
  w.g(w.base, 'clone', '-q', origin, far);
  const farWt = path.join(far, '.claude/worktrees/tidy');
  w.g(far, 'worktree', 'add', '-q', '-b', 'tidy', farWt);
  for (const s of [w.worker.store, w.home.store]) s.update((d) => { Object.assign(d.robots.c_1, { cwd: farWt, repo: { root: farWt, mainRoot: far, branch: 'tidy', isWorktree: true } }); });
  return { mac, farWt };
}

// fires `then` at a step's edge, once
const at = (name: Failpoint, edge: Edge, then: () => void): void => {
  let done = false;
  disarm = armFailpoints((n, e) => { if (!done && n === name && e === edge) { done = true; then(); } });
};

describe.skipIf(!hasGit)('the move transaction', () => {
  it('moves a dirty worktree robot: the worker holds the branch, the split state, the session; the source is locked and left as it was', async () => {
    const w = open();
    const home = await w.start();
    const before = state(w, w.wt);
    const fingerprint = await fingerprintOf(w.wt, hooklessGit);
    // a terminal, a second one, a revive, a prompt and a close, asked for while the robot is on its way
    const refused: unknown[] = [];
    let closed: Promise<unknown> | undefined;
    at('worker.prepare.worktree', 'before', () => {
      const asks = [() => home.fleet.live('c_1'), () => home.fleet.openSecond('c_1'), () => home.fleet.reviveRobot('c_1'), () => home.fleet.run('c_1', 'go on', true)];
      for (const ask of asks) {
        try { ask(); } catch (e) { refused.push(e); }
      }
      closed = home.fleet.closeRobot('c_1').catch((e: unknown) => e);
      // a board column is this Mac's, and a card dropped on the way stays there
      home.fleet.placeRobot('c_1', 'review');
    });

    const id = await home.placement.start('c_1', W);

    expect(refused).toHaveLength(4);
    for (const e of [...refused, await closed]) expect(e).toMatchObject({ code: 'moving', message: 'moving to w1' });
    expect(home.store.state.robots.c_1).toBeDefined();
    // the worker: the branch with its commit, staged against unstaged, the untracked file, no .env, the session
    expect(state(w, w.farWt)).toEqual(before);
    expect(fs.existsSync(path.join(w.farWt, '.env'))).toBe(false);
    expect(await fingerprintOf(w.farWt, hooklessGit)).toBe(fingerprint);
    const farTranscript = path.join(w.farClaude, 'projects/-Users-ada-code-app', `${SID}.jsonl`);
    expect(fs.readFileSync(farTranscript, 'utf8')).toBe(fs.readFileSync(path.join(w.macClaude, 'projects/-Users-ada-code-app', `${SID}.jsonl`), 'utf8'));
    const there = w.worker.store.state.robots.c_1;
    expect(there).toMatchObject({ machine: W, placement: { generation: 1 }, cwd: w.farWt, repo: { root: w.farWt, mainRoot: w.clone, branch: 'kanban', isWorktree: true } });
    expect(there.agent?.transcriptPath).toBe(farTranscript);
    expect(there.tmux).toBeDefined();
    expect(w.vault.opened).toEqual(['c_1']);
    // trust for the clone's main checkout, in the worker's Claude config
    expect(JSON.parse(fs.readFileSync(path.join(w.far, '.claude.json'), 'utf8')).projects[fs.realpathSync(w.clone)]).toEqual({ hasTrustDialogAccepted: true });
    // the Mac: as it was, locked, and the robot placed there with what it left
    expect(state(w, w.wt)).toEqual(before);
    expect(await fingerprintOf(w.wt, hooklessGit)).toBe(fingerprint);
    expect(fs.readFileSync(path.join(w.wt, '.env'), 'utf8')).toBe('TOKEN=secret\n');
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    const here = home.store.state.robots.c_1;
    expect(here.machine).toBe(W);
    expect(here.moving).toBeUndefined();
    expect(here.left).toEqual({ moveId: id, machine: H, path: w.wt, branch: 'kanban', branchSha: before.head, fingerprint });
    expect(here).toMatchObject({ column: 'review', columnSource: 'manual' });
    expect(w.mac1.opened).toEqual([]);
    expect(home.placement.status(id).phase).toBe('done');
  });

  it('a robot sharing a main checkout, given its own worktree, moves on a new branch at HEAD, and main keeps its changes and the robot that stays', async () => {
    const w = open();
    const home = await w.start();
    // which marks each file of the worktree the move makes assume-unchanged too
    w.g(w.main, 'config', 'core.ignoreStat', 'true');
    fs.writeFileSync(path.join(w.main, 'a.txt'), 'one\nstaged\n');
    w.g(w.main, 'add', 'a.txt');
    fs.writeFileSync(path.join(w.main, 'notes.md'), 'untracked\n');
    home.store.update((d) => {
      Object.assign(d.robots.c_1, { name: 'ada', cwd: w.main, repo: { root: w.main, mainRoot: w.main, branch: 'main', isWorktree: false } });
      const { tmux: _t, agent: _a, ...board } = structuredClone(d.robots.c_1);
      d.robots.c_2 = { ...board, id: 'c_2', name: 'board', cell: { x: 1, y: 0 } };
    });
    // the worktrees under main are untracked there
    const inMain = () => { const s = state(w, w.main); return { ...s, untracked: s.untracked.filter((f) => !f.startsWith('.claude/')) }; };
    const before = inMain();

    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'refused', message: "two robots share app's main checkout; give it its own worktree" });
    const id = await home.placement.start('c_1', W, { ownWorktree: true });

    const [wt, farWt] = [path.join(w.main, '.claude/worktrees/ada'), path.join(w.clone, '.claude/worktrees/ada')];
    const fresh = { head: before.head, branch: 'ada', staged: '', unstaged: '', untracked: [] };
    expect(inMain()).toEqual(before);
    expect(state(w, wt)).toEqual(fresh);
    expect(listed(w, w.main, wt)).toEqual({ locked: `moved to w1 ${id}` });
    expect(state(w, farWt)).toEqual(fresh);
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, cwd: farWt, repo: { root: farWt, mainRoot: w.clone, branch: 'ada', isWorktree: true } });
    expect(home.store.state.robots.c_2).toMatchObject({ cwd: w.main, repo: { root: w.main, branch: 'main', isWorktree: false } });
    expect(home.store.state.robots.c_2.machine).toBeUndefined();
  });

  it('a robot given its own worktree whose move fails reopens in that worktree, and main keeps its changes', async () => {
    const w = open();
    const home = await w.start();
    fs.writeFileSync(path.join(w.main, 'notes.md'), 'untracked\n');
    home.store.update((d) => {
      Object.assign(d.robots.c_1, { name: 'ada', cwd: w.main, repo: { root: w.main, mainRoot: w.main, branch: 'main', isWorktree: false } });
      const { tmux: _t, agent: _a, ...board } = structuredClone(d.robots.c_1);
      d.robots.c_2 = { ...board, id: 'c_2', name: 'board', cell: { x: 1, y: 0 } };
    });
    const before = state(w, w.main);
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', W, { ownWorktree: true })).rejects.toThrow('the disk is full');

    const wt = path.join(w.main, '.claude/worktrees/ada');
    expect(home.store.state.robots.c_1).toMatchObject({ cwd: wt, repo: { root: wt, mainRoot: w.main, branch: 'ada', isWorktree: true } });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.mac1.opened).toEqual(['c_1']);
    expect(state(w, wt)).toEqual({ head: before.head, branch: 'ada', staged: '', unstaged: '', untracked: [] });
    expect({ ...state(w, w.main), untracked: state(w, w.main).untracked.filter((f) => f !== '.claude/worktrees/ada/') }).toEqual(before);
  });

  it('a failure in prepare reopens the robot at home with its window and the worker has nothing left', async () => {
    const w = open();
    const home = await w.start();
    const fingerprint = await fingerprintOf(w.wt, hooklessGit);
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });

    // with the step it failed at, which the move sheet names
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ message: 'the disk is full', data: { phase: 'prepare', moveId: expect.stringMatching(/^mv_/) } });

    const here = home.store.state.robots.c_1;
    expect(here.machine).toBeUndefined();
    expect(here.moving).toBeUndefined();
    expect(here.tmux).toBeDefined();
    expect(w.mac1.opened).toEqual(['c_1']);
    expect(w.mac1.lines.at(-1)?.text).toMatch(new RegExp(`^claude --resume ${SID}`));
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(await fingerprintOf(w.wt, hooklessGit)).toBe(fingerprint);
    const [j] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    expect(home.placement.status(j.slice(0, -'.json'.length))).toMatchObject({ phase: 'aborted', error: 'the disk is full' });
    // the worker: no worktree, no branch, no session, no robot of its own
    expect(fs.existsSync(w.farWt)).toBe(false);
    expect(listed(w, w.clone, w.farWt)).toBeUndefined();
    expect(w.g(w.clone, 'branch', '--list', 'kanban')).toBe('');
    expect(fs.existsSync(path.join(w.farClaude, 'projects/-Users-ada-code-app', `${SID}.jsonl`))).toBe(false);
    await until(() => { expect(w.worker.store.state.robots.c_1?.machine).toBeUndefined(); });
    expect(w.vault.opened).toEqual([]);
  });

  it('a crash after commit and before activate resumes from the journal: activate runs on the worker, the source is never reopened', async () => {
    const w = open();
    const first = await w.start();
    at('move.journal.activate', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });

    await expect(first.placement.start('c_1', W)).rejects.toThrow(Crash);
    first.links.stop();
    expect(w.vault.opened).toEqual([]);
    const [file] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    const id = file.slice(0, -'.json'.length);

    expect(FleetState.parse(JSON.parse(fs.readFileSync(w.homePaths.state, 'utf8'))).robots.c_1).toMatchObject({ machine: W, placement: { generation: 1 }, moving: { id, phase: 'commit' } });
    const again = await w.bootHome();
    await again.placement.recoverMoves();

    expect(again.placement.status(id).phase).toBe('done');
    expect(w.vault.opened).toEqual(['c_1']);
    expect(w.mac1.opened).toEqual([]);
    expect(again.store.state.robots.c_1.moving).toBeUndefined();
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });

  it('recovers a move whose journal holds the rest 0.19.0 writes, with role, transactionId, generation and phase', async () => {
    const w = open();
    const first = await w.start();
    at('move.journal.activate', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });
    await expect(first.placement.start('c_1', W)).rejects.toThrow(Crash);
    first.links.stop();
    const [file] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    const journal = JSON.parse(fs.readFileSync(path.join(w.homePaths.moves, file), 'utf8'));
    fs.writeFileSync(path.join(w.homePaths.moves, file), JSON.stringify({
      ...journal, rest: { role: 'source', transactionId: journal.id, generation: 0, phase: 'freeze', stoppedTerminals: [], terminated: [], serverKills: [] },
    }));

    const again = await w.bootHome();
    await again.placement.recoverMoves();

    expect(['done', 'aborted']).toContain(again.placement.status(journal.id).phase);
  });

  it('returns a robot whose Mac worktree is unchanged: reset to the recorded base, bundle applied, badge gone', async () => {
    const w = open();
    const home = await w.start();
    const out = await home.placement.start('c_1', W);
    // the robot works on there: a commit, a further edit, a new file, a longer conversation
    w.g(w.farWt, 'commit', '-qm', 'staged work');
    fs.appendFileSync(path.join(w.farWt, 'b.txt'), 'more\n');
    fs.writeFileSync(path.join(w.farWt, 'later.md'), 'later\n');
    const farTranscript = path.join(w.farClaude, 'projects/-Users-ada-code-app', `${SID}.jsonl`);
    fs.appendFileSync(farTranscript, `${JSON.stringify({ type: 'assistant', sessionId: SID })}\n`);
    const there = state(w, w.farWt);
    const fingerprint = await fingerprintOf(w.farWt, hooklessGit);
    // the sheet counts what comes back as the worker holds it
    const check = await home.placement.check('c_1', H);
    if (!check.ok) throw new Error(check.refusal.reason);
    expect(check.sheet).toMatchObject({ sessionBytes: fs.statSync(farTranscript).size, commits: 1, changedFiles: 1, untrackedFiles: 2, clone: 'warm' });
    expect(moveSummary(check.sheet, 'app', 'this Mac')).toBe('session 1 KB · branch kanban: 1 commit not on origin, 3 changed files · app on this Mac: cloned already');

    const back = await home.placement.start('c_1', H);

    expect(state(w, w.wt)).toEqual(there);
    expect(await fingerprintOf(w.wt, hooklessGit)).toBe(fingerprint);
    expect(fs.readFileSync(path.join(w.wt, '.env'), 'utf8')).toBe('TOKEN=secret\n');
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(fs.readFileSync(path.join(w.macClaude, 'projects/-Users-ada-code-app', `${SID}.jsonl`), 'utf8')).toBe(fs.readFileSync(farTranscript, 'utf8'));
    const here = home.store.state.robots.c_1;
    expect(here).toMatchObject({ cwd: w.wt, placement: { generation: 2 }, repo: { root: w.wt, mainRoot: w.main } });
    for (const k of ['machine', 'moving'] as const) expect(here[k]).toBeUndefined();
    expect(here.tmux).toBeDefined();
    expect(w.mac1.opened).toEqual(['c_1']);
    expect(listed(w, w.clone, w.farWt)).toEqual({ locked: `moved to mac ${back}` });
    expect(here.left).toEqual({ moveId: back, machine: W, path: w.farWt, branch: 'kanban', branchSha: there.head, fingerprint });
    expect(home.placement.status(back).phase).toBe('done');
    expect(back).not.toBe(out);
    await until(() => { expect(w.worker.store.state.robots.c_1?.machine).toBeUndefined(); });
  });

  it('refuses a return when the Mac branch moved, and when the Mac worktree changed, with the exact sentences', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const keys = w.vault.keys.length;

    const head = w.g(w.wt, 'rev-parse', 'HEAD');
    const elsewhere = w.g(w.wt, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'on the Mac');
    w.g(w.main, 'update-ref', 'refs/heads/kanban', elsewhere);
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: 'kanban moved on this Mac since the move; merge or rename it' });
    w.g(w.main, 'update-ref', 'refs/heads/kanban', head);

    const a = fs.readFileSync(path.join(w.wt, 'a.txt'));
    fs.appendFileSync(path.join(w.wt, 'a.txt'), 'edited on the Mac\n');
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: `changes on this Mac in ${w.wt} since the move; stash or commit them` });
    fs.writeFileSync(path.join(w.wt, 'a.txt'), a);

    expect((await home.placement.check('c_1', H)).ok).toBe(true);
    // nothing was rested or reopened for either
    expect(w.vault.keys.length).toBe(keys);
    expect(w.worker.store.state.robots.c_1.tmux).toBeDefined();
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
  });

  it('two prepares into one clone serialize under its lock', async () => {
    const w = open({ second: true });
    const home = await w.start();
    const steps: string[] = [];
    disarm = armFailpoints((name, edge) => { if (name.startsWith('worker.prepare.')) steps.push(`${name.slice('worker.prepare.'.length)}:${edge}`); });

    const [one, two] = await Promise.all([home.placement.start('c_1', W), home.placement.start('c_2', W)]);

    const each = ['worktree', 'apply', 'session', 'journal'].flatMap((s) => [`${s}:before`, `${s}:after`]);
    expect(steps).toEqual([...each, ...each]);
    expect([home.placement.status(one).phase, home.placement.status(two).phase]).toEqual(['done', 'done']);
    for (const [id, slug] of [['c_1', 'kanban'], ['c_2', 'board']]) {
      const root = path.join(w.clone, '.claude/worktrees', slug);
      expect(w.g(root, 'symbolic-ref', '--short', 'HEAD')).toBe(slug);
      expect(w.worker.store.state.robots[id]).toMatchObject({ machine: W, cwd: root });
    }
  });

  it('a blocked agent moves, resumes idle with revive.interrupted, and the sheet said so', async () => {
    const w = open({ agent: { status: 'blocked', prompt: 'Allow Bash?', promptId: 'p1' } });
    const home = await w.start();
    const pane = home.store.state.robots.c_1.tmux!.paneId;

    const check = await home.placement.check('c_1', W);
    if (!check.ok) throw new Error(check.refusal.reason);
    expect(check.sheet).toMatchObject({ question: true });
    expect(check.plan.interruptAfterMs).toBe(0);
    let revive: unknown;
    at('worker.activate.open', 'before', () => { revive = w.worker.store.state.robots.c_1.revive; });

    await home.placement.start('c_1', W);

    expect(w.mac1.keys).toContainEqual({ paneId: pane, text: '\x1b' });
    expect(revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
    const there = w.worker.store.state.robots.c_1;
    expect(there.agent?.status).toBe('idle');
    expect(there.revive).toBeUndefined();
    const promptFile = w.vault.lines.map((l) => /^\. '([^']+)'$/.exec(l.text)?.[1]).find((f) => f !== undefined)!;
    expect(fs.readFileSync(promptFile, 'utf8')).toBe(`rm -f '${promptFile}'; claude --resume ${SID} -- '${RESUME_NOTE}'\n`);
  });

  it('an activation that fails stalls the move with its error on the card, and Retry starts the robot without moving it again', async () => {
    const w = open();
    const home = await w.start();
    at('worker.activate.open', 'before', () => { throw new Error('tmux is gone'); });

    const id = await home.placement.start('c_1', W);

    expect(home.store.state.robots.c_1).toMatchObject({ machine: W, moving: { id, phase: 'activate', error: 'tmux is gone' } });
    expect(home.placement.status(id)).toMatchObject({ phase: 'activate', error: 'tmux is gone' });
    expect(listed(w, w.main, w.wt)).toEqual({});
    const steps: string[] = [];
    disarm = armFailpoints((name, edge) => { if (edge === 'before') steps.push(name); });

    await home.placement.retry(id);

    expect(steps.filter((n) => n.startsWith('worker.prepare.') || n === 'move.bundle' || n === 'move.rest')).toEqual([]);
    expect(home.placement.status(id).phase).toBe('done');
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(w.vault.opened).toEqual(['c_1']);
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
  });

  it('a resume that exits back to its shell on the worker stalls the move with its error, the session kept, and Retry resumes it there', async () => {
    const w = open({ pollMs: 50 });
    const home = await w.start();
    // the agent the worker resumes runs a moment and exits before it reports its session, as a Claude without its login does
    const report = w.vault.started;
    w.vault.started = () => {};
    const moved = home.placement.start('c_1', W);
    await until(() => { expect(w.vault.lines.some((l) => l.text.startsWith('claude --resume'))).toBe(true); });
    await waitForPolls(w.worker.fleet, 2);
    for (const win of w.vault.windows.values()) if (win.name === 'c_1') delete win.job;
    const id = await moved;

    const error = `kanban's terminal resumed claude session ${SID}, but claude exited back to its shell before that session started, so it is dormant again with that session; revive it to see`;
    const there = w.worker.store.state.robots.c_1;
    expect(there).toMatchObject({ resumeError: error, agent: { sessionId: SID }, revive: { command: expect.stringContaining(`--resume ${SID}`) } });
    expect(there.tmux).toBeUndefined();
    expect(home.placement.status(id)).toMatchObject({ phase: 'activate', error });
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W, moving: { id, phase: 'activate', error } });
    await until(() => { expect(home.store.state.robots.c_1.resumeError).toBe(error); });

    w.vault.started = report;
    await home.placement.retry(id);

    expect(home.placement.status(id).phase).toBe('done');
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(w.worker.store.state.robots.c_1).toMatchObject({ tmux: expect.anything(), agent: { sessionId: SID } });
    expect(w.worker.store.state.robots.c_1.resumeError).toBeUndefined();
  });

  it('a worker that could not seed trust answers the agent\'s trust question as it shows', async () => {
    const w = open({ agentRunsThere: true });
    w.vault.screens.set('%1', TRUST_DIALOG);
    const home = await w.start();
    await home.placement.start('c_1', W);
    await until(() => { expect(w.vault.keys).toEqual([{ paneId: '%1', text: '2' }, { paneId: '%1', text: '\r' }]); });
    expect(JSON.parse(fs.readFileSync(path.join(w.far, '.claude.json'), 'utf8')).projects).toBeUndefined();
  });

  it('a worker that seeded trust never looks for the trust question, nor types into the pane', async () => {
    const w = open();
    w.vault.screens.set('%1', TRUST_DIALOG);
    const home = await w.start();
    await home.placement.start('c_1', W);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(w.vault.keys).toEqual([]);
  });

  it('a robot in no repository moves with its session only, and comes back the same way', async () => {
    const w = open({ notInRepo: true });
    const home = await w.start();
    const transcript = (claude: string) => path.join(claude, 'projects/-Users-ada-code-app', `${SID}.jsonl`);

    await home.placement.start('c_1', W);
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, cwd: path.join(w.far, 'notes'), agent: { transcriptPath: transcript(w.farClaude) } });
    expect(w.worker.store.state.robots.c_1.repo).toBeUndefined();
    expect(fs.existsSync(w.clone)).toBe(false);
    expect(fs.readFileSync(transcript(w.farClaude), 'utf8')).toBe(fs.readFileSync(transcript(w.macClaude), 'utf8'));
    expect(home.store.state.robots.c_1.left).toBeUndefined();

    fs.appendFileSync(transcript(w.farClaude), `${JSON.stringify({ type: 'assistant', sessionId: SID })}\n`);
    await home.placement.start('c_1', H);
    expect(home.store.state.robots.c_1).toMatchObject({ cwd: w.notes, agent: { transcriptPath: transcript(w.macClaude) } });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(fs.readFileSync(transcript(w.macClaude), 'utf8')).toBe(fs.readFileSync(transcript(w.farClaude), 'utf8'));
    expect(w.mac1.opened).toEqual(['c_1']);
  });

  it('a Claude robot never prompted moves with no session, and starts fresh there without waiting on its old session', async () => {
    const w = open({ notInRepo: true });
    const home = await w.start();
    const transcript = (claude: string) => path.join(claude, 'projects/-Users-ada-code-app', `${SID}.jsonl`);
    fs.rmSync(transcript(w.macClaude));

    const began = Date.now();
    await home.placement.start('c_1', W);
    expect(Date.now() - began).toBeLessThan(5000);
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, cwd: path.join(w.far, 'notes') });
    expect(fs.existsSync(transcript(w.farClaude))).toBe(false);
    expect(w.vault.lines.at(-1)?.text).toMatch(/^claude\b/);
    expect(w.vault.lines.at(-1)?.text).not.toContain('--resume');
  });

  it('an OpenCode robot moves with its session written out of OpenCode here and read into OpenCode there, and comes back the same way', async () => {
    const w = open({ opencode: true });
    const home = await w.start();
    const log = (dir: string) => path.join(dir, `${OSID}.jsonl`);

    await home.placement.start('c_1', W);
    // the worker's OpenCode holds the session in the robot's folder there, and this Mac's keeps its own copy
    expect(w.opencode.far.sessions.get(OSID)).toEqual({ directory: w.farWt, messages: [{ id: 'msg_1' }, { id: 'msg_2' }] });
    expect(w.opencode.mac.sessions.get(OSID)).toEqual({ directory: w.wt, messages: [{ id: 'msg_1' }, { id: 'msg_2' }] });
    expect(fs.readFileSync(log(w.farOpencode), 'utf8')).toBe(fs.readFileSync(log(w.macOpencode), 'utf8'));
    expect(fs.existsSync(path.join(w.farOpencode, 'exports'))).toBe(false);
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, cwd: w.farWt, agent: { kind: 'opencode', transcriptPath: log(w.farOpencode) } });
    expect(w.vault.lines.at(-1)?.text).toMatch(new RegExp(`^opencode .*-s ${OSID}$`));

    // a turn there, then the way back replaces this Mac's older copy with the worker's
    w.opencode.far.sessions.get(OSID)!.messages.push({ id: 'msg_3' });
    await home.placement.start('c_1', H);
    expect(w.opencode.mac.sessions.get(OSID)).toEqual({ directory: w.wt, messages: [{ id: 'msg_1' }, { id: 'msg_2' }, { id: 'msg_3' }] });
    expect(home.store.state.robots.c_1).toMatchObject({ cwd: w.wt, agent: { kind: 'opencode', transcriptPath: log(w.macOpencode) } });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.mac1.lines.at(-1)?.text).toMatch(new RegExp(`^opencode .*-s ${OSID}$`));
  });

  it('a return refuses an OpenCode session this Mac went on with meanwhile before it touches the Mac worktree, and its copy stays', async () => {
    const w = open({ opencode: true });
    const home = await w.start();
    const out = await home.placement.start('c_1', W);
    const before = state(w, w.wt);
    const fingerprint = await fingerprintOf(w.wt, hooklessGit);
    w.opencode.mac.sessions.get(OSID)!.messages.push({ id: 'msg_here' });
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({
      code: 'refused', message: `OpenCode went on with session ${OSID} on this Mac since the move; save it with opencode session export, then delete it`,
    });
    expect(w.opencode.mac.sessions.get(OSID)?.messages.at(-1)).toEqual({ id: 'msg_here' });
    expect(home.store.state.robots.c_1.machine).toBe(W);
    // the Mac worktree keeps the changes it held, locked as the robot left it
    expect(state(w, w.wt)).toEqual(before);
    expect(await fingerprintOf(w.wt, hooklessGit)).toBe(fingerprint);
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${out}` });
    expect(home.store.state.robots.c_1.left?.fingerprint).toBe(fingerprint);
  });

  it('a move refuses an OpenCode session the worker went on with since the robot came back, before anything moves, and its copy stays', async () => {
    const w = open({ opencode: true });
    const home = await w.start();
    await home.placement.start('c_1', W);
    await home.placement.start('c_1', H);
    const before = state(w, w.wt);
    w.opencode.far.sessions.get(OSID)!.messages.push({ id: 'msg_there' });
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({
      code: 'refused', message: `OpenCode went on with session ${OSID} on w1 since the move; save it with opencode session export, then delete it`,
    });
    expect(w.opencode.far.sessions.get(OSID)?.messages.at(-1)).toEqual({ id: 'msg_there' });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(state(w, w.wt)).toEqual(before);
    expect(w.worker.store.state.robots.c_1?.machine).toBeUndefined();
  });

  it('a return refuses a working agent or a running command there unless an interrupt is chosen, and one chosen rests it after its turn', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    const pane = w.worker.store.state.robots.c_1.tmux!.paneId;
    const win = [...w.vault.windows.values()].find((x) => x.paneId === pane)!;
    const agent = win.job;
    win.job = 'npm test';
    expect(await home.placement.check('c_1', H)).toMatchObject({
      ok: false, refusal: { reason: 'a command is running', action: INTERRUPT_ACTIONS.command, details: ['wait for it'] },
    });
    win.job = agent;
    w.worker.store.update((d) => { d.robots.c_1.agent!.status = 'working'; });
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: 'kanban is working', action: INTERRUPT_ACTIONS.agent, details: [] } });
    expect(await home.placement.check('c_1', H, { interruptAfterMs: 0 })).toMatchObject({ ok: true, sheet: { interrupts: true }, plan: { interruptAfterMs: 0 } });

    const id = await home.placement.start('c_1', H, { interruptAfterMs: 0 });

    expect(w.vault.keys).toContainEqual({ paneId: pane, text: '\x1b' });
    expect(home.placement.status(id).phase).toBe('done');
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.mac1.opened).toEqual(['c_1']);
  });

  it('a return check names a worker that answers no move sheet in time, or runs a release without one', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const sheet = w.worker.handlers['move.sheet'];
    w.worker.handlers['move.sheet'] = () => new Promise(() => {});
    // the sheet's 30 s, cut short
    const call = home.links.call.bind(home.links);
    const waits: (number | undefined)[] = [];
    home.links.call = ((m, method, params, o) => {
      if (method !== 'move.sheet') return call(m, method, params, o);
      waits.push(o?.timeoutMs);
      return call(m, method, params, { ...o, timeoutMs: 100 });
    }) as typeof home.links.call;
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: 'w1 did not answer the move sheet in 30 s', action: 'try again' } });
    expect(waits).toEqual([30_000]);
    home.links.call = call;
    delete w.worker.handlers['move.sheet'];
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: 'w1 runs a release without move.sheet', action: 'upgrade it under Machines' } });
    w.worker.handlers['move.sheet'] = sheet;
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: true });
  });

  it('a check names a worker that gives no answer in time, on the way back, out again, and home into a new worktree', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const silent = { ok: false, refusal: { reason: 'w1 did not answer', action: 'try again; if it keeps happening, Check it under Machines' } };
    // `method` hangs there, and its call here is cut short
    const call = home.links.call.bind(home.links);
    const hang = (method: string): (() => void) => {
      const was = w.worker.handlers[method];
      w.worker.handlers[method] = () => new Promise(() => {});
      home.links.call = ((m, asked, params, o) => call(m, asked, params, asked === method ? { ...o, timeoutMs: 100 } : o)) as typeof home.links.call;
      return () => { w.worker.handlers[method] = was; home.links.call = call; };
    };

    let answer = hang('system.info');
    expect(await home.placement.check('c_1', H)).toMatchObject(silent);
    answer();
    await home.placement.start('c_1', H);
    answer = hang('move.compare');
    expect(await home.placement.check('c_1', W)).toMatchObject(silent);
    answer();
    const b = await bornThere(w, 'scout');
    answer = hang('repo.probe');
    expect(await home.placement.check(b.id, H)).toMatchObject(silent);
    answer();
    expect(await home.placement.check(b.id, H)).toMatchObject({ ok: true });
  });

  it('a return refuses a worktree there mid-merge, whose bundle would carry none of it', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const merge = path.join(w.g(w.farWt, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD');
    fs.writeFileSync(merge, `${w.g(w.farWt, 'rev-parse', 'HEAD')}\n`);
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: `${w.farWt} is in the middle of a merge`, action: 'finish or abort it first' } });
    fs.rmSync(merge);
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: true });
  });

  it('a merge started while the agent rests undoes the move at the bundle, either way, and stays where it was started', async () => {
    const w = open();
    const home = await w.start();
    const merging = (wt: string): string => {
      const merge = path.join(w.g(wt, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD');
      at('move.bundle', 'before', () => fs.writeFileSync(merge, `${w.g(wt, 'rev-parse', 'HEAD')}\n`));
      return merge;
    };
    let merge = merging(w.wt);
    await expect(home.placement.start('c_1', W)).rejects.toThrow(`${w.wt} is in the middle of a merge; finish or abort it first`);
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(fs.existsSync(merge)).toBe(true);
    fs.rmSync(merge);

    await home.placement.start('c_1', W);
    merge = merging(w.farWt);
    await expect(home.placement.start('c_1', H)).rejects.toThrow(`${w.farWt} is in the middle of a merge; finish or abort it first`);
    expect(home.store.state.robots.c_1.machine).toBe(W);
    expect(fs.existsSync(merge)).toBe(true);
  });

  it('a return whose OpenCode import fails puts back the copy this Mac held, and keeps no other', async () => {
    const w = open({ opencode: true });
    const home = await w.start();
    await home.placement.start('c_1', W);
    w.opencode.far.sessions.get(OSID)!.messages.push({ id: 'msg_3' });
    w.opencode.mac.failImports = 1;
    await expect(home.placement.start('c_1', H)).rejects.toThrow(`OpenCode did not import session ${OSID}: Error: database is locked`);
    expect(w.opencode.mac.sessions.get(OSID)).toEqual({ directory: w.wt, messages: [{ id: 'msg_1' }, { id: 'msg_2' }] });
    expect(fs.existsSync(path.join(w.homePaths.moves, 'held', 'opencode', `${OSID}.json`))).toBe(false);
    expect(home.store.state.robots.c_1.machine).toBe(W);
  });

  it('a robot back from a worker goes there again into the worktree it left, and is refused when that changed since', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    await home.placement.start('c_1', H);

    const b = path.join(w.farWt, 'b.txt');
    const held = fs.readFileSync(b);
    fs.appendFileSync(b, 'edited on w1\n');
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'refused', message: `changes on w1 in ${w.farWt} since the move; stash or commit them` });
    fs.writeFileSync(b, held);
    const head = w.g(w.farWt, 'rev-parse', 'HEAD');
    w.g(w.clone, 'update-ref', 'refs/heads/kanban', w.g(w.farWt, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'on w1'));
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'refused', message: 'kanban moved on w1 since the move; merge or rename it' });
    w.g(w.clone, 'update-ref', 'refs/heads/kanban', head);
    // neither refusal rested the robot
    expect(w.mac1.opened).toEqual(['c_1']);

    // the robot works on here: a commit, an edit, a new file
    w.g(w.wt, 'commit', '-qm', 'on the Mac');
    fs.appendFileSync(path.join(w.wt, 'b.txt'), 'and on the Mac\n');
    fs.writeFileSync(path.join(w.wt, 'again.md'), 'again\n');
    const now = state(w, w.wt);
    const fingerprint = await fingerprintOf(w.wt, hooklessGit);
    // a prepare that fails there leaves that worktree as the robot left it, locked again, for the next move to take
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });
    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');
    disarm?.();
    expect(listed(w, w.clone, w.farWt)?.locked).toMatch(/^moved to mac mv_/);
    expect(w.g(w.farWt, 'rev-parse', 'HEAD')).toBe(head);

    const id = await home.placement.start('c_1', W);

    expect(state(w, w.farWt)).toEqual(now);
    expect(await fingerprintOf(w.farWt, hooklessGit)).toBe(fingerprint);
    expect(listed(w, w.clone, w.farWt)).toEqual({});
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W, left: { moveId: id, machine: H, path: w.wt, branchSha: now.head } });
    expect(home.placement.status(id).phase).toBe('done');
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);
  });

  it('an abort the worker answers again holds the fingerprint of the worktree it left again, so the next move there passes its checks', async () => {
    const w = open();
    const first = await w.start();
    await first.placement.start('c_1', W);
    await first.placement.start('c_1', H);
    // the prepare there fails, and the home dies before it takes the worker's answer to the abort
    disarm = armFailpoints((n, e) => {
      if (n === 'worker.prepare.journal' && e === 'before') throw new Error('the disk is full');
      if (n === 'worker.abort.remove' && e === 'after') first.life.dead = true;
    });
    await expect(first.placement.start('c_1', W)).rejects.toThrow();
    disarm();
    disarm = undefined;
    first.links.stop();
    const fingerprint = await fingerprintOf(w.farWt, hooklessGit);

    const again = await w.bootHome();
    await again.placement.recoverMoves();
    expect(again.store.state.robots.c_1.left).toMatchObject({ machine: W, path: w.farWt, fingerprint });
    const id = await again.placement.start('c_1', W);
    expect(again.placement.status(id).phase).toBe('done');
    expect(again.store.state.robots.c_1.machine).toBe(W);
  });

  it('an aborted move on another branch into the worktree the robot left on the worker puts it back on kanban where it left it, and that branch there as it was, new or not', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    await home.placement.start('c_1', H);
    const left = w.g(w.farWt, 'rev-parse', 'HEAD');
    // the robot goes on here on a branch of its own, with a commit the move carries
    w.g(w.wt, 'checkout', '-q', '-b', 'other');
    w.g(w.wt, 'commit', '-qm', 'on other');
    const failing = (): void => at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });

    failing();
    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');
    expect(state(w, w.farWt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.clone, 'branch', '--list', 'other')).toBe('');
    expect(listed(w, w.clone, w.farWt)?.locked).toMatch(/^moved to mac mv_/);

    // a branch of that name there already, behind what comes
    const before = w.g(w.clone, 'rev-parse', 'kanban~1');
    w.g(w.clone, 'branch', 'other', before);
    failing();
    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');
    expect(state(w, w.farWt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.clone, 'rev-parse', 'other')).toBe(before);
    expect(listed(w, w.clone, w.farWt)?.locked).toMatch(/^moved to mac mv_/);
    expect(home.store.state.robots.c_1.machine).toBeUndefined();

    disarm?.();
    const here = state(w, w.wt);
    await home.placement.start('c_1', W);
    expect(state(w, w.farWt)).toEqual(here);
  });

  it('an aborted move leaves the worktree the robot left on the worker as it is, unlocked, when it changed after the move took it back, and the note says so', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    await home.placement.start('c_1', H);
    const b = path.join(w.farWt, 'b.txt');
    const coming = fs.readFileSync(path.join(w.wt, 'b.txt'), 'utf8');
    at('worker.prepare.journal', 'before', () => {
      fs.appendFileSync(b, 'saved on w1\n');
      throw new Error('the disk is full');
    });

    const failed = await home.placement.start('c_1', W).catch((e: Error & { data: { moveId: string } }) => e);

    expect(failed).toMatchObject({ message: 'the disk is full' });
    expect(fs.readFileSync(b, 'utf8')).toBe(`${coming}saved on w1\n`);
    expect(listed(w, w.clone, w.farWt)).toEqual({});
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(home.store.state.robots.c_1.note).toContain(`${w.farWt} on w1 changed during a move that was undone, so it stays as it is, unlocked; save what you need from it and git worktree remove --force it, and the next move there makes a new one`);
    // and answers so again
    expect(await w.worker.handlers['move.abort']({ id: (failed as { data: { moveId: string } }).data.moveId })).toEqual({ kept: true });
    disarm?.();
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'refused', message: `changes on w1 in ${w.farWt} since the move; stash or commit them` });
    expect(fs.readFileSync(b, 'utf8')).toBe(`${coming}saved on w1\n`);
  });

  it('an abort asked again after the worker left the worktree again, and failed before it answered, leaves it locked with its fingerprint', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    await home.placement.start('c_1', H);
    disarm = armFailpoints((n, e) => {
      if (n === 'worker.prepare.journal' && e === 'before') throw new Error('the disk is full');
      if (n === 'worker.abort.remove' && e === 'after') throw new Error('the worker stopped');
    });
    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');
    disarm();
    disarm = undefined;

    await home.placement.recoverMoves();

    const c = home.store.state.robots.c_1;
    expect(c.note).not.toContain('changed during a move that was undone');
    expect(listed(w, w.clone, w.farWt)?.locked).toMatch(/^moved to mac mv_/);
    expect(c.left).toMatchObject({ machine: W, path: w.farWt, fingerprint: await fingerprintOf(w.farWt, hooklessGit) });
    const id = await home.placement.start('c_1', W);
    expect(home.placement.status(id).phase).toBe('done');
  });

  it('a move refuses a branch of its name on the worker holding commits the robot\'s lacks, at the check and at the apply, and takes one it holds whole', async () => {
    const w = open();
    w.g(w.base, 'clone', '-q', w.origin, w.clone);
    // kanban there, checked out nowhere, one commit past anything this Mac has
    const theirs = w.g(w.clone, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'on w1');
    w.g(w.clone, 'update-ref', 'refs/heads/kanban', theirs);
    const home = await w.start();
    const sentence = 'w1 has a branch kanban with commits this one lacks; merge or rename it there first';
    expect(await home.placement.check('c_1', W)).toMatchObject({ ok: false, refusal: { reason: 'w1 has a branch kanban with commits this one lacks', action: 'merge or rename it there first' } });

    // one made there after the check passed is refused where the bundle is applied
    w.g(w.clone, 'update-ref', '-d', 'refs/heads/kanban');
    at('move.journal.prepare', 'after', () => { w.g(w.clone, 'update-ref', 'refs/heads/kanban', theirs); });
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'refused', message: sentence });
    disarm?.();
    expect(w.g(w.clone, 'rev-parse', 'kanban')).toBe(theirs);
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.mac1.opened).toEqual(['c_1']);
    const [j] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    expect(home.placement.status(j.slice(0, -'.json'.length))).toMatchObject({ phase: 'aborted', error: sentence });

    // one the robot's branch holds whole moves on to it
    w.g(w.clone, 'update-ref', 'refs/heads/kanban', w.g(w.main, 'rev-parse', 'main'));
    const id = await home.placement.start('c_1', W);
    expect(home.placement.status(id).phase).toBe('done');
    expect(w.g(w.clone, 'rev-parse', 'kanban')).toBe(w.g(w.wt, 'rev-parse', 'HEAD'));
  });

  it('a return refuses a branch of its name on this Mac holding commits the worker\'s lacks, at the check and at the apply, and the robot stays there', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    // the robot takes up fix-login there, which this Mac holds too, one commit past anything w1 has
    w.g(w.farWt, 'switch', '-q', '-c', 'fix-login');
    for (const s of [w.worker.store, home.store]) s.update((d) => { d.robots.c_1.repo!.branch = 'fix-login'; });
    const base = w.g(w.main, 'rev-parse', 'main');
    const mine = w.g(w.main, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'on the Mac');
    w.g(w.main, 'update-ref', 'refs/heads/fix-login', mine);
    const sentence = 'this Mac has a branch fix-login with commits this one lacks; merge or rename it there first';
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: 'this Mac has a branch fix-login with commits this one lacks', action: 'merge or rename it there first' } });

    w.g(w.main, 'update-ref', '-d', 'refs/heads/fix-login');
    at('move.journal.bundle', 'after', () => { w.g(w.main, 'update-ref', 'refs/heads/fix-login', mine); });
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: sentence });
    expect(w.g(w.main, 'rev-parse', 'fix-login')).toBe(mine);
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W });
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });

  it('an abort after a worktree in the way leaves that worktree and its branch on the worker as they were', async () => {
    const w = open();
    w.g(w.base, 'clone', '-q', w.origin, w.clone);
    w.g(w.clone, 'worktree', 'add', '-q', '-b', 'kanban', w.farWt);
    fs.writeFileSync(path.join(w.farWt, 'mine.md'), 'mine\n');
    const sha = w.g(w.clone, 'rev-parse', 'kanban');
    const home = await w.start();

    await expect(home.placement.start('c_1', W)).rejects.toThrow(`${w.farWt} on w1 is in the way; move it out of the way there first`);

    expect(fs.readFileSync(path.join(w.farWt, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(listed(w, w.clone, w.farWt)).toEqual({});
    expect(w.g(w.clone, 'rev-parse', 'kanban')).toBe(sha);
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.mac1.opened).toEqual(['c_1']);
  });

  it('an abort after the clone\'s main checkout let go of the branch checks the branch out there again where it was', async () => {
    const w = open();
    w.g(w.base, 'clone', '-q', w.origin, w.clone);
    w.g(w.clone, 'checkout', '-q', '-b', 'kanban');
    const sha = w.g(w.clone, 'rev-parse', 'kanban');
    const home = await w.start();
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');

    expect(w.g(w.clone, 'symbolic-ref', '--short', 'HEAD')).toBe('kanban');
    expect(w.g(w.clone, 'rev-parse', 'kanban')).toBe(sha);
    expect(listed(w, w.clone, w.farWt)).toBeUndefined();
    expect(fs.existsSync(w.farWt)).toBe(false);
  });

  it('a move refuses a worker clone\'s main checkout that is rebasing or bisecting the robot\'s branch, and leaves it where it stopped', async () => {
    const w = open();
    w.g(w.base, 'clone', '-q', w.origin, w.clone);
    w.g(w.clone, 'fetch', '-q', w.main, 'kanban:kanban');
    w.g(w.clone, 'checkout', '-q', 'kanban');
    let side = w.g(w.clone, 'rev-parse', 'HEAD');
    for (const n of ['1', '2', '3']) side = w.g(w.clone, 'commit-tree', 'HEAD^{tree}', '-p', side, '-m', n);
    w.g(w.clone, 'update-ref', 'refs/heads/side', side);
    const home = await w.start();

    for (const [stop, done] of [[['rebase', '-q', '-x', 'false', 'HEAD~1'], ['rebase', '--abort']], [['bisect', 'start', 'side', 'HEAD'], ['bisect', 'reset']]]) {
      try { w.g(w.clone, ...stop); } catch { /* the rebase stops at its failing exec */ }
      const head = w.g(w.clone, 'rev-parse', 'HEAD');

      await expect(home.placement.start('c_1', W)).rejects.toThrow(`kanban is checked out in ${fs.realpathSync(w.clone)} on w1; check out another branch there first`);

      expect(w.g(w.clone, 'rev-parse', 'HEAD')).toBe(head);
      expect(() => w.g(w.clone, 'symbolic-ref', '-q', 'HEAD')).toThrow();
      expect(listed(w, w.clone, w.farWt)).toBeUndefined();
      expect(home.store.state.robots.c_1.machine).toBeUndefined();
      w.g(w.clone, ...done);
    }
  });

  it('a return refused at prepare leaves the Mac worktree\'s changes as they are and the robot running on the worker', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const a = path.join(w.wt, 'a.txt');
    const held = fs.readFileSync(a);
    // the Mac worktree unlocked and worked in once the return's checks passed
    at('move.journal.prepare', 'after', () => {
      w.g(w.main, 'worktree', 'unlock', w.wt);
      fs.appendFileSync(a, 'edited on the Mac\n');
      fs.writeFileSync(path.join(w.wt, 'mine.md'), 'mine\n');
    });

    // with the step it failed at, which the move sheet names
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({
      code: 'refused', message: `changes on this Mac in ${w.wt} since the move; stash or commit them`, data: { phase: 'prepare', moveId: expect.stringMatching(/^mv_/) },
    });

    expect(fs.readFileSync(a, 'utf8')).toBe(`${held}edited on the Mac\n`);
    expect(fs.readFileSync(path.join(w.wt, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W });
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);
    expect(w.mac1.opened).toEqual([]);
  });

  it('a return looks at the Mac worktree again right before it resets it, so a save made while what came back is checked stays', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const a = path.join(w.wt, 'a.txt');
    const held = fs.readFileSync(a);
    // an editor saves into the Mac worktree once the return's prepare is under way, as it checks the branches here
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    at('move.journal.prepare', 'after', () => {
      let saved = false;
      d.git = (args, cwd) => {
        if (!saved && args[0] === 'for-each-ref' && args.at(-1) === 'refs/heads') {
          saved = true;
          fs.appendFileSync(a, 'saved on the Mac\n');
        }
        return git(args, cwd);
      };
    });

    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({
      code: 'refused', message: `changes on this Mac in ${w.wt} since the move; stash or commit them`, data: { phase: 'prepare' },
    });
    d.git = git;

    expect(fs.readFileSync(a, 'utf8')).toBe(`${held}saved on the Mac\n`);
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W });
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });

  it('an aborted return that came back on another branch puts the Mac worktree back on kanban where it left it, and that branch as it was here, new or not', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const left = w.g(w.wt, 'rev-parse', 'HEAD');
    // the robot goes on there on a branch of its own, with a commit the return carries
    w.g(w.farWt, 'checkout', '-q', '-b', 'other');
    w.g(w.farWt, 'commit', '-qm', 'on other');
    const failing = (): void => at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });

    failing();
    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');
    expect(state(w, w.wt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.main, 'branch', '--list', 'other')).toBe('');
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);

    // a branch of that name here already, behind what comes back
    const before = w.g(w.main, 'rev-parse', 'kanban~1');
    w.g(w.main, 'branch', 'other', before);
    failing();
    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');
    expect(state(w, w.wt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.main, 'rev-parse', 'other')).toBe(before);
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    expect(home.store.state.robots.c_1.machine).toBe(W);

    disarm?.();
    const there = state(w, w.farWt);
    await home.placement.start('c_1', H);
    expect(state(w, w.wt)).toEqual(there);
  });

  it('an aborted return leaves the Mac worktree as it is, unlocked, when it changed after the return took it back, and the note says so and how to bring the robot back', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    w.g(w.farWt, 'commit', '-qm', 'staged work');
    const a = path.join(w.wt, 'a.txt');
    const coming = fs.readFileSync(path.join(w.farWt, 'a.txt'), 'utf8');
    at('move.journal.commit', 'before', () => {
      fs.appendFileSync(a, 'saved on the Mac\n');
      throw new Error('the disk is full');
    });

    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');

    expect(fs.readFileSync(a, 'utf8')).toBe(`${coming}saved on the Mac\n`);
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1.machine).toBe(W);
    expect(home.store.state.robots.c_1.note).toContain(`${w.wt} on this Mac changed during a move that was undone, so it stays as it is, unlocked; save what you need from it and git worktree remove --force it, and the next move there makes a new one`);
    disarm?.();
    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: 'kanban moved on this Mac since the move; merge or rename it' });
    expect(fs.readFileSync(a, 'utf8')).toBe(`${coming}saved on the Mac\n`);

    w.g(w.main, 'worktree', 'remove', '--force', w.wt);
    const there = state(w, w.farWt);
    await home.placement.start('c_1', H);
    expect(state(w, w.wt)).toEqual(there);
  });

  it('an aborted return keeps a file saved into the Mac worktree while the return applied what came back', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    let saved = false;
    d.git = (args, cwd) => {
      if (!saved && args[0] === 'apply') {
        saved = true;
        fs.writeFileSync(path.join(w.wt, 'mine.md'), 'mine\n');
      }
      return git(args, cwd);
    };
    at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');
    d.git = git;

    expect(saved).toBe(true);
    expect(fs.readFileSync(path.join(w.wt, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1.note).toContain(`${w.wt} on this Mac changed during a move that was undone, so it stays as it is, unlocked; save what you need from it and git worktree remove --force it, and the next move there makes a new one`);
  });

  it('an aborted return leaves the Mac worktree as it is, unlocked, when the branch it was left on moved after the return took it back', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    w.g(w.farWt, 'checkout', '-q', '-b', 'other');
    w.g(w.farWt, 'commit', '-qm', 'on other');
    const head = w.g(w.main, 'rev-parse', 'kanban');
    const moved = w.g(w.main, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'on the Mac');
    at('move.journal.commit', 'before', () => {
      w.g(w.main, 'update-ref', 'refs/heads/kanban', moved);
      throw new Error('the disk is full');
    });

    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');

    expect(w.g(w.main, 'rev-parse', 'kanban')).toBe(moved);
    expect(state(w, w.wt).branch).toBe('other');
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1.note).toContain(`${w.wt} on this Mac changed during a move that was undone, so it stays as it is, unlocked; save what you need from it and git worktree remove --force it, and the next move there makes a new one`);
  });

  it('a return refuses a Mac worktree kept on the branch an undone return came on, and a commit made there stays on that branch', async () => {
    const w = open();
    // the robot leaves its worktree here holding nothing beyond its commit
    w.g(w.wt, 'add', 'a.txt', 'b.txt', 'notes.md');
    w.g(w.wt, 'commit', '-qm', 'all of it');
    const home = await w.start();
    await home.placement.start('c_1', W);
    w.g(w.farWt, 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(w.farWt, 'other.txt'), 'other\n');
    w.g(w.farWt, 'add', 'other.txt');
    w.g(w.farWt, 'commit', '-qm', 'on other');
    at('move.journal.commit', 'before', () => {
      fs.appendFileSync(path.join(w.wt, 'other.txt'), 'saved on the Mac\n');
      throw new Error('the disk is full');
    });
    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');
    disarm?.();
    expect(state(w, w.wt).branch).toBe('other');
    w.g(w.wt, 'commit', '-qam', 'mine');
    const mine = w.g(w.wt, 'rev-parse', 'HEAD');

    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: `${w.wt} on this Mac is on other since the move; check out kanban there or remove the worktree` });

    expect(w.g(w.main, 'rev-parse', 'other')).toBe(mine);
    expect(home.store.state.robots.c_1.machine).toBe(W);
  });

  it('an aborted return puts the Mac worktree back on kanban when what came back was refused once it was checked out', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const left = w.g(w.wt, 'rev-parse', 'HEAD');
    w.g(w.farWt, 'checkout', '-q', '-b', 'other');
    w.g(w.farWt, 'commit', '-qm', 'on other');
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    d.git = (args, cwd) => (args[0] === 'apply' && args.includes('--whitespace=nowarn') ? Promise.resolve({ code: 1, stdout: '', stderr: 'error: patch failed' }) : git(args, cwd));

    await expect(home.placement.start('c_1', H)).rejects.toThrow('patch failed');
    d.git = git;

    expect(state(w, w.wt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.main, 'branch', '--list', 'other')).toBe('');
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    expect(home.store.state.robots.c_1.note).not.toContain('changed during a move that was undone');
  });

  it('an aborted return takes back a file this Mac\'s ignore rules leave out, and locks the Mac worktree again', async () => {
    const w = open();
    fs.appendFileSync(path.join(w.main, '.git/info/exclude'), '*.log\n');
    const home = await w.start();
    await home.placement.start('c_1', W);
    fs.writeFileSync(path.join(w.farWt, 'run.log'), 'ran\n');
    fs.appendFileSync(path.join(w.farWt, 'b.txt'), 'more\n');
    at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');

    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    expect(home.store.state.robots.c_1.note).not.toContain('changed during a move that was undone');
    disarm?.();
    await home.placement.start('c_1', H);
    expect(fs.readFileSync(path.join(w.wt, 'run.log'), 'utf8')).toBe('ran\n');
  });

  it('an abort that stopped once it checked the Mac worktree out on kanban again finishes when svalld starts again', async () => {
    const w = open();
    const first = await w.start();
    await first.placement.start('c_1', W);
    const left = w.g(w.wt, 'rev-parse', 'HEAD');
    w.g(w.farWt, 'checkout', '-q', '-b', 'other');
    w.g(w.farWt, 'commit', '-qm', 'on other');
    const d = first.placement['d'] as { git: GitRunner };
    const git = d.git;
    d.git = async (args, cwd) => {
      const r = await git(args, cwd);
      if (args[0] === 'checkout' && args.includes('-f')) {
        first.life.dead = true;
        throw new Crash('svalld died');
      }
      return r;
    };
    at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });
    await expect(first.placement.start('c_1', H)).rejects.toThrow();
    first.links.stop();
    disarm?.();
    expect(fs.existsSync(path.join(w.wt, 'notes.md'))).toBe(true);

    const again = await w.bootHome();
    await again.placement.recoverMoves();

    expect(state(w, w.wt)).toMatchObject({ branch: 'kanban', head: left });
    expect(w.g(w.main, 'branch', '--list', 'other')).toBe('');
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    expect(again.store.state.robots.c_1.note).not.toContain('changed during a move that was undone');
  });

  it('a move waits while the worker catches up with this Mac: busy, with the one sentence', async () => {
    const w = open();
    const home = await w.start();
    const link = home.links.for(W)!;
    link.outboxDrained = () => false;
    await expect(home.placement.start('c_1', W)).rejects.toMatchObject({ code: 'busy', message: 'w1 is still catching up with this Mac; try again in a moment' });
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(w.mac1.windows.size).toBe(1);
  });

  it('a move whose link to the worker drops before its prepare waits for the link to come back and the agent configuration it sends then, and goes on', async () => {
    let [pushes, pushing] = [0, 0];
    let last: Promise<unknown> = Promise.resolve();
    const push = async () => { pushes++; pushing++; await new Promise((r) => setTimeout(r, 500)); pushing--; return { sent: 0 }; };
    const w = open({ mirror: { push: () => (last = push()), settled: () => last } });
    const home = await w.start();
    let [closed, atPrepare] = [false, -1];
    disarm = armFailpoints((n, e) => {
      // as the home closes a link whose ping went unanswered
      if (n === 'move.bundle' && e === 'after' && !closed) { closed = true; home.links.for(W)!['stream']!.close(); }
      if (n === 'worker.prepare.journal' && e === 'before') atPrepare = pushing;
    });
    await home.placement.start('c_1', W);
    expect(home.store.state.robots.c_1.machine).toBe(W);
    // the link's push, the move's before its bundle, and the link's again once it is back
    expect([atPrepare, pushes]).toEqual([0, 3]);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });

  it('a move sends the worker the home\'s agent configuration before its bundle, and goes on when that fails', async () => {
    let pushes = 0;
    const w = open({ mirror: { push: async () => { pushes++; throw new Error('no space left on device'); }, settled: async () => {} } });
    const home = await w.start();
    await until(() => { expect(pushes).toBe(1); });
    let atBundle = 0;
    at('move.bundle', 'before', () => { atBundle = pushes; });
    await home.placement.start('c_1', W);
    expect(atBundle).toBe(2);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });

  it('a robot started on the worker comes home into a new worktree of this Mac\'s clone with all it holds there, and its worktree there is left locked', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    const there = state(w, b.far);
    const fingerprint = await fingerprintOf(b.far, hooklessGit);
    const check = await home.placement.check(b.id, H);
    if (!check.ok) throw new Error(check.refusal.reason);
    expect(check.sheet).toMatchObject({ commits: 1, changedFiles: 2, untrackedFiles: 1, clone: 'warm' });
    expect(check.plan.have.sort()).toEqual([...new Set(w.g(w.main, 'for-each-ref', '--format=%(objectname)').split('\n'))].sort());

    const id = await home.placement.start(b.id, H);

    expect(state(w, b.mac)).toEqual(there);
    expect(await fingerprintOf(b.mac, hooklessGit)).toBe(fingerprint);
    expect(listed(w, w.main, b.mac)).toEqual({});
    expect(w.g(w.main, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(fs.readFileSync(path.join(w.macClaude, b.transcript), 'utf8')).toBe(fs.readFileSync(path.join(w.farClaude, b.transcript), 'utf8'));
    const here = home.store.state.robots[b.id];
    expect(here).toMatchObject({ cwd: b.mac, placement: { generation: 1 }, repo: { root: b.mac, mainRoot: w.main, branch: 'scout', isWorktree: true } });
    expect(here.machine).toBeUndefined();
    expect(here.left).toEqual({ moveId: id, machine: W, path: b.far, branch: 'scout', branchSha: there.head, fingerprint });
    expect(listed(w, w.clone, b.far)).toEqual({ locked: `moved to mac ${id}` });
    expect(w.mac1.opened).toEqual([b.id]);
    expect(home.placement.status(id).phase).toBe('done');
    await until(() => { expect(w.worker.store.state.robots[b.id]?.machine).toBeUndefined(); });
  });

  it('a robot that went on in another worktree on the worker comes home into a new one, and the worktree it left here is unlocked as it was', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const left = state(w, w.wt);
    const other = path.join(w.clone, '.claude/worktrees/other');
    w.g(w.clone, 'worktree', 'add', '-q', '-b', 'other', other);
    fs.writeFileSync(path.join(other, 'other.md'), 'other\n');
    for (const s of [w.worker.store, home.store]) s.update((d) => { Object.assign(d.robots.c_1, { cwd: other, repo: { root: other, mainRoot: w.clone, branch: 'other', isWorktree: true } }); });
    const there = state(w, other);
    // a commit that stops once the record of the worktree it left is gone, and a retry
    at('move.commit.state', 'after', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', H)).rejects.toThrow('the disk is full');
    const id = home.store.state.robots.c_1.moving!.id;
    disarm?.();
    await home.placement.retry(id);

    const mac = path.join(w.main, '.claude/worktrees/other');
    expect(state(w, mac)).toEqual(there);
    expect(home.store.state.robots.c_1).toMatchObject({ cwd: mac, left: { moveId: id, machine: W, path: other, branch: 'other' } });
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(state(w, w.wt)).toEqual(left);
    expect(listed(w, w.clone, other)).toEqual({ locked: `moved to mac ${id}` });
  });

  it('a return refuses while git lists the worktree the robot left here and its folder is gone, which it leaves alone, and comes home into a new one once that is cleared', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    // the robot rewrites the commit it left with there, which this Mac's kanban still names
    w.g(w.farWt, 'commit', '-q', '--amend', '-m', 'kanban work, amended');
    const there = state(w, w.farWt);
    const away = `${w.wt}.away`;
    fs.renameSync(w.wt, away);
    const copy = state(w, away);
    const gone = { reason: `git on this Mac still lists ${w.wt}, whose folder is gone`, action: `git worktree repair <its new place> if you moved it, else git worktree unlock '${w.wt}' && git worktree remove '${w.wt}'` };

    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: gone });
    expect(state(w, away)).toEqual(copy);
    // repaired, the copy holds the branch; taken away, the robot comes home
    w.g(away, 'worktree', 'repair');
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: { reason: `kanban is checked out in ${away} on this Mac` } });
    w.g(w.main, 'worktree', 'unlock', away);
    w.g(w.main, 'worktree', 'remove', '--force', away);
    const id = await home.placement.start('c_1', H);

    expect(state(w, w.wt)).toEqual(there);
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1).toMatchObject({ cwd: w.wt, left: { moveId: id, machine: W, path: w.farWt } });
    expect(w.mac1.opened).toEqual(['c_1']);

    // one deleted after the checks passed stops the return at prepare, and the robot stays on the worker
    await home.placement.start('c_1', W);
    at('move.journal.prepare', 'after', () => { fs.rmSync(w.wt, { recursive: true, force: true }); });
    await expect(home.placement.start('c_1', H)).rejects.toThrow(`kanban is checked out in ${w.wt} on this Mac; check out another branch there first`);
    disarm?.();
    expect(home.store.state.robots.c_1.machine).toBe(W);
    expect(await home.placement.check('c_1', H)).toMatchObject({ ok: false, refusal: gone });
  });

  it('a return into a new worktree refuses, before anything rests, whatever would stop it there', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    const { name } = home.store.state.robots[b.id];
    const refusal = async () => {
      const r = await home.placement.check(b.id, H);
      return r.ok ? undefined : { reason: r.refusal.reason, action: r.refusal.action };
    };
    const onMain = { root: w.clone, mainRoot: w.clone, branch: 'main', isWorktree: false };
    for (const s of [w.worker.store, home.store]) s.update((d) => { Object.assign(d.robots[b.id], { cwd: w.clone, repo: onMain }); });
    expect(await refusal()).toEqual({ reason: `${name} works in app's main checkout on w1`, action: 'give it its own worktree on w1 first' });
    for (const s of [w.worker.store, home.store]) s.update((d) => { Object.assign(d.robots[b.id], { cwd: b.far, repo: { root: b.far, mainRoot: w.clone, branch: 'scout', isWorktree: true } }); });

    // no clone here, named by the worker's origin without its token; another repository, folder or origin there
    w.g(w.clone, 'remote', 'set-url', 'origin', 'https://ada:ghp_secret@github.com/ada/app.git');
    expect(await refusal()).toEqual({ reason: `${w.main} on this Mac is not a clone of app`, action: 'move it out of the way first' });
    fs.renameSync(w.main, `${w.main}.away`);
    expect(await refusal()).toEqual({ reason: 'app is not cloned on this Mac', action: `git clone 'https://github.com/ada/app.git' '${w.main}'` });
    w.g(w.clone, 'remote', 'set-url', 'origin', w.origin);
    fs.mkdirSync(w.main);
    expect(await refusal()).toEqual({ reason: `${w.main} on this Mac is not a clone of app`, action: 'move it out of the way first' });
    w.g(w.main, 'init', '-q');
    w.g(w.main, 'commit', '-q', '--allow-empty', '-m', 'another history');
    w.g(w.main, 'remote', 'add', 'origin', w.origin);
    expect(await refusal()).toEqual({ reason: `${w.main} on this Mac is not a clone of app`, action: 'move it out of the way first' });
    fs.rmSync(w.main, { recursive: true });
    fs.renameSync(`${w.main}.away`, w.main);
    // a shallow clone here, whose oldest commit is no root
    w.g(w.main, 'commit', '-q', '--allow-empty', '-m', 'more');
    fs.writeFileSync(path.join(w.main, '.git/shallow'), `${w.g(w.main, 'rev-parse', 'HEAD')}\n`);
    expect(await refusal()).toEqual({ reason: 'app is a shallow clone', action: `git -C '${w.main}' fetch --unshallow` });
    w.g(w.main, 'remote', 'set-url', 'origin', path.join(w.base, 'origins/other.git'));
    expect(await refusal()).toEqual({ reason: `${w.main} on this Mac is not a clone of app`, action: 'move it out of the way first' });
    w.g(w.main, 'remote', 'set-url', 'origin', w.origin);
    fs.rmSync(path.join(w.main, '.git/shallow'));
    w.g(w.main, 'reset', '-q', '--hard', 'HEAD~1');

    const inTheWay = { reason: `${b.mac} on this Mac is in the way`, action: 'move it out of the way first' };
    fs.mkdirSync(b.mac);
    expect(await refusal()).toEqual(inTheWay);
    fs.rmdirSync(b.mac);
    fs.symlinkSync(path.join(w.base, 'nowhere'), b.mac);
    expect(await refusal()).toEqual(inTheWay);
    fs.unlinkSync(b.mac);

    // a worktree git still lists at that place, or on that branch, locked or not, whose folder is gone
    const elsewhere = path.join(w.main, '.claude/worktrees/elsewhere');
    for (const [at, args, locked] of [[b.mac, ['--detach'], false], [elsewhere, ['-b', 'scout'], false], [b.mac, ['--detach'], true]] as const) {
      w.g(w.main, 'worktree', 'add', '-q', ...args, at);
      if (locked) w.g(w.main, 'worktree', 'lock', at);
      fs.rmSync(at, { recursive: true });
      const remove = `${locked ? `git worktree unlock '${at}' && ` : ''}git worktree remove '${at}'`;
      expect(await refusal()).toEqual({ reason: `git on this Mac still lists ${at}, whose folder is gone`, action: `git worktree repair <its new place> if you moved it, else ${remove}` });
      if (locked) w.g(w.main, 'worktree', 'unlock', at);
      w.g(w.main, 'worktree', 'remove', at);
    }
    w.g(w.main, 'branch', '-q', '-D', 'scout');

    // its branch checked out here, in the main checkout too, or rebased or bisected there; one this Mac holds ahead; one it
    // cannot keep beside it
    const held = { reason: `scout is checked out in ${w.main} on this Mac`, action: 'check out another branch there first' };
    w.g(w.main, 'checkout', '-q', '-b', 'scout');
    expect(await refusal()).toEqual(held);
    for (const n of ['1', '2', '3']) w.g(w.main, 'commit', '-q', '--allow-empty', '-m', n);
    expect(() => w.g(w.main, 'rebase', '-q', '-x', 'false', 'HEAD~2')).toThrow();
    expect(await refusal()).toEqual(held);
    w.g(w.main, 'rebase', '--abort');
    w.g(w.main, 'bisect', 'start', 'HEAD', 'HEAD~3');
    expect(await refusal()).toEqual(held);
    w.g(w.main, 'bisect', 'reset');
    w.g(w.main, 'checkout', '-q', 'main');
    w.g(w.main, 'branch', '-q', '-D', 'scout');
    w.g(w.main, 'update-ref', 'refs/heads/scout', w.g(w.main, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'on the Mac'));
    expect(await refusal()).toEqual({ reason: 'this Mac has a branch scout with commits this one lacks', action: 'merge or rename it there first' });
    w.g(w.main, 'branch', '-q', '-D', 'scout');
    for (const other of ['Scout', 'scout/old', 'SCOUT/old']) {
      w.g(w.main, 'branch', other);
      expect(await refusal()).toEqual({ reason: `this Mac has a branch ${other}, which it cannot keep beside scout`, action: 'rename one of them first' });
      w.g(w.main, 'branch', '-q', '-D', other);
    }

    expect(await refusal()).toBeUndefined();
    expect(w.vault.keys).toEqual([]);
    expect(w.worker.store.state.robots[b.id].tmux).toBeDefined();
  });

  it('a return whose branch this Mac\'s main checkout took after the checks leaves that checkout on it, and the robot on the worker', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    at('move.journal.prepare', 'after', () => { w.g(w.main, 'checkout', '-q', '-b', 'scout'); });

    await expect(home.placement.start(b.id, H)).rejects.toThrow(`scout is checked out in ${w.main} on this Mac; check out another branch there first`);

    expect(w.g(w.main, 'symbolic-ref', '--short', 'HEAD')).toBe('scout');
    expect(fs.existsSync(b.mac)).toBe(false);
    expect(home.store.state.robots[b.id].machine).toBe(W);
    await until(() => { expect(w.worker.store.state.robots[b.id]?.tmux).toBeDefined(); });
  });

  it('a return that finds a branch here after the checks that this Mac cannot keep beside the robot\'s refuses before it makes anything', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    at('move.journal.prepare', 'after', () => { w.g(w.main, 'branch', 'Scout'); });

    await expect(home.placement.start(b.id, H)).rejects.toMatchObject({ code: 'refused', message: 'this Mac has a branch Scout, which it cannot keep beside scout; rename one of them first' });

    expect(w.g(w.main, 'rev-parse', 'Scout')).toBe(w.g(w.main, 'rev-parse', 'main'));
    expect(fs.existsSync(b.mac)).toBe(false);
    expect(home.store.state.robots[b.id].machine).toBe(W);
  });

  it('a return whose prepare fails after its new worktree takes that worktree away here and puts its branch back, and the robot reopens on the worker', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    // this Mac's scout, which the worker's holds whole
    w.g(w.main, 'branch', 'scout');
    const sha = w.g(w.main, 'rev-parse', 'scout');
    at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start(b.id, H)).rejects.toThrow('the disk is full');

    expect(fs.existsSync(b.mac)).toBe(false);
    expect(listed(w, w.main, b.mac)).toBeUndefined();
    expect(w.g(w.main, 'rev-parse', 'scout')).toBe(sha);
    expect(home.store.state.robots[b.id]).toMatchObject({ machine: W });
    expect(home.store.state.robots[b.id].moving).toBeUndefined();
    await until(() => { expect(w.worker.store.state.robots[b.id]?.tmux).toBeDefined(); });
    expect(w.mac1.opened).toEqual([]);
    expect(listed(w, w.clone, b.far)).toEqual({});
  });

  it('two robots coming home into one clone here at once make their worktrees one after the other', async () => {
    const w = open();
    const home = await w.start();
    const [one, two] = [await bornThere(w, 'scout'), await bornThere(w, 'probe')];
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    const steps: string[] = [];
    let slow = true;
    d.git = async (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        steps.push(path.basename(args.at(-2)!));
        if (slow) { slow = false; await new Promise((resolve) => setTimeout(resolve, 500)); }
      }
      if (args[0] === 'checkout' && args.includes('-B')) steps.push(path.basename(cwd));
      return git(args, cwd);
    };

    await Promise.all([home.placement.start(one.id, H), home.placement.start(two.id, H)]);

    expect([steps[0], steps[2]].sort()).toEqual(['probe', 'scout']);
    expect(steps).toEqual([steps[0], steps[0], steps[2], steps[2]]);
    for (const b of [one, two]) expect(home.store.state.robots[b.id]).toMatchObject({ cwd: b.mac });
  });

  it('a return aborted while the worker was out of reach undoes what it made here once, and leaves what a later return made at that place', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    const call = home.links.call.bind(home.links);
    let silent = true;
    home.links.call = ((m, method, params, o) => {
      if (method === 'move.abort' && silent) { silent = false; return Promise.reject(new Error('w1 did not answer')); }
      return call(m, method, params, o);
    }) as typeof home.links.call;
    at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });
    const first = await home.placement.start(b.id, H).catch((e: { data: { moveId: string } }) => e.data.moveId);
    disarm?.();
    expect(fs.existsSync(b.mac)).toBe(false);
    expect(home.placement.status(first)).toMatchObject({ phase: 'prepare' });
    expect(home.placement.status(first).made).toBeUndefined();

    await home.placement.start(b.id, H);
    fs.writeFileSync(path.join(b.mac, 'mine.md'), 'mine\n');
    // recovered once the worker has taken this Mac's record of the later return, as a link that comes back has
    await until(() => { expect(w.worker.store.state.robots[b.id]?.machine).toBeUndefined(); });
    await home.placement.recoverMoves();

    expect(home.placement.status(first).phase).toBe('aborted');
    expect(fs.readFileSync(path.join(b.mac, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(w.g(b.mac, 'symbolic-ref', '--short', 'HEAD')).toBe('scout');
    expect(home.store.state.robots[b.id].machine).toBeUndefined();
  });

  it('a return abort whose undo fails part way journals what is left to undo, and undoes none of it once a later return has landed there', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    const call = home.links.call.bind(home.links);
    let silent = true;
    home.links.call = ((m, method, params, o) => {
      if (method === 'move.abort' && silent) { silent = false; return Promise.reject(new Error('w1 did not answer')); }
      return call(m, method, params, o);
    }) as typeof home.links.call;
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    let fail: string | undefined;
    d.git = async (args, cwd) => {
      if (fail && args.join(' ').startsWith(fail)) { fail = undefined; return { code: 1, stdout: '', stderr: 'fatal: busy' }; }
      return git(args, cwd);
    };
    const abort = async (step: string): Promise<string> => {
      fail = step;
      at('move.journal.commit', 'before', () => { throw new Error('the disk is full'); });
      const id = await home.placement.start(b.id, H).catch((e: { data: { moveId: string } }) => e.data.moveId);
      disarm?.();
      return id;
    };

    // the branch is let go of after the worktree, which the journal no longer names
    const one = await abort('branch -q -D scout');
    expect(home.placement.status(one).made).toEqual({ branch: null });
    expect(fs.existsSync(b.mac)).toBe(false);
    w.g(w.main, 'branch', '-q', '-D', 'scout');

    // the worktree stays and the journal names both; taken away by hand, a later return lands there
    silent = true;
    const two = await abort('worktree remove --force');
    expect(home.placement.status(two).made).toEqual({ worktree: true, branch: null });
    w.g(w.main, 'worktree', 'remove', '--force', b.mac);
    await home.placement.start(b.id, H);
    fs.writeFileSync(path.join(b.mac, 'mine.md'), 'mine\n');
    await until(() => { expect(w.worker.store.state.robots[b.id]?.machine).toBeUndefined(); });
    await home.placement.recoverMoves();

    expect([home.placement.status(one).phase, home.placement.status(two).phase]).toEqual(['aborted', 'aborted']);
    expect(fs.readFileSync(path.join(b.mac, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(w.g(b.mac, 'symbolic-ref', '--short', 'HEAD')).toBe('scout');
  });

  it('a main checkout a move converts and a robot coming home into that clone make their worktrees one after the other', async () => {
    const w = open();
    const home = await w.start();
    const b = await bornThere(w, 'scout');
    home.store.update((d) => { Object.assign(d.robots.c_1, { cwd: w.main, repo: { root: w.main, mainRoot: w.main, branch: 'main', isWorktree: false } }); });
    const d = home.placement['d'] as { git: GitRunner };
    const git = d.git;
    const steps: string[] = [];
    d.git = async (args, cwd) => {
      if (args[0] !== 'worktree' || args[1] !== 'add') return git(args, cwd);
      const who = args.includes('--detach') ? 'return' : 'convert';
      steps.push(`${who} starts`);
      if (who === 'convert') await new Promise((resolve) => setTimeout(resolve, 1500));
      const r = await git(args, cwd);
      steps.push(`${who} ends`);
      return r;
    };

    await Promise.all([home.placement.start('c_1', W), new Promise((resolve) => setTimeout(resolve, 200)).then(() => home.placement.start(b.id, H))]);

    expect(steps).toEqual(['convert starts', 'convert ends', 'return starts', 'return ends']);
  });

  it('a main checkout a move converts fails the move when a folder is at its new worktree\'s place after the checks, and the robot stays in main', async () => {
    const w = open();
    const home = await w.start();
    const onMain = { root: w.main, mainRoot: w.main, branch: 'main', isWorktree: false };
    home.store.update((d) => { Object.assign(d.robots.c_1, { cwd: w.main, repo: onMain }); });
    const r = await home.placement.check('c_1', W);
    const root = path.join(w.main, '.claude/worktrees', r.ok ? r.plan.convert!.slug : '');
    at('move.journal.bundle', 'after', () => { w.g(w.main, 'worktree', 'add', '-q', '-b', 'scout', root); });

    await expect(home.placement.start('c_1', W)).rejects.toThrow(`${root} on this Mac is in the way; move it out of the way first`);

    expect(home.store.state.robots.c_1).toMatchObject({ cwd: w.main, repo: onMain });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
    expect(w.g(root, 'symbolic-ref', '--short', 'HEAD')).toBe('scout');
  });

  it('a robot that went on in a worktree of another repository on the worker comes home into it, and the worktree it left here is unlocked', async () => {
    const w = open();
    const home = await w.start();
    await home.placement.start('c_1', W);
    const { mac, farWt } = libThere(w);

    await home.placement.start('c_1', H);

    expect(home.store.state.robots.c_1).toMatchObject({ cwd: path.join(mac, '.claude/worktrees/tidy'), left: { machine: W, path: farWt } });
    expect(listed(w, w.main, w.wt)).toEqual({});
  });

  it('a worktree the robot left here whose folder is gone stays locked when the robot comes home into another, so a prune keeps a copy moved away', async () => {
    const w = open();
    const home = await w.start();
    const id = await home.placement.start('c_1', W);
    const away = `${w.wt}.away`;
    fs.renameSync(w.wt, away);
    const before = state(w, away);
    libThere(w);

    await home.placement.start('c_1', H);

    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    w.g(w.main, 'worktree', 'prune');
    expect(state(w, away)).toEqual(before);
  });
});
