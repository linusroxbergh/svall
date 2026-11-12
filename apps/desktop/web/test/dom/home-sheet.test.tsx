// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPT_ACTIONS, type MachineId } from '@svall/protocol';
import { bridge, call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { app } = await import('../../src/boot.js');
const { HomeSheet } = await import('../../src/HomeSheet.js');
const { CrewAwayBanner, HomeMoveBanner } = await import('../../src/HomeBanner.js');

const STUDIO = '66666666-7777-4888-9999-aaaaaaaaaaaa' as MachineId;
const ME = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const SHEET = { here: 3, there: 7, mission: [], rewrites: [] };

const answer = (methods: Record<string, unknown>) => call.mockImplementation((method: string) => Promise.resolve(methods[method] ?? {}));

beforeEach(() => { freshStore(); answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET } }); });
afterEach(cleanup);

const api = app.api;
afterEach(() => { app.api = api; });

const open = async (back = false) => {
  act(() => { store.getState().setHomeSheet({ to: STUDIO, name: 'studio', back }); });
  render(<HomeSheet />);
  await screen.findAllByTestId(/home-summary|home-refusal|home-error/);
};
const step = (s: string, status: string, more = {}, op = 'home') => act(() => { store.getState().hostStep(op as never, { step: s, status, ...more } as never); });
const go = async () => { fireEvent.click(await screen.findByTestId('home-go')); };
// the summary's rows, each its label and its value; the label's own words, without its info tip
const summary = () => [...screen.getByTestId('home-summary').querySelectorAll('.row')].map((r) => `${r.firstElementChild!.firstChild!.textContent}: ${r.querySelector('b')!.textContent}`);
// what a problem says: its line, and what to do under it
const said = (el: Element) => [...el.querySelectorAll('.said > div > span')].map((e) => e.textContent);
const raw = (el: Element) => el.querySelector('.said details .modal-more-body')?.textContent;

