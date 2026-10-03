import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// the app's palette, so the editor sits on the board like the terminal does
const editorTheme: Extension = [
  EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--surface-0)', color: 'var(--ink)' },
    '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--text-md)', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--sel)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sel)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--sel) 25%, transparent)' },
    '.cm-activeLine': { backgroundColor: 'var(--fill-1)' },
    '.cm-gutters': { backgroundColor: 'var(--surface-0)', color: 'var(--ink-3)', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--fill-1)' },
    '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
    '.cm-panels input, .cm-panels button': { font: 'inherit' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--pt-sun) 35%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--pt-sun) 60%, transparent)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--sel) 15%, transparent)' },
    '.cm-changedLine': { backgroundColor: 'transparent' },
    '.cm-insertedLine': { backgroundColor: 'color-mix(in srgb, var(--syntax-string) 14%, transparent)' },
    '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--blocked) 14%, transparent)' },
    '.cm-deletedChunk del': { textDecoration: 'none', color: 'var(--ink-2)' },
    '.cm-changedText': { background: 'color-mix(in srgb, var(--syntax-string) 35%, transparent)' },
    '.cm-collapsedLines': { color: 'var(--ink-3)', backgroundColor: 'var(--fill-1)', padding: '2px 12px' },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: t.keyword, color: 'var(--pt-sun)' },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--ink)' },
    { tag: [t.function(t.variableName), t.labelName], color: 'var(--sel)' },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--pt-coral)' },
    { tag: [t.definition(t.name), t.separator], color: 'var(--ink)' },
    { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: 'var(--pt-sky)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--pt-coral)' },
    { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--syntax-op)' },
    { tag: [t.meta, t.comment], color: 'var(--ink-cool)', fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.heading, fontWeight: 'bold', color: 'var(--pt-sun)' },
    { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--syntax-string)' },
    { tag: t.invalid, color: 'var(--blocked)' },
  ])),
];

/** Everything an editable file gets; Mod-s runs onSave. */
export const editorExtensions = (onSave: () => void): Extension => [
  lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(),
  closeBrackets(), highlightActiveLine(), highlightSelectionMatches(), EditorView.lineWrapping,
  keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
  editorTheme,
];

/** A file shown, not edited: the diff pane. */
export const readOnlyExtensions = (): Extension => [
  lineNumbers(), drawSelection(), highlightSelectionMatches(), keymap.of(searchKeymap),
  EditorState.readOnly.of(true), EditorView.editable.of(false), editorTheme,
];

/** The language for a file name, loaded on first use; undefined when none is known. */
export async function languageFor(name: string): Promise<Extension | undefined> {
  return LanguageDescription.matchFilename(languages, name)?.load();
}
