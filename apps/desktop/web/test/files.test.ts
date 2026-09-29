import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import { dropBuffers, getBuffer, isDirty, setState } from '../src/ide/buffers.js';
import { checkDisk, closeFile, openFile, overwriteFile, placeCursor, reloadFile, saveFile } from '../src/ide/files.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

type Disk = Record<string, { text: string; mtimeMs: number }>;

// svalld as the page sees it: a disk of files under the character's root, a conflict when the mtime moved on or the
// file went (mtime 0 writes one that is not there), and a write refused once the root is no longer the one it was read from
function fakeApi(disk: Disk, at = { root: '/r' }) {
  const calls: string[] = [];
  const writes: { path: string; root?: string }[] = [];
  const api = {
    call: (method: string, p: { path: string; text?: string; mtimeMs?: number; root?: string }) => {
      calls.push(method);
      const f = disk[p.path];
      if (method === 'fs.read') return f ? Promise.resolve({ ...f, root: at.root }) : Promise.reject(Object.assign(new Error('gone'), { code: 'not_found' }));
      if (method === 'fs.write') {
        writes.push({ path: p.path, root: p.root });
        if (p.root !== undefined && p.root !== at.root) return Promise.reject(Object.assign(new Error(`${p.path} was opened in ${p.root}`), { code: 'invalid' }));
        if (f ? f.mtimeMs !== p.mtimeMs : p.mtimeMs !== 0) return Promise.resolve({ conflict: true, mtimeMs: f?.mtimeMs ?? 0 });
        disk[p.path] = { text: p.text!, mtimeMs: (f?.mtimeMs ?? 0) + 1 };
        return Promise.resolve({ mtimeMs: disk[p.path].mtimeMs });
      }
      return Promise.resolve({});
    },
  } as unknown as Pick<Api, 'call'>;
  return { api, calls, writes };
}

const edit = (id: string, path: string, insert: string) => {
  const b = getBuffer(id, path)!;
  setState(id, path, b.state.update({ changes: { from: b.state.doc.length, insert } }).state);
};