describe('the sheet of a home move', () => {
  it('asks the check of where the fleet goes, and says what moves and where robots stay', async () => {
    await open();
    expect(call).toHaveBeenCalledWith('fleet.homeCheck', { to: STUDIO });
    expect(screen.getByTestId('home-title').textContent).toBe("Make studio this fleet's home");
    expect(screen.getByRole('dialog').classList.contains('sheet')).toBe(true);
    expect(screen.getByTestId('home-ready').textContent).toBe('Ready to move');
    expect(summary()).toEqual(['moves: islands, notes, settings, phone link', 'robots: stay where they run · 3 here, 7 on studio']);
    expect(document.getElementById('set-tip-home-moves')!.textContent).toBe('Push keys and phone pairing move too, so paired phones stay paired. Open the phone once from the new QR code.');
    expect(screen.getByTestId('home-go').textContent).toBe('Make it the home');
  });

  it('a move that carried no other worker shows no row for them, before or after', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'adopt', 'join', 'probe']) {
      step(s, 'ok');
      expect(screen.getByTestId('home-steps').textContent).not.toContain('The other workers join');
    }
    step('workers', 'skip');
    expect(screen.getByTestId('home-steps').textContent).not.toContain('The other workers join');
  });

  it('a move that carried one shows its row as it waits, and what it found', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('workers', 'start');
    expect(screen.getByTestId('home-steps').textContent).toContain('The other workers join');
    step('workers', 'warn', { detail: 'box has not joined studio yet; its row under Machines says why' });
    expect(screen.getByTestId('home-steps').textContent).toContain('box has not joined studio yet');
  });

  it('names a worker that does not answer, which joins the new home when it does', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, waits: [{ id: 'cccccccc-0000-4000-8000-000000000000', name: 'box' }] } } });
    await open();
    expect(summary().at(-1)).toBe('box: not answering · joins studio when it does');
  });

  it('names mission control\'s robots, and each path it rewrites', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, mission: [{ id: 'c_a', name: 'crew' }, { id: 'c_b', name: 'crew2' }], rewrites: [{ key: 'defaultCwd', to: '~/code' }] } } });
    await open();
    expect(screen.getByTestId('home-mission').textContent).toBe('2 robots move to studio first');
    expect(summary().slice(2)).toEqual(['mission control: 2 robots move to studio first', "new robots' folder: ~/code"]);
  });

  it('says of a rewritten path that the machine taking the fleet does not have it, and goes on', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, rewrites: [{ key: 'defaultCwd', to: '~/code', lacks: true }, { key: 'home.cwd', to: '~/crew' }, { key: 'onboarding.firstProject', to: '~/app', kept: true, lacks: true }] } } });
    await open();
    expect(summary().slice(2)).toEqual(["new robots' folder: ~/code · not on studio yet", "mission control's folder: ~/crew", 'first project folder: ~/app · not on studio yet']);
    expect(screen.getByTestId('home-go')).toBeTruthy();
  });

  it('lists every refusal with what to do, offers no way past them, and checks again', async () => {
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: 'studio is not reachable', action: 'try again when it is awake', details: [], more: [{ reason: 'studio2 is a worker of this fleet too', action: 'remove studio2 first, and add it again from studio' }] } } });
    await open();
    expect(screen.getByTestId('home-blocked').textContent).toBe('Not ready to move yet');
    expect(screen.queryByTestId('home-ready')).toBeNull();
    expect(screen.getAllByTestId('home-refusal').map(said)).toEqual([['studio is not reachable', 'try again when it is awake'], ['studio2 is a worker of this fleet too', 'remove studio2 first, and add it again from studio']]);
    expect(screen.queryByTestId('home-go')).toBeNull();
    answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET } });
    fireEvent.click(screen.getByTestId('home-again'));
    expect(await screen.findByTestId('home-go')).toBeTruthy();
  });

  it('starts the move by name, follows its steps, and cannot be shut while it runs', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home', args: { name: 'studio' } });
    step('check', 'ok');
    step('mission', 'skip');
    step('pause', 'start');
    expect(screen.getByTestId('home-step-check').dataset.state).toBe('done');
    expect(screen.queryByTestId('home-step-mission')).toBeNull();
    expect(screen.getByTestId('home-step-pause').dataset.state).toBe('doing');
    expect(screen.getByTestId('home-step-pause').textContent).toBe('Pause this Mac');
    expect(screen.getByTestId('home-step-adopt').textContent).toBe('studio takes over');
    expect(screen.queryByTestId('home-close')).toBeNull();
    fireEvent.pointerDown(screen.getByTestId('home-sheet'));
    expect(store.getState().homeSheet).toBeDefined();
  });

  it('ends on the phone\'s new QR code, once the window follows the new home', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    const NEW = { serving: true, url: 'https://studio.tailnet.ts.net:8443', qr: 'data:image/png;base64,NEW', logins: ['ada@github'], phones: [] };
    answer({ 'mobile.get': NEW });
    act(() => { store.getState().hostDone('home', 0); });
    expect(screen.getByTestId('home-done').querySelector('.move-state')!.textContent).toBe('The fleet runs on studio');
    expect(call).not.toHaveBeenCalledWith('mobile.get', {});
    await act(async () => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    expect(call).toHaveBeenCalledWith('mobile.get', {});
    // the code alone, and one line under it: none of the phone panel's other words
    const done = screen.getByTestId('home-done');
    expect(done.querySelector('img')?.getAttribute('src')).toBe(NEW.qr);
    expect(done.querySelector('.mob + .modal-sub')!.textContent).toBe('Scan once with your phone. Paired phones stay paired.');
    expect(done.querySelector('.use-note, .mob-here')).toBeNull();
    fireEvent.click(screen.getByTestId('home-finish'));
    expect(store.getState().homeSheet).toBeUndefined();
  });

  it('asks the new home\'s phone link again until it serves, as the one read on reconnect may come first', async () => {
    const OLD = { serving: true, url: 'https://the-mac.tailnet.ts.net:8443', qr: 'data:image/png;base64,OLD', logins: [], phones: [] };
    const NEW = { ...OLD, url: 'https://studio.tailnet.ts.net:8443', qr: 'data:image/png;base64,NEW' };
    let now: object = { ...OLD, serving: false, qr: undefined };
    call.mockImplementation((method: string) => Promise.resolve(method === 'mobile.get' ? now : method === 'fleet.homeCheck' ? { ok: true, sheet: SHEET } : {}));
    act(() => { store.getState().setMobile(OLD as never); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await open();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId('home-go'));
      for (const st of ['check', 'pause', 'phone', 'copy', 'adopt', 'join', 'probe']) step(st, 'ok');
      await act(async () => { store.getState().hostDone('home', 0); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('home-done').querySelector('img')).toBeNull();
      now = NEW;
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(screen.getByTestId('home-done').querySelector('img')?.getAttribute('src')).toBe(NEW.qr);
      expect(screen.queryByTestId('home-phone-wait')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each([[true, 'off'], [false, 'on']])('past half a minute with the new home\'s phone link still off, says what it waits on only when the old home said it served (%s), whatever the window last read (%s)', async (served, read) => {
    const OLD = { serving: read === 'on', url: 'https://the-mac.tailnet.ts.net:8443', qr: 'data:image/png;base64,OLD', logins: [], phones: [] };
    answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET }, 'mobile.get': { ...OLD, serving: false, qr: undefined } });
    act(() => { store.getState().setMobile(OLD as never); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await open();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId('home-go'));
      for (const st of ['check', 'pause', ...(served ? ['phone'] : []), 'copy', 'adopt', 'join', 'probe']) step(st, 'ok');
      await act(async () => { store.getState().hostDone('home', 0); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId('home-phone-wait')).toBeNull();
      // a wait says so as it goes, so the code takes the place of a line rather than of nothing
      expect(screen.getByTestId('home-done').textContent).toContain(served ? 'Starting the phone link on studio…' : 'The fleet runs on studio');
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      if (!served) { expect(screen.queryByTestId('home-phone-wait')).toBeNull(); expect(screen.getByTestId('home-done').textContent).not.toContain('phone link'); return; }
      expect(said(screen.getByTestId('home-phone-wait'))).toEqual(['studio has not turned its phone link on yet']);
      expect(screen.getByTestId('home-phone-wait').textContent).toContain('Turn it on later in Settings → Phone.');
      const asked = call.mock.calls.filter(([m]) => m === 'mobile.get').length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(call.mock.calls.filter(([m]) => m === 'mobile.get').length).toBe(asked);
    } finally { vi.useRealTimers(); }
  });

  it('holds the old home\'s QR back while the window follows the new home with no socket to it yet', async () => {
    const OLD = { serving: true, url: 'https://the-mac.tailnet.ts.net:8443', qr: 'data:image/png;base64,OLD', logins: [], phones: [] };
    const NEW = { ...OLD, url: 'https://studio.tailnet.ts.net:8443', qr: 'data:image/png;base64,NEW' };
    answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET }, 'mobile.get': NEW });
    act(() => { store.getState().setMobile(OLD as never); });
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    act(() => { store.getState().hostDone('home', 0); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio' }); });
    expect(screen.getByTestId('home-reaching')).toBeTruthy();
    expect(screen.getByTestId('home-done').querySelector('img')).toBeNull();
    expect(call).not.toHaveBeenCalledWith('mobile.get', {});
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await waitFor(() => expect(screen.getByTestId('home-done').querySelector('img')?.getAttribute('src')).toBe(NEW.qr));
  });

  it.each([['has yet to answer', () => new Promise(() => {})], ['fails', () => Promise.reject(new Error('no route'))]])('shows no QR code of the old home while the new home\'s phone link %s', async (_how, said) => {
    const OLD = { serving: true, url: 'https://the-mac.tailnet.ts.net:8443', qr: 'data:image/png;base64,OLD', logins: [], phones: [] };
    call.mockImplementation((method: string) => (method === 'mobile.get' ? said() : Promise.resolve(method === 'fleet.homeCheck' ? { ok: true, sheet: SHEET } : {})));
    act(() => { store.getState().setMobile(OLD as never); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    await act(async () => { store.getState().hostDone('home', 0); await Promise.resolve(); });
    expect(call).toHaveBeenCalledWith('mobile.get', {});
    expect(screen.getByTestId('home-done').querySelector('img')).toBeNull();
  });

  it('a failure outside its rows, at the mark or in the shell, says why, and closes', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy']) step(s, 'ok');
    step('mark', 'fail', { detail: 'this home is not frozen for hm_abcdefghij: it stopped, and may have taken a write since' });
    act(() => { store.getState().hostDone('home', 1); });
    expect(screen.getByTestId('home-step-mark').dataset.state).toBe('failed');
    expect(screen.getByTestId('home-failed').textContent).toContain('this home is not frozen for hm_abcdefghij');
    fireEvent.click(screen.getByTestId('home-close-failed'));
    expect(store.getState().homeSheet).toBeUndefined();
  });

  it('a run that ends badly with nothing failed says how it ended, and closes', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    act(() => { store.getState().hostDone('home', 143); });
    expect(said(screen.getByTestId('home-ended'))).toEqual(['The move stopped without saying why.']);
    expect(raw(screen.getByTestId('home-ended'))).toBe('exit 143');
    fireEvent.click(screen.getByTestId('home-close-failed'));
    expect(store.getState().homeSheet).toBeUndefined();
  });

  it('a way back that went through with its old home not yet linked ends done, and says so in the window\'s words', async () => {
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await open(true);
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'mark', 'adopt', 'join']) step(s, 'ok');
    step('probe', 'warn', { detail: 'the fleet runs on this machine; studio has not linked yet', action: 'svall host doctor studio', say: 'Check studio under Machines' });
    act(() => { store.getState().hostDone('home', 0); });
    expect(screen.getByTestId('home-done')).toBeTruthy();
    expect(screen.getByTestId('home-step-probe').dataset.state).toBe('warned');
    expect(screen.getByTestId('home-step-probe').textContent).toContain('the fleet runs on this Mac; studio has not linked yet');
    expect(screen.getByTestId('home-step-probe').textContent).toContain('Check studio under Machines');
    expect(screen.getByTestId('home-step-probe').textContent).not.toContain('svall host doctor');
  });

  it('a failure past the mark says what the window does, not the command a terminal runs', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'mark']) step(s, 'ok');
    step('adopt', 'fail', { detail: 'this machine asked, and studio did not take the fleet: rolledback', action: 'svall fleet home abort, or svall fleet home retry', say: 'The move is not finished' });
    act(() => { store.getState().hostDone('home', 1); });
    expect(said(screen.getByTestId('home-failed'))).toEqual(['this Mac asked, and studio did not take the fleet: rolledback', 'The move is not finished']);
    expect(screen.getByTestId('home-step-adopt').textContent).not.toContain('svall fleet');
  });

  it('a refusal\'s raw words sit behind details: its own, the check\'s, or a tail its sentence carries', async () => {
    answer({
      'fleet.homeCheck': {
        ok: false, sheet: SHEET, refusal: {
          reason: 'Tailscale is not running on studio', action: 'Start it there: sudo systemctl start tailscaled', raw: 'tailscale is stopped', details: ['Command failed: tailscale status --json'],
          more: [{ reason: 'box has no Tailscale: Command failed: tailscale status --json\ntailscale: command not found', action: 'install Tailscale there and sign in' }],
        },
      },
    });
    await open();
    const [first, second] = screen.getAllByTestId('home-refusal');
    expect(said(first)).toEqual(['Tailscale is not running on studio', 'Start it there: sudo systemctl start tailscaled']);
    expect(raw(first)).toBe('tailscale is stopped\nCommand failed: tailscale status --json');
    expect(first.querySelector('details')!.hasAttribute('open')).toBe(false);
    expect(said(second)).toEqual(['box has no Tailscale', 'install Tailscale there and sign in']);
    expect(raw(second)).toBe('Command failed: tailscale status --json\ntailscale: command not found');
  });

  it('a refusal with a command to run opens a terminal on the machine with it typed', async () => {
    act(() => store.getState().setMachines([{ name: 'studio', id: STUDIO, ssh: 'ada@studio', platform: 'linux-x64' }]));
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: 'Tailscale on studio is signed out', action: 'Sign in there: sudo tailscale up', run: 'sudo tailscale up', details: [] } } });
    await open();
    fireEvent.click(within(screen.getByTestId('home-refusal')).getByRole('button', { name: 'Open terminal' }));
    expect(store.getState().hostMachine).toBe('studio');
    expect(store.getState().hostTerminal).toEqual({ run: 'sudo tailscale up' });
  });

  it('a fleet too big to carry offers its folder in Finder, on this Mac only', async () => {
    act(() => store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, machine: ME }));
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: "the fleet's files are 201 MB; a move carries 180 MB", action: 'remove what you no longer need from docs and retro', details: [] } } });
    await open();
    bridge.present = true;
    try { fireEvent.click(screen.getByTestId('home-show-files')); } finally { bridge.present = false; }
    expect(sent).toContainEqual({ type: 'openFolder', path: '/Users/ada/.svall' });
    cleanup();
    act(() => { store.getState().setHomeSheet(undefined); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    await open(true);
    expect(screen.queryByTestId('home-show-files')).toBeNull();
  });

  it('a refusal calls this machine this Mac', async () => {
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: 'this machine has no Tailscale: not running', action: 'install Tailscale and sign in', details: [] } } });
    await open();
    expect(said(screen.getByTestId('home-refusal'))[0]).toBe('this Mac has no Tailscale: not running');
  });

  it('holds the focus, and Escape does not close it while it runs', async () => {
    await open();
    expect(screen.getByTestId('home-sheet').contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    expect(screen.getByTestId('home-sheet').contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(store.getState().homeSheet).toBeDefined();
    act(() => { store.getState().hostDone('home', 1); });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(store.getState().homeSheet).toBeUndefined();
  });

  it('starts nothing while another run is under way', async () => {
    act(() => { store.getState().hostStarted('doctor', { name: 'vault' }); });
    await open();
    expect((screen.getByTestId('home-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a step that fails says why and what to do, and shows no steps past it', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    step('adopt', 'fail', { detail: 'studio did not take the fleet: its daemon did not answer', action: 'svall fleet home abort, or svall fleet home retry' });
    act(() => { store.getState().hostDone('home', 1); });
    expect(screen.getByTestId('home-failed').textContent).toContain('its daemon did not answer');
    expect(screen.queryByTestId('home-step-join')).toBeNull();
    expect(screen.queryByTestId('home-done')).toBeNull();
    fireEvent.click(screen.getByTestId('home-close-failed'));
    expect(store.getState().homeSheet).toBeUndefined();
  });

  it('a running move shows a bar of its steps over them, and once through folds them behind one line', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    step('mission', 'skip');
    step('pause', 'start');
    const bar = () => [...screen.getByTestId('home-bar').children].map((i) => i.getAttribute('data-state'));
    expect(bar()).toEqual(['done', 'doing', 'todo', 'todo', 'todo', 'todo']);
    expect(screen.getByTestId('home-steps').getAttribute('aria-live')).toBe('polite');
    for (const s of ['pause', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    act(() => { store.getState().hostDone('home', 0); });
    expect(screen.queryByTestId('home-bar')).toBeNull();
    expect(screen.queryByTestId('home-steps')).toBeNull();
    expect(screen.getByTestId('home-steps-fold').textContent).toBe('6 steps done');
    expect(screen.queryByTestId('home-steps-done')).toBeNull();
    fireEvent.click(screen.getByTestId('home-steps-fold'));
    expect([...screen.getByTestId('home-steps-done').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Check', 'Pause this Mac', 'Copy the fleet', 'studio takes over', 'This Mac joins', 'Reconnect']);
  });

  it('a failed step says why, what to do under it, and what a tool said behind details', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    step('pause', 'fail', { detail: 'the phone link cannot be read: Command failed: tailscale status --json\ntailscale is stopped', action: 'svall fleet home abort' });
    step('copy', 'fail', { detail: 'rsync could not reach studio', raw: 'rsync: connection unexpectedly closed', say: 'Check that studio is reachable, then try the move again' });
    act(() => { store.getState().hostDone('home', 1); });
    const [pause, copy] = screen.getAllByTestId('home-failed');
    expect(said(pause)).toEqual(['the phone link cannot be read', 'svall fleet home abort']);
    expect(raw(pause)).toBe('Command failed: tailscale status --json\ntailscale is stopped');
    expect(said(copy)).toEqual(['rsync could not reach studio', 'Check that studio is reachable, then try the move again']);
    expect(raw(copy)).toBe('rsync: connection unexpectedly closed');
    expect(screen.getByTestId('home-bar').lastElementChild!.getAttribute('data-state')).toBe('todo');
  });

  it('a stopped move with mission control left away offers to bring them back, which the banner then runs', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    step('check', 'ok');
    step('pause', 'fail', { detail: 'the phone link cannot be read' });
    step('crew', 'warn', { detail: "mission control's crew stayed where the move sent them", say: "Mission control's crew is still on studio" });
    act(() => { store.getState().hostDone('home', 1); });
    expect([...document.querySelectorAll('.modal .acts button')].map((b) => [b.textContent, b.className])).toEqual([['Bring them back', 'btn pri'], ['Close', 'btn']]);
    fireEvent.click(screen.getByTestId('home-crew-back'));
    expect(store.getState().homeSheet).toBeUndefined();
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-crew', args: { name: '' } });
  });

  it.each([['finish', 'home-retry'], ['call off', 'home-abort']] as const)('a stopped move that still stands offers to finish it or call it off, and no Close: the × closes; %s hands it on', async (_what, testid) => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'mark']) step(s, 'ok');
    step('adopt', 'fail', { detail: 'studio did not take the fleet: rolledback', say: 'The move is not finished' });
    step('crew', 'warn', { detail: "mission control's crew stayed where the move sent them" });
    act(() => { store.getState().setHomeMove({ id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true }); store.getState().hostDone('home', 1); });
    expect([...document.querySelectorAll('.modal .acts button')].map((b) => [b.textContent, b.className])).toEqual([['Finish the move', 'btn pri'], ['Call it off', 'btn']]);
    expect(screen.getByTestId('home-close')).toBeTruthy();
    fireEvent.click(screen.getByTestId(testid));
    expect(store.getState().homeSheet).toBeUndefined();
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: testid === 'home-retry' ? 'home-retry' : 'home-abort', args: { name: '' } });
  });

  it('a new home whose phone link would not start says why, how to fix it there, and where to turn it on later', async () => {
    act(() => store.getState().setMachines([{ name: 'studio', id: STUDIO, ssh: 'ada@studio', platform: 'linux-x64' }]));
    const OFF = {
      serving: false, url: '', port: 8443, logins: [], phones: [], error: 'Tailscale on studio does not let Svall share this fleet',
      fix: 'Run once on studio: sudo tailscale set --operator=$USER', run: 'sudo tailscale set --operator=$USER', raw: 'Access denied: serve config denied',
    };
    answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET }, 'mobile.get': OFF });
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'phone', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    await act(async () => { store.getState().hostDone('home', 0); store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    const failed = (await screen.findByTestId('mobile-problem')).parentElement!;
    expect(said(failed)).toEqual(['Tailscale on studio does not let Svall share this fleet', 'Run once on studio: sudo tailscale set --operator=$USER']);
    expect(raw(failed)).toBe('Access denied: serve config denied');
    expect(failed.textContent).toContain('Turn it on later in Settings → Phone.');
    fireEvent.click(within(failed).getByRole('button', { name: 'Open terminal' }));
    expect(store.getState().hostTerminal).toEqual({ run: 'sudo tailscale set --operator=$USER' });
  });

  it('the way back asks about this Mac, and says the sheet the other way', async () => {
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, here: 7, there: 3 } } });
    await open(true);
    expect(call).toHaveBeenCalledWith('fleet.homeCheck', { to: ME });
    expect(screen.getByTestId('home-title').textContent).toBe('Bring the fleet back to this Mac');
    expect(summary()[1]).toBe('robots: stay where they run · 3 here, 7 on studio');
    fireEvent.click(screen.getByTestId('home-go'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home', args: { name: 'local' } });
    expect(screen.getByTestId('home-step-adopt').textContent).toBe('This Mac takes over');
  });
});

