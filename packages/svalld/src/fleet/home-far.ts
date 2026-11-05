import fs from 'node:fs';
import { z } from 'zod';
import { AdoptAnswer, HomeFacts, type HomeMoving, type WorkerFile } from '@svall/protocol';
import { homePoint } from '../failpoints.js';
import type { Logger } from '../log.js';
import { SshMaster } from '../link/ssh.js';
import { fleetHomeOfSocket, type Paths } from '../paths.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { moveOutcome, readOwed } from './home-move.js';

const ASK_MS = 30_000;

// the fleet there by its folder, as its profile there need not be the one it has here
const farSvall = (svallBase: string, fleetHome: string, args: string[]): string[] => ['env', shq(`SVALL_HOME=${fleetHome}`), shq(svallExe(svallBase)), '--json', ...args.map(shq)];

async function farJson<T>(master: Pick<SshMaster, 'run'>, svallBase: string, fleetHome: string, args: string[], schema: z.ZodType<T>, what: string): Promise<T> {
  const r = await master.run(farSvall(svallBase, fleetHome, args), { timeoutMs: ASK_MS });
  if (r.code !== 0) throw new Error(`${what} exited ${r.code ?? r.signal}: ${r.stderr.trim().slice(0, 400)}`);
  try { return schema.parse(JSON.parse(r.stdout)); } catch { throw new Error(`${what} did not answer what it should`); }
}

/** What the machine that holds the fleet says of the move this marker names, over a connection of this call's own. */
export async function askAcross(marker: HomeMoving, op: 'status' | 'abort'): Promise<AdoptAnswer> {
  if (!marker.ask) throw new Error('this home has no route to where the fleet went');
  const master = await SshMaster.open({ destination: marker.ask.ssh });
  try {
    return await farJson(master, marker.ask.svallBase, marker.ask.fleetHome, ['fleet', op, marker.id], AdoptAnswer, `svall fleet ${op}`);
  } finally { await master.close().catch(() => undefined); }
}

/** What the home says of itself, over a worker's dial. */
export async function factsAcross(dial: { master(): SshMaster | undefined } | undefined, worker: WorkerFile): Promise<HomeFacts> {
  const master = dial?.master();
  if (!master || !worker.homeSvallBase || !worker.homeSocket) throw new Error(`no connection to ${worker.homeName}`);
  return farJson(master, worker.homeSvallBase, fleetHomeOfSocket(worker.homeSocket), ['fleet', 'facts'], HomeFacts, 'svall fleet facts');
}

const Settled = z.object({ status: z.string() });
const FIRST_MS = 5_000;
const LAST_MS = 5 * 60_000;
const SETTLE_MS = 120_000;

/** Tells the old home how its move ended, once this machine's journal says: it has no route here, so it waits frozen for this. */
export async function deliverOwed(paths: Paths, open: (destination: string) => Promise<Pick<SshMaster, 'run' | 'close'>> = (destination) => SshMaster.open({ destination })): Promise<'nothing' | 'waiting' | 'told'> {
  const owed = readOwed(paths);
  if (!owed) return 'nothing';
  const said = moveOutcome(paths, owed.id);
  if (!said) return 'waiting';
  // `done`: only a link with the token this move issued says so, and that home has heard
  if (said.status !== 'done') {
    const master = await open(owed.ssh);
    try {
      const r = await master.run(farSvall(owed.svallBase, owed.fleetHome, ['fleet', 'settle', owed.id, '--outcome', said.status]), { timeoutMs: SETTLE_MS, ...(said.status === 'adopted' && { input: JSON.stringify(said.enrol) }) });
      if (r.code !== 0) throw new Error(`svall fleet settle exited ${r.code ?? r.signal}: ${r.stderr.trim().slice(0, 400)}`);
      Settled.parse(JSON.parse(r.stdout));
    } finally { await master.close().catch(() => undefined); }
    homePoint('deliver.told');
  }
  fs.rmSync(paths.homeDeliver, { force: true });
  return 'told';
}

/** Tells the old home what this machine owes it, from the moment that is known, for as long as this daemon runs; the returned function stops it. */
export function startDeliveries(paths: Paths, log: Pick<Logger, 'error' | 'info'>, open?: Parameters<typeof deliverOwed>[1]): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let ms = FIRST_MS;
  const tick = async () => {
    try {
      if (await deliverOwed(paths, open) === 'told') log.info('the old home has heard how the move ended');
      ms = FIRST_MS;
    } catch (e) {
      log.error(`the old home was not told how the move ended: ${(e as Error).message}; trying again`);
      ms = Math.min(ms * 2, LAST_MS);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  timer = setTimeout(() => void tick(), FIRST_MS);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
