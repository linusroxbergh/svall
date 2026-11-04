import fs from 'node:fs';
import { ApiError, migrateState, WorkerFile, type FleetState } from '@svall/protocol';
import { InvalidConfig, parseConfig } from '../config.js';
import { docsDir, listDocs } from '../docs.js';
import { readRegistry } from '../machine.js';
import type { Fleets } from '../fleets.js';
import type { mobileControl } from '../mobile.js';
import type { Paths } from '../paths.js';
import { workerIds } from '../placement/workers.js';

/** What `svalld --worker` leaves to the home; a Mac keeps listing the fleets beside this one, which its File menu opens. */
const OFF = ['mobile', 'push', 'scribe', 'fleets'] as const;
export type Off = (typeof OFF)[number];
const offOn = (platform: NodeJS.Platform): readonly Off[] => (platform === 'darwin' ? OFF.filter((o) => o !== 'fleets') : OFF);

export const isWorker = (paths: Paths): boolean => fs.existsSync(paths.workerFile);

export function readWorkerFile(paths: Paths): WorkerFile {
  let text: string;
  try {
    text = fs.readFileSync(paths.workerFile, 'utf8');
  } catch (e) {
    throw new InvalidConfig(`invalid config ${paths.workerFile}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return parseConfig(text, paths.workerFile, WorkerFile);
}

export const workerOptions = (paths: Paths, platform: NodeJS.Platform = process.platform): { worker: WorkerFile; off: readonly Off[] } =>
  ({ worker: readWorkerFile(paths), off: offOn(platform) });

/** What a fleet's home would lose to a worker's first snapshot, by name; nothing once it has taken one, as it then holds a
 *  worker's copy. An island counts for what is on it, as a new fleet opens on an empty one. */
export function heldAsHome(paths: Paths, me: string): string | undefined {
  let state: FleetState | undefined;
  // one that cannot be read is set aside whatever happens to it, so nothing is erased
  try { state = migrateState(JSON.parse(fs.readFileSync(paths.state, 'utf8'))).state; } catch { /* none to lose */ }
  if (Object.values(state?.machines ?? {}).some((m) => m.snapshot)) return undefined;
  const islands = Object.values(state?.islands ?? {}).filter((i) => i.description || i.instructions || i.context.length || listDocs(docsDir(paths.docs, 'island', i.id)).length);
  let listed: Set<string> | undefined;
  // a registry that cannot be read may list them all
  try { listed = new Set(readRegistry().map((m) => m.id)); } catch { /* every token counts */ }
  const count = (n: number, what: string): string[] => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);
  const held = [
    ...count(Object.values(state?.robots ?? {}).filter((r) => r.machine !== me).length, 'robot'),
    ...count(islands.length, 'island'),
    ...count(workerIds(paths).filter((id) => !listed || listed.has(id)).length, 'worker'),
  ];
  return held.length ? new Intl.ListFormat('en').format(held) : undefined;
}

const refuse = (): Promise<never> => Promise.reject(new ApiError('not_on_worker', 'not on a worker'));

/** What answers on a worker in place of the phone link and the fleets beside this one. */
export const workerStubs = {
  mobile: { get: refuse, set: refuse, logins: (): string[] => [], served: (): string | undefined => undefined } satisfies ReturnType<typeof mobileControl>,
  fleets: { list: refuse, create: refuse, start: refuse } satisfies Fleets,
};