describe('mission control in the check', () => {
  const MISSION = { ...SHEET, mission: [{ id: 'c_a', name: 'crew' }] };
  const WORKING = { ok: false, refusal: { reason: 'crew is working', action: INTERRUPT_ACTIONS.agent, details: [] } };
  // the check goes to this Mac's daemon, a robot's to the home that holds the fleet
  const local = vi.fn((_m: string, _p?: unknown): Promise<unknown> => Promise.resolve({ ok: true, sheet: MISSION }));
  const robots = (answer: (p: { interruptAfterMs?: number }) => unknown) => {
    local.mockClear();
    call.mockImplementation((method: string, p?: unknown) => Promise.resolve(method === 'robot.moveCheck' ? answer(p as never) : {}));
    app.api = () => ({ call, retryHome: vi.fn(), local: { call: local } }) as never;
  };
  const moveChecks = () => call.mock.calls.filter(([m]) => m === 'robot.moveCheck').map(([, p]) => p);

  it('one at work is asked about on the home, and the move sheet\'s choice is ticked in its words and goes with the move', async () => {
    robots((p) => (p.interruptAfterMs === undefined ? WORKING : { ok: true, sheet: {} }));
    await open();
    expect(local).toHaveBeenCalledWith('fleet.homeCheck', { to: STUDIO });
    const kept = await screen.findByTestId('home-interrupt');
    expect(kept.textContent).toBe('Interrupt it nowcrew is working');
    expect(moveChecks()).toEqual([
      { id: 'c_a', machine: STUDIO, homeMove: expect.stringMatching(/^hm_[0-9a-z]{10}$/) },
      { id: 'c_a', machine: STUDIO, homeMove: expect.stringMatching(/^hm_[0-9a-z]{10}$/), interruptAfterMs: 0 },
    ]);
    await go();
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home', args: { name: 'studio', interrupt: true } });
  });

  it('unticked, the robot at work stands as a refusal with the move sheet\'s button, and nothing goes', async () => {
    robots((p) => (p.interruptAfterMs === undefined ? WORKING : { ok: true, sheet: {} }));
    await open();
    fireEvent.click((await screen.findByTestId('home-interrupt')).querySelector('input')!);
    expect(said(await screen.findByTestId('home-crew-refusal'))).toEqual(['crew is working']);
    expect(screen.getByTestId('home-blocked')).toBeTruthy();
    expect(screen.queryByTestId('home-go')).toBeNull();
    fireEvent.click(screen.getByTestId('home-crew-action'));
    expect(await screen.findByTestId('home-interrupt')).toBeTruthy();
    expect(await screen.findByTestId('home-go')).toBeTruthy();
  });

  it('any other refusal of theirs shows in the check by the robot\'s name, and nothing goes', async () => {
    robots(() => ({ ok: false, refusal: { reason: 'claude is not logged in on studio', action: 'log in there', details: [] } }));
    await open();
    expect(said(await screen.findByTestId('home-crew-refusal'))).toEqual(['crew: claude is not logged in on studio', 'log in there']);
    expect(screen.queryByTestId('home-go')).toBeNull();
    expect(screen.getByTestId('home-again')).toBeTruthy();
  });

  it('on the way back they are asked about coming to this Mac', async () => {
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    robots(() => ({ ok: true, sheet: {} }));
    await open(true);
    await screen.findByTestId('home-go');
    expect(moveChecks()).toEqual([{ id: 'c_a', machine: ME, homeMove: expect.stringMatching(/^hm_/) }]);
    await go();
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home', args: { name: 'local' } });
  });
});

