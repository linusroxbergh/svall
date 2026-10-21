// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { HandoverEvent } from '../../src/handover.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const bridge = { present: true, send: () => {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ app: { get store() { return store; }, bridge, api: () => ({ call: vi.fn() }) } }));

const { HandoverSheet } = await import('../../src/HandoverSheet.js');
const { HostSetup } = await import('../../src/HostSetup.js');

const freeze: HandoverEvent = { event: 'handover.changed', data: { transactionId: 'tx', phase: 'freeze' } };
const blocked: HandoverEvent = { event: 'handover.blocked', data: { transactionId: 'tx', phase: 'freeze', blockers: [{ code: 'agent_working', message: "Ada's terminal is still working" }] } };

beforeEach(() => {
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, handoverEnabled: true, gateway: 'trift' });
  store.getState().handoverFollow('trift');
});

test('opened by hand, the sheet focuses its close button', () => {
  render(<HandoverSheet />);
  act(() => store.getState().toggleHandover(true));
  expect(document.activeElement).toBe(screen.getByTestId('handover-close'));
});

test('a decision that opens the sheet, or arrives while it is up, puts the focus on its answer', () => {
  render(<HandoverSheet />);
  act(() => { store.getState().handoverEvent(freeze); store.getState().handoverEvent(blocked); });
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));

  // closing leaves the decision waiting, and opening the sheet again goes back to it
  fireEvent.click(screen.getByTestId('handover-close'));
  expect(screen.queryByTestId('handover-sheet')).toBeNull();
  expect(store.getState().handover?.decision?.phase).toBe('freeze');
  act(() => store.getState().toggleHandover());
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));

  fireEvent.click(screen.getByTestId('handover-go'));
  act(() => screen.getByTestId('handover-close').focus());
  act(() => store.getState().handoverEvent(blocked));
  expect(document.activeElement).toBe(screen.getByTestId('handover-go'));
});

test('a release blocker opens the machines panel on the Linux machine, in place of the sheet', () => {
  render(<><HandoverSheet /><HostSetup /></>);
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
      { code: 'incompatible_release', message: 'trift runs release 0.5.0, and this Mac 0.6.0' },
    ] } });
  });
  fireEvent.click(screen.getByTestId('handover-upgrade'));
  expect(screen.queryByTestId('handover-sheet')).toBeNull();
  expect((screen.getByTestId('host-name') as HTMLInputElement).value).toBe('trift');
});

test('a folder that holds repositories no character works in blocks on its character until Carry the folder whole is chosen, and the start again carries it', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const message = "c1's terminal is in /Users/ada/Developer, which holds 2 Git repositories no character works in (old-stuff, unrelated), so the handover would carry them too; cd that terminal to ~ or into the repository it works on";
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
      { code: 'repository_unused', message, entity: { kind: 'character', id: 'c1' } },
    ] } });
    store.getState().handoverExit(1);
  });
  const row = screen.getByTestId('handover-blocker-repository_unused');
  expect(row.querySelector('.ho-who')?.textContent).toBe('c1');
  // the problem on one line, the helper's remedy and the choice's meaning behind Details
  expect(row.querySelector('.host-said')?.textContent).toContain('so the handover would carry them too');
  expect(row.querySelector('.ho-more')?.textContent).toContain('cd that terminal to ~');
  expect(row.querySelector('.ho-more')?.textContent).toContain('Carry the folder whole copies those repositories to trift with it.');
  expect(screen.getByTestId('handover-headline').textContent).toBe('1 thing to settle before the fleet moves to trift. Nothing has moved.');
  expect(screen.getByTestId('handover-footnote').textContent).toBe('1 choice still open. Move to trift runs the checks again.');
  expect(screen.getByTestId('handover-section-checks').dataset.state).toBe('waiting');

  // picking the choice settles the row: it says what will happen, and can be undone
  fireEvent.click(screen.getByTestId('handover-choice-carry'));
  expect(screen.getByTestId('handover-choice-carry').textContent).toBe('Carry the folder whole');
  expect(screen.getByTestId('handover-choice-carry').getAttribute('aria-pressed')).toBe('true');
  expect(row.dataset.status).toBe('ok');
  expect(row.querySelector('.ho-plan')?.textContent).toBe("c1's folder will be carried whole, with the repositories in it.");
  expect(store.getState().handover?.choices).toEqual({ carryUnused: true });
  expect(screen.getByTestId('handover-footnote').textContent).toBe('Everything is settled: Move to trift runs the checks again and goes on.');
  fireEvent.click(screen.getByTestId('handover-undo-carry'));
  expect(store.getState().handover?.choices).toEqual({});
  expect(row.dataset.status).toBe('fail');
  fireEvent.click(screen.getByTestId('handover-choice-carry'));

  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
  fireEvent.click(screen.getByTestId('handover-try-again'));
  expect(send.mock.calls).toContainEqual([{ type: 'handover.start', to: 'trift', choices: { carryUnused: true } }]);
});

