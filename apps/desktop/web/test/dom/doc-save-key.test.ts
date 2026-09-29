// @vitest-environment jsdom
import './setup.js';
import { runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from '../../src/api.js';
import { dropBuffers, editBuffer, loadBuffer, mountView } from '../../src/ide/buffers.js';
import { editorExtensions } from '../../src/ide/codemirror.js';
import { saveFile } from '../../src/ide/files.js';
import { flushDocs } from '../../src/resources/autosave.js';
import { asDoc } from '../../src/resources/docEditor.js';
import { createAppStore } from '../../src/store/index.js';
import { theme } from '../../src/theme.js';

const ROOT = 'r:/d/islands/i1';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); dropBuffers(ROOT); });
afterEach(async () => { await flushDocs(); vi.useRealTimers(); });

it('⌘S on a doc waits for the autosave write already out, so the doc does not conflict with itself', async () => {
  const disk = { text: 'one', mtimeMs: 1 };
  const pending: (() => void)[] = [];
  const api = {
    call: (m: string, p: { text: string; mtimeMs: number }) => {
      if (m !== 'fs.write') return Promise.resolve({ sources: [] });
      return new Promise((resolve) => pending.push(() => {
        if (disk.mtimeMs !== p.mtimeMs) { resolve({ conflict: true, mtimeMs: disk.mtimeMs }); return; }
        Object.assign(disk, { text: p.text, mtimeMs: disk.mtimeMs + 1 });
        resolve({ mtimeMs: disk.mtimeMs });
      }));
    },
  } as unknown as Pick<Api, 'call'>;
  const d = { api, store: createAppStore() };
  loadBuffer(ROOT, 'a.md', 'one', 1, [editorExtensions(() => { void saveFile(d, ROOT, 'a.md'); })]);
  const view = mountView(ROOT, 'a.md', document.createElement('div'), () => {});
  asDoc(d, ROOT, 'a.md');
  editBuffer(ROOT, 'a.md', { changes: { from: 3, insert: '!' } });
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(pending).toHaveLength(1);

  // CodeMirror reads Mod as ⌘ where the platform says Mac
  const mac = /Mac/.test(navigator.platform);
  expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 's', metaKey: mac, ctrlKey: !mac }), 'editor')).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(pending).toHaveLength(1);

  pending.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(disk.text).toBe('one!');
  expect(d.store.getState().ide[ROOT]?.conflict ?? []).toEqual([]);
  view.destroy();
});
