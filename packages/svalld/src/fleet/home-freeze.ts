import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, HOME_ISLAND, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, UPGRADE_ACTION, type AdoptAnswer, type Blocker, type Enrolment, type FleetState, type HomeFacts, type HomeReach, type HomeMoveId, type HomeMoving, type HomeSheet, type MachineId, type MethodName, type Refusal, type Result } from '@svall/protocol';
import { readFleetConfig } from '../config.js';
import { writeDurable } from '../durable.js';
import { enrolLock } from '../kernel-lock.js';
import type { Logger } from '../log.js';
import { LinkProblem, realDeps, resolveTailscale, tailnetSelf, TailscaleDown, type Mobile, type MobileDeps } from '../mobile.js';
import { expandHome, type Paths } from '../paths.js';
import { classification } from '../api/classify.js';
import { releaseVersion } from '../release.js';
import { addEnrol, carriedKb, createMarker, endMove, keyFits, MAX_CARRIED_KB, moveInFlight, phoneOwed, readMarker, servedPhone, TOLD_UNMARKED } from './home-move.js';
import { keyLine, listedWorkerIds, noLoginFix } from '../placement/workers.js';

// what still answers on a frozen home: a person's terminals go on, as do the robots
const STILL = new Set<MethodName>(['term.open', 'term.attach', 'term.input', 'term.resize', 'term.close', 'robot.seen', 'robot.answer', 'fleet.freeze', 'fleet.thaw', 'fleet.homeCheck', 'fleet.homeMove']);
// and reads that are no reads: a quit that ends the robots, or a link that would come back
const NOT_READS = new Set<MethodName>(['fleet.stop', 'machines.refresh', 'fleets.create', 'fleets.start']);
const DRAIN_MS = 30_000;
const FIRST_ASK_MS = 5_000;
const LAST_ASK_MS = 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
// room for what its robots write meanwhile, past what the move itself takes
const SPARE_KB = 100 * 1024;
// the archive, what it unpacks to and the files built from that stand side by side until the install ends
const COPIES_TAKEN = 3;
const mb = (kb: number): number => Math.ceil(kb / 1024);

type Holder = object;

const markerOf = (p: Paths): HomeMoving | undefined => { try { return readMarker(p); } catch { return undefined; } };

export type FreezeDeps = {
  paths: Paths; store: { state: FleetState; flush(): Promise<boolean> }; me: MachineId; log: Pick<Logger, 'error' | 'info'>;
  /** the link to `machine`, with what a barrier needs of it */
  links: { barrier(machine: MachineId, ms: number): Promise<boolean | 'applying'>; hold(on: boolean): void; quiet?(): Promise<void>; call<T>(machine: MachineId, method: string, params: unknown): Promise<T> };
  /** the scribe, the pusher, the relay and the retro, which only a home runs and which a frozen one holds still */
  background: { pause(): void; resume(): void };
  phone: Mobile;
  /** the machine holding the fleet, asked about this move over ssh */
  ask(marker: HomeMoving, op: 'status' | 'abort'): Promise<AdoptAnswer>;
  /** ends this daemon, whose next start finishes the join */
  restart(): void;
  /** what this machine's network addresses come to, which changes as a network comes back */
  network?: () => string;
};

