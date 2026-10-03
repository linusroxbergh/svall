import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import { dropBuffers, editBuffer, getBuffer } from '../src/ide/buffers.js';
import { openFile } from '../src/ide/files.js';
import { flushDoc, watchDoc } from '../src/resources/autosave.js';
import { createDoc, deleteDoc, deleteResource, isFresh, letGo, renameDoc, skeleton } from '../src/resources/docs.js';
import { createAppStore } from '../src/store/index.js';

const ROOT = 'r:/d/islands/i1';

// a buffer another test loaded for the same path would otherwise still answer getBuffer here
beforeEach(() => { dropBuffers(ROOT); });

// a docs folder held in memory, answering the way svalld does
function fake(files: Record<string, string> = {}) {
  const calls: [string, unknown][] = [];
  const fail = (code: string, message: string) => Promise.reject(Object.assign(new Error(message), { code }));
  const api = {
    call: (m: string, p: { id: string; path: string; text?: string; to?: string }) => {
      calls.push([m, p]);
      if (m === 'resources.get') return Promise.resolve({ sources: [] });
      if (m === 'fs.read') return p.path in files ? Promise.resolve({ text: files[p.path], mtimeMs: 1 }) : fail('not_found', `${p.path} is not a file`);
      if (m === 'docs.create') { if (p.path in files) return fail('exists', `${p.path} is already there`); files[p.path] = p.text!; return Promise.resolve({ mtimeMs: 1 }); }
      if (m === 'docs.rename') { if (p.to! in files) return fail('exists', `${p.to} is already there`); files[p.to!] = files[p.path]; delete files[p.path]; return Promise.resolve({}); }
      if (m === 'docs.delete') { delete files[p.path]; return Promise.resolve({}); }
      if (m === 'fs.write') { files[p.path] = p.text!; return Promise.resolve({ mtimeMs: 2 }); }
      return fail('unknown_method', m);
    },
  } as unknown as Pick<Api, 'call'>;
  const store = createAppStore();
  return { d: { api, store }, files, calls, store };
}

describe('skeleton', () => {
  it('is a description line and nothing else: a doc is named for its file', () => {
    expect(skeleton()).toBe('---\ndescription: \n---\n\n');
  });
});

describe('createDoc', () => {
  it('writes <slug>.md with the skeleton and opens it', async () => {
    const { d, files, store } = fake();
    expect(await createDoc(d, ROOT, 'Native Surfaces')).toBe(true);
    expect(files['native-surfaces.md']).toBe(skeleton());
    expect(store.getState().resourcesShown).toEqual({ rootId: ROOT, path: 'native-surfaces.md' });
  });
  it('surfaces a name that is taken, and writes nothing', async () => {
    const { d, files, store } = fake({ 'plan.md': 'mine' });
    expect(await createDoc(d, ROOT, 'plan')).toBe(false);
    expect(files['plan.md']).toBe('mine');
    expect(store.getState().toast).toMatchObject({ tone: 'error', text: expect.stringContaining('already there') });
  });
  it('refuses a name with nothing in it without asking svalld', async () => {
    const { d, calls, store } = fake();
    expect(await createDoc(d, ROOT, '  — ')).toBe(false);
    expect(calls).toEqual([]);
    expect(store.getState().toast?.tone).toBe('error');
  });
});

describe('renameDoc', () => {
  it('renames the file and moves the open editor to it', async () => {
    const { d, files, store } = fake({ 'old.md': 'text' });
    store.getState().openFile(ROOT, 'old.md');
    expect(await renameDoc(d, ROOT, 'old.md', 'New Name')).toBe(true);
    expect(Object.keys(files)).toEqual(['new-name.md']);
    expect(store.getState().ide[ROOT].open).toEqual(['new-name.md']);
  });
  it('leaves a doc with unsaved edits alone', async () => {
    const { d, files, store } = fake({ 'old.md': 'text' });
    store.getState().openFile(ROOT, 'old.md');
    store.getState().markFile(ROOT, 'old.md', { dirty: true });
    expect(await renameDoc(d, ROOT, 'old.md', 'new')).toBe(false);
    expect(Object.keys(files)).toEqual(['old.md']);
    expect(store.getState().toast?.text).toMatch(/save/i);
  });
  it('does nothing when the name has not changed', async () => {
    const { d, calls } = fake({ 'old.md': 'text' });
    expect(await renameDoc(d, ROOT, 'old.md', 'old')).toBe(true);
    expect(calls.filter(([m]) => m === 'docs.rename')).toEqual([]);
  });
  it('surfaces a taken name, and leaves both files alone', async () => {
    const { d, files, store } = fake({ 'old.md': 'text', 'new.md': 'other' });
    expect(await renameDoc(d, ROOT, 'old.md', 'new')).toBe(false);
    expect(files).toEqual({ 'old.md': 'text', 'new.md': 'other' });
    expect(store.getState().toast).toMatchObject({ tone: 'error', text: expect.stringContaining('already there') });
  });
});

