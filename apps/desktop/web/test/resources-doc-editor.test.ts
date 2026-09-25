import { cursorDocStart, history, moveLineUp, selectAll, undo } from '@codemirror/commands';
import { SearchQuery } from '@codemirror/search';
import { EditorState, type StateCommand, type TransactionSpec } from '@codemirror/state';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import { dropBuffers, editBuffer, getBuffer, loadBuffer, replaceText } from '../src/ide/buffers.js';
import { asDoc, bodyStart, frontmatterHidden } from '../src/resources/docEditor.js';
import { createAppStore } from '../src/store/index.js';

const ROOT = 'r:/d/islands/i1';
const d = { api: { call: () => Promise.resolve({}) } as unknown as Pick<Api, 'call'>, store: createAppStore() };

const ranges = (): [number, number][] => {
  const out: [number, number][] = [];
  getBuffer(ROOT, 'a.md')!.state.field(frontmatterHidden).between(0, 1e9, (from, to) => { out.push([from, to]); });
  return out;
};

beforeEach(() => dropBuffers(ROOT));

it('hides the frontmatter lines once the buffer is a doc, and follows edits to them', () => {
  loadBuffer(ROOT, 'a.md', '---\ndescription: d\n---\n# Body\n', 1, []);
  asDoc(d, ROOT, 'a.md');
  expect(ranges()).toEqual([[0, 22]]);
  expect(getBuffer(ROOT, 'a.md')!.state.selection.main.head).toBe(23);
  editBuffer(ROOT, 'a.md', { changes: { from: 0, to: 23 } });
  expect(ranges()).toEqual([]);
});

it('takes a text read again from the disk, block and all', () => {
  loadBuffer(ROOT, 'a.md', '---\ndescription: d\n---\n# Body\n', 1, []);
  asDoc(d, ROOT, 'a.md');
  replaceText(ROOT, 'a.md', '---\ndescription: agent\n---\nIts words\n', 2);
  expect(getBuffer(ROOT, 'a.md')!.state.doc.toString()).toBe('---\ndescription: agent\n---\nIts words\n');
});

it('can be asked twice', () => {
  loadBuffer(ROOT, 'a.md', '---\ndescription: d\n---\n', 1, []);
  asDoc(d, ROOT, 'a.md');
  asDoc(d, ROOT, 'a.md');
  expect(ranges()).toEqual([[0, 22]]);
});

it('starts the body on the line after the frontmatter, or at the top without one', () => {
  expect(bodyStart(EditorState.create({ doc: '---\ndescription: \n---\n\n' }))).toBe(22);
  expect(bodyStart(EditorState.create({ doc: '---\ndescription: d\n---' }))).toBe(22);
  expect(bodyStart(EditorState.create({ doc: '# Title\n' }))).toBe(0);
});

describe('what a person types or deletes', () => {
  // the body starts at 23, the line after the block's closing ---
  const DOC = '---\ndescription: d\n---\n# Body\n';
  const docState = (at: number, doc = DOC): EditorState => EditorState.create({ doc, selection: { anchor: at }, extensions: [history(), frontmatterHidden] });
  const apply = (s: EditorState, spec: TransactionSpec): EditorState => s.update(spec).state;
  const run = (s: EditorState, command: StateCommand): EditorState => { let out = s; command({ state: s, dispatch: (tr) => { out = tr.state; } }); return out; };
  // what the editor sends for a typed text over the selection, and for Backspace
  const type = (s: EditorState, insert: string): EditorState => {
    const { from, to } = s.selection.main;
    return apply(s, { changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' });
  };
  const backspace = (s: EditorState): EditorState => {
    const at = s.selection.main.head;
    return apply(s, { changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: 'delete.backward' });
  };

  it('Backspace at the start of the body leaves the block and its line break', () => {
    const s = backspace(docState(23));
    expect(s.doc.toString()).toBe(DOC);
    expect(s.selection.main.head).toBe(23);
  });
  it('the top of the text is the start of the body, and typing lands there', () => {
    const s = run(docState(27), cursorDocStart);
    expect(s.selection.main.head).toBe(23);
    expect(type(s, 'x').doc.toString()).toBe('---\ndescription: d\n---\nx# Body\n');
  });
  it('text typed with the cursor left at the top lands at the start of the body', () => {
    const s = type(docState(0), 'x');
    expect(s.doc.toString()).toBe('---\ndescription: d\n---\nx# Body\n');
    expect(s.selection.main.head).toBe(24);
  });
  it('the cursor moved left from the start of the body stays there', () => {
    const s = apply(docState(23), { selection: { anchor: 22 }, userEvent: 'select' });
    expect(s.selection.main.head).toBe(23);
    expect(type(s, 'x').doc.toString()).toBe('---\ndescription: d\n---\nx# Body\n');
  });
  it('select-all takes the body, and typing over it keeps the block', () => {
    const s = run(docState(23), selectAll);
    expect([s.selection.main.from, s.selection.main.to]).toEqual([23, DOC.length]);
    expect(type(s, 'x').doc.toString()).toBe('---\ndescription: d\n---\nx');
  });
  it('the first text typed after a block with nothing after it goes on a new line', () => {
    const s = type(docState(22, '---\ndescription: d\n---'), 'x');
    expect(s.doc.toString()).toBe('---\ndescription: d\n---\nx');
    expect(s.selection.main.head).toBe(24);
  });
  it('a line moved up from the start of the body stays below the block', () => {
    expect(run(docState(23), moveLineUp).doc.toString()).toBe(DOC);
  });
  it('the description field still writes the block', () => {
    expect(apply(docState(23), { changes: { from: 17, to: 18, insert: 'new' } }).doc.toString()).toBe('---\ndescription: new\n---\n# Body\n');
  });
  it('undo still takes back a description change', () => {
    const s = apply(docState(23), { changes: { from: 17, to: 18, insert: 'new' } });
    expect(run(s, undo).doc.toString()).toBe(DOC);
  });
  // what the find panel's Replace All sends: every match in one transaction
  const replaceAll = (s: EditorState, search: string, replace: string): EditorState => {
    const cursor = new SearchQuery({ search }).getCursor(s) as Iterator<{ from: number; to: number }>;
    const changes = [];
    for (let m = cursor.next(); !m.done; m = cursor.next()) changes.push({ from: m.value.from, to: m.value.to, insert: replace });
    return apply(s, { changes, userEvent: 'input.replace.all' });
  };
  it('Replace All leaves a match in the block alone and replaces the ones in the body', () => {
    const doc = '---\ndescription: Body\n---\n# Body\n';
    expect(replaceAll(docState(26, doc), 'Body', 'Head').doc.toString()).toBe('---\ndescription: Body\n---\n# Head\n');
    expect(replaceAll(docState(26, doc), 'description', 'x').doc.toString()).toBe(doc);
  });
});
