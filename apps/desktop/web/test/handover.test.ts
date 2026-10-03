import { describe, expect, it } from 'vitest';
import type { Blocker, HandoverPhase } from '@svall/protocol';
import {
  actionsOf, applyEvent, blockerHint, choiceFor, chosen, endFollow, entityLabel, followRun, formatBytes, headline, holdsTerminals, isCommitted, needsUser,
  rowText, sectionStates, withChoice, type HandoverEvent, type HandoverRun,
} from '../src/handover.js';

const tx = 'tx-1';
const summary = { digest: 'a'.repeat(64), roots: 2, files: 120, bytes: 42_000_000, sessions: 1 };
const changed = (phase: HandoverPhase): HandoverEvent => ({ event: 'handover.changed', data: { transactionId: tx, phase } });
const entity = (data: Partial<Extract<HandoverEvent, { event: 'handover.entity' }>['data']> & { kind: 'character' | 'root' | 'session' | 'git'; id: string }): HandoverEvent =>
  ({ event: 'handover.entity', data: { transactionId: tx, phase: 'freeze', ...data } });
const play = (events: HandoverEvent[], run: HandoverRun = followRun('studio')) => events.reduce(applyEvent, run);

const through = (phase: 'freeze' | 'transfer' | 'verify' | 'commit' | 'activate') => {
  const order = ['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate'] as const;
  return order.slice(0, order.indexOf(phase) + 1).map((p) => changed(p));
};

