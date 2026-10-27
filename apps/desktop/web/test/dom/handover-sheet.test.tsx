// @vitest-environment jsdom
import './setup.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { HandoverEvent } from '../../src/handover.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const bridge = { present: true, send: () => {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ app: { get store() { return store; }, bridge, api: () => ({ call: vi.fn() }) } }));

const { HandoverSheet } = await import('../../src/HandoverSheet.js');
const { HostSetup } = await import('../../src/HostSetup.js');

// what a note says, line by line
const linesOf = (id: string) => [...screen.getByTestId(id).querySelectorAll('.ho-line')].map((l) => l.textContent);

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

test('a destination runs the checks alone and shows what moves and who stops before anything freezes; Move starts the handover', () => {
  const send = vi.spyOn(bridge, 'send');
  const agent = (status: 'idle' | 'working') => ({ kind: 'claude' as const, sessionId: 's', status, lastActivityAt: 0 });
  store.getState().setFleet({ ...fleet(), robots: {
    c1: chr('c1', 'i_b', { x: 1, y: 1 }, { name: 'ada', agent: agent('idle') }),
    c2: chr('c2', 'i_b', { x: 2, y: 1 }, { name: 'bo', agent: agent('working') }),
    c3: chr('c3', 'i_a', { x: 1, y: 1 }, { name: 'cy' }),
  } });
  store.setState({ handover: undefined });
  render(<HandoverSheet />);
  act(() => store.getState().toggleHandover(true));
  // what moves folds away under the one line on what a handover does
  const moves = screen.getByTestId('handover-what-moves');
  expect(moves.querySelector('summary')?.textContent).toBe('What moves');
  expect([...moves.querySelectorAll('.ho-more-body > span')].map((s) => s.textContent)).toEqual(['Islands, robots, repositories and agent sessions.',
    'Agents resume from their transcripts.', 'Shells reopen in their folders; a command still running does not move.']);
  fireEvent.click(screen.getByTestId('handover-to-gateway'));
  expect(send).toHaveBeenLastCalledWith({ type: 'handover.start', to: 'trift', check: true });
  act(() => {
    store.getState().handoverEvent({ event: 'handover.preflight', data: { summary: { digest: 'a'.repeat(64), roots: 2, files: 120, bytes: 42_000_000, sessions: 1 }, blockers: [], warnings: [] } });
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'ready' } });
    store.getState().handoverExit(0);
  });
  expect(screen.getByTestId('handover-summary').textContent).toBe('2 folders, 120 files, 42.0 MB, 1 session');
  expect(screen.getByTestId('handover-rest-resume').textContent).toBe('ada stops now and resumes from its transcript on trift.');
  expect(screen.getByTestId('handover-rest-wait').textContent).toContain('bo is working: the handover waits up to three minutes');
  expect(screen.getByTestId('handover-rest-shell').textContent).toContain('cy closes and reopens in its folder on trift');
  expect(screen.getByTestId('handover-section-rest').getAttribute('data-state')).toBe('pending');
  expect(screen.getByTestId('handover-headline').textContent).toBe('Nothing stops the move to trift, and nothing has moved yet.');

  fireEvent.click(screen.getByTestId('handover-try-again'));
  expect(send).toHaveBeenLastCalledWith({ type: 'handover.start', to: 'trift' });
  // a check read back at launch, with nothing open, offers no move and so no plan
  act(() => {
    store.getState().handoverReplay([
      { event: 'handover.preflight', data: { summary: { digest: 'a'.repeat(64), roots: 2, files: 120, bytes: 42_000_000, sessions: 1 }, blockers: [], warnings: [] } },
      { event: 'handover.result', data: { status: 'ready' } },
      { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } },
    ]);
  });
  expect(screen.queryByTestId('handover-rest-resume')).toBeNull();
  expect(screen.queryByTestId('handover-footnote')?.textContent ?? '').not.toContain('Move to');
  act(() => store.getState().handoverFollow('trift'));
  // once the move has begun, the robots' own rows take the place of the plan
  act(() => store.getState().handoverEvent({ event: 'handover.changed', data: { transactionId: 'tx', phase: 'freeze' } }));
  expect(screen.queryByTestId('handover-rest-resume')).toBeNull();
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
  expect(screen.getByTestId('host-machine').textContent).toBe('trift');
  expect(screen.getByTestId('host-setup').querySelector('[data-testid="machine-more"]')).not.toBeNull();
});