const names = { characters: { c0: 'dev', c1: 'codex-r', c2: 'claude-x' }, roots: { r_1: '/Users/ada/src/alpha', r_2: '/Users/ada/src/beta' }, sessions: { s0: 'dev' } };
const summary = { digest: 'a'.repeat(64), roots: 2, files: 10, bytes: 2_000_000, sessions: 1 };
const preflight: HandoverEvent = { event: 'handover.preflight', data: { summary, blockers: [], warnings: [
  { code: 'env_file', message: '/Users/ada/src/alpha holds .env', entity: { kind: 'root', id: 'r_1' } },
  { code: 'worktree_unused', message: '/Users/ada/src/beta: worktrees no character uses are not registered on the destination: /Users/ada/src/beta-wt (on fix)', entity: { kind: 'git', id: 'g_b2c1' } },
], names } };
const changed = (...phases: ('begin' | 'freeze' | 'transfer' | 'verify' | 'prepare' | 'ready' | 'commit' | 'activate' | 'complete')[]): HandoverEvent[] =>
  phases.map((phase) => ({ event: 'handover.changed', data: { transactionId: 'tx', phase } }));
const rested = (): HandoverEvent[] => ['c0', 'c1', 'c2'].map((id) => ({ event: 'handover.entity', data: { transactionId: 'tx', kind: 'character', id, phase: 'freeze', done: 1, total: 1 } }));
const say = (...events: HandoverEvent[]) => act(() => { store.getState().toggleHandover(true); for (const e of events) store.getState().handoverEvent(e); });

