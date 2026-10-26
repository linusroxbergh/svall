import fs from 'node:fs';
import { ApiError, WorkerFile } from '@svall/protocol';
import { InvalidConfig, parseConfig } from '../config.js';
import type { Fleets } from '../fleets.js';
import type { mobileControl } from '../mobile.js';
import type { Paths } from '../paths.js';

/** What `svalld --worker` leaves to the home. */
const OFF = ['mobile', 'push', 'scribe', 'gateway', 'fleets'] as const;
export type Off = (typeof OFF)[number];

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

export const workerOptions = (paths: Paths): { worker: WorkerFile; off: typeof OFF } => ({ worker: readWorkerFile(paths), off: OFF });

const refuse = (): Promise<never> => Promise.reject(new ApiError('not_on_worker', 'not on a worker'));

/** What answers on a worker in place of the phone link and the fleets beside this one. */
export const workerStubs = {
  mobile: { get: refuse, set: refuse, logins: (): string[] => [], served: (): string | undefined => undefined } satisfies ReturnType<typeof mobileControl>,
  fleets: { list: refuse, create: refuse, start: refuse } satisfies Fleets,
};
