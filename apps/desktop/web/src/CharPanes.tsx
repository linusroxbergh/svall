import { useRef } from 'react';
import { openSecondTerminal } from './actions.js';
import { app, deps } from './boot.js';
import { BrowserArea } from './BrowserArea.js';
import { useApp } from './hooks.js';
import { Changes } from './ide/Changes.js';
import { FilesArea } from './ide/FilesArea.js';
import { keyTip, type ActionId } from './keys.js';
import { closeSide, isTerminal, kindOf, pick, shows, snapRatio, split, type Kind, type Panes, type Side, type Surface } from './panes.js';
import { panesOf, slotStatus } from './selectors.js';
import { TerminalArea } from './TerminalArea.js';

// a pane divided in two, the half it gains filled in
const SplitGlyph = () => (
  <svg className="split-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <rect x="13" y="7" width="6.5" height="10" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const KINDS: { kind: Kind; label: string; action: ActionId }[] = [
  { kind: 'terminal', label: 'Terminal', action: 'paneTerminal' },
  { kind: 'browser', label: 'Browser', action: 'paneBrowser' },
  { kind: 'files', label: 'Files', action: 'paneFiles' },
  { kind: 'changes', label: 'Changes', action: 'paneChanges' },
];

// the half a pane gives back, crossed out
const UnsplitGlyph = ({ side }: { side: Side }) => {
  const x = side === 'left' ? 4.5 : 14;
  return (
    <svg className="split-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="M12 4.5v15" />
      <path d={`M${x} 9l5.5 6M${x + 5.5} 9l-5.5 6`} />
    </svg>
  );
};

type Props = { id: string; opacity?: number; lead?: React.ReactNode; trail?: React.ReactNode };

// one or two panes of a character, each with the control that says what it holds;
// the card's own name and marks ride the same row, at the far left and the far right
export function CharPanes({ id, opacity, lead, trail }: Props) {
  const c = useApp((s) => s.fleet.characters[id]);
  const panes = useApp((s) => panesOf(s, id));
  const ratio = useApp((s) => s.ide[id]?.ratio ?? 0.5);
  const bindings = useApp((s) => s.settings.bindings);
  const host = useRef<HTMLDivElement>(null);
  if (!c) return null;
  const two = panes.right !== undefined;

  const set = (next: Panes) => {
    if (shows(next, 'terminal2') && !c.second) openSecondTerminal(deps(), id);
    app.store.getState().setPanes(id, next);
  };
  const dragTo = (e: React.PointerEvent<HTMLElement>) => {
    const box = host.current?.getBoundingClientRect();
    if (!box || e.buttons === 0 || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    app.store.getState().setRatio(id, snapRatio((e.clientX - box.left) / box.width));
  };

  const body = (surface: Surface, side: Side) => {
    // in a split only the left pane takes the keyboard
    const aside = two && side === 'right';
    return surface === 'browser' ? <BrowserArea key={id} id={id} aside={aside} />
      : surface === 'files' ? <FilesArea key={id} id={id} />
      : surface === 'changes' ? <Changes key={id} id={id} />
      // the side is in the key so a terminal moved across remounts and takes or leaves the keyboard anew
      : <TerminalArea key={`${id}:${surface}:${side}`} id={id} second={surface === 'terminal2'} aside={aside} opacity={opacity} />;
  };

  const pane = (side: Side, surface: Surface) => (
    <div className="pane" data-testid={`pane-${side}`} style={side === 'left' && two ? { flex: `0 0 ${ratio * 100}%` } : undefined}>
      <div className="phead" onPointerDown={(e) => e.stopPropagation()}>
        {side === 'left' && lead}
        <span className="tseg" role="tablist">
          {KINDS.map(({ kind, label, action }) => (
            <button key={kind} className="tbtn" role="tab" data-testid={`pane-${side}-${kind}`} data-active={kindOf(surface) === kind}
              title={side === 'left' ? keyTip(label, action, bindings) : label} onClick={() => set(pick(panes, side, kind))}>
              {kind === 'terminal' && c.second && isTerminal(surface) && <i className="sdot" data-status={slotStatus(c, surface === 'terminal2' ? 2 : 1)} />}
              {kind === 'terminal' && surface === 'terminal2' ? 'Terminal 2' : label}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {two
          ? <button className="px" data-testid={`pane-${side}-close`} title="Close this pane" aria-label="Close this pane" onClick={() => set(closeSide(panes, side))}><UnsplitGlyph side={side} /></button>
          : <button className="tbtn psplit" data-testid="pane-split" title="Split in two" onClick={() => set(split(panes))}><SplitGlyph />Split</button>}
        {(side === 'right' || !two) && trail}
      </div>
      <div className="pbody">{body(surface, side)}</div>
    </div>
  );

  return (
    <div ref={host} className="panes" data-testid="panes">
      {pane('left', panes.left)}
      {panes.right && (
        // the native surfaces are drawn over the page, so the divider is a strip of its own between them
        <i className="pdivider" data-testid="pane-divider" title="Drag to resize" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={dragTo} onDoubleClick={(e) => { e.stopPropagation(); app.store.getState().setRatio(id, 0.5); }} />
      )}
      {panes.right && pane('right', panes.right)}
    </div>
  );
}