const nothingOpen: HandoverEvent = { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover of this fleet is open anywhere' } };

test('the sheet offers only where the fleet can go: the gateway from this Mac, and this Mac from the gateway', () => {
  store.setState({ handover: undefined });
  render(<HandoverSheet />);
  act(() => { store.getState().toggleHandover(true); store.getState().handoverReplay([nothingOpen]); });
  expect(screen.getByTestId('handover-to-gateway').textContent).toBe('Move to trift');
  expect(screen.queryByTestId('handover-to-local')).toBeNull();
  // with nothing open, the status says nothing the destination does not, and there is nowhere else to pick
  expect(screen.queryByTestId('handover-footer')).toBeNull();
  expect(screen.queryByTestId('handover-again')).toBeNull();

  act(() => store.getState().setConnectionState({ state: 'online', owner: 'trift' }));
  expect(screen.getByTestId('handover-to-local').textContent).toBe('Move to This Mac');
  expect(screen.queryByTestId('handover-to-gateway')).toBeNull();
});

test('with nothing open but a leftover Abort clears, the footer keeps Abort beside the destination', () => {
  const send = vi.spyOn(bridge, 'send');
  store.setState({ handover: undefined });
  render(<HandoverSheet />);
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'none', journals: {}, action: 'finish-abort', safe: ['abort'], reason: 'the gateway never began this handover; nothing moved' } }]);
  });
  expect(screen.getByTestId('handover-to-gateway').textContent).toBe('Move to trift');
  expect(screen.queryByTestId('handover-again')).toBeNull();
  fireEvent.click(screen.getByTestId('handover-abort'));
  expect(send).toHaveBeenLastCalledWith({ type: 'handover.abort' });
});

test('with no gateway, the sheet says so, and offers neither a move nor a gateway to make', () => {
  const send = vi.spyOn(bridge, 'send');
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, handoverEnabled: true });
  store.setState({ handover: undefined });
  render(<HandoverSheet />);
  act(() => store.getState().toggleHandover(true));
  expect(screen.getByTestId('handover-no-gateway').textContent).toBe('This fleet names no gateway to hand it over to.');
  expect(screen.queryByTestId('handover-destinations')).toBeNull();
  expect(screen.getByTestId('handover-sheet').querySelectorAll('[data-testid="handover-no-gateway"] button')).toHaveLength(0);
  expect(send).not.toHaveBeenCalledWith({ type: 'host.list' });
});

