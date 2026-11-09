// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { bridge, freshStore, store } from './harness.js';
import { isVeiled } from '../../src/selectors.js';

const here = vi.hoisted(() => vi.fn());
const there = vi.hoisted(() => vi.fn());
vi.mock('../../src/boot.js', async () => {
  const made = (await import('./harness.js')).bootModule();
  return { ...made, app: Object.defineProperties({ ...made.app }, { store: { get: () => Object.getOwnPropertyDescriptor(made.app, 'store')!.get!() }, api: { value: () => ({ call: there, local: { call: here } }) } }) };
});
vi.mock('../../src/resources/load.js', () => ({ reloadResources: () => Promise.resolve() }));

const { SeedSheet } = await import('../../src/SeedSheet.js');
const { installKeyHandlers } = await import('../../src/keyboard.js');

const ME = 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId;
const HOME = 'bbbbbbbb-0000-4000-8000-000000000000' as MachineId;
const KEY = { key: 'claude:mcp:a', status: 'warn', detail: 'a key', tick: { item: 'claude:mcp:a', fields: ['env.A'], on: false, preview: ['env.A ****'] } };

const answer = (mine: boolean, far: boolean) => {
  here.mockImplementation((m: string) => Promise.resolve(m === 'machines.holdsSetup' ? { holds: mine } : { rows: [KEY] }));
  there.mockImplementation((m: string) => Promise.resolve(m === 'machines.holdsSetup' ? { holds: far } : { sent: 3 }));
};
const following = (o: { master?: boolean } = {}) => {
  store.getState().setShell({ home: '/u/.svall-a', log: [], op: false } as never);
  store.getState().setVia({ machine: ME, home: HOME, name: 'studio', online: true });
  store.getState().setHome({ name: 'studio', state: 'connected', ...(o.master !== false && { master: '/tmp/m' }) } as never);
};
const copies = () => there.mock.calls.filter(([m]) => m === 'machines.copySetupFrom');

beforeEach(() => { freshStore(); localStorage.clear(); here.mockReset(); there.mockReset(); answer(true, false); });
afterEach(cleanup);