// a beat that finds the network changed, or that ran late as after a sleep, asks at once
const BEAT_MS = 5_000;
const addresses = (): string => JSON.stringify(Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address).sort());

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
  private asking = false;
  private stopped = false;
  private beat?: NodeJS.Timeout;
  private enrolling?: () => void;

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
    this.enrolling?.();
    this.enrolling = undefined;
    clearTimeout(this.timer);
    clearInterval(this.beat);
  }

  get active(): boolean {
    return this.moving !== undefined;
  }

  /** The move this home is frozen for, from its pause. */
  get movingId(): HomeMoveId | undefined {
    return this.moving?.id;
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
    if (held) throw new ApiError('busy', 'the fleet is already moving', { raw: held });
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
    if (this.moving) throw new ApiError('busy', 'the fleet is already moving', { raw: this.moving.id });
    const held = { id, to, holder, served: false, ready: false };
    // from here new calls are refused, and a driver that leaves during any step below ends it by finding `moving` gone
    this.moving = held;
    this.d.background.pause();
    const still = (): void => { if (this.moving !== held) throw new ApiError('not_frozen', 'the run that started this move went away', { raw: id }); };
    try {
      // from the pause, no person's add and no re-enrol issues a token here: an enrol under way refuses the freeze
      const unlock = await enrolLock(this.d.paths.home);
      if (!unlock) throw new ApiError('busy', 'a worker is being enrolled; try again in a moment');
      // a driver that left while this waited has let the freeze go already
      if (this.moving === held) this.enrolling = unlock;
      else unlock();
      still();
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
      await this.d.links.call(to, 'home.freeze', { id });
      still();
      // the worker starts nothing new, and what it sent is in; from here its metadata stays in its outbox
      const caught = await this.d.links.barrier(to, DRAIN_MS);
      if (caught === 'applying') throw new ApiError('busy', 'a change a worker sent is still being applied; try again in a moment');
      if (!caught) throw new ApiError('busy', 'a worker is still catching up; try again in a moment');
      still();
      this.d.links.hold(true);
      // an event some worker's link is applying as the hold starts would be acked after the cut
      await this.d.links.quiet?.();
      still();
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

  /** The outcome `not-adopted`, delivered by the machine holding the fleet to a home with no route to ask it; before the mark, it refuses that mark for good. */
  async told(id: HomeMoveId, key: string): Promise<void> {
    if (this.marker?.id !== id) return endMove(this.d.paths, id, { by: 'refused', detail: TOLD_UNMARKED });
    if (this.marker.ask) throw new ApiError('frozen', 'this home asks where the fleet went, and is told by no one');
    await this.release({ by: 'told', key });
  }

  mark(marker: HomeMoving): void {
    if (this.moving?.id !== marker.id || !this.moving.ready) throw new ApiError('not_frozen', 'this home is not frozen for this move: it stopped, and may have taken a write since', { raw: marker.id });
    if (this.marker) throw new ApiError('frozen', 'this home is marked for a move already', { raw: this.marker.id });
    try { createMarker(this.d.paths, marker); } catch (e) {
      // one the call linked into place before it failed stands, and holds this home as one it wrote
      if (markerOf(this.d.paths)?.keySha256 === marker.keySha256) this.marker = marker;
      throw e;
    }
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
    if (this.marker?.id !== id) throw new ApiError('not_frozen', 'this home holds no marker of this move', { raw: id });
    if (!keyFits(this.marker, key)) throw new ApiError('frozen', 'only the run that started this move ends it, with its key', { raw: id });
    this.enrolled(this.marker, enrol);
  }

  private enrolled(held: HomeMoving, enrol: Enrolment): void {
    this.marker = addEnrol(this.d.paths, held.id, enrol);
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
    this.watchNetwork();
    this.timer = setTimeout(() => {
      this.askMs = Math.min(this.askMs * 2, LAST_ASK_MS);
      this.ask();
    }, this.askMs);
    this.timer.unref?.();
  }

  // one ask at a time, so an older answer never lands over a newer one; one in flight is followed by the next at the wait then set
  private ask(): void {
    if (this.asking) return;
    this.asking = true;
    // an outcome that could not be written, or that was refused, leaves the marker as it stands, so the asking goes on
    void this.settle('status').catch((e: Error) => {
      this.d.log.error(`how the move ended did not land here: ${e.message}`);
      this.answer = e.message;
      this.schedule();
    }).finally(() => { this.asking = false; });
  }

  // a network that comes back, or a wake, is asked at once rather than at the end of the wait its absence built up
  private watchNetwork(): void {
    if (this.beat) return;
    const network = this.d.network ?? addresses;
    let [last, seen] = [Date.now(), network()];
    this.beat = setInterval(() => {
      const [now, net] = [Date.now(), network()];
      const back = now - last > 2 * BEAT_MS || net !== seen;
      [last, seen] = [now, net];
      if (this.stopped || !this.marker?.ask || this.moving?.holder) { clearInterval(this.beat); this.beat = undefined; return; }
      if (!back || this.askMs === FIRST_ASK_MS) return;
      clearTimeout(this.timer);
      this.askMs = FIRST_ASK_MS;
      this.ask();
    }, BEAT_MS);
    this.beat.unref?.();
  }

  private async servedAgain(): Promise<void> {
    // kept unless it serves, so the next start tries again
    const s = await this.d.phone.set(true).catch((e: Error): { serving: false; error: string; raw?: string } => ({ serving: false, error: e.message }));
    if (s.serving) fs.rmSync(this.d.paths.homeServed, { force: true });
    else this.d.log.error(`the phone link did not come back: ${s.error ?? 'it does not serve'}${s.raw ? `: ${s.raw}` : ''}`);
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
    this.enrolling?.();
    this.enrolling = undefined;
    this.answer = undefined;
    this.phase = undefined;
    clearTimeout(this.timer);
    this.d.links.hold(false);
    await this.d.links.call(held.to, 'home.thaw', { id: held.id }).catch(() => undefined);
    // a freeze begun during that call holds all of it
    if (this.moving) return;
    this.d.background.resume();
    if (held.served) await this.servedAgain();
  }
}

/** What this machine says of itself to a home move's check. `paths`: whether each of these exists here. */
/** `moving`: the move this home's own freeze holds, which holds the enrol lock itself. */
export async function homeFacts(p: Paths, o: { paths?: string[]; me: MachineId; role: 'home' | 'worker'; fleetId?: string; tailscale?: MobileDeps; carried?: HomeFacts['carried']; moving?: string }): Promise<HomeFacts> {
  let tailscale: HomeFacts['tailscale'];
  try {
    const m = o.tailscale ?? realDeps();
    const self = await tailnetSelf(m, await resolveTailscale(m));
    tailscale = { host: self.host, state: 'ok' };
  } catch (e) {
    // one whose status cannot be read is installed, and does not run as it should
    const raw = e instanceof LinkProblem ? e.said.raw : (e as Error).message;
    tailscale = { state: e instanceof TailscaleDown ? e.state : 'stopped', ...(raw && { error: raw }) };
  }
  let freeKb: number | undefined;
  try { const s = fs.statfsSync(p.home); freeKb = Math.floor((s.bavail * s.bsize) / 1024); } catch { /* the check says it could not read it */ }
  let fleetKb: number | undefined;
  if (o.role === 'home') try { fleetKb = carriedKb(p); } catch { /* the check refuses a fleet it cannot measure */ }
  const workers = workersOf(p);
  // let go at once: the check says so before anything moves, and the pause refuses one that begins after it
  const unlock = o.role === 'home' && !o.moving ? await enrolLock(p.home) : () => undefined;
  unlock?.();
  return {
    machineId: o.me, ...(o.fleetId && { fleetId: o.fleetId as HomeFacts['fleetId'] }), release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION,
    clock: Date.now(), ...(freeKb !== undefined && { freeKb }), ...(fleetKb !== undefined && { fleetKb }), fleetHome: p.home as HomeFacts['fleetHome'],
    ...((moveInFlight(p) ?? o.moving) && { moving: moveInFlight(p) ?? o.moving }), tailscale,
    ...(o.paths && { paths: Object.fromEntries(o.paths.map((f) => [f, fs.existsSync(expandHome(f))])) }), ...(workers && { workers }),
    ...(o.role === 'home' && { rewrites: configRewrites(p, os.homedir()) }),
    ...(o.carried && { carried: o.carried }),
    ...(!unlock && { enrolling: true as const }),
  };
}

/**
 * The paths in fleet.json named under the old home, which go in as `~/…` for the new one to read as its own, and those written as `~/…` already.
 * Mission control's folder that is the fleet's own is none of them: it becomes the fleet's own there.
 */
export function configRewrites(p: Pick<Paths, 'fleetConfig' | 'home'>, fromHome: string): HomeSheet['rewrites'] {
  let c: ReturnType<typeof readFleetConfig>;
  try { c = readFleetConfig(p); } catch { return []; }
  const own = path.join(p.home, 'home') === expandHome(c.home.cwd, fromHome);
  const named: [string, string | undefined][] = [['defaultCwd', c.defaultCwd], ['home.cwd', own ? undefined : c.home.cwd], ['onboarding.firstProject', c.onboarding?.firstProject]];
  return named.flatMap(([key, value]) => {
    if (value && (value === fromHome || value.startsWith(`${fromHome}/`))) return [{ key, to: `~${value.slice(fromHome.length)}` }];
    return value && (value === '~' || value.startsWith('~/')) ? [{ key, to: value, kept: true as const }] : [];
  });
}

/** `back`: the name of the home the fleet leaves for this machine, on the way back. `platformOf`: a machine's platform, as this machine's registry has it. */
type HomeCheckInput = {
  state: FleetState; from: HomeFacts; to: HomeFacts; toName: string; back?: string; linked: boolean; synced: boolean; fromIsHome: boolean; platformOf?: (id: string) => string | undefined;
  /** What the machine that would take the fleet found of each worker the move can carry, null where it could not be asked; `linkedTo`: whether this home's link to one is up. */
  reach?: Record<string, HomeReach> | null; linkedTo?: (machine: string) => boolean;
  /** The workers the move would carry, where known: what an unasked machine leaves unsaid. */
  carried?: string[];
  /** How this machine's terminal reaches the home the fleet would leave, on the way back, or the machine taking it, on the way out. */
  farSsh?: string;
};

const AUTHORIZED = `'cat >> .ssh/authorized_keys'`;
const NTP = 'sudo timedatectl set-ntp on';


// from the machine that reaches both: on the way out it asks the far machine for its key, on the way back it sends its own over the home
const publicHalf = (i: Pick<HomeCheckInput, 'back' | 'farSsh'>, ssh: string): string | undefined => {
  if (!i.farSsh) return undefined;
  return i.back ? `cat ~/.ssh/id_ed25519.pub | ssh ${i.farSsh} "ssh ${ssh} ${AUTHORIZED}"` : `ssh ${i.farSsh} cat .ssh/id_ed25519.pub | ssh ${ssh} ${AUTHORIZED}`;
};

/** Every reason the fleet cannot move now, each with its action, and what it would move. A reason names the other machine, and this one as this machine, or as this Mac on a Mac where it speaks of the move's workers. */
export function homeCheck(i: HomeCheckInput): Result<'fleet.homeCheck'> {
  const { state, from, to, toName } = i;
  const far = i.back ?? toName;
  const [there, here] = i.back ? [from, to] : [to, from];
  const goesTo = i.back ? 'this machine' : toName;
  // the words of a move's workers: a Mac names itself as its window does
  const mac = process.platform === 'darwin';
  const taker = i.back && mac ? 'this Mac' : goesTo;
  const leaver = i.back ?? (mac ? 'this Mac' : 'this home');
  const failed: Blocker[] = [];
  const waits: NonNullable<HomeSheet['waits']> = [];
  const fail = (reason: string, action: string, more: Pick<Blocker, 'run' | 'raw'> = {}): void => { failed.push({ reason, action, ...more }); };
  const robots = Object.values(state.robots);
  if (!i.fromIsHome) fail('this daemon is not the fleet\'s home', 'run this where the fleet\'s home is');
  if (!i.linked) fail(`${far} is not reachable`, 'try again when it is awake');
  else if (!i.synced) fail(`${far} is still catching up`, 'try again in a moment');
  if (from.release !== to.release || from.protocol !== to.protocol || from.stateSchema !== to.stateSchema) fail(`${far} runs ${there.release}, this machine ${here.release}`, 'upgrade it under Machines');
  for (const r of robots.filter((c) => c.moving)) fail(`${r.name} is moving`, 'wait for its move to finish');
  if (from.enrolling) fail('a worker is being enrolled', 'try again in a moment');
  if (!from.workers) fail(`${i.back ?? 'this machine'} cannot read which workers this fleet has`, `fix ${from.fleetHome}/workers.json`);
  const others = (from.workers ?? []).filter((m) => m !== to.machineId && m !== from.machineId);
  // a machine that could not be asked says nothing of a worker it would carry; one it would not, as a second Mac, is refused all the same
  const unasked = (m: string): boolean => i.reach === null && (!i.carried || i.carried.includes(m));
  if (i.linked && others.some(unasked)) fail(`${taker} could not be asked whether it reaches the other workers`, 'try again in a moment');
  for (const m of others.filter((w) => !unasked(w))) {
    const name = state.machines?.[m as MachineId]?.name ?? m;
    const r = i.reach?.[m];
    // nothing can log in to it, so nothing can tell it of a new home
    if (!r) {
      const platform = i.platformOf?.(m);
      const again = platform === 'linux' ? `after the move, add it again from ${goesTo}` : platform === 'darwin' ? 'after the move, run svall fleet join on it' : 'add it again after the move';
      fail(`${name} is a worker of this fleet too`, `remove ${name} first; ${again}`);
    } else if (r.ok) continue;
    else if (r.kind === 'unreachable' && !i.linkedTo?.(m)) waits.push({ id: m as MachineId, name });
    // a key is made where the fleet goes, which on the way out is the far machine
    else if (r.kind === 'auth' || r.kind === 'host_key') fail(`${taker} cannot log in to ${name}`, noLoginFix(taker, r.ssh, publicHalf(i, r.ssh)), { ...(!i.back && { run: keyLine(r.ssh) }), raw: r.raw });
    else if (r.kind === 'unreachable') fail(`${taker} cannot reach ${name}, which ${leaver} reaches`, `check Tailscale on both machines, then ssh ${r.ssh} from ${taker}`, { raw: r.raw });
    else fail(`${name}: ${r.why}`, r.kind === 'release' ? UPGRADE_ACTION : 'fix it, or remove it first', { raw: r.raw });
  }
  const farPlatform = i.platformOf?.(there.machineId);
  if (Math.abs(from.clock - to.clock) > CLOCK_SKEW_MS) {
    fail(`${far}'s clock and this machine's are more than 5 minutes apart`, 'set the one that is wrong: on a server, ssh there, then sudo timedatectl set-ntp on', farPlatform === 'darwin' ? {} : { run: NTP });
  }
  // on the way back, the leaving home's facts are its own only once it answers
  if (i.linked && from.fleetKb === undefined) fail(`${i.back ?? 'this machine'} cannot tell what the fleet's files come to`, `check that everything in ${from.fleetHome} can be read`);
  const fleetKb = from.fleetKb ?? 0;
  if (fleetKb > MAX_CARRIED_KB) {
    fail(`the fleet's files are ${mb(fleetKb)} MB; a move carries ${mb(MAX_CARRIED_KB)} MB`, 'remove what you no longer need from docs and retro', { raw: `${from.fleetHome}/docs\n${from.fleetHome}/retro` });
  }
  const needKb = COPIES_TAKEN * fleetKb + SPARE_KB;
  if (to.freeKb !== undefined && to.freeKb < needKb) fail(`${goesTo} has ${Math.floor(to.freeKb / 1024)} MB free, and taking the fleet takes ${mb(needKb)} MB`, i.back ? 'free some space here' : 'free some space there');
  if (from.moving) fail('the fleet is moving already', 'finish or call off that move first', { raw: from.moving });
  if (to.moving) fail(i.back ? 'this machine is still taking a move' : `${toName} is still leaving a move`, 'finish or call off that move first', { raw: to.moving });
  // Tailscale by its state on each machine; a command is typed only on the far one, where its terminal opens
  const tailscale = (f: HomeFacts, on: string, platform: string | undefined, where: string, typed: boolean): void => {
    const state = f.tailscale.state ?? (f.tailscale.error ? 'missing' : 'ok');
    const raw = { raw: f.tailscale.error };
    const app = platform === 'darwin';
    if (state === 'missing') fail(`${on} has no Tailscale`, `install it${where} from tailscale.com/download and sign in`, raw);
    else if (state === 'stopped') fail(`Tailscale is not running on ${on}`, app ? `open the Tailscale app${where}` : `start it${where}: sudo systemctl start tailscaled`, { ...(!app && typed && { run: 'sudo systemctl start tailscaled' }), ...raw });
    else if (state === 'signedOut') fail(`Tailscale on ${on} is signed out`, app ? `sign in from the Tailscale app${where}` : `sign in${where}: sudo tailscale up`, { ...(!app && typed && { run: 'sudo tailscale up' }), ...raw });
  };
  tailscale(there, far, farPlatform, ' there', true);
  tailscale(here, 'this machine', i.platformOf?.(here.machineId) ?? process.platform, '', false);
  const sheet: HomeSheet = {
    here: robots.filter((r) => (r.machine ?? from.machineId) === from.machineId && state.islands[r.islandId]?.kind !== 'home').length,
    there: robots.filter((r) => r.machine === to.machineId).length,
    mission: robots.filter((r) => state.islands[r.islandId]?.kind === 'home' && r.islandId === HOME_ISLAND && (r.machine ?? from.machineId) !== to.machineId).map((r) => ({ id: r.id, name: r.name })),
    rewrites: (from.rewrites ?? []).map((r) => ({ ...r, ...(to.paths?.[r.to] === false && { lacks: true }) })).filter((r) => !r.kept || r.lacks),
    ...(waits.length && { waits }),
  };
  if (!failed.length) return { ok: true, sheet };
  const [first, ...more] = failed;
  const refusal: Refusal = { ...first, details: [], ...(more.length && { more }) };
  return { ok: false, refusal, sheet };
}

/** The machines this fleet holds a token for that the registry lists, none where it has no workers.json; undefined where it cannot read one, which refuses a move. */
export const workersOf = (p: Paths): string[] | undefined => {
  try { return listedWorkerIds(p); } catch { return undefined; }
};