describe('deleteDoc', () => {
  it('unlinks the file, closes it, and offers an undo that puts the same text back', async () => {
    const { d, files, store } = fake({ 'plan.md': 'the text' });
    store.getState().openFile(ROOT, 'plan.md');
    await deleteDoc(d, ROOT, 'plan.md');
    expect(files).toEqual({});
    expect(store.getState().ide[ROOT].open).toEqual([]);
    expect(store.getState().resourcesShown).toBeUndefined();
    expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Deleted plan', action: { label: 'Undo' } });
    store.getState().runToastAction();
    await new Promise((r) => setTimeout(r, 0));
    expect(files).toEqual({ 'plan.md': 'the text' });
  });
  it('leaves the file gone when the toast is let go', async () => {
    const { d, files, store } = fake({ 'plan.md': 'the text' });
    await deleteDoc(d, ROOT, 'plan.md');
    store.getState().clearToast();
    expect(files).toEqual({});
  });
  it('leaves a doc with unsaved edits alone', async () => {
    const { d, files, store } = fake({ 'plan.md': 'the text' });
    store.getState().openFile(ROOT, 'plan.md');
    store.getState().markFile(ROOT, 'plan.md', { dirty: true });
    await deleteDoc(d, ROOT, 'plan.md');
    expect(files).toEqual({ 'plan.md': 'the text' });
  });
  it('deletes a doc it cannot read, and offers nothing back', async () => {
    const { d, files, calls, store } = fake({ 'plan.md': 'the text' });
    d.api.call = ((m: string, p: { path: string }) => {
      calls.push([m, p]);
      if (m === 'fs.read') return Promise.reject(Object.assign(new Error('is not text'), { code: 'invalid' }));
      if (m === 'resources.get') return Promise.resolve({ sources: [] });
      if (m === 'docs.delete') { delete files[p.path]; return Promise.resolve({}); }
      return Promise.reject(new Error(m));
    }) as typeof d.api.call;
    await deleteDoc(d, ROOT, 'plan.md');
    expect(files).toEqual({});
    expect(calls.filter(([m]) => m === 'docs.delete')).toHaveLength(1);
    expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Deleted plan' });
    expect(store.getState().toast?.action).toBeUndefined();
  });

  it('surfaces a delete that fails', async () => {
    const { d, files, store } = fake({ 'plan.md': 'the text' });
    d.api.call = (() => Promise.reject(Object.assign(new Error('plan.md is not a file'), { code: 'not_found' }))) as typeof d.api.call;
    await deleteDoc(d, ROOT, 'plan.md');
    expect(files).toEqual({ 'plan.md': 'the text' });
    expect(store.getState().toast).toMatchObject({ tone: 'error', text: expect.stringContaining('not a file') });
  });
});

describe('deleteResource', () => {
  const C = 'r:/u/.claude';
  const skill = { rootId: C, path: 'skills/tidy/SKILL.md', folder: 'skills/tidy' };
  function setup(answer: (m: string) => Promise<unknown> = (m) => Promise.resolve(m === 'resources.delete' ? { token: 't1' } : m === 'resources.get' ? { sources: [] } : {})) {
    const calls: [string, unknown][] = [];
    const api = { call: (m: string, p: unknown) => { calls.push([m, p]); return answer(m); } } as unknown as Pick<Api, 'call'>;
    const store = createAppStore();
    return { d: { api, store }, calls, store };
  }
  it('sets a skill folder aside, closes its files and offers it back', async () => {
    const { d, calls, store } = setup();
    store.getState().openFile(C, 'skills/tidy/SKILL.md');
    store.getState().openFile(C, 'skills/tidy/run.sh');
    store.getState().openFile(C, 'skills/tidy-two/SKILL.md');
    await deleteResource(d, 'tidy', skill);
    expect(calls[0]).toEqual(['resources.delete', { id: C, path: 'skills/tidy' }]);
    expect(store.getState().ide[C]?.open).toEqual(['skills/tidy-two/SKILL.md']);
    expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Deleted tidy', action: { label: 'Undo' } });
    store.getState().toast!.action!.run();
    expect(calls.at(-1)).toEqual(['resources.restore', { token: 't1' }]);
  });
  it('leaves a skill with an unsaved file alone', async () => {
    const { d, calls, store } = setup();
    store.getState().openFile(C, 'skills/tidy/run.sh');
    store.getState().markFile(C, 'skills/tidy/run.sh', { dirty: true });
    await deleteResource(d, 'tidy', skill);
    expect(calls).toEqual([]);
    expect(store.getState().toast).toMatchObject({ tone: 'error', text: 'Save tidy before deleting it' });
  });
  it('surfaces a delete svalld refuses', async () => {
    const { d, store } = setup(() => Promise.reject(Object.assign(new Error('CLAUDE.md is not a skill, agent, command or memory file the shelf lists'), { code: 'invalid' })));
    await deleteResource(d, 'CLAUDE.md', { rootId: C, path: 'CLAUDE.md' });
    expect(store.getState().toast).toMatchObject({ tone: 'error', text: expect.stringContaining('the shelf lists') });
  });
});