describe('the handover a sheet follows', () => {
  it('keeps one row per character, root and session, in the section it belongs to, whatever order its updates come in', () => {
    const run = play([
      { event: 'handover.preflight', data: { summary, blockers: [], warnings: [] } },
      ...through('freeze'),
      entity({ kind: 'character', id: 'c1' }),
      entity({ kind: 'character', id: 'c2' }),
      entity({ kind: 'character', id: 'c1', done: 1, total: 1 }),
      changed('transfer'),
      entity({ kind: 'root', id: 'r_a', phase: 'transfer', bytes: 0, totalBytes: 40_000_000 }),
      entity({ kind: 'session', id: 's0', phase: 'transfer', bytes: 100, totalBytes: 1500 }),
      entity({ kind: 'root', id: 'r_a', phase: 'transfer', bytes: 12_000_000, totalBytes: 40_000_000 }),
      entity({ kind: 'session', id: 's0', phase: 'verify', bytes: 1500, totalBytes: 1500 }),
    ]);
    expect(run.rows.map((r) => [r.section, r.kind, r.id])).toEqual([
      ['rest', 'character', 'c1'], ['rest', 'character', 'c2'], ['transfer', 'root', 'r_a'], ['transfer', 'session', 's0'],
    ]);
    expect(run.rows[0]).toMatchObject({ done: 1, total: 1 });
    expect(run.rows[2]).toMatchObject({ bytes: 12_000_000, totalBytes: 40_000_000 });
    // a session is one row, all its files together
    expect(run.rows[3]).toMatchObject({ bytes: 1500, totalBytes: 1500 });
    expect(run.preflight?.summary.roots).toBe(2);
  });

  it('names each character, root and session by what preflight said of them, and a blocker by the same', () => {
    const names = { characters: { c1: 'ada' }, roots: { r_a: '/home/ada/app' }, sessions: { s0: 'ada' } };
    const run = play([{ event: 'handover.preflight', data: { summary, blockers: [], warnings: [], names } }]);
    const name = (id: string) => run.preflight?.names?.characters[id] ?? id;
    expect(entityLabel({ kind: 'character', id: 'c1' }, name, run.preflight?.names)).toBe('ada');
    expect(entityLabel({ kind: 'root', id: 'r_a' }, name, run.preflight?.names)).toBe('/home/ada/app');
    expect(entityLabel({ kind: 'session', id: 's0' }, name, run.preflight?.names)).toBe("ada's session");
    // without what preflight said, the id is what there is
    expect(entityLabel({ kind: 'root', id: 'r_b' }, name, run.preflight?.names)).toBe('folder r_b');
  });

  it('puts a character the destination brought up under Resuming, apart from its rest row', () => {
    const run = play([
      ...through('freeze'), entity({ kind: 'character', id: 'c1', done: 1, total: 1 }),
      ...through('activate').slice(2),
      entity({ kind: 'character', id: 'c1', phase: 'activate' }),
      entity({ kind: 'character', id: 'c2', phase: 'activate', error: 'claude --resume exited 1' }),
      entity({ kind: 'character', id: 'c3', phase: 'activate', notice: 'codex waits at its "Trust this folder?" prompt in cy\'s terminal; answer it there' }),
    ]);
    expect(run.rows.map((r) => [r.section, r.id])).toEqual([['rest', 'c1'], ['resume', 'c1'], ['resume', 'c2'], ['resume', 'c3']]);
    expect(rowText(run.rows[1])).toBe('resumed');
    expect(rowText(run.rows[2])).toBe('claude --resume exited 1');
    // one that came up and waits on something in its terminal says what
    expect(rowText(run.rows[3])).toBe('resumed; codex waits at its "Trust this folder?" prompt in cy\'s terminal; answer it there');
  });

  it('keeps a decision until the controller goes on, whatever a daemon relays after it', () => {
    const asked: HandoverEvent = { event: 'handover.blocked', data: { transactionId: tx, phase: 'freeze', blockers: [{ code: 'agent_working', message: 'still working' }] } };
    expect(play([...through('freeze'), asked]).decision?.phase).toBe('freeze');
    // a rest row the source sent before it refused can reach the stream after the decision it led to
    expect(play([...through('freeze'), asked, entity({ kind: 'character', id: 'c1', error: 'still working' })]).decision?.phase).toBe('freeze');
    expect(play([...through('freeze'), asked, changed('transfer')]).decision).toBeUndefined();
    expect(play([...through('freeze'), asked, { event: 'handover.result', data: { status: 'aborted', transactionId: tx, phase: 'freeze' } }]).decision).toBeUndefined();
  });

  it('never moves back a phase when a daemon relays an earlier step late', () => {
    const run = play([...through('verify'), changed('freeze')]);
    expect(run.phase).toBe('verify');
  });

  it('says how far each of the five sections has come', () => {
    const states = (run: HandoverRun) => sectionStates(run).map((s) => `${s.label}: ${s.state}`);
    expect(states(play(through('transfer')))).toEqual([
      'Checks: done', 'Resting characters: done', 'Transferring files and sessions: active', 'Verifying and committing: pending', 'Resuming characters: pending',
    ]);
    const blocked = play([...through('freeze'), { event: 'handover.blocked', data: { transactionId: tx, phase: 'freeze', blockers: [] } }]);
    expect(sectionStates(blocked)[1].state).toBe('waiting');
    const stopped = play([...through('transfer'), { event: 'handover.result', data: { status: 'interrupted', transactionId: tx, phase: 'transfer', error: 'ssh closed', safe: ['resume', 'abort'] } }]);
    expect(sectionStates(stopped)[2].state).toBe('stopped');
    const done = play([...through('activate'), { event: 'handover.result', data: { status: 'complete', transactionId: tx, generation: 4, characters: [] } }]);
    expect(sectionStates(done).every((s) => s.state === 'done')).toBe(true);
  });

  it('keeps where an archived root\'s earlier content went on its row, whatever its copy says since', () => {
    const entity = (over: object): HandoverEvent => ({ event: 'handover.entity', data: { transactionId: tx, kind: 'root', id: 'r_a', phase: 'transfer', archivedTo: '/home/ada/a.archived-1', ...over } });
    const run = play([...through('transfer'), entity({}), entity({ bytes: 12_000_000, totalBytes: 40_000_000 })]);
    const row = run.rows.find((r) => r.id === 'r_a')!;
    expect(row.error).toBeUndefined();
    expect(rowText(row)).toBe('12.0 MB of 40.0 MB; what was there is kept at /home/ada/a.archived-1');
  });

  it('shows progress in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(12_000_000)).toBe('12.0 MB');
    expect(formatBytes(2_100_000_000)).toBe('2.1 GB');
    expect(rowText({ section: 'transfer', kind: 'root', id: 'r_a', phase: 'transfer', bytes: 12_000_000, totalBytes: 40_000_000 })).toBe('12.0 MB of 40.0 MB');
  });
});

