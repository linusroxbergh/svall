import fs from 'node:fs';
import { ApiError, HOME_ISLAND, WorkerFile } from '@svall/protocol';
import { InvalidConfig, parseConfig } from '../config.js';
import { docsDir, listDocs } from '../docs.js';
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

/**
 * What a fleet's home holds of its own here, by name, which a worker's first snapshot would erase: the robots not running
 * on `me`, the islands beyond mission control with anything on them, as a new fleet opens with an empty one, and its
 * workers. Nothing once it has taken a snapshot, as what it holds is then a worker's copy.
 */
export function heldAsHome(paths: Paths, me: string): string | undefined {
  let state: {
    robots?: Record<string, { machine?: string }>; machines?: Record<string, { snapshot?: unknown }>;
    islands?: Record<string, { description?: string; instructions?: string; context?: unknown[] }>;
  } = {};
  // one that cannot be read is set aside whatever happens to it, so nothing is erased
  try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch { /* none to lose */ }
  if (Object.values(state.machines ?? {}).some((m) => m.snapshot)) return undefined;
  const islands = Object.entries(state.islands ?? {}).filter(([id, i]) =>
    id !== HOME_ISLAND && (i.description || i.instructions || i.context?.length || listDocs(docsDir(paths.docs, 'island', id)).length));
  const count = (n: number, what: string): string[] => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);
  const held = [
    ...count(Object.values(state.robots ?? {}).filter((r) => r.machine !== me).length, 'robot'),
    ...count(islands.length, 'island'),
    ...count(workerIds(paths).length, 'worker'),
  ];
  return held.length ? new Intl.ListFormat('en').format(held) : undefined;
}

const refuse = (): Promise<never> => Promise.reject(new ApiError('not_on_worker', 'not on a worker'));

/** What answers on a worker in place of the phone link and the fleets beside this one. */
export const workerStubs = {
  mobile: { get: refuse, set: refuse, logins: (): string[] => [], served: (): string | undefined => undefined } satisfies ReturnType<typeof mobileControl>,
  fleets: { list: refuse, create: refuse, start: refuse } satisfies Fleets,
};