describe('fresh docs', () => {
  it('a doc createDoc made is fresh until the editor lets go of it', async () => {
    const { d } = fake();
    await createDoc(d, ROOT, 'Fresh One');
    expect(isFresh(ROOT, 'fresh-one.md')).toBe(true);
    await letGo(d, ROOT, 'fresh-one.md');
    expect(isFresh(ROOT, 'fresh-one.md')).toBe(false);
  });
});

describe('letGo', () => {
  it('deletes a doc this session made and nobody wrote in, and says so', async () => {
    const { d, files, store } = fake();
    await createDoc(d, ROOT, 'blank');
    await letGo(d, ROOT, 'blank.md');
    expect(files).toEqual({});
    expect(store.getState().ide[ROOT].open).toEqual([]);
    expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Discarded empty blank' });
  });
  it('still throws away a new doc written in, saved, and emptied again just before it is let go', async () => {
    const { d, files, store } = fake();
    await createDoc(d, ROOT, 'emptied');
    watchDoc(d, ROOT, 'emptied.md');
    const end = skeleton().length;
    editBuffer(ROOT, 'emptied.md', { changes: { from: end, insert: 'words' } });
    await flushDoc(ROOT, 'emptied.md');
    editBuffer(ROOT, 'emptied.md', { changes: { from: end, to: end + 5 } });
    await letGo(d, ROOT, 'emptied.md');
    expect(files).toEqual({});
    expect(store.getState().toast).toMatchObject({ tone: 'ok', text: 'Discarded empty emptied' });
  });
  it('keeps a new doc that was written in, and saves what waits', async () => {
    const { d, files } = fake();
    await createDoc(d, ROOT, 'kept');
    watchDoc(d, ROOT, 'kept.md');
    editBuffer(ROOT, 'kept.md', { changes: { from: skeleton().length, insert: 'words' } });
    await letGo(d, ROOT, 'kept.md');
    expect(files['kept.md']).toBe(`${skeleton()}words`);
  });
  it('keeps a new doc that something else wrote while it stood open, and shows what the disk has', async () => {
    const { d, files, calls, store } = fake();
    await createDoc(d, ROOT, 'taken');
    files['taken.md'] = '---\ndescription: An agent wrote this\n---\nIts words\n';
    await letGo(d, ROOT, 'taken.md');
    expect(files['taken.md']).toBe('---\ndescription: An agent wrote this\n---\nIts words\n');
    expect(calls.filter(([m]) => m === 'docs.delete')).toEqual([]);
    expect(getBuffer(ROOT, 'taken.md')?.state.doc.toString()).toBe(files['taken.md']);
    expect(store.getState().ide[ROOT].dirty).not.toContain('taken.md');
    expect(store.getState().toast).toBeUndefined();
  });
  it('closes a new doc that is already gone from the disk', async () => {
    const { d, files, calls, store } = fake();
    await createDoc(d, ROOT, 'gone');
    delete files['gone.md'];
    await letGo(d, ROOT, 'gone.md');
    expect(calls.filter(([m]) => m === 'docs.delete')).toEqual([]);
    expect(store.getState().ide[ROOT].open).toEqual([]);
    expect(store.getState().toast).toBeUndefined();
  });
  it('leaves a blank doc alone that this session did not make', async () => {
    const { d, files } = fake({ 'old.md': skeleton() });
    await openFile(d, ROOT, 'old.md');
    await letGo(d, ROOT, 'old.md');
    expect(files).toEqual({ 'old.md': skeleton() });
  });
});

describe('waiting edits', () => {
  it('renameDoc saves them before it renames', async () => {
    const { d, files, store } = fake({ 'old.md': 'text' });
    await openFile(d, ROOT, 'old.md');
    watchDoc(d, ROOT, 'old.md');
    editBuffer(ROOT, 'old.md', { changes: { from: 4, insert: '!' } });
    store.getState().markFile(ROOT, 'old.md', { dirty: true });
    expect(await renameDoc(d, ROOT, 'old.md', 'new')).toBe(true);
    expect(files).toEqual({ 'new.md': 'text!' });
  });
  it('deleteDoc saves them first, so Undo brings back the latest text', async () => {
    const { d, files, store } = fake({ 'plan.md': 'text' });
    await openFile(d, ROOT, 'plan.md');
    watchDoc(d, ROOT, 'plan.md');
    editBuffer(ROOT, 'plan.md', { changes: { from: 4, insert: '!' } });
    store.getState().markFile(ROOT, 'plan.md', { dirty: true });
    await deleteDoc(d, ROOT, 'plan.md');
    expect(files).toEqual({});
    store.getState().runToastAction();
    await new Promise((r) => setTimeout(r, 0));
    expect(files).toEqual({ 'plan.md': 'text!' });
  });
});