describe('what the sheet offers', () => {
  const result = (data: Extract<HandoverEvent, { event: 'handover.result' }>['data']): HandoverEvent => ({ event: 'handover.result', data });

  it('offers Abort before the commit, and nothing that goes back once the commit is under way', () => {
    expect(actionsOf(play(through('transfer'))).cancel).toBe(true);
    expect(isCommitted(play(through('transfer')))).toBe(false);
    const committing = play(through('commit'));
    expect(actionsOf(committing).cancel).toBe(false);
    const activating = play(through('activate'));
    expect(isCommitted(activating)).toBe(true);
    expect(actionsOf(activating)).toMatchObject({ cancel: false, abort: false });
  });

  it('offers Resume and Abort for a handover stopped before the commit, and only Retry after it', () => {
    const before = endFollow(play([...through('transfer'), result({ status: 'interrupted', transactionId: tx, phase: 'transfer', error: 'ssh closed', safe: ['resume', 'abort'] })]), 0);
    expect(actionsOf(before)).toMatchObject({ resume: 'Resume', abort: true, cancel: false });
    const after = endFollow(play([...through('activate'), result({ status: 'interrupted', transactionId: tx, phase: 'activate', error: 'studio did not answer', safe: ['resume'] })]), 0);
    expect(actionsOf(after)).toMatchObject({ resume: 'Retry', abort: false, cancel: false });
  });

  it('rebuilds what may follow from the status a relaunch reads back', () => {
    const status = (standing: 'open' | 'committed' | 'moved', safe: ('resume' | 'abort')[], phase: 'transfer' | 'activate') =>
      endFollow(play([{ event: 'handover.status', data: { standing, journals: {}, action: 'none', transactionId: tx, phase, safe, reason: `${standing} at ${phase}` } }], followRun()), 0);
    expect(actionsOf(status('open', ['resume', 'abort'], 'transfer'))).toMatchObject({ resume: 'Resume', abort: true });
    expect(actionsOf(status('committed', ['resume'], 'activate'))).toMatchObject({ resume: 'Retry', abort: false });
    expect(actionsOf(status('moved', [], 'activate'))).toMatchObject({ resume: undefined, abort: false, start: true });
  });

  it('offers Forget for a journal the gateway has moved on from, and asks the user only about what can be decided', () => {
    const status = (standing: 'superseded' | 'open' | 'unknown', safe: ('resume' | 'abort')[]) =>
      endFollow(play([{ event: 'handover.status', data: { standing, journals: {}, action: 'none', safe, reason: standing } }], followRun()), 0);
    expect(actionsOf(status('superseded', []))).toMatchObject({ forget: true, resume: undefined, abort: false });
    expect(actionsOf(status('open', ['resume', 'abort'])).forget).toBe(false);
    expect(needsUser(status('superseded', []).status!)).toBe(true);
    expect(needsUser(status('open', ['resume']).status!)).toBe(true);
    expect(needsUser(status('open', []).status!)).toBe(false);
    expect(needsUser(status('unknown', []).status!)).toBe(false);
  });

  it('counts a stopped run as committed only once it can only go on, and says so when whether it committed is unknown', () => {
    const stopped = (phase: HandoverPhase, safe: ('resume' | 'abort')[]) =>
      endFollow(play([...through('commit'), result({ status: 'interrupted', transactionId: tx, phase, error: 'the gateway did not answer', safe })]), 0);
    const unknown = stopped('commit', []);
    expect(isCommitted(unknown)).toBe(false);
    expect(headline(unknown, 'studio')).toMatch(/^Whether the fleet moved to studio is not known yet: the gateway did not answer\. Check again/);
    expect(actionsOf(unknown)).toMatchObject({ follow: true, resume: undefined, abort: false });
    expect(isCommitted(stopped('commit', ['resume']))).toBe(true);
    expect(isCommitted(stopped('activate', []))).toBe(true);
    expect(isCommitted(stopped('commit', ['resume', 'abort']))).toBe(false);
  });

  it('says why what is left to finish is left once the fleet has moved', () => {
    const moved = play([...through('activate'), result({ status: 'complete', transactionId: tx, generation: 4, characters: [], pending: ['source'], error: "mac: the Mac's daemon is restarting" })]);
    expect(headline(moved, 'studio')).toContain("source has not heard that it finished (mac: the Mac's daemon is restarting); Retry tells it.");
  });

  it('asks for a new start with the choices made when preflight blocked', () => {
    const blocked = endFollow(play([result({ status: 'blocked', phase: 'begin', blockers: [{ code: 'shell_busy', message: "bo's terminal is running npm test", entity: { kind: 'character', id: 'c2' } }] })]), 1);
    expect(actionsOf(blocked)).toMatchObject({ tryAgain: true, cancel: false });
  });

  it('never speaks of going back once the fleet has moved', () => {
    const rollback = /abort|roll ?back|undo|revert|cancel/i;
    const moved = play([...through('activate'), result({ status: 'complete', transactionId: tx, generation: 4, characters: [{ id: 'c1', ok: true }, { id: 'c2', ok: false, error: 'exited 1' }], pending: ['source'] })]);
    expect(headline(moved, 'studio')).toMatch(/runs on studio/);
    expect(headline(moved, 'studio')).not.toMatch(rollback);
    const stuck = play([...through('activate'), result({ status: 'interrupted', transactionId: tx, phase: 'activate', error: 'studio did not answer', safe: ['resume'] })]);
    expect(headline(stuck, 'studio')).not.toMatch(rollback);
    expect(headline(play([...through('activate'), result({ status: 'detached', transactionId: tx })]), 'studio')).not.toMatch(rollback);
  });
});