test('stopped at the checks, every blocker names what it is about in words and has a way out, and the notes fold away', () => {
  render(<HandoverSheet />);
  say(preflight, { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'agent_blocked', message: 'codex-r is waiting on an answer: "Allow Codex to run `rm -rf dist`?"', entity: { kind: 'character', id: 'c1' } },
    { code: 'path_unsupported', message: "claude-x's terminal is in /Users/ada/.local/share/opencode, which stays on its machine", entity: { kind: 'character', id: 'c2' } },
    { code: 'destination_occupied', message: '/Users/ada/src/beta already exists on trift', entity: { kind: 'root', id: 'r_2' } },
  ] } });
  act(() => store.getState().handoverExit(1));
  expect(screen.getByTestId('handover-route').textContent).toBe('This Mac→trift');
  expect(screen.getByTestId('handover-headline').textContent).toBe('3 things to settle before the fleet moves to trift. Nothing has moved.');
  expect(screen.getByTestId('handover-footnote').textContent).toBe('2 choices still open; 1 thing to fix outside the sheet first. Move to trift runs the checks again.');
  const asked = screen.getByTestId('handover-blocker-agent_blocked');
  expect(asked.querySelector('.host-said')?.firstChild?.textContent).toBe('codex-r is waiting on an answer');
  expect(asked.querySelector('.ho-quote')?.textContent).toBe('Allow Codex to run `rm -rf dist`?');
  expect(asked.querySelector('[data-testid="handover-open-card"]')?.textContent).toBe('Open c1');
  // each blocker's code, small, to look up in errors.md
  expect(asked.querySelector('.ho-code')?.textContent).toBe('agent_blocked');
  const stuck = screen.getByTestId('handover-blocker-path_unsupported');
  expect(stuck.querySelector('em')?.textContent).toContain('cd that terminal to a folder that travels');
  expect(stuck.querySelector('[data-testid="handover-open-card"]')?.textContent).toBe('Open c2');
  const taken = screen.getByTestId('handover-blocker-destination_occupied');
  expect(taken.querySelector('.ho-who')?.textContent).toBe('~/src/beta');
  expect(taken.querySelector('.ho-who')?.getAttribute('title')).toBe('/Users/ada/src/beta');
  // that folder is on trift, so it is named, not opened in this Mac's Finder
  expect(taken.querySelector('[data-testid="handover-show-folder"]')).toBeNull();
  expect(taken.querySelector('[data-testid="handover-path"]')?.textContent).toBe('/Users/ada/src/beta on trift');
  const notes = screen.getByTestId('handover-notes');
  expect(notes.querySelector('summary')?.textContent).toBe('2 notes');
  expect(screen.getByTestId('handover-warning-env_file').querySelector('.ho-who')?.textContent).toBe('~/src/alpha');
  expect(screen.getByTestId('handover-warning-worktree_unused').querySelector('.ho-who')?.textContent).toBe('~/src/beta');
  // the blockers come before the notes
  expect(asked.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(asked.querySelector('[data-testid="handover-open-card"]')!);
  expect(store.getState().selectedId).toBe('c1');
  expect(store.getState().handoverOpen).toBe(false);
});

test('the warnings that bite once the fleet has moved stay in sight, and only the rest fold away', () => {
  render(<HandoverSheet />);
  say({ event: 'handover.preflight', data: { summary, blockers: [], warnings: [
    ...(preflight.event === 'handover.preflight' ? preflight.data.warnings : []),
    { code: 'claude_trust', message: 'Claude asks whether to trust ~/src/alpha the first time dev resumes on trift', entity: { kind: 'character', id: 'c0' } },
    { code: 'claude_bypass', message: 'claude-x resumes in Bypass Permissions mode, which Claude on trift has not accepted', entity: { kind: 'character', id: 'c2' } },
    { code: 'config_difference', message: 'claude 2.0.1 runs on this machine and 2.0.3 on trift' },
  ], names } });
  for (const code of ['claude_trust', 'claude_bypass', 'config_difference']) {
    expect(screen.getByTestId(`handover-warning-${code}`).closest('details'), code).toBeNull();
  }
  expect(screen.getByTestId('handover-warning-claude_trust').querySelector('em')?.textContent).toMatch(/"No, exit" preselected/);
  expect(screen.getByTestId('handover-notes').querySelector('summary')?.textContent).toBe('2 notes');
  expect(screen.getByTestId('handover-warning-env_file').closest('details')).not.toBeNull();
});

test('Show in Finder is offered only for a folder on this Mac while the fleet runs here; elsewhere the path is named with its machine', () => {
  render(<HandoverSheet />);
  const linked = (message: string): HandoverEvent => ({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code: 'path_symlinked', message, entity: { kind: 'root', id: 'r_1' } }] } });
  say(preflight, linked('/Users/ada/src/alpha leads to /Volumes/work/alpha through a symbolic link; a handover carries each folder at its real path, the one Git and the agents record, so use /Volumes/work/alpha instead'));
  expect(screen.getByTestId('handover-show-folder')).toBeTruthy();
  // the destination's own link: on trift
  say(linked('/Users/ada/src/alpha leads to /data/alpha on this machine through a symbolic link; a folder lands at the path it has on the source, the one Git and the agents record, so that link has to go first'));
  expect(screen.queryByTestId('handover-show-folder')).toBeNull();
  expect(screen.getByTestId('handover-path').textContent).toBe('/Users/ada/src/alpha on trift');
  // in a pull the fleet runs on the gateway, and this Mac opens no folder for it
  act(() => store.getState().handoverFollow('local'));
  say(preflight, linked('/Users/ada/src/alpha leads to /Volumes/work/alpha through a symbolic link; a handover carries each folder at its real path, the one Git and the agents record, so use /Volumes/work/alpha instead'));
  expect(screen.queryByTestId('handover-show-folder')).toBeNull();
  expect(screen.getByTestId('handover-path').textContent).toBe('/Users/ada/src/alpha on trift');
});

