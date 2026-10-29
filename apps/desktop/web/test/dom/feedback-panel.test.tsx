// @vitest-environment jsdom
import './setup.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FeedbackPanel } from '../../src/FeedbackPanel.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore } from '../../src/store/index.js';

const DIAG = 'svall 0.22.0 · macOS 26.0\n\nsvalld.log, last 200 lines\nline';
const ok = () => new Response('{"ok":true}', { status: 201 });
let fetchMock: ReturnType<typeof vi.fn>;
const posted = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body as string);

beforeEach(() => { setAppStore(createAppStore()); fetchMock = vi.fn(async () => ok()); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const shown = async (diagnostics: () => Promise<string> = async () => DIAG) => {
  render(<FeedbackPanel diagnostics={diagnostics} />);
  await waitFor(() => expect((screen.getByTestId('feedback-diagnostics') as HTMLInputElement).disabled).toBe(false));
};
const type = (t: string) => fireEvent.change(screen.getByTestId('feedback-text'), { target: { value: t } });
const box = () => screen.getByTestId('feedback-diagnostics') as HTMLInputElement;
const send = () => screen.getByTestId('feedback-send') as HTMLButtonElement;

test('Bug is first, with diagnostics ticked and the bug placeholder; Idea unticks and swaps it', async () => {
  await shown();
  const text = screen.getByTestId('feedback-text') as HTMLTextAreaElement;
  expect(screen.getByTestId('feedback-kind-bug').getAttribute('aria-pressed')).toBe('true');
  expect(box().checked).toBe(true);
  expect(text.placeholder).toBe('What happened, and what did you expect?');
  fireEvent.click(screen.getByTestId('feedback-kind-idea'));
  expect(box().checked).toBe(false);
  expect(text.placeholder).toBe('What would you like Svall to do?');
});

test('a touched checkbox survives a kind switch', async () => {
  await shown();
  fireEvent.click(box());
  fireEvent.click(screen.getByTestId('feedback-kind-idea'));
  expect(box().checked).toBe(false);
  fireEvent.click(box());
  fireEvent.click(screen.getByTestId('feedback-kind-bug'));
  expect(box().checked).toBe(true);
  fireEvent.click(box());
  fireEvent.click(screen.getByTestId('feedback-kind-idea'));
  expect(box().checked).toBe(false);
});

test('Send is disabled for empty or whitespace text', async () => {
  await shown();
  expect(send().disabled).toBe(true);
  type('  \n ');
  expect(send().disabled).toBe(true);
  type('broke');
  expect(send().disabled).toBe(false);
});

test("See what's sent shows the exact diagnostics, and that same string is posted", async () => {
  await shown();
  expect(screen.queryByTestId('feedback-preview')).toBeNull();
  fireEvent.click(screen.getByTestId('feedback-see'));
  const shownText = screen.getByTestId('feedback-preview').textContent;
  expect(shownText).toBe(DIAG);
  type('broke');
  fireEvent.click(send());
  await screen.findByTestId('feedback-sent');
  expect(posted()).toEqual({ kind: 'bug', text: 'broke', diagnostics: shownText });
});

test('unticked, the post carries only kind and text', async () => {
  await shown();
  fireEvent.click(box());
  type('broke');
  fireEvent.click(send());
  await screen.findByTestId('feedback-sent');
  expect(posted()).toEqual({ kind: 'bug', text: 'broke' });
});

test('a double press posts once', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await shown();
  type('broke');
  fireEvent.click(send());
  fireEvent.click(send());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('success swaps Send for "Sent, thanks" and clears the text', async () => {
  await shown();
  type('broke');
  fireEvent.click(send());
  expect((await screen.findByTestId('feedback-sent')).textContent).toBe('Sent, thanks');
  expect(screen.queryByTestId('feedback-send')).toBeNull();
  expect((screen.getByTestId('feedback-text') as HTMLTextAreaElement).value).toBe('');
});

test('a failure shows the error, keeps text and kind, and Send works again', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{"error":"slow down"}', { status: 429 }));
  await shown();
  fireEvent.click(screen.getByTestId('feedback-kind-idea'));
  type('my idea');
  fireEvent.click(send());
  expect((await screen.findByTestId('feedback-error')).textContent).toBe('slow down');
  expect((screen.getByTestId('feedback-text') as HTMLTextAreaElement).value).toBe('my idea');
  expect(screen.getByTestId('feedback-kind-idea').getAttribute('aria-pressed')).toBe('true');
  expect(send().disabled).toBe(false);
  fireEvent.click(send());
  await screen.findByTestId('feedback-sent');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('feedback-error')).toBeNull();
});

test('a failed preview disables and unticks the box with "Diagnostics unavailable", and sending still works', async () => {
  render(<FeedbackPanel diagnostics={() => Promise.reject(new Error('down'))} />);
  await waitFor(() => expect(box().disabled).toBe(true));
  expect(box().checked).toBe(false);
  expect(screen.getByText('Diagnostics unavailable')).toBeTruthy();
  expect(screen.queryByTestId('feedback-see')).toBeNull();
  type('broke');
  fireEvent.click(send());
  await screen.findByTestId('feedback-sent');
  expect(posted()).toEqual({ kind: 'bug', text: 'broke' });
});