describe('a move nothing is driving', () => {
  const online = () => act(() => { store.getState().setStatus('online'); });

  it('says nothing with none under way', async () => {
    online();
    const { container } = render(<HomeMoveBanner />);
    await waitFor(() => expect(call).toHaveBeenCalledWith('fleet.homeMove', { op: 'status' }));
    expect(container.textContent).toBe('');
  });

  it('names where it goes, what a frozen home refuses, and where that machine stands, and offers to finish it or call it off', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'staged', phase: 'staged' } } });
    render(<HomeMoveBanner />);
    const said = (await screen.findByTestId('home-move-banner')).textContent;
    expect(said).toBe("The fleet is moving to studio. studio holds the fleet's files and has not taken over. This Mac takes no changes until the move ends; robots keep running.Finish the moveCall it off");
    expect(screen.getByTestId('home-move-banner').querySelector('b')!.textContent).toBe('The fleet is moving to studio.');
    expect(screen.getByTestId('home-move-answer').textContent).toBe("studio holds the fleet's files and has not taken over.");
    expect(screen.getByTestId('home-move-answer').parentElement!.className).toBe('banner-sub');
    fireEvent.click(screen.getByTestId('home-move-retry'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-retry', args: { name: '' } });
    act(() => { store.getState().hostDone('home-retry', 1); });
    expect(screen.getByTestId('home-move-abort').dataset.tip).toBe('Works once the machine that holds the move says it was not taken');
    fireEvent.click(screen.getByTestId('home-move-abort'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-abort', args: { name: '' } });
  });

  it('on a worker the move comes here, and stands down for the sheet that drives it', async () => {
    online();
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: ME, name: 'this mac', asks: false, from: 'studio' } } });
    const { rerender } = render(<HomeMoveBanner />);
    expect((await screen.findByTestId('home-move-banner')).textContent).toContain('The fleet is moving to this Mac. studio takes no changes until the move ends; robots keep running.');
    act(() => { store.getState().setHomeSheet({ to: STUDIO, name: 'studio', back: true }); });
    rerender(<HomeMoveBanner />);
    expect(screen.queryByTestId('home-move-banner')).toBeNull();
  });

  it('past the commit, with no home to follow, still calls this Mac this Mac', async () => {
    online();
    act(() => { store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, machine: ME }); });
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: ME, name: 'linus-mbp', asks: false } } });
    render(<HomeMoveBanner />);
    const said = (await screen.findByTestId('home-move-banner')).textContent;
    expect(said).toContain('moving to this Mac');
    expect(said).not.toContain('linus-mbp');
  });

  it('a poll that fails keeps the move it last heard of, its buttons and its words, until one answers', async () => {
    online();
    let polls = 0;
    const moving = { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true };
    call.mockImplementation((method: string) => {
      if (method !== 'fleet.homeMove') return Promise.resolve({});
      polls++;
      return polls === 1 ? Promise.resolve({ moving }) : polls === 2 ? Promise.reject(new Error('svalld connection closed')) : Promise.resolve({});
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      render(<HomeMoveBanner />);
      await screen.findByTestId('home-move-banner');
      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); });
      expect(polls).toBe(2);
      expect(screen.getByTestId('home-move-abort')).toBeTruthy();
      expect(store.getState().homeMove).toEqual(moving);
      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); });
      expect(polls).toBe(3);
      expect(screen.queryByTestId('home-move-banner')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a move coming here with no mark to stand says the old home is still the home, and offers only to clear it, with no word of an answer to wait for', async () => {
    online();
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: ME, name: 'this mac', asks: false, from: 'studio', unmarked: true } } });
    render(<HomeMoveBanner />);
    const said = (await screen.findByTestId('home-move-banner')).textContent;
    expect(said).toBe('A move to this Mac did not take hold. studio is still the home.Clear it');
    expect(screen.queryByTestId('home-move-retry')).toBeNull();
    expect(screen.getByTestId('home-move-abort').dataset.tip).toBeUndefined();
    fireEvent.click(screen.getByTestId('home-move-abort'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-abort', args: { name: '' } });
  });

  it('a machine whose background service has not started again says so', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'its daemon did not start again: failed to connect to bus', phase: 'stopping' } } });
    render(<HomeMoveBanner />);
    const said = await screen.findByTestId('home-move-answer');
    expect(said.textContent).toBe('studio went back as it was and has not started again.');
    expect(said.getAttribute('data-tip')).toMatch(/failed to connect to bus/);
  });

  it('a machine out of reach reads as a sentence, its own words behind it', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'ssh: connect to host studio port 22: Connection refused', phase: 'unreachable' } } });
    render(<HomeMoveBanner />);
    const said = await screen.findByTestId('home-move-answer');
    expect(screen.getByTestId('home-move-banner').querySelector('b')!.textContent).toBe('studio is not answering.');
    expect(said.textContent).toBe('The move to studio waits for it; this Mac takes no changes until then.');
    expect(said.getAttribute('data-tip')).toBe('ssh: connect to host studio port 22: Connection refused');
  });

  it('a machine that cannot say how the move went reads as a sentence, the move waiting', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'this folder does not serve the home that asks as a worker of its fleet', phase: 'unknown' } } });
    render(<HomeMoveBanner />);
    expect((await screen.findByTestId('home-move-answer')).textContent).toBe('studio cannot say how the move went; the move waits until it can.');
  });

  it('a press that fails says why and what to do in the window, and Call it off says it is at work', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } } });
    render(<HomeMoveBanner />);
    fireEvent.click(await screen.findByTestId('home-move-abort'));
    expect(screen.getByTestId('home-move-abort').textContent).toBe('Calling it off…');
    step('abort', 'fail', { detail: 'studio has not let go of it: staged', action: 'svall fleet home abort again once it answers, or svall fleet home retry', say: 'Call it off again once it answers, or finish the move' }, 'home-abort');
    act(() => { store.getState().hostDone('home-abort', 1); });
    expect(screen.getByTestId('home-move-failed').textContent).toBe('studio has not let go of it: staged. Call it off again once it answers, or finish the move.');
    expect(screen.getByTestId('home-move-failed').className).toBe('banner-sub');
    // the failure stands in place of how the move stands, so the banner ends on it
    expect(screen.getByTestId('home-move-banner').querySelector('span')!.textContent).toBe('The fleet is moving to studio. studio has not let go of it: staged. Call it off again once it answers, or finish the move.');
  });

  it('while Call it off runs, neither button takes a press', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } } });
    render(<HomeMoveBanner />);
    fireEvent.click(await screen.findByTestId('home-move-abort'));
    expect((screen.getByTestId('home-move-retry') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('home-move-abort') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the sheet\'s own run that failed past the mark says why alone, as its Close words were for the sheet', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, phase: 'rolledback' } } });
    render(<HomeMoveBanner />);
    await screen.findByTestId('home-move-banner');
    act(() => { store.getState().hostStarted('home', { name: 'studio' }); });
    step('adopt', 'fail', { detail: 'studio did not take the fleet: rolledback', action: 'svall fleet home abort, or svall fleet home retry', say: 'Close to finish the move or call it off' }, 'home');
    act(() => { store.getState().hostDone('home', 1); });
    expect(screen.getByTestId('home-move-failed').textContent).toBe('studio did not take the fleet: rolledback.');
  });

  it('a press while another run is under way starts nothing, and says so', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } } });
    render(<HomeMoveBanner />);
    act(() => { store.getState().hostStarted('doctor', { name: 'vault' }); });
    sent.length = 0;
    fireEvent.click(await screen.findByTestId('home-move-retry'));
    expect(sent).toEqual([]);
    expect(store.getState().host).toMatchObject({ op: 'doctor', running: true });
    expect(store.getState().toast?.text).toContain('Check');
  });
});

