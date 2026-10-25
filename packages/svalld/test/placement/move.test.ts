import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RESUME_NOTE } from '../../src/dormancy.js';
import { armFailpoints, type Edge, type Failpoint } from '../../src/handover/failpoints.js';
import { realPath } from '../../src/handover/portable-path.js';
import { handoverGit } from '../../src/links/git.js';
import { fingerprintOf } from '../../src/placement/bundle.js';
import { Store } from '../../src/store.js';
import { hasGit } from '../handover/git-fixture.js';
import { cleanHomes } from '../helpers.js';
import { Crash, SID, moveWorld, until, type MoveWorld } from './move-world.js';
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

// what `git worktree list` says of the worktree at `root`, or undefined when git lists none there
function listed(w: MoveWorld, repo: string, root: string): { locked?: string } | undefined {
  const entries = w.g(repo, 'worktree', 'list', '--porcelain').split('\n\n');
  const entry = entries.find((e) => e.split('\n')[0] === `worktree ${realPath(root)}`);
  if (!entry) return undefined;
  const locked = entry.split('\n').find((l) => l.startsWith('locked'));
  return locked === undefined ? {} : { locked: locked.slice('locked'.length).trim() };
}

const state = (w: MoveWorld, root: string) => ({
  head: w.g(root, 'rev-parse', 'HEAD'), branch: w.g(root, 'symbolic-ref', '--short', 'HEAD'),
  staged: w.g(root, 'diff', '--cached', '--name-status'), unstaged: w.g(root, 'diff', '--name-status'),
  // a credential file travels only when ticked
  untracked: w.g(root, 'ls-files', '--others', '--exclude-standard').split('\n').filter((f) => f && f !== '.env').sort(),
});

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
    const fingerprint = await fingerprintOf(w.wt, handoverGit);
    // a terminal, a second one, a revive, a prompt and a close, asked for while the robot is on its way
    const refused: unknown[] = [];
    let closed: Promise<unknown> | undefined;
    at('worker.prepare.worktree', 'before', () => {
      const asks = [() => home.fleet.live('c_1'), () => home.fleet.openSecond('c_1'), () => home.fleet.reviveRobot('c_1'), () => home.fleet.run('c_1', 'go on', true)];
      for (const ask of asks) {
        try { ask(); } catch (e) { refused.push(e); }
      }
      closed = home.fleet.closeRobot('c_1').catch((e: unknown) => e);
    });

    const id = await home.placement.start('c_1', W);

    expect(refused).toHaveLength(4);
    for (const e of [...refused, await closed]) expect(e).toMatchObject({ code: 'moving', message: 'moving to w1' });
    expect(home.store.state.robots.c_1).toBeDefined();
    // the worker: the branch with its commit, staged against unstaged, the untracked file, no .env, the session
    expect(state(w, w.farWt)).toEqual(before);
    expect(fs.existsSync(path.join(w.farWt, '.env'))).toBe(false);
    expect(await fingerprintOf(w.farWt, handoverGit)).toBe(fingerprint);
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
    expect(await fingerprintOf(w.wt, handoverGit)).toBe(fingerprint);
    expect(fs.readFileSync(path.join(w.wt, '.env'), 'utf8')).toBe('TOKEN=secret\n');
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    const here = home.store.state.robots.c_1;
    expect(here.machine).toBe(W);
    expect(here.moving).toBeUndefined();
    expect(here.left).toEqual({ moveId: id, machine: H, path: w.wt, branch: 'kanban', branchSha: before.head, fingerprint });
    expect(w.mac1.opened).toEqual([]);
    expect(home.placement.status(id).phase).toBe('done');
  });

  it('a failure in prepare reopens the robot at home with its window and the worker has nothing left', async () => {
    const w = open();
    const home = await w.start();
    const fingerprint = await fingerprintOf(w.wt, handoverGit);
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });

    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');

    const here = home.store.state.robots.c_1;
    expect(here.machine).toBeUndefined();
    expect(here.moving).toBeUndefined();
    expect(here.tmux).toBeDefined();
    expect(w.mac1.opened).toEqual(['c_1']);
    expect(w.mac1.lines.at(-1)?.text).toMatch(new RegExp(`^claude --resume ${SID}`));
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(await fingerprintOf(w.wt, handoverGit)).toBe(fingerprint);
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

    expect(Store.readSnapshot(w.homePaths.state).robots.c_1).toMatchObject({ machine: W, placement: { generation: 1 }, moving: { id, phase: 'commit' } });
    const again = await w.bootHome();
    await again.placement.recoverMoves();

    expect(again.placement.status(id).phase).toBe('done');
    expect(w.vault.opened).toEqual(['c_1']);
    expect(w.mac1.opened).toEqual([]);
    expect(again.store.state.robots.c_1.moving).toBeUndefined();
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
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
    const fingerprint = await fingerprintOf(w.farWt, handoverGit);

    const back = await home.placement.start('c_1', H);

    expect(state(w, w.wt)).toEqual(there);
    expect(await fingerprintOf(w.wt, handoverGit)).toBe(fingerprint);
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

  it('two prepares into one clone serialize under repoLock', async () => {
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
    const line = w.vault.lines.find((l) => l.text.startsWith('claude --resume'))!.text;
    const promptFile = /cat '([^']+)'/.exec(line)![1];
    expect(fs.readFileSync(promptFile, 'utf8')).toContain(RESUME_NOTE);
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
    const fingerprint = await fingerprintOf(w.wt, handoverGit);
    // a prepare that fails there leaves that worktree as the robot left it, locked again, for the next move to take
    at('worker.prepare.journal', 'before', () => { throw new Error('the disk is full'); });
    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');
    disarm?.();
    expect(listed(w, w.clone, w.farWt)?.locked).toMatch(/^moved to mac mv_/);
    expect(w.g(w.farWt, 'rev-parse', 'HEAD')).toBe(head);

    const id = await home.placement.start('c_1', W);

    expect(state(w, w.farWt)).toEqual(now);
    expect(await fingerprintOf(w.farWt, handoverGit)).toBe(fingerprint);
    expect(listed(w, w.clone, w.farWt)).toEqual({});
    expect(listed(w, w.main, w.wt)).toEqual({ locked: `moved to w1 ${id}` });
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W, left: { moveId: id, machine: H, path: w.wt, branchSha: now.head } });
    expect(home.placement.status(id).phase).toBe('done');
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);
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

    await expect(home.placement.start('c_1', H)).rejects.toMatchObject({ code: 'refused', message: `changes on this Mac in ${w.wt} since the move; stash or commit them` });

    expect(fs.readFileSync(a, 'utf8')).toBe(`${held}edited on the Mac\n`);
    expect(fs.readFileSync(path.join(w.wt, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(listed(w, w.main, w.wt)).toEqual({});
    expect(home.store.state.robots.c_1).toMatchObject({ machine: W });
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);

    // one whose Mac worktree is gone by then unwinds the same way
    fs.writeFileSync(a, held);
    fs.rmSync(path.join(w.wt, 'mine.md'));
    at('move.journal.prepare', 'after', () => { fs.renameSync(w.wt, `${w.wt}.away`); });
    await expect(home.placement.start('c_1', H)).rejects.toThrow();
    fs.renameSync(`${w.wt}.away`, w.wt);
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    expect(w.vault.opened).toEqual(['c_1', 'c_1', 'c_1']);
    expect(w.mac1.opened).toEqual([]);
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

  it('a move sends the worker the home\'s agent configuration before its bundle, and goes on when that fails', async () => {
    let pushes = 0;
    const w = open({ mirror: { push: async () => { pushes++; throw new Error('no space left on device'); } } });
    const home = await w.start();
    await until(() => { expect(pushes).toBe(1); });
    let atBundle = 0;
    at('move.bundle', 'before', () => { atBundle = pushes; });
    await home.placement.start('c_1', W);
    expect(atBundle).toBe(2);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
  });
});

