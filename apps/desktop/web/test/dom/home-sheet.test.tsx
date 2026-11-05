// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { HomeSheet } = await import('../../src/HomeSheet.js');
const { HomeMoveBanner } = await import('../../src/HomeBanner.js');

const STUDIO = '66666666-7777-4888-9999-aaaaaaaaaaaa' as MachineId;
const ME = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const SHEET = { here: 3, there: 7, mission: [], toName: 'studio', rewrites: [] };

const answer = (methods: Record<string, unknown>) => call.mockImplementation((method: string) => Promise.resolve(methods[method] ?? {}));

beforeEach(() => { freshStore(); answer({ 'fleet.homeCheck': { ok: true, sheet: SHEET } }); });
afterEach(cleanup);

const open = async (back = false) => {
  act(() => { store.getState().setHomeSheet({ to: STUDIO, name: 'studio', back }); });
  render(<HomeSheet />);
  await screen.findAllByTestId(/home-summary|home-refusal|home-error/);
};
const step = (s: string, status: string, more = {}) => act(() => { store.getState().hostStep('home', { step: s, status, ...more } as never); });

describe('the sheet of a home move', () => {
  it('asks the check of where the fleet goes, and says what moves and where robots stay', async () => {
    await open();
    expect(call).toHaveBeenCalledWith('fleet.homeCheck', { to: STUDIO });
    expect(screen.getByTestId('home-title').textContent).toBe("Make studio this fleet's home");
    expect(screen.getByTestId('home-summary').textContent).toContain("The fleet's islands, notes, settings, phone pairing and push keys. Robots stay where they run: 3 here, 7 on studio.");
    expect(screen.getByTestId('home-go').textContent).toBe('Make it the home');
  });

  it('names mission control\'s robots, and each path it rewrites', async () => {
    answer({ 'fleet.homeCheck': { ok: true, sheet: { ...SHEET, mission: [{ id: 'c_a', name: 'crew' }, { id: 'c_b', name: 'crew2' }], rewrites: [{ key: 'defaultCwd', from: '/Users/ada/code', to: '~/code' }] } } });
    await open();
    expect(screen.getByTestId('home-mission').textContent).toBe("Mission control's 2 robots move to studio first.");
    expect(screen.getByTestId('home-rewrite').textContent).toBe('defaultCwd becomes ~/code');
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

  it('ends on the phone\'s new QR code', async () => {
    await open();
    fireEvent.click(screen.getByTestId('home-go'));
    for (const s of ['check', 'pause', 'copy', 'adopt', 'join', 'probe']) step(s, 'ok');
    act(() => { store.getState().hostDone('home', 0); });
    expect(screen.getByTestId('home-done').textContent).toContain('The fleet runs on studio. Open the phone from its new QR code once.');
    fireEvent.click(screen.getByTestId('home-finish'));
    expect(store.getState().homeSheet).toBeUndefined();
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

describe('a move nothing is driving', () => {
  const online = () => act(() => { store.getState().setStatus('online'); });

  it('says nothing with none under way', async () => {
    online();
    const { container } = render(<HomeMoveBanner />);
    await waitFor(() => expect(call).toHaveBeenCalledWith('fleet.homeMove', { op: 'status' }));
    expect(container.textContent).toBe('');
  });

  it('names where it goes and what that machine last said, and offers to finish it or call it off', async () => {
    online();
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'staged' } } });
    render(<HomeMoveBanner />);
    expect((await screen.findByTestId('home-move-banner')).textContent).toContain('Finishing the move to studio…');
    expect(screen.getByTestId('home-move-answer').textContent).toContain('staged');
    fireEvent.click(screen.getByTestId('home-move-retry'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-retry', args: { name: '' } });
    act(() => { store.getState().hostDone('home-retry', 1); });
    fireEvent.click(screen.getByTestId('home-move-abort'));
    expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'home-abort', args: { name: '' } });
  });

  it('on a worker the move comes here, and stands down for the sheet that drives it', async () => {
    online();
    act(() => { store.getState().setVia({ machine: ME, home: STUDIO, name: 'studio', online: true }); });
    answer({ 'fleet.homeMove': { moving: { id: 'hm_abcdefghij', to: ME, name: 'this mac', asks: false } } });
    const { rerender } = render(<HomeMoveBanner />);
    expect((await screen.findByTestId('home-move-banner')).textContent).toContain('Finishing the move to this Mac…');
    act(() => { store.getState().setHomeSheet({ to: STUDIO, name: 'studio', back: true }); });
    rerender(<HomeMoveBanner />);
    expect(screen.queryByTestId('home-move-banner')).toBeNull();
  });
});
