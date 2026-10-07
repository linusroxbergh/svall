import { type Island as IslandModel } from '@svall/protocol';
import { useMemo } from 'react';
import { theme } from '../theme.js';
import { Chevron } from './Chevron.js';
import { coastPath } from './coast.js';
import { GrassTexture } from './GrassTexture.js';
import { LandTexture } from './LandTexture.js';
import { Seabed, Waterline } from './Relief.js';
import type { HoldHandlers, PointerHandlers } from './types.js';

// the pill sits at the top of the reserved band, clearing a selected card on the top row
const LABEL_OFFSET = theme.bounds.top * theme.cell;

export function Island({
  island, count, hot, selected, dragging, settling, hover, offset, gripOffset, onNew, onToggle, onMenu, land, label, handle, hold,
}: {
  island: IslandModel;
  count: number;
  hot: boolean;
  selected: boolean;
  dragging: boolean;
  settling: boolean;
  hover: boolean;
  offset?: { x: number; y: number };
  gripOffset?: { x: number; y: number };
  onNew(): void;
  onToggle(): void;
  onMenu(e: React.MouseEvent): void;
  land: PointerHandlers;
  label: PointerHandlers;
  handle: PointerHandlers;
  hold: HoldHandlers;
}) {
  const { cell, pad } = theme;
  const fw = island.size.w * cell, fh = island.size.h * cell;
  const bw = fw + pad * 2, bh = fh + pad * 2;
  const cx = bw / 2, cy = bh / 2;
  const seed = String(island.seed);
  const sand = useMemo(() => coastPath(island.size.w * cell, island.size.h * cell, seed, 0), [island.size.w, island.size.h, seed]);
  const grass = useMemo(() => coastPath(island.size.w * cell, island.size.h * cell, seed, -4), [island.size.w, island.size.h, seed]);
  const gid = `g-${island.id}`, sid = `s-${island.id}`;

  return (
    <div
      className="island"
      data-hot={hot}
      data-selected={selected}
      data-dragging={dragging}
      data-settling={settling}
      data-drop={`island:${island.id}`}
      data-drop-hover={hover}
      onContextMenu={onMenu}
      style={{ left: `calc(${island.position.x * cell - pad}px * var(--ms))`, top: `calc(${island.position.y * cell - pad}px * var(--ms))`, width: bw, height: bh,
        '--ox': offset && `${offset.x}px`, '--oy': offset && `${offset.y}px` } as React.CSSProperties}
    >
      <svg data-testid={`island-${island.id}`} width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`}>
        <defs>
          <radialGradient id={gid} cx="40%" cy="30%" r="76%">
            <stop offset="0" stopColor="var(--grass-hi)" />
            <stop offset="1" stopColor="var(--grass)" />
          </radialGradient>
          <linearGradient id={sid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--sand-lite)" />
            <stop offset="1" stopColor="var(--sand-deep)" />
          </linearGradient>
        </defs>
        <Seabed id={island.id} sand={sand} cx={cx} cy={cy} bank="var(--bank)" />
        <g {...land} {...hold} style={{ pointerEvents: 'visiblePainted' }}>
          <path className="land" d={sand} fill={`url(#${sid})`} />
          <path className="land grass" d={grass} fill={`url(#${gid})`} stroke="var(--shore)" strokeWidth="1" />
          <GrassTexture seed={seed} shape={grass} w={fw} h={fh} />
          <LandTexture id={island.id} shape={sand} />
        </g>
        <Waterline sand={sand} />
      </svg>
      {/* a hidden island leaves the map; the sidebar is where it comes back */}
      <div className="ilabel" data-testid={`island-label-${island.id}`} style={{ top: pad - LABEL_OFFSET }} {...label} {...hold}>
        <button className="itog" data-testid={`island-toggle-${island.id}`} title="Hide island" aria-label={`Hide ${island.name}`}
          onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={onToggle}><Chevron up /></button>
        <b>{island.name}</b>
        <span className="ct">{count || 'empty'}</span>
      </div>
      <button
        className="inew"
        data-testid={`island-new-${island.id}`}
        data-empty={count === 0}
        aria-label={`New character on ${island.name}`}
        style={count === 0 ? { left: pad + fw / 2, top: pad + fh / 2 } : { left: pad + fw - 8, top: pad - 4 }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={onNew}
        {...hold}
      >
        + New character
      </button>
      <div
        className="ihandle"
        data-testid={`handle-${island.id}`}
        title="Resize"
        style={{ left: pad + fw - 6, top: pad + fh - 6,
          translate: gripOffset ? `${gripOffset.x}px ${gripOffset.y}px` : undefined }}
        {...handle}
        {...hold}
      />
    </div>
  );
}