test('a folder that holds repositories no robot works in blocks on its robot until Carry the folder whole is chosen, and the start again carries it', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const message = "c1's terminal is in /Users/ada/Developer, which holds 2 Git repositories no robot works in (old-stuff, unrelated), so the handover would carry them too; cd that terminal to ~ or into the repository it works on";
  act(() => {
    store.getState().toggleHandover(true);
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
      { code: 'repository_unused', message, entity: { kind: 'robot', id: 'c1' } },
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
  expect(linesOf('handover-footnote')).toEqual(['1 choice still open.', 'Move to trift runs the checks again.']);
  expect(screen.getByTestId('handover-section-checks').dataset.state).toBe('waiting');

  // picking the choice settles the row: it says what will happen, and can be undone
  fireEvent.click(screen.getByTestId('handover-choice-carry'));
  expect(screen.getByTestId('handover-choice-carry').textContent).toBe('Carry the folder whole');
  expect(screen.getByTestId('handover-choice-carry').getAttribute('aria-pressed')).toBe('true');
  expect(row.dataset.status).toBe('ok');
  expect(row.querySelector('.ho-plan')?.textContent).toBe("c1's folder will be carried whole, with the repositories in it.");
  expect(store.getState().handover?.choices).toEqual({ carryUnused: true });
  expect(screen.getByTestId('handover-footnote').textContent).toBe('All settled: Move to trift runs the checks again and goes on.');
  fireEvent.click(screen.getByTestId('handover-undo-carry'));
  expect(store.getState().handover?.choices).toEqual({});
  expect(row.dataset.status).toBe('fail');
  fireEvent.click(screen.getByTestId('handover-choice-carry'));

  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
  fireEvent.click(screen.getByTestId('handover-try-again'));
  expect(send.mock.calls).toContainEqual([{ type: 'handover.start', to: 'trift', choices: { carryUnused: true } }]);
});

const names = { robots: { c0: 'dev', c1: 'codex-r', c2: 'claude-x' }, roots: { r_1: '/Users/ada/src/alpha', r_2: '/Users/ada/src/beta' }, sessions: { s0: 'dev' } };
const summary = { digest: 'a'.repeat(64), roots: 2, files: 10, bytes: 2_000_000, sessions: 1 };
const preflight: HandoverEvent = { event: 'handover.preflight', data: { summary, blockers: [], warnings: [
  { code: 'env_file', message: '/Users/ada/src/alpha holds .env', entity: { kind: 'root', id: 'r_1' } },
  { code: 'worktree_unused', message: '/Users/ada/src/beta: worktrees no robot uses are not registered on the destination: /Users/ada/src/beta-wt (on fix)', entity: { kind: 'git', id: 'g_b2c1' } },
], names } };
const changed = (...phases: ('begin' | 'freeze' | 'transfer' | 'verify' | 'prepare' | 'ready' | 'commit' | 'activate' | 'complete')[]): HandoverEvent[] =>
  phases.map((phase) => ({ event: 'handover.changed', data: { transactionId: 'tx', phase } }));
const rested = (): HandoverEvent[] => ['c0', 'c1', 'c2'].map((id) => ({ event: 'handover.entity', data: { transactionId: 'tx', kind: 'robot', id, phase: 'freeze', done: 1, total: 1 } }));
const say = (...events: HandoverEvent[]) => act(() => { store.getState().toggleHandover(true); for (const e of events) store.getState().handoverEvent(e); });

test('stopped at the checks, every blocker names what it is about in words and has a way out, and the notes fold away', () => {
  render(<HandoverSheet />);
  say(preflight, { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'agent_blocked', message: 'codex-r is waiting on an answer: "Allow Codex to run `rm -rf dist`?"', entity: { kind: 'robot', id: 'c1' } },
    { code: 'path_unsupported', message: "claude-x's terminal is in /Users/ada/.local/share/opencode, which stays on its machine", entity: { kind: 'robot', id: 'c2' } },
    { code: 'destination_occupied', message: '/Users/ada/src/beta already exists on trift', entity: { kind: 'root', id: 'r_2' } },
  ] } });
  act(() => store.getState().handoverExit(1));
  expect(screen.getByTestId('handover-route').textContent).toBe('This Mac→trift');
  expect(screen.getByTestId('handover-headline').textContent).toBe('3 things to settle before the fleet moves to trift. Nothing has moved.');
  expect(linesOf('handover-footnote')).toEqual(['2 choices still open, 1 thing to fix outside the sheet.', 'Move to trift runs the checks again.']);
  const asked = screen.getByTestId('handover-blocker-agent_blocked');
  expect(asked.querySelector('.host-said')?.firstChild?.textContent).toBe('codex-r is waiting on an answer');
  expect(asked.querySelector('.ho-quote')?.textContent).toBe('Allow Codex to run `rm -rf dist`?');
  expect(asked.querySelector('[data-testid="handover-open-card"]')?.textContent).toBe('Open c1');
  // each blocker's code, small, to look up in errors.md
  expect(asked.querySelector('.ho-code')?.textContent).toBe('agent_blocked');
  const stuck = screen.getByTestId('handover-blocker-path_unsupported');
  expect([...stuck.querySelectorAll('em .ho-line[data-item]')].map((l) => l.textContent)).toEqual(['move what it names', 'cd that terminal to a folder that travels', 'close the robot']);
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
    { code: 'claude_trust', message: 'Claude asks whether to trust ~/src/alpha the first time dev resumes on trift', entity: { kind: 'robot', id: 'c0' } },
    { code: 'claude_bypass', message: 'claude-x resumes in Bypass Permissions mode, which Claude on trift has not accepted', entity: { kind: 'robot', id: 'c2' } },
    { code: 'config_difference', message: 'claude 2.0.1 runs on this machine and 2.0.3 on trift' },
  ], names } });
  for (const code of ['claude_trust', 'claude_bypass', 'config_difference']) {
    expect(screen.getByTestId(`handover-warning-${code}`).closest('details'), code).toBeNull();
  }
  expect(screen.getByTestId('handover-warning-claude_trust').querySelector('em')?.textContent).toMatch(/"No, exit" is preselected/);
  expect(screen.getByTestId('handover-notes').querySelector('summary')?.textContent).toBe('2 notes');
  expect(screen.getByTestId('handover-warning-env_file').closest('details')).not.toBeNull();
});

test('an OpenCode warned of as logged in on neither machine is not told to log in there', () => {
  render(<HandoverSheet />);
  say({ event: 'handover.preflight', data: { summary, blockers: [], warnings: [
    { code: 'agent_logged_out', message: "opencode is not logged in on the destination, nor here, where its agent answers without a login, as on OpenCode Zen's free models; for a provider's model, run opencode auth login there" },
  ], names } });
  expect(screen.getByTestId('handover-warning-agent_logged_out').textContent).not.toMatch(/Log it in/);
});

