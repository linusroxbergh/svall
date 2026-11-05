import fs from 'node:fs';
import os from 'node:os';
import { ApiError, HOME_ISLAND, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type AdoptAnswer, type Enrolment, type FleetState, type HomeFacts, type HomeMoveId, type HomeMoving, type HomeSheet, type MachineId, type MethodName, type Refusal, type Result } from '@svall/protocol';
import { readFleetConfig } from '../config.js';
import { writeDurable } from '../durable.js';
import type { Logger } from '../log.js';
import { realDeps, resolveTailscale, tailnetSelf, type Mobile, type MobileDeps } from '../mobile.js';
import { expandHome, type Paths } from '../paths.js';
import { classification } from '../api/classify.js';
import { installPrefix, releaseVersion } from '../release.js';
import { endMove, keyFits, moveInFlight, phoneOwed, servedPhone, writeMarker } from './home-move.js';
import { workerIds } from '../placement/workers.js';

// what still answers on a frozen home: a person's terminals go on, as do the robots
const STILL = new Set<MethodName>(['term.open', 'term.attach', 'term.input', 'term.resize', 'term.close', 'robot.seen', 'robot.answer', 'fleet.freeze', 'fleet.thaw', 'fleet.homeCheck', 'fleet.homeMove']);
// and reads that are no reads: a quit that ends the robots, or a link that would come back
const NOT_READS = new Set<MethodName>(['fleet.stop', 'machines.refresh', 'fleets.create', 'fleets.start']);
const DRAIN_MS = 30_000;
const FIRST_ASK_MS = 5_000;
const LAST_ASK_MS = 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
// a fleet's kilobytes, with room for what its robots write meanwhile
const MIN_FREE_KB = 100 * 1024;

type Holder = object;

export type FreezeDeps = {
  paths: Paths; store: { state: FleetState; flush(): Promise<boolean> }; me: MachineId; log: Pick<Logger, 'error' | 'info'>;
  /** the link to `machine`, with what a barrier needs of it */
  links: { barrier(machine: MachineId, ms: number): Promise<boolean>; hold(on: boolean): void; call?<T>(machine: MachineId, method: string, params: unknown): Promise<T> };
  /** the scribe, the pusher, the relay and the retro, which only a home runs and which a frozen one holds still */
  background: { pause(): void; resume(): void };
  phone: Mobile;
  /** the machine holding the fleet, asked about this move over ssh */
  ask(marker: HomeMoving, op: 'status' | 'abort'): Promise<AdoptAnswer>;
  /** ends this daemon, whose next start finishes the join */
  restart(): void;
};

/** A home that takes no writes while the fleet moves. Until its marker is written a thaw is free, and a driver that goes away is one; from then on only the machine holding the fleet can end it. */
export class HomeFreeze {
  // `ready` once the freeze has ended, as only then is there a cut for a marker to stand on
  private moving?: { id: HomeMoveId; to: MachineId; holder?: Holder; served: boolean; ready: boolean };
  private marker?: HomeMoving;
  private opened?: { id: HomeMoveId; holder: Holder };
  private admitted = 0;
  private idle?: () => void;
  private answer?: string;
  private phase?: string;
  private timer?: NodeJS.Timeout;
  private askMs = FIRST_ASK_MS;
  private stopped = false;

  constructor(private d: FreezeDeps, frozen?: HomeMoving) {
    if (!frozen) return;
    this.marker = frozen;
    this.moving = { id: frozen.id, to: frozen.to, served: fs.existsSync(d.paths.homeServed), ready: true };
  }

  /** Starts asking, for a daemon that started under a marker. */
  start(): void {
    if (this.marker) { this.d.background.pause(); this.d.links.hold(true); this.schedule(); }
  }

