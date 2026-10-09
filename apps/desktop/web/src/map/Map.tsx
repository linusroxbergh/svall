import { useMemo, useRef } from 'react';
import { HOME_ISLAND, MIN_SIZE } from '@svall/protocol';
import { newCharacterOn, newIsland, startHomeAction, toggleIsland } from '../actions.js';
import { app, deps } from '../boot.js';
import { followLink } from '../LinkAsk.js';
import { useApp } from '../hooks.js';
import { characterMenu, islandMenu } from '../menus.js';
import { ResourcesLayer } from '../resources/Shelf.js';
import { charactersOf, homeIsland, mapIslandsSorted, statusOf } from '../selectors.js';
import { theme } from '../theme.js';
import { Toast, toastCorner } from '../Toast.js';
import { useAutoArrange } from './arrange.js';
import { useCamera } from './camera.js';
import { cardRect } from './card.js';
import { useDevHook } from './devHook.js';
import { homeCrew } from './home.js';
import { Home } from './HomeIsland.js';
import { HoverLayer, useHover } from './hover.js';
import { Island } from './Island.js';
import { cardScale, cellSize, crewOf, labelScale, worldCell } from './layout.js';
import { useRobotMotion } from './motion.js';
import { useMapPointer, type IslandDrag, type PendingIsland } from './pointer.js';
import { ISLET, placeIslet } from './resources.js';
import { ResourcesIsland, ResourcesPill } from './ResourcesIsland.js';
import { TerminalCard } from './TerminalCard.js';
import { Token } from './Token.js';