describe('mission control left away by a move that stopped', () => {
  const crew = (machine?: string) => act(() => {
    store.setState((s) => ({ fleet: { ...s.fleet, islands: { home: { id: 'home', kind: 'home' } }, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 0 } }, robots: { r1: { id: 'r1', name: 'golden heron', islandId: 'home', ...(machine && { machine, sentAhead: 'hm_abcdefghij' }) } } } }) as never);
  });

  it('says nothing with them on the home', () => {
    crew();
    const { container } = render(<CrewAwayBanner />);
    expect(container.textContent).toBe('');
  });

  it('names them and where they are, and offers to bring them back', () => {
    crew(STUDIO);
    render(<CrewAwayBanner />);
    expect(screen.getByTestId('crew-away-banner').textContent).toBe('Mission control\'s golden heron is still on studio. A move that stopped left it there.Bring it back');
    fireEvent.click(screen.getByTestId('crew-away-back'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-crew', args: { name: '' } });
  });

  it('names two as they, and this Mac as this Mac', () => {
    crew(ME);
    act(() => {
      store.setState((s) => ({ via: { machine: ME, home: STUDIO, name: 'studio', online: true }, fleet: { ...s.fleet, robots: { ...s.fleet.robots, r2: { ...s.fleet.robots.r1, id: 'r2', name: 'swift' } } } }) as never);
    });
    render(<CrewAwayBanner />);
    expect(screen.getByTestId('crew-away-banner').textContent).toBe('Mission control\'s golden heron and swift are still on this Mac. A move that stopped left them there.Bring them back');
  });

  it('names what could not come back, and stands down for a sheet that is moving them', () => {
    crew(STUDIO);
    const { rerender } = render(<CrewAwayBanner />);
    act(() => { store.getState().hostStarted('home-crew', { name: '' }); });
    rerender(<CrewAwayBanner />);
    expect((screen.getByTestId('crew-away-back') as HTMLButtonElement).disabled).toBe(true);
    act(() => { store.getState().hostStep('home-crew', { step: 'crew', status: 'fail', detail: 'these cannot come back: golden heron: dirty' } as never); store.getState().hostDone('home-crew', 1); });
    rerender(<CrewAwayBanner />);
    expect(screen.getByTestId('crew-away-failed').textContent).toContain('dirty');
    expect(screen.getByTestId('crew-away-banner').textContent).not.toContain('A move that stopped');
    act(() => { store.getState().setHomeSheet({ to: STUDIO, name: 'studio', back: false }); });
    rerender(<CrewAwayBanner />);
    expect(screen.queryByTestId('crew-away-banner')).toBeNull();
  });

  it('stands down while a move stands, where bringing them back can only fail', async () => {
    act(() => { store.getState().setStatus('online'); });
    crew(STUDIO);
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } } });
    render(<><HomeMoveBanner /><CrewAwayBanner /></>);
    await screen.findByTestId('home-move-banner');
    expect(screen.queryByTestId('crew-away-banner')).toBeNull();
  });

  it('one at work holding them back says why, and the second press carries the move sheet\'s choice in its words', () => {
    crew(STUDIO);
    const { rerender } = render(<CrewAwayBanner />);
    fireEvent.click(screen.getByTestId('crew-away-back'));
    step('crew', 'fail', { detail: 'these cannot come back: golden heron: golden heron is working; interrupt it now', action: 'try again once what they name is fixed; svall fleet home crew-back --interrupt-after 0 ends what they run', say: INTERRUPT_ACTIONS.agent }, 'home-crew');
    act(() => { store.getState().hostDone('home-crew', 1); });
    rerender(<CrewAwayBanner />);
    expect(screen.getByTestId('crew-away-failed').textContent).toContain('golden heron is working');
    expect(screen.getByTestId('crew-away-back').textContent).toBe('Interrupt it now');
    fireEvent.click(screen.getByTestId('crew-away-back'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-crew', args: { name: '', interrupt: true } });
  });
});
