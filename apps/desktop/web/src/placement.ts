import { farRootOf, type FleetState, type HomeState, type MachineId, type MachineLink, type Robot } from '@svall/protocol';

type Machines = Pick<FleetState, 'machines'>;

// a worker the fleet no longer lists goes by its id
export const machineName = (f: Machines, id: MachineId): string => f.machines?.[id]?.name ?? id;

/** Where a move goes, by name: this Mac is the window's machine; the fleet lists its workers, and the home named by `via` lists none of itself. */
export const destinationName = (f: Machines, to: MachineId, via?: Via): string =>
  (to === via?.machine ? 'this Mac' : f.machines?.[to]?.name ?? via?.name ?? 'this Mac');

/**
 * Whether a robot runs elsewhere than this window. A robot that names no machine runs on the home, which is here only
 * for a window on the home; a robot on this machine is here whichever it is.
 */
export const isPlaced = (c: Pick<Robot, 'machine'>, via?: Via): boolean => (via ? c.machine !== via.machine : c.machine !== undefined);

// what a window knows of the machines: its daemon's word on a far home, its shell's on any other
type Seat = { via?: Via; shell?: { machine?: string } };

/** This window's machine, by id. */
export const myMachine = (w: Seat): string | undefined => w.via?.machine ?? w.shell?.machine;

/** The machine a robot runs on, by id: one that names none runs on the home. */
export const robotMachine = (c: Pick<Robot, 'machine'>, w: Seat): string | undefined => c.machine ?? w.via?.home ?? w.shell?.machine;

/** The machine a shelf root's files are on, by id: a worker's clone names it, and any other is the daemon's that lists it, this one's while it stands in for the home. */
export const rootMachine = (id: string, w: Seat): string | undefined => farRootOf(id)?.machine ?? (w.via?.online ? w.via.home : myMachine(w));

/** The machine a shelf root's files are on, by name, when that is not this window's. */
export const rootAway = (f: Machines, id: string, w: Seat): string | undefined => {
  const on = rootMachine(id, w);
  if (on === myMachine(w)) return undefined;
  return on === w.via?.home ? homeName(f, w.via!) : machineName(f, on as MachineId);
};

/** The machine a new robot starts on: the home the window follows, else this one, which also serves a window its home dials. */
export const startsOn = (via: Via): MachineId => (via.online && !via.served ? via.home : via.machine);

/** Whether a robot works on the machine a new one starts on, so that its folder is there. */
export const startsBeside = (c: Pick<Robot, 'machine'>, via: Via): boolean => (c.machine ?? via.home) === startsOn(via);

/** The machine a robot that is not here runs on, by name. */
export const machineOf = (f: Machines, c: Pick<Robot, 'machine'>, via?: Via): string | undefined => {
  if (!isPlaced(c, via)) return undefined;
  return c.machine !== undefined && c.machine !== via?.home ? machineName(f, c.machine) : homeName(f, via!);
};

/** A worker that answers: linked, or on a build this Mac cannot read, whose move check says which side to upgrade. */
export const answers = (m: MachineLink | undefined): boolean => !!m && (m.reachable || m.mismatch === true);

/** The machine a workspace id's files are on, by name, when they are not here: a robot's, or a worker clone's on the shelf. */
export const readsOn = (f: Pick<FleetState, 'robots' | 'machines'>, id: string, via?: Via): string | undefined => {
  const far = farRootOf(id);
  if (far) return machineName(f, far.machine);
  return Object.hasOwn(f.robots, id) ? machineOf(f, f.robots[id], via) : undefined;
};

/**
 * A page on a worker: a phone that reaches the fleet through it while the home does not answer, or a window on a worker's
 * own machine. `machine` is that worker, `home` the home it stands in for; a window names the home, and says `online` while
 * it follows the home itself, when each machine's link reads as the home tells it, and `served` while this machine's daemon
 * serves it for a home that dials this Mac.
 */
export type Via = { machine: MachineId; home: MachineId; name?: string; online?: true; served?: true };

/** The home as the fleet names it, as a window was told, or by what it is. */
export const homeName = (f: Machines, via: Via): string => f.machines?.[via.home]?.name ?? via.name ?? 'the Mac';