test('while transferring, one bar sums every folder and session, a verified folder reads whole, and the rows wait behind a disclosure', () => {
  render(<HandoverSheet />);
  say(preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer'),
    // a fresh copy is checked with every byte sent; only the row the destination verified counts
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_1', phase: 'verify', bytes: 1_000_000, totalBytes: 1_000_000 } },
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_2', phase: 'transfer', bytes: 250_000, totalBytes: 1_000_000 } },
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'session', id: 's0', phase: 'verify', bytes: 1_000, totalBytes: 1_000, verified: true } });
  expect(screen.getByTestId('handover-transfer-total').textContent).toContain('1.3 MB of 2.0 MB · 1 of 3 verified');
  expect(screen.getByTestId('handover-transfer-total').querySelector('.ho-bar > i')?.getAttribute('style')).toContain('width: 63%');
  expect(screen.getByTestId('handover-transfer-rows').querySelector('summary')?.textContent).toBe('2 folders and 1 session');
  expect(screen.getByTestId('handover-row-transfer-r_1').querySelector('.ho-bar > i')?.getAttribute('style')).toContain('width: 100%');
  expect(screen.getByTestId('handover-row-transfer-r_1').querySelector('.host-mark')?.textContent).toBe('·');
  expect(screen.getByTestId('handover-row-transfer-s0').querySelector('.host-mark')?.textContent).toBe('✓');
  expect(screen.getByTestId('handover-rest-rows').querySelector('summary')?.textContent).toBe('3 characters at rest');
  expect(screen.getByTestId('handover-headline').textContent).toBe('Transferring files and sessions…');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
  expect(screen.queryByTestId('handover-done')).toBeNull();
});

test('a decision mid-run says how many things wait on it, with the agent at work named above the characters at rest', () => {
  render(<HandoverSheet />);
  say(preflight, ...changed('begin', 'freeze'), ...rested(),
    { event: 'handover.blocked', data: { transactionId: 'tx', phase: 'freeze', blockers: [{ code: 'agent_working', message: "dev's terminal is still working", entity: { kind: 'character', id: 'c0' } }] } });
  expect(screen.getByTestId('handover-headline').textContent).toBe('One thing to decide before the fleet goes on.');
  expect(screen.getByTestId('handover-go').textContent).toBe('Continue waiting');
  expect(screen.getByTestId('handover-section-rest').dataset.state).toBe('waiting');
  const working = screen.getByTestId('handover-blocker-agent_working');
  expect(working.compareDocumentPosition(screen.getByTestId('handover-row-rest-c0')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByTestId('handover-choice-interrupt'));
  expect(screen.getByTestId('handover-go').textContent).toBe('Carry on');
  expect(working.querySelector('.ho-plan')?.textContent).toBe('c0 will be stopped with Escape and resume from its transcript on trift.');
});

// what the controller's status reasons look like: ids and generations the sheet never shows
const [TX, MAC, TRIFT] = ['2f6c1e9a-41b7-4c1e-9d2a-6b0e3c5d7f11', '7d3e0b52-9c4a-4f18-a6b2-0e5d8c1f3a90', 'c41a9e07-5b3d-4e62-8f1c-2a7d9b0e6f45'];

const committed = (standing: 'committed' | 'moved'): HandoverEvent => ({ event: 'handover.status', data: {
  standing, journals: {}, action: standing === 'committed' ? 'continue' : 'finish', transactionId: TX, phase: 'activate', safe: ['resume'],
  reason: `${TX} is committed: the fleet belongs to ${TRIFT} at generation 4, and only its activation can go on`,
} });
const resumes = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'handover.resume').length;

