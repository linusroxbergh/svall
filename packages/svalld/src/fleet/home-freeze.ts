import fs from 'node:fs';
import os from 'node:os';
import { ApiError, HOME_ISLAND, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type AdoptAnswer, type Enrolment, type FleetState, type HomeFacts, type HomeMoveId, type HomeMoving, type HomeSheet, type MachineId, type MethodName, type Refusal, type Result } from '@svall/protocol';
import { readFleetConfig } from '../config.js';
import type { Logger } from '../log.js';
import { realDeps, resolveTailscale, tailnetSelf, type MobileDeps } from '../mobile.js';
import { expandHome, type Paths } from '../paths.js';
import { classification } from '../api/classify.js';
import { installPrefix, releaseVersion } from '../release.js';
import { dropMarker, moveInFlight, writeMarker } from './home-move.js';
import { workerIds } from '../placement/workers.js';

// what still answers on a frozen home: a person's terminals go on, as do the robots
const STILL = new Set<MethodName>(['term.open', 'term.input', 'term.resize', 'term.close', 'robot.seen', 'robot.answer', 'fleet.freeze', 'fleet.thaw', 'fleet.homeCheck', 'fleet.homeMove']);
// and reads that are no reads: a quit that ends the robots, or a link that would come back
const NOT_READS = new Set<MethodName>(['fleet.stop', 'machines.refresh', 'fleets.create', 'fleets.start']);
const DRAIN_MS = 30_000;
const FIRST_ASK_MS = 5_000;
const LAST_ASK_MS = 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
// a fleet's kilobytes, with room for what its robots write meanwhile
const MIN_FREE_KB = 100 * 1024;

export type Holder = object;

export type FreezeDeps = {
  paths: Paths; store: { state: FleetState; flush(): Promise<boolean> }; me: MachineId; log: Pick<Logger, 'error' | 'info'>;
  /** the link to `machine`, with what a barrier needs of it */
  links: { barrier(machine: MachineId, ms: number): Promise<boolean>; hold(on: boolean): void; call?<T>(machine: MachineId, method: string, params: unknown): Promise<T> };
  /** the scribe, the pusher, the relay and the retro, which only a home runs and which a frozen one holds still */
  background: { pause(): void; resume(): void };
  phone: { get(): Promise<{ serving: boolean; logins: string[] }>; set(on: boolean): Promise<unknown> };
  /** the machine holding the fleet, asked about this move over ssh */
  ask(marker: HomeMoving, op: 'status' | 'abort'): Promise<AdoptAnswer>;
  /** ends this daemon, whose next start finishes the join */
  restart(): void;
};

/** A home that takes no writes while the fleet moves. Until its marker is written a thaw is free, and a driver that goes away is one; from then on only the machine holding the fleet can end it. */
export class HomeFreeze {
  private moving?: { id: HomeMoveId; to: MachineId; holder?: Holder; served: boolean };
  private marker?: HomeMoving;
  private answer?: string;
  private timer?: NodeJS.Timeout;
  private askMs = FIRST_ASK_MS;
  private stopped = false;

  constructor(private d: FreezeDeps, frozen?: HomeMoving) {
    if (!frozen) return;
    this.marker = frozen;
    this.moving = { id: frozen.id, to: frozen.to, served: frozen.phone === true };
  }

