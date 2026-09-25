// what a pane can hold; terminal2 is the character's second terminal
export type Surface = 'terminal' | 'terminal2' | 'browser' | 'files' | 'changes';
// what a pane's control offers: Terminal stands for whichever terminal the other side does not hold
export type Kind = 'terminal' | 'browser' | 'files' | 'changes';
export type Side = 'left' | 'right';
export type Panes = { left: Surface; right?: Surface };

export const SINGLE: Panes = { left: 'terminal' };

export const isTerminal = (s?: Surface): boolean => s === 'terminal' || s === 'terminal2';
export const kindOf = (s: Surface): Kind => (isTerminal(s) ? 'terminal' : (s as Kind));
export const shows = (p: Panes, s: Surface): boolean => p.left === s || p.right === s;

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');
const put = (p: Panes, side: Side, s: Surface): Panes => (side === 'left' ? { ...p, left: s } : { ...p, right: s });

export function pick(p: Panes, side: Side, kind: Kind): Panes {
  const across = p[other(side)];
  if (kind === 'terminal') {
    if (isTerminal(p[side])) return p;
    return put(p, side, across === 'terminal' ? 'terminal2' : 'terminal');
  }
  if (across === kind && p.right) return { left: p.right, right: p.left };
  return put(p, side, kind);
}

// ⌘1–⌘4: the left pane takes the kind; a terminal asked for by key is the main one, swapped over if it is on the right
export function mainLeft(p: Panes, kind: Kind): Panes {
  if (kind !== 'terminal') return pick(p, 'left', kind);
  if (p.right === 'terminal') return { left: 'terminal', right: p.left };
  return { ...p, left: 'terminal' };
}

export const split = (p: Panes): Panes => (p.right ? p : { left: p.left, right: p.left === 'terminal' ? 'terminal2' : 'terminal' });

export const closeSide = (p: Panes, side: Side): Panes => (!p.right ? p : { left: side === 'left' ? p.right : p.left });

// the pane that showed the second terminal closes, and the other takes the whole width
export const withoutSecond = (p: Panes): Panes => (!shows(p, 'terminal2') ? p : { left: p.left === 'terminal2' ? p.right ?? 'terminal' : p.left });

export function toggleBrowserRight(p: Panes): Panes {
  if (p.right === 'browser') return { left: p.left };
  if (p.left === 'browser') return p.right ? { left: p.right, right: 'browser' } : { left: 'terminal' };
  return { left: p.left, right: 'browser' };
}

export const showBrowser = (p: Panes): Panes => (shows(p, 'browser') ? p : { left: p.left, right: 'browser' });

export const snapRatio = (r: number): number => {
  const clamped = Math.min(0.75, Math.max(0.25, r));
  return Math.abs(clamped - 0.5) < 0.025 ? 0.5 : clamped;
};
