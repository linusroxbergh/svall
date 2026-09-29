export type Chord = string;

export type KeyAction =
  | { type: 'newCharacter' }
  | { type: 'missionControl' }
  | { type: 'arrange' }
  | { type: 'closeCharacter' }
  | { type: 'prevCharacter' }
  | { type: 'nextCharacter' }
  | { type: 'toggleView' }
  | { type: 'toggleSideCard' }
  | { type: 'toggleSettings' }
  | { type: 'toggleResources' }
  | { type: 'zoom'; steps: number }
  | { type: 'toggleCardSize' }
  | { type: 'showPane'; pane: 'terminal' | 'browser' | 'files' | 'changes' }
  | { type: 'nextIsland' }
  | { type: 'toggleBrowser' }
  | { type: 'focusAddress' }
  | { type: 'openLink' }
  | { type: 'fillLogin' }
  | { type: 'openFleets' }
  | { type: 'none' };

export type ActionId =
  | 'newCharacter' | 'missionControl' | 'arrange' | 'closeCharacter'
  | 'prevCharacter' | 'nextCharacter' | 'nextIsland'
  | 'toggleView' | 'toggleSideCard' | 'toggleCardSize' | 'toggleSettings' | 'toggleResources'
  | 'paneTerminal' | 'paneBrowser' | 'paneFiles' | 'paneChanges'
  | 'toggleBrowser' | 'focusAddress' | 'openLink' | 'fillLogin' | 'openFleets'
  | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'quit';

// `also` carries the chords a layout may put the same key on; they follow the shipped chord, not a chosen one
export type ActionSpec = { label: string; action: KeyAction; chord: Chord; also?: Chord[] };

// Shipped chords stay on letters and digits: a bracket or a slash needs Option on many layouts,
// and Option is what keeps a chord out of the terminal's reach.
export const ACTIONS: Record<ActionId, ActionSpec> = {
  newCharacter: { label: 'New character', action: { type: 'newCharacter' }, chord: 'cmd+t' },
  missionControl: { label: 'Mission control', action: { type: 'missionControl' }, chord: 'cmd+g' },
  arrange: { label: 'Arrange the fleet', action: { type: 'arrange' }, chord: 'cmd+shift+a' },
  closeCharacter: { label: 'Close', action: { type: 'closeCharacter' }, chord: 'cmd+w' },
  prevCharacter: { label: 'Previous character', action: { type: 'prevCharacter' }, chord: 'cmd+k' },
  nextCharacter: { label: 'Next character', action: { type: 'nextCharacter' }, chord: 'cmd+j' },
  nextIsland: { label: 'Next island', action: { type: 'nextIsland' }, chord: 'cmd+shift+j' },
  toggleView: { label: 'Map or board', action: { type: 'toggleView' }, chord: 'cmd+m' },
  toggleSideCard: { label: 'Side card', action: { type: 'toggleSideCard' }, chord: 'cmd+i' },
  toggleCardSize: { label: 'Card size', action: { type: 'toggleCardSize' }, chord: 'cmd+enter' },
  toggleSettings: { label: 'Settings', action: { type: 'toggleSettings' }, chord: 'cmd+,' },
  toggleResources: { label: 'Resources', action: { type: 'toggleResources' }, chord: 'cmd+shift+r' },
  paneTerminal: { label: 'Terminal pane', action: { type: 'showPane', pane: 'terminal' }, chord: 'cmd+1' },
  paneBrowser: { label: 'Browser pane', action: { type: 'showPane', pane: 'browser' }, chord: 'cmd+2' },
  paneFiles: { label: 'Files pane', action: { type: 'showPane', pane: 'files' }, chord: 'cmd+3' },
  paneChanges: { label: 'Changes pane', action: { type: 'showPane', pane: 'changes' }, chord: 'cmd+4' },
  toggleBrowser: { label: 'Browser on the right', action: { type: 'toggleBrowser' }, chord: 'cmd+b' },
  focusAddress: { label: 'Address bar', action: { type: 'focusAddress' }, chord: 'cmd+l' },
  openLink: { label: 'Open the first link', action: { type: 'openLink' }, chord: 'cmd+u' },
  fillLogin: { label: 'Fill a login', action: { type: 'fillLogin' }, chord: 'cmd+shift+p' },
  openFleets: { label: 'Open a fleet', action: { type: 'openFleets' }, chord: 'cmd+shift+o' },
  // the key that carries + and the one that carries = , so the layout in use does not matter
  zoomIn: { label: 'Zoom in', action: { type: 'zoom', steps: 1 }, chord: 'cmd+=', also: ['cmd++', 'cmd+shift++'] },
  zoomOut: { label: 'Zoom out', action: { type: 'zoom', steps: -1 }, chord: 'cmd+-' },
  zoomReset: { label: 'Actual size', action: { type: 'zoom', steps: 0 }, chord: 'cmd+0' },
  // the shell takes this chord itself (quit.ts tells it which), so the page has nothing to run
  quit: { label: 'Quit Svall', action: { type: 'none' }, chord: 'cmd+q' },
};

