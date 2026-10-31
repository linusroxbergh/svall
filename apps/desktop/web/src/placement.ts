import { farRootOf, type FleetState, type MachineId, type MachineLink, type Robot } from '@svall/protocol';

type Machines = Pick<FleetState, 'machines'>;

// a worker the fleet no longer lists goes by its id
export const machineName = (f: Machines, id: MachineId): string => f.machines?.[id]?.name ?? id;

// the fleet lists its workers, so a move to a machine it does not list is the way back to this Mac
export const destinationName = (f: Machines, to: MachineId): string => f.machines?.[to]?.name ?? 'this Mac';

// the home never names itself, so a robot that names a machine runs on a worker
export const isPlaced = (c: Pick<Robot, 'machine'>): c is { machine: MachineId } => c.machine !== undefined;

export const machineOf = (f: Machines, c: Pick<Robot, 'machine'>): string | undefined => (isPlaced(c) ? machineName(f, c.machine) : undefined);

/** A worker that answers: linked, or on a build this Mac cannot read, whose move check says which side to upgrade. */
export const answers = (m: MachineLink | undefined): boolean => !!m && (m.reachable || m.mismatch === true);

/** The worker a workspace id's files are on, by name: a placed robot's, or a worker clone's on the shelf. */
export const readsOn = (f: Pick<FleetState, 'robots' | 'machines'>, id: string): string | undefined => {
  const at = farRootOf(id)?.machine ?? (Object.hasOwn(f.robots, id) ? f.robots[id].machine : undefined);
  return at && machineName(f, at);
};

/** The worker a phone reaches the fleet through while the home does not answer, and the home it stands in for. */
export type Via = { machine: MachineId; home: MachineId };

/** The home as a worker's copy of the fleet names it; before that copy arrives, by what it is. */
export const homeName = (f: Machines, via: Via): string => f.machines?.[via.home]?.name ?? 'the Mac';

/** The machine a robot runs on, while the home has lost its link to it; through a worker, any machine but that worker. */
export const unreachableOf = (f: Machines, c: Pick<Robot, 'machine'>, via?: Via): string | undefined => {
  if (via) return c.machine === via.machine ? undefined : isPlaced(c) ? machineName(f, c.machine) : homeName(f, via);
  return isPlaced(c) && f.machines?.[c.machine]?.reachable === false ? machineName(f, c.machine) : undefined;
};

/** Through a worker, a robot that runs on another machine, which takes none of the actions the Mac would answer. */
export const elsewhere = (c: Pick<Robot, 'machine'>, via?: Via): boolean => !!via && c.machine !== via.machine;

/** What a robot's terminal and files say in their place while the home has lost its worker: a link in mismatch names the upgrade. */
export function awayLine(f: Machines, c: Pick<Robot, 'machine'>, via?: Via): string | undefined {
  const name = unreachableOf(f, c, via);
  if (via) return name && `${name} ${isPlaced(c) ? 'is not reachable' : 'is asleep'}`;
  const mismatch = isPlaced(c) && f.machines?.[c.machine]?.mismatch === true;
  return name && `${name} ${mismatch ? 'runs a different build; upgrade it under Machines' : 'is not reachable'}`;
}
