import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import type { ToShell } from '../src/bridge.js';
import { dropBuffers, getBuffer, isDirty, setState } from '../src/ide/buffers.js';
import { checkDisk, closeFile, openFile, openPath, overwriteFile, placeCursor, reloadFile, saveFile } from '../src/ide/files.js';
import { createAppStore } from '../src/store/index.js';
import { chr, fleet } from './fixtures.js';

type Disk = Record<string, { text: string; mtimeMs: number }>;

// svalld as the page sees it: a disk of files under the robot's root, a conflict when the mtime moved on or the
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

// holds every fs.read answer until the test lets it go, so answers can come late or out of order
function slowReads(api: Pick<Api, 'call'>) {
  const held: (() => void)[] = [];
  const call = api.call as (method: string, p: unknown) => Promise<unknown>;
  const slow = { call: (method: string, p: unknown) => {
    const r = call(method, p);
    return method === 'fs.read' ? new Promise((go) => held.push(() => go(r))) : r;
  } } as unknown as Pick<Api, 'call'>;
  return { api: slow, held };
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

  it('saves only into the root the file was read from, so a robot that moved checkout gets no stray file', async () => {
    const disk: Disk = { 'docs/plan.md': { text: 'plan for a\n', mtimeMs: 1 } };
    const at = { root: '/proj-a' };
    const { api, writes } = fakeApi(disk, at);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'docs/plan.md');
    edit('c1', 'docs/plan.md', 'edit meant for a\n');
    // the robot cds into another checkout, which has no such file
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

  it('drops the conflict a move flagged once the robot is back where the buffer was read', async () => {
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

  it('leaves a tab opened again during a disk check to its own text and edits', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    const slow = slowReads(api);
    await openFile(d, 'c1', 'a.ts');
    disk['a.ts'] = { text: 'two\n', mtimeMs: 2 };
    const checking = checkDisk({ api: slow.api, store }, 'c1');
    closeFile(d, 'c1', 'a.ts');
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'mine\n');
    store.getState().markFile('c1', 'a.ts', { dirty: true });
    slow.held[0]();
    await checking;
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('two\nmine\n');
    expect(isDirty(getBuffer('c1', 'a.ts')!)).toBe(true);
    expect(store.getState().ide.c1.dirty).toEqual(['a.ts']);
  });

  it('keeps the newest disk text when an earlier check answers last', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const slow = slowReads(api);
    const d = { api: slow.api, store };
    await openFile({ api, store }, 'c1', 'a.ts');
    disk['a.ts'] = { text: 'two\n', mtimeMs: 2 };
    const earlier = checkDisk(d, 'c1');
    disk['a.ts'] = { text: 'three\n', mtimeMs: 3 };
    const later = checkDisk(d, 'c1');
    slow.held[1]();
    await later;
    slow.held[0]();
    await earlier;
    expect(getBuffer('c1', 'a.ts')!.state.doc.toString()).toBe('three\n');
    expect(getBuffer('c1', 'a.ts')!.mtimeMs).toBe(3);
  });

  it('sends a save made before the last one is answered after it, so pressing Cmd-S or Overwrite twice makes no conflict', async () => {
    const disk: Disk = { 'a.ts': { text: 'one\n', mtimeMs: 1 } };
    const { api } = fakeApi(disk);
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const d = { api, store };
    await openFile(d, 'c1', 'a.ts');
    edit('c1', 'a.ts', 'two\n');
    await Promise.all([saveFile(d, 'c1', 'a.ts'), saveFile(d, 'c1', 'a.ts')]);
    expect(disk['a.ts'].text).toBe('one\ntwo\n');
    expect(store.getState().ide.c1?.conflict ?? []).toEqual([]);
    edit('c1', 'a.ts', 'mine\n');
    disk['a.ts'] = { text: 'theirs\n', mtimeMs: 9 };
    await saveFile(d, 'c1', 'a.ts');
    expect(store.getState().ide.c1.conflict).toEqual(['a.ts']);
    await Promise.all([overwriteFile(d, 'c1', 'a.ts'), overwriteFile(d, 'c1', 'a.ts')]);
    expect(disk['a.ts'].text).toBe('one\ntwo\nmine\n');
    expect(store.getState().ide.c1).toMatchObject({ conflict: [], dirty: [] });
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

describe('openPath', () => {
  beforeEach(() => dropBuffers('c1'));
  const ROOT = '/Users/ada/svall/.wt/auth';

  // a robot in a worktree, working in a folder below its root, over a disk of text files, one folder and one picture
  function setup() {
    const store = createAppStore();
    const f = fleet();
    f.robots.c1 = chr('c1', 'i_b', { x: 4, y: 1 }, { cwd: `${ROOT}/pkg`, repo: { root: ROOT, mainRoot: '/Users/ada/svall', branch: 'auth', isWorktree: true } });
    store.getState().setFleet(f);
    const text: Record<string, string> = { [`${ROOT}/pkg/src/a.ts`]: 'one\ntwo\nthree\n', '/Users/ada/Desktop/run.log': 'ok\n' };
    const abs = (p: string) => (p.startsWith('/') ? p : p ? `${ROOT}/${p}` : ROOT);
    const refuse = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
    const api = {
      call: (method: string, p: { path: string }) => {
        const at = abs(p.path);
        if (method === 'fs.read') return text[at] !== undefined ? Promise.resolve({ text: text[at], mtimeMs: 1, root: '/' }) : refuse(at.endsWith('.png') ? 'binary' : 'not_found');
        if (method === 'fs.list') return at === '/Users/ada/Desktop/invoices' ? Promise.resolve({ entries: [] }) : refuse('not_found');
        return Promise.resolve({});
      },
    } as unknown as Pick<Api, 'call'>;
    const sent: ToShell[] = [];
    return { d: { api, store, bridge: { present: true, send: (m: ToShell) => { sent.push(m); } } }, s: () => store.getState(), sent };
  }

  it('opens a path relative to the cwd as a file under the root, at its line, beside the terminal', async () => {
    const { d, s } = setup();
    await openPath(d, 'c1', 'src/a.ts:2:5', 'terminal');
    expect(s().ide.c1).toMatchObject({ panes: { left: 'terminal', right: 'files' }, open: ['pkg/src/a.ts'], top: '', expanded: ['pkg/src', 'pkg'] });
    expect(getBuffer('c1', 'pkg/src/a.ts')!.state.selection.main.head).toBe(4);
  });

  it('reads a relative path against the root when git names it by a real path the cwd does not spell', async () => {
    const { d, s } = setup();
    s().setFleet({ ...s().fleet, robots: { ...s().fleet.robots, c1: { ...s().fleet.robots.c1, cwd: '/Users/link/svall/.wt/auth' } } });
    await openPath(d, 'c1', 'pkg/src/a.ts', 'terminal');
    expect(s().ide.c1.open).toEqual(['pkg/src/a.ts']);
  });

  it('moves the tree to a file outside the root, reading ~ as the home the root lies in', async () => {
    const { d, s } = setup();
    await openPath(d, 'c1', '~/Desktop/run.log', 'terminal');
    expect(s().ide.c1).toMatchObject({ open: ['/Users/ada/Desktop/run.log'], active: '/Users/ada/Desktop/run.log', top: '/Users/ada/Desktop' });
  });

  it('makes a folder the tree\'s top, hands a picture to the Mac, and says when a path is not there', async () => {
    const { d, s, sent } = setup();
    await openPath(d, 'c1', '/Users/ada/Desktop/invoices/', 'terminal');
    expect(s().ide.c1.top).toBe('/Users/ada/Desktop/invoices');
    await openPath(d, 'c1', '/Users/ada/Desktop/shot.png', 'terminal');
    expect(sent).toEqual([{ type: 'openFile', path: '/Users/ada/Desktop/shot.png' }]);
    expect(s().ide.c1).toMatchObject({ top: '/Users/ada/Desktop', open: [] });
    await openPath(d, 'c1', '../gone.ts', 'terminal');
    expect(s().toast?.text).toBe('~/svall/.wt/auth/gone.ts is not there');
  });

  it('opens Files on the side away from the terminal the path was followed in', async () => {
    const { d, s } = setup();
    s().setPanes('c1', { left: 'browser', right: 'terminal2' });
    await openPath(d, 'c1', '~/Desktop/run.log', 'terminal2');
    expect(s().ide.c1.panes).toEqual({ left: 'files', right: 'terminal2' });
  });
});