test('Show in Finder is offered only for a folder on this Mac while the fleet runs here; elsewhere the path is named with its machine', () => {
  render(<HandoverSheet />);
  const linked = (message: string): HandoverEvent => ({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code: 'path_symlinked', message, entity: { kind: 'root', id: 'r_1' } }] } });
  say(preflight, linked('/Users/ada/src/alpha leads to /Volumes/work/alpha through a symbolic link; a handover carries each folder at its real path, the one Git and the agents record, so use /Volumes/work/alpha instead'));
  expect(screen.getByTestId('handover-show-folder')).toBeTruthy();
  // the destination's own link: on trift
  say(linked('/Users/ada/src/alpha leads to /data/alpha on this machine through a symbolic link; a folder lands at the path the handover gives it here, the one Git and the agents record, so that link has to go first'));
  expect(screen.queryByTestId('handover-show-folder')).toBeNull();
  expect(screen.getByTestId('handover-path').textContent).toBe('/Users/ada/src/alpha on trift');
  // a folder the checks could not carry is on this Mac
  say({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code: 'path_unsupported', message: '/Users/ada/src/alpha: 1 path cannot be carried: a\nb', entity: { kind: 'root', id: 'r_1' } }] } });
  expect(screen.getByTestId('handover-show-folder')).toBeTruthy();
  // in a pull the fleet runs on the gateway, and this Mac opens no folder for it
  act(() => store.getState().handoverFollow('local'));
  say(preflight, linked('/Users/ada/src/alpha leads to /Volumes/work/alpha through a symbolic link; a handover carries each folder at its real path, the one Git and the agents record, so use /Volumes/work/alpha instead'));
  expect(screen.queryByTestId('handover-show-folder')).toBeNull();
  expect(screen.getByTestId('handover-path').textContent).toBe('/Users/ada/src/alpha on trift');
});

test('while transferring, one bar sums every folder and session, a verified folder reads whole, and the rows wait behind a disclosure', () => {
  render(<HandoverSheet />);
  say(preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer'),
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_1', phase: 'transfer', bytes: 500_000, totalBytes: 1_000_000 } });
  // before the other rows say their size, the whole is what preflight found
  expect(screen.getByTestId('handover-transfer-total').textContent).toContain('500.0 KB of 2.0 MB');
  expect(screen.getByTestId('handover-transfer-total').querySelector('.ho-bar > i')?.getAttribute('style')).toContain('width: 25%');
  say(
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
  expect(screen.getByTestId('handover-rest-rows').querySelector('summary')?.textContent).toBe('3 robots at rest');
  expect(screen.getByTestId('handover-headline').textContent).toBe('Transferring files and sessions…');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
});

test('a folder whose copy kept files aside shows that above the folded rows', () => {
  render(<HandoverSheet />);
  const notice = '1 file the copy replaced or deleted after its first pass is kept at /Users/ada/src/alpha.overwritten-tx: a.txt';
  say(preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer'),
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_1', phase: 'verify', bytes: 1_000, totalBytes: 1_000, verified: true, notice } },
    { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_2', phase: 'verify', bytes: 1_000, totalBytes: 1_000, verified: true } });
  const row = screen.getByTestId('handover-row-transfer-r_1');
  expect(row.textContent).toContain(notice);
  expect(screen.getByTestId('handover-transfer-rows').contains(row)).toBe(false);
  expect(screen.getByTestId('handover-transfer-rows').contains(screen.getByTestId('handover-row-transfer-r_2'))).toBe(true);
});

test('a decision mid-run says how many things wait on it, with the agent at work named above the robots at rest', () => {
  render(<HandoverSheet />);
  say(preflight, ...changed('begin', 'freeze'), ...rested(),
    { event: 'handover.blocked', data: { transactionId: 'tx', phase: 'freeze', blockers: [{ code: 'agent_working', message: "dev's terminal is still working", entity: { kind: 'robot', id: 'c0' } }] } });
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
const attaches = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'handover.attach').length;

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
  expect(linesOf('handover-footnote')).toEqual(['Resume goes on from where it stopped.', 'Abort gives the fleet back to This Mac.']);
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

test('a watched run that stops past the commit, with resuming all that is safe, resumes by itself once', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const stopped: HandoverEvent = { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'activate', error: 'ssh to trift closed', safe: ['resume'] } };
  say(preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer', 'verify', 'prepare', 'ready', 'commit', 'activate'), stopped);
  expect(resumes(send)).toBe(0);
  act(() => store.getState().handoverExit(1));
  expect(resumes(send)).toBe(1);
  expect(screen.getByTestId('handover-headline').textContent).toBe("The fleet is trift's now, so the sheet resumes it there by itself…");
  say(stopped);
  act(() => store.getState().handoverExit(1));
  expect(resumes(send)).toBe(1);
  expect(screen.getByTestId('handover-resume').textContent).toBe('Retry');
  // before the commit, a stop waits for Resume or Abort
  act(() => store.getState().handoverFollow('trift'));
  say(...changed('begin', 'freeze', 'transfer'), { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'transfer', error: 'ssh to trift closed', safe: ['resume', 'abort'] } });
  act(() => store.getState().handoverExit(1));
  expect(resumes(send)).toBe(1);
});

test('a resume the sheet started by itself that finds nothing safe has the status read once, and then waits for Retry', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([committed('committed')]));
  const refused: HandoverEvent = { event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'activate', error: 'the handover helper exited before it listened', safe: [] } };
  // the shell answers each resume with the refusal and each status it is asked for with the replay, as long as the sheet asks
  let [resumed, asked] = [0, 0];
  for (let i = 0; i < 3; i++) {
    if (resumes(send) > resumed) { resumed = resumes(send); act(() => { store.getState().handoverEvent(refused); store.getState().handoverExit(1); }); }
    if (attaches(send) > asked) { asked = attaches(send); act(() => store.getState().handoverReplay([refused, committed('committed')])); }
  }
  expect(resumes(send)).toBe(1);
  expect(attaches(send)).toBe(1);
  expect(screen.getByTestId('handover-resume').textContent).toBe('Retry');
});

