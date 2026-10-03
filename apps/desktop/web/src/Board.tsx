import { newCharacterOn } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { CharPanes } from './CharPanes.js';
import { keyLabel, keyTip } from './keys.js';
import { boardIsland, boardViewed, charactersOf, statusOf } from './selectors.js';
import { DeleteIsland } from './IslandCard.js';
import { Toast } from './Toast.js';

const view = (id: string) => app.store.getState().focus(id);

export function Board() {
  const fleet = useApp((s) => s.fleet);
  const viewed = useApp(boardViewed);
  const island = useApp(boardIsland);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const opacity = useApp((s) => s.settings.fullOpacity);
  const bindings = useApp((s) => s.settings.bindings);
  const mapKey = keyLabel('toggleView', bindings);
  const newKey = keyLabel('newCharacter', bindings);
  const c = viewed ? fleet.characters[viewed] : undefined;
  const tabs = island ? charactersOf(fleet, island.id) : [];

  return (
    <div className="board" data-testid="board">
      <div className="tabs" data-testid="tabs">
        {!sidebarOpen && (
          <button className="tab tab-sb" data-testid="sidebar-show" title="Show the islands" aria-label="Show the islands"
            onClick={() => app.store.getState().toggleSidebar(true)}>›</button>
        )}
        {island && <span className="tabs-isl">{island.name}</span>}
        {tabs.map((t) => (
          <button key={t.id} className="tab" data-testid={`tab-${t.id}`} data-status={statusOf(t)} data-active={t.id === viewed} onClick={() => view(t.id)}>
            <i className="sdot" data-status={statusOf(t)} />{t.name}
          </button>
        ))}
        {island && <button className="tab tab-new" data-testid="island-new" title="New character here" onClick={() => newCharacterOn(deps(), island.id)}>+</button>}
        <span className="spacer" />
        <button className="tab tab-map" data-testid="board-map" onClick={() => app.store.getState().setView('map')}>Map {mapKey && <span className="meta">{mapKey}</span>}</button>
        {/* the board draws a native terminal over the card's edge, so its control lives here */}
        <button className="tab tab-info" data-testid="board-side" title={keyTip('Side card', 'toggleSideCard', bindings)} aria-label="Toggle the side card"
          onClick={() => app.store.getState().toggleSideCard()}>ⓘ</button>
      </div>
      <div className="term-host">
        {c ? (
          <CharPanes key={c.id} id={c.id} opacity={opacity} />
        ) : (
          <div className="board-empty" data-testid="board-empty">
            <div className="kicker">{island ? island.name : 'The fleet'}</div>
            <div className="desc">{island ? 'No characters on this island yet.' : `No islands yet.${newKey ? ` Press ${newKey} to start.` : ''}`}</div>
            <div className="acts">
              {island && <button className="btn pri" data-testid="empty-new" onClick={() => newCharacterOn(deps(), island.id)}>New character</button>}
              {island && island.kind !== 'home' && tabs.length === 0 && <DeleteIsland id={island.id} testid="island-delete" label="Delete island" />}
            </div>
          </div>
        )}
        <Toast />
      </div>
    </div>
  );
}