test('a run that stopped before the commit offers Resume and Abort with what each does, and waits for one', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverReplay([preflight, ...changed('begin', 'freeze', 'transfer'),
      { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'transfer', error: 'ssh to trift closed', safe: ['resume', 'abort'] } },
      { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } }]);
  });
  expect(screen.getByTestId('handover-headline').textContent).toBe('Stopped at Transferring files and sessions, before the commit: the fleet has not moved.');
  expect(screen.getByTestId('handover-footnote').textContent).toBe('Resume goes on from where it stopped; Abort gives the fleet back to This Mac.');
  expect(screen.getByTestId('handover-resume').textContent).toBe('Resume');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
  expect(resumes(send)).toBe(0);
  expect(screen.getByTestId('handover-sheet').textContent).not.toMatch(new RegExp(`${TX}|${MAC}|generation`));
});

test('past the commit, a status that leaves only resuming opens the sheet and resumes by itself, and a resume that stops again offers Retry', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer', 'verify', 'prepare', 'ready', 'commit'),
    { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'commit', error: 'ssh to trift closed', safe: ['resume'] } },
    committed('committed')]));
  expect(resumes(send)).toBe(1);
  expect(store.getState().handoverOpen).toBe(true);
  expect(screen.getByTestId('handover-headline').textContent).toBe("The fleet is trift's now, so the sheet resumes it there by itself…");
  expect(screen.getByTestId('handover-section-resume').dataset.state).toBe('active');
  expect(screen.getByTestId('handover-rest-rows')).toBeTruthy();
  expect(screen.queryByTestId('handover-resume')).toBeNull();
  expect(screen.queryByTestId('handover-abort')).toBeNull();
  expect(screen.getByTestId('handover-sheet').textContent).not.toMatch(new RegExp(`${TX}|${TRIFT}|generation|activation`));

  act(() => {
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'activate', error: 'ssh to trift closed', safe: ['resume'] } });
    store.getState().handoverExit(1);
  });
  expect(screen.getByTestId('handover-resume').textContent).toBe('Retry');
  expect(screen.queryByTestId('handover-abort')).toBeNull();
  expect(screen.getByTestId('handover-footnote').textContent).toBe('Retry finishes resuming on trift; nothing goes back from here.');
  expect(resumes(send)).toBe(1);

  // a moved fleet the gateway left only to be finished goes on by itself too
  act(() => store.getState().handoverReplay([committed('moved')]));
  expect(resumes(send)).toBe(2);
});

test('a resume the sheet started by itself is not started again by what its helper replays, however often', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([committed('committed')]));
  expect(resumes(send)).toBe(1);
  // the helper had already ended: attach reads back its result and the status, then exits
  for (let i = 0; i < 3; i++) {
    act(() => {
      store.getState().handoverEvent({ event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'activate', error: 'ssh to trift closed', safe: ['resume'] } });
      store.getState().handoverEvent(committed('committed'));
      store.getState().handoverExit(0);
    });
  }
  expect(resumes(send)).toBe(1);
  expect(screen.getByTestId('handover-resume').textContent).toBe('Retry');
});

const openAtChecks = (code: 'transaction_open' | 'generation_mismatch' | 'identity_mismatch', message: string): HandoverEvent =>
  ({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code, message }] } });
const attaches = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'handover.attach').length;