test('a start refused with nothing safe keeps its error when the status it reads finds nothing open', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const nothingOpen: HandoverEvent = { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover of this fleet is open anywhere' } };
  // the launcher refuses on stdout alone, so the events file still holds the run before it
  say({ event: 'handover.result', data: { status: 'interrupted', phase: 'begin', error: 'the handover helper exited before it listened; ~/.svall/controller/helper.log says why', safe: [], stop: 'unexpected' } });
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
  act(() => store.getState().handoverReplay([...finished({ id: 'c0', ok: true }), nothingOpen]));
  expect(screen.getByTestId('handover-headline').textContent).toBe('Stopped at Checks: the handover helper exited before it listened; ~/.svall/controller/helper.log says why');
  expect(attaches(send)).toBe(1);
  // one the helper wrote down comes back from the events file the same
  act(() => store.getState().handoverFollow('trift'));
  const refused: HandoverEvent = { event: 'handover.result', data: { status: 'interrupted', phase: 'begin', error: 'ssh: connect to host trift port 22: Connection refused', safe: [], stop: 'unexpected' } };
  say(refused);
  act(() => store.getState().handoverExit(1));
  act(() => store.getState().handoverReplay([refused, nothingOpen]));
  expect(screen.getByTestId('handover-headline').textContent).toBe('Stopped at Checks: ssh: connect to host trift port 22: Connection refused');
  // a run that stopped with a way on, which something since has closed, offers none of it
  act(() => store.getState().handoverReplay([{ event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'transfer', error: 'ssh to trift closed', safe: ['resume', 'abort'] } },
    { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: '' } }]));
  expect(screen.getByTestId('handover-headline').textContent).toBe('No handover of this fleet is open.');
  expect(screen.queryByTestId('handover-resume')).toBeNull();
  // nor does one that stopped with nothing safe, which a recovery since has settled
  act(() => store.getState().handoverReplay([{ event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'commit', error: 'whether the handover committed is unknown', safe: [], stop: 'commit_unknown' } },
    { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: '' } }]));
  expect(screen.getByTestId('handover-headline').textContent).toBe('No handover of this fleet is open.');
  expect(screen.queryByTestId('handover-way-out')).toBeNull();
  expect(screen.queryByTestId('handover-follow')).toBeNull();
});

const openAtChecks = (code: 'transaction_open' | 'generation_mismatch' | 'identity_mismatch', message: string): HandoverEvent =>
  ({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code, message }] } });

test('a handover already open at the checks is looked up, and the sheet offers what its status says is safe in place of a new start', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  act(() => store.getState().setConnectionState({ state: 'online', owner: 'local' }));
  const open = openAtChecks('transaction_open', `this fleet is already in handover ${TX} (preparing); resume or abort it first`);
  say(open);
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
  expect(screen.queryByTestId('handover-try-again')).toBeNull();
  expect(screen.getByTestId('handover-headline').textContent).toBe('Asking where the handover stands…');
  // nothing starts while the status is on its way, which the shell would not run beside it
  expect(screen.queryByTestId('handover-again')).toBeNull();

  // what the shell reads back: the run that blocked, then where the open one stands
  act(() => store.getState().handoverReplay([open,
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } }]));
  expect(attaches(send)).toBe(1);
  expect(screen.getByTestId('handover-headline').textContent).toBe('Stopped at Transferring files and sessions, before the commit: the fleet has not moved.');
  expect(screen.getByTestId('handover-blocker-transaction_open')).toBeTruthy();
  expect(screen.getByTestId('handover-resume').textContent).toBe('Resume');
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
  expect(screen.queryByTestId('handover-try-again')).toBeNull();
  expect(linesOf('handover-footnote')).toEqual(['Resume goes on from where it stopped.', 'Abort gives the fleet back to This Mac.']);
  // with the status in, the blocker keeps its hint and code, not the ids its message names
  expect(screen.getByTestId('handover-blocker-transaction_open').textContent).toContain('transaction_open');
  expect(screen.getByTestId('handover-sheet').textContent).not.toMatch(new RegExp(`${TX}|${MAC}|generation`));

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
  expect(screen.getByTestId('handover-blocker-generation_mismatch').querySelector('em')?.textContent).toMatch(/restart Svall's daemon/);
  expect(screen.getByTestId('handover-sheet').textContent).not.toMatch(new RegExp(`${MAC}|at generation`));
  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
  expect(attaches(send)).toBe(1);
});