describe('the terminals while the fleet moves', () => {
  it('holds them from the freeze until the fleet runs again somewhere', () => {
    expect(holdsTerminals(play([changed('begin')]))).toBe(false);
    expect(holdsTerminals(play(through('freeze')))).toBe(true);
    // a freeze that could not rest gave the fleet back while it waits for the user
    expect(holdsTerminals(play([...through('freeze'), { event: 'handover.blocked', data: { transactionId: tx, phase: 'freeze', blockers: [] } }]))).toBe(false);
    expect(holdsTerminals(play([...through('transfer'), { event: 'handover.result', data: { status: 'aborted', transactionId: tx, phase: 'transfer' } }]))).toBe(false);
    const moved = play([...through('activate'), { event: 'handover.result', data: { status: 'complete', transactionId: tx, generation: 4, characters: [] } }]);
    expect(moved.awaitingOwner).toBe(true);
    expect(holdsTerminals(moved)).toBe(true);
    expect(holdsTerminals({ ...moved, awaitingOwner: false })).toBe(false);
  });

  it('reads the hold back from the status a relaunch finds', () => {
    const status = (standing: 'open' | 'moved', phase: 'begin' | 'transfer') =>
      play([{ event: 'handover.status', data: { standing, journals: {}, action: 'none', phase, safe: [], reason: '' } }], followRun());
    expect(holdsTerminals(status('open', 'transfer'))).toBe(true);
    expect(holdsTerminals(status('open', 'begin'))).toBe(false);
    expect(holdsTerminals(status('moved', 'transfer'))).toBe(false);
    // the events file ends with the run's result, then the status: a finished move holds nothing
    const replay = play([...through('activate'), { event: 'handover.result', data: { status: 'complete', transactionId: tx, generation: 4, characters: [] } },
      { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } }], followRun());
    expect(holdsTerminals(replay)).toBe(false);
  });
});

