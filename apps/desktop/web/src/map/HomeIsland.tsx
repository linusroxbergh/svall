import type { Character, ContextItem, Home as HomeConfig, HomeAction, Island } from '@svall/protocol';
import { useMemo, useState } from 'react';
import type { DropTarget } from '../drop.js';
import type { DisplayStatus } from '../selectors.js';
import { theme } from '../theme.js';
import { Chevron } from './Chevron.js';
import { coastPath } from './coast.js';
import { LandTexture } from './LandTexture.js';
import { Seabed, Waterline } from './Relief.js';
import { Token } from './Token.js';
import type { Drag, PointerHandlers } from './types.js';

const PAD_CELLS = theme.pad / theme.cell;
const stop = (e: React.PointerEvent) => e.stopPropagation();

// the home island: sandbar land pinned to the bottom centre, its crew, and the label row with the buttons; the land and
// crew shrink by `scale` towards the bottom centre, and the row stays full size above them
export function Home({
  island, crew, config, collapsed, selected, selectedId, drag, status, shift, rowShift, scale, extra,
  onToggle, onAction, onArrange, onNewIsland, onNew, label, tokenPointer, onHoverStart, onHoverEnd, onOpen, onLink, dropHover,
}: {
  island: Island;
  crew: Character[];
  config: HomeConfig;
  collapsed: boolean;
  selected: boolean;
  selectedId?: string;
  drag?: Drag;
  status(c: Character): DisplayStatus;
  shift: number;
  // the shift the window's width alone gives home: the row wraps by it, so its height never follows the map's zoom
  rowShift: number;
  scale: number;
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
  onLink(item: ContextItem, charId: string, at: { x: number; y: number }): void;
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
    <div className="home" data-testid="home" data-collapsed={collapsed} data-selected={selected} style={{ width: bw, left: `calc(50% + ${shift}px)`, '--home-shift': `${rowShift}px` } as React.CSSProperties}>
      {!collapsed && (
        <div className="island" data-drop={`island:${island.id}`} data-drop-hover={dropHover?.kind === 'island' && dropHover.id === island.id}
          style={{ left: 0, bottom: -(bh - pad - theme.home.visible), width: bw, height: bh,
            transform: `scale(${scale})`, transformOrigin: `50% ${pad + theme.home.visible}px` }}>
          <svg data-testid="island-home" width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}>
            <defs>
              <linearGradient id="s-home" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--home-sand)" />
                <stop offset="1" stopColor="var(--home-sand-deep)" />
              </linearGradient>
            </defs>
            <Seabed id="home" sand={sand} cx={cx} cy={cy} bank="var(--home-bank)" />
            <g {...label} style={{ pointerEvents: 'visiblePainted' }}>
              <path className="land" d={sand} fill="url(#s-home)" stroke="rgba(120,104,68,.28)" strokeWidth="1" />
              <path className="land grass" d={dune} fill="rgba(255,250,236,.38)" />
              <LandTexture id="home" shape={sand} />
            </g>
            <Waterline sand={sand} />
          </svg>
          {over && (
            <div className="drop-cell" data-testid="drop-cell" data-free={over.free}
              style={{ left: pad + over.local.x * cell, top: pad + over.local.y * cell, width: cell, height: cell }} />
          )}
          {crew.map((c) => {
            const dragging = drag?.kind === 'figure' && drag.id === c.id;
            const at = dragging && over ? over.local : c.cell;
            return (
              <Token key={c.id} c={c} status={status(c)} world={{ x: at.x + PAD_CELLS, y: at.y + PAD_CELLS }}
                selected={c.id === selectedId} dragging={dragging} hover={dropHover?.kind === 'char' && dropHover.id === c.id}
                pointer={tokenPointer(c.id)} onHoverStart={() => onHoverStart(c.id)} onHoverEnd={onHoverEnd}
                onOpen={() => onOpen(c.id)} onLink={onLink} />
            );
          })}
        </div>
      )}
      <div className="hrow" data-testid="home-row" style={{ bottom: collapsed ? theme.home.bar : theme.home.visible * scale + theme.home.rowGap }}>
        <button className="htog" data-testid="home-toggle" title={collapsed ? 'Show island' : 'Hide island'}
          aria-label={collapsed ? 'Show island' : 'Hide island'} aria-expanded={!collapsed} onPointerDown={stop} onClick={onToggle}>
          <Chevron up={collapsed} />
        </button>
        <div className="ilabel" data-testid="island-label-home" {...label}>
          <b>{island.name}</b>
          <span className="ct">{count || 'empty'}</span>
        </div>
        <button className="hact" data-testid="home-arrange" title="Fit islands to their crews and pack them together"
          onPointerDown={stop} onClick={onArrange}>arrange</button>
        {config.actions.map((a, i) => (
          <button key={`${a.label}-${i}`} className="hact" data-testid={`home-action-${a.label}`} disabled={busy !== undefined}
            onPointerDown={stop} onClick={() => press(a)}>{a.label}</button>
        ))}
        <div className="home-create">
          <button className="hact dim" data-testid="home-new-island" onPointerDown={stop} onClick={onNewIsland}>+ New island</button>
          <button className="hact dim" data-testid="home-new" onPointerDown={stop} onClick={onNew}>+ New character</button>
        </div>
        {extra}
      </div>
    </div>
  );
}