  /** What a crash around a freeze left off of the phone comes back: once the port it proxies to is known, and under no marker. */
  phoneBack(): void {
    if (!this.moving && fs.existsSync(this.d.paths.homeServed)) void this.servedAgain();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  get active(): boolean {
    return this.moving !== undefined;
  }

  // what may change the fleet: a frozen home refuses these, and a freeze waits on those it had already taken
  private writes(method: MethodName): boolean {
    return !STILL.has(method) && (classification[method] !== 'read' || NOT_READS.has(method));
  }

  /** A call this home takes while it may still freeze; what it returns ends it, so the barrier can wait for it. */
  admit(method: MethodName): (() => void) | undefined {
    if (!this.writes(method)) return undefined;
    this.admitted++;
    return () => { if (--this.admitted === 0) this.idle?.(); };
  }

  // whether every call taken before the freeze has ended, within `ms`
  private drained(ms: number): Promise<boolean> {
    if (!this.admitted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.idle = undefined; resolve(false); }, ms);
      this.idle = () => { clearTimeout(timer); this.idle = undefined; resolve(true); };
    });
  }

  /** Opens a move for its driver, whose calls alone may move mission control's robots under its id. */
  open(id: HomeMoveId, holder: Holder): void {
    const held = this.moving?.id ?? (this.opened?.holder !== holder ? this.opened?.id : undefined);
    if (held) throw new ApiError('busy', `the fleet is already moving (${held})`);
    this.opened = { id, holder };
  }

  /** Whether `id` is the move this caller opened here. */
  mayMoveCrew(id: string, holder: Holder): boolean {
    return this.opened?.id === id && this.opened.holder === holder;
  }

  /** Why a frozen home refuses `method`, when it does. */
  refusal(method: MethodName): ApiError | undefined {
    if (!this.moving || !this.writes(method)) return undefined;
    const name = this.d.store.state.machines?.[this.moving.to]?.name ?? this.marker?.toName ?? this.moving.to;
    return new ApiError('frozen', `the fleet is moving to ${name}; try again once it has`, { to: this.moving.to });
  }

  async freeze(id: HomeMoveId, to: MachineId, holder: Holder): Promise<Result<'fleet.freeze'>> {
    if (this.moving) throw new ApiError('busy', `the fleet is already moving (${this.moving.id})`);
    const held = { id, to, holder, served: false, ready: false };
    // from here new calls are refused, and a driver that leaves during any step below ends it by finding `moving` gone
    this.moving = held;
    this.d.background.pause();
    const still = (): void => { if (this.moving !== held) throw new ApiError('not_frozen', `the driver of ${id} went away`); };
    try {
      const status = await this.d.phone.get();
      still();
      // a link that cannot be read must not be taken for off, as the next home would never serve it
      if (status.error) throw new ApiError('busy', `the phone link cannot be read: ${status.error}`);
      // a link this home still owes counts as on: the next home takes the debt, and no tick here serves past the cut. So does one
      // an earlier freeze turned off and could not turn back on, whose record stands
      const owed = phoneOwed(this.d.paths);
      const serving = status.serving || owed.length > 0 || fs.existsSync(this.d.paths.homeServed);
      held.served = serving;
      if (!await this.drained(DRAIN_MS)) throw new ApiError('busy', 'a call this home took is still running; try again in a moment');
      still();
      const robot = Object.values(this.d.store.state.robots).find((r) => r.moving);
      if (robot) throw new ApiError('busy', `${robot.name} is moving; wait for its move to finish`);
      await this.d.links.call?.(to, 'home.freeze', { id });
      still();
      // the worker starts nothing new, and what it sent is in; from here its metadata stays in its outbox
      if (!await this.d.links.barrier(to, DRAIN_MS)) throw new ApiError('busy', 'a worker is still catching up; try again in a moment');
      still();
      this.d.links.hold(true);
      if (!await this.d.store.flush()) throw new ApiError('not_written', 'state.json was not written');
      still();
      if (serving) {
        writeDurable(this.d.paths.homeServed, { id }, { mode: 0o600 });
        for (const was of owed) servedPhone(this.d.paths, was);
        const off = await this.d.phone.set(false);
        still();
        if (off.error) throw new ApiError('busy', `the phone link did not go off: ${off.error}`);
      }
      held.ready = true;
      return { phone: { serving, logins: status.logins } };
    } catch (e) {
      if (this.moving === held) await this.release();
      throw e;
    }
  }

  /** A driver that went away, before the marker: this home goes on as it was. */
  left(holder: Holder): void {
    if (this.opened?.holder === holder) this.opened = undefined;
    if (this.moving?.holder !== holder) return;
    if (this.marker) { this.moving.holder = undefined; this.schedule(); return; }
    void this.release();
  }

  /** The driver's own failure before the marker. Past it, only the outcome `not-adopted` thaws. */
  async thaw(id: HomeMoveId): Promise<void> {
    if (this.moving?.id !== id) return;
    if (this.marker) throw new ApiError('frozen', 'this move can be called off only where the fleet is going');
    await this.release();
  }

  /** The outcome `not-adopted`, delivered by the machine holding the fleet to a home with no route to ask it. */
  async told(id: HomeMoveId, key: string): Promise<void> {
    if (this.marker?.id !== id) throw new ApiError('not_frozen', `this home holds no marker of ${id}`);
    if (this.marker.ask) throw new ApiError('frozen', 'this home asks where the fleet went, and is told by no one');
    await this.release({ by: 'told', key });
  }

  mark(marker: HomeMoving): void {
    if (this.moving?.id !== marker.id || !this.moving.ready) throw new ApiError('not_frozen', `this home is not frozen for ${marker.id}: it stopped, and may have taken a write since`);
    writeMarker(this.d.paths, marker);
    this.marker = marker;
  }

  status(): Result<'fleet.homeMove'> {
    if (!this.marker) return {};
    return { moving: { id: this.marker.id, to: this.marker.to, name: this.marker.toName, asks: this.marker.ask !== undefined, ...(this.answer && { answer: this.answer }), ...(this.phase && { phase: this.phase }) } };
  }

  /** The machine holding the fleet asked now, and what it says acted on. */
  async settle(op: 'status' | 'abort'): Promise<void> {
    const asked = this.marker;
    if (!asked?.ask) return;
    const answer = await this.d.ask(asked, op).catch((e: Error): AdoptAnswer => ({ status: 'pending', phase: 'unreachable', detail: e.message }));
    // an answer about an earlier move says nothing of the one standing now
    if (this.marker?.id === asked.id) await this.act(this.marker, answer);
  }

  /** The outcome `adopted` from the move's driver, on the disk before this daemon ends. */
  join(id: HomeMoveId, enrol: Enrolment, key: string): void {
    if (this.marker?.id !== id) throw new ApiError('not_frozen', `this home holds no marker of ${id}`);
    if (!keyFits(this.marker, key)) throw new ApiError('frozen', `only the driver of ${id} ends it, with its key`);
    this.enrolled(this.marker, enrol);
  }

  private enrolled(held: HomeMoving, enrol: Enrolment): void {
    const m = { ...held, enrol };
    writeMarker(this.d.paths, m);
    this.marker = m;
    this.d.restart();
  }

  private async act(held: HomeMoving, a: AdoptAnswer): Promise<void> {
    this.phase = a.status === 'pending' ? a.phase : a.status;
    if (a.status === 'adopted') return this.enrolled(held, a.enrol);
    if (a.status === 'not-adopted') return this.release({ by: 'asked' });
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

  private async servedAgain(): Promise<void> {
    // kept unless it serves, so the next start tries again
    const s = await this.d.phone.set(true).catch((e: Error) => ({ serving: false, error: e.message }));
    if (s.serving) fs.rmSync(this.d.paths.homeServed, { force: true });
    else this.d.log.error(`the phone link did not come back: ${s.error ?? 'it does not serve'}`);
  }

  // the marker goes first: a crash after it starts this home as it was, and the start turns back on what served
  private async release(end?: { by: 'asked' } | { by: 'told'; key: string }): Promise<void> {
    const held = this.moving;
    if (!held) return;
    if (this.marker) {
      if (!end) throw new ApiError('frozen', 'this move can be called off only where the fleet is going');
      endMove(this.d.paths, this.marker.id, end);
    }
    this.marker = undefined;
    this.moving = undefined;
    this.answer = undefined;
    this.phase = undefined;
    clearTimeout(this.timer);
    this.d.links.hold(false);
    await this.d.links.call?.(held.to, 'home.thaw', { id: held.id }).catch(() => undefined);
    // a freeze begun during that call holds all of it
    if (this.moving) return;
    this.d.background.resume();
    if (held.served) await this.servedAgain();
  }
}

