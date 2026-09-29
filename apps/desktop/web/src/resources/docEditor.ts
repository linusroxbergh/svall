import { frontmatterEnd } from '@svall/protocol';
import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeSpec, type SelectionRange, type Text } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { editBuffer, getBuffer } from '../ide/buffers.js';
import { flushDoc, watchDoc } from './autosave.js';
import type { ResourcesDeps } from './load.js';

// the description field writes the frontmatter, so the text shows only the body
const hidden = (state: EditorState): DecorationSet => {
  const end = frontmatterEnd(state.doc.toString());
  return end ? Decoration.set(Decoration.replace({ block: true }).range(0, end)) : Decoration.none;
};

// the block's end, just past its closing ---, and where the body starts: the line after, or that end when nothing follows
function span(doc: Text): { end: number; start: number } {
  const end = frontmatterEnd(doc.toString());
  const line = doc.lineAt(end);
  return { end, start: end && line.number < doc.lines ? doc.line(line.number + 1).from : end };
}

const clamp = (sel: EditorSelection, at: number): EditorSelection =>
  EditorSelection.create(sel.ranges.map((r) => EditorSelection.range(Math.max(r.anchor, at), Math.max(r.head, at))), sel.mainIndex);

// what a person types, deletes or moves lands in the body, and a doc that ends at the block gets a line break ahead of it;
// a find-panel replacement that reaches into the block is left out; the field, undo and a read from the disk still write
// the block, and every selection stays in the body
const keepBlock = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr;
  const { end, start } = span(tr.startState.doc);
  if (start && tr.docChanged && ['input', 'delete', 'move'].some((e) => tr.isUserEvent(e))) {
    const specs: ChangeSpec[] = [];
    const replace = tr.isUserEvent('input.replace');
    let touched = false;
    let owed = start === end;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
      if (replace && fromA < start) { touched = true; return; }
      const from = Math.max(fromA, start);
      const to = Math.max(toA, start);
      let insert = text.toString();
      if (owed && insert) { insert = tr.startState.lineBreak + insert; owed = false; }
      if (from !== fromA || insert.length !== text.length) touched = true;
      if (from < to || insert) specs.push({ from, to, insert });
    });
    if (touched) {
      // a moved line or swapped character that reaches into the block does not move at all
      if (tr.isUserEvent('move')) return [];
      const changes = tr.startState.changes(specs);
      const after: SelectionRange[] = [];
      changes.iterChangedRanges((_fromA, _toA, _fromB, toB) => { after.push(EditorSelection.cursor(toB)); });
      return {
        changes, effects: tr.effects, scrollIntoView: tr.scrollIntoView, userEvent: tr.annotation(Transaction.userEvent),
        selection: after.length ? EditorSelection.create(after) : clamp(tr.startState.selection, start),
      };
    }
  }
  const at = tr.docChanged ? span(tr.newDoc).start : start;
  return tr.newSelection.ranges.some((r) => r.from < at) ? [tr, { selection: clamp(tr.newSelection, at), sequential: true }] : tr;
});

export const frontmatterHidden = StateField.define<DecorationSet>({
  create: hidden,
  update: (deco, tr) => (tr.docChanged ? hidden(tr.state) : deco),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f)), keepBlock],
});

/** Where the body starts: the line after the frontmatter, or the top without one. */
export const bodyStart = (state: EditorState): number => span(state.doc).start;

/** Makes an open buffer a doc's: its frontmatter hidden and kept from what is typed, and its edits saved as they come. */
export function asDoc(d: ResourcesDeps, id: string, path: string): void {
  const b = getBuffer(id, path);
  if (!b) return;
  if (b.state.field(frontmatterHidden, false) === undefined) {
    // ⌘S joins autosave's writes, so it never races one already out
    const save = Prec.high(keymap.of([{ key: 'Mod-s', run: () => { void flushDoc(id, path); return true; } }]));
    editBuffer(id, path, { effects: StateEffect.appendConfig.of([frontmatterHidden, save]), selection: clamp(b.state.selection, bodyStart(b.state)) });
  }
  watchDoc(d, id, path);
}
