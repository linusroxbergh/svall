// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId, MobileStatus } from '@svall/protocol';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { MobilePanel } = await import('../../src/PhonePanel.js');

const OFF: MobileStatus = { serving: false, url: '', port: 8443, logins: [], phones: [] };
const SERVING: MobileStatus = { serving: true, url: 'https://studio.tailnet.ts.net:8461/', port: 8461, logins: ['ada@example.com'], phones: [] };
const DENIED = 'Command failed: tailscale serve --bg --yes --https=8461 http://127.0.0.1:41939/\nAccess denied: serve config denied';

beforeEach(() => { freshStore(); });

// the panel reads the status again as it opens; the daemon answers with what the store holds
async function panel(status: MobileStatus) {
  call.mockImplementation((m: string) => Promise.resolve(m === 'mobile.get' ? status : {}));
  act(() => store.getState().setMobile(status));
  await act(async () => { render(<MobilePanel />); });
}
const problem = () => screen.queryByTestId('mobile-problem');

test('off, it says what the link is for in one line', async () => {
  await panel(OFF);
  expect(screen.getByTestId('mobile-body').textContent).toBe('Reach this fleet from your phone, over your tailnet only.');
  expect(problem()).toBeNull();
});

test('a problem the daemon words stands in place of that line: its sentence, what to do, a terminal there, and the tool behind details', async () => {
  act(() => store.getState().setVia({ machine: 'm-mac' as MachineId, home: 'm-studio' as MachineId, name: 'studio', online: true }));
  await panel({ ...OFF, reason: 'Tailscale on studio does not let Svall share this fleet', fix: 'Run once on studio: sudo tailscale set --operator=$USER', run: 'sudo tailscale set --operator=$USER', raw: DENIED });
  const said = problem()!;
  expect(said.querySelector('.said > div > span')!.textContent).toBe('Tailscale on studio does not let Svall share this fleet');
  expect(said.querySelector('.modal-sub')!.textContent).toBe('Run once on studio: sudo tailscale set --operator=$USER');
  expect(said.querySelector('.modal-more-body')!.textContent).toBe(DENIED);
  expect(screen.getByTestId('mobile-body').textContent).not.toContain('Reach this fleet');
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  expect(store.getState().hostMachine).toBe('studio');
  expect(store.getState().hostTerminal).toEqual({ run: 'sudo tailscale set --operator=$USER' });
});

test('a problem that is a tool\'s words alone reads as one sentence, the words behind details', async () => {
  await panel({ ...OFF, reason: DENIED });
  expect(problem()!.querySelector('.said > div > span')!.textContent).toBe('The phone link could not start.');
  expect(problem()!.querySelector('.modal-more-body')!.textContent).toBe(DENIED);
});

test('a problem in a sentence of its own is said as it is', async () => {
  await panel({ ...OFF, reason: 'the phone link stayed off for the move to studio' });
  expect(problem()!.textContent).toBe('the phone link stayed off for the move to studio');
});

test('serving, it says who can connect and the three steps to the Home Screen icon', async () => {
  await panel(SERVING);
  const body = screen.getByTestId('mobile-body');
  expect(body.querySelector('.use-note')!.textContent).toBe('Only ada@example.com can connect. Settings → Phone says how to add a login.');
  expect([...screen.getByTestId('mobile-steps').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'Scan the code with your phone\'s camera.',
    'Tap Share, then Add to Home Screen.Safari: the square with an arrow, at the bottom. Chrome: the same mark, right of the address bar.',
    'Open Svall from the new icon and allow notifications.',
  ]);
  expect(body.textContent).not.toContain('restart the daemon');
});

test('serving with no login, it says none can connect yet', async () => {
  await panel({ ...SERVING, logins: [] });
  expect(screen.getByTestId('mobile-body').querySelector('.use-note')!.textContent).toBe('No login can connect yet. Settings → Phone says how to add a login.');
});

test('the address is a button that copies, with a copy mark, the whole of it on the pointer', async () => {
  await panel(SERVING);
  expect(screen.getByTestId('mobile-url').dataset.tip).toBe(`Copy ${SERVING.url}`);
  expect(screen.getByTestId('mobile-url').querySelector('svg')).not.toBeNull();
  act(() => store.getState().setPhoneRedact('data:image/png;base64,AAAA'));
  expect(screen.getByTestId('mobile-url').dataset.tip).toBe('Copy the link');
});

test('a phone on the page is said to be connected, and since when', async () => {
  await panel({ ...SERVING, phones: [{ login: 'ada@example.com', since: new Date(2026, 10, 12, 11, 54).getTime() }] });
  expect(screen.getByTestId('mobile-here').textContent).toBe('ada@example.com connected since 11:54');
});

test('on a Mac home, whose terminal this window cannot open, the fix sets its command as code, whole', async () => {
  await panel({ ...OFF, error: 'Tailscale on this Mac does not let Svall share this fleet', fix: 'Run once on this Mac: sudo tailscale set --operator=$USER', run: 'sudo tailscale set --operator=$USER', raw: DENIED });
  const fix = problem()!.querySelector('.modal-sub')!;
  expect(fix.textContent).toBe('Run once on this Mac: sudo tailscale set --operator=$USER');
  expect(fix.querySelector('code.said-run')!.textContent).toBe('sudo tailscale set --operator=$USER');
  expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull();
  expect(problem()!.querySelector('.modal-more-body')!.textContent).toBe(DENIED);
});