// the home's side of a move out, each step a crash can fall on
const HOME_STEPS: Failpoint[] = [
  'move.journal.rest', 'move.rest', 'move.journal.bundle', 'move.bundle', 'move.journal.prepare', 'move.journal.commit', 'move.commit.state',
  'move.journal.activate', 'move.journal.release', 'move.release.lock', 'move.journal.done',
];

describe.skipIf(!hasGit)('a crash of the home during a move', () => {
  for (const name of HOME_STEPS) {
    for (const edge of ['before', 'after'] as const) {
      it(`at ${name}:${edge} ends with the move done or aborted and the robot on exactly one machine`, async () => {
        const w = open();
        const first = await w.start();
        at(name, edge, () => { first.life.dead = true; throw new Crash(name); });
        await expect(first.placement.start('c_1', W)).rejects.toThrow();
        first.links.stop();
        const opened = w.mac1.opened.length;

        const again = await w.bootHome();
        await again.placement.recoverMoves();

        const ids = (fs.existsSync(w.homePaths.moves) ? fs.readdirSync(w.homePaths.moves) : []).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
        const phase = ids.length ? again.placement.status(ids[0]).phase : 'never journaled';
        const here = again.store.state.robots.c_1;
        expect(here.moving).toBeUndefined();
        if (phase === 'done') {
          expect(here.machine).toBe(W);
          expect(w.mac1.opened.length).toBe(opened);
          expect([...w.mac1.windows.values()].some((x) => x.name === 'c_1')).toBe(false);
          expect(listed(w, w.main, w.wt)?.locked).toBe(`moved to w1 ${ids[0]}`);
          await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
          expect(w.vault.opened).toEqual(['c_1']);
        } else {
          expect(['aborted', 'never journaled']).toContain(phase);
          expect(here.machine).toBeUndefined();
          expect(here.tmux).toBeDefined();
          expect([...w.mac1.windows.values()].filter((x) => x.name === 'c_1')).toHaveLength(1);
          expect(listed(w, w.main, w.wt)).toEqual({});
          expect(fs.existsSync(w.farWt)).toBe(false);
          expect(w.vault.opened).toEqual([]);
          await until(() => { expect(w.worker.store.state.robots.c_1?.machine).toBeUndefined(); });
        }
      });
    }
  }

  it('a worker linked again after a crash at move.journal.activate starts the robot only once it holds the commit\'s snapshot', async () => {
    const w = open();
    const first = await w.start();
    at('move.journal.activate', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });
    await expect(first.placement.start('c_1', W)).rejects.toThrow(Crash);
    first.links.stop();
    const [file] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    const id = file.slice(0, -'.json'.length);
    // what the worker holds of the robot is its own prepare's, marked so
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, placement: { generation: 1 }, moving: { id, phase: 'prepare' } });
    let held: unknown;
    at('worker.activate.open', 'before', () => { held = structuredClone(w.worker.store.state.robots.c_1.moving); });

    // the link answers at once and syncs late: the move runs on as it answers, and waits for the sync
    const again = await w.bootHome(undefined, { syncAfterMs: 1500 });

    await until(() => { expect(again.placement.status(id).phase).toBe('done'); });
    expect(held).toEqual({ id, to: W, phase: 'activate' });
    expect(w.vault.opened).toEqual(['c_1']);
  });

  it('a return cut short before its commit leaves the robot on the worker and the Mac worktree locked, and the next return goes through', async () => {
    const w = open();
    const first = await w.start();
    await first.placement.start('c_1', W);
    w.g(w.farWt, 'commit', '-qm', 'staged work');
    fs.appendFileSync(path.join(w.farWt, 'b.txt'), 'more\n');
    at('move.journal.commit', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });
    await expect(first.placement.start('c_1', H)).rejects.toThrow(Crash);
    first.links.stop();
    disarm?.();

    const again = await w.bootHome();
    await again.placement.recoverMoves();
    const here = again.store.state.robots.c_1;
    expect(here).toMatchObject({ machine: W });
    expect(here.moving).toBeUndefined();
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);

    const there = state(w, w.farWt);
    await again.placement.start('c_1', H);
    expect(state(w, w.wt)).toEqual(there);
    expect(again.store.state.robots.c_1.machine).toBeUndefined();
  });
});