export function Map() {
  const host = useRef<HTMLDivElement>(null);
  const fleet = useApp((s) => s.fleet);
  const links = useApp((s) => s.settings.cardLinks);
  const selectedId = useApp((s) => s.selectedId);
  const selectedIslandId = useApp((s) => s.selectedIslandId);
  const card = useApp((s) => s.card);
  const cardSize = useApp((s) => s.cardSize);
  const halfCard = useApp((s) => s.halfCard);
  const dropHover = useApp((s) => s.dropHover);
  const active = useApp((s) => s.active);
  const lastPressAt = useRef(-Infinity);
  const hov = useHover();
  const camera = useCamera(host, lastPressAt);
  const { layout, hostSize, rowH } = camera;
  const hi = homeIsland(fleet);
  // where the resources islet stands, and how far home slides left to make room for it
  const place = placeIslet(hostSize.w, (hi?.size.w ?? 0) * theme.cell, Boolean(hi?.collapsed), camera.homeMost.current);
  const placeRef = useRef(place);
  placeRef.current = place;
  // the fit reads where the crew stand, which a patch can change without touching an island
  const crewCells = useMemo(() => JSON.stringify(crewOf(fleet)), [fleet]);
  const { drag, pendingIsland, panning, inDrag, domPointer, hostPointer, onSeaDoubleClick } =
    useMapPointer({ host, camera, hover: hov, place: placeRef, lastPressAt, islands: fleet.islands, crewCells });
  const { arrange, covered } = useAutoArrange({ host, islands: fleet.islands, card, cardSize, lastPressAt, reserveAt: camera.reserveAt });
  useDevHook(camera.layoutRef, camera.refits);
  useRobotMotion();

  const cs = cellSize(layout);
  const hovered = hov.hover && !drag && !card ? fleet.characters[hov.hover] : undefined;
  const cardBox = card ? cardRect({ size: cardSize, win: hostSize, half: halfCard }) : undefined;
  const sea = domPointer({ kind: 'water' });
  const startHover = (id: string) => { if (!card && !inDrag()) hov.start(id); };
  const endHover = hov.end;
  const overHome = drag?.kind === 'figure' && drag.over?.islandId === HOME_ISLAND ? drag : undefined;
  const crew = homeCrew(fleet, drag);
  const previewFor = (id: string): IslandDrag | PendingIsland | undefined =>
    drag && drag.kind !== 'figure' && drag.id === id ? drag : pendingIsland?.id === id ? pendingIsland : undefined;
  const islandOffset = (i: typeof fleet.islands[string], p: IslandDrag | PendingIsland | undefined) => {
    if (!p || p.kind !== 'island') return undefined;
    if (p === pendingIsland) return { x: (p.position.x - pendingIsland.from.x) * theme.cell,
      y: (p.position.y - pendingIsland.from.y) * theme.cell };
    return p.offset ?? { x: (p.position.x - i.position.x) * theme.cell, y: (p.position.y - i.position.y) * theme.cell };
  };
  return (
    <div ref={host} className="map" data-testid="map" data-dragging={Boolean(drag) || panning} data-paused={!active || covered} onWheel={camera.onWheel} onDoubleClick={onSeaDoubleClick} {...hostPointer}
      style={{ '--map-w': `${hostSize.w}px`, '--home-row-top': `${(hi?.collapsed ? theme.home.bar : theme.home.visible * place.homeScale + theme.home.rowGap) + rowH + 24}px` } as React.CSSProperties}>
      <div className="map-grain" />
      {/* the camera's values sit on the one element that reads them: set on the map, every frame of a zoom would restyle all of it */}
      <div className="map-grid" style={{ '--cell': `${cs}px`, '--gx': `${layout.ox % cs}px`, '--gy': `${layout.oy % cs}px` } as React.CSSProperties} />
      <div className="map-sea" {...sea} />
      {/* the world is only placed; each island and card scales itself, as mission control's island does. WebKit draws a scaled
          world as one layer at 1:1 and stretches the bitmap, which blurs every island */}
      <div className="map-world" style={{ left: Math.round(layout.ox), top: Math.round(layout.oy), '--cell': `${theme.cell}px`, '--ms': layout.scale, '--k': cardScale(layout.scale), '--lk': labelScale(layout.scale) / layout.scale } as React.CSSProperties}>
        {mapIslandsSorted(fleet).map((i) => {
          const preview = previewFor(i.id);
          const shown = preview?.kind === 'island' && preview === pendingIsland ? { ...i, position: pendingIsland.from }
            : preview?.kind === 'resize' ? { ...i, size: preview.size } : i;
          const gripOffset = preview?.kind === 'resize' && preview.offset && preview !== pendingIsland
            ? { x: Math.max((MIN_SIZE.w - i.size.w) * theme.cell, preview.offset.x) - (preview.size.w - i.size.w) * theme.cell,
              y: Math.max((MIN_SIZE.h - i.size.h) * theme.cell, preview.offset.y) - (preview.size.h - i.size.h) * theme.cell }
            : undefined;
          const hold = { onPointerEnter: () => hov.holdIsland(i.id), onPointerLeave: () => hov.releaseIsland(i.id) };
          const count = charactersOf(fleet, i.id).length;
          return (
            <Island key={i.id} island={shown} count={count} offset={islandOffset(i, preview)} gripOffset={gripOffset}
              hot={hov.hotIsland === i.id || selectedIslandId === i.id} selected={selectedIslandId === i.id}
              dragging={Boolean(preview)} settling={Boolean(pendingIsland) && preview === pendingIsland}
              hover={dropHover?.kind === 'island' && dropHover.id === i.id}
              onNew={() => newCharacterOn(deps(), i.id)}
              onToggle={() => toggleIsland(deps(), i.id)}
              onMenu={(e) => islandMenu(e, i.id, count === 0)}
              land={domPointer({ kind: 'label', islandId: i.id })}
              label={domPointer({ kind: 'label', islandId: i.id })}
              handle={domPointer({ kind: 'handle', islandId: i.id })}
              hold={hold} />
          );
        })}
        {drag?.kind === 'island' && fleet.islands[drag.id] && (() => {
          const { size } = fleet.islands[drag.id];
          return <div className="island-landing" aria-hidden="true"
            style={{ left: drag.position.x * cs, top: drag.position.y * cs, width: size.w * cs, height: size.h * cs }} />;
        })()}
        {drag?.kind === 'figure' && drag.over && (() => {
          const i = fleet.islands[drag.over.islandId];
          if (!i || i.kind === 'home') return null;
          return <div className="drop-cell" data-testid="drop-cell" data-free={drag.over.free}
            style={{ left: (i.position.x + drag.over.local.x) * cs, top: (i.position.y + drag.over.local.y) * cs, width: cs, height: cs }} />;
        })()}
        {mapIslandsSorted(fleet).flatMap((i) => charactersOf(fleet, i.id).map((c) => {
          const dragging = drag?.kind === 'figure' && drag.id === c.id;
          if (dragging && overHome) return null;
          const preview = previewFor(i.id);
          const base = preview?.kind === 'island' && preview === pendingIsland ? pendingIsland.from : i.position;
          const world = dragging ? drag.cell : worldCell(base, c.cell);
          return (
            <Token key={c.id} c={c} status={statusOf(c)} world={world} robots={!fleet.animals} links={links} selected={c.id === selectedId} dragging={dragging}
              offset={islandOffset(i, preview)} settling={Boolean(pendingIsland) && preview === pendingIsland}
              hover={dropHover?.kind === 'char' && dropHover.id === c.id}
              pointer={domPointer({ kind: 'figure', id: c.id })}
              onHoverStart={() => startHover(c.id)} onHoverEnd={endHover}
              onOpen={() => app.store.getState().focus(c.id)}
              onLink={followLink} onMenu={(e) => characterMenu(e, c.id)} />
          );
        }))}
        {drag?.kind === 'figure' && !overHome && fleet.characters[drag.id]?.islandId === HOME_ISLAND && (
          <Token key={drag.id} c={fleet.characters[drag.id]} status={statusOf(fleet.characters[drag.id])} world={drag.cell} robots={!fleet.animals} links={links} selected={drag.id === selectedId} dragging
            pointer={domPointer({ kind: 'figure', id: drag.id })} hover={false} onHoverStart={() => {}} onHoverEnd={endHover}
            onOpen={() => app.store.getState().focus(drag.id)} onLink={followLink} onMenu={(e) => characterMenu(e, drag.id)} />
        )}
      </div>
      <div className="map-overlay">
        {hi && (
          <Home island={hi} crew={crew} config={fleet.home} collapsed={Boolean(hi.collapsed)}
            selected={selectedIslandId === HOME_ISLAND} selectedId={selectedId} drag={drag} status={statusOf} robots={!fleet.animals} links={links}
            shift={place.homeShift} rowShift={placeIslet(hostSize.w, hi.size.w * theme.cell, Boolean(hi.collapsed)).homeShift}
            scale={place.homeScale} extra={place.mode === 'pill' ? <ResourcesPill /> : undefined}
            onToggle={() => toggleIsland(deps(), HOME_ISLAND)}
            onArrange={() => arrange()}
            onNewIsland={() => newIsland(deps())}
            onAction={(a) => startHomeAction(deps(), a)}
            onNew={() => newCharacterOn(deps(), HOME_ISLAND)}
            label={domPointer({ kind: 'label', islandId: HOME_ISLAND })}
            tokenPointer={(id) => domPointer({ kind: 'figure', id })}
            onHoverStart={startHover} onHoverEnd={endHover}
            onOpen={(id) => app.store.getState().focus(id)}
            onLink={followLink}
            onMenu={(id, e) => characterMenu(e, id)}
            dropHover={dropHover} />
        )}
        {hi && place.mode !== 'pill' && <ResourcesIsland place={place} />}
        {hovered && fleet.islands[hovered.islandId] && <HoverLayer c={hovered} island={fleet.islands[hovered.islandId]} layout={layout} place={place} host={hostSize} />}
        {card && fleet.characters[card] && <TerminalCard key={card} id={card} host={hostSize} />}
        <Toast corner={toastCorner(cardBox, hostSize)} />
        <ResourcesLayer tip={place.cx - ISLET.margin} />
      </div>
    </div>
  );
}
