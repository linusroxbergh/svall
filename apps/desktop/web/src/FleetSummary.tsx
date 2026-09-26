import { useApp } from './hooks.js';
import { charactersOf, countsByStatus, DISPLAY_STATUSES, islandsSorted, isUnread, statusOf } from './selectors.js';

export function FleetSummary() {
  const fleet = useApp((s) => s.fleet);
  const chars = Object.values(fleet.characters);
  const islands = islandsSorted(fleet);
  const counts = countsByStatus(fleet);
  const blocked = chars.filter((c) => statusOf(c) === 'blocked').length;
  const unread = chars.filter(isUnread).length;
  return (
    <aside className="side" data-testid="fleet-summary">
      <div className="kicker">The fleet</div>
      <h2 className="h2">{chars.length} {chars.length === 1 ? 'character' : 'characters'}<br />on {islands.length} {islands.length === 1 ? 'island' : 'islands'}</h2>
      <div className="desc">{blocked} blocked, {unread} unread.</div>
      <div className="rows">
        {DISPLAY_STATUSES.map((s) => (
          <div key={s} className="row">
            <span className="sname"><i className="sdot" data-status={s} />{s}</span>
            <b className="tnum">{counts[s]}</b>
          </div>
        ))}
      </div>
      <div className="rows">
        {islands.map((i) => <div key={i.id} className="row">{i.name}<b className="tnum">{charactersOf(fleet, i.id).length}</b></div>)}
      </div>
    </aside>
  );
}
