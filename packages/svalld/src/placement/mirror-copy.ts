import fs from 'node:fs';
import { ApiError, serverWait, type MachineId, type SetupRow } from '@svall/protocol';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { Mirror, mirrorCalls, type MirrorLink, type Pushed } from './mirror.js';
import { readState, type MirrorHomes } from './mirror-state.js';

const TAKEN = new Set(['config.state', 'config.blob', 'config.apply']);
// as long as the home waits for the copy it asked for
const GRANT_MS = serverWait('machines.copySetupFrom', {});

const refused = (method: string): ApiError => new ApiError('unauthorized', `${method} is not taken from a worker`);

/**
 * The home's side of a copy of a worker's agent setup: it takes one push from the worker `machines.copySetupFrom` named, and
 * nothing of the kind from any other, past `GRANT_MS` or once that push has reached its apply. The first copy keeps what it replaces.
 */
export class SetupCopy {
  private grant?: { machine: MachineId; until: number; offered?: true; used?: true };
  private calls: ReturnType<typeof mirrorCalls>;

  constructor(private o: MirrorHomes & {
    overrides: string; stage: string; stateFile: string; varsFile: string; envFile: string; backups: string; log: Logger;
    links: { for(machine: MachineId): Pick<WorkerLink, 'receiveBlob'> | undefined };
  }) {
    const receiveBlob = (id: string, into: string): Promise<{ sha256: string }> => {
      const link = this.grant && this.o.links.for(this.grant.machine);
      return link ? link.receiveBlob(id, into) : Promise.reject(new ApiError('not_reachable', 'no worker is copying its agent setup here'));
    };
    this.calls = mirrorCalls({ ...o, connection: { receiveBlob } });
  }

  takes(method: string): boolean {
    return TAKEN.has(method);
  }

  /** Lets `machine` make one push for `ms`; one copy at a time. */
  arm(machine: MachineId, ms = GRANT_MS): object {
    if (this.grant && Date.now() <= this.grant.until) throw new ApiError('busy', 'another copy of an agent setup is landing here');
    this.grant = { machine, until: Date.now() + ms };
    return this.grant;
  }

  /** Arms `machine` for what `run` asks of it; the grant ends with `run`, and whatever it left unapplied goes. */
  async from<T>(machine: MachineId, run: () => Promise<T>): Promise<T> {
    const mine = this.arm(machine);
    try {
      return await run();
    } finally {
      if (this.grant === mine) this.end();
    }
  }

  take(caller: MachineId, method: string, params: unknown): Promise<unknown> {
    const g = this.grant;
    if (!g || g.machine !== caller || Date.now() > g.until || g.used) throw refused(method);
    if (method === 'config.blob') {
      if (g.offered) throw refused(method);
      g.offered = true;
    }
    if (method === 'config.apply') g.used = true;
    return this.calls.calls[method](params);
  }

  /** The named worker's link closed: its push can come to nothing more. */
  lost(machine: MachineId): void {
    if (this.grant?.machine === machine) this.end();
  }

  private end(): void {
    this.grant = undefined;
    this.calls.linkLost();
  }
}

export type WorkerSetup = {
  get(): Promise<{ rows: SetupRow[]; backup?: string }>;
  consent(item: string, fields: string[], on: boolean): void;
  push(): Promise<Pushed>;
};

/** A worker's own agent setup, as its window sees it: the ticks it holds for its home, and the push of it the home asks for. */
export function workerSetup(o: { mirror: Mirror; connection: Pick<HomeConnection, 'call' | 'sendBlob'>; home: MachineId; homeName: () => string; stateFile: string }): WorkerSetup {
  const link: MirrorLink = { machine: o.home, call: (method, params, c) => o.connection.call(method, params, c), sendBlob: (id, file) => o.connection.sendBlob(id, file) };
  return {
    // what the rows ask is what leaves this machine, which the home has no say in
    get: async () => {
      const rows = await o.mirror.report(undefined, o.home, { name: o.homeName(), fleetFlag: '' });
      const dir = readState(o.stateFile).backup?.dir;
      return { rows: rows.filter((r) => r.tick), ...(dir !== undefined && fs.existsSync(dir) && { backup: dir }) };
    },
    consent: (item, fields, on) => o.mirror.consent(o.home, item, fields, on),
    push: () => o.mirror.push(link),
  };
}
