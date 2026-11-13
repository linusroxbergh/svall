// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type LimitsReport, type MachineId } from '@svall/protocol';
import { bridge, call, freshStore, sent, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SettingsCard } = await import('../../src/SettingsCard.js');
const { HostSetup } = await import('../../src/HostSetup.js');
const { Toast } = await import('../../src/Toast.js');
const { followLimitsAsk, limitHit } = await import('../../src/limitsAsk.js');

const MAC = 'aaaaaaaa-0000-4000-8000-000000000000' as MachineId;
const STUDIO = 'bbbbbbbb-0000-4000-8000-000000000000' as MachineId;
const VAULT = 'cccccccc-0000-4000-8000-000000000000' as MachineId;
const SIZE = { cores: 12, memoryMb: 96256 };
const UNSET: LimitsReport = { size: SIZE, suggested: { cpus: 11, memoryMb: 95232 }, limits: {}, state: 'none', heldMb: 6349 };
const SET: LimitsReport = { ...UNSET, limits: { cpus: 11, memoryMb: 95232 }, state: 'applied' };
const LIST = [
  { id: MAC, name: 'mac', role: 'home', platform: 'darwin', reachable: true, robots: 1 },
  { id: STUDIO, name: 'studio', role: 'worker', platform: 'linux', reachable: true, robots: 2 },
];

/** The daemon's answers: the fleet's machines, and each Linux machine's limits by id. */
function daemon(limits: Partial<Record<MachineId, LimitsReport | Error>>, list: object[] = LIST) {
  call.mockImplementation((method: string, params?: unknown) => {
    const p = params as { machine?: MachineId; cpus?: number | null; memoryMb?: number | null };
    if (method === 'machines.list') return Promise.resolve({ machines: list });
    if (method === 'machines.limits') { const r = limits[p.machine!]; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); }
    if (method === 'machines.setLimits') {
      const set = { ...(p.cpus && { cpus: p.cpus }), ...(p.memoryMb && { memoryMb: p.memoryMb }) };
      return Promise.resolve({ ...limits[p.machine!], limits: set, state: p.cpus || p.memoryMb ? 'applied' : 'none' });
    }
    return Promise.resolve({ serving: false, logins: [], phones: [] });
  });
}

const machines = async () => {
  act(() => { store.getState().setStatus('online'); store.getState().setMachines([]); });
  render(<SettingsCard />);
  fireEvent.click(screen.getByTestId('settings-tab-machines'));
  await screen.findByTestId('machine-studio');
};
const row = (name: string) => screen.queryByTestId(`machine-limits-${name}`);
const value = async (name: string) => (await within(screen.getByTestId(`machine-limits-${name}`)).findByTestId('limits-value')).textContent;
const field = (part: 'cores' | 'memory') => screen.getByTestId(`limits-${part}`) as HTMLInputElement;
/** A `Said` in `in`: its line, the fix under it, and what waits behind details. */
const said = (inside: HTMLElement) => ({
  line: inside.querySelector('.said > div > span')!.textContent,
  fix: inside.querySelector('.said .set-note, .said .modal-sub')?.textContent,
  raw: inside.querySelector('.said .modal-more-body')?.textContent,
});

beforeEach(() => {
  freshStore();
  localStorage.clear();
});