test('the handover a check finds is named by where the fleet runs, not by the start the checks stopped, which may have gone the other way', () => {
  render(<HandoverSheet />);
  const open = openAtChecks('transaction_open', `this fleet is already in handover ${TX} (preparing); resume or abort it first`);
  act(() => { store.getState().setConnectionState({ state: 'online', owner: 'local' }); store.getState().handoverFollow('local'); });
  say(open);
  act(() => store.getState().handoverExit(1));
  act(() => store.getState().handoverReplay([open,
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: '' } }]));
  expect(screen.getByTestId('handover-route').textContent).toBe('This Mac→trift');
  // one with nothing open leaves the start the checks stopped, and its Move to
  act(() => store.getState().handoverFollow('trift'));
  say(open);
  act(() => store.getState().handoverExit(1));
  act(() => store.getState().handoverReplay([open, { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: '' } }]));
  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
  // a live helper the status found is the other handover too
  act(() => store.getState().handoverFollow('local'));
  say(open);
  act(() => store.getState().handoverExit(1));
  say(...changed('begin', 'freeze'));
  expect(screen.getByTestId('handover-route').textContent).toBe('This Mac→trift');
});

test('a status the sheet could not read says so and offers to look again, without asking again by itself', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  say(openAtChecks('transaction_open', `this fleet is already in handover ${TX} (preparing); resume or abort it first`));
  act(() => store.getState().handoverExit(1));
  // status printed nothing and said nothing on stderr
  act(() => store.getState().handoverExit(1));
  expect(screen.getByTestId('handover-headline').textContent).toBe('The helper did not run: the helper exited with code 1');
  expect(screen.getByTestId('handover-follow').textContent).toBe('Check again');
  expect(attaches(send)).toBe(1);
});

test('a status that finds a live helper follows it, from its first event', () => {
  render(<HandoverSheet />);
  say(openAtChecks('transaction_open', `this fleet is already in handover ${TX} (transfer); resume or abort it first`));
  act(() => store.getState().handoverExit(1));
  say(...changed('begin', 'freeze', 'transfer'));
  expect(screen.getByTestId('handover-headline').textContent).toBe('Transferring files and sessions…');
  expect(screen.getByTestId('handover-section-transfer').dataset.state).toBe('active');
  expect(screen.queryByTestId('handover-blocker-transaction_open')).toBeNull();
  expect(screen.getByTestId('handover-abort')).toBeTruthy();
});

test('a resume the sheet started by itself that could not start offers Retry, not a new move', () => {
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([committed('committed')]));
  act(() => store.getState().handoverExit(1, 'svall: the handover helper exited before it listened'));
  expect(screen.getByTestId('handover-resume').textContent).toBe('Retry');
  expect(screen.queryByTestId('handover-again')).toBeNull();
});

test('where nothing is safe or the gateway has moved on, the sheet names the commands that go on from a terminal, as code to copy', () => {
  render(<HandoverSheet />);
  const commands = () => [...screen.getByTestId('handover-way-out').querySelectorAll('code')].map((c) => c.textContent);
  say(...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit'),
    { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx', phase: 'commit', error: 'whether the handover committed is unknown', safe: [], stop: 'commit_unknown' } });
  act(() => store.getState().handoverExit(1));
  const gone = ['svall handover status', 'svall host doctor trift', 'svall fleet recover --force-owner local', 'svall fleet recover --force-owner local --gateway <machine>'];
  expect(commands()).toEqual(gone);
  // each command stands alone on its line, under what it is for
  expect(linesOf('handover-way-out')).toEqual(['Once the gateway answers, this says what is safe:', 'svall handover status', 'Meanwhile, check the link to it:', 'svall host doctor trift',
    'If it is gone for good, run the fleet on this Mac alone:', 'svall fleet recover --force-owner local', 'Or with another machine as its gateway:', 'svall fleet recover --force-owner local --gateway <machine>']);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'unknown', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(commands()).toEqual(gone);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(commands()).toEqual(['svall handover status', 'svall fleet recover --force-owner local']);
  expect(linesOf('handover-way-out')).toEqual(['Where the fleet stands now:', 'svall handover status', 'Forget is enough if another handover or a recovery moved it on.',
    "If the gateway was set up again, make this Mac the fleet's owner:", 'svall fleet recover --force-owner local']);

  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: '' } }]));
  expect(screen.queryByTestId('handover-way-out')).toBeNull();
});

