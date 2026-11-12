// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, render } from '@testing-library/react';
import { beforeAll, expect, test, vi } from 'vitest';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Toast } = await import('../../src/Toast.js');

const src = path.join(__dirname, '../../src');
const selectable = (el: Element) => getComputedStyle(el).getPropertyValue('user-select') === 'text';

beforeAll(() => {
  document.head.appendChild(document.createElement('style')).textContent = fs.readFileSync(path.join(src, 'base.css'), 'utf8');
});

test('an error toast selects its words and not its buttons', () => {
  freshStore();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  expect(selectable(getByTestId('toast-text'))).toBe(true);
  expect(selectable(getByTestId('toast'))).toBe(false);
  expect(selectable(getByTestId('toast-dismiss'))).toBe(false);
});

test('an ok toast stays as it is, its words out of a selection', () => {
  freshStore();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('Deleted plan', 'ok', { label: 'Undo', run() {} }));
  expect(selectable(getByTestId('toast-text'))).toBe(false);
});

// each as its component draws it
test.each([
  ['a banner', '<div class="banner dan"><span id="w">svalld connection lost</span></div>'],
  ['the connect screen', '<div class="connect"><div id="w">svalld not running</div></div>'],
  ['a setup error', '<div class="setup"><p class="setup-error" id="w">could not configure</p></div>'],
  ['a setup blocker', '<div class="setup"><p class="setup-blocker" id="w">no agent found</p></div>'],
  ['a feedback error', '<div class="fb-error" id="w">could not send</div>'],
  ['a fleet error', '<div class="fleet-error" id="w">that name is taken</div>'],
  ['a failed setup tick', '<span class="host-failed" id="w">could not write</span>'],
  ['a failed setup step', '<div class="host-step" data-status="fail"><span class="host-said" id="w">no tmux</span></div>'],
  ['a setup outcome', '<span class="host-verdict" id="w">Setup failed</span>'],
  ['a move refusal', '<div class="host-note" id="w">the robot is working</div>'],
  ['a failed move step', '<ol class="move-steps"><li data-state="failed"><span>x</span><span id="w">could not copy</span></li></ol>'],
  ['a terminal that failed', '<div class="revive"><span id="w">attach failed</span></div>'],
  ['a machine\'s check', '<b class="machine-said" id="w">unreachable</b>'],
  ['a chord that is taken', '<div class="row key-ask"><span id="w">⌘K is taken</span></div>'],
  ['a file tree error', '<div class="tree-err" id="w">permission denied</div>'],
  ['a changes error', '<div class="ide-empty" id="w">not a git repository</div>'],
  ['a dialog note', '<div class="modal-note" id="w">svalld is not connected</div>'],
  ['a browser error', '<span class="baddr-err" id="w">could not connect</span>'],
  ['a marked error', '<b data-error="true" id="w">resume failed</b>'],
])('%s can be selected', (_name, html) => {
  document.body.innerHTML = html;
  expect(selectable(document.getElementById('w')!)).toBe(true);
});

test('what is not marked an error stays out of a selection', () => {
  document.body.innerHTML = '<b data-error="false" id="w">3 files</b>';
  expect(selectable(document.getElementById('w')!)).toBe(false);
});