describe('a machine\'s limits in Settings → Machines', () => {
  test('a Linux machine says what this fleet may use of it, between its address and its last line; a Mac has no such row and is not asked', async () => {
    daemon({ [STUDIO]: SET });
    await machines();
    expect(await value('studio')).toBe('11 of 12 cores · 93 of 94 GB');
    const block = screen.getByTestId('machine-studio');
    expect([...block.children].map((c) => c.className)).toEqual(['machine-dot', 'machine-name', 'machine-meta', 'machine-rows']);
    expect(row('mac')).toBeNull();
    expect(call.mock.calls.filter(([m]) => m === 'machines.limits')).toEqual([['machines.limits', { machine: STUDIO }]]);
  });

  test('no limit, part of one, and a machine not joined or not reachable, which is not asked', async () => {
    daemon({ [STUDIO]: UNSET, [VAULT]: { ...SET, limits: { memoryMb: 8192 } } }, [...LIST,
      { id: VAULT, name: 'vault', role: 'worker', platform: 'linux', reachable: true, robots: 0 },
      { id: 'dddddddd-0000-4000-8000-000000000000', name: 'away', role: 'worker', platform: 'linux', reachable: false, robots: 0 },
      { id: 'eeeeeeee-0000-4000-8000-000000000000', name: 'new', role: 'worker', platform: 'linux', reachable: false, robots: 0, joining: '' }]);
    await machines();
    expect(await value('studio')).toBe('no limit');
    expect(await value('vault')).toBe('all 12 cores · 8 of 94 GB');
    expect([row('away'), row('new')]).toEqual([null, null]);
  });

  test('a limit that does not hold says why in a line, systemd\'s words behind details, and how often the fleet reached it', async () => {
    daemon({ [STUDIO]: { ...SET, state: 'outside', hits: 3, lastHit: Date.UTC(2026, 10, 12, 14, 2) } });
    await machines();
    const said = await screen.findByTestId('limits-said');
    expect(said.querySelector('.said')!.getAttribute('data-mark')).toBe('warn');
    expect(said.querySelector('.said > div > span')!.textContent).toBe('robots on studio run outside the limit');
    expect(said.querySelector('.modal-more-body')!.textContent).toMatch(/^the fleet's terminals run outside its unit, on a tmux Svall did not bring/);
    const at = new Date(Date.UTC(2026, 10, 12, 14, 2)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByTestId('limits-hits').textContent).toBe(`reached its memory limit 3 times, last ${at}`);
  });

  test('one that cannot be read says why, with Read again', async () => {
    daemon({ [STUDIO]: new ApiError('not_supported', 'studio runs a release that takes no limit; upgrade it under Machines') });
    await machines();
    const r = await screen.findByTestId('limits-read');
    expect(said(row('studio')!)).toEqual({ line: 'studio runs a release that takes no limit', fix: 'Upgrade it under Machines', raw: undefined });
    daemon({ [STUDIO]: SET });
    fireEvent.click(r);
    expect(await value('studio')).toBe('11 of 12 cores · 93 of 94 GB');
  });

  test('Change opens the editor with the default for a machine with none and what the fleet holds now; Save sets it, an empty field for no limit on that part', async () => {
    daemon({ [STUDIO]: UNSET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    expect(screen.getByTestId('limits-change').textContent).toBe('Cancel');
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    expect(screen.getByTestId('limits-held').textContent).toBe('in use now6.2 GB');
    // No limit has nothing to take away from a machine that holds none
    expect((screen.getByTestId('limits-none') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field('cores'), { target: { value: '' } });
    fireEvent.change(field('memory'), { target: { value: '200' } });
    const save = screen.getByTestId('limits-save') as HTMLButtonElement;
    expect([save.disabled, save.dataset.tip]).toEqual([true, '0.5 to 94 GB']);
    fireEvent.change(field('memory'), { target: { value: '64' } });
    fireEvent.click(save);
    expect(call).toHaveBeenCalledWith('machines.setLimits', { machine: STUDIO, cpus: null, memoryMb: 65536 });
    await waitFor(() => expect(screen.queryByTestId('limits-edit')).toBeNull());
    expect(await value('studio')).toBe('all 12 cores · 64 of 94 GB');
  });

  test('a refusal is said in the editor, which stays open, as a line with its fix under it and a tool\'s words behind details', async () => {
    daemon({ [STUDIO]: SET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    call.mockImplementationOnce(() => Promise.reject(new ApiError('invalid', '6.2 GB is in use now; stop a robot or allow at least 7 GB')));
    fireEvent.click(screen.getByTestId('limits-save'));
    expect(said(await screen.findByTestId('limits-error'))).toEqual({ line: '6.2 GB is in use now', fix: 'Stop a robot or allow at least 7 GB', raw: undefined });
    call.mockImplementationOnce(() => Promise.reject(new Error('studio did not answer within 30000ms: timed out')));
    fireEvent.click(screen.getByTestId('limits-save'));
    await waitFor(() => expect(said(screen.getByTestId('limits-error'))).toEqual({ line: 'studio did not answer', fix: undefined, raw: 'within 30000ms: timed out' }));
  });

  test('a wrong field is said in one line under its row, and an edit clears a refusal', async () => {
    daemon({ [STUDIO]: SET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    call.mockImplementationOnce(() => Promise.reject(new ApiError('invalid', '6.2 GB is in use now; stop a robot or allow at least 7 GB')));
    fireEvent.click(screen.getByTestId('limits-save'));
    await screen.findByTestId('limits-error');
    fireEvent.change(field('cores'), { target: { value: '20' } });
    expect(screen.queryByTestId('limits-error')).toBeNull();
    const wrong = () => screen.getAllByTestId('limits-wrong').map((w) => [w.previousElementSibling, w.textContent]);
    expect(wrong()).toEqual([[field('cores').closest('.row'), '1 to 12 cores']]);
    expect((screen.getByTestId('limits-save') as HTMLButtonElement).dataset.tip).toBe('1 to 12 cores');
    fireEvent.change(field('cores'), { target: { value: '8' } });
    fireEvent.change(field('memory'), { target: { value: '0.2' } });
    expect(wrong()).toEqual([[field('memory').closest('.row'), '0.5 to 94 GB']]);
  });

  test('No limit takes a set limit off', async () => {
    daemon({ [STUDIO]: SET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    fireEvent.click(screen.getByTestId('limits-none'));
    expect(call).toHaveBeenLastCalledWith('machines.setLimits', { machine: STUDIO, cpus: null, memoryMb: null });
    expect(await within(row('studio')!).findByText('no limit')).toBeTruthy();
  });

  test('a machine that gives this fleet no control of cores offers memory alone', async () => {
    daemon({ [STUDIO]: { ...UNSET, suggested: { memoryMb: 95232 } } });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    expect(screen.queryByTestId('limits-cores')).toBeNull();
    expect(field('memory').value).toBe('93');
  });
});

describe('a fleet that reached its memory limit', () => {
  test('is said in an information toast, by this Mac\'s name for the machine, whose Change limits opens that machine\'s editor', async () => {
    daemon({ [STUDIO]: SET });
    act(() => store.getState().setFleet({ ...store.getState().fleet, machines: { [STUDIO]: { name: 'studio', reachable: true } } } as never));
    render(<Toast />);
    act(() => limitHit(store, { machine: STUDIO, name: 'the-home-calls-it', hits: 1, at: Date.now() }));
    const toast = screen.getByTestId('toast');
    expect([toast.dataset.tone, screen.getByTestId('toast-text').textContent]).toEqual(['info', "studio's fleet hit its memory limit; a process was stopped"]);
    expect(screen.getByTestId('toast-action').textContent).toBe('Change limits');
    act(() => screen.getByTestId('toast-action').click());
    expect(store.getState().settingsOpen).toBe(true);
    await machines();
    expect(await screen.findByTestId('limits-edit')).toBeTruthy();
    expect(row('studio')!.contains(screen.getByTestId('limits-edit'))).toBe(true);
  });
});

describe('the window a join opens', () => {
  const via = (online: boolean) => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', ...(online && { online: true as const }) });

  test('asks for its home\'s limits once, on the home\'s row, as soon as it reaches the home', () => {
    localStorage.setItem('svall.limitsAsk', '1');
    act(() => via(false));
    followLimitsAsk(store);
    expect(store.getState().settingsOpen).toBe(false);
    act(() => via(true));
    expect([store.getState().settingsOpen, store.getState().settingsAsk]).toEqual([true, { pane: 'machines', limits: STUDIO }]);
    expect(localStorage.getItem('svall.limitsAsk')).toBeNull();
    act(() => store.getState().toggleSettings(false));
    followLimitsAsk(store);
    expect(store.getState().settingsOpen).toBe(false);
  });

  test('asks nothing when the join found the home\'s limits set', () => {
    act(() => via(true));
    followLimitsAsk(store);
    expect(store.getState().settingsOpen).toBe(false);
  });
});

describe('Add machine', () => {
  const OFFER = { size: SIZE, suggested: { cpus: 11, memoryMb: 95232 } };
  const add = (offer?: typeof OFFER, code = 0) => act(() => {
    store.getState().hostStarted('add', { name: 'studio', ssh: 'ada@studio' });
    store.getState().hostStep('add', { step: 'limits', status: 'warn', detail: 'studio has 12 cores and 94 GB, and this fleet may use all of it', ...(offer && { offer }) });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'listed' });
    store.getState().hostDone('add', code);
  });
  beforeEach(() => store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false }));

  test('asks what the fleet may use of a machine with no limit once it is added, and sets it through the fleet\'s daemon', async () => {
    daemon({ [STUDIO]: UNSET });
    act(() => store.getState().setMachines([{ name: 'studio', id: STUDIO, ssh: 'ada@studio', platform: 'linux-x64' }] as never));
    render(<HostSetup />);
    act(() => store.getState().toggleHost(true));
    add(OFFER);
    const ask = screen.getByTestId('limits-ask');
    expect(ask.closest('.host-form')).toBeTruthy();
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    // the ask stands for the run's own row, which is not folded under the notes as well
    expect(screen.queryByTestId('host-notes')).toBeNull();
    call.mockImplementationOnce(() => Promise.reject(new ApiError('invalid', '6.2 GB is in use now; stop a robot or allow at least 7 GB')));
    fireEvent.click(screen.getByTestId('limits-set'));
    await waitFor(() => expect(said(ask)).toEqual({ line: '6.2 GB is in use now', fix: 'Stop a robot or allow at least 7 GB', raw: undefined }));
    fireEvent.click(screen.getByTestId('limits-set'));
    expect(call).toHaveBeenCalledWith('machines.setLimits', { machine: STUDIO, cpus: 11, memoryMb: 95232 });
    expect((await screen.findByTestId('limits-done')).textContent).toBe('limits11 of 12 cores · 93 of 94 GB');
  });

  test('a machine this Mac does not list yet waits to be checked again, and one with a limit, or a run under way, is not asked', () => {
    render(<HostSetup />);
    act(() => store.getState().toggleHost(true));
    add(OFFER);
    const set = screen.getByTestId('limits-set') as HTMLButtonElement;
    expect([set.disabled, set.dataset.tip]).toEqual([true, 'Check again to list studio here first']);
    add();
    expect(screen.queryByTestId('limits-ask')).toBeNull();
    act(() => {
      store.getState().hostStarted('add', { name: 'studio', ssh: 'ada@studio' });
      store.getState().hostStep('add', { step: 'limits', status: 'warn', detail: 'x', offer: OFFER });
    });
    expect(screen.queryByTestId('limits-ask')).toBeNull();
    expect(sent.filter((m) => m.type === 'host.start')).toEqual([]);
  });
});
