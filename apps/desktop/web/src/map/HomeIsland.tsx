import type { Robot, ContextItem, Home as HomeConfig, HomeAction, Island } from '@svall/protocol';
import { useMemo, useState } from 'react';
import type { DropTarget } from '../drop.js';
import { stop } from '../hooks.js';
import { Caret } from '../icons.js';
import type { DisplayStatus } from '../selectors.js';
import { theme } from '../theme.js';
import { coastPath } from './coast.js';
import { LandTexture } from './LandTexture.js';
import { Seabed, Waterline } from './Relief.js';
import { Token } from './Token.js';
import type { Drag, PointerHandlers } from './types.js';

const PAD_CELLS = theme.pad / theme.cell;

// what the shipped skills do, said by the button that runs one; a button of the user's own says its prompt
const SKILLS: Record<string, string[]> = {
  '/svall-status': ["Reads every robot's screen", "Lists who needs you, what's ready to review and what's working", 'Saves that report as its note; changes nothing else'],
  '/svall-update-info': ["The scribe reads every agent's transcript", 'Updates robot names, notes and links, and island descriptions', 'Keeps notes and descriptions you wrote', 'Takes a few minutes'],
  '/svall-rename': ["The scribe reads every agent's transcript", "Renames each robot for what it's doing", 'Takes a few minutes'],
  '/svall-organise': ["Updates every robot's name, note and links", 'Moves robots onto islands that fit their work, making new islands as needed', 'Describes every island', "Leaves mission control's robots where they are"],
  '/svall-retro': ['Reads what the agents did over a span you pick', "Asks before it runs, with the model's cost", 'Lists findings for skills, reviews and instructions', 'Changes a file only after you OK its diff'],
};
const actionTip = (a: HomeAction): string => (SKILLS[a.prompt]
  ? [`Starts a mission control robot that runs ${a.prompt}`, ...SKILLS[a.prompt].map((l) => `• ${l}`)].join('\n')
  : `Starts a mission control robot named ${a.label} and sends it:\n${a.prompt}`);