/** What this machine says of itself to a home move's check. `paths`: whether each of these exists here. */
export async function homeFacts(p: Paths, o: { paths?: string[]; me: MachineId; role: 'home' | 'worker'; fleetId?: string; tailscale?: MobileDeps }): Promise<HomeFacts> {
  let tailscale: HomeFacts['tailscale'];
  try {
    const m = o.tailscale ?? realDeps();
    const self = await tailnetSelf(m, await resolveTailscale(m));
    tailscale = { host: self.host };
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

/** `back`: the name of the home the fleet leaves for this machine, on the way back. */
type HomeCheckInput = {
  state: FleetState; from: HomeFacts; to: HomeFacts; toName: string; back?: string; linked: boolean; synced: boolean; workers: string[]; rewrites: HomeSheet['rewrites']; fromIsHome: boolean;
};

/** Every reason the fleet cannot move now, each with its action, and what it would move. A reason names the other machine, and this one as this machine. */
export function homeCheck(i: HomeCheckInput): Result<'fleet.homeCheck'> {
  const { state, from, to, toName } = i;
  const far = i.back ?? toName;
  const [there, here] = i.back ? [from, to] : [to, from];
  const goesTo = i.back ? 'this machine' : toName;
  const failed: { reason: string; action: string; run?: string }[] = [];
  const fail = (reason: string, action: string): void => { failed.push({ reason, action }); };
  const robots = Object.values(state.robots);
  if (!i.fromIsHome) fail('this daemon is not the fleet\'s home', 'run this where the fleet\'s home is');
  if (!i.linked) fail(`${far} is not reachable`, 'try again when it is awake');
  else if (!i.synced) fail(`${far} is still catching up`, 'try again in a moment');
  if (from.release !== to.release || from.protocol !== to.protocol || from.stateSchema !== to.stateSchema) fail(`${far} runs ${there.release}, this machine ${here.release}`, 'upgrade it under Machines');
  for (const r of robots.filter((c) => c.moving)) fail(`${r.name} is moving`, 'wait for its move to finish');
  const others = i.workers.filter((m) => m !== to.machineId && m !== from.machineId);
  for (const m of others) {
    const name = state.machines?.[m as MachineId]?.name ?? m;
    fail(`${name} is a worker of this fleet too`, `remove ${name} first, and add it again from ${goesTo}`);
  }
  if (Math.abs(from.clock - to.clock) > CLOCK_SKEW_MS) fail(`${far}'s clock is off by more than 5 minutes`, `set its clock: ssh there, then sudo timedatectl set-ntp on`);
  if (to.freeKb !== undefined && to.freeKb < MIN_FREE_KB) fail(`${goesTo} has ${to.freeKb} KB free, too little for the fleet's files`, i.back ? 'free some space here' : 'free some space there');
  if (from.moving) fail(`the fleet is moving already (${from.moving})`, 'finish or call off that move first');
  if (to.moving) fail(`${goesTo} is still leaving a move (${to.moving})`, 'finish or call off that move first');
  if (there.tailscale.error) fail(`${far} has no Tailscale: ${there.tailscale.error}`, 'install Tailscale there and sign in');
  if (here.tailscale.error) fail(`this machine has no Tailscale: ${here.tailscale.error}`, 'install Tailscale and sign in');
  const sheet: HomeSheet = {
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
