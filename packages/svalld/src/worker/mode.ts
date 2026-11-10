import fs from 'node:fs';
import path from 'node:path';
import { ApiError, migrateState, WorkerFile, type FleetState } from '@svall/protocol';
import { InvalidConfig, parseConfig } from '../config.js';
import { docsDir, fleetDir, listDocs } from '../docs.js';
import type { Fleets } from '../fleets.js';
import type { mobileControl } from '../mobile.js';
import type { Paths } from '../paths.js';
import { listedWorkerIds } from '../placement/workers.js';

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

// a repo's notes, each folder named for its repo, none of which a worker's fleet reads again
const repoNotes = (paths: Paths): number => {
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(path.join(paths.docs, 'repos')); } catch { /* none */ }
  return slugs.flatMap((slug) => listDocs(docsDir(paths.docs, 'repo', slug))).length;
};

/** What a fleet's home would lose to a worker's first snapshot, by name; nothing once it has taken one, as it then holds a
 *  worker's copy. An island counts for what is on it, as a new fleet opens on an empty one. */
export function heldAsHome(paths: Paths, me: string): string | undefined {
  let state: FleetState | undefined;
  // one that cannot be read is set aside whatever happens to it, so nothing is erased
  try { state = migrateState(JSON.parse(fs.readFileSync(paths.state, 'utf8'))).state; } catch { /* none to lose */ }
  if (Object.values(state?.machines ?? {}).some((m) => m.snapshot)) return undefined;
  const islands = Object.values(state?.islands ?? {}).filter((i) => i.description || i.instructions || i.context.length || listDocs(docsDir(paths.docs, 'island', i.id)).length);
  const count = (n: number, what: string): string[] => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);
  const held = [
    ...count(Object.values(state?.robots ?? {}).filter((r) => r.machine !== me).length, 'robot'),
    ...count(islands.length, 'island'),
    ...count(listDocs(fleetDir(paths.docs)).length, 'fleet note'),
    ...count(repoNotes(paths), 'repo note'),
    ...count(listedWorkerIds(paths).length, 'worker'),
  ];
  return held.length ? new Intl.ListFormat('en').format(held) : undefined;
}

/** A Mac's launchd agent runs every fleet the same way, so worker.json alone makes it a worker, but for a fleet's home. */
export function startsAsWorker(paths: Paths, me: () => string): true | undefined {
  if (!isWorker(paths)) return undefined;
  // only a worker's outbox writes it, so what this holds is a worker's, even with no link yet
  if (fs.existsSync(paths.epoch)) return true;
  let held: string | undefined;
  const id = me();
  try { held = heldAsHome(paths, id); } catch (e) { throw new InvalidConfig((e as Error).message, { cause: e }); }
  if (held) throw new InvalidConfig(`${paths.workerFile} makes this fleet home a worker, but it holds ${held} as a fleet's home, which the first snapshot would erase; remove the file, or enrol an empty fleet`);
  return true;
}

const refuse = (): Promise<never> => Promise.reject(new ApiError('not_on_worker', 'not on a worker'));

/** What answers on a worker in place of the phone link and the fleets beside this one. */
export const workerStubs = {
  mobile: { get: refuse, set: refuse, logins: (): string[] => [], served: (): string | undefined => undefined } satisfies ReturnType<typeof mobileControl>,
  fleets: { list: refuse, create: refuse, start: refuse } satisfies Fleets,
};
