import { useApp, usePanelWidth } from './hooks.js';
import { robotsOf, countsByStatus, DISPLAY_STATUSES, islandsSorted, isUnread, statusOf } from './selectors.js';

export function FleetSummary() {
  const fleet = useApp((s) => s.fleet);
  const width = usePanelWidth('card');
  const robots = Object.values(fleet.robots);
  const islands = islandsSorted(fleet);
  const counts = countsByStatus(fleet);
  const blocked = robots.filter((c) => statusOf(c, fleet) === 'blocked').length;
  const unread = robots.filter(isUnread).length;
  return (
    <aside className="side" style={width} data-testid="fleet-summary">
      <div className="kicker">The fleet</div>
      <h2 className="h2">{robots.length} {robots.length === 1 ? 'robot' : 'robots'}<br />on {islands.length} {islands.length === 1 ? 'island' : 'islands'}</h2>
      <div className="desc">{blocked} blocked, {unread} unread.</div>
      <div className="rows">
        {[...DISPLAY_STATUSES, ...(['moving', 'unknown'] as const).filter((s) => counts[s] > 0)].map((s) => (
          <div key={s} className="row">
            <span className="sname"><i className="sdot" data-status={s} />{s}</span>
            <b className="tnum">{counts[s]}</b>
          </div>
        ))}
      </div>
      <div className="rows">
        {islands.map((i) => <div key={i.id} className="row">{i.name}<b className="tnum">{robotsOf(fleet, i.id).length}</b></div>)}
      </div>
    </aside>
  );
}
