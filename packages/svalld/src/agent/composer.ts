import type { AgentKind } from '@svall/protocol';
import type { Screen } from '../tmux/tmux.js';

/** The agent's prompt line as its pane shows it: empty, holding text the user typed, or out of view under a dialog or menu. */
export type Composer = 'empty' | 'draft' | 'hidden';

// OpenCode draws its placeholder in the theme's muted colour, and only on its home screen
const OPENCODE_PLACEHOLDER = /^(Ask anything|Run a command)… "/;

/** The agent a pane runs, by the process name tmux reports for it: Claude Code's native install's is its version. */
export const agentInFront = (command: string): AgentKind | undefined =>
  /^\d+\.\d+\.\d+$/.test(command) ? 'claude' : command === 'claude' || command === 'codex' || command === 'opencode' ? command : undefined;

export function readComposer(kind: AgentKind, s: Screen): Composer {
  // all three hide the cursor while a dialog or a menu has the keys. A Claude Code that paints its own cursor hides the
  // terminal's for good, parked on its prompt line
  if (!s.shown && !(kind === 'claude' && plain(s.rows[s.cursor] ?? '').startsWith('❯\u00a0'))) return 'hidden';
  if (kind === 'opencode') return readOpencode(s.rows, s.cursor);
  // Claude Code and Codex start the prompt line with a marker and draw its placeholder faint. A row without the
  // marker has the cursor further down a draft, or in a field of their own. Claude Code follows its marker with a no-break space
  const line = plain(s.rows[s.cursor] ?? '', false);
  const marker = kind === 'claude' ? '❯' : '›';
  const rest = line.slice(marker.length);
  if (!line.startsWith(marker) || /^\S/.test(rest) || rest.trim()) return 'draft';
  // a draft's further lines sit under its first, down to Claude Code's rule or Codex's blank row
  for (const r of s.rows.slice(s.cursor + 1)) {
    const more = plain(r, false).trim();
    if (kind === 'claude' ? plain(r).trimStart().startsWith('─') : !more) break;
    if (more) return 'draft';
  }
  return 'empty';
}

/** Whether a pane shows Codex's review of hooks it has not trusted, which holds its start until answered. */
export const codexHooksReview = (s: Screen): boolean => !s.shown && s.rows.some((r) => plain(r).trim() === 'Hooks need review');

// OpenCode's prompt box has a bar down its left side, a blank row at its top and the agent and model in its last row
function readOpencode(rows: string[], cursor: number): Composer {
  const bar = plain(rows[cursor] ?? '').indexOf('┃');
  if (bar < 0) return 'draft';
  const inBox = (i: number) => plain(rows[i] ?? '')[bar] === '┃';
  let top = cursor;
  while (inBox(top - 1)) top--;
  let end = cursor + 1;
  while (inBox(end)) end++;
  const input = rows.slice(top, Math.max(end - 1, cursor + 1)).map((r) => plain(r).slice(bar + 1).trim()).filter(Boolean);
  return input.every((t) => OPENCODE_PLACEHOLDER.test(t)) ? 'empty' : 'draft';
}

type Attrs = { dim: boolean; inverse: boolean };

// a row as capture-pane -e prints it, without its escapes, and without its faint text unless `faint`; with that text goes
// the inverse letter before it, a cursor Claude Code paints on its placeholder's first letter
function plain(row: string, faint = true): string {
  const cells: (Attrs & { ch: string })[] = [];
  let attrs: Attrs = { dim: false, inverse: false };
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== '\x1b') {
      cells.push({ ch: row[i], ...attrs });
      continue;
    }
    if (row[i + 1] === '[') {
      let end = i + 2;
      while (end < row.length && !/[@-~]/.test(row[end])) end++;
      if (row[end] === 'm') attrs = sgr(row.slice(i + 2, end), attrs);
      i = end;
    } else if (row[i + 1] === ']') {
      // an OSC, as a hyperlink, ends at BEL or at ESC \
      const end = row.slice(i).search(/\x07|\x1b\\/);
      i = end < 0 ? row.length : i + end + (row[i + end] === '\x07' ? 0 : 1);
    } else i++;
  }
  return cells.filter((c, k) => faint || !(c.dim || (c.inverse && cells[k + 1]?.dim))).map((c) => c.ch).join('');
}

// the numbers after 38, 48 or 58 name a colour, so a 2 or a 7 among them is neither faint nor inverse
function sgr(params: string, attrs: Attrs): Attrs {
  let { dim, inverse } = attrs;
  const ps = params.split(';');
  for (let k = 0; k < ps.length; k++) {
    const n = Number(ps[k].split(':')[0] || 0);
    if (n === 0) dim = inverse = false;
    else if (n === 22) dim = false;
    else if (n === 2) dim = true;
    else if (n === 27) inverse = false;
    else if (n === 7) inverse = true;
    else if ((n === 38 || n === 48 || n === 58) && !ps[k].includes(':')) k += ps[k + 1] === '5' ? 2 : 4;
  }
  return { dim, inverse };
}