test('a handover already open at the checks is looked up, and the sheet offers what its status says is safe in place of a new start', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const open = openAtChecks('transaction_open', `this fleet is already in handover ${TX} (preparing); resume or abort it first`);
  say(open);
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
  expect(screen.queryByTestId('handover-try-again')).toBeNull();
  expect(screen.getByTestId('handover-footnote').textContent).toBe('Asking where that handover stands…');

  // what the shell reads back: the run that blocked, then where the open one stands
  act(() => store.getState().handoverReplay([open,
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } }]));
  expect(attaches(send)).toBe(1);
  expect(screen.getByTestId('handover-headline').textContent).toBe('Stopped at Transferring files and sessions, before the commit: the fleet has not moved.');
  expect(screen.getByTestId('handover-blocker-transaction_open')).toBeTruthy();
  expect(screen.getByTestId('handover-resume').textContent).toBe('Resume');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
  expect(screen.queryByTestId('handover-try-again')).toBeNull();
  expect(screen.getByTestId('handover-footnote').textContent).toBe('Resume goes on from where it stopped; Abort gives the fleet back to This Mac.');

  // one the gateway has moved on from is Forget's
  act(() => store.getState().handoverReplay([open, { event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(screen.getByTestId('handover-forget')).toBeTruthy();
  expect(screen.queryByTestId('handover-try-again')).toBeNull();
});

test('a generation the gateway does not share, with nothing open, keeps its blocker and the new start', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const stale = openAtChecks('generation_mismatch', `This Mac holds this fleet for ${MAC} at generation 4, and the gateway for ${MAC} at 0`);
  say(stale);
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
  act(() => store.getState().handoverReplay([stale, { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover of this fleet is open anywhere' } }]));
  expect(screen.getByTestId('handover-headline').textContent).toBe('1 thing to settle before the fleet moves to trift. Nothing has moved.');
  expect(screen.getByTestId('handover-blocker-generation_mismatch')).toBeTruthy();
  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
  expect(attaches(send)).toBe(1);
});

test('a status the sheet could not read leaves the blockers and the new start', () => {
  render(<HandoverSheet />);
  say(openAtChecks('transaction_open', `this fleet is already in handover ${TX} (preparing); resume or abort it first`));
  act(() => { store.getState().handoverExit(1); store.getState().handoverExit(1, 'svall: the gateway did not answer'); });
  expect(screen.getByTestId('handover-try-again')).toBeTruthy();
  expect(screen.getByTestId('handover-footnote').textContent).toBe('1 thing to fix outside the sheet first. Move to trift runs the checks again.');
});

test('where nothing is safe or the gateway has moved on, the sheet names the commands that go on from a terminal, as code to copy', () => {
  render(<HandoverSheet />);
  const commands = () => [...screen.getByTestId('handover-way-out').querySelectorAll('code')].map((c) => c.textContent);
  say(...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit'),
    { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'commit', error: 'the gateway did not answer', safe: [] } });
  act(() => store.getState().handoverExit(1));
  expect(commands()).toEqual(['svall handover status', 'svall fleet recover --force-owner local --gateway <machine>']);
  expect(screen.getByTestId('handover-way-out').textContent).toMatch(/^Once the gateway answers, svall handover status in a terminal says what is safe\. If it is gone for good/);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'unknown', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(commands()).toEqual(['svall handover status', 'svall fleet recover --force-owner local --gateway <machine>']);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(commands()).toEqual(['svall handover status', 'svall fleet recover --force-owner local']);
  expect(screen.getByTestId('handover-way-out').textContent).toMatch(/Forget is enough when another handover or a recovery moved it on/);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: '' } }]));
  expect(screen.queryByTestId('handover-way-out')).toBeNull();
});

