import { DROP_MAX, DROP_PART, robotOfKey, type ContextItem, type FleetState } from '@svall/protocol';
import type { Api } from './api.js';
import { DROP_URL, type Bridge, type DropFile } from './bridge.js';
import { awayLine } from './placement.js';
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
export function dropRefusal(fleet: FleetState, id: string, files: DropFile[]): string | undefined {
  const c = fleet.robots[id];
  const away = c && awayLine(fleet, c);
  if (away) return away;
  const folder = files.find((f) => f.folder);
  if (folder) return `${folder.name} is a folder; drop the files in it`;
  const big = files.find((f) => f.bytes > DROP_MAX);
  if (big) return `${big.name} is ${Math.round(big.bytes / MB)} MB, over the ${DROP_MAX / MB} MB a drop carries`;
}

const base64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let at = 0; at < bytes.length; at += 0x8000) s += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(s);
};

const uploadId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Sends files dropped or pasted into terminal `key` to the machine its robot runs on, then types where each landed. A
 * refusal says why and types nothing.
 */
export async function dropOnTerminal(o: {
  api: Pick<Api, 'call'>; fleet: FleetState; key: string; files: DropFile[]; read(f: DropFile): Promise<ArrayBuffer>; type(paths: string[]): void; onError(message: string): void;
}): Promise<void> {
  const id = robotOfKey(o.key);
  const refused = dropRefusal(o.fleet, id, o.files);
  if (refused) return o.onError(refused);
  const paths: string[] = [];
  try {
    for (const f of o.files) {
      const bytes = new Uint8Array(await o.read(f));
      const upload = uploadId();
      for (let index = 0; index === 0 || index * DROP_PART < bytes.length; index++) {
        await o.api.call('drop.part', { upload, index, data: base64(bytes.subarray(index * DROP_PART, (index + 1) * DROP_PART)) });
      }
      paths.push((await o.api.call('robot.drop', { id, upload, name: f.name })).path);
    }
  } catch (e) {
    return o.onError((e as Error).message);
  }
  o.type(paths);
}

const readDrop = async (f: DropFile): Promise<ArrayBuffer> => {
  const res = await fetch(DROP_URL + f.token).catch(() => undefined);
  if (!res?.ok) throw new Error(`${f.name} could not be read`);
  return res.arrayBuffer();
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
        api, fleet: o.store.getState().fleet, key: m.id, files: m.files, read: readDrop,
        type: (paths) => o.bridge.send({ type: 'term.type', id: m.id, paths }), onError: (msg) => o.store.getState().showToast(msg),
      });
    }
  });
}
