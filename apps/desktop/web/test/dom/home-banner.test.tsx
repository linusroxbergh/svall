// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import type { HomeLink } from '../../src/store/fleet.js';
import { freshStore, retryHome, sent, store } from './harness.js';
import { HomeBanner } from '../../src/HomeBanner.js';
import { TerminalArea } from '../../src/TerminalArea.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const ME = 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId;
const HOME = 'bbbbbbbb-0000-4000-8000-000000000000' as MachineId;
const VIA = { machine: ME, home: HOME, name: 'studio' };

beforeEach(() => { freshStore(); retryHome.mockClear(); });
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
    standingIn({ state: 'unreachable', detail: 'ssh: Connection refused' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toContain('studio is not reachable');
    expect(screen.getByTestId('home-detail').textContent).toContain('Connection refused');
    expect(screen.getByTestId('home-age').textContent).toMatch(/showing the fleet as of .*2026/);
    fireEvent.click(screen.getByTestId('home-retry'));
    expect(retryHome).toHaveBeenCalledTimes(1);
  });

  it('shows a mismatch in the words the daemon gives, and goes to no other home', () => {
    standingIn({ state: 'unreachable', detail: 'studio answered with fleetId x, not y' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-detail').textContent).toContain('answered with fleetId x');
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('names a refused login with what to do, with no upgrade to press', () => {
    standingIn({ state: 'auth', detail: 'Permission denied (publickey); run ssh ada@studio once in a terminal, then try again' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toContain("studio refused this Mac's login");
    expect(screen.getByTestId('home-retry')).toBeTruthy();
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('offers to upgrade a home behind this Mac, runs host upgrade, and asks again once it ends', async () => {
    standingIn({ state: 'version', release: '0.20', detail: 'studio runs 0.20, this Mac 0.21' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toContain('studio runs 0.20, this Mac 0.21');
    fireEvent.click(screen.getByTestId('home-upgrade'));
    expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: 'studio' } });
    expect((screen.getByTestId('home-upgrade') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('home-upgrade').textContent).toBe('Upgrading studio…');
    expect(retryHome).not.toHaveBeenCalled();
    store.getState().hostDone('upgrade', 0);
    await waitFor(() => expect(retryHome).toHaveBeenCalledTimes(1));
  });

  it('says an upgrade failed in its own words, and leaves the button', async () => {
    standingIn({ state: 'version', detail: 'studio runs 0.20, this Mac 0.21' });
    render(<HomeBanner />);
    fireEvent.click(screen.getByTestId('home-upgrade'));
    store.getState().hostStep('upgrade', { step: 'release', status: 'fail', detail: 'this build publishes no companion for linux-x64' } as never);
    store.getState().hostDone('upgrade', 1);
    await waitFor(() => expect(screen.getByTestId('home-upgrade-failed').textContent).toContain('no companion'));
    expect((screen.getByTestId('home-upgrade') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends a person to update this Mac when the home is ahead of it, with no upgrade to press', () => {
    standingIn({ state: 'version', newer: true, detail: 'studio runs 0.22, this Mac 0.21' });
    render(<HomeBanner />);
    expect(screen.getByTestId('home-banner').textContent).toContain('update Svall on this Mac');
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
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