describe('the choices a blocker takes', () => {
  const b = (code: Blocker['code'], entity?: Blocker['entity']): Blocker => ({ code, message: 'm', ...(entity && { entity }) });

  it('interrupts agents, terminates what runs in a terminal, and archives a destination root', () => {
    expect(choiceFor(b('agent_working'))).toBe('interrupt');
    expect(choiceFor(b('agent_blocked'))).toBe('interrupt');
    expect(choiceFor(b('shell_busy'))).toBe('terminate');
    expect(choiceFor(b('agent_unsettled'))).toBe('terminate');
    expect(choiceFor(b('destination_diverged', { kind: 'root', id: 'r_a' }))).toBe('archive');
    expect(choiceFor(b('destination_occupied', { kind: 'root', id: 'r_a' }))).toBe('archive');
    expect(choiceFor(b('character_pinned'))).toBeUndefined();
    const working = b('agent_working', { kind: 'character', id: 'c3' });
    const unsettled = b('agent_unsettled', { kind: 'character', id: 'c1' });
    const busy = b('shell_busy', { kind: 'character', id: 'c2' });
    const occupied = b('destination_occupied', { kind: 'root', id: 'r_a' });
    const shown = [working, unsettled, busy, occupied];
    let choices = withChoice({}, working, shown);
    choices = withChoice(choices, busy, shown);
    // terminating names every terminal the blockers name, as the CLI answers
    expect(chosen(choices, unsettled)).toBe(true);
    choices = withChoice(choices, occupied, shown);
    expect(choices).toEqual({ interruptAfterMs: 0, terminateShells: ['c1', 'c2'], archiveRoots: ['r_a'] });
    choices = withChoice(choices, occupied, shown);
    expect(choices).toEqual({ interruptAfterMs: 0, terminateShells: ['c1', 'c2'] });
    choices = withChoice(choices, unsettled, shown);
    expect(choices).toEqual({ interruptAfterMs: 0 });
  });

  it('adds the terminals named here to those chosen before, and holds a choice of every terminal as one', () => {
    const busy = b('shell_busy', { kind: 'character', id: 'c2' });
    expect(chosen({ terminateShells: ['c9'] }, busy)).toBe(false);
    expect(withChoice({ terminateShells: ['c9'] }, busy, [busy])).toEqual({ terminateShells: ['c9', 'c2'] });
    expect(withChoice({ terminateShells: ['c9', 'c2'] }, busy, [busy])).toEqual({ terminateShells: ['c9'] });
    // `--terminate-shells` chose every terminal
    expect(chosen({ terminateShells: true }, busy)).toBe(true);
    expect(withChoice({ terminateShells: true }, busy, [busy])).toEqual({});
  });

  it('starts from the choices the run holds, in a sheet opened after the start that made them', () => {
    const held = { terminateShells: true, archiveRoots: ['r_a'] };
    const working = b('agent_working', { kind: 'character', id: 'c1' });
    // a relaunched sheet follows a resume with nothing chosen yet
    const run = play([...through('freeze'), { event: 'handover.blocked', data: { transactionId: tx, phase: 'freeze', blockers: [working], choices: held } }], followRun());
    expect(run.choices).toEqual(held);
    expect(withChoice(run.choices, working, [working])).toEqual({ ...held, interruptAfterMs: 0 });
  });
});

