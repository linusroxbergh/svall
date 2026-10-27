import type { Api } from './api.js';
import { machineName } from './placement.js';
import type { AppStore } from './store/index.js';

/** When a robot lands on a worker, a toast says how much of its agent setup will not work there, and Show opens its card. */
export function followLandings(o: { store: AppStore; api: () => Pick<Api, 'call'> | undefined }): () => void {
  return o.store.subscribe((s, prev) => {
    for (const [id, was] of Object.entries(prev.fleet.robots)) {
      const to = was.moving?.to;
      const c = s.fleet.robots[id];
      if (!to || !c || c.moving || c.machine !== to) continue;
      o.api()?.call('machines.setup', { machine: to, robot: id }).then(({ rows }) => {
        const n = rows.filter((r) => r.gap).length;
        if (!n) return;
        o.store.getState().showToast(`${c.name} is on ${machineName(s.fleet, to)}. ${n} ${n === 1 ? 'part' : 'parts'} of its agent setup will not work there.`, 'ok',
          { label: 'Show', run: () => o.store.getState().select(id, true) });
      }, () => {});
    }
  });
}