  /** Starts asking, for a daemon that started under a marker. */
  start(): void {
    if (this.marker) { this.d.background.pause(); this.d.links.hold(true); this.schedule(); }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  get active(): boolean {
    return this.moving !== undefined;
  }

  /** Why a frozen home refuses `method`, when it does. */
  refusal(method: MethodName): ApiError | undefined {
    if (!this.moving || STILL.has(method)) return undefined;
    if (classification[method] === 'read' && !NOT_READS.has(method)) return undefined;
    const name = this.d.store.state.machines?.[this.moving.to]?.name ?? this.marker?.toName ?? this.moving.to;
    return new ApiError('frozen', `the fleet is moving to ${name}; try again once it has`);
  }

  async freeze(id: HomeMoveId, to: MachineId, holder: Holder): Promise<Result<'fleet.freeze'>> {
    if (this.moving && this.moving.id !== id) throw new ApiError('busy', `the fleet is already moving (${this.moving.id})`);
    const robot = Object.values(this.d.store.state.robots).find((r) => r.moving);
    if (robot) throw new ApiError('busy', `${robot.name} is moving; wait for its move to finish`);
    const status = await this.d.phone.get().catch(() => ({ serving: false, logins: [] as string[] }));
    if (!this.moving) {
      this.moving = { id, to, holder, served: status.serving };
      this.d.background.pause();
    }
    try {
      await this.d.links.call?.(to, 'home.freeze', { id });
      // the worker starts nothing new, and what it sent is in; from here its metadata stays in its outbox
      if (!await this.d.links.barrier(to, DRAIN_MS)) throw new ApiError('busy', 'a worker is still catching up; try again in a moment');
      this.d.links.hold(true);
      if (!await this.d.store.flush()) throw new ApiError('not_written', 'state.json was not written');
      if (status.serving) await this.d.phone.set(false);
    } catch (e) {
      await this.release();
      throw e;
    }
    return { phone: { serving: status.serving, logins: status.logins } };
  }

  /** A driver that went away, before the marker: this home goes on as it was. */
  left(holder: Holder): void {
    if (this.moving?.holder !== holder) return;
    if (this.marker) { this.moving.holder = undefined; this.schedule(); return; }
    void this.release();
  }

  /** The driver's own failure before the marker. Past it, only an answer of `not-adopted` thaws, or one delivered to a home with no route to ask. */
  async thaw(id: HomeMoveId): Promise<void> {
    if (this.moving?.id !== id) return;
    if (this.marker?.ask) throw new ApiError('frozen', 'this move can be called off only where the fleet is going');
    await this.release();
  }

  mark(marker: HomeMoving): void {
    if (this.moving?.id !== marker.id) throw new ApiError('not_frozen', `this home is not frozen for ${marker.id}: it stopped, and may have taken a write since`);
    const m = { ...marker, phone: this.moving.served };
    writeMarker(this.d.paths, m);
    this.marker = m;
  }

  status(): Result<'fleet.homeMove'> {
    if (!this.marker) return {};
    return { moving: { id: this.marker.id, to: this.marker.to, name: this.marker.toName, asks: this.marker.ask !== undefined, ...(this.answer && { answer: this.answer }) } };
  }

  /** The machine holding the fleet asked now, and what it says acted on. */
  async settle(op: 'status' | 'abort'): Promise<void> {
    if (!this.marker?.ask) return;
    const answer = await this.d.ask(this.marker, op).catch((e: Error): AdoptAnswer => ({ status: 'pending', phase: 'unreachable', detail: e.message }));
    await this.act(answer);
  }

  /** The outcome `adopted`, on the disk before this daemon ends. */
  join(id: HomeMoveId, enrol: Enrolment): void {
    if (this.marker?.id !== id) throw new ApiError('not_frozen', `this home holds no marker of ${id}`);
    const m = { ...this.marker, enrol };
    writeMarker(this.d.paths, m);
    this.marker = m;
    this.d.restart();
  }

  private async act(a: AdoptAnswer): Promise<void> {
    if (!this.marker) return;
    if (a.status === 'adopted') return this.join(this.marker.id, a.enrol);
    if (a.status === 'not-adopted') return this.release();
    this.answer = a.status === 'pending' ? a.detail ?? a.phase : 'done';
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.marker?.ask || this.moving?.holder) return;
    this.timer = setTimeout(() => {
      this.askMs = Math.min(this.askMs * 2, LAST_ASK_MS);
      void this.settle('status');
    }, this.askMs);
    this.timer.unref?.();
  }

  // the marker goes first: a crash after it starts this home as it was, unserved; what served comes back by a person's switch
  private async release(): Promise<void> {
    const held = this.moving;
    if (!held) return;
    if (this.marker) dropMarker(this.d.paths, held.id);
    this.marker = undefined;
    this.moving = undefined;
    clearTimeout(this.timer);
    this.d.links.hold(false);
    await this.d.links.call?.(held.to, 'home.thaw', { id: held.id }).catch(() => undefined);
    this.d.background.resume();
    if (held.served) await this.d.phone.set(true).catch((e: Error) => this.d.log.error(`the phone link did not come back: ${e.message}`));
  }
}

/** What this machine says of itself to a home move's check. `paths`: whether each of these exists here. */
export async function homeFacts(p: Paths, o: { paths?: string[]; me: MachineId; role: 'home' | 'worker'; fleetId?: string; tailscale?: MobileDeps }): Promise<HomeFacts> {
  let tailscale: HomeFacts['tailscale'];
  try {
    const m = o.tailscale ?? realDeps();
    const self = await tailnetSelf(m, await resolveTailscale(m));
    tailscale = { host: self.host, ...(self.owner && { owner: self.owner }) };
  } catch (e) { tailscale = { error: (e as Error).message }; }
  let freeKb: number | undefined;
  try { const s = fs.statfsSync(p.home); freeKb = Math.floor((s.bavail * s.bsize) / 1024); } catch { /* the check says it could not read it */ }
  return {
    machineId: o.me, role: o.role, ...(o.fleetId && { fleetId: o.fleetId as HomeFacts['fleetId'] }), release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION,
    clock: Date.now(), ...(freeKb !== undefined && { freeKb }), home: os.homedir() as HomeFacts['home'], svallBase: installPrefix() as HomeFacts['svallBase'], fleetHome: p.home as HomeFacts['fleetHome'],
    ...(moveInFlight(p) && { moving: moveInFlight(p) }), tailscale,
    ...(o.paths && { paths: Object.fromEntries(o.paths.map((f) => [f, fs.existsSync(expandHome(f))])) }),
  };
}

