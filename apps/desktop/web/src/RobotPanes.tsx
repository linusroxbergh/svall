import { useRef } from 'react';
import { openSecondTerminal } from './actions.js';
import { app, deps } from './boot.js';
import { BrowserArea } from './BrowserArea.js';
import { useApp } from './hooks.js';
import { Split, Unsplit } from './icons.js';
import { Changes } from './ide/Changes.js';
import { Glide } from './Glide.js';
import { FilesArea } from './ide/FilesArea.js';
import { MachineLine } from './indicators.js';
import { keyTip, type ActionId } from './keys.js';
import { closeSide, isTerminal, kindOf, pick, shows, snapRatio, split, type Kind, type Panes, type Side, type Surface } from './panes.js';
import { awayLine, machineOf } from './placement.js';
import { panesOf, slotStatus } from './selectors.js';
import { TerminalArea } from './TerminalArea.js';

const KINDS: { kind: Kind; label: string; action: ActionId }[] = [
  { kind: 'terminal', label: 'Terminal', action: 'paneTerminal' },
  { kind: 'browser', label: 'Browser', action: 'paneBrowser' },
  { kind: 'files', label: 'Files', action: 'paneFiles' },
  { kind: 'changes', label: 'Changes', action: 'paneChanges' },
];

type Props = { id: string; opacity?: number; lead?: React.ReactNode; trail?: React.ReactNode };

// one or two panes of a robot, each with the control that says what it holds;
// the card's own name and marks ride the same row, at the far left and the far right
export function RobotPanes({ id, opacity, lead, trail }: Props) {
  const c = useApp((s) => s.fleet.robots[id]);
  const panes = useApp((s) => panesOf(s, id));
  const ratio = useApp((s) => s.ide[id]?.ratio ?? 0.5);
  const bindings = useApp((s) => s.settings.bindings);
  const machines = useApp((s) => s.fleet.machines);
  const host = useRef<HTMLDivElement>(null);
  if (!c) return null;
  const two = panes.right !== undefined;
  // the files of a robot on a worker are read there, so they wait while it is out of reach
  const away = awayLine({ machines }, c);
  const on = machineOf({ machines }, c);

  const set = (next: Panes) => {
    if (shows(next, 'terminal2') && !c.second?.tmux) openSecondTerminal(deps(), id);
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
    if (away && (surface === 'files' || surface === 'changes')) return <div className="ide-empty" data-testid="pane-elsewhere">{away}</div>;
    // a move takes the files to another machine, and the views mount anew to watch them there
    const at = `${id}@${c.machine ?? ''}`;
    return surface === 'browser' ? <BrowserArea key={id} id={id} aside={aside} />
      : surface === 'files' ? <FilesArea key={at} id={id} />
      : surface === 'changes' ? <Changes key={at} id={id} />
      // the side is in the key so a terminal moved across remounts and takes or leaves the keyboard anew
      : <TerminalArea key={`${id}:${surface}:${side}`} id={id} second={surface === 'terminal2'} aside={aside} opacity={opacity} />;
  };

  const pane = (side: Side, surface: Surface) => (
    <div className="pane" data-testid={`pane-${side}`} style={side === 'left' && two ? { flex: `0 0 ${ratio * 100}%` } : undefined}>
      <div className="phead" onPointerDown={(e) => e.stopPropagation()}>
        {side === 'left' && lead}
        <span className="seg" role="tablist">
          <Glide at={kindOf(surface)} />
          {KINDS.map(({ kind, label, action }) => (
            <button key={kind} role="tab" data-testid={`pane-${side}-${kind}`} data-active={kindOf(surface) === kind}
              data-tip={side === 'left' ? keyTip(label, action, bindings) : label} onClick={() => set(pick(panes, side, kind))}>
              {kind === 'terminal' && c.second && isTerminal(surface) && <i className="sdot" data-status={slotStatus(c, surface === 'terminal2' ? 2 : 1)} />}
              {kind === 'terminal' && surface === 'terminal2' ? 'Terminal 2' : label}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {two
          ? <button className="ib bar px" data-testid={`pane-${side}-close`} data-tip="Close this pane" aria-label="Close this pane" onClick={() => set(closeSide(panes, side))}><Unsplit side={side} /></button>
          : <button className="btn sm psplit" data-testid="pane-split" data-tip="Split in two" onClick={() => set(split(panes))}><Split />Split</button>}
        {(side === 'right' || !two) && trail}
      </div>
      {on && <MachineLine name={on} className="pon" testid={`pane-${side}-machine`} />}
      <div className="pbody">{body(surface, side)}</div>
    </div>
  );

  return (
    <div ref={host} className="panes" data-testid="panes">
      {pane('left', panes.left)}
      {panes.right && (
        // the native surfaces are drawn over the page, so the divider is a strip of its own between them
        <i className="pdivider" data-testid="pane-divider" data-tip="Drag to resize" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={dragTo} onDoubleClick={(e) => { e.stopPropagation(); app.store.getState().setRatio(id, 0.5); }} />
      )}
      {panes.right && pane('right', panes.right)}
    </div>
  );
}
