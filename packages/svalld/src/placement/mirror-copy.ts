import fs from 'node:fs';
import { ApiError, serverWait, type AgentKind, type MachineId, type SetupRow } from '@svall/protocol';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { Mirror, mirrorCalls, type MirrorLink, type Pushed } from './mirror.js';
import { entryName, type Manifest } from './mirror-apply.js';
import { CONFIG_ITEMS } from './mirror-consent.js';
import { carriable } from './mirror-plan.js';
import { CODEX_MAC_ONLY, CODEX_WORKER_OWNED, OPENCODE_FILES, OPENCODE_WORKER_OWNED, readState, WORKER_OWNED, type DocName, type MirrorHomes } from './mirror-state.js';

const TAKEN = new Set(['config.state', 'config.blob', 'config.apply']);
// as long as the home waits for the copy it asked for
const GRANT_MS = serverWait('machines.copySetupFrom', {});

const refused = (method: string): ApiError => new ApiError('unauthorized', `${method} is not taken from a worker`);

const SERVER_PLACE: Record<AgentKind, (p: string[], doc: DocName) => boolean> = {
  claude: (p, doc) => doc === '.claude.json' && ((p.length === 2 && p[0] === 'mcpServers') || (p.length === 4 && p[0] === 'projects' && p[2] === 'mcpServers')),
  codex: (p, doc) => doc === 'config.toml' && p.length === 2 && p[0] === 'mcp_servers',
  opencode: (p, doc) => (OPENCODE_FILES as readonly string[]).includes(doc) && p[0] === 'mcp' && (p.length === 2 || (p.length === 3 && p[1] === 'servers')),
};
const OWNED: Record<string, readonly string[]> = {
  [CONFIG_ITEMS.settings]: WORKER_OWNED, [CONFIG_ITEMS.codex]: [...CODEX_WORKER_OWNED, ...CODEX_MAC_ONLY], [CONFIG_ITEMS.opencode]: OPENCODE_WORKER_OWNED,
};

/** Stops a Copy's blob that is not what mirrorPlan makes: a worker's account is not the only thing that could have written it. */
export function refuseForeign(m: Manifest, files: string[]): void {
  for (const to of [...files, ...m.keep, ...m.keyed, ...m.unticked, ...m.inPlace.map((f) => f.to)]) if (!carriable(to)) throw new Error(`the agent configuration names ${to}, which the mirror does not carry`);
  for (const s of m.servers) if (s.doc && (s.place.includes('__proto__') || !SERVER_PLACE[s.agent](s.place, s.doc))) throw new Error(`the agent configuration places a ${s.agent} server at ${s.place.join('.')}`);
  const fields = [...m.configs.flatMap((c) => c.fields.map((f) => [c.key, f])), ...m.opencode.flatMap((x) => x.fields.map((f) => [CONFIG_ITEMS.opencode, f]))];
  for (const [key, f] of fields) {
    if (OWNED[key]?.includes(f.split('.')[0]) && !(key === CONFIG_ITEMS.settings && f.startsWith('env.'))) throw new Error(`the agent configuration names a key at ${f}, which this machine owns`);
  }
}

/**
 * The home's side of a copy of a worker's agent setup: it takes one push from the worker `machines.copySetupFrom` named, and
 * nothing of the kind from any other, past `GRANT_MS` or once that push has reached its apply. It removes nothing here, and keeps
 * a copy of each file it replaces that no copy wrote.
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
    this.calls = mirrorCalls({ ...o, additive: true, refuse: refuseForeign, connection: { receiveBlob } });
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

  private end(): void {
    this.grant = undefined;
    this.calls.linkLost();
  }
}

export type WorkerSetup = {
  get(): Promise<{ rows: SetupRow[]; backup?: string; replaced?: string[]; pushFailed?: string }>;
  consent(item: string, fields: string[], on: boolean): void;
  push(): Promise<Pushed>;
};

/** A worker's own agent setup, as its window sees it: the ticks it holds for its home, and the push of it the home asks for. */
export function workerSetup(o: { mirror: Mirror; connection: Pick<HomeConnection, 'call' | 'sendBlob'>; home: MachineId; homeName: () => string; stateFile: string; pushFailed?: () => string | undefined }): WorkerSetup {
  const link: MirrorLink = { machine: o.home, call: (method, params, c) => o.connection.call(method, params, c), sendBlob: (id, file) => o.connection.sendBlob(id, file) };
  return {
    // what the rows ask is what leaves this machine, which the home has no say in
    get: async () => {
      const rows = await o.mirror.report(undefined, o.home, { name: o.homeName(), fleetFlag: '' });
      const { backup, replaced } = readState(o.stateFile);
      const here = backup !== undefined && fs.existsSync(backup.dir);
      const named = replaced?.map(entryName);
      const pushFailed = o.pushFailed?.();
      return { rows: rows.filter((r) => r.tick), ...(here && { backup: backup.dir, ...(named && { replaced: named }) }), ...(pushFailed && { pushFailed }) };
    },
    consent: (item, fields, on) => o.mirror.consent(o.home, item, fields, on, true),
    push: () => o.mirror.push(link),
  };
}