describe('what each blocker and warning is explained with', () => {
  const ctx = { destination: 'studio', source: 'This Mac', pull: false, name: (id: string) => ({ c1: 'Ada' }[id] ?? id) };

  it('explains what terminating a terminal that will not settle does, hooks included', () => {
    const hint = blockerHint({ code: 'agent_unsettled', message: "Ada's terminal did not come to rest after it was interrupted", entity: { kind: 'character', id: 'c1' } }, ctx);
    expect(hint).toMatch(/hook/);
    expect(hint).toMatch(/Terminate and carry/);
  });

  it('points a kept character at its toggle', () => {
    expect(blockerHint({ code: 'character_pinned', message: 'Ada is kept on this machine', entity: { kind: 'character', id: 'c1' } }, ctx))
      .toMatch(/Keep on this machine.*Ada/);
  });

  it('names both sides of a pull when a copy kept changing', () => {
    const writer: Blocker = { code: 'external_writer', message: 'the source /w/app kept changing through 3 passes', entity: { kind: 'root', id: 'r_a' } };
    const pull = blockerHint(writer, { ...ctx, destination: 'This Mac', source: 'studio', pull: true });
    expect(pull).toMatch(/studio/);
    expect(pull).toMatch(/This Mac/);
  });

  it('compares agent CLI versions only, and warns of the trust question Codex asks', () => {
    const diff = blockerHint({ code: 'config_difference', message: 'claude 1.0 runs on mac and 1.1 on studio' }, ctx);
    expect(diff).toMatch(/version/);
    expect(diff).not.toMatch(/MCP|skill/i);
    expect(blockerHint({ code: 'codex_trust', message: 'Codex asks…' }, ctx)).toMatch(/trust.*each moved folder/);
  });

  it('warns of the trust question Claude asks, whose preselected answer quits it', () => {
    const hint = blockerHint({ code: 'claude_trust', message: 'Claude asks…' }, ctx);
    expect(hint).toMatch(/trust.*each moved folder.*studio/);
    expect(hint).toMatch(/"No, exit".*"Yes, I trust this folder"/);
  });

  it('warns of the Bypass Permissions warning Claude shows, whose preselected answer quits it', () => {
    const hint = blockerHint({ code: 'claude_bypass', message: 'Claude warns…' }, ctx);
    expect(hint).toMatch(/Bypass Permissions mode.*studio/);
    expect(hint).toMatch(/"No, exit".*"Yes, I accept"/);
  });

  it('sends two releases that differ to Upgrade for the Linux machine, whichever way the fleet moves', () => {
    const release: Blocker = { code: 'incompatible_release', message: 'the destination runs release a1, this machine b2' };
    expect(blockerHint(release, ctx)).toMatch(/same Svall release.*Upgrade studio/);
    expect(blockerHint(release, { ...ctx, destination: 'This Mac', source: 'studio', pull: true })).toMatch(/Upgrade studio/);
    expect(blockerHint({ ...release, code: 'incompatible_protocol' }, ctx)).toBe(blockerHint(release, ctx));
    expect(blockerHint({ ...release, code: 'incompatible_schema' }, ctx)).toBe(blockerHint(release, ctx));
  });

  it('says where an agent is to be installed, logged in or set up, and that a login never moves', () => {
    expect(blockerHint({ code: 'agent_cli_missing', message: 'the destination has no codex CLI' }, ctx)).toMatch(/Install it on studio/);
    expect(blockerHint({ code: 'agent_logged_out', message: 'claude is not logged in on the destination' }, ctx)).toMatch(/on studio.*never moves/);
    expect(blockerHint({ code: 'agent_hooks_missing', message: "Svall's hooks are not installed for codex" }, ctx)).toMatch(/svall setup on studio/);
  });
});