test('a stop with nothing safe names the way out for what stopped it, with what the journals said behind Details', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const commands = (id: string) => [...screen.getByTestId(id).querySelectorAll('code')].map((c) => c.textContent);
  const broken = '/Users/ada/.svall/handover/journal.json';
  say(...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate'), { event: 'handover.result', data: {
    status: 'interrupted', transactionId: TX, phase: 'activate', safe: [], stop: 'journal_lost',
    error: "trift's handover journal could not be read, so nothing is safe until it is put back or the fleet is recovered",
    detail: `${TX} moved this fleet to ${TRIFT}, whose handover journal could not be read and was moved to ${broken}.broken-1: on that machine, repair it and put it back at ${broken}, then restart the fleet's daemon there and resume; or \`svall fleet recover --force-owner <machine>\` names the machine to run the fleet, from the state it holds`,
  } });
  act(() => store.getState().handoverExit(1));
  expect(screen.getByTestId('handover-headline').textContent).toBe("The fleet moved to trift, but trift's handover record is unreadable. Nothing is safe until it is put back or the fleet is recovered.");
  expect(screen.getByTestId('handover-detail').textContent).toContain(`${broken}.broken-1`);
  expect(commands('handover-detail')).toEqual(['svall fleet recover --force-owner <machine>']);
  expect(linesOf('handover-way-out')).toEqual(["On trift, put the handover record back where Details says, restart the fleet's daemon there, then Check again.",
    'Or run the fleet on a machine you name, from the state it holds:', 'svall fleet recover --force-owner <machine>']);
  expect(commands('handover-way-out')).toEqual(['svall fleet recover --force-owner <machine>']);
  expect(screen.getByTestId('handover-follow')).toBeTruthy();
  expect(attaches(send)).toBe(0);

  // the gateway could not be asked: its link first, then the recoveries
  act(() => store.getState().handoverFollow('trift'));
  say(...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit'), { event: 'handover.result', data: {
    status: 'interrupted', transactionId: TX, phase: 'commit', safe: [], stop: 'gateway_unknown', error: 'the gateway could not say whether this handover committed, so nothing is safe until it answers',
  } });
  act(() => store.getState().handoverExit(1));
  expect(screen.getByTestId('handover-headline').textContent).toBe('Whether the fleet moved to trift is not known yet: the gateway could not be asked.');
  expect(commands('handover-way-out')).toEqual(['svall handover status', 'svall host doctor trift', 'svall fleet recover --force-owner local', 'svall fleet recover --force-owner local --gateway <machine>']);
  expect(attaches(send)).toBe(0);

  // another run holds the machine: the sheet follows it
  act(() => store.getState().handoverFollow('trift'));
  say({ event: 'handover.result', data: { status: 'interrupted', phase: 'begin', safe: [], stop: 'running', error: 'a handover of this fleet already runs here as pid 4242' } });
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
});

test('a generation the gateway does not share names the restart and the recovery that clear it, with the machine that runs the fleet', () => {
  render(<HandoverSheet />);
  say(openAtChecks('generation_mismatch', `This Mac holds this fleet for ${MAC} at generation 4, and the gateway for ${MAC} at 0`));
  const hint = screen.getByTestId('handover-blocker-generation_mismatch').querySelector('em')!;
  expect([...hint.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['svall handover status', 'svall fleet recover --force-owner local']);
  // each command alone on its line, under what it is for
  expect([...hint.querySelectorAll('.ho-line')].map((l) => l.textContent)).toEqual(['Another handover or a recovery moved the fleet since This Mac last heard, or the gateway was set up again.',
    'This says which:', 'svall handover status', "With nothing open, restart Svall's daemon on This Mac; it takes the gateway's newer record.",
    'A gateway set up again needs:', 'svall fleet recover --force-owner local']);
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
  expect(screen.getByTestId('handover-no-way-back').textContent).toBe('No way back from here: the move to trift can only go on.');
});

test('a resume or abort that finds nothing safe has the sheet read the status, and says where things stand in its words', () => {
  const send = vi.spyOn(bridge, 'send');
  render(<HandoverSheet />);
  const reason = `the gateway holds this fleet for ${TRIFT} at generation 5 in handover 9b1d0c3e-7f2a-4d6b-8e5c-1a0f9d3b7c24, past ${TX}`;
  say(...changed('begin', 'freeze', 'transfer'), { event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'transfer', error: reason, safe: [] } });
  act(() => store.getState().handoverExit(1));
  expect(attaches(send)).toBe(1);
  act(() => store.getState().handoverReplay([{ event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'transfer', error: reason, safe: [] } },
    { event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason } }]));
  expect(screen.getByTestId('handover-forget')).toBeTruthy();
  expect(screen.getByTestId('handover-sheet').textContent).not.toMatch(new RegExp(`${TX}|${TRIFT}|generation`));
  expect(attaches(send)).toBe(1);
});