test('a generation the gateway does not share names the restart and the recovery that clear it, with the machine that runs the fleet', () => {
  render(<HandoverSheet />);
  say(openAtChecks('generation_mismatch', `This Mac holds this fleet for ${MAC} at generation 4, and the gateway for ${MAC} at 0`));
  const hint = screen.getByTestId('handover-blocker-generation_mismatch').querySelector('em')!;
  expect([...hint.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['svall handover status', 'svall fleet recover --force-owner local']);
  expect(hint.textContent).toMatch(/restart Svall's daemon on This Mac/);
});

test('the sheet says when Abort stops being possible: once the commit begins, and not before', () => {
  render(<HandoverSheet />);
  say(preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer', 'verify', 'prepare', 'ready'));
  expect(screen.getByTestId('handover-section-verify').dataset.state).toBe('active');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
  expect(screen.queryByTestId('handover-no-way-back')).toBeNull();
  say(...changed('commit'));
  expect(screen.getByTestId('handover-section-verify').dataset.state).toBe('done');
  expect(screen.getByTestId('handover-section-commit').dataset.state).toBe('active');
  expect(screen.queryByTestId('handover-abort')).toBeNull();
  expect(screen.getByTestId('handover-no-way-back').textContent).toBe('From here there is no way back: the gateway gives the fleet to trift, and the move can only go on.');
});

const finished = (...characters: { id: string; ok: boolean; error?: string }[]): HandoverEvent[] => [
  preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer'),
  { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_1', phase: 'verify', bytes: 1_000_000, totalBytes: 1_000_000, verified: true } },
  ...changed('verify', 'prepare', 'ready', 'commit', 'activate'),
  ...characters.map((c): HandoverEvent => ({ event: 'handover.entity', data: { transactionId: 'tx', kind: 'character', id: c.id, phase: 'activate', ...(c.error && { error: c.error }) } })),
  ...changed('complete'),
  { event: 'handover.result', data: { status: 'complete', transactionId: 'tx', generation: 2, characters } },
];

test('done, the footer says where the fleet runs with a Close, the route points at the destination, and every character is accounted for', () => {
  render(<HandoverSheet />);
  say(...finished({ id: 'c0', ok: true }, { id: 'c1', ok: true }));
  act(() => store.getState().handoverExit(0));
  expect(screen.getByTestId('handover-headline').textContent).toBe('The fleet runs on trift now.');
  expect(screen.getByTestId('handover-footer').dataset.tone).toBe('done');
  expect(screen.getByTestId('handover-route').querySelector('[data-here]')?.textContent).toBe('trift');
  expect(screen.getByTestId('handover-resume-tally').querySelector('.host-said')?.textContent).toBe('2 agents resumed; 1 terminal reopens in its folder when you open it');
  expect(screen.getByTestId('handover-rest-rows').querySelector('summary')?.textContent).toBe('3 characters at rest');
  expect(screen.getByTestId('handover-transfer-total').textContent).toContain('1 folder verified on trift, 1.0 MB');
  expect(screen.getByTestId('handover-section-resume').dataset.state).toBe('done');
  fireEvent.click(screen.getByTestId('handover-done'));
  expect(store.getState().handoverOpen).toBe(false);
  // the sheet opens on the finished run, and the way to another move is a click away
  act(() => store.getState().toggleHandover(true));
  fireEvent.click(screen.getByTestId('handover-again'));
  expect(screen.getByTestId('handover-destinations')).toBeTruthy();
  expect(screen.queryByTestId('handover-footer')).toBeNull();
});

test('done with a character that did not resume, the tally and its row say so, and the row offers Retry and its card', () => {
  render(<HandoverSheet />);
  say(...finished({ id: 'c0', ok: true }, { id: 'c1', ok: false, error: 'codex-r did not start: codex exited 1' }));
  act(() => store.getState().handoverExit(0));
  expect(screen.getByTestId('handover-headline').textContent).toBe('The fleet runs on trift now. 1 character did not resume.');
  expect(screen.getByTestId('handover-resume-tally').querySelector('.host-said')?.textContent).toBe('1 agent resumed, 1 did not; 1 terminal reopens in its folder when you open it');
  expect(screen.getByTestId('handover-resume-tally').dataset.status).toBe('fail');
  const row = screen.getByTestId('handover-row-resume-c1');
  expect(row.dataset.status).toBe('fail');
  expect(row.textContent).toContain('codex exited 1');
  expect(screen.getByTestId('handover-retry-c1')).toBeTruthy();
  expect(screen.getByTestId('handover-done').textContent).toBe('Close');
});
