// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type LimitsReport, type MachineId } from '@svall/protocol';
import { bridge, call, freshStore, sent, store } from './harness.js';

bridge.present = true;
// jsdom lays nothing out
Element.prototype.scrollIntoView = () => undefined;
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

  test('a limit that does not hold says why in a line and what to do under it, a tool\'s words alone behind details, never daemon', async () => {
    const PENDING = 'dddddddd-0000-4000-8000-000000000000' as MachineId;
    daemon({ [STUDIO]: { ...SET, state: 'outside' }, [VAULT]: { ...SET, state: 'unapplied' }, [PENDING]: { ...SET, state: 'pending' } }, [...LIST,
      { id: VAULT, name: 'vault', role: 'worker', platform: 'linux', reachable: true, robots: 0 },
      { id: PENDING, name: 'tern', role: 'worker', platform: 'linux', reachable: true, robots: 0 }]);
    await machines();
    const of = async (name: string) => said(await within(screen.getByTestId(`machine-limits-${name}`)).findByTestId('limits-said'));
    expect((await screen.findAllByTestId('limits-said'))[0].querySelector('.said')!.getAttribute('data-mark')).toBe('warn');
    expect(await of('studio')).toEqual({ line: 'robots on studio run outside the limit', fix: "Close every robot there, then restart Svall's background service", raw: undefined });
    expect(await of('tern')).toEqual({ line: 'not in force yet', fix: "It takes hold when Svall's background service on tern starts.", raw: undefined });
    expect(await of('vault')).toEqual({ line: 'not in force', fix: undefined, raw: "systemd did not put it on the fleet's unit" });
    expect(document.body.textContent).not.toMatch(/daemon/);
  });

  test('how often the fleet reached its memory limit waits in the limits Info, not as a line of the block, at a time of day today', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 13, 12, 0), toFake: ['Date'] });
    try {
      daemon({ [STUDIO]: { ...SET, hits: 3, lastHit: new Date(2026, 10, 13, 9, 23).getTime() }, [VAULT]: { ...SET, hits: 1, lastHit: new Date(2026, 10, 12, 9, 23).getTime() } }, [...LIST,
        { id: VAULT, name: 'vault', role: 'worker', platform: 'linux', reachable: true, robots: 0 }]);
      await machines();
      await value('studio');
      await value('vault');
      expect(screen.queryByTestId('limits-hits')).toBeNull();
      const today = new Date(2026, 10, 13, 9, 23).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const before = new Date(2026, 10, 12, 9, 23).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      expect(document.getElementById(`set-tip-limits-${STUDIO}`)!.textContent).toMatch(new RegExp(`This fleet reached it 3 times, last ${today}\\.$`));
      expect(document.getElementById(`set-tip-limits-${VAULT}`)!.textContent).toMatch(new RegExp(`This fleet reached it once, ${before}\\.$`));
    } finally {
      vi.useRealTimers();
    }
  });

  test('reading says so in words, and the Info stays while reading and after a read that failed', async () => {
    daemon({ [STUDIO]: new Promise(() => undefined) as never });
    await machines();
    expect(within(row('studio')!).getByTestId('limits-reading').textContent).toBe("Reading studio's limits…");
    expect(document.getElementById(`set-tip-limits-${STUDIO}`)).toBeTruthy();
  });

  test('one that cannot be read says why, with Read again', async () => {
    daemon({ [STUDIO]: new ApiError('not_supported', "studio's release has no limits yet; upgrade it from its ⋯ menu") });
    await machines();
    const r = await screen.findByTestId('limits-read');
    expect(said(row('studio')!)).toEqual({ line: "studio's release has no limits yet", fix: 'Upgrade it from its ⋯ menu', raw: undefined });
    expect(document.getElementById(`set-tip-limits-${STUDIO}`)).toBeTruthy();
    daemon({ [STUDIO]: SET });
    fireEvent.click(r);
    expect(await value('studio')).toBe('11 of 12 cores · 93 of 94 GB');
  });

  test('Change opens the editor, a machine with none suggested a limit, each field beside its range, the memory in use, and Save alone under what it does', async () => {
    daemon({ [STUDIO]: UNSET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    expect(screen.getByTestId('limits-change').textContent).toBe('Cancel');
    const edit = screen.getByTestId('limits-edit');
    expect(screen.getByTestId('limits-suggested').textContent).toBe("Suggested for studio's 12 cores and 94 GB");
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    // memory starts at what is in use, in whole GB
    expect([...edit.querySelectorAll('.limits-range')].map((r) => r.textContent)).toEqual(['1 to 12', '7 to 94 GB']);
    expect(screen.getByTestId('limits-held').textContent).toBe('memory in use now6.2 GB');
    expect([...edit.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Save']);
    expect(screen.getByTestId('limits-save').closest('.row')!.textContent).toBe('Robots keep running; the limits take hold nowSave');
    fireEvent.change(field('cores'), { target: { value: '' } });
    fireEvent.change(field('memory'), { target: { value: '6' } });
    const save = screen.getByTestId('limits-save') as HTMLButtonElement;
    expect([save.disabled, save.dataset.tip]).toEqual([true, '7 to 94 GB']);
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
    // the range leaves the wrong field's side for the line under it
    expect([...screen.getByTestId('limits-edit').querySelectorAll('.limits-range')].map((r) => r.textContent)).toEqual(['7 to 94 GB']);
    expect((screen.getByTestId('limits-save') as HTMLButtonElement).dataset.tip).toBe('1 to 12 cores');
    fireEvent.change(field('cores'), { target: { value: '8' } });
    fireEvent.change(field('memory'), { target: { value: '0.2' } });
    expect(wrong()).toEqual([[field('memory').closest('.row'), '7 to 94 GB']]);
  });

  test('Save keeps a memory limit to the MiB when only the cores change', async () => {
    daemon({ [STUDIO]: { ...SET, limits: { cpus: 11, memoryMb: 8000 } } });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    fireEvent.change(field('cores'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('limits-save'));
    expect(call).toHaveBeenLastCalledWith('machines.setLimits', { machine: STUDIO, cpus: 8, memoryMb: 8000 });
  });

  test('Save with both fields cleared takes a set limit off', async () => {
    daemon({ [STUDIO]: SET });
    await machines();
    await value('studio');
    fireEvent.click(screen.getByTestId('limits-change'));
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    expect(screen.queryByTestId('limits-suggested')).toBeNull();
    fireEvent.change(field('cores'), { target: { value: '' } });
    fireEvent.change(field('memory'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('limits-save'));
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
    expect([toast.dataset.tone, screen.getByTestId('toast-text').firstChild!.textContent, screen.getByTestId('toast-fix').textContent]).toEqual(['info', 'studio reached its memory limit', "One of the fleet's processes was stopped"]);
    expect(screen.getByTestId('toast-action').textContent).toBe('Change limits');
    act(() => screen.getByTestId('toast-action').click());
    expect(store.getState().settingsOpen).toBe(true);
    await machines();
    expect(await screen.findByTestId('limits-edit')).toBeTruthy();
    expect(row('studio')!.contains(screen.getByTestId('limits-edit'))).toBe(true);
  });

  test('Change limits scrolls to the row once its limits are read', async () => {
    let read: (r: LimitsReport) => void = () => undefined;
    daemon({ [STUDIO]: new Promise<LimitsReport>((r) => { read = r; }) as never });
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    act(() => store.getState().toggleSettings(true, 'machines', STUDIO));
    await machines();
    expect(scrolled).toEqual([]);
    await act(async () => read(SET));
    await screen.findByTestId('limits-edit');
    expect(scrolled).toEqual([row('studio')]);
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

  test('asks what the fleet may use of a machine with no limit once it is added, in one limits row, and sets it through the fleet\'s daemon', async () => {
    daemon({ [STUDIO]: UNSET });
    act(() => store.getState().setMachines([{ name: 'studio', id: STUDIO, ssh: 'ada@studio', platform: 'linux-x64' }] as never));
    render(<HostSetup />);
    act(() => store.getState().toggleHost(true));
    add(OFFER);
    const ask = screen.getByTestId('limits-ask');
    expect(ask.closest('.host-form')).toBeTruthy();
    expect(ask.textContent).toBe('limitsof 12 cores·of 94 GBSet');
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    // the ask stands for the run's own row, which is not folded under the notes as well
    expect(screen.queryByTestId('host-notes')).toBeNull();
    // unanswered, the add is not called ready, and Done does not lead
    expect([screen.getByTestId('host-outcome').querySelector('.host-verdict')!.textContent, screen.getByTestId('host-done').className]).toEqual(['studio is added', 'btn']);
    call.mockImplementationOnce(() => Promise.reject(new ApiError('invalid', '6.2 GB is in use now; stop a robot or allow at least 7 GB')));
    fireEvent.click(screen.getByTestId('limits-set'));
    await waitFor(() => expect(said(ask.parentElement!)).toEqual({ line: '6.2 GB is in use now', fix: 'Stop a robot or allow at least 7 GB', raw: undefined }));
    fireEvent.click(screen.getByTestId('limits-set'));
    expect(call).toHaveBeenCalledWith('machines.setLimits', { machine: STUDIO, cpus: 11, memoryMb: 95232 });
    expect((await screen.findByTestId('limits-done')).textContent).toBe('limits11 of 12 cores · 93 of 94 GBChange');
    expect([screen.getByTestId('host-outcome').querySelector('.host-verdict')!.textContent, screen.getByTestId('host-done').className]).toEqual(['studio is ready', 'btn pri']);
    // Change asks again, filled in with what was set; both fields empty is no limit, as in the first run
    fireEvent.click(screen.getByTestId('limits-change'));
    expect([field('cores').value, field('memory').value]).toEqual(['11', '93']);
    fireEvent.change(field('memory'), { target: { value: '200' } });
    expect(screen.getByTestId('limits-wrong').textContent).toBe('0.5 to 94 GB');
    fireEvent.change(field('cores'), { target: { value: '' } });
    fireEvent.change(field('memory'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('limits-set'));
    expect(call).toHaveBeenLastCalledWith('machines.setLimits', { machine: STUDIO, cpus: null, memoryMb: null });
    expect((await screen.findByTestId('limits-done')).textContent).toBe('limitsno limitChange');
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