// the land shrinks by `scale` towards the bottom centre, its cards stand at `cards`, and the row stays full size above them
export function Home({
  island, crew, config, collapsed, selected, selectedId, drag, status, failed, links, shift, rowShift, mapW, scale, cards = scale, extra,
  onToggle, onAction, onArrange, onNewIsland, onNew, label, tokenPointer, onHoverStart, onHoverEnd, onOpen, onLink, onMenu, dropHover,
}: {
  island: Island;
  crew: Robot[];
  config: HomeConfig;
  collapsed: boolean;
  selected: boolean;
  selectedId?: string;
  drag?: Drag;
  status(c: Robot): DisplayStatus;
  failed?(c: Robot): string | undefined;
  links?: boolean;
  shift: number;
  // the shift the window's width alone gives home: the row wraps by it, so its height never follows the map's zoom
  rowShift: number;
  // the map's width, which the row wraps within
  mapW: number;
  scale: number;
  cards?: number;
  extra?: React.ReactNode;
  onToggle(): void;
  onAction(a: HomeAction): Promise<void>;
  onArrange(): void;
  onNewIsland(): void;
  onNew(): void;
  label: PointerHandlers;
  tokenPointer(id: string): PointerHandlers;
  onHoverStart(id: string): void;
  onHoverEnd(): void;
  onOpen(id: string): void;
  onLink(item: ContextItem, robotId: string, at: { x: number; y: number }): void;
  onMenu(id: string, e: React.MouseEvent): void;
  dropHover?: DropTarget;
}) {
  // an action holds the daemon for up to the run timeout; the row stays disabled so one press is one crew member
  const [busy, setBusy] = useState<string>();
  const press = (a: HomeAction) => { setBusy(a.label); void onAction(a).finally(() => setBusy(undefined)); };
  const { cell, pad } = theme;
  const fw = island.size.w * cell, fh = island.size.h * cell;
  const bw = fw + pad * 2, bh = fh + pad * 2;
  const cx = bw / 2, cy = bh / 2;
  const seed = String(island.seed);
  const sand = useMemo(() => coastPath(fw, fh, seed, 0), [fw, fh, seed]);
  const dune = useMemo(() => coastPath(fw, fh, seed, -16), [fw, fh, seed]);
  const over = drag?.kind === 'figure' && drag.over?.islandId === island.id ? drag.over : undefined;
  const count = crew.filter((c) => !(drag?.kind === 'figure' && drag.id === c.id)).length;
  return (
    <div className="home" data-testid="home" data-collapsed={collapsed} data-selected={selected} style={{ width: bw, left: `calc(50% + ${shift}px)` }}>
      {!collapsed && (
        <div className="island" data-drop={`island:${island.id}`} data-drop-hover={dropHover?.kind === 'island' && dropHover.id === island.id}
          style={{ left: 0, bottom: -(bh - pad - theme.home.visible), width: bw, height: bh,
            transform: `scale(${scale})`, transformOrigin: `50% ${pad + theme.home.visible}px`, '--k': cards / scale } as React.CSSProperties}>
          <svg data-testid="island-home" width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}>
            <defs>
              <linearGradient id="s-home" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--home-sand)" />
                <stop offset="1" stopColor="var(--home-sand-deep)" />
              </linearGradient>
            </defs>
            <Seabed sand={sand} cx={cx} cy={cy} bank="var(--home-bank)" />
            <g {...label} style={{ pointerEvents: 'visiblePainted' }}>
              <path className="land" d={sand} fill="url(#s-home)" stroke="rgba(120,104,68,.28)" strokeWidth="1" />
              <path className="land grass" d={dune} fill="rgba(255,250,236,.33)" />
            </g>
          </svg>
          <LandTexture shape={sand} />
          <svg className="waterline" width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}><Waterline sand={sand} /></svg>
          {over && (
            <div className="drop-cell" data-testid="drop-cell" data-free={over.free}
              style={{ left: pad + over.local.x * cell, top: pad + over.local.y * cell, width: cell, height: cell }} />
          )}
          {crew.map((c) => {
            const dragging = drag?.kind === 'figure' && drag.id === c.id;
            const at = dragging && over ? over.local : c.cell;
            return (
              <Token key={c.id} c={c} status={status(c)} world={{ x: at.x + PAD_CELLS, y: at.y + PAD_CELLS }} links={links}
                selected={c.id === selectedId} dragging={dragging} hover={dropHover?.kind === 'robot' && dropHover.id === c.id} failed={failed?.(c)}
                pointer={tokenPointer(c.id)} onHoverStart={() => onHoverStart(c.id)} onHoverEnd={onHoverEnd}
                onOpen={() => onOpen(c.id)} onLink={onLink} onMenu={(e) => onMenu(c.id, e)} />
            );
          })}
        </div>
      )}
      <div className="hrow" data-testid="home-row"
        style={{ bottom: collapsed ? theme.home.bar : theme.home.visible * scale + theme.home.rowGap, '--map-w': `${mapW}px`, '--home-shift': `${rowShift}px` } as React.CSSProperties}>
        <button className="htog" data-testid="home-toggle" data-tip={collapsed ? 'Show island' : 'Hide island'}
          aria-label={collapsed ? 'Show island' : 'Hide island'} aria-expanded={!collapsed} onPointerDown={stop} onClick={onToggle}>
          <Caret dir={collapsed ? 'up' : 'down'} />
        </button>
        <div className="ilabel" data-testid="island-label-home" {...label}>
          <b>{island.name}</b>
          <span className="ct">{count || 'empty'}</span>
        </div>
        <button className="hact" data-testid="home-arrange" data-tip="Fit islands to their crews and pack them together"
          onPointerDown={stop} onClick={onArrange}>arrange</button>
        {config.actions.map((a, i) => (
          <button key={`${a.label}-${i}`} className="hact" data-testid={`home-action-${a.label}`} disabled={busy !== undefined}
            data-tip={actionTip(a)} onPointerDown={stop} onClick={() => press(a)}>{a.label}</button>
        ))}
        <div className="home-create">
          <button className="hact dim" data-testid="home-new-island" data-tip="Adds an empty island to the map" onPointerDown={stop} onClick={onNewIsland}>+ New island</button>
          <button className="hact dim" data-testid="home-new" data-tip={"Starts a mission control robot for you to talk to\nIt looks after the fleet, not your code"}
            onPointerDown={stop} onClick={onNew}>+ New robot</button>
        </div>
        {extra}
      </div>
    </div>
  );
}