/** The paths in fleet.json named under the old home, which go in as `~/…` for the new one to read as its own. */
export function configRewrites(p: Pick<Paths, 'fleetConfig'>, fromHome: string): HomeSheet['rewrites'] {
  let c: ReturnType<typeof readFleetConfig>;
  try { c = readFleetConfig(p); } catch { return []; }
  const named: [string, string | undefined][] = [['defaultCwd', c.defaultCwd], ['home.cwd', c.home.cwd], ['onboarding.firstProject', c.onboarding?.firstProject]];
  return named.flatMap(([key, value]) => (value && (value === fromHome || value.startsWith(`${fromHome}/`)) ? [{ key, from: value, to: `~${value.slice(fromHome.length)}` }] : []));
}

export type HomeCheckInput = {
  state: FleetState; from: HomeFacts; to: HomeFacts; toName: string; linked: boolean; synced: boolean; workers: string[]; rewrites: HomeSheet['rewrites']; serving: boolean; fromIsHome: boolean;
};

/** Every reason the fleet cannot move now, each with its action, and what it would move. */
export function homeCheck(i: HomeCheckInput): Result<'fleet.homeCheck'> {
  const { state, from, to, toName } = i;
  const failed: { reason: string; action: string; run?: string }[] = [];
  const fail = (reason: string, action: string): void => { failed.push({ reason, action }); };
  const robots = Object.values(state.robots);
  if (!i.fromIsHome) fail('this daemon is not the fleet\'s home', 'run this where the fleet\'s home is');
  if (!i.linked) fail(`${toName} is not reachable`, 'try again when it is awake');
  else if (!i.synced) fail(`${toName} is still catching up`, 'try again in a moment');
  if (from.release !== to.release || from.protocol !== to.protocol || from.stateSchema !== to.stateSchema) fail(`${toName} runs ${to.release}, this machine ${from.release}`, 'upgrade it under Machines');
  for (const r of robots.filter((c) => c.moving)) fail(`${r.name} is moving`, 'wait for its move to finish');
  const others = i.workers.filter((m) => m !== to.machineId && m !== from.machineId);
  for (const m of others) {
    const name = state.machines?.[m as MachineId]?.name ?? m;
    fail(`${name} is a worker of this fleet too`, `remove ${name} first, and add it again from ${toName}`);
  }
  if (Math.abs(from.clock - to.clock) > CLOCK_SKEW_MS) fail(`${toName}'s clock is off by more than 5 minutes`, `set its clock: ssh there, then sudo timedatectl set-ntp on`);
  if (to.freeKb !== undefined && to.freeKb < MIN_FREE_KB) fail(`${toName} has ${to.freeKb} KB free, too little for the fleet's files`, 'free some space there');
  if (from.moving) fail(`the fleet is moving already (${from.moving})`, 'finish or call off that move first');
  if (to.moving) fail(`${toName} is still leaving a move (${to.moving})`, 'finish or call off that move first');
  if (to.tailscale.error) fail(`${toName} has no Tailscale: ${to.tailscale.error}`, 'install Tailscale there and sign in');
  if (from.tailscale.error) fail(`this machine has no Tailscale: ${from.tailscale.error}`, 'install Tailscale and sign in');
  const sheet: HomeSheet = {
    toName,
    here: robots.filter((r) => (r.machine ?? from.machineId) === from.machineId && state.islands[r.islandId]?.kind !== 'home').length,
    there: robots.filter((r) => r.machine === to.machineId).length,
    mission: robots.filter((r) => state.islands[r.islandId]?.kind === 'home' && r.islandId === HOME_ISLAND && (r.machine ?? from.machineId) !== to.machineId).map((r) => ({ id: r.id, name: r.name })),
    rewrites: i.rewrites,
  };
  if (!failed.length) return { ok: true, sheet };
  const [first, ...more] = failed;
  const refusal: Refusal = { ...first, details: [], ...(more.length && { more }) };
  return { ok: false, refusal, sheet };
}

export const workersOf = (p: Paths): string[] => {
  try { return workerIds(p); } catch { return []; }
};