test("the commands the sheet names act on this window's fleet, by the profile the shell names it by", () => {
  // a home that reads like a profile names none unless the shell says so, as a Dev build's own does
  store.getState().setShell({ home: '/Users/ada/.svall-dev', log: [], op: false, handoverEnabled: true, gateway: 'trift' });
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect(screen.getByTestId('handover-way-out').querySelector('code')?.textContent).toBe('svall handover status');
  cleanup();
  store.getState().setShell({ home: '/Users/ada/.svall-work', log: [], op: false, handoverEnabled: true, gateway: 'trift', profile: 'work' });
  render(<HandoverSheet />);
  act(() => store.getState().handoverReplay([{ event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: '' } }]));
  expect([...screen.getByTestId('handover-way-out').querySelectorAll('code')].map((c) => c.textContent)).toEqual(['svall -p work handover status', 'svall -p work fleet recover --force-owner local']);
  act(() => store.getState().handoverFollow('trift'));
  say(openAtChecks('generation_mismatch', 'This Mac holds this fleet at a later generation than the gateway'));
  expect([...screen.getByTestId('handover-blocker-generation_mismatch').querySelectorAll('em code')].map((c) => c.textContent))
    .toEqual(['svall -p work handover status', 'svall -p work fleet recover --force-owner local']);
});

const finished = (...robots: { id: string; ok: boolean; error?: string }[]): HandoverEvent[] => [
  preflight, ...changed('begin', 'freeze'), ...rested(), ...changed('transfer'),
  { event: 'handover.entity', data: { transactionId: 'tx', kind: 'root', id: 'r_1', phase: 'verify', bytes: 1_000_000, totalBytes: 1_000_000, verified: true } },
  ...changed('verify', 'prepare', 'ready', 'commit', 'activate'),
  ...robots.map((c): HandoverEvent => ({ event: 'handover.entity', data: { transactionId: 'tx', kind: 'robot', id: c.id, phase: 'activate', ...(c.error && { error: c.error }) } })),
  ...changed('complete'),
  { event: 'handover.result', data: { status: 'complete', transactionId: 'tx', generation: 2, robots } },
];

test('done, the footer says where the fleet runs, the route points at the destination, and every robot is accounted for', () => {
  render(<HandoverSheet />);
  say(...finished({ id: 'c0', ok: true }, { id: 'c1', ok: true }));
  act(() => store.getState().handoverExit(0));
  expect(screen.getByTestId('handover-headline').textContent).toBe('The fleet runs on trift now.');
  expect(screen.getByTestId('handover-footer').dataset.tone).toBe('done');
  expect(screen.getByTestId('handover-route').querySelector('[data-here]')?.textContent).toBe('trift');
  expect(screen.getByTestId('handover-resume-tally').querySelector('.host-said')?.textContent).toBe('2 agents resumed; 1 terminal reopens in its folder when you open it');
  expect(screen.getByTestId('handover-rest-rows').querySelector('summary')?.textContent).toBe('3 robots at rest');
  expect(screen.getByTestId('handover-transfer-total').textContent).toContain('1 folder verified on trift, 1.0 MB');
  expect(screen.getByTestId('handover-section-resume').dataset.state).toBe('done');
  // the × is the way out, so the footer holds no buttons of its own
  expect(screen.getByTestId('handover-footer').querySelector('.acts')).toBeNull();
  fireEvent.click(screen.getByTestId('handover-close'));
  expect(store.getState().handoverOpen).toBe(false);
  // the sheet opens on the finished run, and the way to another move is a click away
  act(() => store.getState().toggleHandover(true));
  fireEvent.click(screen.getByTestId('handover-again'));
  expect(screen.getByTestId('handover-destinations')).toBeTruthy();
  expect(screen.queryByTestId('handover-footer')).toBeNull();
  // the machine chosen there runs its checks in sight, and offers its Move
  fireEvent.click(screen.getByTestId('handover-to-gateway'));
  act(() => {
    store.getState().handoverEvent({ event: 'handover.result', data: { status: 'ready' } });
    store.getState().handoverExit(0);
  });
  expect(screen.queryByTestId('handover-destinations')).toBeNull();
  expect(screen.getByTestId('handover-try-again').textContent).toBe('Move to trift');
});

test('done with a robot that did not resume, the tally and its row say so, and the row offers Retry and its card', () => {
  render(<HandoverSheet />);
  say(...finished({ id: 'c0', ok: true }, { id: 'c1', ok: false, error: 'codex-r did not start: codex exited 1' }));
  act(() => store.getState().handoverExit(0));
  expect(screen.getByTestId('handover-headline').textContent).toBe('The fleet runs on trift now. 1 robot did not resume.');
  expect(screen.getByTestId('handover-resume-tally').querySelector('.host-said')?.textContent).toBe('1 agent resumed, 1 did not; 1 terminal reopens in its folder when you open it');
  expect(screen.getByTestId('handover-resume-tally').dataset.status).toBe('fail');
  const row = screen.getByTestId('handover-row-resume-c1');
  expect(row.dataset.status).toBe('fail');
  expect(row.textContent).toContain('codex exited 1');
  expect(screen.getByTestId('handover-retry-c1')).toBeTruthy();
});
