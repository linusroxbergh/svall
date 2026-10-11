import type { AgentKind } from '@svall/protocol';
import type { Screen } from '../tmux/tmux.js';

/** The agent's prompt line as its pane shows it: empty, holding text the user typed, or out of view under a dialog or menu. */
export type Composer = 'empty' | 'draft' | 'hidden';

// OpenCode draws its placeholder in the theme's muted colour, and only on its home screen
const OPENCODE_PLACEHOLDER = /^(Ask anything|Run a command)… "/;

export function readComposer(kind: AgentKind, s: Screen): Composer {
  // all three hide the cursor while a dialog or a menu has the keys
  if (s.cursor === undefined) return 'hidden';
  const row = s.rows[s.cursor] ?? '';
  if (kind === 'opencode') return readOpencode(row, s.rows[s.cursor - 1] ?? '');
  // Claude Code and Codex start the prompt line with a marker and draw its placeholder faint. A row without the
  // marker has the cursor further down a draft, or in a field of their own. Claude Code follows its marker with a no-break space
  const line = plain(row, false);
  const marker = kind === 'claude' ? '❯' : '›';
  const rest = line.slice(marker.length);
  if (!line.startsWith(marker) || /^\S/.test(rest)) return 'draft';
  return rest.trim() ? 'draft' : 'empty';
}

// OpenCode's prompt box has a bar down its left side and a blank row at its top, so a row above the cursor's with text
// in it is the draft's
function readOpencode(row: string, above: string): Composer {
  const line = plain(row);
  const bar = line.indexOf('┃');
  if (bar < 0) return 'draft';
  const prev = plain(above);
  if (prev[bar] === '┃' && prev.slice(bar + 1).trim()) return 'draft';
  const input = line.slice(bar + 1).trim();
  return !input || OPENCODE_PLACEHOLDER.test(input) ? 'empty' : 'draft';
}

// a row as capture-pane -e prints it, without its escapes, and without its faint text unless `faint`
function plain(row: string, faint = true): string {
  let out = '';
  let dim = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== '\x1b') {
      if (faint || !dim) out += row[i];
      continue;
    }
    if (row[i + 1] === '[') {
      let end = i + 2;
      while (end < row.length && !/[@-~]/.test(row[end])) end++;
      if (row[end] === 'm') dim = sgrFaint(row.slice(i + 2, end), dim);
      i = end;
    } else if (row[i + 1] === ']') {
      // an OSC, as a hyperlink, ends at BEL or at ESC \
      const end = row.slice(i).search(/\x07|\x1b\\/);
      i = end < 0 ? row.length : i + end + (row[i + end] === '\x07' ? 0 : 1);
    } else i++;
  }
  return out;
}

// the numbers after 38, 48 or 58 name a colour, so a 2 among them is no faint
function sgrFaint(params: string, dim: boolean): boolean {
  const ps = params.split(';');
  for (let k = 0; k < ps.length; k++) {
    const n = Number(ps[k].split(':')[0] || 0);
    if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
    else if ((n === 38 || n === 48 || n === 58) && !ps[k].includes(':')) k += ps[k + 1] === '5' ? 2 : 4;
  }
  return dim;
}