// The lines `svall handover --json` prints (packages/cli/src/controller/events.ts), each with the fields the sheet
// reads from it. A line without one of them, from an older release's events file or a newer helper, is passed over.
describe('the helper lines the sheet reads', () => {
  const blocker = { code: 'agent_working', message: 'ada is still working', entity: { kind: 'character', id: 'c1' } };
  const lines: { line: Record<string, unknown>; reads: string[] }[] = [
    {
      line: { event: 'handover.preflight', data: { summary, blockers: [blocker], warnings: [blocker], names: { characters: { c1: 'ada' }, roots: {}, sessions: {} } } },
      reads: ['data.summary', 'data.summary.roots', 'data.summary.files', 'data.summary.bytes', 'data.summary.sessions', 'data.blockers',
        'data.blockers.0.code', 'data.blockers.0.message', 'data.blockers.0.entity.kind', 'data.blockers.0.entity.id', 'data.warnings',
        'data.warnings.0.message', 'data.names.characters', 'data.names.roots'],
    },
    { line: { event: 'handover.changed', data: { transactionId: tx, phase: 'freeze' } }, reads: ['data.phase'] },
    {
      line: { event: 'handover.entity', data: { transactionId: tx, kind: 'root', id: 'r_a', phase: 'transfer', bytes: 1, totalBytes: 2 } },
      reads: ['data.kind', 'data.id', 'data.phase'],
    },
    { line: { event: 'handover.blocked', data: { transactionId: tx, phase: 'freeze', blockers: [blocker] } }, reads: ['data.phase', 'data.blockers', 'data.blockers.0.message'] },
    { line: { event: 'handover.retry', data: { transactionId: tx, phase: 'transfer', attempt: 2, error: 'ssh closed' } }, reads: ['data.phase', 'data.attempt', 'data.error'] },
    {
      line: { event: 'handover.result', data: { status: 'complete', transactionId: tx, generation: 3, characters: [{ id: 'c1', ok: true }] } },
      reads: ['data.status', 'data.characters', 'data.characters.0.id', 'data.characters.0.ok'],
    },
    { line: { event: 'handover.result', data: { status: 'none', reason: 'no handover is open' } }, reads: ['data.reason'] },
    { line: { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [blocker] } }, reads: ['data.phase', 'data.blockers'] },
    { line: { event: 'handover.result', data: { status: 'aborted', phase: 'freeze' } }, reads: ['data.phase'] },
    {
      line: { event: 'handover.result', data: { status: 'interrupted', phase: 'transfer', error: 'ssh closed', safe: ['resume', 'abort'] } },
      reads: ['data.phase', 'data.error', 'data.safe'],
    },
    { line: { event: 'handover.result', data: { status: 'detached', transactionId: tx } }, reads: ['data.transactionId'] },
    { line: { event: 'handover.status', data: { standing: 'open', phase: 'transfer', safe: ['resume'], reason: 'handover tx-1 is under way' } }, reads: ['data.standing', 'data.safe', 'data.reason'] },
  ];
  const without = (line: Record<string, unknown>, at: string): unknown => {
    const copy = structuredClone(line);
    const keys = at.split('.');
    const parent = keys.slice(0, -1).reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, copy);
    delete parent[keys.at(-1)!];
    return copy;
  };
  const start = followRun('studio');

  it('folds in every line the helper prints', () => {
    for (const { line } of lines) expect(applyEvent(start, line as HandoverEvent), JSON.stringify(line)).not.toBe(start);
  });

  it('passes over a line missing any field it reads, without throwing', () => {
    for (const { line, reads } of lines) {
      for (const at of reads) expect(applyEvent(start, without(line, at) as HandoverEvent), `${String(line.event)} without ${at}`).toBe(start);
    }
    for (const odd of [null, 'handover.changed', {}, { event: 'handover.weather', data: {} }, { event: 'handover.changed' },
      { event: 'handover.result', data: { status: 'renamed' } }, { event: 'handover.changed', data: { phase: 'teleport' } },
      { event: 'handover.blocked', data: { phase: 'freeze', blockers: [], choices: 'all' } }]) {
      expect(applyEvent(start, odd as unknown as HandoverEvent), JSON.stringify(odd)).toBe(start);
    }
  });

  it('reads an older events file back to the status after it, whatever it holds', () => {
    const older = [changed('begin'), { event: 'handover.preflight', data: { summary } }, { event: 'handover.result', data: { status: 'interrupted', phase: 'transfer' } },
      { event: 'handover.status', data: { standing: 'none', safe: [], reason: 'no handover is open' } }] as HandoverEvent[];
    const run = play(older);
    expect(headline(run, 'studio')).toBe('no handover is open');
    expect(run.preflight).toBeUndefined();
  });
});
