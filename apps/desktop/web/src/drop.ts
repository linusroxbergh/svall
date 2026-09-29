import type { ContextItem, FleetState } from '@svall/protocol';
import type { Api } from './api.js';
import type { Bridge } from './bridge.js';
import type { AppStore } from './store/index.js';

export type DropTarget = { kind: 'island' | 'char'; id: string; after?: boolean };

export function parseDropTarget(attr: string | null | undefined): DropTarget | undefined {
  const m = attr?.match(/^(island|char):(.+)$/);
  return m ? { kind: m[1] as DropTarget['kind'], id: m[2] } : undefined;
}

function dropTargetAt(doc: Document, x: number, y: number): DropTarget | undefined {
  return parseDropTarget(doc.elementFromPoint(x, y)?.closest('[data-drop]')?.getAttribute('data-drop'));
}

// every path arrives as a file; the daemon stats it and keeps folders as folders.
// a rejected path (e.g. one that vanished mid-drag) reaches onError instead of vanishing silently.
export function appendItems(api: Api, fleet: FleetState, target: DropTarget, paths: string[], onError: (message: string) => void): void {
  const items: ContextItem[] = paths.map((ref) => ({ kind: 'file', ref, label: '', source: 'manual' }));
  const call = target.kind === 'island'
    ? fleet.islands[target.id] && (() => api.call('island.update', { id: target.id, context: [...fleet.islands[target.id].context, ...items] }))
    : fleet.characters[target.id] && (() => api.call('char.update', { id: target.id, context: [...fleet.characters[target.id].context, ...items] }));
  call?.()?.catch((e: Error) => onError(e.message));
}

export function installDropHandlers(o: { bridge: Bridge; store: AppStore; api(): Api | undefined; doc?: Document }): void {
  const doc = o.doc ?? document;
  o.bridge.onMessage((m) => {
    if (m.type === 'drag.over') o.store.getState().setDropHover(dropTargetAt(doc, m.x, m.y));
    else if (m.type === 'drag.exit') o.store.getState().setDropHover(undefined);
    else if (m.type === 'drag.drop') {
      o.store.getState().setDropHover(undefined);
      const target = dropTargetAt(doc, m.x, m.y);
      const api = o.api();
      if (target && m.paths.length && api) appendItems(api, o.store.getState().fleet, target, m.paths, (msg) => o.store.getState().showToast(msg));
    }
  });
}
