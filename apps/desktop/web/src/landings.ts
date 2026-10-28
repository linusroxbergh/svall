import { aside, asideLine, wayOn, type SetupRow } from '@svall/protocol';
import type { Api } from './api.js';
import { machineName } from './placement.js';
import type { AppStore } from './store/index.js';

/** How much of a robot's agent setup will not work on the machine it moved to, or nothing when none of that has a way on. */
export function setupNote(rows: SetupRow[]): string | undefined {
  const gaps = rows.filter((r) => r.gap && !aside(r));
  const apart = asideLine(rows.filter(aside));
  const n = gaps.length;
  return gaps.some(wayOn) ? `${n} ${n === 1 ? 'part' : 'parts'} of its agent setup will not work there${apart ? `, and ${apart}` : ''}.` : undefined;
}

/** A robot landing on a worker toasts how much of its agent setup will not work there, with Show to open its card;
 * an open move sheet says it in its done line instead. */
export function followLandings(o: { store: AppStore; api: () => Pick<Api, 'call'> | undefined }): () => void {
  return o.store.subscribe((s, prev) => {
    for (const [id, was] of Object.entries(prev.fleet.robots)) {
      const to = was.moving?.to;
      const c = s.fleet.robots[id];
      if (!to || !c || c.moving || c.machine !== to) continue;
      o.api()?.call('machines.setup', { machine: to, robot: id }).then(({ rows }) => {
        const note = setupNote(rows);
        if (!note || o.store.getState().moveSheet?.id === id) return;
        o.store.getState().showToast(`${c.name} is on ${machineName(s.fleet, to)}. ${note}`, 'ok',
          { label: 'Show', run: () => o.store.getState().select(id, true) });
      }, () => {});
    }
  });
}
