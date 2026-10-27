import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetState, INTERRUPT_ACTIONS, moveSummary } from '@svall/protocol';
import { RESUME_NOTE } from '../../src/dormancy.js';
import { armFailpoints, type Edge, type Failpoint } from '../../src/failpoints.js';
import { hooklessGit } from '../../src/links/git.js';
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

// fires `then` at a step's edge, once
// Claude's question to trust its folder, as the robot's pane on the worker shows it
const TRUST_DIALOG = [' Quick safety check: Is this a project you created or one you trust?', '', ' ❯ 1. No, exit', '   2. Yes, I trust this folder'];

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

    await expect(home.placement.start('c_1', W)).rejects.toThrow('the disk is full');

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