/** The machine a robot runs on, while the home has lost its link to it; through a worker, any machine but that worker. */
export const unreachableOf = (f: Machines, c: Pick<Robot, 'machine'>, via?: Via): string | undefined => {
  if (via && c.machine === via.machine) return undefined;
  if (via && !via.online) return machineOf(f, c, via);
  if (c.machine === undefined || c.machine === via?.home) return undefined;
  return f.machines?.[c.machine]?.reachable === false ? machineName(f, c.machine) : undefined;
};

/** Through a worker, a robot that runs on another machine, which takes none of the actions the Mac would answer. */
export const elsewhere = (c: Pick<Robot, 'machine'>, via?: Via): boolean => !!via && c.machine !== via.machine;

// what the home last answered: a version gap names the home's release; with none, a detail is the daemon saying why it cannot run there
type Answered = { state: HomeState; release?: string; detail?: string };
type Standing = { fleet: Pick<FleetState, 'robots' | 'machines'>; via?: Via; home?: Answered };

/** Why a window on this Mac's copy of the fleet takes no change to a robot elsewhere: only its home takes one, and that cannot be asked. */
export const frozenWhy = (s: Standing, id: string): (Apart & { robot: string; machine: string; through?: string }) | undefined => {
  if (!s.via || s.via.online || !Object.hasOwn(s.fleet.robots, id)) return undefined;
  const c = s.fleet.robots[id];
  if (!elsewhere(c, s.via)) return undefined;
  const machine = machineOf(s.fleet, c, s.via)!;
  // a robot on another machine waits on the home, which this Mac reaches it through
  const through = c.machine === undefined || c.machine === s.via.home ? undefined : homeName(s.fleet, s.via);
  return { robot: c.name, machine, ...(through && { through }), ...apartOf(through ?? machine, s.home) };
};

/** What a try at changing such a robot is told. */
export const frozenLine = (s: Standing, id: string): string | undefined => {
  const why = frozenWhy(s, id);
  return why && `${why.robot} runs on ${why.machine}${why.through ? `, reached through ${why.through}` : ''}, which ${why.which}; you can change it once ${why.once}.`;
};

// what keeps a window from its home, by what the home last answered, and what ends it
type Apart = { line: string; which: string; once: string };
const apartOf = (home: string, answer?: Answered): Apart => {
  const state = answer?.state;
  if (state === 'version' && !answer?.release && answer?.detail) return { line: `${home} cannot run this Mac's Svall`, which: 'cannot run this Mac\'s Svall', once: 'it runs this Mac\'s Svall' };
  if (state === 'version') return { line: `${home} runs another version of Svall`, which: 'runs another version of Svall', once: 'both run the same' };
  if (state === 'auth') return { line: `this Mac cannot log in to ${home}`, which: 'this Mac cannot log in to', once: 'this Mac can log in' };
  if (state === 'mismatch') return { line: `${home} holds a different fleet`, which: 'holds a different fleet', once: 'it holds the fleet this Mac expects' };
  if (state === 'machine') return { line: `${home} is a different machine than this Mac expects`, which: 'is a different machine than this Mac expects', once: 'it is the machine this Mac expects' };
  return { line: `${home} is not reachable`, which: 'is not reachable', once: 'it answers' };
};

/** What a robot's terminal and files say in their place while the home has lost its worker: a link in mismatch names the upgrade.
 *  On this Mac's copy of the fleet a robot elsewhere goes by `home`, what the home last answered. */
export function awayLine(f: Machines, c: Pick<Robot, 'machine'>, via?: Via, home?: Answered): string | undefined {
  const name = unreachableOf(f, c, via);
  if (name && via && !via.online && home) return apartOf(homeName(f, via), home).line;
  // a phone's home is a Mac, which sleeps
  if (via && !via.online) return name && `${name} ${c.machine !== undefined || via.name ? 'is not reachable' : 'is asleep'}`;
  const mismatch = c.machine !== undefined && f.machines?.[c.machine]?.mismatch === true;
  return name && `${name} ${mismatch ? 'runs a different build; upgrade it under Machines' : 'is not reachable'}`;
}
