// the shelf's two walkable columns, and what counts as a row in each
const COLS = ['.res-tree', '.res-list'] as const;
const ROWS = ['.res-node', '.res-item'] as const;

export type At = { col: number; row: number };
export type Step = At | 'editor' | undefined;

// A row the arrows picked shows its file without sending the keys after it, so the walk can go on; a row
// the pointer picked hands them to the editor as it always has. The pane asks once, as it opens the file.
let walked = false;
export const takesKeys = (): boolean => { const was = walked; walked = false; return !was; };
export const pointerPicked = (): void => { walked = false; };

/** Where an arrow key takes the shelf. A row of -1 asks the column for the one it has already chosen;
 *  a row of -1 coming in means nothing in the column holds the keys, so down lands on its first. */
export function step(at: At, counts: number[], key: string): Step {
  if (key === 'ArrowRight') { const col = at.col + 1; return col >= counts.length || counts[col] === 0 ? 'editor' : { col, row: -1 }; }
  if (key === 'ArrowLeft') { const col = at.col - 1; return col < 0 || counts[col] === 0 ? undefined : { col, row: -1 }; }
  const n = counts[at.col];
  const row = key === 'ArrowDown' ? Math.min(n - 1, at.row + 1) : at.row - 1;
  return n === 0 || row < 0 || row === at.row ? undefined : { col: at.col, row };
}

const rowsOf = (shelf: Element, col: number): HTMLElement[] => [...shelf.querySelectorAll<HTMLElement>(`${COLS[col]} :is(${ROWS[col]})`)];
const isFolder = (el: HTMLElement) => el.hasAttribute('aria-expanded');
const toggle = (el: HTMLElement) => el.querySelector<HTMLElement>('.res-car')?.click();

/** Walks the shelf with the arrow keys; true when the key was spent. */
export function shelfKey(e: KeyboardEvent, shelf: HTMLElement): boolean {
  if (!e.key.startsWith('Arrow') || e.metaKey || e.ctrlKey || e.altKey) return false;
  const active = document.activeElement as HTMLElement | null;
  // the editor and the file tree own their own arrows; a name being typed keeps all of them, and a
  // caret in a find field keeps the sideways ones
  const sideways = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (active?.closest('.res-editor, .res-files')) return false;
  if (active?.closest('.res-name, .res-newdoc')) return false;
  if (sideways && active?.closest('input, textarea')) return false;

  const col = Math.max(0, COLS.findIndex((sel) => active?.closest(sel)));
  const here = rowsOf(shelf, col);
  const row = active ? here.indexOf(active) : -1;

  // the tree walks as folders do: right opens a shut folder and only then leaves for the list, left shuts
  // an open one, and left on a source climbs to the tier it stands under
  if (sideways && col === 0 && row >= 0) {
    const node = here[row];
    if (isFolder(node)) {
      const open = node.getAttribute('aria-expanded') === 'true';
      if (open === (e.key === 'ArrowLeft')) { toggle(node); return true; }
      if (!open) return true;
    } else if (e.key === 'ArrowLeft') {
      const parent = here.slice(0, row).reverse().find(isFolder);
      if (parent) { parent.focus(); walked = true; parent.click(); }
      return true;
    }
  }

  const to = step({ col, row }, COLS.map((_, i) => rowsOf(shelf, i).length), e.key);
  if (to === undefined) return false;
  if (to === 'editor') { shelf.querySelector<HTMLElement>('.res-editor :is(.cm-content, .res-field)')?.focus(); return true; }

  const rows = to.col === col ? here : rowsOf(shelf, to.col);
  const chosen = rows.findIndex((el) => el.matches('[aria-pressed="true"], [data-active="true"]'));
  const next = rows[to.row === -1 ? (chosen === -1 ? 0 : chosen) : to.row];
  if (!next) return false;
  next.focus();
  // walking a column picks as it goes, but only rows the pane can show: a link and a row that opens
  // Finder act on the press, so they take the keys alone. A column entered sideways keeps its pick.
  if (to.col === col && !next.matches('[data-opens="false"]')) { walked = true; next.click(); }
  return true;
}
