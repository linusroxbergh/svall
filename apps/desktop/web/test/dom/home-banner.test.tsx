// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import type { HomeLink } from '../../src/store/fleet.js';
import { bridge, call, freshStore, retryHome, sent, store } from './harness.js';
import { HomeBanner } from '../../src/HomeBanner.js';
import { TerminalArea } from '../../src/TerminalArea.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const ME = 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId;
const HOME = 'bbbbbbbb-0000-4000-8000-000000000000' as MachineId;
const VIA = { machine: ME, home: HOME, name: 'studio' };

beforeEach(() => { freshStore(); retryHome.mockClear(); call.mockReset(); });
afterEach(cleanup);

const standingIn = (home: Omit<HomeLink, 'name'>) => {
  store.getState().setVia(VIA);
  store.getState().setHome({ name: 'studio', ...home });
};

describe('the banner of a home this window cannot follow', () => {
  it('says nothing on a Mac that is the home, or while it follows the far one, or has yet to hear', () => {
    const { container, rerender } = render(<HomeBanner />);
    expect(container.textContent).toBe('');
    store.getState().setVia({ ...VIA, online: true });
    store.getState().setHome({ name: 'studio', state: 'connected' });
    rerender(<HomeBanner />);
    expect(screen.queryByTestId('home-banner')).toBeNull();
    store.getState().setVia(VIA);
    store.getState().setHome({ name: 'studio', state: 'connecting' });
    rerender(<HomeBanner />);
    expect(screen.queryByTestId('home-banner')).toBeNull();
  });

  it('names a home out of reach, the age of the copy shown, and asks again for a person', () => {
    store.getState().setFleet({ ...store.getState().fleet, machines: { [HOME]: { name: 'studio', reachable: false, since: 0, snapshot: { version: 1, at: new Date('2026-11-04T10:00:00').getTime() } } } });
    standingIn({ state: 'unreachable' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toMatch(/^studio is not reachable\. Showing the fleet as of [^;]*; robots on this Mac keep working\.Try again$/);
    // dated as Machines dates a check, with no year
    expect(screen.getByTestId('home-age').textContent).not.toMatch(/2026/);
    expect(screen.getByTestId('home-banner').querySelector('b')!.textContent).toBe('studio is not reachable.');
    expect(screen.queryByTestId('home-detail')).toBeNull();
    expect(screen.getByTestId('home-age').className).toBe('banner-sub');
    expect(screen.getByTestId('home-banner').querySelector('small')).toBeNull();
    fireEvent.click(screen.getByTestId('home-retry'));
    expect(retryHome).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another fleet', 'mismatch', 'studio holds a different fleet than this Mac expects (x… there, y… here)', 'studio holds a different fleet than this Mac expects.', 'x… there, y… here'],
    ['another machine', 'machine', 'studio answered with machineId x, not y', 'studio answered with machineId x, not y.', undefined],
  ] as const)('shows %s in the words the daemon gives, the ids it compared in a tip, and goes to no other home', (_what, state, detail, said, tip) => {
    standingIn({ state, detail });
    render(<HomeBanner />);
    // a fact and what the window shows meanwhile, as the other banners
    expect(screen.getByTestId('home-banner').textContent).toBe(`${said} Robots on this Mac keep working.Try again`);
    expect(screen.getByTestId('home-banner').querySelector('b')!.dataset.tip).toBe(tip);
    expect(screen.queryByTestId('home-detail')).toBeNull();
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('names a refused login with what to do, with no upgrade to press', () => {
    standingIn({ state: 'auth', detail: 'run ssh ada@studio once in a terminal, then try again' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toBe('This Mac cannot log in to studio. Run ssh ada@studio once in a terminal, then try again.CopyTry again');
    // the command alone is mono, whole, and Copy beside the buttons copies it for a terminal on this Mac
    expect([...screen.getByTestId('home-detail').querySelectorAll('code')].map((c) => c.textContent)).toEqual(['ssh ada@studio']);
    bridge.present = true;
    try { fireEvent.click(screen.getByTestId('home-copy')); } finally { bridge.present = false; }
    expect(sent).toContainEqual({ type: 'copy', text: 'ssh ada@studio' });
    expect(screen.getByTestId('home-copy').textContent).toBe('Copied');
    expect(screen.getByTestId('home-retry')).toBeTruthy();
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('offers to upgrade a home behind this Mac, with both releases, runs host upgrade, and asks again once it ends', async () => {
    call.mockImplementation((m: string) => Promise.resolve(m === 'system.info' ? { release: '0.21' } : {}));
    standingIn({ state: 'version', release: '0.20', detail: 'studio runs an older Svall than this Mac (0.20, here 0.21); upgrade it to reach its robots' });
    render(<HomeBanner />);
    await waitFor(() => expect(screen.getByTestId('home-banner').textContent).toBe('studio runs an older Svall than this Mac. 0.20 there, 0.21 here.Upgrade studioTry again'));
    fireEvent.click(screen.getByTestId('home-upgrade'));
    expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: HOME } });
    expect((screen.getByTestId('home-upgrade') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('home-upgrade').textContent).toBe('Upgrading studio…');
    expect(retryHome).not.toHaveBeenCalled();
    store.getState().hostDone('upgrade', 0);
    await waitFor(() => expect(retryHome).toHaveBeenCalledTimes(1));
  });

  it('says a version the page found itself in the card\'s words', () => {
    standingIn({ state: 'version' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toMatch(/^studio runs another version of Svall/);
  });

  it('says an upgrade failed in its own words, a tool\'s behind them, and leaves the button', async () => {
    standingIn({ state: 'version', release: '0.20' });
    render(<HomeBanner />);
    fireEvent.click(screen.getByTestId('home-upgrade'));
    store.getState().hostStep('upgrade', { step: 'release', status: 'fail', detail: 'this build publishes no companion for linux-x64' } as never);
    store.getState().hostDone('upgrade', 1);
    await waitFor(() => expect(screen.getByTestId('home-upgrade-failed').textContent).toBe('this build publishes no companion for linux-x64.'));
    expect(screen.getByTestId('home-upgrade-failed').className).toBe('banner-sub');
    expect((screen.getByTestId('home-upgrade') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('home-upgrade'));
    store.getState().hostStep('upgrade', { step: 'install', status: 'fail', detail: 'the install did not finish: svall setup exited 1: no space left on device' } as never);
    store.getState().hostDone('upgrade', 1);
    await waitFor(() => expect(screen.getByTestId('home-upgrade-failed').textContent).toBe('the install did not finish: svall setup.'));
    expect(screen.getByTestId('home-upgrade-failed').dataset.tip).toBe('exited 1: no space left on device');

    fireEvent.click(screen.getByTestId('home-upgrade'));
    store.getState().hostStep('upgrade', { step: 'install', status: 'fail', detail: 'the install did not finish', raw: 'E: dpkg was interrupted' } as never);
    store.getState().hostDone('upgrade', 1);
    await waitFor(() => expect(screen.getByTestId('home-upgrade-failed').dataset.tip).toBe('E: dpkg was interrupted'));
  });

  it('names a home ahead of this Mac, with both releases and no upgrade to press', async () => {
    call.mockImplementation((m: string) => Promise.resolve(m === 'system.info' ? { release: '0.21' } : {}));
    standingIn({ state: 'version', newer: true, release: '0.22', detail: 'studio runs a newer Svall than this Mac (0.22, here 0.21); update Svall on this Mac' });
    render(<HomeBanner />);
    await waitFor(() => expect(screen.getByTestId('home-banner').textContent).toBe('studio runs a newer Svall than this Mac. 0.22 there, 0.21 here.Try again'));
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('says why it cannot run there in the daemon\'s words when there is no release to name', () => {
    standingIn({ state: 'version', detail: 'this Mac does not know where svall is on studio; enrol it again with svall fleet enroll-worker there' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toBe('this Mac does not know where svall is on studio; enrol it again with svall fleet enroll-worker there.Upgrade studioTry again');
    expect(call).not.toHaveBeenCalledWith('system.info', {});
  });
});

describe('the fallback view of a far robot', () => {
  it('shows its last screen under the home\'s name, and this machine\'s robot its terminal', async () => {
    const { fleet } = store.getState();
    store.getState().setFleet({ ...fleet, robots: { ...fleet.robots, c1: { ...fleet.robots.c1, machine: ME } } });
    store.getState().setVia(VIA);
    const { rerender } = render(<TerminalArea id="c0" />);
    expect(screen.getByText('studio is not reachable')).toBeTruthy();
    rerender(<TerminalArea id="c1" />);
    expect(screen.queryByText('studio is not reachable')).toBeNull();
  });
});
