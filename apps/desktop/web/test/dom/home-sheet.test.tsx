// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPT_ACTIONS, type MachineId } from '@svall/protocol';
import { call, freshStore, sent, store } from './harness.js';

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

describe('the sheet of a home move', () => {
  it('asks the check of where the fleet goes, and says what moves and where robots stay', async () => {
    await open();
    expect(call).toHaveBeenCalledWith('fleet.homeCheck', { to: STUDIO });
    expect(screen.getByTestId('home-title').textContent).toBe("Make studio this fleet's home");
    expect(screen.getByTestId('home-summary').textContent).toContain("The fleet's islands, notes, settings, phone pairing and push keys. Robots stay where they run: 3 here, 7 on studio.");
    expect(screen.getByTestId('home-go').textContent).toBe('Make it the home');
  });

  it('names mission control\'s robots, and each path it rewrites', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, mission: [{ id: 'c_a', name: 'crew' }, { id: 'c_b', name: 'crew2' }], rewrites: [{ key: 'defaultCwd', to: '~/code' }] } } });
    await open();
    expect(screen.getByTestId('home-mission').textContent).toBe("Mission control's 2 robots move to studio first.");
    expect(screen.getByTestId('home-rewrite').textContent).toBe('defaultCwd becomes ~/code');
  });

  it('says of a rewritten path that the machine taking the fleet does not have it, and goes on', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, rewrites: [{ key: 'defaultCwd', to: '~/code', lacks: true }, { key: 'home.cwd', to: '~/crew' }] } } });
    await open();
    expect(screen.getAllByTestId('home-rewrite').map((r) => r.textContent)).toEqual(['defaultCwd becomes ~/code, which studio does not have yet', 'home.cwd becomes ~/crew']);
    expect(screen.getByTestId('home-go')).toBeTruthy();
  });

  it('lists every refusal with what to do, offers no way past them, and checks again', async () => {
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: 'studio is not reachable', action: 'try again when it is awake', details: [], more: [{ reason: 'studio2 is a worker of this fleet too', action: 'remove studio2 first, and add it again from studio' }] } } });
    await open();
    expect(screen.getAllByTestId('home-reason').map((r) => r.textContent)).toEqual(['studio is not reachable', 'studio2 is a worker of this fleet too']);
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
    act(() => { store.getState().hostDone('home', 0); });
    expect(screen.getByTestId('home-done').textContent).toContain('The fleet runs on studio. Open the phone from its new QR code once.');
    expect(call).not.toHaveBeenCalledWith('mobile.get', {});
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    expect(call).toHaveBeenCalledWith('mobile.get', {});
    fireEvent.click(screen.getByTestId('home-finish'));
    expect(store.getState().homeSheet).toBeUndefined();
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
    expect(screen.getByTestId('home-ended').textContent).toContain('143');
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
    step('adopt', 'fail', { detail: 'this machine asked, and studio did not take the fleet: rolledback', action: 'svall fleet home abort, or svall fleet home retry', say: 'Close to finish the move or call it off' });
    act(() => { store.getState().hostDone('home', 1); });
    const row = screen.getByTestId('home-step-adopt').textContent;
    expect(row).toContain('this Mac asked, and studio did not take the fleet');
    expect(row).toContain('Close to finish the move or call it off');
    expect(row).not.toContain('svall fleet');
  });

  it('a refusal calls this machine this Mac', async () => {
    answer({ 'fleet.homeCheck': { ok: false, sheet: SHEET, refusal: { reason: 'this machine has no Tailscale: not running', action: 'install Tailscale and sign in', details: [] } } });
    await open();
    expect(screen.getByTestId('home-reason').textContent).toBe('this Mac has no Tailscale: not running');
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

  it('the way back asks about this Mac, and says the sheet the other way', async () => {
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, here: 7, there: 3 } } });
    await open(true);
    expect(call).toHaveBeenCalledWith('fleet.homeCheck', { to: ME });
    expect(screen.getByTestId('home-title').textContent).toBe('Bring the fleet back to this Mac');
    expect(screen.getByTestId('home-summary').textContent).toContain('Robots stay where they run: 3 here, 7 on studio.');
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
    expect((await screen.findByTestId('home-crew-reason')).textContent).toBe('crew is working');
    expect(screen.queryByTestId('home-go')).toBeNull();
    fireEvent.click(screen.getByTestId('home-crew-action'));
    expect(await screen.findByTestId('home-interrupt')).toBeTruthy();
    expect(await screen.findByTestId('home-go')).toBeTruthy();
  });

  it('any other refusal of theirs shows in the check by the robot\'s name, and nothing goes', async () => {
    robots(() => ({ ok: false, refusal: { reason: 'claude is not logged in on studio', action: 'log in there', details: [] } }));
    await open();
    expect((await screen.findByTestId('home-crew-reason')).textContent).toBe('crew: claude is not logged in on studio');
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
    expect(said).toContain('The fleet is moving to studio, and this Mac takes no changes until the move ends; robots keep running.');
    expect(screen.getByTestId('home-move-answer').textContent).toBe(" studio holds the fleet's files and has not taken over.");
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
    expect((await screen.findByTestId('home-move-banner')).textContent).toContain('The fleet is moving to this Mac, and studio takes no changes until the move ends');
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
    expect(said).toContain('A move of the fleet to this Mac has not taken hold, and studio is still the home.');
    expect(said).not.toContain('takes no changes');
    expect(screen.queryByTestId('home-move-retry')).toBeNull();
    expect(screen.getByTestId('home-move-abort').dataset.tip).toBeUndefined();
    fireEvent.click(screen.getByTestId('home-move-abort'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-abort', args: { name: '' } });
  });

  it('a machine whose daemon has not started again says so', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'its daemon did not start again: failed to connect to bus', phase: 'stopping' } } });
    render(<HomeMoveBanner />);
    const said = await screen.findByTestId('home-move-answer');
    expect(said.textContent).toBe(' studio went back as it was, and its daemon has not started again.');
    expect(said.getAttribute('data-tip')).toMatch(/failed to connect to bus/);
  });

  it('a machine out of reach reads as a sentence, its own words behind it', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'ssh: connect to host studio port 22: Connection refused', phase: 'unreachable' } } });
    render(<HomeMoveBanner />);
    const said = await screen.findByTestId('home-move-answer');
    expect(said.textContent).toBe(' studio does not answer; the move waits until it does.');
    expect(said.getAttribute('data-tip')).toBe('ssh: connect to host studio port 22: Connection refused');
  });

  it('a machine that cannot say how the move went reads as a sentence, the move waiting', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'this folder does not serve the home that asks as a worker of its fleet', phase: 'unknown' } } });
    render(<HomeMoveBanner />);
    expect((await screen.findByTestId('home-move-answer')).textContent).toBe(' studio cannot say how the move went; the move waits until it can.');
  });

  it('a press that fails says why and what to do in the window, and Abort says it is at work', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } } });
    render(<HomeMoveBanner />);
    fireEvent.click(await screen.findByTestId('home-move-abort'));
    expect(screen.getByTestId('home-move-abort').textContent).toBe('Calling it off…');
    step('abort', 'fail', { detail: 'studio has not let go of it: staged', action: 'svall fleet home abort again once it answers, or svall fleet home retry', say: 'Call it off again once it answers, or finish the move' }, 'home-abort');
    act(() => { store.getState().hostDone('home-abort', 1); });
    expect(screen.getByTestId('home-move-failed').textContent).toBe(' studio has not let go of it: staged. Call it off again once it answers, or finish the move');
  });

  it('while Abort runs, neither button takes a press', async () => {
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
    expect(screen.getByTestId('home-move-failed').textContent).toBe(' studio did not take the fleet: rolledback');
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
    store.setState((s) => ({ fleet: { ...s.fleet, islands: { home: { id: 'home', kind: 'home' } }, robots: { r1: { id: 'r1', name: 'golden heron', islandId: 'home', ...(machine && { machine, sentAhead: 'hm_abcdefghij' }) } } } }) as never);
  });

  it('says nothing with them on the home', () => {
    crew();
    const { container } = render(<CrewAwayBanner />);
    expect(container.textContent).toBe('');
  });

  it('names them, and offers to bring them back', () => {
    crew(STUDIO);
    render(<CrewAwayBanner />);
    expect(screen.getByTestId('crew-away-banner').textContent).toContain('golden heron');
    fireEvent.click(screen.getByTestId('crew-away-back'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-crew', args: { name: '' } });
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