describe('the first copy of an agent setup onto a far home', () => {
  it('is offered once a window reaches a home with none, on a Mac that holds one, with its key rows, and veils the terminals', async () => {
    following();
    render(<SeedSheet />);
    expect(await screen.findByTestId('seed-title')).toHaveProperty('textContent', 'studio has no agent setup yet');
    await screen.findByTestId('setup-tick-claude:mcp:a');
    expect(isVeiled(store.getState())).toBe(true);
    expect(copies()).toEqual([]);
  });

  it('asks nothing of a home that holds one, or a Mac with none, or a window with no way to the home', async () => {
    for (const [mine, far, master] of [[true, true, true], [false, false, true], [true, false, false]] as const) {
      freshStore();
      answer(mine, far);
      following({ master });
      const { unmount } = render(<SeedSheet />);
      await new Promise((r) => { setTimeout(r, 0); });
      expect(screen.queryByTestId('seed-sheet')).toBeNull();
      unmount();
    }
  });

  it('sends a person\'s ticks to this Mac\'s daemon, and the one Copy to the home, as a seed; the sheet goes and does not come back', async () => {
    following();
    const { unmount } = render(<SeedSheet />);
    fireEvent.click(await screen.findByTestId('setup-tick-claude:mcp:a'));
    await waitFor(() => expect(here).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:a', fields: ['env.A'], on: true }));
    await waitFor(() => expect(screen.getByTestId('seed-copy').hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByTestId('seed-copy'));
    await waitFor(() => expect(screen.queryByTestId('seed-sheet')).toBeNull());
    expect(copies()).toEqual([['machines.copySetupFrom', { machine: ME, seed: true }]]);
    expect(isVeiled(store.getState())).toBe(false);
    unmount();
    there.mockClear();
    render(<SeedSheet />);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(there).not.toHaveBeenCalled();
  });

  it('Not now copies nothing and is not asked again in this fleet', async () => {
    following();
    const { unmount } = render(<SeedSheet />);
    fireEvent.click(await screen.findByTestId('seed-no'));
    expect(screen.queryByTestId('seed-sheet')).toBeNull();
    expect(copies()).toEqual([]);
    unmount();
    here.mockClear();
    render(<SeedSheet />);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(here).not.toHaveBeenCalled();
  });

  it.each([['in the sheet', true], ['that has left it', false]])('answers Esc as Not now, with the focus %s: what lies behind stays, nothing is copied, and it is not asked again', async (_where, inside) => {
    const off = installKeyHandlers({ store, api: { call: there } as never, bridge });
    try {
      following();
      store.getState().toggleSettings(true);
      render(<SeedSheet />);
      await screen.findByTestId('setup-tick-claude:mcp:a');
      expect(screen.getByTestId('seed-sheet').contains(document.activeElement)).toBe(true);
      if (!inside) (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(store.getState().seedAsk).toBeUndefined();
      expect(store.getState().settingsOpen).toBe(true);
      expect(copies()).toEqual([]);
      expect(localStorage.getItem('svall.seedAsked@/u/.svall-a')).toBe('1');
    } finally { off(); }
  });

  it('holds through Esc while its Copy runs', async () => {
    const off = installKeyHandlers({ store, api: { call: there } as never, bridge });
    try {
      following();
      let landed: (v: { sent: number }) => void = () => {};
      there.mockImplementation((m: string) => (m === 'machines.holdsSetup' ? Promise.resolve({ holds: false }) : new Promise((r) => { landed = r; })));
      render(<SeedSheet />);
      await screen.findByTestId('setup-tick-claude:mcp:a');
      fireEvent.click(screen.getByTestId('seed-copy'));
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.getByTestId('seed-sheet')).toBeTruthy();
      landed({ sent: 1 });
      await waitFor(() => expect(screen.queryByTestId('seed-sheet')).toBeNull());
    } finally { off(); }
  });

  describe('while its Copy runs, with the focus left the sheet', () => {
    const running = async () => {
      let landed: (v: { sent: number }) => void = () => {};
      let failed: (e: Error) => void = () => {};
      there.mockImplementation((m: string) => (m === 'machines.holdsSetup' ? Promise.resolve({ holds: false }) : new Promise((resolve, reject) => { landed = resolve; failed = reject; })));
      following();
      store.getState().toggleSettings(true);
      render(<SeedSheet />);
      await screen.findByTestId('setup-tick-claude:mcp:a');
      fireEvent.click(screen.getByTestId('seed-copy'));
      await waitFor(() => expect(copies()).toHaveLength(1));
      (document.activeElement as HTMLElement).blur();
      expect(screen.getByTestId('seed-sheet').contains(document.activeElement)).toBe(false);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      return { land: () => landed({ sent: 1 }), fail: (m: string) => failed(new Error(m)) };
    };

    it('Esc does nothing: the sheet stays, what lies behind stays, and it is not answered', async () => {
      const off = installKeyHandlers({ store, api: { call: there } as never, bridge });
      try {
        const { land } = await running();
        expect(screen.getByTestId('seed-sheet')).toBeTruthy();
        expect(store.getState().settingsOpen).toBe(true);
        expect(localStorage.getItem('svall.seedAsked@/u/.svall-a')).toBeNull();
        land();
        await waitFor(() => expect(screen.queryByTestId('seed-sheet')).toBeNull());
      } finally { off(); }
    });

    it('a failure from it is still said, and Esc answers again once it has ended', async () => {
      const off = installKeyHandlers({ store, api: { call: there } as never, bridge });
      try {
        const { fail } = await running();
        fail('this home holds an agent setup of its own');
        expect((await screen.findByTestId('seed-failed')).textContent).toContain('holds an agent setup');
        (document.activeElement as HTMLElement).blur();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(store.getState().seedAsk).toBeUndefined();
      } finally { off(); }
    });

    it('offers no ×, and gives it back once a failed Copy has ended', async () => {
      const off = installKeyHandlers({ store, api: { call: there } as never, bridge });
      try {
        const { fail } = await running();
        expect(screen.queryByTestId('seed-close')).toBeNull();
        fail('this home holds an agent setup of its own');
        fireEvent.click(await screen.findByTestId('seed-close'));
        expect(store.getState().seedAsk).toBeUndefined();
      } finally { off(); }
    });
  });

  it('stays, saying why, when the home refuses or the copy fails', async () => {
    following();
    there.mockImplementation((m: string) => (m === 'machines.holdsSetup' ? Promise.resolve({ holds: false }) : Promise.reject(new Error('this home holds an agent setup of its own'))));
    render(<SeedSheet />);
    await screen.findByTestId('setup-tick-claude:mcp:a');
    fireEvent.click(screen.getByTestId('seed-copy'));
    expect((await screen.findByTestId('seed-failed')).textContent).toContain('holds an agent setup');
    expect(screen.getByTestId('seed-sheet')).toBeTruthy();
  });
});
