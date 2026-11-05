import fs from 'node:fs';
import { z } from 'zod';
import { AdoptAnswer, HomeFacts, type HomeDelivery, type HomeMoving, type WorkerFile } from '@svall/protocol';
import { homePoint } from '../failpoints.js';
import type { Logger } from '../log.js';
import { SshMaster } from '../link/ssh.js';
import { fleetHomeOfSocket, type Paths } from '../paths.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import type { Mobile } from '../mobile.js';
import { driverKey, forgetPhoneReason, moveOutcome, phoneOwed, phoneReason, readOwed, servedPhone } from './home-move.js';

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

/** Whether the old home still holds its mark of this move: only a marked home stays frozen, so only then may this machine go on and take the fleet. */
export async function markedThere(master: Pick<SshMaster, 'run'>, owed: HomeDelivery): Promise<boolean> {
  return (await farJson(master, owed.svallBase, owed.fleetHome, ['fleet', 'facts'], HomeFacts, 'svall fleet facts')).moving === owed.id;
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
  // `done`: only a link with the token this move issued says so, and that home has heard. No key: no marker of it there to end
  const key = driverKey(paths, owed.id);
  if (said.status !== 'done' && key) {
    const master = await open(owed.ssh);
    try {
      // the key on stdin, as an argv is seen by every account there
      const input = JSON.stringify({ key, ...(said.status === 'adopted' && { enrol: said.enrol }) });
      const r = await master.run(farSvall(owed.svallBase, owed.fleetHome, ['fleet', 'settle', owed.id, '--outcome', said.status]), { timeoutMs: SETTLE_MS, input });
      if (r.code !== 0) throw new Error(`svall fleet settle exited ${r.code ?? r.signal}: ${r.stderr.trim().slice(0, 400)}`);
      Settled.parse(JSON.parse(r.stdout));
    } finally { await master.close().catch(() => undefined); }
    homePoint('deliver.told');
  }
  fs.rmSync(paths.homeDeliver, { force: true });
  return 'told';
}

// the link the old home's was, on this home once it has taken the fleet: tried once, and what fails is logged, and Settings → Phone says why
async function servePhones(paths: Paths, log: Pick<Logger, 'error' | 'info'>, serve: () => Promise<{ error?: string | null }>): Promise<void> {
  for (const id of phoneOwed(paths)) {
    const why = await serve().then((s) => s.error ?? undefined, (e: Error) => e.message);
    if (why) log.error(`the phone link did not come on here: ${why}`);
    servedPhone(paths, id, why);
  }
}

/** The link as Settings → Phone sees it: off, it says why a move's try left it so, until a person's own switch. */
export const phoneWithReason = (mobile: Mobile, paths: Pick<Paths, 'homeMoves'>): Mobile => ({
  get: async () => {
    const s = await mobile.get();
    return s.serving || s.error ? s : { ...s, error: phoneReason(paths) ?? s.error };
  },
  set: (on) => {
    forgetPhoneReason(paths);
    return mobile.set(on);
  },
});

/**
 * Tells the old home what this machine owes it, from the moment that is known, for as long as this daemon runs, and with `serve`,
 * a home's, turns on the phone link a move it took owes; the returned function stops it.
 */
export function startDeliveries(paths: Paths, log: Pick<Logger, 'error' | 'info'>, open?: Parameters<typeof deliverOwed>[1], serve?: () => Promise<{ error?: string | null }>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let ms = FIRST_MS;
  let serving = false;
  const tick = async () => {
    // a `tailscale serve` that hangs must not keep the old home frozen
    if (serve && !serving) {
      serving = true;
      void servePhones(paths, log, serve).catch((e: Error) => log.error(`the phone link: ${e.message}`)).finally(() => { serving = false; });
    }
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