describe('files', () => {
  beforeEach(() => dropBuffers('c1'));

  it('opens a file into a buffer and the store, and saves it back', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    expect(store.getState().ide.c1).toMatchObject({ open: ['a.ts'], active: 'a.ts' });
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('one\n');
    edit('c1', 'a.ts', 'two\n');
    store.getState().markFile('c1', 'a.ts', { dirty: true });
    await saveFile(d, 'c1', 'a.ts');
    expect(disk['a.ts']).toEqual({ text: 'one\ntwo\n', mtimeMs: 2 });
    expect(isDirty(getBuffer('c1', 'a.ts')!)).toBe(false);
    expect(store.getState().ide.c1.dirty).toEqual([]);
    // opening again keeps the buffer instead of reading the disk
    await openFile(d, 'c1', 'a.ts');
    expect(getBuffer('c1', 'a.ts')!.mtimeMs).toBe(2);
  });

  it('reloads a clean buffer from a changed disk, and flags a dirty one', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 }, 'b.ts': { text: 'b\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    await openFile(d, 'c1', 'b.ts');
    edit('c1', 'b.ts', 'edited\n');
    store.getState().markFile('c1', 'b.ts', { dirty: true });
    disk['a.ts'] = { text: 'one\nfrom disk\n', mtimeMs: 5 };
    disk['b.ts'] = { text: 'b\nfrom disk\n', mtimeMs: 5 };
    await checkDisk(d, 'c1');
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('one\nfrom disk\n');
    expect(getBuffer('c1', 'b.ts')!.state.doc.toString()).toBe('b\nedited\n');
    expect(store.getState().ide.c1.conflict).toEqual(['b.ts']);
    await reloadFile(d, 'c1', 'b.ts');
    expect(getBuffer('c1', 'b.ts')!.state.doc.toString()).toBe('b\nfrom disk\n');
    expect(store.getState().ide.c1).toMatchObject({ conflict: [], dirty: [] });
  });

  it('forgets a closed file, so opening it again reads the disk', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'discarded\n');
    store.getState().markFile('c1', 'a.ts', { dirty: true });
    closeFile(d, 'c1', 'a.ts');
    expect(getBuffer('c1', 'a.ts')).toBeUndefined();
    expect(store.getState().ide.c1).toMatchObject({ open: [], dirty: [] });
    await openFile(d, 'c1', 'a.ts');
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('one\n');
  });

  it('keeps what was typed during a save as unsaved', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'two\n');
    const saving = saveFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'three\n');
    await saving;
    expect(disk['a.ts'].text).toBe('one\ntwo\n');
    expect(isDirty(getBuffer('c1', 'a.ts')!)).toBe(true);
    expect(store.getState().ide.c1.dirty).toEqual(['a.ts']);
  });

  it('leaves nothing unsaved behind when the tab closes during its save', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'two\n');
    store.getState().markFile('c1', 'a.ts', { dirty: true });
    const saving = saveFile(d, 'c1', 'a.ts');
    closeFile(d, 'c1', 'a.ts');
    await saving;
    expect(store.getState().ide.c1).toMatchObject({ open: [], dirty: [], conflict: [] });
  });

  it('turns a refused save into a conflict, and overwrite wins it without reading the file again', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api, calls } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'mine\n');
    disk['a.ts'] = { text: 'theirs\n', mtimeMs: 9 };
    await saveFile(d, 'c1', 'a.ts');
    expect(disk['a.ts'].text).toBe('theirs\n');
    expect(store.getState().ide.c1.conflict).toEqual(['a.ts']);
    await overwriteFile(d, 'c1', 'a.ts');
    expect(disk['a.ts']).toEqual({ text: 'one\nmine\n', mtimeMs: 10 });
    expect(store.getState().ide.c1).toMatchObject({ conflict: [], dirty: [] });
    expect(calls.filter((m) => m === 'fs.read')).toHaveLength(1);
  });

  it('turns a save of a file deleted on disk into a conflict, and overwrite puts it back', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'mine\n');
    delete disk['a.ts'];
    await saveFile(d, 'c1', 'a.ts');
    expect(disk['a.ts']).toBeUndefined();
    expect(store.getState().ide.c1.conflict).toEqual(['a.ts']);
    await overwriteFile(d, 'c1', 'a.ts');
    expect(disk['a.ts'].text).toBe('one\nmine\n');
    expect(store.getState().ide.c1).toMatchObject({ conflict: [], dirty: [] });
  });

  it('says so when a file cannot be opened, and opens no tab for it', async () => {
    const { api } = fakeApi({});
    const store = createAppStore();
    store.getState().setFleet(fleet());
    await openFile({ api, store }, 'c1', 'bin.png');
    expect(store.getState().toast?.text).toContain('bin.png');
    expect(store.getState().ide.c1?.open ?? []).toEqual([]);
    expect(getBuffer('c1', 'bin.png')).toBeUndefined();
  });

  it('puts the cursor on the text it is asked to find', async () => {
    const disk: Disk = { 'settings.json': { text: '{\n  "hooks": {\n    "Stop": []\n  }\n}\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    await openFile({ api, store }, 'c1', 'settings.json');
    placeCursor('c1', 'settings.json', '"Stop"');
    expect(getBuffer('c1', 'settings.json')!.state.selection.main.head).toBe(disk['settings.json'].text.indexOf('"Stop"'));
    placeCursor('c1', 'settings.json', '"Nope"');
    expect(getBuffer('c1', 'settings.json')!.state.selection.main.head).toBe(disk['settings.json'].text.indexOf('"Stop"'));
  });

  it('saves only into the root the file was read from, so a character that moved checkout gets no stray file', async () => {
    const disk: Disk = { 'docs/plan.md': { text: 'plan for a\n', mtimeMs: 1 } };
    const at = { root: '/proj-a' };
    const { api, writes } = fakeApi(disk, at);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'docs/plan.md');
    edit('c1', 'docs/plan.md', 'edit meant for a\n');
    // the character cds into another checkout, which has no such file
    at.root = '/proj-b';
    delete disk['docs/plan.md'];
    await checkDisk(d, 'c1');
    await saveFile(d, 'c1', 'docs/plan.md');
    expect(writes).toEqual([{ path: 'docs/plan.md', root: '/proj-a' }]);
    expect(disk['docs/plan.md']).toBeUndefined();
    expect(store.getState().toast?.text).toContain('/proj-a');
    expect(isDirty(getBuffer('c1', 'docs/plan.md')!)).toBe(true);
  });

  it('takes the new root with the text when a buffer follows the disk into another checkout', async () => {
    const disk: Disk = { 'a.ts': { text: 'a\n', mtimeMs: 1 }, 'b.ts': { text: 'b\n', mtimeMs: 1 } };
    const at = { root: '/proj-a' };
    const { api, writes } = fakeApi(disk, at);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    await openFile(d, 'c1', 'b.ts');
    edit('c1', 'b.ts', 'edited\n');
    at.root = '/proj-b';
    // the same mtime in another checkout is still another file
    disk['a.ts'] = { text: 'a in b\n', mtimeMs: 1 };
    disk['b.ts'] = { text: 'b in b\n', mtimeMs: 5 };
    await checkDisk(d, 'c1');
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('a in b\n');
    expect(store.getState().ide.c1.conflict).toEqual(['b.ts']);
    // Overwrite would take the edit into the other checkout; Reload takes that checkout's file instead
    await overwriteFile(d, 'c1', 'b.ts');
    expect(disk['b.ts'].text).toBe('b in b\n');
    await reloadFile(d, 'c1', 'b.ts');
    edit('c1', 'a.ts', 'more\n');
    edit('c1', 'b.ts', 'more\n');
    await saveFile(d, 'c1', 'a.ts');
    await saveFile(d, 'c1', 'b.ts');
    expect(writes.slice(-2)).toEqual([{ path: 'a.ts', root: '/proj-b' }, { path: 'b.ts', root: '/proj-b' }]);
    expect(disk['a.ts'].text).toBe('a in b\nmore\n');
    expect(disk['b.ts'].text).toBe('b in b\nmore\n');
  });

  it('drops the conflict a move flagged once the character is back where the buffer was read', async () => {
    const disk: Disk = { 'a.ts': { text: 'a\n', mtimeMs: 1 } };
    const at = { root: '/proj-a' };
    const { api, writes } = fakeApi(disk, at);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'mine\n');
    const inA = disk['a.ts'];
    at.root = '/proj-b';
    disk['a.ts'] = { text: 'a in b\n', mtimeMs: 5 };
    await checkDisk(d, 'c1');
    expect(store.getState().ide.c1.conflict).toEqual(['a.ts']);
    // an Overwrite pressed while away is refused, and leaves the buffer as it was read
    await overwriteFile(d, 'c1', 'a.ts');
    at.root = '/proj-a';
    disk['a.ts'] = inA;
    await checkDisk(d, 'c1');
    expect(store.getState().ide.c1.conflict).toEqual([]);
    await saveFile(d, 'c1', 'a.ts');
    expect(writes.at(-1)).toEqual({ path: 'a.ts', root: '/proj-a' });
    expect(disk['a.ts'].text).toBe('a\nmine\n');
  });

  it('says so when Reload finds the file gone', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    delete disk['a.ts'];
    await reloadFile(d, 'c1', 'a.ts');
    expect(store.getState().toast?.text).toContain('a.ts');
  });
});
