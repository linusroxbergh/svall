import { DROP_MAX, DROP_PART, robotOfKey, type ContextItem, type FleetState } from '@svall/protocol';
import type { Api } from './api.js';
import { DROP_URL, type Bridge, type DropFile } from './bridge.js';
import { encode } from './mobile/term.js';
import { awayLine, destinationName, type Via } from './placement.js';
import type { AppStore } from './store/index.js';

export type DropTarget = { kind: 'island' | 'robot'; id: string; after?: boolean };

export function parseDropTarget(attr: string | null | undefined): DropTarget | undefined {
  const m = attr?.match(/^(island|robot):(.+)$/);
  return m ? { kind: m[1] as DropTarget['kind'], id: m[2] } : undefined;
}

function dropTargetAt(doc: Document, x: number, y: number): DropTarget | undefined {
  return parseDropTarget(doc.elementFromPoint(x, y)?.closest('[data-drop]')?.getAttribute('data-drop'));
}

// every path arrives as a file; the daemon stats it and keeps folders as folders.
export function appendItems(api: Api, fleet: FleetState, target: DropTarget, paths: string[], onError: (message: string) => void): void {
  const items: ContextItem[] = paths.map((ref) => ({ kind: 'file', ref, label: '', source: 'manual' }));
  const call = target.kind === 'island'
    ? fleet.islands[target.id] && (() => api.call('island.update', { id: target.id, context: [...fleet.islands[target.id].context, ...items] }))
    : fleet.robots[target.id] && (() => api.call('robot.update', { id: target.id, context: [...fleet.robots[target.id].context, ...items] }));
  call?.()?.catch((e: Error) => onError(e.message));
}

const MB = 2 ** 20;

/** Why files dropped or pasted into robot `id`'s terminal do not go, in the words the app uses; undefined when they all may. */
export function dropRefusal(fleet: FleetState, id: string, files: DropFile[], via?: Via): string | undefined {
  const c = fleet.robots[id];
  if (c?.moving) return `moving to ${destinationName(fleet, c.moving.to, via)}`;
  const away = c && awayLine(fleet, c, via);
  if (away) return away;
  const folder = files.find((f) => f.folder);
  if (folder) return `${folder.name} is a folder; drop the files in it`;
  const big = files.find((f) => f.bytes > DROP_MAX);
  if (big) return `${big.name} is ${Math.ceil(big.bytes / MB)} MB, over the ${DROP_MAX / MB} MB a drop carries`;
}

const uploadId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Sends files dropped or pasted into terminal `key` to the machine its robot runs on, then types where each landed. A
 * refusal says why and types nothing.
 */
export async function dropOnTerminal(o: {
  api: Pick<Api, 'call'>; fleet: FleetState; via?: Via; key: string; files: DropFile[]; read(f: DropFile, at: number): Promise<Uint8Array>; type(paths: string[]): void; onError(message: string): void;
}): Promise<void> {
  const id = robotOfKey(o.key);
  const refused = dropRefusal(o.fleet, id, o.files, o.via);
  if (refused) return o.onError(refused);
  const paths: string[] = [];
  try {
    for (const f of o.files) {
      const upload = uploadId();
      // a part held at a time, the next asked of the shell once the daemon has this one; a short one is the last
      for (let index = 0; ; index++) {
        const part = await o.read(f, index * DROP_PART);
        if (part.length > 0 || index === 0) await o.api.call('drop.part', { upload, index, data: encode(part) });
        if (part.length < DROP_PART) break;
      }
      paths.push((await o.api.call('robot.drop', { id, upload, name: f.name })).path);
    }
  } catch (e) {
    return o.onError((e as Error).message);
  }
  o.type(paths);
}

const readPart = async (f: DropFile, at: number): Promise<Uint8Array> => {
  const res = await fetch(`${DROP_URL}${f.token}?at=${at}&size=${DROP_PART}`).catch(() => undefined);
  if (!res?.ok) throw new Error(`${f.name} could not be read`);
  return new Uint8Array(await res.arrayBuffer());
};

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
    } else if (m.type === 'term.drop') {
      const api = o.api();
      if (!api) return;
      void dropOnTerminal({
        api, fleet: o.store.getState().fleet, via: o.store.getState().via, key: m.id, files: m.files, read: readPart,
        type: (paths) => o.bridge.send({ type: 'term.type', id: m.id, paths }), onError: (msg) => o.store.getState().showToast(msg),
      });
    }
  });
}
