import { history, isolateHistory, undo } from '@codemirror/commands';
import { beforeEach, describe, expect, it } from 'vitest';
import { dropBuffer, dropBuffers, editBuffer, focusBuffer, getBuffer, isDirty, loadBuffer, markSaved, replaceText, setState, subscribeBuffer } from '../src/ide/buffers.js';

describe('buffers', () => {
  beforeEach(() => dropBuffers('c'));

  it('holds a state per file and knows when it differs from what was saved', () => {
    const b = loadBuffer('c', 'a.ts', 'one\n', 10, []);
    expect(isDirty(b)).toBe(false);
    const edited = b.state.update({ changes: { from: 4, insert: 'two\n' } }).state;
    expect(setState('c', 'a.ts', edited)).toBe(true);
    expect(getBuffer('c', 'a.ts')!.state.doc.toString()).toBe('one\ntwo\n');
    const back = getBuffer('c', 'a.ts')!.state.update({ changes: { from: 4, to: 8 } }).state;
    expect(setState('c', 'a.ts', back)).toBe(false);
  });

  it('marks the text that was written as saved, not what was typed since', () => {
    const b = loadBuffer('c', 'a.ts', 'one\n', 10, []);
    setState('c', 'a.ts', b.state.update({ changes: { from: 0, insert: '// ' } }).state);
    const written = getBuffer('c', 'a.ts')!.state.doc;
    markSaved('c', 'a.ts', written, 20);
    const now = getBuffer('c', 'a.ts')!;
    expect(isDirty(now)).toBe(false);
    expect(now.mtimeMs).toBe(20);
    expect(now.saved.toString()).toBe('// one\n');
    setState('c', 'a.ts', now.state.update({ changes: { from: 0, insert: 'x' } }).state);
    markSaved('c', 'a.ts', written, 30);
    expect(isDirty(getBuffer('c', 'a.ts')!)).toBe(true);
  });

  it('replaces the text from disk without losing the undo history', () => {
    const b = loadBuffer('c', 'a.ts', 'one\n', 10, [history()]);
    setState('c', 'a.ts', b.state.update({ changes: { from: 0, insert: 'x' }, annotations: isolateHistory.of('after') }).state);
    replaceText('c', 'a.ts', 'from disk\n', 30);
    const now = getBuffer('c', 'a.ts')!;
    expect(now.state.doc.toString()).toBe('from disk\n');
    expect(isDirty(now)).toBe(false);
    expect(now.mtimeMs).toBe(30);
    let state = now.state;
    undo({ state, dispatch: (tr) => { state = tr.state; } });
    expect(state.doc.toString()).toBe('xone\n');
  });

  it('notifies a preview about edits and disk replacements while no view is mounted', () => {
    const b = loadBuffer('c', 'README.md', '# Old\n', 10, []);
    const seen: string[] = [];
    const stop = subscribeBuffer('c', 'README.md', (text) => seen.push(text));
    setState('c', 'README.md', b.state.update({ changes: { from: 2, to: 5, insert: 'Draft' } }).state);
    replaceText('c', 'README.md', '# New\n', 20);
    stop();
    replaceText('c', 'README.md', '# Later\n', 30);
    expect(seen).toEqual(['# Old\n', '# Draft\n', '# New\n']);
  });

  it('drops one buffer, and every buffer of a character', () => {
    loadBuffer('c', 'a.ts', '', 1, []);
    loadBuffer('c', 'b.ts', '', 1, []);
    loadBuffer('d', 'a.ts', '', 1, []);
    dropBuffer('c', 'a.ts');
    expect(getBuffer('c', 'a.ts')).toBeUndefined();
    expect(getBuffer('c', 'b.ts')).toBeDefined();
    dropBuffers('c');
    expect(getBuffer('c', 'b.ts')).toBeUndefined();
    expect(getBuffer('d', 'a.ts')).toBeDefined();
    dropBuffers('d');
  });

  it('edits a buffer with no view mounted, tells its subscribers and answers the dirty flag', () => {
    loadBuffer('c', 'a.md', 'one', 1, []);
    const seen: string[] = [];
    const stop = subscribeBuffer('c', 'a.md', (t) => seen.push(t));
    expect(editBuffer('c', 'a.md', { changes: { from: 3, insert: '!' } })).toBe(true);
    expect(getBuffer('c', 'a.md')!.state.doc.toString()).toBe('one!');
    expect(editBuffer('c', 'a.md', { changes: { from: 3, to: 4 } })).toBe(false);
    stop();
    expect(seen).toEqual(['one', 'one!', 'one']);
  });

  it('tells nobody about a transaction that leaves the text alone', () => {
    loadBuffer('c', 'a.md', 'one', 1, []);
    const seen: string[] = [];
    const stop = subscribeBuffer('c', 'a.md', (t) => seen.push(t));
    expect(editBuffer('c', 'a.md', { selection: { anchor: 1 } })).toBe(false);
    stop();
    expect(seen).toEqual(['one']);
  });

  it('has no view to focus for a buffer that is not shown', () => {
    loadBuffer('c', 'a.md', 'one', 1, []);
    expect(focusBuffer('c', 'a.md')).toBe(false);
  });
});