export const actionIds = (): ActionId[] => Object.keys(ACTIONS) as ActionId[];

// only what the user changed: a chord of their own, or null for an action they left unbound
export type Bindings = Partial<Record<ActionId, Chord | null>>;

// the chords an install made before the shipped set moved, kept so an upgrade changes nothing
export const LEGACY_BINDINGS: Bindings = {
  prevCharacter: 'cmd+q',
  nextCharacter: 'cmd+e',
  nextIsland: 'cmd+d',
  quit: 'cmd+shift+q',
};

export const chordFor = (id: ActionId, b: Bindings = {}): Chord | null =>
  id in b ? (b[id] ?? null) : ACTIONS[id].chord;

// every chord an action answers to: the aliases come along only while it sits where it shipped
export function chordsOf(id: ActionId, b: Bindings = {}): Chord[] {
  const spec = ACTIONS[id];
  const chord = chordFor(id, b);
  if (!chord) return [];
  return chord === spec.chord ? [chord, ...(spec.also ?? [])] : [chord];
}

export function resolve(b: Bindings = {}): Record<Chord, KeyAction> {
  const out: Record<Chord, KeyAction> = {};
  const aliases: [Chord, KeyAction][] = [];
  for (const id of actionIds()) {
    const [chord, ...rest] = chordsOf(id, b);
    if (!chord) continue;
    out[chord] = ACTIONS[id].action;
    for (const a of rest) aliases.push([a, ACTIONS[id].action]);
  }
  // an alias only fills a chord no action asked for by name, so a chosen key is never taken back
  for (const [a, action] of aliases) out[a] ??= action;
  return out;
}

export const holderOf = (chord: Chord, b: Bindings = {}): ActionId | undefined =>
  actionIds().find((id) => chordFor(id, b) === chord) ?? actionIds().find((id) => chordsOf(id, b).includes(chord));

// what the first launch on a machine does with the chords the user's own Ghostty config already spends:
// leaves them alone, so installing the app changes nothing about the keyboard until they say so
export function declineTaken(taken: Record<Chord, string>, b: Bindings = {}): Bindings {
  const out: Bindings = { ...b };
  for (const id of actionIds()) {
    if (chordsOf(id, b).some((c) => taken[c])) out[id] = null;
  }
  return out;
}

type KeyLike = { key: string; metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean };

export function chordOf(e: KeyLike): Chord | undefined {
  if (!e.metaKey || e.ctrlKey || e.altKey) return undefined;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key === 'Enter' ? 'enter' : undefined;
  if (!key) return undefined;
  return `cmd+${e.shiftKey ? 'shift+' : ''}${key}`;
}

// what a row shows: ⌘⇧J rather than cmd+shift+j
const SYMBOL: Record<string, string> = { enter: '↩', '-': '−' };
export function chordLabel(chord: Chord | null): string {
  if (!chord) return '—';
  const parts = chord.split('+');
  // a trailing '+' splits into an empty tail; the key it names is the plus sign itself
  const key = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
  return `⌘${parts.includes('shift') ? '⇧' : ''}${SYMBOL[key] ?? key.toUpperCase()}`;
}

// the key an action answers to now, as a hint names it; none once the action is unbound
export function keyLabel(id: ActionId, b: Bindings = {}): string | undefined {
  const chord = chordFor(id, b);
  return chord ? chordLabel(chord) : undefined;
}

export function keyTip(text: string, id: ActionId, b: Bindings = {}): string {
  const key = keyLabel(id, b);
  return key ? `${text} (${key})` : text;
}
